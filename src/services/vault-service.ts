import {
  App,
  MarkdownView,
  TFile,
  TFolder,
  parseLinktext,
  resolveSubpath,
  getAllTags,
  type CachedMetadata,
} from "obsidian";
import type { ContextAttachment, ModelImage, NoteContext } from "../types";
import { createId } from "./id-utils";
import { pageItems, textRange } from "./vault-pagination";
import {
  dateBound,
  matchesProperty,
  matchesTags,
  searchMatcher,
  type NoteSearchOptions,
} from "./note-search";
import {
  arrayBufferToBase64,
  imageMimeType,
  validateMarkdownPath,
  validateVaultPath,
  validateAttachmentName,
  isTextExtension,
} from "./path-utils";
import {
  extractOfficeDocument,
  isOfficeExtension,
  type OfficeDocumentContent,
} from "./office-document-service";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_EMBEDDED_IMAGES = 10;
const MAX_OFFICE_BYTES = 25 * 1024 * 1024;

export class VaultService {
  constructor(private readonly app: App) {}

  listEntries(
    folder = "",
    recursive = false,
    kind: "all" | "folder" | "note" | "image" | "office" = "all",
    offset = 0,
    limit = 100,
  ) {
    const root = this.requireFolder(folder);
    const entries: Array<{
      path: string;
      name: string;
      kind: "folder" | "file";
      extension?: string;
      size?: number;
    }> = [];
    const visit = (parent: TFolder) => {
      for (const child of [...parent.children].sort((a, b) =>
        a.path.localeCompare(b.path),
      )) {
        if (!this.isAccessible(child.path)) continue;
        if (child instanceof TFolder) {
          if (kind === "all" || kind === "folder") {
            entries.push({
              path: child.path,
              name: child.name,
              kind: "folder",
            });
          }
          if (recursive) visit(child);
        } else if (child instanceof TFile) {
          if (kind === "folder") continue;
          if (kind === "note" && child.extension !== "md") continue;
          if (kind === "image" && !imageMimeType(child.extension)) continue;
          if (kind === "office" && !isOfficeExtension(child.extension))
            continue;
          entries.push({
            path: child.path,
            name: child.name,
            kind: "file",
            extension: child.extension,
            size: child.stat.size,
          });
        }
      }
    };
    visit(root);
    return {
      folder: root.path,
      recursive,
      ...pageItems(entries, offset, limit),
    };
  }

  async createFolder(path: string, signal: AbortSignal): Promise<string> {
    const normalized = validateVaultPath(path, this.app.vault.configDir);
    for (const existingPath of normalized
      .split("/")
      .map((_, index, parts) => parts.slice(0, index + 1).join("/"))) {
      this.requireNotCancelled(signal);
      const existing = this.app.vault.getAbstractFileByPath(existingPath);
      if (existing && !(existing instanceof TFolder)) {
        throw new Error(`Not a folder: ${existingPath}`);
      }
      if (!existing) await this.app.vault.createFolder(existingPath);
    }
    return normalized;
  }

  async readTextFile(
    path: string,
    maxCharacters: number,
    startLine = 1,
    endLine: number | null = null,
    offset = 0,
    markdownOnly = false,
  ) {
    const file = markdownOnly
      ? this.requireMarkdownFile(path)
      : this.requireFile(path);
    if (!isTextExtension(file.extension)) {
      throw new Error(`Not a supported text file: ${file.path}`);
    }
    const content = await this.app.vault.read(file);
    if (content.includes("\0"))
      throw new Error(`Binary content in text file: ${file.path}`);
    return {
      path: file.path,
      ...textRange(content, startLine, endLine, offset, maxCharacters),
    };
  }

  getActiveNote() {
    const file =
      this.activeMarkdownView()?.file ?? this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md")
      throw new Error("No active Markdown note.");
    return this.getNoteMetadata(file.path);
  }

  getEditorContext(maxCharacters: number) {
    const view = this.activeMarkdownView();
    if (!view?.file || view.getMode() !== "source") {
      throw new Error("No active Markdown editor.");
    }
    validateVaultPath(view.file.path, this.app.vault.configDir);
    const selection = view.editor.getSelection();
    return {
      path: view.file.path,
      selection: selection.slice(0, maxCharacters),
      truncated: selection.length > maxCharacters,
      cursor: view.editor.getCursor(),
      from: view.editor.getCursor("from"),
      to: view.editor.getCursor("to"),
      positionBase: 0,
    };
  }

