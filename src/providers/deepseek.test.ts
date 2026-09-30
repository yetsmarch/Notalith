import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderHandlers, ProviderInput, ToolDefinition } from "../types";
import { DeepSeekProvider } from "./deepseek";

const { requestUrlMock } = vi.hoisted(() => ({
  requestUrlMock:
    vi.fn<
      (request: { body: string }) => Promise<{ status: number; json: unknown }>
    >(),
}));
vi.mock("obsidian", () => ({ requestUrl: requestUrlMock }));

const tools: ToolDefinition[] = [
  {
    type: "function",
    name: "read_note",
    description: "Read a note",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    strict: true,
  },
];
const message: ProviderInput = {
  kind: "message",
  message: { text: "Find notes", images: [] },
};
const handlers = (): ProviderHandlers => ({
  onTextDelta: vi.fn(),
  onToolCall: vi.fn(),
  onUsage: vi.fn(),
});
const provider = (modelId = "deepseek-chat"): DeepSeekProvider =>
  new DeepSeekProvider(
    {
      id: "deepseek",
      endpoint: "https://api.deepseek.com",
      apiKeySecretId: "test",
    },
    { id: modelId, connectionId: "deepseek", displayName: modelId, modelId },
    "Be helpful",
    () => "secret",
  );
const streamed = (...events: object[]): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const payload = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
        controller.enqueue(encoder.encode(payload.slice(0, 25)));
        controller.enqueue(encoder.encode(payload.slice(25)));
        controller.close();
      },
    }),
  );
const ending = (content: string): Response =>
  streamed(
    { choices: [{ delta: { content }, finish_reason: null }] },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { total_tokens: 12 },
    },
  );

function jsonBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string")
    throw new Error("Expected a JSON request body.");
  return JSON.parse(body) as unknown;
}

