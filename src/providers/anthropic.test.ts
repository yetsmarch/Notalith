import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, ProviderHandlers, ToolDefinition } from "../types";
import { AnthropicProvider } from "./anthropic";

const { requestUrlMock } = vi.hoisted(() => ({
  requestUrlMock:
    vi.fn<
      (options: {
        body: string;
        headers: Record<string, string>;
      }) => Promise<{ status: number; text: string; json: unknown }>
    >(),
}));
vi.mock("obsidian", () => ({ requestUrl: requestUrlMock }));

const model: ModelProfile = {
  id: "claude",
  connectionId: "anthropic",
  modelId: "claude-sonnet-4-5",
  displayName: "Claude",
  supportsImages: true,
};
const makeProvider = (profile: ModelProfile = model): AnthropicProvider =>
  new AnthropicProvider(
    {
      id: "anthropic",
      endpoint: "https://api.anthropic.com/v1/",
      apiKeySecretId: "key-ref",
    },
    profile,
    "Answer carefully.",
    () => "private-key",
  );
const handlers = (): ProviderHandlers => ({
  onTextDelta: vi.fn(),
  onToolCall: vi.fn(),
  onUsage: vi.fn(),
});
const tools: ToolDefinition[] = [
  {
    type: "function",
    name: "read_image",
    description: "Read an image",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    strict: true,
  },
];
const message = {
  kind: "message" as const,
  message: { text: "Hi", images: [] },
};
const start = {
  type: "message_start",
  message: {
    type: "message",
    role: "assistant",
    content: [],
    usage: { input_tokens: 8, output_tokens: 1 },
  },
};
const textStart = {
  type: "content_block_start",
  index: 0,
  content_block: { type: "text", text: "" },
};
const stopBlock = (index: number) => ({ type: "content_block_stop", index });
const end = (reason: string, tokens = 4) => [
  {
    type: "message_delta",
    delta: { stop_reason: reason },
    usage: { output_tokens: tokens },
  },
  { type: "message_stop" },
];
const stream = (events: object[], complete = true): Response => {
  const payload = events
    .map(
      (event) =>
        `event: ${(event as { type: string }).type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`,
    )
    .join("");
  const bytes = new TextEncoder().encode(payload);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 49));
        controller.enqueue(bytes.slice(49, 128));
        controller.enqueue(bytes.slice(128));
        if (complete) controller.close();
        else controller.error(new Error("connection interrupted"));
      },
    }),
  );
};
const textResponse = (text = "Hello"): Response =>
  stream([
    start,
    textStart,
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    stopBlock(0),
    ...end("end_turn"),
  ]);
const jsonBody = (
  body: BodyInit | null | undefined,
): Record<string, unknown> => {
  if (typeof body !== "string") throw new Error("Missing request body");
  return JSON.parse(body) as Record<string, unknown>;
};
const completed = (content: object[], stopReason = "end_turn") => ({
  type: "message",
  role: "assistant",
  content,
  stop_reason: stopReason,
  usage: { input_tokens: 3, output_tokens: 2 },
});