  async resolveWikilink(link: string, sourcePath = "") {
    let value = link.trim();
    if (value.startsWith("!")) value = value.slice(1);
    if (value.startsWith("[[") && value.endsWith("]]"))
      value = value.slice(2, -2);
    value = value.split("|", 1)[0];
    if (!value || /^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(value)) {
      throw new Error(`Not a local note link: ${link}`);
    }
    if (sourcePath) this.requireMarkdownFile(sourcePath);
    const { path, subpath } = parseLinktext(value);
    let file = path
      ? this.app.metadataCache.getFirstLinkpathDest(path, sourcePath)
      : sourcePath
        ? this.requireMarkdownFile(sourcePath)
        : null;
    if (!file && path) {
      const aliases = this.app.vault.getMarkdownFiles().filter((candidate) => {
        if (!this.isAccessible(candidate.path)) return false;
        const frontmatter =
          this.app.metadataCache.getFileCache(candidate)?.frontmatter;
        const raw: unknown = frontmatter?.aliases ?? frontmatter?.alias;
        const names = Array.isArray(raw)
          ? raw
          : typeof raw === "string"
            ? [raw]
            : [];
        return names.some(
          (alias) =>
            typeof alias === "string" &&
            alias.toLowerCase() === path.toLowerCase(),
        );
      });
      if (aliases.length > 1) throw new Error(`Ambiguous note alias: ${path}`);
      file = aliases[0] ?? null;
    }
    if (!file) throw new Error(`Note link not found: ${link}`);
    this.requireMarkdownFile(file.path);
    const text = await this.app.vault.read(file);
    const totalLines = text.split("\n").length;
    const cache = this.app.metadataCache.getFileCache(file);
    let startLine = 1;
    let endLine = totalLines;
    if (subpath) {
      const reference = cache ? resolveSubpath(cache, subpath) : null;
      if (!reference) {
        throw new Error(
          `${subpath.startsWith("#^") ? "Block" : "Heading"} not found: ${subpath}`,
        );
      }
      startLine = reference.start.line + 1;
      endLine =
        reference.type === "heading"
          ? reference.next
            ? reference.next.position.start.line
            : totalLines
          : (reference.end?.line ?? totalLines - 1) + 1;
    }
    return { path: file.path, subpath, startLine, endLine, totalLines };
  }

  listNotes(folder = "", limit = 100): Array<{ path: string; name: string }> {
    const normalizedFolder = folder
      ? `${validateVaultPath(folder.replace(/[\\/]+$/, ""), this.app.vault.configDir)}/`
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
      ? `${validateVaultPath(folder.replace(/[\\/]+$/, ""), this.app.vault.configDir)}/`
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

  async searchNotesAdvanced(options: NoteSearchOptions, signal: AbortSignal) {
    pageItems([], options.offset, options.limit);
    const folder = options.folder
      ? `${this.requireFolder(options.folder).path}/`
      : "";
    const createdAfter = dateBound(options.createdAfter);
    const createdBefore = dateBound(options.createdBefore);
    const modifiedAfter = dateBound(options.modifiedAfter);
    const modifiedBefore = dateBound(options.modifiedBefore);
    if (
      createdAfter !== null &&
      createdBefore !== null &&
      createdAfter > createdBefore
    )
      throw new Error("Created time range is reversed.");
    if (
      modifiedAfter !== null &&
      modifiedBefore !== null &&
      modifiedAfter > modifiedBefore
    )
      throw new Error("Modified time range is reversed.");
    const match = searchMatcher(
      options.query,
      options.regex,
      options.caseSensitive,
    );
    const results: Array<{
      path: string;
      name: string;
      excerpt: string;
      line: number | null;
      tags: string[];
      created: string;
      modified: string;
    }> = [];
    let uncachedNoteCount = 0;
    let examined = 0;
    for (const file of this.app.vault
      .getMarkdownFiles()
      .filter((item) => this.isAccessible(item.path))
      .sort((a, b) => a.path.localeCompare(b.path))) {
      if (++examined % 20 === 0)
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      this.requireNotCancelled(signal);
      if (folder && !file.path.startsWith(folder)) continue;
      if (createdAfter !== null && file.stat.ctime < createdAfter) continue;
      if (createdBefore !== null && file.stat.ctime > createdBefore) continue;
      if (modifiedAfter !== null && file.stat.mtime < modifiedAfter) continue;
      if (modifiedBefore !== null && file.stat.mtime > modifiedBefore) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) uncachedNoteCount++;
      const tags = cache ? (getAllTags(cache) ?? []) : [];
      if (!matchesTags(tags, options.tags)) continue;
      if (
        !options.properties.every((filter) =>
          matchesProperty(cache?.frontmatter, filter),
        )
      )
        continue;
      const content = await this.app.vault.cachedRead(file);
      this.requireNotCancelled(signal);
      const index = options.query ? match(content) : -1;
      if (options.query && index < 0 && match(file.path) < 0) continue;
      results.push({
        path: file.path,
        name: file.basename,
        excerpt:
          index < 0
            ? content.slice(0, 360)
            : content.slice(Math.max(0, index - 120), index + 240),
        line: index < 0 ? null : content.slice(0, index).split("\n").length,
        tags: [...new Set(tags)].sort(),
        created: new Date(file.stat.ctime).toISOString(),
        modified: new Date(file.stat.mtime).toISOString(),
      });
    }
    this.requireNotCancelled(signal);
    return {
      ...pageItems(results, options.offset, options.limit),
      uncachedNoteCount,
    };
  }

