import { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ImageGenerationService, ImageSaveError } from "./image-generation";
import type { ImageProvider } from "../providers/image-provider";
import type { VaultService } from "./vault-service";

vi.mock("obsidian", () => ({ TFile: class {} }));
const data = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
const fixture = () => {
  const generate = vi
    .fn<ImageProvider["generate"]>()
    .mockResolvedValue({ data, mimeType: "image/png" });
  const importAttachment = vi
    .fn<VaultService["importAttachment"]>()
    .mockResolvedValue({
      file: Object.assign(new TFile(), { path: "Attachments/image (1).png" }),
      link: "[image (1).png](../Attachments/image%20(1).png)",
    });
  const validateAttachmentDestination =
    vi.fn<VaultService["validateAttachmentDestination"]>();
  const service = new ImageGenerationService({
    importAttachment,
    validateAttachmentDestination,
  });
  service.configure({ generate }, "Attachments");
  return { service, generate, importAttachment, validateAttachmentDestination };
};

describe("image generation and attachment storage", () => {
  it("returns the actual non-overwriting path and embed after saving, without Base64", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const result = await f.service.generate(
      "Prompt",
      "image.png",
      "Notes/current.md",
      signal,
    );
    expect(f.validateAttachmentDestination).toHaveBeenCalledWith(
      "Attachments",
      "Notes/current.md",
    );
    expect(f.generate).toHaveBeenCalledWith("Prompt", signal);
    expect(f.importAttachment).toHaveBeenCalledWith(
      "image.png",
      data,
      "Attachments",
      "Notes/current.md",
      signal,
    );
    expect(result).toMatchObject({
      status: "saved",
      path: "Attachments/image (1).png",
      sourcePath: "Notes/current.md",
      embedLink: "![image (1).png](../Attachments/image%20(1).png)",
    });
    expect(JSON.stringify(result)).not.toContain("base64");
    expect(f.service.pendingArtifact).toBeNull();
  });

  it("retains failed saves across configuration changes and retries only saving", async () => {
    const f = fixture();
    f.importAttachment.mockRejectedValueOnce(new Error("Disk full"));
    const error = await f.service
      .generate("Prompt", "image.png", "", new AbortController().signal)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ImageSaveError);
    const pending = f.service.pendingArtifact;
    if (!pending) throw new Error("Missing pending image");
    expect(pending.error).toBe("Disk full");
    expect(f.service.pendingPreview(pending.id)).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    f.service.configure(null, "Other");
    expect(f.service.available).toBe(false);
    const saved = await f.service.retrySave(
      pending.id,
      new AbortController().signal,
    );
    expect(saved.status).toBe("saved");
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.importAttachment).toHaveBeenLastCalledWith(
      "image.png",
      data,
      "Attachments",
      "",
      expect.any(AbortSignal),
    );
  });

  it("blocks further generations while an unsaved image is pending", async () => {
    const f = fixture();
    f.importAttachment.mockRejectedValueOnce(new Error("Disk full"));
    await expect(
      f.service.generate(
        "Prompt",
        "image.png",
        "",
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ImageSaveError);
    await expect(
      f.service.generate("New", null, "", new AbortController().signal),
    ).rejects.toThrow("pending generated image");
    const pending = f.service.pendingArtifact;
    if (!pending) throw new Error("Missing pending image");
    f.service.discard(pending.id);
    await f.service.generate("New", null, "", new AbortController().signal);
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe names and destinations before generation", async () => {
    const f = fixture();
    for (const name of [
      "../image.png",
      "file.jpg",
      "con.png",
      "bad\\image.png",
    ]) {
      await expect(
        f.service.generate("Prompt", name, "", new AbortController().signal),
      ).rejects.toThrow();
    }
    f.validateAttachmentDestination.mockImplementation(() => {
      throw new Error("Unsafe vault path");
    });
    await expect(
      f.service.generate("Prompt", null, "", new AbortController().signal),
    ).rejects.toThrow("Unsafe");
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.importAttachment).not.toHaveBeenCalled();
  });

  it("does not save when cancelled while generation is in flight", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.generate.mockImplementation(async () => {
      controller.abort();
      return { data, mimeType: "image/png" };
    });
    await expect(
      f.service.generate("Prompt", null, "", controller.signal),
    ).rejects.toMatchObject({ category: "cancelled" });
    expect(f.importAttachment).not.toHaveBeenCalled();
  });

  it("rejects concurrent image operations and snapshots the destination", async () => {
    const f = fixture();
    let resolve:
      | ((value: Awaited<ReturnType<ImageProvider["generate"]>>) => void)
      | undefined;
    f.generate.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = f.service.generate(
      "Prompt",
      "image.png",
      "",
      new AbortController().signal,
    );
    await expect(
      f.service.generate("Other", null, "", new AbortController().signal),
    ).rejects.toThrow("already running");
    f.service.configure(null, "Other");
    if (!resolve) throw new Error("Generation was not started");
    resolve({ data, mimeType: "image/png" });
    await first;
    expect(f.importAttachment).toHaveBeenCalledWith(
      "image.png",
      data,
      "Attachments",
      "",
      expect.any(AbortSignal),
    );
  });
});
