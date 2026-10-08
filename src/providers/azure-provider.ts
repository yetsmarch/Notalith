import type { ModelProfile, ProviderConnection } from "../types";
import { NotalithError } from "../types";
import { AnthropicProvider } from "./anthropic";
import { AzureFoundryProvider } from "./azure-foundry";
import { ChatCompletionsProvider } from "./chat-completions";
import type { ModelProvider } from "./provider";

export function azureMessagesEndpoint(
  connection: ProviderConnection,
  model: ModelProfile,
): string {
  if (model.endpointOverride?.trim()) return model.endpointOverride.trim();
  let url: URL;
  try {
    url = new URL(connection.endpoint);
  } catch {
    throw new NotalithError("Invalid Azure endpoint URL.", "configuration");
  }
  const match = /^([a-z0-9-]+)\.(openai|services\.ai)\.azure\.com$/i.exec(
    url.hostname,
  );
  if (
    !match ||
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    ![
      "",
      "/",
      "/openai/v1",
      "/openai/v1/",
      "/anthropic/v1",
      "/anthropic/v1/",
    ].includes(url.pathname)
  ) {
    throw new NotalithError(
      "Set a Claude endpoint override for this Azure connection, including /anthropic/v1.",
      "configuration",
    );
  }
  return `https://${match[1]}.services.ai.azure.com/anthropic/v1`;
}

export function createAzureProvider(
  connection: ProviderConnection,
  model: ModelProfile,
  systemPrompt: string,
  getApiKey: () => string | null,
): ModelProvider {
  const protocol = model.azureProtocol ?? "openai-responses";
  const effectiveConnection = {
    ...connection,
    endpoint: model.endpointOverride?.trim() || connection.endpoint,
  };
  switch (protocol) {
    case "openai-responses":
      return new AzureFoundryProvider(
        effectiveConnection,
        model,
        systemPrompt,
        getApiKey,
      );
    case "openai-chat-completions":
      return new ChatCompletionsProvider(
        effectiveConnection,
        model,
        systemPrompt,
        getApiKey,
        {
          name: "Azure Foundry",
          supportsImages: model.supportsImages === true,
          apiKeyHeader: "api-key",
        },
      );
    case "anthropic-messages":
      return new AnthropicProvider(connection, model, systemPrompt, getApiKey, {
        name: "Azure Foundry Claude",
        endpoint: () => azureMessagesEndpoint(connection, model),
      });
    default:
      throw new NotalithError(
        "Unsupported Azure inference protocol.",
        "configuration",
      );
  }
}
