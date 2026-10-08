import type { ImageGenerationSettings } from "../types";
import { NotalithError } from "../types";

export const DEFAULT_IMAGE_SETTINGS: ImageGenerationSettings = {
  enabled: false,
  connectionId: "azure-foundry",
  modelId: "",
  endpointOverride: "",
  azureApiVersion: "2025-04-01-preview",
  size: "1024x1024",
  quality: "medium",
};

export function normalizeImageSettings(
  value: unknown,
): ImageGenerationSettings {
  if (value === undefined) return { ...DEFAULT_IMAGE_SETTINGS };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotalithError(
      "Invalid image generation settings.",
      "configuration",
    );
  }
  const result = { ...DEFAULT_IMAGE_SETTINGS };
  const settings = value as Record<string, unknown>;
  for (const key of [
    "enabled",
    "connectionId",
    "modelId",
    "endpointOverride",
    "azureApiVersion",
    "size",
    "quality",
  ] as const) {
    if (settings[key] === undefined) continue;
    const item = settings[key];
    switch (key) {
      case "enabled":
        if (typeof item !== "boolean") throw invalid(key);
        result.enabled = item;
        break;
      case "connectionId":
        if (item !== "azure-foundry" && item !== "openai") throw invalid(key);
        result.connectionId = item;
        break;
      case "size":
        if (
          item !== "1024x1024" &&
          item !== "1536x1024" &&
          item !== "1024x1536"
        )
          throw invalid(key);
        result.size = item;
        break;
      case "quality":
        if (item !== "low" && item !== "medium" && item !== "high")
          throw invalid(key);
        result.quality = item;
        break;
      default:
        if (typeof item !== "string") throw invalid(key);
        result[key] = item.trim();
    }
  }
  return result;
}

function invalid(key: string): NotalithError {
  return new NotalithError(
    `Invalid image generation setting: ${key}.`,
    "configuration",
  );
}
