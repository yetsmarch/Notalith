import { strFromU8, unzipSync } from "fflate";

export type OfficeFormat = "docx" | "pptx" | "xlsx";

export interface OfficeDocumentContent {
  path: string;
  format: OfficeFormat;
  content: string;
  truncated: boolean;
}

const OFFICE_EXTENSIONS = new Set<OfficeFormat>(["docx", "pptx", "xlsx"]);

export function isOfficeExtension(
  extension: string,
): extension is OfficeFormat {
  return OFFICE_EXTENSIONS.has(extension.toLocaleLowerCase() as OfficeFormat);
}

export function extractOfficeDocument(
  path: string,
  extension: string,
  data: ArrayBuffer,
  maxCharacters: number,
): OfficeDocumentContent {
  const format = extension.toLocaleLowerCase();
  if (!isOfficeExtension(format)) {
    throw new Error(`Unsupported Office format: ${extension}`);
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(data));
  } catch {
    throw new Error(
      `Unable to open ${path}. The file may be invalid, encrypted, or password protected.`,
    );
  }

  const content =
    format === "docx"
      ? extractDocx(entries)
      : format === "pptx"
        ? extractPptx(entries)
        : extractXlsx(entries);
  return {
    path,
    format,
    content: content.slice(0, maxCharacters),
    truncated: content.length > maxCharacters,
  };
}

function extractDocx(entries: Record<string, Uint8Array>): string {
  const document = parseEntry(entries, "word/document.xml");
  const body = firstByLocalName(document, "body");
  if (!body) throw new Error("DOCX document body is missing.");

  const blocks: string[] = [];
  for (const child of Array.from(body.children)) {
    if (child.localName === "p") {
      const text = textFrom(child);
      if (text) blocks.push(text);
    } else if (child.localName === "tbl") {
      const rows = descendants(child, "tr")
        .map((row) =>
          descendants(row, "tc")
            .map((cell) => textFrom(cell))
            .join("\t"),
        )
        .filter(Boolean);
      if (rows.length) blocks.push(rows.join("\n"));
    }
  }
  return blocks.join("\n\n");
}

function extractPptx(entries: Record<string, Uint8Array>): string {
  const slidePaths = Object.keys(entries)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (slidePaths.length === 0) {
    throw new Error("PPTX contains no readable slides.");
  }

  return slidePaths
    .map((path, index) => {
      const slide = parseEntry(entries, path);
      const lines = descendants(slide.documentElement, "p")
        .map((paragraph) => textFrom(paragraph))
        .filter(Boolean);
      return `## Slide ${index + 1}\n\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

function extractXlsx(entries: Record<string, Uint8Array>): string {
  const workbook = parseEntry(entries, "xl/workbook.xml");
  const relationships = parseEntry(entries, "xl/_rels/workbook.xml.rels");
  const relationshipTargets = new Map<string, string>();
  for (const relationship of descendants(
    relationships.documentElement,
    "Relationship",
  )) {
    const id = relationship.getAttribute("Id");
    const target = relationship.getAttribute("Target");
    if (id && target) relationshipTargets.set(id, resolveXlPath(target));
  }

  const sharedStrings = entries["xl/sharedStrings.xml"]
    ? descendants(
        parseEntry(entries, "xl/sharedStrings.xml").documentElement,
        "si",
      ).map((item) => textFrom(item))
    : [];

  const sheets: string[] = [];
  for (const sheet of descendants(workbook.documentElement, "sheet")) {
    const name = sheet.getAttribute("name") ?? "Sheet";
    const relationId =
      sheet.getAttribute("r:id") ??
      sheet.getAttributeNS(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "id",
      );
    const target = relationId ? relationshipTargets.get(relationId) : undefined;
    if (!target || !entries[target]) continue;

    const worksheet = parseEntry(entries, target);
    const rows = descendants(worksheet.documentElement, "row").map((row) => {
      const values: string[] = [];
      for (const cell of descendants(row, "c")) {
        const reference = cell.getAttribute("r") ?? "";
        const index = columnIndex(reference);
        while (values.length <= index) values.push("");
        values[index] = cellValue(cell, sharedStrings);
      }
      while (values.at(-1) === "") values.pop();
      return values.map(tsvValue).join("\t");
    });
    sheets.push(`## Sheet: ${name}\n\n${rows.join("\n")}`);
  }
  if (sheets.length === 0) {
    throw new Error("XLSX contains no readable worksheets.");
  }
  return sheets.join("\n\n");
}

function cellValue(cell: Element, sharedStrings: string[]): string {
  const type = cell.getAttribute("t");
  if (type === "inlineStr") return textFrom(cell);
  const value = firstByLocalName(cell, "v")?.textContent ?? "";
  if (type === "s") return sharedStrings[Number(value)] ?? value;
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  const formula = firstByLocalName(cell, "f")?.textContent;
  return formula ? `=${formula}${value ? ` (${value})` : ""}` : value;
}

function parseEntry(
  entries: Record<string, Uint8Array>,
  path: string,
): Document {
  const entry = entries[path];
  if (!entry) throw new Error(`Office package entry is missing: ${path}`);
  const document = new DOMParser().parseFromString(
    strFromU8(entry),
    "application/xml",
  );
  if (document.querySelector("parsererror")) {
    throw new Error(`Invalid Office XML: ${path}`);
  }
  return document;
}

function descendants(root: Element, localName: string): Element[] {
  return Array.from(root.getElementsByTagName("*")).filter(
    (element) => element.localName === localName,
  );
}

function firstByLocalName(
  root: Document | Element,
  localName: string,
): Element | null {
  return (
    Array.from(root.getElementsByTagName("*")).find(
      (element) => element.localName === localName,
    ) ?? null
  );
}

function textFrom(element: Element): string {
  return descendants(element, "t")
    .map((text) => text.textContent ?? "")
    .join("")
    .trim();
}

function slideNumber(path: string): number {
  return Number(path.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
}

function resolveXlPath(target: string): string {
  const normalized = target.replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized.startsWith("xl/") ? normalized : `xl/${normalized}`;
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "A";
  let index = 0;
  for (const letter of letters) {
    index = index * 26 + letter.charCodeAt(0) - 64;
  }
  return Math.max(0, index - 1);
}

function tsvValue(value: string): string {
  return value.replaceAll("\t", " ").replace(/\r?\n/g, " ");
}
