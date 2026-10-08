import { describe, expect, it, vi } from "vitest";
import {
  MarkdownView,
  TFile,
  TFolder,
  type App,
  type CachedMetadata,
  type WorkspaceLeaf,
} from "obsidian";
import { VaultService } from "./vault-service";
import type { NoteSearchOptions } from "./note-search";

vi.mock("obsidian", () => ({
  TFile: class {},
  TFolder: class {},
  MarkdownView: class {},
  getAllTags: (cache: CachedMetadata) => [
    ...(cache.tags?.map((tag) => tag.tag) ?? []),
    ...(Array.isArray(cache.frontmatter?.tags)
      ? (cache.frontmatter.tags as string[]).map((tag) =>
          tag.startsWith("#") ? tag : `#${tag}`,
        )
      : []),
  ],
  parseLinktext: (link: string) => {
    const hash = link.indexOf("#");
    return hash < 0
      ? { path: link, subpath: "" }
      : { path: link.slice(0, hash), subpath: link.slice(hash) };
  },
  resolveSubpath: (cache: CachedMetadata, subpath: string) => {
    if (subpath.startsWith("#^")) {
      const block = cache.blocks?.[subpath.slice(2)];
      return block
        ? {
            type: "block",
            start: block.position.start,
            end: block.position.end,
          }
        : null;
    }
    const current = cache.headings?.find(
      (heading) =>
        heading.heading.toLowerCase() === subpath.slice(1).toLowerCase(),
    );
    if (!current) return null;
    const next = cache.headings?.find(
      (heading) =>
        heading.position.start.line > current.position.start.line &&
        heading.level <= current.level,
    );
    return { type: "heading", start: current.position.start, current, next };
  },
}));

function fixture() {
  const root = new TFolder();
  root.path = "/";
  root.children = [];
  const entries = new Map<string, TFile | TFolder>();
  const contents = new Map<string, string>();
  const caches = new Map<string, CachedMetadata>();
  const folder = (path: string) => {
    const parentPath = path.split("/").slice(0, -1).join("/");
    const parent = parentPath ? entries.get(parentPath) : root;
    if (!(parent instanceof TFolder)) throw new Error("Missing parent folder");
    const entry = new TFolder();
    entry.path = path;
    entry.name = path.split("/").at(-1)!;
    entry.children = [];
    entries.set(path, entry);
    parent.children.push(entry);
    return entry;
  };
  const file = (path: string, content = "") => {
    const parentPath = path.split("/").slice(0, -1).join("/");
    const parent = parentPath ? entries.get(parentPath) : root;
    if (!(parent instanceof TFolder)) throw new Error("Missing parent folder");
    const entry = new TFile();
    entry.path = path;
    entry.name = path.split("/").at(-1)!;
    entry.extension = entry.name.split(".").at(-1)!;
    entry.basename = entry.name.slice(0, -entry.extension.length - 1);
    entry.stat = { size: content.length, ctime: 0, mtime: 0 };
    entries.set(path, entry);
    contents.set(path, content);
    parent.children.push(entry);
    return entry;
  };
  const resolve = vi.fn((link: string, _source: string): TFile | null => {
    const entry = entries.get(link) ?? entries.get(`${link}.md`);
    return entry instanceof TFile ? entry : null;
  });
  const createFolder = vi.fn(async (path: string) => folder(path));
  const createBinary = vi.fn(async (path: string, data: ArrayBuffer) => {
    if (entries.has(path)) throw new Error(`File already exists: ${path}`);
    const result = file(path);
    result.stat.size = data.byteLength;
    return result;
  });
  const getAvailablePathForAttachment = vi.fn(
    async (name: string, _source?: string) => `Attachments/${name}`,
  );
  const generateMarkdownLink = vi.fn(
    (entry: TFile, source: string) =>
      `[${entry.name}](${source ? "../" : ""}${entry.path})`,
  );
  const activeFile = vi.fn<() => TFile | null>(() => null);
  const cachedRead = vi.fn(async (entry: TFile) => contents.get(entry.path)!);
  const activeView = vi.fn<() => MarkdownView | null>(() => null);
  const leaves: Array<{ view: MarkdownView }> = [];
  const app = {
    vault: {
      configDir: ".config",
      getRoot: () => root,
      getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
      getMarkdownFiles: () =>
        [...entries.values()].filter(
          (entry): entry is TFile =>
            entry instanceof TFile && entry.extension === "md",
        ),
      getFiles: () =>
        [...entries.values()].filter(
          (entry): entry is TFile => entry instanceof TFile,
        ),
      read: async (entry: TFile) => contents.get(entry.path)!,
      cachedRead,
      createFolder,
      createBinary,
    },
    metadataCache: {
      resolvedLinks: {} as Record<string, Record<string, number>>,
      unresolvedLinks: {} as Record<string, Record<string, number>>,
      getFileCache: (entry: TFile) => caches.get(entry.path) ?? null,
      getFirstLinkpathDest: resolve,
    },
    fileManager: { getAvailablePathForAttachment, generateMarkdownLink },
    workspace: {
      getActiveFile: activeFile,
      getActiveViewOfType: activeView,
      getLeavesOfType: () => leaves,
    },
  } as unknown as App;
  return {
    service: new VaultService(app),
    folder,
    file,
    caches,
    resolve,
    createFolder,
    activeFile,
    activeView,
    leaves,
    app,
    contents,
    createBinary,
    getAvailablePathForAttachment,
    generateMarkdownLink,
    cachedRead,
  };
}

