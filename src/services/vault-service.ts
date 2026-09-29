import { App, MarkdownView, TFile, type CachedMetadata } from "obsidian";
import type { ContextAttachment, ModelImage, NoteContext } from "../types";
import {
  arrayBufferToBase64,
  imageMimeType,
  validateVaultPath,
} from "./path-utils";
import {
  extractOfficeDocument,
  isOfficeExtension,
  type OfficeDocumentContent,
} from "./office-document-service";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_EMBEDDED_IMAGES = 10;
const MAX_OFFICE_BYTES = 25 * 1024 * 1024;

export class VaultService {
  constructor(private readonly app: App) {}

  listNotes(folder = "", limit = 100): Array<{ path: string; name: string }> {
    const normalizedFolder = folder
      ? `${validateVaultPath(folder).replace(/\/+$/, "")}/`
      : "";

    return this.app.vault
      .getMarkdownFiles()
      .filter(
        (file) => !normalizedFolder || file.path.startsWith(normalizedFolder),
      )
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map((file) => ({ path: file.path, name: file.basename }));
  }

  listFiles(
    folder = "",
    kind: "image" | "office" | "all" = "all",
    limit = 100,
  ): Array<{
    path: string;
    name: string;
    extension: string;
    size: number;
  }> {
    const normalizedFolder = folder
      ? `${validateVaultPath(folder).replace(/\/+$/, "")}/`
      : "";

    return this.app.vault
      .getFiles()
      .filter(
        (file) =>
          (!normalizedFolder || file.path.startsWith(normalizedFolder)) &&
          (kind === "all" ||
            (kind === "image" && imageMimeType(file.extension) !== null) ||
            (kind === "office" && isOfficeExtension(file.extension))),
      )
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map((file) => ({
        path: file.path,
        name: file.name,
        extension: file.extension,
        size: file.stat.size,
      }));
  }

  async searchNotes(
    query: string,
    limit = 20,
  ): Promise<Array<{ path: string; name: string; excerpt: string }>> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];

    const results: Array<{
      path: string;
      name: string;
      excerpt: string;
      score: number;
    }> = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      const pathMatch = file.path.toLocaleLowerCase().includes(needle);
      const content = await this.app.vault.cachedRead(file);
      const contentIndex = content.toLocaleLowerCase().indexOf(needle);
      if (!pathMatch && contentIndex < 0) continue;

      const excerptStart = Math.max(0, contentIndex - 120);
      results.push({
        path: file.path,
        name: file.basename,
        excerpt:
          contentIndex >= 0
            ? content.slice(excerptStart, excerptStart + 360)
            : "",
        score: pathMatch ? 2 : 1,
      });
    }

    return results
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map(({ path, name, excerpt }) => ({ path, name, excerpt }));
  }

  async readNote(path: string, maxCharacters: number): Promise<NoteContext> {
    const file = this.requireFile(path);
    if (file.extension !== "md") {
      throw new Error(`Not a Markdown note: ${path}`);
    }

    const fullContent = await this.app.vault.cachedRead(file);
    return {
      path: file.path,
      content: fullContent.slice(0, maxCharacters),
      images: [],
      truncated: fullContent.length > maxCharacters,
    };
  }

  async readImage(path: string): Promise<ModelImage> {
    const file = this.requireFile(path);
    const mimeType = imageMimeType(file.extension);
    if (!mimeType) throw new Error(`Unsupported image type: ${file.extension}`);
    if (file.stat.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image exceeds 10 MB: ${file.path}`);
    }

    const data = await this.app.vault.readBinary(file);
    return {
      mimeType,
      data: arrayBufferToBase64(data),
      sourcePath: file.path,
    };
  }

  async readOfficeDocument(
    path: string,
    maxCharacters: number,
  ): Promise<OfficeDocumentContent> {
    const file = this.requireFile(path);
    if (!isOfficeExtension(file.extension)) {
      throw new Error(`Not a supported Office document: ${file.path}`);
    }
    if (file.stat.size > MAX_OFFICE_BYTES) {
      throw new Error(`Office document exceeds 25 MB: ${file.path}`);
    }
    return extractOfficeDocument(
      file.path,
      file.extension,
      await this.app.vault.readBinary(file),
      maxCharacters,
    );
  }

  async readEmbeddedImages(notePath: string): Promise<ModelImage[]> {
    const note = this.requireFile(notePath);
    const metadata = this.app.metadataCache.getFileCache(note);
    const links = metadata?.embeds?.map((embed) => embed.link) ?? [];
    const images: ModelImage[] = [];
    const seen = new Set<string>();

    for (const link of links) {
      if (images.length >= MAX_EMBEDDED_IMAGES) break;
      const target = this.app.metadataCache.getFirstLinkpathDest(
        link,
        note.path,
      );
      if (
        !target ||
        seen.has(target.path) ||
        !imageMimeType(target.extension)
      ) {
        continue;
      }
      seen.add(target.path);
      images.push(await this.readImage(target.path));
    }

    return images;
  }

  getNoteMetadata(path: string): Record<string, unknown> {
    const file = this.requireFile(path);
    const cache = this.app.metadataCache.getFileCache(file);
    return this.serializeMetadata(file, cache);
  }

  getActiveNoteAttachment(): ContextAttachment | null {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return null;
    return {
      id: crypto.randomUUID(),
      kind: "note",
      path: file.path,
      name: file.basename,
    };
  }

  getActiveSelectionAttachment(): ContextAttachment | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || !view.editor.somethingSelected()) return null;

    return {
      id: crypto.randomUUID(),
      kind: "selection",
      path: view.file.path,
      name: `${view.file.basename} selection`,
      text: view.editor.getSelection(),
    };
  }

  listAttachableImages(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((file) => imageMimeType(file.extension) !== null);
  }

  listAttachableNotes(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  listAttachableDocuments(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((file) => isOfficeExtension(file.extension));
  }

  private requireFile(path: string): TFile {
    const normalized = validateVaultPath(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
    return file;
  }

  private serializeMetadata(
    file: TFile,
    cache: CachedMetadata | null,
  ): Record<string, unknown> {
    return {
      path: file.path,
      size: file.stat.size,
      modified: new Date(file.stat.mtime).toISOString(),
      frontmatter: cache?.frontmatter ?? null,
      headings:
        cache?.headings?.map((heading) => ({
          heading: heading.heading,
          level: heading.level,
        })) ?? [],
      links: cache?.links?.map((link) => link.link) ?? [],
      embeds: cache?.embeds?.map((embed) => embed.link) ?? [],
      tags: cache?.tags?.map((tag) => tag.tag) ?? [],
    };
  }
}
