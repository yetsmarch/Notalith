import { requestUrl } from "obsidian";
import type {
  ConnectionTestResult,
  ModelImage,
  ModelProfile,
  ProviderConnection,
  ProviderHandlers,
  ProviderInput,
  ProviderResult,
  ProviderUsage,
  ToolCall,
  ToolDefinition,
  ToolOutput,
} from "../types";
import { NotalithError } from "../types";
import type { ModelProvider } from "./provider";

type TextBlock = { type: "text"; text: string };
type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<TextBlock | ImageBlock>;
};
type MessageBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;
type Message = {
  role: "user" | "assistant";
  content: string | MessageBlock[];
};
type AssistantMessage = {
  role: "assistant";
  content: Array<TextBlock | ToolUseBlock>;
};
type Completion = {
  message: AssistantMessage;
  toolCalls: ToolCall[];
  usage?: ProviderUsage;
};
type PartialBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      json: string;
    };

const API_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export class AnthropicProvider implements ModelProvider {
  private history: Message[] = [];
  private turnStart: number | null = null;

  constructor(
    private readonly connection: ProviderConnection,
    private readonly model: ModelProfile,
    private readonly systemPrompt: string,
    private readonly getApiKey: () => string | null,
  ) {}

  get supportsImages(): boolean {
    return this.model.supportsImages === true;
  }

  get supportsImageToolResults(): boolean {
    return this.supportsImages;
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
    try {
      this.validateConfiguration();
      const response = await requestUrl({
        url: this.messagesUrl(),
        method: "POST",
        headers: this.headers(),
        contentType: "application/json",
        body: JSON.stringify({
          model: this.model.modelId,
          max_tokens: 16,
          messages: [{ role: "user", content: "Reply with OK." }],
        }),
        throw: false,
      });
      if (response.status < 200 || response.status >= 300)
        throw this.httpError(response.status, response.text);
      this.parseCompletion(response.json);
      return {
        ok: true,
        message: `Connected to Anthropic model "${this.model.modelId}".`,
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
      max_tokens: MAX_TOKENS,
      ...(this.systemPrompt ? { system: this.systemPrompt } : {}),
      messages: [...this.history, ...incoming],
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
      stream: true,
    };

    let completion: Completion;
    let responseReceived = false;
    try {
      const response = await fetch(this.messagesUrl(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(request),
        signal,
      });
      responseReceived = true;
      if (!response.ok)
        throw this.httpError(response.status, await response.text());
      if (!response.body) {
        completion = await this.completeResponse(
          { ...request, stream: false },
          handlers,
          signal,
        );
      } else {
        completion = await this.readStream(response.body, handlers, signal);
      }
    } catch (error) {
      if (signal.aborted) throw this.cancelledError();
      if (error instanceof TypeError && !responseReceived) {
        try {
          completion = await this.completeResponse(
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
    this.history.push(...incoming, completion.message);
    return { toolCalls: completion.toolCalls, usage: completion.usage };
  }

  private toMessages(input: ProviderInput): Message[] {
    if (input.kind === "message") {
      if (input.message.images.length === 0) {
        if (!input.message.text)
          throw new NotalithError(
            "Cannot send an empty Anthropic message.",
            "configuration",
          );
        return [{ role: "user", content: input.message.text }];
      }
      if (!this.supportsImages)
        throw new NotalithError(
          "The selected Anthropic model does not support image input.",
          "tool",
        );
      return [
        {
          role: "user",
          content: [
            ...(input.message.text
              ? [{ type: "text" as const, text: input.message.text }]
              : []),
            ...input.message.images.map((image) => this.imageBlock(image)),
          ],
        },
      ];
    }
    const last = this.history[this.history.length - 1];
    const expected =
      last?.role === "assistant" && Array.isArray(last.content)
        ? last.content.filter(
            (block): block is ToolUseBlock => block.type === "tool_use",
          )
        : [];
    if (
      expected.length === 0 ||
      input.results.length !== expected.length ||
      new Set(input.results.map((result) => result.callId)).size !==
        expected.length ||
      input.results.some(
        (result) => !expected.some((call) => call.id === result.callId),
      )
    ) {
      throw new NotalithError(
        "Anthropic tool results do not match pending tool calls.",
        "tool",
      );
    }
    return [
      {
        role: "user",
        content: input.results.map(({ callId, output }): ToolResultBlock => ({
          type: "tool_result",
          tool_use_id: callId,
          content: this.toolOutput(output),
        })),
      },
    ];
  }

  private toolOutput(output: ToolOutput): ToolResultBlock["content"] {
    if (typeof output === "string") return output;
    if (!this.supportsImageToolResults)
      throw new NotalithError(
        "The selected Anthropic model does not support image tool results.",
        "tool",
      );
    if (!output.length)
      throw new NotalithError("Empty Anthropic tool result.", "tool");
    return output.map((part): TextBlock | ImageBlock => {
      if (part.type === "input_text" && typeof part.text === "string")
        return { type: "text", text: part.text };
      if (part.type === "input_image" && typeof part.image_url === "string") {
        const match =
          /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
            part.image_url,
          );
        if (match)
          return this.imageBlock({
            mimeType: match[1].toLowerCase(),
            data: match[2],
            sourcePath: "",
          });
      }
      throw new NotalithError(
        "Unsupported Anthropic image tool result.",
        "tool",
      );
    });
  }

  private imageBlock(image: ModelImage): ImageBlock {
    const mimeType = image.mimeType.toLowerCase();
    if (
      !IMAGE_TYPES.has(mimeType) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        image.data,
      ) ||
      !image.data
    ) {
      throw new NotalithError(
        "Anthropic requires a base64 JPEG, PNG, GIF, or WebP image.",
        "tool",
      );
    }
    return {
      type: "image",
      source: { type: "base64", media_type: mimeType, data: image.data },
    };
  }

  private async completeResponse(
    request: Record<string, unknown>,
    handlers: ProviderHandlers,
    signal: AbortSignal,
  ): Promise<Completion> {
    if (signal.aborted) throw this.cancelledError();
    const response = await requestUrl({
      url: this.messagesUrl(),
      method: "POST",
      headers: this.headers(),
      contentType: "application/json",
      body: JSON.stringify(request),
      throw: false,
    });
    if (signal.aborted) throw this.cancelledError();
    if (response.status < 200 || response.status >= 300)
      throw this.httpError(response.status, response.text);
    const completion = this.parseCompletion(response.json);
    if (signal.aborted) throw this.cancelledError();
    for (const block of completion.message.content) {
      if (block.type === "text" && block.text) handlers.onTextDelta(block.text);
      if (signal.aborted) throw this.cancelledError();
    }
    for (const call of completion.toolCalls) {
      handlers.onToolCall(call);
      if (signal.aborted) throw this.cancelledError();
    }
    if (completion.usage) handlers.onUsage(completion.usage);
    return completion;
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    handlers: ProviderHandlers,
    signal: AbortSignal,
  ): Promise<Completion> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let started = false;
    let stopped = false;
    let stopReason = "";
    let usage: ProviderUsage | undefined;
    const blocks = new Map<number, PartialBlock>();
    const open = new Set<number>();

    const consume = (frame: string): void => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) return;
      let event: Record<string, unknown> | null;
      try {
        event = this.asRecord(JSON.parse(data));
      } catch {
        throw new NotalithError("Invalid Anthropic stream event.", "provider");
      }
      if (!event || typeof event.type !== "string")
        throw new NotalithError("Invalid Anthropic stream event.", "provider");
      if (event.type === "error") {
        const error = this.asRecord(event.error);
        throw new NotalithError(
          typeof error?.message === "string"
            ? error.message
            : "Anthropic streaming request failed.",
          "provider",
        );
      }
      if (event.type === "ping") return;
      if (stopped)
        throw new NotalithError(
          "Anthropic stream continued after message_stop.",
          "provider",
        );
      if (event.type === "message_start") {
        const message = this.asRecord(event.message);
        if (
          started ||
          message?.type !== "message" ||
          message.role !== "assistant" ||
          !Array.isArray(message.content) ||
          message.content.length !== 0
        )
          throw new NotalithError(
            "Invalid Anthropic message_start.",
            "provider",
          );
        started = true;
        usage = this.mergeUsage(usage, message.usage);
        if (usage) handlers.onUsage(usage);
        return;
      }
      if (!started)
        throw new NotalithError(
          "Anthropic stream is missing message_start.",
          "provider",
        );
      if (stopReason && event.type !== "message_stop")
        throw new NotalithError(
          "Anthropic stream continued after stop reason.",
          "provider",
        );
      if (event.type === "content_block_start") {
        const index = this.blockIndex(event.index);
        if (index !== blocks.size || open.size)
          throw new NotalithError(
            "Invalid Anthropic content block order.",
            "provider",
          );
        const block = this.asRecord(event.content_block);
        if (block?.type === "text" && typeof block.text === "string") {
          blocks.set(index, { type: "text", text: block.text });
          if (block.text) handlers.onTextDelta(block.text);
        } else if (
          block?.type === "tool_use" &&
          typeof block.id === "string" &&
          block.id &&
          typeof block.name === "string" &&
          block.name &&
          this.asRecord(block.input)
        ) {
          blocks.set(index, {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
            json: "",
          });
        } else {
          throw new NotalithError(
            "Invalid Anthropic content block.",
            "provider",
          );
        }
        open.add(index);
      } else if (event.type === "content_block_delta") {
        const block = blocks.get(this.blockIndex(event.index));
        const delta = this.asRecord(event.delta);
        if (!block || !open.has(event.index as number) || !delta)
          throw new NotalithError(
            "Invalid Anthropic content delta.",
            "provider",
          );
        if (
          block.type === "text" &&
          delta.type === "text_delta" &&
          typeof delta.text === "string"
        ) {
          block.text += delta.text;
          if (delta.text) handlers.onTextDelta(delta.text);
        } else if (
          block.type === "tool_use" &&
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          block.json += delta.partial_json;
        } else {
          throw new NotalithError(
            "Invalid Anthropic content delta.",
            "provider",
          );
        }
      } else if (event.type === "content_block_stop") {
        if (!open.delete(this.blockIndex(event.index)))
          throw new NotalithError(
            "Invalid Anthropic content_block_stop.",
            "provider",
          );
      } else if (event.type === "message_delta") {
        if (open.size || stopReason)
          throw new NotalithError(
            "Invalid Anthropic message_delta.",
            "provider",
          );
        const delta = this.asRecord(event.delta);
        if (typeof delta?.stop_reason !== "string")
          throw new NotalithError("Missing Anthropic stop reason.", "provider");
        stopReason = delta.stop_reason;
        usage = this.mergeUsage(usage, event.usage);
        if (usage) handlers.onUsage(usage);
      } else if (event.type === "message_stop") {
        if (!stopReason || open.size)
          throw new NotalithError("Incomplete Anthropic stream.", "provider");
        stopped = true;
      } else {
        throw new NotalithError("Unknown Anthropic stream event.", "provider");
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw this.cancelledError();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          consume(frame);
          if (signal.aborted) throw this.cancelledError();
        }
      }
      buffer += decoder.decode();
      if (buffer.trim() || !stopped)
        throw new NotalithError(
          "Anthropic stream did not complete normally.",
          "provider",
        );
      const content = [...blocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, block]): TextBlock | ToolUseBlock => {
          if (block.type === "text") return { type: "text", text: block.text };
          let input: unknown = block.input;
          if (block.json) {
            try {
              input = JSON.parse(block.json) as unknown;
            } catch {
              throw new NotalithError(
                "Invalid Anthropic tool arguments.",
                "provider",
              );
            }
          }
          const parsed = this.asRecord(input);
          if (!parsed)
            throw new NotalithError(
              "Invalid Anthropic tool arguments.",
              "provider",
            );
          return {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: parsed,
          };
        });
      const completion = this.makeCompletion(content, stopReason, usage);
      for (const call of completion.toolCalls) {
        handlers.onToolCall(call);
        if (signal.aborted) throw this.cancelledError();
      }
      return completion;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private parseCompletion(value: unknown): Completion {
    const response = this.asRecord(value);
    if (
      response?.type !== "message" ||
      response.role !== "assistant" ||
      !Array.isArray(response.content)
    )
      throw new NotalithError(
        "Invalid Anthropic Messages response.",
        "provider",
      );
    const content = response.content.map((item): TextBlock | ToolUseBlock => {
      const block = this.asRecord(item);
      if (block?.type === "text" && typeof block.text === "string")
        return { type: "text", text: block.text };
      if (
        block?.type === "tool_use" &&
        typeof block.id === "string" &&
        block.id &&
        typeof block.name === "string" &&
        block.name &&
        this.asRecord(block.input)
      ) {
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      }
      throw new NotalithError(
        "Invalid Anthropic response content.",
        "provider",
      );
    });
    return this.makeCompletion(
      content,
      response.stop_reason,
      this.mergeUsage(undefined, response.usage),
    );
  }

  private makeCompletion(
    content: Array<TextBlock | ToolUseBlock>,
    reason: unknown,
    usage?: ProviderUsage,
  ): Completion {
    const toolCalls = content
      .filter((block): block is ToolUseBlock => block.type === "tool_use")
      .map((block): ToolCall => ({
        callId: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      }));
    if (
      typeof reason !== "string" ||
      !["end_turn", "stop_sequence", "tool_use"].includes(reason) ||
      (reason === "tool_use" ? !toolCalls.length : !!toolCalls.length) ||
      new Set(toolCalls.map((call) => call.callId)).size !== toolCalls.length ||
      (!toolCalls.length &&
        !content.some((block) => block.type === "text" && block.text))
    ) {
      throw new NotalithError(
        `Anthropic response did not complete normally (${typeof reason === "string" ? reason : "interrupted"}).`,
        "provider",
      );
    }
    return { message: { role: "assistant", content }, toolCalls, usage };
  }

  private mergeUsage(
    previous: ProviderUsage | undefined,
    value: unknown,
  ): ProviderUsage | undefined {
    const raw = this.asRecord(value);
    if (!raw) return previous;
    const inputTokens =
      typeof raw.input_tokens === "number"
        ? raw.input_tokens
        : previous?.inputTokens;
    const outputTokens =
      typeof raw.output_tokens === "number"
        ? raw.output_tokens
        : previous?.outputTokens;
    if (inputTokens === undefined && outputTokens === undefined)
      return previous;
    return {
      inputTokens,
      outputTokens,
      totalTokens:
        inputTokens !== undefined && outputTokens !== undefined
          ? inputTokens + outputTokens
          : undefined,
    };
  }

  private blockIndex(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new NotalithError(
        "Invalid Anthropic content block index.",
        "provider",
      );
    return value;
  }

  private validateConfiguration(): void {
    if (!this.connection.endpoint || !this.model.modelId)
      throw new NotalithError(
        "Configure an Anthropic endpoint and model.",
        "configuration",
      );
    let url: URL;
    try {
      url = new URL(this.connection.endpoint);
    } catch {
      throw new NotalithError(
        "Invalid Anthropic endpoint URL.",
        "configuration",
      );
    }
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      )
    ) {
      throw new NotalithError(
        "Anthropic endpoint must use HTTPS.",
        "configuration",
      );
    }
    if (!this.getApiKey())
      throw new NotalithError(
        "Save an Anthropic API key in Notalith settings.",
        "authentication",
      );
  }

  private messagesUrl(): string {
    return `${this.connection.endpoint.replace(/\/+$/, "")}/messages`;
  }

  private headers(): Record<string, string> {
    const key = this.getApiKey();
    if (!key)
      throw new NotalithError(
        "Anthropic API key is not configured.",
        "authentication",
      );
    return {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": API_VERSION,
    };
  }

  private httpError(status: number, body: string): NotalithError {
    let message = `Anthropic request failed (${status}).`;
    let type = "";
    try {
      const error = this.asRecord(this.asRecord(JSON.parse(body))?.error);
      if (typeof error?.message === "string" && error.message)
        message = `Anthropic request failed (${status}): ${error.message}`;
      if (typeof error?.type === "string") type = error.type;
    } catch {
      // Non-JSON provider errors still carry their HTTP status.
    }
    const lower = message.toLowerCase();
    const category =
      status === 401
        ? "authentication"
        : status === 403
          ? "authorization"
          : status === 402 ||
              (status === 429 && /quota|credit|balance/.test(lower))
            ? "quota"
            : status === 429 || type === "rate_limit_error"
              ? "rate_limit"
              : status === 404
                ? "configuration"
                : status === 413 ||
                    /context window|prompt is too long|too many tokens/.test(
                      lower,
                    )
                  ? "context_length"
                  : /content filter|content policy/.test(lower)
                    ? "content_filter"
                    : "provider";
    return new NotalithError(message, category, status);
  }

  private normalizeError(error: unknown): NotalithError {
    if (error instanceof NotalithError) return error;
    if (error instanceof Error && error.name === "AbortError")
      return this.cancelledError();
    if (error instanceof TypeError)
      return new NotalithError(error.message, "network");
    if (error instanceof Error)
      return new NotalithError(error.message, "provider");
    return new NotalithError("Anthropic request failed.", "provider");
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
