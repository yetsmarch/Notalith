import { describe, expect, it } from "vitest";
import { normalizeProviderSettings, PROVIDER_IDS } from "./provider-settings";

describe("provider settings", () => {
  it("persists explicit Azure protocol and endpoint overrides without guessing from aliases", () => {
    const result = normalizeProviderSettings({
      models: [
        {
          id: "claude",
          connectionId: "azure-foundry",
          modelId: "custom-alias",
          azureProtocol: "anthropic-messages",
          endpointOverride: " https://gateway.test/anthropic/v1/ ",
          supportsImages: true,
        },
        {
          id: "old",
          connectionId: "azure-foundry",
          modelId: "claude-named-but-responses",
        },
      ],
    });
    expect(result.models[0]).toMatchObject({
      azureProtocol: "anthropic-messages",
      endpointOverride: "https://gateway.test/anthropic/v1/",
      supportsImages: true,
    });
    expect(result.models[1].azureProtocol).toBeUndefined();
    expect(normalizeProviderSettings(result).models).toEqual(result.models);
  });

  it("reports unsupported persisted Azure protocols rather than silently switching", () => {
    expect(() =>
      normalizeProviderSettings({
        models: [
          {
            id: "invalid",
            connectionId: "azure-foundry",
            modelId: "alias",
            azureProtocol: "unknown",
          },
        ],
      }),
    ).toThrow("Unsupported Azure inference protocol");
  });

  it("migrates Azure deployments without changing their endpoint or secret", () => {
    const settings = normalizeProviderSettings({
      azureEndpoint: "https://example.openai.azure.com/openai/v1",
      deploymentName: "gpt-4.1",
      deployments: [
        {
          id: "reasoning",
          displayName: "Reasoning",
          deploymentName: "o4-mini",
        },
        { id: "standard", displayName: "Standard", deploymentName: "gpt-4.1" },
      ],
    });

    expect(settings.connections[0]).toEqual({
      id: "azure-foundry",
      endpoint: "https://example.openai.azure.com/openai/v1",
      apiKeySecretId: "notalith-azure-api-key",
    });
    expect(settings.models).toEqual([
      {
        id: "azure:reasoning",
        connectionId: "azure-foundry",
        displayName: "Reasoning",
        modelId: "o4-mini",
      },
      {
        id: "azure:standard",
        connectionId: "azure-foundry",
        displayName: "Standard",
        modelId: "gpt-4.1",
      },
    ]);
    expect(settings.activeModelId).toBe("azure:standard");
  });

  it("keeps new profiles and empty drafts without restoring deleted legacy models", () => {
    const stored = {
      deploymentName: "old-deployment",
      models: [
        {
          id: "draft",
          connectionId: "deepseek",
          displayName: "Draft",
          modelId: "",
        },
        {
          id: "deepseek-flash",
          connectionId: "deepseek",
          displayName: "Flash",
          modelId: "deepseek-flash",
        },
      ],
      activeModelId: "draft",
    };
    const settings = normalizeProviderSettings(stored);
    expect(settings.models).toHaveLength(2);
    expect(settings.activeModelId).toBe("deepseek-flash");
    expect(normalizeProviderSettings({ ...stored, models: [] }).models).toEqual(
      [],
    );
  });

  it("adds every provider without disturbing migrated Azure or DeepSeek settings", () => {
    const settings = normalizeProviderSettings({
      connections: [
        {
          id: "azure-foundry",
          endpoint: "https://example.openai.azure.com/openai/v1",
          apiKeySecretId: "custom-azure-secret",
        },
        {
          id: "deepseek",
          endpoint: "https://api.deepseek.com",
          apiKeySecretId: "notalith-deepseek-api-key",
        },
      ],
      models: [
        {
          id: "existing",
          connectionId: "azure-foundry",
          displayName: "Azure",
          modelId: "o4-mini",
        },
        {
          id: "vision",
          connectionId: "gemini",
          displayName: "Vision",
          modelId: "gemini-2.5-flash",
          supportsImages: true,
        },
      ],
      activeModelId: "existing",
    });

    expect(settings.connections.map((connection) => connection.id)).toEqual(
      PROVIDER_IDS,
    );
    expect(settings.connections[0].apiKeySecretId).toBe("custom-azure-secret");
    expect(settings.activeModelId).toBe("existing");
    expect(settings.models[1].supportsImages).toBe(true);
    expect(
      settings.connections.find((connection) => connection.id === "gemini"),
    ).toMatchObject({
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
    });
  });
});
