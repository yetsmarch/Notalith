import { requestUrl } from "obsidian";
import type {
  ConnectionTestResult,
  ModelProfile,
  ModelTurnInput,
  ProviderConnection,
  ProviderHandlers,
  ProviderInput,
  ProviderResult,
  ProviderUsage,
  ToolCall,
  ToolDefinition,
} from "../types";
import { NotalithError } from "../types";
import type { ModelProvider, ProviderRequestOptions } from "./provider";
import { ConversationHistory } from "../services/context-history";

type JsonObject = Record<string, unknown>;

interface GeminiContent extends JsonObject {
  role: string;
  parts: JsonObject[];
}

interface GeminiResponse {
  content: GeminiContent;
  toolCalls: ToolCall[];
  usage?: ProviderUsage;
  pending: Map<string, { name: string; id?: string }>;
}

export class GeminiProvider implements ModelProvider {
  readonly supportsImageToolResults = false;
  readonly context = new ConversationHistory<GeminiContent>((text) => [
    { role: "user", parts: [{ text }] },
    { role: "model", parts: [{ text: "Historical context noted." }] },
  ]);

  private get history(): GeminiContent[] {
    return this.context.items;
  }
  private pending = new Map<string, { name: string; id?: string }>();
  private nextCallId = 0;
  private conversationVersion = 0;

  constructor(
    private readonly connection: ProviderConnection,
    private readonly model: ModelProfile,
    private readonly systemPrompt: string,
    private readonly getApiKey: () => string | null,
  ) {}

  get supportsImages(): boolean {
    return this.model.supportsImages === true;
  }

  resetConversation(): void {
    this.conversationVersion++;
    this.context.reset();
    this.pending.clear();
  }

  finishTurn(): void {
    this.context.finishTurn();
    this.pending.clear();
  }

  abortTurn(): void {
    this.conversationVersion++;
    this.context.abortTurn();
    this.pending.clear();
  }