  getBacklinks(path: string, offset = 0, limit = 100) {
    const file = this.requireMarkdownFile(path);
    const items = Object.entries(this.app.metadataCache.resolvedLinks)
      .filter(
        ([source, targets]) =>
          this.isAccessible(source) && targets[file.path] > 0,
      )
      .map(([source, targets]) => ({ path: source, count: targets[file.path] }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return { path: file.path, ...pageItems(items, offset, limit) };
  }

  getOutgoingLinks(path: string, offset = 0, limit = 100) {
    const file = this.requireMarkdownFile(path);
    const items = Object.entries(
      this.app.metadataCache.resolvedLinks[file.path] ?? {},
    )
      .filter(([target]) => this.isAccessible(target))
      .map(([target, count]) => ({ path: target, count }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return { path: file.path, ...pageItems(items, offset, limit) };
  }

  getUnresolvedLinks(path: string | null, offset = 0, limit = 100) {
    if (path !== null) this.requireMarkdownFile(path);
    const items = Object.entries(this.app.metadataCache.unresolvedLinks)
      .filter(
        ([source]) =>
          this.isAccessible(source) && (path === null || path === source),
      )
      .flatMap(([source, targets]) =>
        Object.entries(targets).map(([link, count]) => ({
          sourcePath: source,
          link,
          count,
        })),
      )
      .sort(
        (a, b) =>
          a.sourcePath.localeCompare(b.sourcePath) ||
          a.link.localeCompare(b.link),
      );
    return pageItems(items, offset, limit);
  }

  getTagIndex(prefix = "", offset = 0, limit = 100) {
    const index = new Map<string, number>();
    let uncachedNoteCount = 0;
    const normalized =
      prefix && !prefix.startsWith("#") ? `#${prefix}` : prefix;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.isAccessible(file.path)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) uncachedNoteCount++;
      for (const tag of new Set(cache ? (getAllTags(cache) ?? []) : [])) {
        if (tag.startsWith(normalized))
          index.set(tag, (index.get(tag) ?? 0) + 1);
      }
    }
    return {
      ...pageItems(
        [...index]
          .map(([tag, noteCount]) => ({ tag, noteCount }))
          .sort((a, b) => a.tag.localeCompare(b.tag)),
        offset,
        limit,
      ),
      uncachedNoteCount,
    };
  }

  getNoteOutline(path: string, offset = 0, limit = 100) {
    const file = this.requireMarkdownFile(path);
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) throw new Error(`Metadata has not been indexed: ${file.path}`);
    const headings = cache.headings ?? [];
    return {
      path: file.path,
      ...pageItems(
        headings.map((heading) => ({
          heading: heading.heading,
          level: heading.level,
          line: heading.position.start.line + 1,
        })),
        offset,
        limit,
      ),
    };
  }

  async importAttachment(
    name: string,
    data: ArrayBuffer,
    folder = "",
    sourcePath = "",
  ) {
    validateAttachmentName(name);
    if (data.byteLength > MAX_ATTACHMENT_BYTES)
      throw new Error("Attachment exceeds 25 MB.");
    if (sourcePath) this.requireMarkdownFile(sourcePath);
    let path: string;
    if (folder) {
      const normalized = validateVaultPath(folder, this.app.vault.configDir);
      await this.createFolder(normalized, new AbortController().signal);
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const extension = dot > 0 ? name.slice(dot) : "";
      path = `${normalized}/${name}`;
      let suffix = 1;
      while (this.app.vault.getAbstractFileByPath(path)) {
        if (suffix > 10_000)
          throw new Error("No available attachment filename.");
        path = `${normalized}/${stem} (${suffix++})${extension}`;
      }
    } else {
      path = await this.app.fileManager.getAvailablePathForAttachment(
        name,
        sourcePath || undefined,
      );
      const parent = path.split("/").slice(0, -1).join("/");
      validateVaultPath(path, this.app.vault.configDir);
      if (parent) await this.createFolder(parent, new AbortController().signal);
    }
    validateVaultPath(path, this.app.vault.configDir);
    const file = await this.app.vault.createBinary(path, data);
    return {
      file,
      link: this.app.fileManager.generateMarkdownLink(file, sourcePath),
    };
  }

  generateAttachmentLink(path: string, sourcePath = "", embed = false) {
    if (sourcePath) this.requireMarkdownFile(sourcePath);
    const link = this.app.fileManager.generateMarkdownLink(
      this.requireFile(path),
      sourcePath,
    );
    return { path, sourcePath, link: embed ? `!${link}` : link };
  }

  listAttachableFiles(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((file) => this.isAccessible(file.path));
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

  async createMarkdownNote(
    path: string,
    content: string,
    signal: AbortSignal,
  ): Promise<string> {
    const normalized = validateMarkdownPath(path, this.app.vault.configDir);
    if (this.app.vault.getAbstractFileByPath(normalized)) {
      throw new Error(`Note already exists: ${normalized}`);
    }
    const folders = normalized.split("/").slice(0, -1);
    for (let index = 0; index < folders.length; index++) {
      this.requireNotCancelled(signal);
      const folderPath = folders.slice(0, index + 1).join("/");
      const existing = this.app.vault.getAbstractFileByPath(folderPath);
      if (existing && !(existing instanceof TFolder)) {
        throw new Error(`Not a folder: ${folderPath}`);
      }
      if (!existing) await this.app.vault.createFolder(folderPath);
    }
    this.requireNotCancelled(signal);
    const file = await this.app.vault.create(normalized, content);
    return file.path;
  }

  async appendMarkdownNote(
    path: string,
    addition: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (!addition) throw new Error("Append content must not be empty.");
    const file = this.requireMarkdownFile(path);
    await this.app.vault.process(file, (current) => {
      this.requireNotCancelled(signal);
      if (!current) return addition;
      const newline = current.includes("\r\n") ? "\r\n" : "\n";
      const separator = current.endsWith(newline + newline)
        ? ""
        : current.endsWith(newline)
          ? newline
          : newline + newline;
      return current + separator + addition;
    });
    return file.path;
  }

  async replaceMarkdownText(
    path: string,
    oldText: string,
    newText: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (!oldText) throw new Error("Text to replace must not be empty.");
    if (oldText === newText)
      throw new Error("Replacement must change the note.");
    const file = this.requireMarkdownFile(path);
    await this.app.vault.process(file, (current) => {
      this.requireNotCancelled(signal);
      const first = current.indexOf(oldText);
      if (first === -1) throw new Error(`Text not found in note: ${file.path}`);
      if (current.indexOf(oldText, first + 1) !== -1) {
        throw new Error(`Text occurs more than once in note: ${file.path}`);
      }
      return (
        current.slice(0, first) +
        newText +
        current.slice(first + oldText.length)
      );
    });
    return file.path;
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
      id: createId(),
      kind: "note",
      path: file.path,
      name: file.basename,
    };
  }

  getActiveSelectionAttachment(): ContextAttachment | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || !view.editor.somethingSelected()) return null;

