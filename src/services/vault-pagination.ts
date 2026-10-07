export function pageItems<T>(items: T[], offset = 0, limit = 100) {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative integer.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("limit must be an integer between 1 and 200.");
  }
  const page = items.slice(offset, offset + limit);
  return {
    items: page,
    total: items.length,
    offset,
    nextOffset:
      offset + page.length < items.length ? offset + page.length : null,
  };
}

export function textRange(
  text: string,
  startLine = 1,
  endLine: number | null = null,
  offset = 0,
  maxCharacters = 30_000,
) {
  const lines = text.split("\n");
  const lastLine = endLine ?? lines.length;
  if (
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    startLine > lines.length
  ) {
    throw new Error("startLine is outside the file.");
  }
  if (
    !Number.isInteger(lastLine) ||
    lastLine < startLine ||
    lastLine > lines.length
  ) {
    throw new Error("endLine is outside the requested range.");
  }
  const range = lines.slice(startLine - 1, lastLine).join("\n");
  if (!Number.isInteger(offset) || offset < 0 || offset > range.length) {
    throw new Error("offset is outside the selected text.");
  }
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error("maxCharacters must be a positive integer.");
  }
  const content = range.slice(offset, offset + maxCharacters);
  const truncated = offset + content.length < range.length;
  return {
    content,
    startLine,
    endLine: lastLine,
    totalLines: lines.length,
    totalCharacters: range.length,
    offset,
    nextOffset: truncated ? offset + content.length : null,
    truncated,
  };
}
