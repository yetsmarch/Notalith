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
import type { ModelProvider } from "./provider";

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type ChatContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatContent[] }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: ChatToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatResponse {
  message: ChatMessage & { role: "assistant" };
  toolCalls: ToolCall[];
  usage?: ProviderUsage;
}

export interface ChatProviderOptions {
  name: string;
  supportsImages: boolean;
  preserveReasoning?: boolean;
  apiKeyHeader?: "api-key";
}

export class ChatCompletionsProvider implements ModelProvider {
  readonly supportsImageToolResults = false;
  private history: ChatMessage[] = [];
  private turnStart: number | null = null;

  constructor(
    private readonly connection: ProviderConnection,
    private readonly model: ModelProfile,
    private readonly systemPrompt: string,
    private readonly getApiKey: () => string | null,
    private readonly options: ChatProviderOptions,
  ) {}

  get supportsImages(): boolean {
    return this.options.supportsImages;
  }

  resetConversation(): void {
    this.history = [];
    this.turnStart = null;
  }

  finishTurn(): void {
    this.turnStart = null;
  }

  abortTurn(): void {
    if (this.turnStart !== null) this.history.length = this.turnStart;
    this.turnStart = null;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    this.validateConfiguration();
    try {
      const response = await requestUrl({
        url: this.chatUrl(),
        method: "POST",
        headers: this.headers(),
        contentType: "application/json",
        body: JSON.stringify({
          model: this.model.modelId,
          messages: [{ role: "user", content: "Reply with OK." }],
          stream: false,
        }),
        throw: false,
      });
      if (response.status < 200 || response.status >= 300) {
        throw this.httpError(response.status, response.text);
      }
      this.parseResponse(response.json, {
        onTextDelta() {},
        onToolCall() {},
        onUsage() {},
      });
      return {
        ok: true,
        message: `Connected to ${this.options.name} model "${this.model.modelId}".`,
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
  ): Promise<ProviderResult> {
    this.validateConfiguration();
    if (signal.aborted) throw this.cancelledError();

    const incoming = this.toMessages(input);
    if (input.kind === "message") this.turnStart = this.history.length;
    const request = {
      model: this.model.modelId,
      messages: [
        { role: "system", content: this.systemPrompt },
        ...this.history,
        ...incoming,
      ],
      tools: tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      stream: true,
    };

    let result: ChatResponse;
    let connected = false;
    try {
      const response = await fetch(this.chatUrl(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(request),
        signal,
      });
      connected = true;
      if (!response.ok) {
        throw this.httpError(response.status, await response.text());
      }
      if (!response.body) {
        throw new NotalithError(
          `${this.options.name} did not return a streaming body.`,
          "provider",
        );
      }
      result = await this.readStream(response.body, handlers);
    } catch (error) {
      if (signal.aborted) throw this.cancelledError();
      if (error instanceof TypeError && !connected) {
        try {
          result = await this.completeResponse(
            { ...request, stream: false },
            handlers,
            signal,
          );
        } catch (fallbackError) {
          if (signal.aborted) throw this.cancelledError();
          throw this.normalizeError(fallbackError);
        }
      } else {
        throw this.normalizeError(error);
      }
    }

    if (signal.aborted) throw this.cancelledError();
    this.history.push(...incoming, result.message);
    return { toolCalls: result.toolCalls, usage: result.usage };
  }

  private toMessages(input: ProviderInput): ChatMessage[] {
    if (input.kind === "message") {
      return [this.userMessage(input.message)];
    }
    return input.results.map(({ callId, output }) => {
      if (typeof output !== "string") {
        throw new NotalithError(
          `${this.options.name} Chat does not support image results from tools.`,
          "tool",
        );
      }
      return { role: "tool", tool_call_id: callId, content: output };
    });
  }

  private userMessage(input: ModelTurnInput): ChatMessage {
    if (input.images.length === 0) return { role: "user", content: input.text };
    if (!this.supportsImages) {
      throw new NotalithError(
        `${this.options.name} model "${this.model.modelId}" does not support image input.`,
        "tool",
      );
    }
    return {
      role: "user",
      content: [
        { type: "text", text: input.text },
        ...input.images.map((image): ChatContent => ({
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${image.data}` },
        })),
      ],
    };
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    handlers: ProviderHandlers,
  ): Promise<ChatResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let reasoning = "";
    let finishReason = "";
    let completed = false;
    let usage: ProviderUsage | undefined;
    const partialCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    const consume = (block: string): void => {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          completed = true;
          continue;
        }
        if (!payload) continue;
        const chunk = this.asRecord(JSON.parse(payload));
        if (!chunk)
          throw new NotalithError(
            `Invalid ${this.options.name} stream event.`,
            "provider",
          );
        if (chunk.error) {
          const error = this.asRecord(chunk.error);
          throw new NotalithError(
            typeof error?.message === "string"
              ? error.message
              : `${this.options.name} streaming request failed.`,
            "provider",
          );
        }
        const parsedUsage = this.parseUsage(chunk.usage);
        if (parsedUsage) {
          usage = parsedUsage;
          handlers.onUsage(parsedUsage);
        }
        const choice = Array.isArray(chunk.choices)
          ? this.asRecord(chunk.choices[0])
          : null;
        if (!choice) continue;
        if (typeof choice.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }
        const delta = this.asRecord(choice.delta);
        if (!delta) continue;
        if (typeof delta.content === "string") {
          text += delta.content;
          handlers.onTextDelta(delta.content);
        }
        if (typeof delta.reasoning_content === "string") {
          reasoning += delta.reasoning_content;
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const value of delta.tool_calls) {
            const call = this.asRecord(value);
            if (!call || typeof call.index !== "number") {
              throw new NotalithError(
                `Invalid ${this.options.name} tool-call chunk.`,
                "provider",
              );
            }
            const partial = partialCalls.get(call.index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (typeof call.id === "string") partial.id += call.id;
            const fn = this.asRecord(call.function);
            if (typeof fn?.name === "string") partial.name += fn.name;
            if (typeof fn?.arguments === "string") {
              partial.arguments += fn.arguments;
            }
            partialCalls.set(call.index, partial);
          }
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) consume(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (
      !completed ||
      (finishReason !== "stop" && finishReason !== "tool_calls")
    ) {
      throw new NotalithError(
        `${this.options.name} response did not complete normally (${finishReason || "interrupted"}).`,
        "provider",
      );
    }

    const toolCalls = [...partialCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]): ToolCall => {
        if (!call.id || !call.name || !call.arguments) {
          throw new NotalithError(
            `Incomplete ${this.options.name} tool call.`,
            "provider",
          );
        }
        return { callId: call.id, name: call.name, arguments: call.arguments };
      });
    if (finishReason === "tool_calls" && toolCalls.length === 0) {
      throw new NotalithError(
        `${this.options.name} returned no tool calls.`,
        "provider",
      );
    }
    if (finishReason === "stop" && !text) {
      throw new NotalithError(
        `${this.options.name} returned an empty response.`,
        "provider",
      );
    }
    for (const call of toolCalls) handlers.onToolCall(call);
    return {
      message: this.assistantMessage(text, reasoning, toolCalls),
      toolCalls,
      usage,
    };
  }

  private async completeResponse(
    request: Record<string, unknown>,
    handlers: ProviderHandlers,
    signal: AbortSignal,
  ): Promise<ChatResponse> {
    if (signal.aborted) throw this.cancelledError();
    const response = await requestUrl({
      url: this.chatUrl(),
      method: "POST",
      headers: this.headers(),
      contentType: "application/json",
      body: JSON.stringify(request),
      throw: false,
    });
    if (signal.aborted) throw this.cancelledError();
    if (response.status < 200 || response.status >= 300) {
      throw this.httpError(response.status, response.text);
    }
    return this.parseResponse(response.json, handlers);
  }

  private parseResponse(
    value: unknown,
    handlers: ProviderHandlers,
  ): ChatResponse {
    const response = this.asRecord(value);
    const choice = Array.isArray(response?.choices)
      ? this.asRecord(response.choices[0])
      : null;
    const message = this.asRecord(choice?.message);
    if (
      !choice ||
      !message ||
      (choice.finish_reason !== "stop" && choice.finish_reason !== "tool_calls")
    ) {
      throw new NotalithError(
        `${this.options.name} did not return a complete response.`,
        "provider",
      );
    }
    const text = typeof message.content === "string" ? message.content : "";
    const reasoning =
      typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : "";
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((value): ToolCall => {
          const call = this.asRecord(value);
          const fn = this.asRecord(call?.function);
          if (
            typeof call?.id !== "string" ||
            typeof fn?.name !== "string" ||
            typeof fn.arguments !== "string"
          ) {
            throw new NotalithError(
              `Invalid ${this.options.name} tool call.`,
              "provider",
            );
          }
          return {
            callId: call.id,
            name: fn.name,
            arguments: fn.arguments,
          };
        })
      : [];
    if (choice.finish_reason === "tool_calls" && toolCalls.length === 0) {
      throw new NotalithError(
        `${this.options.name} returned no tool calls.`,
        "provider",
      );
    }
    if (choice.finish_reason === "stop" && !text) {
      throw new NotalithError(
        `${this.options.name} returned an empty response.`,
        "provider",
      );
    }
    if (text) handlers.onTextDelta(text);
    for (const call of toolCalls) handlers.onToolCall(call);
    const usage = this.parseUsage(response?.usage);
    if (usage) handlers.onUsage(usage);
    return {
      message: this.assistantMessage(text, reasoning, toolCalls),
      toolCalls,
      usage,
    };
  }

  private assistantMessage(
    text: string,
    reasoning: string,
    calls: ToolCall[],
  ): ChatResponse["message"] {
    return {
      role: "assistant",
      content: text || null,
      ...(reasoning && this.options.preserveReasoning
        ? { reasoning_content: reasoning }
        : {}),
      ...(calls.length
        ? {
            tool_calls: calls.map((call): ChatToolCall => ({
              id: call.callId,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    };
  }

  private parseUsage(value: unknown): ProviderUsage | undefined {
    const usage = this.asRecord(value);
    if (!usage) return undefined;
    const inputTokens =
      typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
    const outputTokens =
      typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : undefined;
    const totalTokens =
      typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
    return { inputTokens, outputTokens, totalTokens };
  }

  private validateConfiguration(): void {
    if (!this.connection.endpoint || !this.model.modelId) {
      throw new NotalithError(
        `Configure a ${this.options.name} endpoint and model.`,
        "configuration",
      );
    }
    const endpoint = new URL(this.connection.endpoint);
    if (
      endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        (endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1")
      )
    ) {
      throw new NotalithError(
        `${this.options.name} endpoint must use HTTPS.`,
        "configuration",
      );
    }
    if (!this.getApiKey()) {
      throw new NotalithError(
        `Save a ${this.options.name} API key in Notalith settings.`,
        "authentication",
      );
    }
  }

  private chatUrl(): string {
    return `${this.connection.endpoint.replace(/\/+$/, "")}/chat/completions`;
  }

  private headers(): Record<string, string> {
    const key = this.getApiKey();
    if (!key)
      throw new NotalithError(
        `${this.options.name} API key is not configured.`,
        "authentication",
      );
    return {
      "Content-Type": "application/json",
      ...(this.options.apiKeyHeader
        ? { [this.options.apiKeyHeader]: key }
        : { Authorization: `Bearer ${key}` }),
    };
  }

  private httpError(status: number, body: string): NotalithError {
    let message = `${this.options.name} request failed (${status}).`;
    try {
      const response = this.asRecord(JSON.parse(body));
      const error = this.asRecord(response?.error);
      if (typeof error?.message === "string") message = error.message;
    } catch {
      // The status code is still reported for non-JSON errors.
    }

    const category =
      status === 401
        ? "authentication"
        : status === 403
          ? "authorization"
          : status === 429
            ? "rate_limit"
            : "provider";
    return new NotalithError(message, category, status);
  }

  private normalizeError(error: unknown): NotalithError {
    if (error instanceof NotalithError) return error;
    if (error instanceof DOMException && error.name === "AbortError") {
      return this.cancelledError();
    }
    if (error instanceof TypeError)
      return new NotalithError(error.message, "network");
    if (error instanceof Error)
      return new NotalithError(error.message, "provider");
    return new NotalithError(String(error), "provider");
  }

  private cancelledError(): NotalithError {
    return new NotalithError("Request cancelled.", "cancelled");
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
}
