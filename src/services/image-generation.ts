import type {
  GeneratedImage,
  ImageProvider,
} from "../providers/image-provider";
import type { GeneratedImageArtifact } from "../types";
import { NotalithError } from "../types";
import { createId } from "./id-utils";
import { arrayBufferToBase64, validateAttachmentName } from "./path-utils";
import type { VaultService } from "./vault-service";

export class ImageSaveError extends Error {
  constructor(
    readonly artifact: Extract<GeneratedImageArtifact, { status: "unsaved" }>,
  ) {
    super(
      `Image generated but not saved: ${artifact.error}. Use Retry save; do not generate again.`,
    );
  }
}

export class ImageGenerationService {
  private provider: ImageProvider | null = null;
  private folder = "";
  private busy = false;
  private pending: {
    id: string;
    image: GeneratedImage;
    filename: string;
    folder: string;
    sourcePath: string;
    error?: string;
  } | null = null;

  constructor(
    private readonly vault: Pick<
      VaultService,
      "validateAttachmentDestination" | "importAttachment"
    >,
  ) {}

  configure(provider: ImageProvider | null, folder: string): void {
    this.provider = provider;
    this.folder = folder;
  }

  get available(): boolean {
    return this.provider !== null;
  }

  get pendingArtifact(): Extract<
    GeneratedImageArtifact,
    { status: "unsaved" }
  > | null {
    return this.pending
      ? {
          id: this.pending.id,
          status: "unsaved",
          filename: this.pending.filename,
          error: this.pending.error ?? "Not saved.",
        }
      : null;
  }

  async generate(
    prompt: string,
    filename: string | null,
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<GeneratedImageArtifact> {
    if (!this.provider)
      throw new NotalithError(
        "Image generation is not configured or enabled.",
        "configuration",
      );
    if (this.busy)
      throw new NotalithError("An image operation is already running.", "tool");
    if (this.pending)
      throw new NotalithError(
        "Save or discard the pending generated image before generating another.",
        "tool",
      );
    this.checkCancelled(signal);
    const name = filename || `generated-${createId()}.png`;
    validateAttachmentName(name);
    if (!name.toLowerCase().endsWith(".png"))
      throw new NotalithError(
        "Generated image filename must end in .png.",
        "tool",
      );
    this.vault.validateAttachmentDestination(this.folder, sourcePath);
    const provider = this.provider;
    const folder = this.folder;
    this.busy = true;
    try {
      const image = await provider.generate(prompt, signal);
      this.checkCancelled(signal);
      this.pending = {
        id: createId(),
        image,
        filename: name,
        folder,
        sourcePath,
      };
      return await this.save(signal);
    } finally {
      this.busy = false;
    }
  }

  async retrySave(
    id: string,
    signal: AbortSignal,
  ): Promise<GeneratedImageArtifact> {
    if (this.busy)
      throw new NotalithError("An image operation is already running.", "tool");
    if (!this.pending || this.pending.id !== id)
      throw new NotalithError("No pending image to save.", "tool");
    this.busy = true;
    try {
      return await this.save(signal);
    } finally {
      this.busy = false;
    }
  }

  pendingPreview(id: string): string {
    if (!this.pending || this.pending.id !== id)
      throw new NotalithError("Pending image is no longer available.", "tool");
    return `data:image/png;base64,${arrayBufferToBase64(this.pending.image.data)}`;
  }

  discard(id: string): void {
    if (this.busy)
      throw new NotalithError("An image operation is already running.", "tool");
    if (!this.pending || this.pending.id !== id)
      throw new NotalithError("Pending image is no longer available.", "tool");
    this.pending = null;
  }

  private async save(signal: AbortSignal): Promise<GeneratedImageArtifact> {
    const pending = this.pending;
    if (!pending) throw new NotalithError("No pending image to save.", "tool");
    try {
      this.checkCancelled(signal);
      const { file, link } = await this.vault.importAttachment(
        pending.filename,
        pending.image.data,
        pending.folder,
        pending.sourcePath,
        signal,
      );
      const artifact: GeneratedImageArtifact = {
        id: pending.id,
        status: "saved",
        path: file.path,
        sourcePath: pending.sourcePath,
        embedLink: `!${link}`,
      };
      this.pending = null;
      return artifact;
    } catch (error) {
      pending.error = error instanceof Error ? error.message : String(error);
      throw new ImageSaveError({
        id: pending.id,
        status: "unsaved",
        filename: pending.filename,
        error: pending.error,
      });
    }
  }

  private checkCancelled(signal: AbortSignal): void {
    if (signal.aborted)
      throw new NotalithError("Request cancelled.", "cancelled");
  }
}
