import { requestUrl } from "obsidian";
import type {
  ConnectionTestResult,
  ModelTurnInput,
  NotalithSettings,
  ProviderHandlers,
  ProviderResult,
  ProviderUsage,
  ToolCall,
  ToolDefinition,
} from "../types";
import { NotalithError } from "../types";

type ResponseInput = Array<Record<string, unknown>> | string;

interface ResponseRequest {
  model: string;
  instructions?: string;
  input: ResponseInput;
  stream: boolean;
  previous_response_id?: string;
  tools?: ToolDefinition[];
  tool_choice?: "auto";
}

interface ResponseObject {
  id?: string;
  output?: Array<Record<string, unknown>>;
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string;
  };
}

export class AzureFoundryProvider {
  constructor(
    private readonly settings: NotalithSettings,
    private readonly getApiKey: () => string | null,
  ) {}

  async testConnection(): Promise<ConnectionTestResult> {
    this.validateConfiguration();
    const request: ResponseRequest = {
      model: this.settings.deploymentName,
      input: "Reply with OK.",
      stream: false,
    };

    try {
      const response = await requestUrl({
        url: this.responsesUrl(),
        method: "POST",
        headers: this.headers(),
        contentType: "application/json",
        body: JSON.stringify(request),
        throw: false,
      });

      if (response.status < 200 || response.status >= 300) {
        throw this.httpError(response.status, response.text);
      }

      const parsed = response.json as ResponseObject;
      return {
        ok: true,
        message: `Connected to deployment "${this.settings.deploymentName}" (${parsed.id ?? "response received"}).`,
      };
    } catch (error) {
      const normalized = this.normalizeError(error);
      return { ok: false, message: normalized.message };
    }
  }

  async respond(
    input: ModelTurnInput | Array<Record<string, unknown>>,
    tools: ToolDefinition[],
    handlers: ProviderHandlers,
    signal: AbortSignal,
    previousResponseId?: string,
  ): Promise<ProviderResult> {
    this.validateConfiguration();
    if (signal.aborted) throw this.cancelledError();

    const request: ResponseRequest = {
      model: this.settings.deploymentName,
      instructions: previousResponseId ? undefined : this.settings.systemPrompt,
      input: Array.isArray(input) ? input : this.toUserInput(input),
      stream: true,
      previous_response_id: previousResponseId,
      tools,
      tool_choice: "auto",
    };

    try {
      return await this.streamResponse(request, handlers, signal);
    } catch (error) {
      if (signal.aborted) throw this.cancelledError();

      // Obsidian's requestUrl works without CORS but is not streaming. Fall
      // back only for network-level fetch failures, not provider HTTP errors.
      if (error instanceof TypeError) {
        return await this.completeResponse(
          { ...request, stream: false },
          handlers,
          signal,
        );
      }
      throw this.normalizeError(error);
    }
  }