  createSummaryProvider(systemPrompt: string): ModelProvider {
    return new GeminiProvider(
      this.connection,
      this.model,
      systemPrompt,
      this.getApiKey,
    );
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      this.validateConfiguration();
      const response = await requestUrl({
        url: this.url(false),
        method: "POST",
        headers: this.headers(),
        contentType: "application/json",
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }],
        }),
        throw: false,
      });
      if (response.status < 200 || response.status >= 300)
        throw this.httpError(response.status, response.text);
      this.parseResponse(response.json, this.silentHandlers());
      return {
        ok: true,
        message: `Connected to Gemini model "${this.model.modelId}".`,
      };
    } catch (error) {
      return { ok: false, message: this.normalizeError(error).message };
    }
  }

  async respond(
    input: ProviderInput,
    tools: ToolDefinition[],
    handlers: ProviderHandlers,
    signal: AbortSignal,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResult> {
    this.validateConfiguration();
    if (signal.aborted) throw this.cancelledError();
    const incoming = this.toContents(input);
    const version = this.conversationVersion;
    if (input.kind === "message") {
      this.context.beginTurn();
      this.pending.clear();
    }
    const request = {
      ...(options?.maxOutputTokens
        ? { generationConfig: { maxOutputTokens: options.maxOutputTokens } }
        : {}),
      ...(this.systemPrompt
        ? { systemInstruction: { parts: [{ text: this.systemPrompt }] } }
        : {}),
      contents: [...this.history, ...incoming],
      ...(tools.length
        ? {
            tools: [
              {
                functionDeclarations: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parametersJsonSchema: tool.parameters,
                })),
              },
            ],
          }
        : {}),
    };

    let result: GeminiResponse;
    let connected = false;
    let usingFallback = false;
    try {
      if (typeof fetch !== "function") {
        usingFallback = true;
        result = await this.completeResponse(request, handlers, signal);
      } else {
        const response = await fetch(this.url(true), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(request),
          signal,
        });
        connected = true;
        if (!response.ok)
          throw this.httpError(response.status, await response.text());
        if (response.body)
          result = await this.readStream(response.body, handlers);
        else {
          usingFallback = true;
          result = await this.completeResponse(request, handlers, signal);
        }
      }
    } catch (error) {
      if (signal.aborted || version !== this.conversationVersion)
        throw this.cancelledError();
      if (error instanceof TypeError && !connected && !usingFallback) {
        try {
          result = await this.completeResponse(request, handlers, signal);
        } catch (fallbackError) {
          if (signal.aborted || version !== this.conversationVersion)
            throw this.cancelledError();
          throw this.normalizeError(fallbackError);
        }
      } else {
        throw this.normalizeError(error);
      }
    }

    if (signal.aborted || version !== this.conversationVersion)
      throw this.cancelledError();
    this.context.append(...incoming, result.content);
    this.pending = result.pending;
    return { toolCalls: result.toolCalls, usage: result.usage };
  }

  private toContents(input: ProviderInput): GeminiContent[] {
    if (input.kind === "message") return [this.userContent(input.message)];
    if (input.results.some(({ output }) => typeof output !== "string"))
      throw new NotalithError(
        "Gemini does not support image results from tools.",
        "tool",
      );
    const seen = new Set<string>();
    const byId = new Map(
      input.results.map(({ callId, output }) => [callId, output]),
    );
    for (const { callId } of input.results) {
      const call = this.pending.get(callId);
      if (!call || seen.has(callId))
        throw new NotalithError("Unknown Gemini function call result.", "tool");
      seen.add(callId);
    }
    if (seen.size !== this.pending.size || !seen.size)
      throw new NotalithError("Missing Gemini function call results.", "tool");
    const parts = [...this.pending].map(([callId, call]) => {
      return {
        functionResponse: {
          name: call.name,
          ...(call.id ? { id: call.id } : {}),
          response: { result: byId.get(callId) },
        },
      };
    });
    return [{ role: "user", parts }];
  }

  private userContent(message: ModelTurnInput): GeminiContent {
    if (message.images.length && !this.supportsImages)
      throw new NotalithError(
        `Gemini model "${this.model.modelId}" does not support image input.`,
        "tool",
      );
    return {
      role: "user",
      parts: [
        { text: message.text },
        ...message.images.map(({ mimeType, data }) => ({
          inlineData: { mimeType, data },
        })),
      ],
    };
  }

  private async completeResponse(
    request: JsonObject,
    handlers: ProviderHandlers,
    signal: AbortSignal,
  ): Promise<GeminiResponse> {
    if (signal.aborted) throw this.cancelledError();
    const response = await requestUrl({
      url: this.url(false),
      method: "POST",
      headers: this.headers(),
      contentType: "application/json",
      body: JSON.stringify(request),
      throw: false,
    });
    if (signal.aborted) throw this.cancelledError();
    if (response.status < 200 || response.status >= 300)
      throw this.httpError(response.status, response.text);
    return this.parseResponse(response.json, handlers);
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    handlers: ProviderHandlers,
  ): Promise<GeminiResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content: GeminiContent | null = null;
    let finishReason: string | null = null;
    let usage: ProviderUsage | undefined;
    let sawEvent = false;

    const consume = (block: string): void => {
      const payload = block
        .split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!payload) return;
      if (payload === "[DONE]") return;
      let chunk: JsonObject | null;
      try {
        chunk = this.asRecord(JSON.parse(payload));
      } catch {
        throw new NotalithError("Invalid Gemini stream event.", "provider");
      }
      if (!chunk)
        throw new NotalithError("Invalid Gemini stream event.", "provider");
      sawEvent = true;
      if (chunk.error) throw this.streamError(chunk.error);
      if (this.asRecord(chunk.promptFeedback)?.blockReason)
        throw new NotalithError("Gemini blocked the prompt.", "content_filter");
      const candidate = this.candidate(chunk);
      if (candidate) {
        if (typeof candidate.finishReason === "string")
          finishReason = candidate.finishReason;
        if (candidate.content !== undefined) {
          const part = this.parseContent(candidate.content);
          if (!content) content = { ...part, parts: [...part.parts] };
          else {
            if (part.role !== content.role)
              throw new NotalithError(
                "Inconsistent Gemini stream roles.",
                "provider",
              );
            content.parts.push(...part.parts);
          }
          for (const piece of part.parts) this.emitText(piece, handlers);
        }
      }
      const parsedUsage = this.parseUsage(chunk.usageMetadata);
      if (parsedUsage) {
        usage = parsedUsage;
        handlers.onUsage(parsedUsage);
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let match: RegExpExecArray | null;
        while ((match = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
          consume(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
    } finally {
      reader.releaseLock();
    }
    if (!sawEvent || !content || finishReason !== "STOP")
      throw this.finishError(finishReason);
    return this.makeResult(content, usage, handlers);
  }

  private parseResponse(
    value: unknown,
    handlers: ProviderHandlers,
  ): GeminiResponse {
    const response = this.asRecord(value);
    if (!response)
      throw new NotalithError("Invalid Gemini response.", "provider");
    if (response.error) throw this.streamError(response.error);
    if (this.asRecord(response.promptFeedback)?.blockReason)
      throw new NotalithError("Gemini blocked the prompt.", "content_filter");
    const candidate = this.candidate(response);
    if (!candidate || candidate.finishReason !== "STOP")
      throw this.finishError(candidate?.finishReason);
    const content = this.parseContent(candidate.content);
    for (const part of content.parts) this.emitText(part, handlers);
    const usage = this.parseUsage(response.usageMetadata);
    if (usage) handlers.onUsage(usage);
    return this.makeResult(content, usage, handlers);
  }

  private makeResult(
    content: GeminiContent,
    usage: ProviderUsage | undefined,
    handlers: ProviderHandlers,
  ): GeminiResponse {
    if (content.role !== "model")
      throw new NotalithError("Invalid Gemini model role.", "provider");
    const toolCalls: ToolCall[] = [];
    const pending = new Map<string, { name: string; id?: string }>();
    for (const part of content.parts) {
      const call = this.asRecord(part.functionCall);
      if (!call) continue;
      if (typeof call.name !== "string" || !this.asRecord(call.args))
        throw new NotalithError("Invalid Gemini function call.", "provider");
      const callId = `gemini-call-${++this.nextCallId}`;
      const id = typeof call.id === "string" ? call.id : undefined;
      const toolCall = {
        callId,
        name: call.name,
        arguments: JSON.stringify(call.args),
      };
      toolCalls.push(toolCall);
      pending.set(callId, { name: call.name, ...(id ? { id } : {}) });
    }
    if (
      !content.parts.length ||
      (!toolCalls.length &&
        !content.parts.some(
          (part) =>
            typeof part.text === "string" &&
            part.thought !== true &&
            part.text.length > 0,
        ))
    )
      throw new NotalithError("Gemini returned an empty response.", "provider");
    for (const call of toolCalls) handlers.onToolCall(call);
    return { content, toolCalls, usage, pending };
  }

  private emitText(part: JsonObject, handlers: ProviderHandlers): void {
    if (part.thought !== true && typeof part.text === "string" && part.text)
      handlers.onTextDelta(part.text);
  }

  private parseContent(value: unknown): GeminiContent {
    const content = this.asRecord(value);
    if (
      !content ||
      !Array.isArray(content.parts) ||
      content.parts.some((part) => !this.asRecord(part))
    )
      throw new NotalithError("Invalid Gemini model content.", "provider");
    return {
      ...content,
      role: typeof content.role === "string" ? content.role : "model",
      parts: content.parts as JsonObject[],
    };
  }

  private candidate(response: JsonObject): JsonObject | null {
    return Array.isArray(response.candidates)
      ? this.asRecord(response.candidates[0])
      : null;
  }

  private parseUsage(value: unknown): ProviderUsage | undefined {
    const usage = this.asRecord(value);
    if (!usage) return undefined;
    return {
      inputTokens:
        typeof usage.promptTokenCount === "number"
          ? usage.promptTokenCount
          : undefined,
      outputTokens:
        typeof usage.candidatesTokenCount === "number"
          ? usage.candidatesTokenCount
          : undefined,
      totalTokens:
        typeof usage.totalTokenCount === "number"
          ? usage.totalTokenCount
          : undefined,
    };
  }

  private finishError(reason: unknown): NotalithError {
    const category =
      reason === "SAFETY" ||
      reason === "RECITATION" ||
      reason === "PROHIBITED_CONTENT"
        ? "content_filter"
        : reason === "MAX_TOKENS"
          ? "context_length"
          : "provider";
    return new NotalithError(
      `Gemini response did not complete normally (${typeof reason === "string" ? reason : "interrupted"}).`,
      category,
    );
  }

  private validateConfiguration(): void {
    if (!this.connection.endpoint || !this.model.modelId)
      throw new NotalithError(
        "Configure a Gemini endpoint and model.",
        "configuration",
      );
    let endpoint: URL;
    try {
      endpoint = new URL(this.connection.endpoint);
    } catch {
      throw new NotalithError("Invalid Gemini endpoint.", "configuration");
    }
    if (
      endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        (endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1")
      )
    )
      throw new NotalithError(
        "Gemini endpoint must use HTTPS.",
        "configuration",
      );
    if (!this.getApiKey())
      throw new NotalithError(
        "Save a Gemini API key in Notalith settings.",
        "authentication",
      );
  }

  private url(stream: boolean): string {
    const base = this.connection.endpoint.replace(/\/+$/, "");
    const modelId = this.model.modelId.replace(/^models\//, "");
    return `${base}/models/${encodeURIComponent(modelId)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  }

  private headers(): Record<string, string> {
    const key = this.getApiKey();
    if (!key)
      throw new NotalithError(
        "Gemini API key is not configured.",
        "authentication",
      );
    return { "Content-Type": "application/json", "x-goog-api-key": key };
  }

  private httpError(status: number, body: string): NotalithError {
    let message = `Gemini request failed (${status}).`;
    try {
      const error = this.asRecord(this.asRecord(JSON.parse(body))?.error);
      if (typeof error?.message === "string") message = error.message;
    } catch {
      // HTTP status remains available when the response is not JSON.
    }
    const category =
      status === 401
        ? "authentication"
        : status === 403
          ? "authorization"
          : status === 404 || status === 400
            ? "configuration"
            : status === 402
              ? "quota"
              : status === 429
                ? /quota/i.test(message)
                  ? "quota"
                  : "rate_limit"
                : status === 413
                  ? "context_length"
                  : status === 408
                    ? "network"
                    : "provider";
    return new NotalithError(message, category, status);
  }

  private streamError(value: unknown): NotalithError {
    const error = this.asRecord(value);
    const status = typeof error?.code === "number" ? error.code : 0;
    return this.httpError(status, JSON.stringify({ error }));
  }

  private normalizeError(error: unknown): NotalithError {
    if (error instanceof NotalithError) return error;
    if (error instanceof Error && error.name === "AbortError")
      return this.cancelledError();
    if (error instanceof TypeError)
      return new NotalithError(error.message, "network");
    return new NotalithError(
      error instanceof Error ? error.message : String(error),
      "provider",
    );
  }

  private cancelledError(): NotalithError {
    return new NotalithError("Request cancelled.", "cancelled");
  }

  private silentHandlers(): ProviderHandlers {
    return { onTextDelta() {}, onToolCall() {}, onUsage() {} };
  }

  private asRecord(value: unknown): JsonObject | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonObject)
      : null;
  }
}