    return {
      id: createId(),
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
    const normalized = validateVaultPath(path, this.app.vault.configDir);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
    return file;
  }

  private requireFolder(path: string): TFolder {
    if (!path) return this.app.vault.getRoot();
    const normalized = validateVaultPath(path, this.app.vault.configDir);
    const folder = this.app.vault.getAbstractFileByPath(normalized);
    if (!(folder instanceof TFolder))
      throw new Error(`Folder not found: ${normalized}`);
    return folder;
  }

  private isAccessible(path: string): boolean {
    const protectedDir = this.app.vault.configDir
      .replaceAll("\\", "/")
      .replace(/\/+$/, "")
      .toLowerCase();
    const lower = path.toLowerCase();
    return lower !== protectedDir && !lower.startsWith(`${protectedDir}/`);
  }

  private activeMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) return active;
    const file = this.app.workspace.getActiveFile();
    const leaf = this.app.workspace
      .getLeavesOfType("markdown")
      .find(
        (candidate) =>
          candidate.view instanceof MarkdownView &&
          candidate.view.file?.path === file?.path,
      );
    return leaf?.view instanceof MarkdownView ? leaf.view : null;
  }

  private requireMarkdownFile(path: string): TFile {
    const normalized = validateMarkdownPath(path, this.app.vault.configDir);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) {
      throw new Error(`Markdown note not found: ${normalized}`);
    }
    return file;
  }

  private requireNotCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new Error("Request cancelled.");
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
      tags: cache ? [...new Set(getAllTags(cache) ?? [])] : [],
    };
  }
}
