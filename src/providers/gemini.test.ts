import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, ProviderHandlers, ToolDefinition } from "../types";
import { GeminiProvider } from "./gemini";

const { requestUrlMock } = vi.hoisted(() => ({
  requestUrlMock:
    vi.fn<
      (request: {
        body: string;
        headers: Record<string, string>;
        url: string;
      }) => Promise<{ status: number; json: unknown; text: string }>
    >(),
}));
vi.mock("obsidian", () => ({ requestUrl: requestUrlMock }));

const profile = (
  supportsImages?: boolean,
): ModelProfile & {
  supportsImages?: boolean;
} => ({
  id: "gemini",
  connectionId: "gemini",
  modelId: "gemini-3-pro",
  displayName: "Gemini",
  ...(supportsImages !== undefined ? { supportsImages } : {}),
});
const provider = (
  model = profile(),
  endpoint = "https://generativelanguage.googleapis.com/v1beta",
): GeminiProvider =>
  new GeminiProvider(
    {
      id: "gemini",
      endpoint,
      apiKeySecretId: "key-ref",
    },
    model,
    "Answer carefully.",
    () => "private-key",
  );
const handlers = () =>
  ({
    onTextDelta: vi.fn(),
    onToolCall: vi.fn(),
    onUsage: vi.fn(),
  }) satisfies ProviderHandlers;
const tools: ToolDefinition[] = [
  {
    type: "function",
    name: "read_note",
    description: "Read a note",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
];
const message = {
  kind: "message" as const,
  message: { text: "Find notes", images: [] },
};
const completed = (parts: object[], usageMetadata?: object) => ({
  candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
  ...(usageMetadata ? { usageMetadata } : {}),
});
const textResponse = (text: string): Response => stream(completed([{ text }]));
const stream = (...events: object[]): Response => {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 9));
        controller.enqueue(bytes.slice(9, 57));
        controller.enqueue(bytes.slice(57));
        controller.close();
      },
    }),
  );
};
const requestBody = (
  body: BodyInit | null | undefined,
): Record<string, unknown> => {
  if (typeof body !== "string") throw new Error("Expected JSON request");
  return JSON.parse(body) as Record<string, unknown>;
};

