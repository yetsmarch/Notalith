import { describe, expect, it } from "vitest";
import { READ_ONLY_TOOLS } from "./tool-definitions";

describe("strict tool definitions", () => {
  it("requires every declared property", () => {
    for (const tool of READ_ONLY_TOOLS) {
      const properties = tool.parameters.properties as Record<string, unknown>;
      const required = tool.parameters.required as string[];

      expect(required.sort()).toEqual(Object.keys(properties).sort());
      expect(tool.parameters.additionalProperties).toBe(false);
    }
  });
});
