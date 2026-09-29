import { describe, expect, it } from "vitest";
import { normalizeDeployments } from "./deployment-settings";

describe("deployment settings", () => {
  it("migrates the current deployment into the deployment list", () => {
    expect(normalizeDeployments(undefined, undefined, "o4-mini")).toEqual([
      {
        id: "o4-mini",
        displayName: "o4-mini",
        deploymentName: "o4-mini",
      },
    ]);
  });

  it("preserves profiles and deduplicates legacy names", () => {
    expect(
      normalizeDeployments(
        [
          {
            id: "reasoning",
            displayName: "Reasoning",
            deploymentName: "o4-mini",
          },
        ],
        ["o4-mini", "gpt-4.1"],
        "o4-mini",
      ),
    ).toEqual([
      {
        id: "reasoning",
        displayName: "Reasoning",
        deploymentName: "o4-mini",
      },
      {
        id: "gpt-4-1",
        displayName: "gpt-4.1",
        deploymentName: "gpt-4.1",
      },
    ]);
  });
});