describe("DeepSeek Chat provider", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    requestUrlMock.mockReset();
  });

  it("preserves reasoning and multiple tool calls across rounds without displaying reasoning", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        streamed(
          { choices: [{ delta: { reasoning_content: "private thought" } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-a",
                      function: { name: "read_note", arguments: '{"path":' },
                    },
                    {
                      index: 1,
                      id: "call-b",
                      function: { name: "read_note", arguments: '{"path":' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: '"a.md"}' } },
                    { index: 1, function: { arguments: '"b.md"}' } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ),
      )
      .mockResolvedValueOnce(ending("Found both"))
      .mockResolvedValueOnce(ending("Next"));
    vi.stubGlobal("fetch", fetchMock);
    const model = provider();
    const onTextDelta = vi.fn();
    const onUsage = vi.fn();
    const observed: ProviderHandlers = {
      onTextDelta,
      onToolCall: vi.fn(),
      onUsage,
    };
    const signal = new AbortController().signal;
    const first = await model.respond(message, tools, observed, signal);
    expect(first.toolCalls).toEqual([
      { callId: "call-a", name: "read_note", arguments: '{"path":"a.md"}' },
      { callId: "call-b", name: "read_note", arguments: '{"path":"b.md"}' },
    ]);
    expect(onTextDelta).not.toHaveBeenCalled();
    await model.respond(
      {
        kind: "tool-results",
        results: [
          { callId: "call-a", output: "A" },
          { callId: "call-b", output: "B" },
        ],
      },
      tools,
      observed,
      signal,
    );
    model.finishTurn();
    const secondRequest = jsonBody(fetchMock.mock.calls[1][1]?.body) as {
      messages: unknown[];
    };
    expect(secondRequest.messages).toEqual([
      { role: "system", content: "Be helpful" },
      { role: "user", content: "Find notes" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "private thought",
        tool_calls: [
          {
            id: "call-a",
            type: "function",
            function: { name: "read_note", arguments: '{"path":"a.md"}' },
          },
          {
            id: "call-b",
            type: "function",
            function: { name: "read_note", arguments: '{"path":"b.md"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-a", content: "A" },
      { role: "tool", tool_call_id: "call-b", content: "B" },
    ]);
    await model.respond(
      { kind: "message", message: { text: "Again", images: [] } },
      tools,
      observed,
      signal,
    );
    expect(
      (
        jsonBody(fetchMock.mock.calls[2][1]?.body) as {
          messages: unknown[];
        }
      ).messages[5],
    ).toEqual({ role: "assistant", content: "Found both" });
    expect(onUsage).toHaveBeenCalledWith({
      totalTokens: 12,
      inputTokens: undefined,
      outputTokens: undefined,
    });
  });

  it("rolls back tool calls after an interrupted tool round", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        streamed({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "read_note", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
                ),
              );
              controller.close();
            },
          }),
        ),
      )
      .mockResolvedValueOnce(ending("Recovered"));
    vi.stubGlobal("fetch", fetchMock);
    const model = provider();
    await model.respond(
      message,
      tools,
      handlers(),
      new AbortController().signal,
    );
    await expect(
      model.respond(
        {
          kind: "tool-results",
          results: [{ callId: "call-1", output: "A" }],
        },
        tools,
        handlers(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("did not complete");
    model.abortTurn();
    await model.respond(
      message,
      tools,
      handlers(),
      new AbortController().signal,
    );
    expect(
      (
        jsonBody(fetchMock.mock.calls[2][1]?.body) as {
          messages: unknown[];
        }
      ).messages,
    ).toHaveLength(2);
  });

  it("falls back on fetch network failure, but never after a partial stream", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("CORS"))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("broken stream"));
            },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: {
        choices: [{ finish_reason: "stop", message: { content: "OK" } }],
      },
    });
    const model = provider();
    await model.respond(
      message,
      tools,
      handlers(),
      new AbortController().signal,
    );
    model.finishTurn();
    expect(
      (
        JSON.parse(requestUrlMock.mock.calls[0][0].body) as Record<
          string,
          unknown
        >
      ).stream,
    ).toBe(false);
    await expect(
      model.respond(message, tools, handlers(), new AbortController().signal),
    ).rejects.toThrow("broken stream");
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
  });

  it("only allows image input for deepseek-flash and rejects image tool results", async () => {
    const input: ProviderInput = {
      kind: "message",
      message: {
        text: "Describe",
        images: [
          { sourcePath: "image.png", mimeType: "image/png", data: "aGVsbG8=" },
        ],
      },
    };
    await expect(
      provider().respond(
        input,
        tools,
        handlers(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("does not support image input");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(ending("An image"));
    vi.stubGlobal("fetch", fetchMock);
    await provider("deepseek-flash").respond(
      input,
      tools,
      handlers(),
      new AbortController().signal,
    );
    expect(
      (
        jsonBody(fetchMock.mock.calls[0][1]?.body) as {
          messages: Array<{ content: unknown[] }>;
        }
      ).messages[1].content[1],
    ).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,aGVsbG8=" },
    });
    await expect(
      provider().respond(
        {
          kind: "tool-results",
          results: [{ callId: "call-1", output: [{ type: "input_image" }] }],
        },
        tools,
        handlers(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("does not support image results");
  });

  it("does not commit a cancelled buffered response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("CORS")),
    );
    let completeRequest:
      ((result: { status: number; json: unknown }) => void) | undefined;
    requestUrlMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeRequest = resolve;
        }),
    );
    const model = provider();
    const controller = new AbortController();
    const pending = model.respond(
      message,
      tools,
      handlers(),
      controller.signal,
    );
    await vi.waitFor(() => expect(requestUrlMock).toHaveBeenCalledOnce());
    controller.abort();
    completeRequest?.({
      status: 200,
      json: {
        choices: [{ finish_reason: "stop", message: { content: "Late" } }],
      },
    });
    await expect(pending).rejects.toThrow("Request cancelled.");
    model.abortTurn();
    expect(requestUrlMock).toHaveBeenCalledOnce();
  });
});
