import { describe, expect, it } from "vitest";
import { pageItems, textRange } from "./vault-pagination";

describe("vault pagination", () => {
  it("returns deterministic pages and an explicit end", () => {
    expect(pageItems(["a", "b", "c"], 0, 2)).toEqual({
      items: ["a", "b"],
      total: 3,
      offset: 0,
      nextOffset: 2,
    });
    expect(pageItems(["a", "b", "c"], 2, 2).nextOffset).toBeNull();
    expect(pageItems([], 0, 2).items).toEqual([]);
    expect(() => pageItems([], -1)).toThrow();
    expect(() => pageItems([], 0, 201)).toThrow();
  });

  it("reads every character of long lines using continuation offsets", () => {
    const text = "标题\r\n" + "a".repeat(25) + "\r\nlast";
    let content = "";
    let offset: number | null = 0;
    while (offset !== null) {
      const page = textRange(text, 1, null, offset, 7);
      content += page.content;
      offset = page.nextOffset;
    }
    expect(content).toBe(text);
  });

  it("supports inclusive one-based ranges and rejects invalid bounds", () => {
    expect(textRange("one\ntwo\nthree", 2, 2).content).toBe("two");
    expect(textRange("").totalLines).toBe(1);
    expect(textRange("one\n").totalLines).toBe(2);
    expect(() => textRange("one", 0)).toThrow();
    expect(() => textRange("one", 1, 2)).toThrow();
    expect(() => textRange("one", 1, null, 4)).toThrow();
  });
});
