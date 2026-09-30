import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderConnection,
  ProviderHandlers,
  ProviderId,
} from "../types";
import { ChatCompletionsProvider } from "./chat-completions";

const { requestUrlMock } = vi.hoisted(() => ({
  requestUrlMock:
    vi.fn<
      (request: {
        url: string;
        headers: Record<string, string>;
        body: string;
      }) => Promise<{ status: number; json: unknown }>
    >(),
}));
vi.mock("obsidian", () => ({ requestUrl: requestUrlMock }));

const handlers: ProviderHandlers = {
  onTextDelta() {},
  onToolCall() {},
  onUsage() {},
};

function provider(
  id: ProviderId,
  endpoint: string,
  supportsImages = false,
): ChatCompletionsProvider {
  const connection: ProviderConnection = {
    id,
    endpoint,
    apiKeySecretId: `notalith-${id}-api-key`,
  };
  return new ChatCompletionsProvider(
    connection,
    {
      id: "profile",
      connectionId: id,
      displayName: "Model",
      modelId: "example-model",
      supportsImages,
    },
    "Instructions",
    () => "test-key",
    { name: id, supportsImages },
  );
}

describe("OpenAI-compatible provider adapters", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    requestUrlMock.mockReset();
  });

  it.each([
    ["openai", "https://api.openai.com/v1"],
    ["grok", "https://api.x.ai/v1"],
    ["openrouter", "https://openrouter.ai/api/v1"],
  ] as const)(
    "%s sends Chat Completions to its own endpoint",
    async (id, endpoint) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockRejectedValue(new TypeError("CORS")),
      );
      requestUrlMock.mockResolvedValue({
        status: 200,
        json: {
          choices: [{ finish_reason: "stop", message: { content: "OK" } }],
        },
      });
      const selected = provider(id, endpoint);
      await selected.respond(
        { kind: "message", message: { text: "Hello", images: [] } },
        [],
        handlers,
        new AbortController().signal,
      );
      const sent = requestUrlMock.mock.calls[0][0];
      expect(sent.url).toBe(`${endpoint}/chat/completions`);
      expect(sent.headers.Authorization).toBe("Bearer test-key");
      expect(
        (JSON.parse(sent.body) as { messages: unknown[] }).messages,
      ).toEqual([
        { role: "system", content: "Instructions" },
        { role: "user", content: "Hello" },
      ]);
    },
  );

  it("requires explicit image capability on each model", async () => {
    const input = {
      kind: "message" as const,
      message: {
        text: "Describe",
        images: [
          { mimeType: "image/png", data: "AAAA", sourcePath: "picture.png" },
        ],
      },
    };
    await expect(
      provider("openrouter", "https://openrouter.ai/api/v1").respond(
        input,
        [],
        handlers,
        new AbortController().signal,
      ),
    ).rejects.toThrow("does not support image input");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("CORS")),
    );
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        choices: [{ finish_reason: "stop", message: { content: "Image" } }],
      },
    });
    await provider("openrouter", "https://openrouter.ai/api/v1", true).respond(
      input,
      [],
      handlers,
      new AbortController().signal,
    );
    const sent = JSON.parse(requestUrlMock.mock.calls[0][0].body) as {
      messages: Array<{ content: Array<{ image_url?: { url: string } }> }>;
    };
    expect(sent.messages[1].content[1].image_url?.url).toBe(
      "data:image/png;base64,AAAA",
    );
  });
});