  private async streamResponse(
    request: ResponseRequest,
    handlers: ProviderHandlers,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    const response = await fetch(this.responsesUrl(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(request),
      signal,
    });

    if (!response.ok) {
      throw this.httpError(response.status, await response.text());
    }
    if (!response.body) {
      throw new TypeError("Streaming response body is unavailable.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let responseId = "";
    let usage: ProviderUsage | undefined;
    const toolCalls: ToolCall[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        for (const payload of this.ssePayloads(block)) {
          if (payload === "[DONE]") continue;
          const event = JSON.parse(payload) as Record<string, unknown>;
          const eventType = typeof event.type === "string" ? event.type : "";

          if (eventType === "response.output_text.delta") {
            if (typeof event.delta === "string") {
              handlers.onTextDelta(event.delta);
            }
          } else if (eventType === "response.output_item.done") {
            const call = this.parseToolCall(event.item);
            if (call) {
              toolCalls.push(call);
              handlers.onToolCall(call);
            }
          } else if (
            eventType === "response.created" ||
            eventType === "response.completed"
          ) {
            const parsedResponse = this.asRecord(event.response);
            if (typeof parsedResponse?.id === "string") {
              responseId = parsedResponse.id;
            }
            const parsedUsage = this.parseUsage(parsedResponse?.usage);
            if (parsedUsage) {
              usage = parsedUsage;
              handlers.onUsage(parsedUsage);
            }
          } else if (eventType === "error") {
            const message =
              this.asRecord(event.error)?.message ??
              event.message ??
              "Azure Foundry streaming error.";
            throw new NotalithError(String(message), "provider");
          }
        }
      }
    }

    if (!responseId) {
      throw new NotalithError(
        "Azure Foundry did not return a response ID.",
        "provider",
      );
    }

    return { responseId, toolCalls, usage };
  }

  private async completeResponse(
    request: ResponseRequest,
    handlers: ProviderHandlers,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    if (signal.aborted) throw this.cancelledError();
    const response = await requestUrl({
      url: this.responsesUrl(),
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

    const parsed = response.json as ResponseObject;
    if (parsed.error) {
      throw new NotalithError(
        parsed.error.message ?? "Azure Foundry request failed.",
        "provider",
      );
    }

    const text = this.extractOutputText(parsed);
    if (text) handlers.onTextDelta(text);

    const toolCalls = (parsed.output ?? [])
      .map((item) => this.parseToolCall(item))
      .filter((call): call is ToolCall => call !== null);
    for (const call of toolCalls) handlers.onToolCall(call);

    const usage = this.parseUsage(parsed.usage);
    if (usage) handlers.onUsage(usage);
    if (!parsed.id) {
      throw new NotalithError(
        "Azure Foundry did not return a response ID.",
        "provider",
      );
    }

    return { responseId: parsed.id, toolCalls, usage };
  }

  private toUserInput(input: ModelTurnInput): Array<Record<string, unknown>> {
    const content: Array<Record<string, unknown>> = [
      { type: "input_text", text: input.text },
    ];

    for (const image of input.images) {
      content.push({
        type: "input_image",
        image_url: `data:${image.mimeType};base64,${image.data}`,
        detail: "auto",
      });
    }

    return [{ role: "user", content }];
  }

  private parseToolCall(value: unknown): ToolCall | null {
    const item = this.asRecord(value);
    if (!item || item.type !== "function_call") return null;

    const callId =
      typeof item.call_id === "string"
        ? item.call_id
        : typeof item.id === "string"
          ? item.id
          : "";
    if (
      !callId ||
      typeof item.name !== "string" ||
      typeof item.arguments !== "string"
    ) {
      return null;
    }

    return {
      callId,
      name: item.name,
      arguments: item.arguments,
    };
  }

  private extractOutputText(response: ResponseObject): string {
    if (typeof response.output_text === "string") return response.output_text;
    const parts: string[] = [];

    for (const item of response.output ?? []) {
      if (item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        const block = this.asRecord(content);
        if (block?.type === "output_text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
    }

    return parts.join("");
  }

  private parseUsage(value: unknown): ProviderUsage | undefined {
    const usage = this.asRecord(value);
    if (!usage) return undefined;
    const parsed: ProviderUsage = {
      inputTokens:
        typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
      outputTokens:
        typeof usage.output_tokens === "number"
          ? usage.output_tokens
          : undefined,
      totalTokens:
        typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
    };
    return parsed.inputTokens || parsed.outputTokens || parsed.totalTokens
      ? parsed
      : undefined;
  }

  private ssePayloads(block: string): string[] {
    return block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
  }

  private validateConfiguration(): void {
    if (!this.settings.azureEndpoint || !this.settings.deploymentName) {
      throw new NotalithError(
        "Configure the Azure endpoint and deployment name in Notalith settings.",
        "configuration",
      );
    }
    if (!this.getApiKey()) {
      throw new NotalithError(
        "Save an Azure API key in Notalith settings.",
        "authentication",
      );
    }
  }

  private responsesUrl(): string {
    return `${this.settings.azureEndpoint.replace(/\/+$/, "")}/responses`;
  }

  private headers(): Record<string, string> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new NotalithError(
        "Azure API key is not configured.",
        "authentication",
      );
    }
    return {
      "Content-Type": "application/json",
      "api-key": apiKey,
    };
  }

  private httpError(status: number, body: string): NotalithError {
    let message = `Azure Foundry request failed (${status}).`;
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string; code?: string };
      };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      if (body.trim()) message = `${message} ${body.slice(0, 300)}`;
    }

    if (status === 401) {
      return new NotalithError(message, "authentication", status);
    }
    if (status === 403) {
      return new NotalithError(message, "authorization", status);
    }
    if (status === 429) {
      const category = message.toLocaleLowerCase().includes("quota")
        ? "quota"
        : "rate_limit";
      return new NotalithError(message, category, status);
    }
    if (message.toLocaleLowerCase().includes("content filter")) {
      return new NotalithError(message, "content_filter", status);
    }
    if (
      message.toLocaleLowerCase().includes("context") &&
      message.toLocaleLowerCase().includes("length")
    ) {
      return new NotalithError(message, "context_length", status);
    }
    return new NotalithError(message, "provider", status);
  }

  private normalizeError(error: unknown): NotalithError {
    if (error instanceof NotalithError) return error;
    if (error instanceof DOMException && error.name === "AbortError") {
      return this.cancelledError();
    }
    if (error instanceof TypeError) {
      return new NotalithError(error.message, "network");
    }
    if (error instanceof Error) {
      return new NotalithError(error.message, "provider");
    }
    return new NotalithError(String(error), "provider");
  }

  private cancelledError(): NotalithError {
    return new NotalithError("Request cancelled.", "cancelled");
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  }
}
