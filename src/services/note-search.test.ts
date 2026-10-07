import { describe, expect, it } from "vitest";
import {
  dateBound,
  matchesProperty,
  matchesTags,
  searchMatcher,
} from "./note-search";

describe("local search filters", () => {
  it("matches literal content, case-sensitive text and multiline regex", () => {
    expect(searchMatcher("a.b", false, false)("A.B")).toBe(0);
    expect(searchMatcher("a.b", false, false)("axb")).toBe(-1);
    expect(searchMatcher("a.b", false, true)("A.B")).toBe(-1);
    expect(
      searchMatcher("^item \\d+$", true, false)("intro\nITEM 42\nend"),
    ).toBe(6);
    expect(searchMatcher("计划", false, false)("测试计划")).toBe(2);
    expect(searchMatcher("needle", false, false)("İ\nneedle")).toBe(2);
    expect(searchMatcher("$[x]\\.", false, false)("prefix $[x]\\.")).toBe(7);
  });

  it("rejects invalid expressions and unsupported backreferences/lookarounds", () => {
    for (const query of ["[", "(a)\\1", "(?=a)a"]) {
      expect(() => searchMatcher(query, true, false)).toThrow("RE2");
    }
    expect(() => searchMatcher("x".repeat(1001), true, false)).toThrow("1000");
  });

  it("handles classic catastrophic-backtracking input without blocking", () => {
    const started = performance.now();
    expect(
      searchMatcher("(a+)+$", true, false)("a".repeat(100_000) + "!"),
    ).toBe(-1);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("parses inclusive UTC calendar/timestamp bounds and rejects invalid dates", () => {
    expect(dateBound(null)).toBeNull();
    expect(dateBound("2026-10-07")).toBe(Date.UTC(2026, 9, 7));
    expect(dateBound("2026-10-07T08:00:00+08:00")).toBe(Date.UTC(2026, 9, 7));
    for (const value of [
      "tomorrow",
      "2026-02-30",
      "2026-02-30T01:00:00Z",
      "2026-10-07T08:00:00",
      "2026-10-07T24:00:00Z",
    ]) {
      expect(() => dateBound(value)).toThrow();
    }
  });

  it("AND-combines tags, allowing parent tags but not partial names", () => {
    expect(
      matchesTags(["#work/project", "#important"], ["work", "#important"]),
    ).toBe(true);
    expect(matchesTags(["#workplace"], ["work"])).toBe(false);
    expect(matchesTags(["#work"], ["work", "missing"])).toBe(false);
  });

  it("matches typed scalar, nested, membership and numeric frontmatter filters", () => {
    const frontmatter = {
      status: "ready",
      labels: ["one", "two"],
      count: 4,
      nested: { enabled: false },
      empty: null,
    };
    expect(
      matchesProperty(frontmatter, {
        key: "nested.enabled",
        operator: "equals",
        value: false,
      }),
    ).toBe(true);
    expect(
      matchesProperty(frontmatter, {
        key: "count",
        operator: "equals",
        value: "4",
      }),
    ).toBe(false);
    expect(
      matchesProperty(frontmatter, {
        key: "labels",
        operator: "contains",
        value: "two",
      }),
    ).toBe(true);
    expect(
      matchesProperty(frontmatter, {
        key: "status",
        operator: "contains",
        value: "ead",
      }),
    ).toBe(true);
    expect(
      matchesProperty(frontmatter, { key: "count", operator: "gte", value: 4 }),
    ).toBe(true);
    expect(
      matchesProperty(frontmatter, { key: "count", operator: "lt", value: 4 }),
    ).toBe(false);
    expect(
      matchesProperty(frontmatter, {
        key: "empty",
        operator: "exists",
        value: null,
      }),
    ).toBe(true);
    expect(
      matchesProperty(frontmatter, {
        key: "missing",
        operator: "not_equals",
        value: "anything",
      }),
    ).toBe(false);
    expect(
      matchesProperty(frontmatter, {
        key: "toString",
        operator: "exists",
        value: null,
      }),
    ).toBe(false);
  });
});