describe("P0 vault tools", () => {
  it("enumerates empty folders and file types, paginates and excludes configuration", () => {
    const f = fixture();
    f.folder("Notes");
    f.folder("Notes/Empty");
    f.file("Notes/a.md");
    f.file("Notes/b.csv");
    f.folder(".config");
    f.file(".config/secret.md");
    expect(
      f.service.listEntries("", false).items.map((item) => item.path),
    ).toEqual(["Notes"]);
    const first = f.service.listEntries("Notes", true, "all", 0, 2);
    expect(first.total).toBe(3);
    expect(first.nextOffset).toBe(2);
    const all = [
      ...first.items,
      ...f.service.listEntries("Notes", true, "all", 2, 2).items,
    ];
    expect(all.map((item) => item.path).sort()).toEqual([
      "Notes/Empty",
      "Notes/a.md",
      "Notes/b.csv",
    ]);
    expect(f.service.listEntries("", true, "note").items).toHaveLength(1);
    expect(() => f.service.listEntries(".config")).toThrow("Unsafe");
    expect(() => f.service.listEntries("missing")).toThrow("Folder not found");
    expect(() => f.service.listEntries("Notes/a.md")).toThrow(
      "Folder not found",
    );
  });

  it("creates empty nested folders idempotently and rejects unsafe or cancelled operations", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await expect(f.service.createFolder("New/Empty", signal)).resolves.toBe(
      "New/Empty",
    );
    await f.service.createFolder("New/Empty", signal);
    expect(f.createFolder).toHaveBeenCalledTimes(2);
    f.file("New/file.txt");
    await expect(
      f.service.createFolder("New/file.txt/child", signal),
    ).rejects.toThrow("Not a folder");
    await expect(f.service.createFolder("../outside", signal)).rejects.toThrow(
      "Unsafe",
    );
    await expect(f.service.createFolder(".config", signal)).rejects.toThrow(
      "Unsafe",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.service.createFolder("Cancelled", controller.signal),
    ).rejects.toThrow("cancelled");
    expect(f.createFolder).toHaveBeenCalledTimes(2);
  });

  it("reads text files and Markdown ranges without pretending binary files are text", async () => {
    const f = fixture();
    f.file("note.md", "first\nsecond\nlast");
    f.file("data.csv", "A,B\n1,2");
    f.file("image.png", "binary");
    f.file("bad.txt", "a\0b");
    expect(
      (await f.service.readTextFile("note.md", 3, 2, 2, 0, true)).nextOffset,
    ).toBe(3);
    expect(
      (await f.service.readTextFile("note.md", 3, 2, 2, 3, true)).content,
    ).toBe("ond");
    expect((await f.service.readTextFile("data.csv", 100)).content).toBe(
      "A,B\n1,2",
    );
    await expect(f.service.readTextFile("image.png", 100)).rejects.toThrow(
      "supported text",
    );
    await expect(f.service.readTextFile("bad.txt", 100)).rejects.toThrow(
      "Binary",
    );
    await expect(
      f.service.readTextFile("data.csv", 100, 1, null, 0, true),
    ).rejects.toThrow("Markdown");
  });

  it("finds the current note and editor even when chat has focus", () => {
    const f = fixture();
    const file = f.file("note.md");
    f.activeFile.mockReturnValue(file);
    const view = Object.assign(new MarkdownView({} as WorkspaceLeaf), {
      file,
      getMode: () => "source",
      editor: {
        getSelection: () => "selected",
        getCursor: (which?: string) => ({
          line: which === "to" ? 2 : 1,
          ch: 3,
        }),
      },
    });
    f.leaves.push({ view });
    expect(f.service.getActiveNote().path).toBe("note.md");
    expect(f.service.getEditorContext(4)).toMatchObject({
      path: "note.md",
      selection: "sele",
      truncated: true,
      cursor: { line: 1, ch: 3 },
      positionBase: 0,
    });
    f.leaves.length = 0;
    expect(() => f.service.getEditorContext(4)).toThrow(
      "No active Markdown editor",
    );
    f.activeFile.mockReturnValue(null);
    expect(() => f.service.getActiveNote()).toThrow("No active Markdown note");
  });

  it("resolves note names, aliases, same-note headings and blocks to inclusive line ranges", async () => {
    const f = fixture();
    f.file("note.md", "# Intro\ntext\n## Child\nchild\n# End\nlast");
    f.caches.set("note.md", {
      frontmatter: { aliases: ["Alias"] },
      headings: [
        {
          heading: "Intro",
          level: 1,
          position: { start: { line: 0 }, end: { line: 0 } },
        },
        {
          heading: "Child",
          level: 2,
          position: { start: { line: 2 }, end: { line: 2 } },
        },
        {
          heading: "End",
          level: 1,
          position: { start: { line: 4 }, end: { line: 4 } },
        },
      ],
      blocks: {
        block: {
          id: "block",
          position: { start: { line: 1 }, end: { line: 1 } },
        },
      },
    } as unknown as CachedMetadata);
    expect(
      await f.service.resolveWikilink("[[note#Intro|title]]"),
    ).toMatchObject({ path: "note.md", startLine: 1, endLine: 4 });
    expect(await f.service.resolveWikilink("Alias")).toMatchObject({
      path: "note.md",
    });
    expect(await f.service.resolveWikilink("#Child", "note.md")).toMatchObject({
      startLine: 3,
      endLine: 4,
    });
    expect(await f.service.resolveWikilink("note#^block")).toMatchObject({
      startLine: 2,
      endLine: 2,
    });
    await expect(f.service.resolveWikilink("note#Missing")).rejects.toThrow(
      "Heading not found",
    );
    await expect(f.service.resolveWikilink("note#^missing")).rejects.toThrow(
      "Block not found",
    );
    await expect(
      f.service.resolveWikilink("https://example.com"),
    ).rejects.toThrow("local note");
  });

  it("passes relative links to Obsidian and rejects protected targets and ambiguous aliases", async () => {
    const f = fixture();
    f.folder("Folder");
    const source = f.file("Folder/source.md");
    const target = f.file("target.md");
    f.resolve.mockReturnValueOnce(target);
    expect(
      (await f.service.resolveWikilink("../target", source.path)).path,
    ).toBe(target.path);
    expect(f.resolve).toHaveBeenCalledWith("../target", source.path);
    f.folder(".config");
    const secret = f.file(".config/secret.md");
    f.resolve.mockReturnValueOnce(secret);
    await expect(f.service.resolveWikilink("secret")).rejects.toThrow("Unsafe");
    f.caches.set(source.path, { frontmatter: { aliases: ["Same"] } });
    f.caches.set(target.path, { frontmatter: { aliases: ["Same"] } });
    await expect(f.service.resolveWikilink("Same")).rejects.toThrow(
      "Ambiguous",
    );
  });
});

