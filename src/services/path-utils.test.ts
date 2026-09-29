import { describe, expect, it } from "vitest";
import { imageMimeType, validateVaultPath } from "./path-utils";

describe("validateVaultPath", () => {
  it("normalizes separators", () => {
    expect(validateVaultPath("Notes\\Example.md")).toBe("Notes/Example.md");
  });

  it.each(["../secret", "Notes/../../secret", ".obsidian/config", ""])(
    "rejects unsafe path %s",
    (path) => {
      expect(() => validateVaultPath(path)).toThrow();
    },
  );
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
