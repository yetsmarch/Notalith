import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIImageProvider } from "./image-provider";
import { DEFAULT_IMAGE_SETTINGS } from "../services/image-settings";

const { requestUrlMock } = vi.hoisted(() => ({
  requestUrlMock:
    vi.fn<
      (options: {
        url: string;
        headers: Record<string, string>;
        body: string;
      }) => Promise<{ status: number; json: unknown }>
    >(),
}));
vi.mock("obsidian", () => ({ requestUrl: requestUrlMock }));
const png = "iVBORw0KGgo=";
const makeProvider = (
  connectionId: "azure-foundry" | "openai" = "azure-foundry",
  overrides: Partial<typeof DEFAULT_IMAGE_SETTINGS> = {},
  key: string | null = "private-key",
) =>
  new OpenAIImageProvider(
    {
      id: connectionId,
      endpoint:
        connectionId === "azure-foundry"
          ? "https://resource.openai.azure.com/openai/v1/"
          : "https://api.openai.com/v1",
      apiKeySecretId: "secret-ref",
    },
    {
      ...DEFAULT_IMAGE_SETTINGS,
      connectionId,
      modelId: "custom deployment",
      ...overrides,
    },
    () => key,
  );
const success = () => ({ status: 200, json: { data: [{ b64_json: png }] } });

describe("independent Images API provider", () => {
  beforeEach(() => requestUrlMock.mockReset());

  it("uses the documented Azure deployment API, saved key and exactly one PNG", async () => {
    requestUrlMock.mockResolvedValue(success());
    const image = await makeProvider().generate(
      "A landscape.",
      new AbortController().signal,
    );
    expect(Array.from(new Uint8Array(image.data))).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    expect(image.mimeType).toBe("image/png");
    const request = requestUrlMock.mock.calls[0][0];
    expect(request.url).toBe(
      "https://resource.openai.azure.com/openai/deployments/custom%20deployment/images/generations?api-version=2025-04-01-preview",
    );
    expect(request.headers).toEqual({ "api-key": "private-key" });
    expect(JSON.parse(request.body)).toEqual({
      model: "custom deployment",
      prompt: "A landscape.",
      n: 1,
      size: "1024x1024",
      quality: "medium",
      output_format: "png",
    });
    expect(request.body).not.toContain("private-key");
  });

  it("uses OpenAI authentication and respects the image endpoint override", async () => {
    requestUrlMock.mockResolvedValue(success());
    await makeProvider("openai", {
      endpointOverride: "https://gateway.test/v1/",
      quality: "high",
      size: "1536x1024",
    }).generate("Prompt", new AbortController().signal);
    const request = requestUrlMock.mock.calls[0][0];
    expect(request.url).toBe("https://gateway.test/v1/images/generations");
    expect(request.headers).toEqual({ Authorization: "Bearer private-key" });
    expect(JSON.parse(request.body)).toMatchObject({
      quality: "high",
      size: "1536x1024",
    });
  });

  it.each([401, 403, 429, 500])(
    "reports HTTP %i without retrying",
    async (status) => {
      requestUrlMock.mockResolvedValue({
        status,
        json: { error: { message: "Provider failed" } },
      });
      await expect(
        makeProvider().generate("Prompt", new AbortController().signal),
      ).rejects.toMatchObject({ status, message: "Provider failed" });
      expect(requestUrlMock).toHaveBeenCalledTimes(1);
    },
  );

  it("reports a content policy failure even when HTTP status is 200", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { error: { code: "contentFilter", message: "Blocked" } },
    });
    await expect(
      makeProvider().generate("Prompt", new AbortController().signal),
    ).rejects.toMatchObject({ category: "content_filter" });
  });

  it.each([
    {},
    { data: [] },
    { data: [{ b64_json: png }, { b64_json: png }] },
    { data: [{ url: "https://untrusted.test/image" }] },
    { data: [{ b64_json: "not-base64" }] },
    { data: [{ b64_json: "dGV4dA==" }] },
  ])(
    "rejects invalid image responses without fetching returned URLs",
    async (json) => {
      requestUrlMock.mockResolvedValue({ status: 200, json });
      await expect(
        makeProvider().generate("Prompt", new AbortController().signal),
      ).rejects.toMatchObject({ category: "provider" });
      expect(requestUrlMock).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects missing keys, invalid endpoint and version before making a paid request", async () => {
    await expect(
      makeProvider("azure-foundry", {}, null).generate(
        "Prompt",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "authentication" });
    await expect(
      makeProvider("azure-foundry", {
        endpointOverride: "https://key:secret@gateway.test/",
      }).generate("Prompt", new AbortController().signal),
    ).rejects.toMatchObject({ category: "configuration" });
    await expect(
      makeProvider("azure-foundry", { azureApiVersion: "" }).generate(
        "Prompt",
        new AbortController().signal,
      ),
    ).rejects.toThrow("API version");
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it("validates configuration without sending a generation request", () => {
    expect(() => makeProvider().validateConfiguration()).not.toThrow();
    expect(() =>
      makeProvider("azure-foundry", {}, null).validateConfiguration(),
    ).toThrow("API key");
    expect(() =>
      makeProvider("azure-foundry", { modelId: "" }).validateConfiguration(),
    ).toThrow("image model");
    expect(() =>
      makeProvider("azure-foundry", {
        endpointOverride: "https://gateway.test/?unexpected=true",
      }).validateConfiguration(),
    ).toThrow("query");
    expect(() =>
      makeProvider("azure-foundry", {
        azureApiVersion: "invalid",
      }).validateConfiguration(),
    ).toThrow("API version");
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it("accepts the exact 25 MB limit and rejects oversized encoded or decoded data", async () => {
    const limit = 25 * 1024 * 1024;
    const base64 = btoa("\x89PNG\r\n\x1a\n" + "\0".repeat(limit - 8));
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: { data: [{ b64_json: base64 }] },
    });
    const image = await makeProvider().generate(
      "Prompt",
      new AbortController().signal,
    );
    expect(image.data.byteLength).toBe(limit);

    for (const oversized of [
      base64.replace(/==$/, "A="),
      base64.replace(/==$/, "AAAA=="),
    ]) {
      requestUrlMock.mockResolvedValue({
        status: 200,
        json: { data: [{ b64_json: oversized }] },
      });
      await expect(
        makeProvider().generate("Prompt", new AbortController().signal),
      ).rejects.toMatchObject({ category: "provider" });
    }
    expect(requestUrlMock).toHaveBeenCalledTimes(3);
  });

  it("never starts a cancelled generation and rejects a late response without retrying", async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      makeProvider().generate("Prompt", before.signal),
    ).rejects.toMatchObject({ category: "cancelled" });
    expect(requestUrlMock).not.toHaveBeenCalled();
    const during = new AbortController();
    requestUrlMock.mockImplementation(async () => {
      during.abort();
      return success();
    });
    await expect(
      makeProvider().generate("Prompt", during.signal),
    ).rejects.toThrow("may already have been billed");
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
  });
});