const searchDefaults: NoteSearchOptions = {
  query: "",
  regex: false,
  caseSensitive: false,
  folder: "",
  tags: [],
  properties: [],
  createdAfter: null,
  createdBefore: null,
  modifiedAfter: null,
  modifiedBefore: null,
  offset: 0,
  limit: 100,
};

describe("local knowledge, filtered search and attachment imports", () => {
  it("paginates backlinks, resolved targets and unresolved references, excluding config paths", () => {
    const f = fixture();
    f.file("a.md");
    f.file("b.md");
    f.file("c.md");
    f.app.metadataCache.resolvedLinks = {
      "b.md": { "a.md": 2, ".config/hidden.md": 4 },
      "c.md": { "a.md": 1 },
      ".config/hidden.md": { "a.md": 3 },
    };
    f.app.metadataCache.unresolvedLinks = {
      "b.md": { missing: 2 },
      "c.md": { other: 1 },
      ".config/hidden.md": { hidden: 3 },
    };
    expect(f.service.getBacklinks("a.md", 0, 1)).toMatchObject({
      total: 2,
      nextOffset: 1,
      items: [{ path: "b.md", count: 2 }],
    });
    expect(f.service.getBacklinks("a.md", 1, 1).items).toEqual([
      { path: "c.md", count: 1 },
    ]);
    expect(f.service.getOutgoingLinks("b.md").items).toEqual([
      { path: "a.md", count: 2 },
    ]);
    expect(f.service.getUnresolvedLinks(null).total).toBe(2);
    expect(f.service.getUnresolvedLinks("b.md").items).toEqual([
      { sourcePath: "b.md", link: "missing", count: 2 },
    ]);
    expect(() => f.service.getBacklinks(".config/hidden.md")).toThrow("Unsafe");
    expect(() => f.service.getOutgoingLinks("missing.md")).toThrow("not found");
  });

  it("combines inline/frontmatter tags, counts distinct notes and signals missing metadata", () => {
    const f = fixture();
    f.file("a.md");
    f.file("b.md");
    f.file("uncached.md");
    f.folder(".config");
    f.file(".config/hidden.md");
    f.caches.set("a.md", {
      tags: [
        {
          tag: "#work",
          position: {
            start: { line: 0, col: 0, offset: 0 },
            end: { line: 0, col: 5, offset: 5 },
          },
        },
        {
          tag: "#work",
          position: {
            start: { line: 1, col: 0, offset: 6 },
            end: { line: 1, col: 5, offset: 11 },
          },
        },
      ],
      frontmatter: { tags: ["work", "work/project"] },
    });
    f.caches.set("b.md", { frontmatter: { tags: ["work"] } });
    f.caches.set(".config/hidden.md", { frontmatter: { tags: ["hidden"] } });
    expect(f.service.getTagIndex("work")).toMatchObject({
      items: [
        { tag: "#work", noteCount: 2 },
        { tag: "#work/project", noteCount: 1 },
      ],
      uncachedNoteCount: 1,
    });
    expect(f.service.getNoteMetadata("a.md").tags).toEqual([
      "#work",
      "#work/project",
    ]);
    expect(() => f.service.getNoteOutline("uncached.md")).toThrow(
      "not been indexed",
    );
    f.caches.set("b.md", {
      headings: [
        {
          heading: "Title",
          level: 2,
          position: { start: { line: 3 }, end: { line: 3 } },
        },
      ],
    } as CachedMetadata);
    expect(f.service.getNoteOutline("b.md").items).toEqual([
      { heading: "Title", level: 2, line: 4 },
    ]);
  });

  it("AND-combines metadata, exact folder boundary, time and regex, returning one-based excerpts", async () => {
    const f = fixture();
    f.folder("Notes");
    f.folder("NotesOther");
    for (const path of ["Notes/a.md", "Notes/b.md", "NotesOther/c.md"]) {
      const file = f.file(path, "intro\nITEM 42\nend");
      file.stat.ctime = Date.UTC(2026, 9, 7);
      file.stat.mtime = Date.UTC(2026, 9, 8);
      f.caches.set(path, {
        frontmatter: {
          tags: ["work/project", "important"],
          status: "ready",
          score: 4,
        },
      });
    }
    f.caches.set("Notes/b.md", {
      frontmatter: { tags: ["work"], status: "draft" },
    });
    const options: NoteSearchOptions = {
      ...searchDefaults,
      query: "^item \\d+$",
      regex: true,
      folder: "Notes",
      tags: ["work", "#important"],
      properties: [
        { key: "status", operator: "equals", value: "ready" },
        { key: "score", operator: "gte", value: 4 },
      ],
      createdAfter: "2026-10-07",
      createdBefore: "2026-10-07",
      modifiedAfter: "2026-10-08",
      modifiedBefore: "2026-10-08",
    };
    const result = await f.service.searchNotesAdvanced(
      options,
      new AbortController().signal,
    );
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      path: "Notes/a.md",
      line: 2,
      excerpt: "intro\nITEM 42\nend",
    });
    expect(
      (
        await f.service.searchNotesAdvanced(
          { ...options, caseSensitive: true },
          new AbortController().signal,
        )
      ).total,
    ).toBe(0);
  });

  it("searches beyond attachment truncation limits and paginates path-only/filter-only matches", async () => {
    const f = fixture();
    f.file("a.md", "x".repeat(40_000) + "\nneedle");
    f.file("needle.md", "unrelated");
    f.folder(".config");
    f.file(".config/needle.md", "needle");
    const signal = new AbortController().signal;
    const first = await f.service.searchNotesAdvanced(
      { ...searchDefaults, query: "needle", limit: 1 },
      signal,
    );
    expect(first).toMatchObject({
      total: 2,
      nextOffset: 1,
      uncachedNoteCount: 2,
    });
    expect(first.items[0]).toMatchObject({ path: "a.md", line: 2 });
    const second = await f.service.searchNotesAdvanced(
      { ...searchDefaults, query: "needle", offset: 1, limit: 1 },
      signal,
    );
    expect(second.items[0]).toMatchObject({ path: "needle.md", line: null });
    expect(second.nextOffset).toBeNull();
    expect(
      (await f.service.searchNotesAdvanced(searchDefaults, signal)).total,
    ).toBe(2);
  });

  it("rejects invalid dates, reversed bounds, invalid regex and cancelled searches", async () => {
    const f = fixture();
    f.file("a.md", "content");
    const signal = new AbortController().signal;
    for (const extra of [
      { createdAfter: "bad" },
      { createdAfter: "2026-10-08", createdBefore: "2026-10-07" },
      { modifiedAfter: "2026-10-08", modifiedBefore: "2026-10-07" },
      { query: "(a)\\1", regex: true },
    ]) {
      await expect(
        f.service.searchNotesAdvanced({ ...searchDefaults, ...extra }, signal),
      ).rejects.toThrow();
    }
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.service.searchNotesAdvanced(searchDefaults, controller.signal),
    ).rejects.toThrow("cancelled");
    const secondController = new AbortController();
    f.cachedRead.mockImplementationOnce(async () => {
      secondController.abort();
      return "content";
    });
    await expect(
      f.service.searchNotesAdvanced(searchDefaults, secondController.signal),
    ).rejects.toThrow("cancelled");
  });

  it("yields between batches so a user can cancel a cached large-vault search", async () => {
    const f = fixture();
    for (let i = 0; i < 40; i++) f.file(`note-${i}.md`, "content");
    const controller = new AbortController();
    const timer = vi.fn((callback: () => void) => {
      controller.abort();
      callback();
      return 1;
    });
    vi.stubGlobal("window", { setTimeout: timer });
    try {
      await expect(
        f.service.searchNotesAdvanced(searchDefaults, controller.signal),
      ).rejects.toThrow("cancelled");
      expect(timer).toHaveBeenCalledOnce();
      expect(f.cachedRead).toHaveBeenCalledTimes(19);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("imports binary files with Obsidian destinations and generated links without editing notes", async () => {
    const f = fixture();
    f.folder("Notes");
    f.file("Notes/current.md", "original");
    const data = new Uint8Array([0, 255, 13]).buffer;
    const imported = await f.service.importAttachment(
      "picture.png",
      data,
      "",
      "Notes/current.md",
    );
    expect(imported.file.path).toBe("Attachments/picture.png");
    expect(f.getAvailablePathForAttachment).toHaveBeenCalledWith(
      "picture.png",
      "Notes/current.md",
    );
    expect(f.createBinary).toHaveBeenCalledWith(
      "Attachments/picture.png",
      data,
    );
    expect(imported.link).toBe("[picture.png](../Attachments/picture.png)");
    expect(
      f.service.generateAttachmentLink(
        imported.file.path,
        "Notes/current.md",
        true,
      ).link,
    ).toBe("![picture.png](../Attachments/picture.png)");
    expect(f.contents.get("Notes/current.md")).toBe("original");
    await expect(
      f.service.importAttachment("picture.png", data),
    ).rejects.toThrow("already exists");
  });

  it("uses custom folders and non-overwriting suffixes for names including spaces and multiple dots", async () => {
    const f = fixture();
    const data = new ArrayBuffer(0);
    const first = await f.service.importAttachment(
      "my.report.csv",
      data,
      "Imported/Files",
    );
    const second = await f.service.importAttachment(
      "my.report.csv",
      data,
      "Imported/Files",
    );
    expect(first.file.path).toBe("Imported/Files/my.report.csv");
    expect(second.file.path).toBe("Imported/Files/my.report (1).csv");
    expect(f.getAvailablePathForAttachment).not.toHaveBeenCalled();
    f.folder(".config");
    f.file(".config/secret.txt");
    expect(f.service.listAttachableFiles().map((file) => file.path)).toEqual([
      first.file.path,
      second.file.path,
    ]);
    expect(() =>
      f.service.generateAttachmentLink(".config/secret.txt"),
    ).toThrow("Unsafe");
  });

  it("does not create image attachments after cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.service.importAttachment(
        "image.png",
        new ArrayBuffer(0),
        "",
        "",
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(f.createBinary).not.toHaveBeenCalled();
    const after = new AbortController();
    f.getAvailablePathForAttachment.mockImplementationOnce(async () => {
      after.abort();
      return "image.png";
    });
    await expect(
      f.service.importAttachment(
        "image.png",
        new ArrayBuffer(0),
        "",
        "",
        after.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(f.createBinary).not.toHaveBeenCalled();
  });
  it("rejects unsafe names, oversized files, protected destinations and file/folder collisions", async () => {
    const f = fixture();
    for (const name of [
      "../a.png",
      "C:\\a.png",
      ".",
      "con.txt",
      "name.",
      "bad\0.txt",
    ]) {
      await expect(
        f.service.importAttachment(name, new ArrayBuffer(0)),
      ).rejects.toThrow("filename");
    }
    await expect(
      f.service.importAttachment(
        "a.bin",
        new ArrayBuffer(25 * 1024 * 1024 + 1),
      ),
    ).rejects.toThrow("25 MB");
    await expect(
      f.service.importAttachment("a.txt", new ArrayBuffer(0), ".config"),
    ).rejects.toThrow("Unsafe");
    f.getAvailablePathForAttachment.mockResolvedValueOnce(".config/a.txt");
    await expect(
      f.service.importAttachment("a.txt", new ArrayBuffer(0)),
    ).rejects.toThrow("Unsafe");
    f.file("collision");
    await expect(
      f.service.importAttachment("a.txt", new ArrayBuffer(0), "collision/sub"),
    ).rejects.toThrow("Not a folder");
    expect(f.createBinary).not.toHaveBeenCalled();
  });
});
