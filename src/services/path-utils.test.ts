import { describe, expect, it } from "vitest";
import {
  imageMimeType,
  validateMarkdownPath,
  validateVaultPath,
} from "./path-utils";

describe("validateVaultPath", () => {
  const configDir = ".config";

  it("normalizes separators", () => {
    expect(validateVaultPath("Notes\\Example.md", configDir)).toBe(
      "Notes/Example.md",
    );
    expect(validateVaultPath("Notes/例.md", configDir)).toBe("Notes/例.md");
  });

  it("protects a nested configuration directory without blocking sibling folders", () => {
    expect(() =>
      validateVaultPath("settings/private/config.md", "settings/private"),
    ).toThrow();
    expect(
      validateVaultPath(
        "settings/private-notes/example.md",
        "settings/private",
      ),
    ).toBe("settings/private-notes/example.md");
  });

  it.each([
    "../secret",
    "Notes/../../secret",
    ".config/settings",
    ".CONFIG/settings",
    "/Notes/example.md",
    "\\Notes\\example.md",
    "C:\\Notes\\example.md",
    "file:example.md",
    "Notes/./example.md",
    "Notes//example.md",
    "",
  ])("rejects unsafe path %s", (path) => {
    expect(() => validateVaultPath(path, configDir)).toThrow();
  });
});

describe("validateMarkdownPath", () => {
  it("normalizes a Vault-relative Markdown path", () => {
    expect(validateMarkdownPath("Notes\\New.md", ".config")).toBe(
      "Notes/New.md",
    );
  });

  it.each([
    "../notes.md",
    ".config/private.md",
    "Notes/file.txt",
    "Notes/file.MD",
  ])("rejects an unsafe or non-Markdown path %s", (path) => {
    expect(() => validateMarkdownPath(path, ".config")).toThrow();
  });
});

describe("imageMimeType", () => {
  it("maps supported image extensions", () => {
    expect(imageMimeType("JPEG")).toBe("image/jpeg");
    expect(imageMimeType("png")).toBe("image/png");
  });

  it("rejects unsupported extensions", () => {
    expect(imageMimeType("svg")).toBeNull();
  });
});
