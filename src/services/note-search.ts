import { RE2JS } from "re2js";

export type PropertyOperator =
  "exists" | "equals" | "not_equals" | "contains" | "gt" | "gte" | "lt" | "lte";
export interface PropertyFilter {
  key: string;
  operator: PropertyOperator;
  value: string | number | boolean | null;
}

export interface NoteSearchOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  folder: string;
  tags: string[];
  properties: PropertyFilter[];
  createdAfter: string | null;
  createdBefore: string | null;
  modifiedAfter: string | null;
  modifiedBefore: string | null;
  offset: number;
  limit: number;
}

export function searchMatcher(
  query: string,
  regex: boolean,
  caseSensitive: boolean,
) {
  if (query.length > 1000)
    throw new Error("Search expression exceeds 1000 characters.");
  const expression = regex
    ? query
    : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let pattern: RE2JS;
  try {
    pattern = RE2JS.compile(
      expression,
      RE2JS.MULTILINE | (caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE),
    );
  } catch (error) {
    throw new Error(
      `Invalid or unsupported RE2 expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return (text: string): number => {
    const matcher = pattern.matcher(text);
    return matcher.find() ? matcher.start() : -1;
  };
}

export function dateBound(value: string | null): number | null {
  if (value === null) return null;
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      value,
    )
  ) {
    throw new Error(
      "Dates must be YYYY-MM-DD or ISO timestamps with a timezone.",
    );
  }
  const timestamp = Date.parse(value);
  const calendarDate = value.slice(0, 10);
  const calendarTimestamp = Date.parse(`${calendarDate}T00:00:00Z`);
  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(calendarTimestamp) ||
    new Date(calendarTimestamp).toISOString().slice(0, 10) !== calendarDate ||
    /T24:/.test(value)
  ) {
    throw new Error(`Invalid date: ${value}`);
  }
  return timestamp;
}

export function matchesTags(tags: string[], required: string[]): boolean {
  return required.every((tag) => {
    const normalized = tag.startsWith("#") ? tag : `#${tag}`;
    return tags.some(
      (actual) => actual === normalized || actual.startsWith(`${normalized}/`),
    );
  });
}

export function matchesProperty(
  frontmatter: Record<string, unknown> | undefined,
  filter: PropertyFilter,
): boolean {
  let actual: unknown = frontmatter;
  for (const part of filter.key.split(".")) {
    if (!actual || typeof actual !== "object" || !Object.hasOwn(actual, part)) {
      actual = undefined;
      break;
    }
    actual = (actual as Record<string, unknown>)[part];
  }
  switch (filter.operator) {
    case "exists":
      return actual !== undefined;
    case "equals":
      return actual === filter.value;
    case "not_equals":
      return actual !== undefined && actual !== filter.value;
    case "contains":
      return Array.isArray(actual)
        ? actual.includes(filter.value)
        : typeof actual === "string" &&
            typeof filter.value === "string" &&
            actual.includes(filter.value);
    case "gt":
      return (
        typeof actual === "number" &&
        typeof filter.value === "number" &&
        actual > filter.value
      );
    case "gte":
      return (
        typeof actual === "number" &&
        typeof filter.value === "number" &&
        actual >= filter.value
      );
    case "lt":
      return (
        typeof actual === "number" &&
        typeof filter.value === "number" &&
        actual < filter.value
      );
    case "lte":
      return (
        typeof actual === "number" &&
        typeof filter.value === "number" &&
        actual <= filter.value
      );
  }
}
