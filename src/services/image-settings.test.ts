import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_SETTINGS,
  normalizeImageSettings,
} from "./image-settings";

describe("independent image settings", () => {
  it("keeps the tool disabled for existing settings and returns independent defaults", () => {
    const first = normalizeImageSettings(undefined);
    expect(first).toEqual(DEFAULT_IMAGE_SETTINGS);
    first.enabled = true;
    expect(normalizeImageSettings(undefined).enabled).toBe(false);
  });

  it("persists connection, image deployment and parameters independently of chat", () => {
    const settings = normalizeImageSettings({
      enabled: true,
      connectionId: "openai",
      modelId: " gpt-image-2 ",
      endpointOverride: " https://gateway.test/v1/ ",
      quality: "high",
      size: "1536x1024",
    });
    expect(settings).toMatchObject({
      enabled: true,
      connectionId: "openai",
      modelId: "gpt-image-2",
      endpointOverride: "https://gateway.test/v1/",
      quality: "high",
      size: "1536x1024",
    });
    expect(normalizeImageSettings(settings)).toEqual(settings);
  });

  it.each([
    null,
    [],
    { enabled: "true" },
    { connectionId: "anthropic" },
    { quality: "max" },
    { size: "4K" },
    { modelId: 123 },
  ])("reports invalid persisted settings explicitly", (value) => {
    expect(() => normalizeImageSettings(value)).toThrow(
      "Invalid image generation",
    );
  });
});
