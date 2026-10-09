import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "./anthropic";
import { AzureFoundryProvider } from "./azure-foundry";
import { ChatCompletionsProvider } from "./chat-completions";
import { GeminiProvider } from "./gemini";
import type { ModelProvider } from "./provider";
import type { ProviderId } from "../types";

const { requestUrlMock } = vi.hoisted(() => ({
  requestUrlMock: vi.fn<
    (request: { body: string }) => Promise<{
      status: number;
      json: unknown;
    }>
  >(),
}));
vi.mock("obsidian", () => ({ requestUrl: requestUrlMock }));

const handlers = {
  onTextDelta: vi.fn(),
  onToolCall: vi.fn(),
  onUsage: vi.fn(),
};
const signal = () => new AbortController().signal;

interface WireRequest {
  previous_response_id?: string;
  max_output_tokens?: number;
  max_completion_tokens?: number;
  max_tokens?: number;
  generationConfig?: { maxOutputTokens: number };
  messages: Array<{ content: Array<Record<string, unknown>> }>;
  contents: Array<{ parts: Array<Record<string, unknown>> }>;
  input: Array<Record<string, unknown>>;
}

function create(id: ProviderId, protocol: string): ModelProvider {
  const connection = {
    id,
    endpoint: "https://example.test/v1",
    apiKeySecretId: "secret-ref",
  };
  const model = {
    id: "model",
    connectionId: id,
    modelId: "deployment",
    displayName: "Model",
    supportsImages: true,
  };
  const args = [connection, model, "System rules", () => "secret"] as const;
  if (protocol === "responses") return new AzureFoundryProvider(...args);
  if (protocol === "anthropic") return new AnthropicProvider(...args);
  if (protocol === "gemini") return new GeminiProvider(...args);
  return new ChatCompletionsProvider(...args, {
    name: "Chat",
    supportsImages: true,
    preserveReasoning: id === "deepseek",
  });
}

