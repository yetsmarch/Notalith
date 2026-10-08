import { describe, expect, it } from "vitest";
import {
  GENERATE_IMAGE_TOOL,
  MARKDOWN_WRITE_TOOLS,
  READ_ONLY_TOOLS,
} from "./tool-definitions";

describe("strict tool definitions", () => {
  it("requires every declared property", () => {
    for (const tool of [
      ...READ_ONLY_TOOLS,
      ...MARKDOWN_WRITE_TOOLS,
      GENERATE_IMAGE_TOOL,
    ]) {
      const properties = tool.parameters.properties as Record<string, unknown>;
      const required = tool.parameters.required as string[];

      expect(required.sort()).toEqual(Object.keys(properties).sort());
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.strict).toBe(true);
    }
  });
  it("uses strict nested frontmatter filter objects", () => {
    const search = READ_ONLY_TOOLS.find(
      (tool) => tool.name === "search_notes",
    )!;
    const properties = search.parameters.properties as Record<
      string,
      {
        items?: {
          properties: Record<string, unknown>;
          required: string[];
          additionalProperties: boolean;
        };
      }
    >;
    const filter = properties.properties.items!;
    expect([...filter.required].sort()).toEqual(
      Object.keys(filter.properties).sort(),
    );
    expect(filter.additionalProperties).toBe(false);
  });
});