describe("native Gemini generateContent provider", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    requestUrlMock.mockReset();
  });

  it("uses native SSE, API key header and JSON schema without putting secrets in requests", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      stream(
        completed([{ text: "Hel" }], {
          promptTokenCount: 3,
          candidatesTokenCount: 2,
          totalTokenCount: 5,
        }),
        completed([{ text: "lo" }], {
          promptTokenCount: 3,
          candidatesTokenCount: 4,
          totalTokenCount: 7,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const observed = handlers();
    const result = await provider().respond(
      message,
      tools,
      observed,
      new AbortController().signal,
    );
    expect(result).toEqual({
      toolCalls: [],
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
    expect(observed.onTextDelta).toHaveBeenCalledTimes(2);
    expect(observed.onTextDelta).toHaveBeenNthCalledWith(1, "Hel");
    expect(observed.onTextDelta).toHaveBeenNthCalledWith(2, "lo");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse",
    );
    expect(init?.headers).toMatchObject({ "x-goog-api-key": "private-key" });
    const body = requestBody(init?.body);
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: "Answer carefully." }] },
      contents: [{ role: "user", parts: [{ text: "Find notes" }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "read_note",
              parametersJsonSchema: tools[0].parameters,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("private-key");
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it("keeps exact signed model parts in order through multiple function calls and rounds", async () => {
    const signedThought = {
      text: "private reasoning",
      thought: true,
      thoughtSignature: "encoded-thought-1",
    };
    const firstCall = {
      functionCall: { name: "read_note", args: { path: "a.md" } },
      thoughtSignature: "encoded-signature-A",
    };
    const secondCall = {
      functionCall: {
        name: "read_note",
        args: { path: "b.md" },
        id: "google-id-b",
      },
      thoughtSignature: "encoded-signature-B",
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        stream(
          {
            candidates: [
              { content: { role: "model", parts: [signedThought] } },
            ],
          },
          { candidates: [{ content: { role: "model", parts: [firstCall] } }] },
          {
            candidates: [
              {
                content: { role: "model", parts: [secondCall] },
                finishReason: "STOP",
              },
            ],
          },
        ),
      )
      .mockResolvedValueOnce(textResponse("Found both"))
      .mockResolvedValueOnce(textResponse("Again"));
    vi.stubGlobal("fetch", fetchMock);
    const model = provider();
    const observed = handlers();
    const signal = new AbortController().signal;
    const first = await model.respond(message, tools, observed, signal);
    expect(first.toolCalls).toEqual([
      {
        callId: "gemini-call-1",
        name: "read_note",
        arguments: '{"path":"a.md"}',
      },
      {
        callId: "gemini-call-2",
        name: "read_note",
        arguments: '{"path":"b.md"}',
      },
    ]);
    expect(observed.onTextDelta).not.toHaveBeenCalled();
    expect(observed.onToolCall).toHaveBeenCalledTimes(2);
    await model.respond(
      {
        kind: "tool-results",
        results: [
          { callId: first.toolCalls[1].callId, output: "B" },
          { callId: first.toolCalls[0].callId, output: "A" },
        ],
      },
      tools,
      observed,
      signal,
    );
    const contents = requestBody(fetchMock.mock.calls[1][1]?.body)
      .contents as object[];
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "Find notes" }] },
      { role: "model", parts: [signedThought, firstCall, secondCall] },
      {
        role: "user",
        parts: [
          {
            functionResponse: { name: "read_note", response: { result: "A" } },
          },
          {
            functionResponse: {
              name: "read_note",
              id: "google-id-b",
              response: { result: "B" },
            },
          },
        ],
      },
    ]);
    expect(JSON.stringify(contents)).toContain("encoded-signature-A");
    model.finishTurn();
    await model.respond(
      { kind: "message", message: { text: "Next", images: [] } },
      tools,
      observed,
      signal,
    );
    expect(
      (requestBody(fetchMock.mock.calls[2][1]?.body).contents as object[])[3],
    ).toEqual({ role: "model", parts: [{ text: "Found both" }] });
  });

  it("requires explicit image opt-in, encodes attachments and rejects image tool outputs", async () => {
    const input = {
      kind: "message" as const,
      message: {
        text: "Describe",
        images: [{ mimeType: "image/png", data: "YWJj", sourcePath: "a.png" }],
      },
    };
    expect(provider().supportsImages).toBe(false);
    expect(provider(profile(false)).supportsImages).toBe(false);
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
      .mockResolvedValueOnce(textResponse("An image"));
    vi.stubGlobal("fetch", fetchMock);
    const model = provider(profile(true));
    expect(model.supportsImages).toBe(true);
    expect(model.supportsImageToolResults).toBe(false);
    await model.respond(input, tools, handlers(), new AbortController().signal);
    expect(requestBody(fetchMock.mock.calls[0][1]?.body).contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "Describe" },
          { inlineData: { mimeType: "image/png", data: "YWJj" } },
        ],
      },
    ]);
    await expect(
      model.respond(
        {
          kind: "tool-results",
          results: [{ callId: "missing", output: [{ type: "image" }] }],
        },
        tools,
        handlers(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "tool" });
  });

  it("rolls back an interrupted tool round and clears pending IDs on abort", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        stream(
          completed([
            {
              functionCall: { name: "read_note", args: { path: "a.md" } },
              thoughtSignature: "keep-me",
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        stream({
          candidates: [
            { content: { role: "model", parts: [{ text: "Partial" }] } },
          ],
        }),
      )
      .mockResolvedValueOnce(textResponse("Recovered"));
    vi.stubGlobal("fetch", fetchMock);
    const model = provider();
    const first = await model.respond(
      message,
      tools,
      handlers(),
      new AbortController().signal,
    );
    await expect(
      model.respond(
        {
          kind: "tool-results",
          results: [{ callId: first.toolCalls[0].callId, output: "A" }],
        },
        tools,
        handlers(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("did not complete");
    model.abortTurn();
    await expect(
      model.respond(
        {
          kind: "tool-results",
          results: [{ callId: first.toolCalls[0].callId, output: "A" }],
        },
        tools,
        handlers(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("Unknown Gemini function call");
    await model.respond(
      message,
      tools,
      handlers(),
      new AbortController().signal,
    );
    expect(requestBody(fetchMock.mock.calls[2][1]?.body).contents).toEqual([
      { role: "user", parts: [{ text: "Find notes" }] },
    ]);
  });

  it("falls back before streaming for fetch failures or missing body, but never after a stream starts", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("CORS"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        stream({
          candidates: [
            { content: { role: "model", parts: [{ text: "partial" }] } },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    requestUrlMock
      .mockResolvedValueOnce({
        status: 200,
        json: completed([{ text: "Fallback" }]),
        text: "",
      })
      .mockResolvedValueOnce({
        status: 200,
        json: completed([{ text: "No body" }]),
        text: "",
      });
    const model = provider(profile(), "https://example.com/v1beta/");
    await model.respond(
      message,
      tools,
      handlers(),
      new AbortController().signal,
    );
    model.finishTurn();
    await model.respond(
      message,
      tools,
      handlers(),
      new AbortController().signal,
    );
    model.finishTurn();
    expect(requestUrlMock).toHaveBeenCalledTimes(2);
    expect(requestUrlMock.mock.calls[0][0]).toMatchObject({
      url: "https://example.com/v1beta/models/gemini-3-pro:generateContent",
      headers: { "x-goog-api-key": "private-key" },
    });
    expect(requestBody(requestUrlMock.mock.calls[0][0].body).contents).toEqual([
      { role: "user", parts: [{ text: "Find notes" }] },
    ]);
    await expect(
      model.respond(message, tools, handlers(), new AbortController().signal),
    ).rejects.toThrow("did not complete");
    expect(requestUrlMock).toHaveBeenCalledTimes(2);
  });

  it("does not commit cancelled buffered responses and validates HTTP errors and connection checks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("CORS")),
    );
    let resolveRequest:
      | ((value: { status: number; json: unknown; text: string }) => void)
      | undefined;
    requestUrlMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
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
    resolveRequest?.({
      status: 200,
      json: completed([{ text: "Late" }]),
      text: "",
    });
    await expect(pending).rejects.toMatchObject({ category: "cancelled" });
    model.abortTurn();
    requestUrlMock.mockResolvedValueOnce({
      status: 429,
      json: {},
      text: '{"error":{"message":"Rate limit"}}',
    });
    await expect(model.testConnection()).resolves.toEqual({
      ok: false,
      message: "Rate limit",
    });
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: completed([{ text: "OK" }]),
      text: "",
    });
    await expect(model.testConnection()).resolves.toMatchObject({ ok: true });
    expect(requestBody(requestUrlMock.mock.calls[2][0].body)).toEqual({
      contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response('{"error":{"message":"Invalid API key"}}', {
          status: 401,
        }),
      ),
    );
    await expect(
      model.respond(message, [], handlers(), new AbortController().signal),
    ).rejects.toMatchObject({ category: "authentication", status: 401 });
  });

  it("preserves signed parts in nonstream fallback and cancels an in-flight turn on reset", async () => {
    vi.stubGlobal("fetch", undefined);
    const signed = {
      text: "hidden",
      thought: true,
      thoughtSignature: "verbatim-binary-looking-signature",
    };
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: completed([
        signed,
        { functionCall: { name: "read_note", args: { path: "x.md" } } },
      ]),
      text: "",
    });
    let resolveRequest:
      | ((value: { status: number; json: unknown; text: string }) => void)
      | undefined;
    requestUrlMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const model = provider();
    const observed = handlers();
    const first = await model.respond(
      message,
      tools,
      observed,
      new AbortController().signal,
    );
    expect(first.toolCalls).toHaveLength(1);
    expect(observed.onTextDelta).not.toHaveBeenCalled();
    const ongoing = model.respond(
      {
        kind: "tool-results",
        results: [{ callId: first.toolCalls[0].callId, output: "X" }],
      },
      tools,
      observed,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(requestUrlMock).toHaveBeenCalledTimes(2));
    expect(requestBody(requestUrlMock.mock.calls[1][0].body).contents).toEqual([
      { role: "user", parts: [{ text: "Find notes" }] },
      {
        role: "model",
        parts: [
          signed,
          { functionCall: { name: "read_note", args: { path: "x.md" } } },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: { name: "read_note", response: { result: "X" } },
          },
        ],
      },
    ]);
    model.resetConversation();
    resolveRequest?.({
      status: 200,
      json: completed([{ text: "Late" }]),
      text: "",
    });
    await expect(ongoing).rejects.toMatchObject({ category: "cancelled" });
  });
});
