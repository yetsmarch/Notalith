import { describe, expect, it, vi } from "vitest";
import { TFile, TFolder, type App } from "obsidian";
import { VaultService } from "./vault-service";

vi.mock("obsidian", () => ({
  TFile: class {},
  TFolder: class {},
  MarkdownView: class {},
}));

function mockVault(initial: Record<string, string> = {}) {
  const files = new Map<string, TFile | TFolder>();
  const contents = new Map<string, string>();
  for (const [path, content] of Object.entries(initial)) {
    const file = new TFile();
    file.path = path;
    files.set(path, file);
    contents.set(path, content);
  }
  const createFolder = vi.fn(async (path: string) => {
    if (files.has(path)) throw new Error(`Folder already exists: ${path}`);
    const folder = new TFolder();
    folder.path = path;
    files.set(path, folder);
  });
  const create = vi.fn(async (path: string, content: string) => {
    if (files.has(path)) throw new Error(`File already exists: ${path}`);
    const file = new TFile();
    file.path = path;
    files.set(path, file);
    contents.set(path, content);
    return file;
  });
  const process = vi.fn(
    async (file: TFile, update: (current: string) => string) => {
      const next = update(contents.get(file.path)!);
      contents.set(file.path, next);
      return next;
    },
  );
  const app = {
    vault: {
      configDir: ".config",
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      createFolder,
      create,
      process,
    },
  } as unknown as App;
  return {
    service: new VaultService(app),
    files,
    contents,
    createFolder,
    create,
    process,
  };
}

describe("Markdown writes", () => {
  it("creates a blank note in new parent folders without overwriting an existing note", async () => {
    const vault = mockVault();
    const signal = new AbortController().signal;
    await expect(
      vault.service.createMarkdownNote("A/B/new.md", "", signal),
    ).resolves.toBe("A/B/new.md");
    expect(vault.createFolder.mock.calls.map(([path]) => path)).toEqual([
      "A",
      "A/B",
    ]);
    expect(vault.contents.get("A/B/new.md")).toBe("");
    await expect(
      vault.service.createMarkdownNote("A/B/new.md", "replace", signal),
    ).rejects.toThrow("already exists");
    expect(vault.contents.get("A/B/new.md")).toBe("");
  });

  it("rejects protected paths, non-Markdown paths, and a file in a parent path", async () => {
    const vault = mockVault({ A: "file" });
    const signal = new AbortController().signal;
    for (const path of [
      "../new.md",
      ".config/config.md",
      "note.txt",
      "A/new.md",
    ]) {
      await expect(
        vault.service.createMarkdownNote(path, "x", signal),
      ).rejects.toThrow();
    }
    expect(vault.create).not.toHaveBeenCalled();
  });

  it("does not start a cancelled creation, including in an existing folder", async () => {
    const vault = mockVault();
    const controller = new AbortController();
    controller.abort();
    await expect(
      vault.service.createMarkdownNote("A/new.md", "x", controller.signal),
    ).rejects.toThrow("cancelled");
    expect(vault.createFolder).not.toHaveBeenCalled();
    expect(vault.create).not.toHaveBeenCalled();
  });

  it("appends to the latest content and preserves the note's newline style", async () => {
    const vault = mockVault({ "note.md": "old\r\n" });
    const signal = new AbortController().signal;
    vault.contents.set("note.md", "new\r\n");
    await vault.service.appendMarkdownNote("note.md", "more", signal);
    expect(vault.contents.get("note.md")).toBe("new\r\n\r\nmore");
    await vault.service.appendMarkdownNote("note.md", "again", signal);
    expect(vault.contents.get("note.md")).toBe("new\r\n\r\nmore\r\n\r\nagain");
  });

  it("rejects empty additions, invalid paths, and aborts inside process without writing", async () => {
    const vault = mockVault({ "note.md": "old" });
    const signal = new AbortController().signal;
    await expect(
      vault.service.appendMarkdownNote("note.md", "", signal),
    ).rejects.toThrow("empty");
    await expect(
      vault.service.appendMarkdownNote("note.txt", "x", signal),
    ).rejects.toThrow("Markdown");
    await expect(
      vault.service.appendMarkdownNote("../note.md", "x", signal),
    ).rejects.toThrow("Unsafe");
    await expect(
      vault.service.appendMarkdownNote("missing.md", "x", signal),
    ).rejects.toThrow("not found");
    const controller = new AbortController();
    controller.abort();
    await expect(
      vault.service.appendMarkdownNote("note.md", "x", controller.signal),
    ).rejects.toThrow("cancelled");
    expect(vault.contents.get("note.md")).toBe("old");
  });

  it("replaces exactly one match in the latest content and permits deletion", async () => {
    const vault = mockVault({ "note.md": "obsolete" });
    vault.contents.set("note.md", "before old after");
    await vault.service.replaceMarkdownText(
      "note.md",
      "old",
      "new",
      new AbortController().signal,
    );
    expect(vault.contents.get("note.md")).toBe("before new after");
    await vault.service.replaceMarkdownText(
      "note.md",
      "new",
      "",
      new AbortController().signal,
    );
    expect(vault.contents.get("note.md")).toBe("before  after");
  });

  it("rejects missing, repeated, and unchanged text without writing", async () => {
    const vault = mockVault({ "note.md": "one one" });
    const signal = new AbortController().signal;
    await expect(
      vault.service.replaceMarkdownText("note.md", "missing", "new", signal),
    ).rejects.toThrow("not found");
    await expect(
      vault.service.replaceMarkdownText("note.md", "one", "new", signal),
    ).rejects.toThrow("more than once");
    await expect(
      vault.service.replaceMarkdownText("note.md", "", "new", signal),
    ).rejects.toThrow("empty");
    await expect(
      vault.service.replaceMarkdownText("note.md", "one", "one", signal),
    ).rejects.toThrow("must change");
    expect(vault.contents.get("note.md")).toBe("one one");
  });

  it("rechecks the current content when the editor changes it before processing", async () => {
    const vault = mockVault({ "note.md": "old" });
    vault.process.mockImplementationOnce(
      async (file: TFile, update: (current: string) => string) => {
        vault.contents.set(file.path, "edited externally");
        const next = update(vault.contents.get(file.path)!);
        vault.contents.set(file.path, next);
        return next;
      },
    );
    await expect(
      vault.service.replaceMarkdownText(
        "note.md",
        "old",
        "new",
        new AbortController().signal,
      ),
    ).rejects.toThrow("not found");
    expect(vault.contents.get("note.md")).toBe("edited externally");
  });
});
