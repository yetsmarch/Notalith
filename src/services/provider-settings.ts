import type {
  ModelProfile,
  NotalithSettings,
  ProviderConnection,
  ProviderId,
} from "../types";
import { normalizeDeployments } from "./deployment-settings";

export const PROVIDER_IDS: readonly ProviderId[] = [
  "azure-foundry",
  "deepseek",
  "anthropic",
  "openai",
  "grok",
  "gemini",
  "openrouter",
];

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  "azure-foundry": "Azure Foundry",
  deepseek: "DeepSeek",
  anthropic: "Claude (Anthropic)",
  openai: "OpenAI",
  grok: "Grok (xAI)",
  gemini: "Gemini (Google)",
  openrouter: "OpenRouter",
};

const CONNECTION_DEFAULTS: ProviderConnection[] = [
  {
    id: "azure-foundry",
    endpoint: "",
    apiKeySecretId: "notalith-azure-api-key",
  },
  {
    id: "deepseek",
    endpoint: "https://api.deepseek.com",
    apiKeySecretId: "notalith-deepseek-api-key",
  },
  {
    id: "anthropic",
    endpoint: "https://api.anthropic.com/v1",
    apiKeySecretId: "notalith-anthropic-api-key",
  },
  {
    id: "openai",
    endpoint: "https://api.openai.com/v1",
    apiKeySecretId: "notalith-openai-api-key",
  },
  {
    id: "grok",
    endpoint: "https://api.x.ai/v1",
    apiKeySecretId: "notalith-grok-api-key",
  },
  {
    id: "gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    apiKeySecretId: "notalith-gemini-api-key",
  },
  {
    id: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    apiKeySecretId: "notalith-openrouter-api-key",
  },
];

export function defaultConnections(): ProviderConnection[] {
  return CONNECTION_DEFAULTS.map((connection) => ({ ...connection }));
}

export function normalizeProviderSettings(
  stored: Record<string, unknown> | null,
): Pick<NotalithSettings, "connections" | "models" | "activeModelId"> {
  const connections = defaultConnections();
  for (const connection of connections) {
    const existing = Array.isArray(stored?.connections)
      ? (stored.connections as unknown[]).find(
          (value) => isRecord(value) && value.id === connection.id,
        )
      : undefined;
    if (isRecord(existing)) {
      if (typeof existing.endpoint === "string") {
        connection.endpoint = existing.endpoint.trim();
      }
      if (
        typeof existing.apiKeySecretId === "string" &&
        /^[a-z0-9-]+$/.test(existing.apiKeySecretId)
      ) {
        connection.apiKeySecretId = existing.apiKeySecretId;
      }
    } else if (connection.id === "azure-foundry") {
      if (typeof stored?.azureEndpoint === "string") {
        connection.endpoint = stored.azureEndpoint.trim();
      }
      if (
        typeof stored?.apiKeySecretId === "string" &&
        /^[a-z0-9-]+$/.test(stored.apiKeySecretId)
      ) {
        connection.apiKeySecretId = stored.apiKeySecretId;
      }
    }
  }

  const models: ModelProfile[] = [];
  if (Array.isArray(stored?.models)) {
    const usedIds = new Set<string>();
    for (const value of stored.models) {
      if (
        !isRecord(value) ||
        typeof value.id !== "string" ||
        !value.id.trim() ||
        usedIds.has(value.id) ||
        !isProviderId(value.connectionId) ||
        typeof value.modelId !== "string"
      ) {
        continue;
      }
      usedIds.add(value.id);
      models.push({
        id: value.id,
        connectionId: value.connectionId,
        displayName:
          typeof value.displayName === "string" && value.displayName.trim()
            ? value.displayName.trim()
            : value.modelId.trim() || "New model",
        modelId: value.modelId.trim(),
        ...(typeof value.supportsImages === "boolean"
          ? { supportsImages: value.supportsImages }
          : {}),
      });
    }
  } else {
    const legacy = normalizeDeployments(
      stored?.deployments,
      stored?.deploymentNames,
      typeof stored?.deploymentName === "string" ? stored.deploymentName : "",
    );
    models.push(
      ...legacy.map((deployment) => ({
        id: `azure:${deployment.id}`,
        connectionId: "azure-foundry" as const,
        displayName: deployment.displayName,
        modelId: deployment.deploymentName,
      })),
    );
  }

  const activeModelId =
    typeof stored?.activeModelId === "string" &&
    models.some((model) => model.id === stored.activeModelId && model.modelId)
      ? stored.activeModelId
      : (models.find(
          (model) =>
            model.connectionId === "azure-foundry" &&
            model.modelId === stored?.deploymentName,
        )?.id ??
        models.find((model) => model.modelId)?.id ??
        "");

  return { connections, models, activeModelId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === "string" &&
    PROVIDER_IDS.some((providerId) => providerId === value)
  );
}
