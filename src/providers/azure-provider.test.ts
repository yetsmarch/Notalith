import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, ProviderConnection } from "../types";
import { AnthropicProvider } from "./anthropic";
import { AzureFoundryProvider } from "./azure-foundry";
import { ChatCompletionsProvider } from "./chat-completions";
import { azureMessagesEndpoint, createAzureProvider } from "./azure-provider";

const { requestUrlMock } = vi.hoisted(() => ({
  requestUrlMock:
    vi.fn<
      (request: {
        url: string;
        headers: Record<string, string>;
        body: string;
      }) => Promise<{ status: number; text: string; json: unknown }>
    >(),
}));
vi.mock("obsidian", () => ({ requestUrl: requestUrlMock }));

const connection: ProviderConnection = {
  id: "azure-foundry",
  endpoint: "https://example.openai.azure.com/openai/v1/",
  apiKeySecretId: "key-ref",
};
const model: ModelProfile = {
  id: "azure",
  connectionId: "azure-foundry",
  modelId: "custom-deployment-alias",
  displayName: "Azure",
};
const provider = (profile: ModelProfile = model, conn = connection) =>
  createAzureProvider(conn, profile, "Be helpful.", () => "private-key");

describe("Azure protocol routing", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("defaults existing profiles to Responses even for a Claude-looking alias", () => {
    expect(provider({ ...model, modelId: "claude-alias" })).toBeInstanceOf(
      AzureFoundryProvider,
    );
  });

  it("keeps the router deployment and tool history when the serving model changes", async () => {
    const profile: ModelProfile = {
      ...model,
      modelId: "router-custom-alias",
      azureProtocol: "openai-chat-completions",
      endpointOverride: "https://example.services.ai.azure.com/openai/v1",
    };
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("CORS")));
    const call = {
      id: "call-router",
      type: "function",
      function: { name: "echo_token", arguments: '{"token":"test"}' },
    };
    requestUrlMock
      .mockResolvedValueOnce({
        status: 200,
        text: "",
        json: {
          model: "gpt-serving-model",
          choices: [
            {
              message: { role: "assistant", content: null, tool_calls: [call] },
              finish_reason: "tool_calls",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        text: "",
        json: {
          model: "another-serving-model",
          choices: [
            {
              message: { role: "assistant", content: "test" },
              finish_reason: "stop",
            },
          ],
        },
      });
    try {
      const router = provider(profile);
      const observed = {
        onTextDelta: vi.fn(),
        onToolCall: vi.fn(),
        onUsage: vi.fn(),
      };
      const tools = [
        {
          type: "function" as const,
          name: "echo_token",
          description: "Echo",
          parameters: {
            type: "object",
            properties: { token: { type: "string" } },
          },
          strict: true as const,
        },
      ];
      const first = await router.respond(
        { kind: "message", message: { text: "Echo test", images: [] } },
        tools,
        observed,
        new AbortController().signal,
      );
      expect(first.toolCalls).toEqual([
        {
          callId: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        },
      ]);
      await router.respond(
        {
          kind: "tool-results",
          results: [{ callId: call.id, output: "test" }],
        },
        tools,
        observed,
        new AbortController().signal,
      );
      const requests = requestUrlMock.mock.calls.map(([request]) => request);
      for (const request of requests) {
        expect(request.url).toBe(
          "https://example.services.ai.azure.com/openai/v1/chat/completions",
        );
        expect(request.headers["api-key"]).toBe("private-key");
        expect((JSON.parse(request.body) as { model: string }).model).toBe(
          profile.modelId,
        );
      }
      expect(
        (JSON.parse(requests[1].body) as { messages: unknown[] }).messages,
      ).toEqual([
        { role: "system", content: "Be helpful." },
        { role: "user", content: "Echo test" },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "test" },
      ]);
      expect(observed.onTextDelta).toHaveBeenCalledWith("test");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tests Claude using the resource key, Messages endpoint and arbitrary deployment alias", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      text: "",
      json: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
      },
    });
    const claude = provider({ ...model, azureProtocol: "anthropic-messages" });
    expect(claude).toBeInstanceOf(AnthropicProvider);
    expect(await claude.testConnection()).toMatchObject({ ok: true });
    expect(requestUrlMock.mock.calls[0][0]).toMatchObject({
      url: "https://example.services.ai.azure.com/anthropic/v1/messages",
      headers: {
        "x-api-key": "private-key",
        "anthropic-version": "2023-06-01",
      },
    });
    expect(JSON.parse(requestUrlMock.mock.calls[0][0].body)).toMatchObject({
      model: model.modelId,
    });
  });

  it("routes Chat Completions with Azure authentication and optional image input", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      text: "",
      json: {
        choices: [
          {
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
      },
    });
    const chat = provider({
      ...model,
      azureProtocol: "openai-chat-completions",
      supportsImages: true,
    });
    expect(chat).toBeInstanceOf(ChatCompletionsProvider);
    expect(chat.supportsImages).toBe(true);
    expect(chat.supportsImageToolResults).toBe(false);
    expect(await chat.testConnection()).toMatchObject({ ok: true });
    const request = requestUrlMock.mock.calls[0][0];
    expect(request.url).toBe(
      "https://example.openai.azure.com/openai/v1/chat/completions",
    );
    expect(request.headers["api-key"]).toBe("private-key");
    expect(request.headers.Authorization).toBeUndefined();
  });

  it("supports explicit Claude endpoints without changing the shared connection", async () => {
    const profile: ModelProfile = {
      ...model,
      azureProtocol: "anthropic-messages",
      endpointOverride: "https://gateway.example/anthropic/v1/",
    };
    expect(azureMessagesEndpoint(connection, profile)).toBe(
      profile.endpointOverride,
    );
    requestUrlMock.mockResolvedValue({
      status: 401,
      text: '{"error":{"message":"Bad key"}}',
      json: {},
    });
    expect(await provider(profile).testConnection()).toMatchObject({
      ok: false,
    });
    expect(requestUrlMock.mock.calls[0][0].url).toBe(
      "https://gateway.example/anthropic/v1/messages",
    );
    expect(connection.endpoint).toBe(
      "https://example.openai.azure.com/openai/v1/",
    );
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://gateway.example/openai/v1",
    "https://example.openai.azure.com.evil.test/openai/v1",
    "https://example.privatelink.openai.azure.com/openai/v1",
    "https://example.openai.azure.com:8443/openai/v1",
    "https://example.openai.azure.com/custom",
    "https://example.openai.azure.com/openai/v1?route=other",
  ])("requires an override instead of rewriting %s", async (endpoint) => {
    const result = await provider(
      { ...model, azureProtocol: "anthropic-messages" },
      { ...connection, endpoint },
    ).testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("endpoint override");
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it("accepts standard services.ai resource domains", () => {
    expect(
      azureMessagesEndpoint(
        {
          ...connection,
          endpoint: "https://example.services.ai.azure.com/anthropic/v1",
        },
        model,
      ),
    ).toBe("https://example.services.ai.azure.com/anthropic/v1");
  });

  it.each(["openai-responses", "openai-chat-completions"] as const)(
    "uses explicit overrides for %s without rewriting them",
    async (azureProtocol) => {
      requestUrlMock.mockResolvedValue({
        status: 400,
        text: '{"error":{"message":"Unsupported request"}}',
        json: {},
      });
      const p = provider({
        ...model,
        azureProtocol,
        endpointOverride: "https://gateway.test/custom/v1/",
      });
      expect((await p.testConnection()).ok).toBe(false);
      expect(requestUrlMock.mock.calls[0][0].url).toBe(
        `https://gateway.test/custom/v1/${azureProtocol === "openai-responses" ? "responses" : "chat/completions"}`,
      );
      expect(requestUrlMock).toHaveBeenCalledTimes(1);
    },
  );
});
