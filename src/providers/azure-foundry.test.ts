import { beforeEach, describe, expect, it, vi } from "vitest";
import { AzureFoundryProvider } from "./azure-foundry";

const { requestUrlMock } = vi.hoisted(() => ({
  requestUrlMock:
    vi.fn<
      (request: { body: string }) => Promise<{ status: number; json: unknown }>
    >(),
}));
vi.mock("obsidian", () => ({ requestUrl: requestUrlMock }));

describe("Azure Responses provider", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    requestUrlMock.mockReset();
  });

  it("keeps response IDs per instance and resets on a new conversation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("CORS")));
    requestUrlMock
      .mockResolvedValueOnce({
        status: 200,
        json: { id: "response-1", output_text: "first", output: [] },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: { id: "response-2", output_text: "second", output: [] },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: { id: "response-3", output_text: "new", output: [] },
      });
    const model = new AzureFoundryProvider(
      {
        id: "azure-foundry",
        endpoint: "https://example.test/openai/v1",
        apiKeySecretId: "test",
      },
      {
        id: "model",
        connectionId: "azure-foundry",
        modelId: "deployment",
        displayName: "Model",
      },
      "prompt",
      () => "secret",
    );
    const handlers = {
      onTextDelta: vi.fn(),
      onToolCall: vi.fn(),
      onUsage: vi.fn(),
    };
    const input = {
      kind: "message" as const,
      message: { text: "Hello", images: [] },
    };
    await model.respond(input, [], handlers, new AbortController().signal);
    model.finishTurn();
    await model.respond(input, [], handlers, new AbortController().signal);
    expect(
      (
        JSON.parse(requestUrlMock.mock.calls[1][0].body) as Record<
          string,
          unknown
        >
      ).previous_response_id,
    ).toBe("response-1");
    model.resetConversation();
    await model.respond(input, [], handlers, new AbortController().signal);
    expect(
      (
        JSON.parse(requestUrlMock.mock.calls[2][0].body) as Record<
          string,
          unknown
        >
      ).previous_response_id,
    ).toBeUndefined();
  });

  it("rejects incomplete streams without retrying or advancing the response ID", async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    'data: {"type":"response.created","response":{"id":"incomplete"}}\n\n' +
                      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
                  ),
                );
                controller.close();
              },
            }),
          ),
        )
        .mockRejectedValueOnce(new TypeError("CORS")),
    );
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: { id: "valid", output_text: "new", output: [] },
    });
    const model = new AzureFoundryProvider(
      {
        id: "azure-foundry",
        endpoint: "https://example.test/openai/v1",
        apiKeySecretId: "test",
      },
      {
        id: "model",
        connectionId: "azure-foundry",
        modelId: "deployment",
        displayName: "Model",
      },
      "prompt",
      () => "secret",
    );
    const handlers = {
      onTextDelta: vi.fn(),
      onToolCall: vi.fn(),
      onUsage: vi.fn(),
    };
    const input = {
      kind: "message" as const,
      message: { text: "Hello", images: [] },
    };
    await expect(
      model.respond(input, [], handlers, new AbortController().signal),
    ).rejects.toThrow("did not complete");
    expect(requestUrlMock).not.toHaveBeenCalled();
    model.abortTurn();
    await model.respond(input, [], handlers, new AbortController().signal);
    expect(
      (
        JSON.parse(requestUrlMock.mock.calls[0][0].body) as Record<
          string,
          unknown
        >
      ).previous_response_id,
    ).toBeUndefined();
  });
});