function response(protocol: string, text = "Answer", index = 1) {
  if (protocol === "responses")
    return {
      id: `response-${index}`,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 2 },
    };
  if (protocol === "anthropic")
    return {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 30,
        output_tokens: 2,
      },
    };
  if (protocol === "gemini")
    return {
      candidates: [
        { content: { role: "model", parts: [{ text }] }, finishReason: "STOP" },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
    };
  return {
    choices: [
      { message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  };
}

describe("provider context replacement on the wire", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("CORS")));
    requestUrlMock.mockReset();
  });

  it.each([
    ["azure-foundry", "responses"],
    ["azure-foundry", "chat"],
    ["deepseek", "chat"],
    ["anthropic", "anthropic"],
    ["gemini", "gemini"],
  ] as const)(
    "replaces %s/%s history while keeping recent messages and isolating summary calls",
    async (id, protocol) => {
      const provider = create(id, protocol);
      let index = 0;
      requestUrlMock.mockImplementation(async () => ({
        status: 200,
        json: response(protocol, "answer", ++index),
      }));
      for (const text of [
        "ARCHIVED_MARKER" + "x".repeat(12_000),
        "RECENT_MARKER",
      ]) {
        await provider.respond(
          { kind: "message", message: { text, images: [] } },
          [],
          handlers,
          signal(),
        );
        provider.finishTurn();
      }
      const before = provider.context.snapshot();
      provider.context.replace("Compact facts", 1, before.revision);
      provider.onContextReplaced?.();
      expect(provider.context.snapshot().tokens).toBeLessThan(
        before.tokens / 10,
      );
      await provider.respond(
        { kind: "message", message: { text: "Next", images: [] } },
        [],
        handlers,
        signal(),
      );
      provider.finishTurn();
      const request = JSON.parse(
        requestUrlMock.mock.calls[2][0].body,
      ) as WireRequest;
      const wire = JSON.stringify(request);
      expect(wire).toContain("Compact facts");
      expect(wire).toContain("RECENT_MARKER");
      expect(wire).not.toContain("ARCHIVED_MARKER");
      expect(wire).toContain("System rules");
      if (protocol === "responses")
        expect(request.previous_response_id).toBeUndefined();

      const snapshot = provider.context.snapshot();
      const summarizer = provider.createSummaryProvider("Summary rules");
      await summarizer.respond(
        {
          kind: "message",
          message: { text: "History to summarize", images: [] },
        },
        [],
        handlers,
        signal(),
        { maxOutputTokens: 2000 },
      );
      expect(provider.context.snapshot()).toEqual(snapshot);
      const summaryRequest = JSON.parse(
        requestUrlMock.mock.calls[3][0].body,
      ) as WireRequest;
      expect(JSON.stringify(summaryRequest)).toContain("Summary rules");
      expect(JSON.stringify(summaryRequest)).not.toContain("RECENT_MARKER");
      expect(summaryRequest.previous_response_id).toBeUndefined();
      if (protocol === "responses")
        expect(summaryRequest.max_output_tokens).toBe(2000);
      else if (protocol === "anthropic" || id === "deepseek")
        expect(summaryRequest.max_tokens).toBe(2000);
      else if (protocol === "gemini")
        expect(summaryRequest.generationConfig?.maxOutputTokens).toBe(2000);
      else expect(summaryRequest.max_completion_tokens).toBe(2000);

      provider.resetConversation();
      expect(provider.context.snapshot().summary).toBe("");
      expect(provider.context.snapshot().turns).toEqual([]);
    },
  );

  it("counts cached Claude input in the context-pressure usage", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: response("anthropic"),
    });
    const result = await create("anthropic", "anthropic").respond(
      { kind: "message", message: { text: "Hello", images: [] } },
      [],
      handlers,
      signal(),
    );
    expect(result.usage).toMatchObject({
      inputTokens: 60,
      outputTokens: 2,
      totalTokens: 62,
    });
  });

  it("retains Claude thinking signatures and a pending call across an older-history replacement", async () => {
    const provider = new AnthropicProvider(
      {
        id: "anthropic",
        endpoint: "https://example.test/v1",
        apiKeySecretId: "secret",
      },
      {
        id: "model",
        connectionId: "anthropic",
        modelId: "claude",
        displayName: "Claude",
      },
      "System rules",
      () => "key",
    );
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: response("anthropic"),
    });
    await provider.respond(
      { kind: "message", message: { text: "old", images: [] } },
      [],
      handlers,
      signal(),
    );
    provider.finishTurn();
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "reason",
            signature: "signature-exact",
          },
          {
            type: "tool_use",
            id: "pending-call",
            name: "read_note",
            input: { path: "Notes/a.md" },
          },
        ],
        stop_reason: "tool_use",
      },
    });
    await provider.respond(
      { kind: "message", message: { text: "read note", images: [] } },
      [],
      handlers,
      signal(),
    );
    provider.context.replace(
      "old facts",
      1,
      provider.context.snapshot().revision,
    );
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: response("anthropic"),
    });
    await provider.respond(
      {
        kind: "tool-results",
        results: [{ callId: "pending-call", output: "content" }],
      },
      [],
      handlers,
      signal(),
    );
    const wire = JSON.parse(
      requestUrlMock.mock.calls[2][0].body,
    ) as WireRequest;
    expect(wire.messages[3].content[0]).toEqual({
      type: "thinking",
      thinking: "reason",
      signature: "signature-exact",
    });
    expect(wire.messages[4].content[0].tool_use_id).toBe("pending-call");
    provider.abortTurn();
    expect(provider.context.snapshot().turns).toEqual([]);
    expect(provider.context.snapshot().summary).toBe("old facts");
  });

  it("retains Gemini call IDs, thought signatures and pending-result mapping", async () => {
    const provider = create("gemini", "gemini");
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: response("gemini"),
    });
    await provider.respond(
      { kind: "message", message: { text: "old", images: [] } },
      [],
      handlers,
      signal(),
    );
    provider.finishTurn();
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: "read_note",
                    id: "native-call",
                    args: {},
                  },
                  thoughtSignature: "signature-exact",
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    });
    const result = await provider.respond(
      { kind: "message", message: { text: "read", images: [] } },
      [],
      handlers,
      signal(),
    );
    provider.context.replace(
      "old facts",
      1,
      provider.context.snapshot().revision,
    );
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: response("gemini"),
    });
    await provider.respond(
      {
        kind: "tool-results",
        results: [{ callId: result.toolCalls[0].callId, output: "content" }],
      },
      [],
      handlers,
      signal(),
    );
    const wire = JSON.parse(
      requestUrlMock.mock.calls[2][0].body,
    ) as WireRequest;
    expect(wire.contents[3].parts[0].thoughtSignature).toBe("signature-exact");
    expect(wire.contents[4].parts[0].functionResponse).toMatchObject({
      id: "native-call",
    });
  });

  it("replays Responses tool pairs after cutting the old server chain and does not resurrect it on abort", async () => {
    const provider = create("azure-foundry", "responses");
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: response("responses"),
    });
    await provider.respond(
      { kind: "message", message: { text: "old", images: [] } },
      [],
      handlers,
      signal(),
    );
    provider.finishTurn();
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: {
        id: "old-chain",
        output: [
          {
            type: "function_call",
            call_id: "call",
            name: "read_note",
            arguments: "{}",
          },
        ],
      },
    });
    await provider.respond(
      { kind: "message", message: { text: "read", images: [] } },
      [],
      handlers,
      signal(),
    );
    provider.context.replace(
      "old facts",
      1,
      provider.context.snapshot().revision,
    );
    provider.onContextReplaced?.();
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: response("responses", "answer", 3),
    });
    await provider.respond(
      {
        kind: "tool-results",
        results: [{ callId: "call", output: "content" }],
      },
      [],
      handlers,
      signal(),
    );
    const wire = JSON.parse(
      requestUrlMock.mock.calls[2][0].body,
    ) as WireRequest;
    expect(wire.previous_response_id).toBeUndefined();
    expect(wire.input.at(-2)).toMatchObject({ call_id: "call" });
    expect(wire.input.at(-1)).toEqual({
      type: "function_call_output",
      call_id: "call",
      output: "content",
    });
    provider.abortTurn();
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: response("responses", "answer", 4),
    });
    await provider.respond(
      { kind: "message", message: { text: "fresh", images: [] } },
      [],
      handlers,
      signal(),
    );
    const next = JSON.parse(
      requestUrlMock.mock.calls[3][0].body,
    ) as WireRequest;
    expect(next.previous_response_id).toBeUndefined();
    expect(JSON.stringify(next.input)).toContain("old facts");
    expect(JSON.stringify(next.input)).not.toContain("function_call");
  });
});
