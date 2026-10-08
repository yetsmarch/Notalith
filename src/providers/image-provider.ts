import { requestUrl } from "obsidian";
import type { ImageGenerationSettings, ProviderConnection } from "../types";
import { NotalithError } from "../types";

export interface GeneratedImage {
  data: ArrayBuffer;
  mimeType: "image/png";
}

export interface ImageProvider {
  generate(prompt: string, signal: AbortSignal): Promise<GeneratedImage>;
}

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export class OpenAIImageProvider implements ImageProvider {
  constructor(
    private readonly connection: ProviderConnection,
    private readonly settings: ImageGenerationSettings,
    private readonly getApiKey: () => string | null,
  ) {}

  validateConfiguration(): void {
    if (!this.getApiKey()) {
      throw new NotalithError(
        "Save an API key for the image connection.",
        "authentication",
      );
    }
    this.generationUrl();
  }

  async generate(prompt: string, signal: AbortSignal): Promise<GeneratedImage> {
    if (signal.aborted)
      throw new NotalithError("Request cancelled.", "cancelled");
    if (!prompt.trim() || prompt.length > 32_000) {
      throw new NotalithError(
        "Image prompt must contain 1 to 32,000 characters.",
        "configuration",
      );
    }
    const key = this.getApiKey();
    if (!key)
      throw new NotalithError(
        "Save an API key for the image connection.",
        "authentication",
      );
    const url = this.generationUrl();
    const body = JSON.stringify({
      model: this.settings.modelId,
      prompt,
      n: 1,
      size: this.settings.size,
      quality: this.settings.quality,
      output_format: "png",
    });
    // requestUrl bypasses mobile WebView CORS. Never retry a billed generation.
    const response = await requestUrl({
      url,
      method: "POST",
      headers:
        this.connection.id === "azure-foundry"
          ? { "api-key": key }
          : { Authorization: `Bearer ${key}` },
      contentType: "application/json",
      body,
      throw: false,
    });
    if (signal.aborted) {
      throw new NotalithError(
        "Request cancelled. Image generation may already have been billed; no image was saved.",
        "cancelled",
      );
    }
    const parsed: unknown = response.json;
    const record = asRecord(parsed);
    const error = asRecord(record?.error);
    if (response.status < 200 || response.status >= 300 || error) {
      const message =
        typeof error?.message === "string"
          ? error.message
          : `Image generation failed (${response.status}).`;
      const category =
        response.status === 401
          ? "authentication"
          : response.status === 403
            ? "authorization"
            : response.status === 429
              ? "rate_limit"
              : /content.?filter|content_policy|safety/i.test(
                    `${String(error?.code)} ${message}`,
                  )
                ? "content_filter"
                : "provider";
      throw new NotalithError(message, category, response.status);
    }
    if (!Array.isArray(record?.data) || record.data.length !== 1) {
      throw new NotalithError(
        "Image generation did not return exactly one image.",
        "provider",
      );
    }
    const base64 = asRecord(record.data[0])?.b64_json;
    if (
      typeof base64 !== "string" ||
      !base64 ||
      base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
    )
      throw new NotalithError(
        "Invalid or oversized generated image data.",
        "provider",
      );
    let binary: string;
    try {
      binary = atob(base64);
    } catch {
      throw new NotalithError("Invalid generated image encoding.", "provider");
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++)
      bytes[index] = binary.charCodeAt(index);
    if (
      bytes.length > MAX_IMAGE_BYTES ||
      !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
    ) {
      throw new NotalithError(
        "The image provider did not return a valid PNG within 25 MB.",
        "provider",
      );
    }
    return { data: bytes.buffer, mimeType: "image/png" };
  }

  private generationUrl(): string {
    if (!this.settings.modelId.trim())
      throw new NotalithError(
        "Configure an image model or deployment.",
        "configuration",
      );
    let url: URL;
    try {
      url = new URL(this.settings.endpointOverride || this.connection.endpoint);
    } catch {
      throw new NotalithError("Invalid image endpoint URL.", "configuration");
    }
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new NotalithError(
        "Image endpoint must use HTTPS without credentials, query or fragment.",
        "configuration",
      );
    const base = url.pathname.replace(/\/+$/, "");
    if (this.connection.id === "azure-foundry") {
      if (
        !/^\d{4}-\d{2}-\d{2}(?:-preview)?$/.test(this.settings.azureApiVersion)
      ) {
        throw new NotalithError(
          "Invalid Azure image API version.",
          "configuration",
        );
      }
      url.pathname = `${base.replace(/\/openai\/v1$/, "")}/openai/deployments/${encodeURIComponent(this.settings.modelId)}/images/generations`;
      url.searchParams.set("api-version", this.settings.azureApiVersion);
    } else if (this.connection.id === "openai") {
      url.pathname = `${base}/images/generations`;
    } else {
      throw new NotalithError("Unsupported image connection.", "configuration");
    }
    return url.toString();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
