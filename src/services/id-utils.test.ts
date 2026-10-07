import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "./id-utils";

afterEach(() => vi.unstubAllGlobals());

describe("createId", () => {
  it("uses native randomUUID when available", () => {
    const randomUUID = vi.fn(() => "native-id");
    vi.stubGlobal("crypto", { randomUUID });
    expect(createId()).toBe("native-id");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("generates a UUID v4 when only getRandomValues is available", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(255);
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    expect(createId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("reports unavailable randomness rather than using weak IDs", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => createId()).toThrow(
      "Secure random ID generation is unavailable.",
    );
  });
});