describe("Anthropic Messages provider", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    requestUrlMock.mockReset();
  });

  it("preserves streamed thinking signatures and redacted blocks through tool results", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        stream([
          start,
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Private reasoning" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "signed-" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "opaque" },
          },
          stopBlock(0),
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "redacted_thinking", data: "opaque-data" },
          },
          stopBlock(1),
          {
            type: "content_block_start",
            index: 2,
            content_block: {
              type: "tool_use",
              id: "call-1",
              name: "read_image",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 2,
            delta: {
              type: "input_json_delta",
              partial_json: '{"path":"picture.png"}',
            },
          },
          stopBlock(2),
          ...end("tool_use"),
        ]),
      )
      .mockResolvedValueOnce(textResponse("Done"))
      .mockResolvedValueOnce(textResponse("New"));
    vi.stubGlobal("fetch", fetchMock);
    const p = makeProvider();
    const onTextDelta = vi.fn();
    const observed = { ...handlers(), onTextDelta };
    const result = await p.respond(
      message,
      tools,
      observed,
      new AbortController().signal,
    );
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([
      {
        callId: "call-1",
        name: "read_image",
        arguments: '{"path":"picture.png"}',
      },
    ]);
    await p.respond(
      {
        kind: "tool-results",
        results: [{ callId: "call-1", output: "image read" }],
      },
      tools,
      handlers(),
      new AbortController().signal,
    );
    expect(jsonBody(fetchMock.mock.calls[1][1]?.body).messages).toEqual([
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Private reasoning",
            signature: "signed-opaque",
          },
          { type: "redacted_thinking", data: "opaque-data" },
          {
            type: "tool_use",
            id: "call-1",
            name: "read_image",
            input: { path: "picture.png" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: "image read" },
        ],
      },
    ]);
    p.abortTurn();
    await p.respond(message, [], handlers(), new AbortController().signal);
    expect(jsonBody(fetchMock.mock.calls[2][1]?.body).messages).toEqual([
      { role: "user", content: "Hi" },
    ]);
  });

  it("preserves completed thinking blocks in fallback history without displaying them", async () => {
    const thinking = {
      type: "thinking",
      thinking: "Reasoning",
      signature: "signature",
    };
    const redacted = { type: "redacted_thinking", data: "hidden" };
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("CORS")));
    requestUrlMock
      .mockResolvedValueOnce({
        status: 200,
        text: "",
        json: completed([thinking, redacted, { type: "text", text: "Answer" }]),
      })
      .mockResolvedValueOnce({
        status: 200,
        text: "",
        json: completed([{ type: "text", text: "Next" }]),
      });
    const p = makeProvider();
    const onTextDelta = vi.fn();
    const observed = { ...handlers(), onTextDelta };
    await p.respond(message, [], observed, new AbortController().signal);
    expect(onTextDelta).toHaveBeenCalledExactlyOnceWith("Answer");
    p.finishTurn();
    await p.respond(message, [], handlers(), new AbortController().signal);
    expect(jsonBody(requestUrlMock.mock.calls[1][0].body).messages).toEqual([
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: [thinking, redacted, { type: "text", text: "Answer" }],
      },
      { role: "user", content: "Hi" },
    ]);
  });

  it("rejects unsigned streamed thinking without committing history", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        stream([
          start,
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
          stopBlock(0),
          {
            ...textStart,
            index: 1,
            content_block: { type: "text", text: "Answer" },
          },
          stopBlock(1),
          ...end("end_turn"),
        ]),
      )
      .mockResolvedValueOnce(textResponse());
    vi.stubGlobal("fetch", fetchMock);
    const p = makeProvider();
    await expect(
      p.respond(message, [], handlers(), new AbortController().signal),
    ).rejects.toThrow("thinking signature");
    expect(requestUrlMock).not.toHaveBeenCalled();
    p.abortTurn();
    await p.respond(message, [], handlers(), new AbortController().signal);
    expect(jsonBody(fetchMock.mock.calls[1][1]?.body).messages).toHaveLength(1);
  });

  it("does not retain thinking from a cancelled response and clears it on reset", async () => {
    const thoughtResponse = () =>
      stream([
        start,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Reasoning" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "opaque" },
        },
        stopBlock(0),
        {
          ...textStart,
          index: 1,
          content_block: { type: "text", text: "Answer" },
        },
        stopBlock(1),
        ...end("end_turn"),
      ]);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(thoughtResponse())
      .mockResolvedValueOnce(thoughtResponse())
      .mockResolvedValueOnce(textResponse());
    vi.stubGlobal("fetch", fetchMock);
    const p = makeProvider();
    const controller = new AbortController();
    await expect(
      p.respond(
        message,
        [],
        { ...handlers(), onTextDelta: () => controller.abort() },
        controller.signal,
      ),
    ).rejects.toMatchObject({ category: "cancelled" });
    p.abortTurn();
    await p.respond(message, [], handlers(), new AbortController().signal);
    expect(jsonBody(fetchMock.mock.calls[1][1]?.body).messages).toHaveLength(1);
    p.finishTurn();
    p.resetConversation();
    await p.respond(message, [], handlers(), new AbortController().signal);
    expect(jsonBody(fetchMock.mock.calls[2][1]?.body).messages).toHaveLength(1);
  });

  it("uses native headers, schema and SSE text/usage without leaking the key into the body", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(textResponse());
    vi.stubGlobal("fetch", fetchMock);
    const provider = makeProvider();
    const onTextDelta = vi.fn();
    const onUsage = vi.fn();
    const observed = { ...handlers(), onTextDelta, onUsage };
    const result = await provider.respond(
      message,
      tools,
      observed,
      new AbortController().signal,
    );
    expect(result).toEqual({
      toolCalls: [],
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
    });
    expect(onTextDelta).toHaveBeenCalledWith("Hello");
    expect(onUsage).toHaveBeenLastCalledWith(result.usage);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(options?.headers).toMatchObject({
      "x-api-key": "private-key",
      "anthropic-version": "2023-06-01",
    });
    const body = jsonBody(options?.body);
    expect(body).toMatchObject({
      model: model.modelId,
      max_tokens: 4096,
      system: "Answer carefully.",
      messages: [{ role: "user", content: "Hi" }],
      tools: [
        {
          name: "read_image",
          description: "Read an image",
          input_schema: tools[0].parameters,
        },
      ],
      stream: true,
    });
    expect(JSON.stringify(body)).not.toContain("private-key");
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it("preserves tool_use IDs and structured image results in local history across rounds", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        stream([
          start,
          textStart,
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Opening" },
          },
          stopBlock(0),
          {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "tool-7",
              name: "read_image",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"path":' },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '"a.png"}' },
          },
          stopBlock(1),
          ...end("tool_use"),
        ]),
      )
      .mockResolvedValueOnce(textResponse("Found it"))
      .mockResolvedValueOnce(textResponse("Again"));
    vi.stubGlobal("fetch", fetchMock);
    const provider = makeProvider();
    const signal = new AbortController().signal;
    expect(provider.supportsImages).toBe(true);
    expect(provider.supportsImageToolResults).toBe(true);
    const first = await provider.respond(
      {
        kind: "message",
        message: {
          text: "Read",
          images: [
            { mimeType: "image/png", data: "YWJj", sourcePath: "a.png" },
          ],
        },
      },
      tools,
      handlers(),
      signal,
    );
    expect(first.toolCalls).toEqual([
      { callId: "tool-7", name: "read_image", arguments: '{"path":"a.png"}' },
    ]);
    const output = [
      { type: "input_text", text: "Image loaded" },
      {
        type: "input_image",
        image_url: "data:image/png;base64,YWJj",
        detail: "auto",
      },
    ];
    await provider.respond(
      { kind: "tool-results", results: [{ callId: "tool-7", output }] },
      tools,
      handlers(),
      signal,
    );
    const request = jsonBody(fetchMock.mock.calls[1][1]?.body);
    expect(request.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Read" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "YWJj" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Opening" },
          {
            type: "tool_use",
            id: "tool-7",
            name: "read_image",
            input: { path: "a.png" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-7",
            content: [
              { type: "text", text: "Image loaded" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "YWJj",
                },
              },
            ],
          },
        ],
      },
    ]);
    provider.finishTurn();
    await provider.respond(message, [], handlers(), signal);
    expect(
      (jsonBody(fetchMock.mock.calls[2][1]?.body).messages as object[])[3],
    ).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Found it" }],
    });
  });

  it("can disable user images and structured image tool results per model", async () => {
    const provider = makeProvider({
      ...model,
      supportsImages: false,
    });
    expect(provider.supportsImages).toBe(false);
    expect(provider.supportsImageToolResults).toBe(false);
    await expect(
      provider.respond(
        {
          kind: "message",
          message: {
            text: "Look",
            images: [{ mimeType: "image/png", data: "YWJj", sourcePath: "a" }],
          },
        },
        [],
        handlers(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "tool" });
  });

  it("rejects image tool output when images are disabled and rejects mismatched tool IDs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        stream([
          start,
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "expected",
              name: "read_image",
              input: { path: "a.png" },
            },
          },
          stopBlock(0),
          ...end("tool_use"),
        ]),
      ),
    );
    const provider = makeProvider({ ...model, supportsImages: false });
    await provider.respond(
      message,
      tools,
      handlers(),
      new AbortController().signal,
    );
    await expect(
      provider.respond(
        {
          kind: "tool-results",
          results: [{ callId: "other", output: "text" }],
        },
        tools,
        handlers(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "tool" });
    await expect(
      provider.respond(
        {
          kind: "tool-results",
          results: [
            {
              callId: "expected",
              output: [
                {
                  type: "input_image",
                  image_url: "data:image/png;base64,YWJj",
                },
              ],
            },
          ],
        },
        tools,
        handlers(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "tool" });
  });

  it("rolls back an aborted tool round and never commits a cancelled streamed response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        stream([
          start,
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "t",
              name: "read_image",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
          },
          stopBlock(0),
          ...end("tool_use"),
        ]),
      )
      .mockResolvedValueOnce(textResponse("Final"))
      .mockResolvedValueOnce(textResponse("Fresh"));
    vi.stubGlobal("fetch", fetchMock);
    const provider = makeProvider();
    const controller = new AbortController();
    await provider.respond(message, tools, handlers(), controller.signal);
    const cancelling = handlers();
    cancelling.onTextDelta = () => controller.abort();
    await expect(
      provider.respond(
        { kind: "tool-results", results: [{ callId: "t", output: "result" }] },
        tools,
        cancelling,
        controller.signal,
      ),
    ).rejects.toMatchObject({ category: "cancelled" });
    provider.abortTurn();
    await provider.respond(
      message,
      tools,
      handlers(),
      new AbortController().signal,
    );
    expect(jsonBody(fetchMock.mock.calls[2][1]?.body).messages).toEqual([
      { role: "user", content: "Hi" },
    ]);
  });

  it("uses nonstream requestUrl only for initial CORS failure or an absent stream body", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("CORS"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    requestUrlMock.mockResolvedValue({
      status: 200,
      text: "",
      json: completed([{ type: "text", text: "Fallback" }]),
    });
    const provider = makeProvider();
    const onTextDelta = vi.fn();
    const observed = { ...handlers(), onTextDelta };
    await provider.respond(message, [], observed, new AbortController().signal);
    provider.finishTurn();
    await provider.respond(message, [], observed, new AbortController().signal);
    expect(requestUrlMock).toHaveBeenCalledTimes(2);
    expect(jsonBody(requestUrlMock.mock.calls[0][0].body)).toMatchObject({
      stream: false,
      max_tokens: 4096,
    });
    expect(jsonBody(fetchMock.mock.calls[1][1]?.body).messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Fallback" }] },
      { role: "user", content: "Hi" },
    ]);
    expect(onTextDelta).toHaveBeenCalledTimes(2);
  });

  it("rejects incomplete, malformed, and invalid tool streams without retry or history commit", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        stream([
          start,
          textStart,
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "partial" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        stream([
          start,
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "x",
              name: "read_image",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{broken" },
          },
          stopBlock(0),
          ...end("tool_use"),
        ]),
      )
      .mockResolvedValueOnce(textResponse());
    vi.stubGlobal("fetch", fetchMock);
    const provider = makeProvider();
    await expect(
      provider.respond(message, [], handlers(), new AbortController().signal),
    ).rejects.toThrow("did not complete");
    await expect(
      provider.respond(
        message,
        tools,
        handlers(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("tool arguments");
    expect(requestUrlMock).not.toHaveBeenCalled();
    await provider.respond(
      message,
      [],
      handlers(),
      new AbortController().signal,
    );
    expect(jsonBody(fetchMock.mock.calls[2][1]?.body).messages).toEqual([
      { role: "user", content: "Hi" },
    ]);
  });

  it("rejects malformed SSE, stream errors, and truncated max-token completions without retry", async () => {
    const malformed = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {bad json}\n\n"));
          controller.close();
        },
      }),
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(malformed)
      .mockResolvedValueOnce(
        stream([
          start,
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        stream([
          start,
          textStart,
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "cut" },
          },
          stopBlock(0),
          ...end("max_tokens"),
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = makeProvider();
    await expect(
      provider.respond(message, [], handlers(), new AbortController().signal),
    ).rejects.toThrow("Invalid Anthropic stream event");
    await expect(
      provider.respond(message, [], handlers(), new AbortController().signal),
    ).rejects.toThrow("Overloaded");
    await expect(
      provider.respond(message, [], handlers(), new AbortController().signal),
    ).rejects.toThrow("max_tokens");
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it("resets local history on a new conversation", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => textResponse());
    vi.stubGlobal("fetch", fetchMock);
    const provider = makeProvider();
    await provider.respond(
      message,
      [],
      handlers(),
      new AbortController().signal,
    );
    provider.finishTurn();
    provider.resetConversation();
    await provider.respond(
      message,
      [],
      handlers(),
      new AbortController().signal,
    );
    expect(jsonBody(fetchMock.mock.calls[1][1]?.body).messages).toEqual([
      { role: "user", content: "Hi" },
    ]);
  });

  it("maps Anthropic HTTP errors and tests connectivity without changing history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "Too many requests" },
          }),
          { status: 429 },
        ),
      ),
    );
    const provider = makeProvider();
    await expect(
      provider.respond(message, [], handlers(), new AbortController().signal),
    ).rejects.toMatchObject({
      category: "rate_limit",
      status: 429,
      message: "Anthropic request failed (429): Too many requests",
    });
    expect(requestUrlMock).not.toHaveBeenCalled();
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      text: "",
      json: completed([{ type: "text", text: "OK" }]),
    });
    expect(await provider.testConnection()).toMatchObject({ ok: true });
    expect(requestUrlMock.mock.calls[0][0].headers).toMatchObject({
      "x-api-key": "private-key",
      "anthropic-version": "2023-06-01",
    });
    expect(jsonBody(requestUrlMock.mock.calls[0][0].body)).toMatchObject({
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with OK." }],
    });
  });
});
