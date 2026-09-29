import { describe, expect, it } from "vitest";
import { isOfficeExtension } from "./office-document-service";

describe("Office document formats", () => {
  it("supports modern Open XML formats", () => {
    expect(isOfficeExtension("docx")).toBe(true);
    expect(isOfficeExtension("PPTX")).toBe(true);
    expect(isOfficeExtension("xlsx")).toBe(true);
  });

  it("does not claim legacy binary or PDF support", () => {
    expect(isOfficeExtension("doc")).toBe(false);
    expect(isOfficeExtension("ppt")).toBe(false);
    expect(isOfficeExtension("xls")).toBe(false);
    expect(isOfficeExtension("pdf")).toBe(false);
  });
});
