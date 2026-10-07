import type { ToolDefinition } from "../types";

const DIRECTORY_PARAMETERS = {
  folder: {
    type: ["string", "null"],
    description: "Vault-relative folder; null or empty means the vault root.",
  },
  kind: {
    type: ["string", "null"],
    enum: ["all", "folder", "note", "image", "office", null],
  },
  offset: {
    type: ["integer", "null"],
    minimum: 0,
    description: "Use nextOffset from the preceding page; null starts at zero.",
  },
  limit: { type: ["integer", "null"], minimum: 1, maximum: 200 },
};

const TEXT_RANGE_PARAMETERS = {
  path: { type: "string", description: "Exact vault-relative file path." },
  startLine: {
    type: ["integer", "null"],
    minimum: 1,
    description: "One-based starting line; null means 1.",
  },
  endLine: {
    type: ["integer", "null"],
    minimum: 1,
    description: "Inclusive one-based ending line; null means end of file.",
  },
  offset: {
    type: ["integer", "null"],
    minimum: 0,
    description:
      "Character offset within the selected line range. Follow nextOffset without changing the line range to read all text.",
  },
};

const PAGE_PARAMETERS = {
  offset: { type: ["integer", "null"], minimum: 0 },
  limit: { type: ["integer", "null"], minimum: 1, maximum: 200 },
};
const NOTE_PAGE_PARAMETERS = { path: { type: "string" }, ...PAGE_PARAMETERS };

function localTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
): ToolDefinition {
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
    strict: true,
  };
}

export const READ_ONLY_TOOLS: ToolDefinition[] = [
  localTool(
    "get_backlinks",
    "List indexed incoming links to a note with per-source reference counts and pagination.",
    NOTE_PAGE_PARAMETERS,
  ),
  localTool(
    "get_outgoing_links",
    "List indexed resolved outgoing links and embeds with per-target counts. Use get_unresolved_links for missing targets.",
    NOTE_PAGE_PARAMETERS,
  ),
  localTool(
    "get_unresolved_links",
    "List indexed broken/missing note links. Null path searches the whole vault; count is occurrences per source/link.",
    { path: { type: ["string", "null"] }, ...PAGE_PARAMETERS },
  ),
  localTool(
    "list_tags",
    "List inline and frontmatter tags with distinct-note counts. Prefix optionally filters tags.",
    { prefix: { type: ["string", "null"] }, ...PAGE_PARAMETERS },
  ),
  localTool(
    "get_note_outline",
    "List headings, levels and one-based line numbers from the note's metadata cache.",
    NOTE_PAGE_PARAMETERS,
  ),
  localTool(
    "get_attachment_link",
    "Generate an Obsidian Markdown link to an existing vault file, respecting the user's link settings. Does not edit a note.",
    {
      path: { type: "string" },
      sourcePath: {
        type: ["string", "null"],
        description:
          "Existing Markdown note where the link will be used; null for vault-root context.",
      },
      embed: {
        type: ["boolean", "null"],
        description: "True to generate an embed; null means a normal link.",
      },
    },
  ),
  localTool(
    "search_notes",
    "Search full Markdown content and paths locally with AND-combined tag/property/date/folder filters and pagination. Regex uses RE2 multiline syntax (no backreferences/lookarounds). Empty query lists filter matches; times are inclusive filesystem creation/modification timestamps.",
    {
      query: { type: ["string", "null"], maxLength: 1000 },
      regex: { type: ["boolean", "null"] },
      caseSensitive: { type: ["boolean", "null"] },
      folder: { type: ["string", "null"] },
      tags: {
        type: ["array", "null"],
        items: { type: "string" },
        description:
          "All tags must match; # is optional and parent tags include subtags.",
      },
      properties: {
        type: ["array", "null"],
        description:
          "All frontmatter filters must match. Dot-separated nested keys; comparisons are type-sensitive; contains means array membership or substring; gt/gte/lt/lte require numbers.",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            operator: {
              type: "string",
              enum: [
                "exists",
                "equals",
                "not_equals",
                "contains",
                "gt",
                "gte",
                "lt",
                "lte",
              ],
            },
            value: {
              type: ["string", "number", "boolean", "null"],
              description:
                "Null for exists; equals null checks an explicit null property.",
            },
          },
          required: ["key", "operator", "value"],
          additionalProperties: false,
        },
      },
      createdAfter: {
        type: ["string", "null"],
        description:
          "YYYY-MM-DD (UTC midnight) or ISO timestamp with timezone, inclusive.",
      },
      createdBefore: { type: ["string", "null"] },
      modifiedAfter: { type: ["string", "null"] },
      modifiedBefore: { type: ["string", "null"] },
      ...PAGE_PARAMETERS,
    },
  ),
  localTool(
    "list_directory",
    "List immediate files and folders with deterministic pagination. Use kind=folder for folders or kind=note for Markdown.",
    DIRECTORY_PARAMETERS,
  ),
  localTool(
    "get_directory_tree",
    "Recursively list the directory tree as ordered paths and kinds, including empty folders. Follow nextOffset for all entries.",
    DIRECTORY_PARAMETERS,
  ),
  localTool(
    "read_note_range",
    "Read selected lines of Markdown, including long notes without losing text. Follow nextOffset for the rest of the same range.",
    TEXT_RANGE_PARAMETERS,
  ),
  localTool(
    "read_text_file",
    "Read TXT, JSON, CSV, TSV, YAML, XML and other supported plain text files by line range and character page.",
    TEXT_RANGE_PARAMETERS,
  ),
  localTool(
    "get_active_note",
    "Get metadata for the current Markdown note even when the chat pane has focus. Errors if there is no active note.",
    {},
  ),
  localTool(
    "get_editor_selection",
    "Get the current Markdown editor selection, selection bounds and cursor. Editor positions use zero-based line/ch. Errors if no editor is available.",
    {},
  ),
  localTool(
    "get_cursor_position",
    "Get the cursor position in the current Markdown editor, with zero-based line/ch.",
    {},
  ),
  localTool(
    "resolve_wikilink",
    "Resolve a note name, alias or relative wikilink with an optional heading or block ID. Returns the actual path and one-based line range for read_note_range.",
    {
      link: {
        type: "string",
        description:
          "For example [[Note]], Alias, ../Note#Heading, [[Note#^block-id]], or #Heading.",
      },
      sourcePath: {
        type: ["string", "null"],
        description:
          "Existing Markdown source path for relative or same-note links; null when not applicable.",
      },
    },
  ),
  {
    type: "function",
    name: "read_note",
    description:
      "Read a Markdown note from the current Obsidian vault by its vault-relative path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative note path." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "search_vault",
    description:
      "Search Markdown note paths and contents in the current Obsidian vault.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 50,
          description: "Maximum results, or null to use the default.",
        },
      },
      required: ["query", "limit"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "list_notes",
    description: "List Markdown notes under an optional vault folder.",
    parameters: {
      type: "object",
      properties: {
        folder: {
          type: ["string", "null"],
          description: "Vault folder path, or null to list the whole vault.",
        },
        limit: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 200,
          description: "Maximum results, or null to use the default.",
        },
      },
      required: ["folder", "limit"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "list_files",
    description:
      "List files in the current Obsidian vault. Use kind=image to locate images before calling read_image.",
    parameters: {
      type: "object",
      properties: {
        folder: {
          type: ["string", "null"],
          description: "Vault folder path, or null to list the whole vault.",
        },
        kind: {
          type: ["string", "null"],
          enum: ["image", "office", "all", null],
          description:
            "Restrict results to images or Office documents, or list all files.",
        },
        limit: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 200,
          description: "Maximum results, or null to use the default.",
        },
      },
      required: ["folder", "kind", "limit"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "read_document",
    description:
      "Extract text and tables from a DOCX, PPTX, or XLSX file in the current Obsidian vault.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Exact vault-relative DOCX, PPTX, or XLSX path, including its extension.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "read_image",
    description:
      "Read an image from the current Obsidian vault and provide it to the vision-capable model.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Exact vault-relative image path, including its extension.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_note_metadata",
    description:
      "Get frontmatter, headings, tags, links, embeds, and file metadata for a vault note.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative note path." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export const MARKDOWN_WRITE_TOOLS: ToolDefinition[] = [
  localTool(
    "create_folder",
    "Create an empty vault folder and missing parents. Existing folders are a no-op; a file at the requested path is an error.",
    {
      path: {
        type: "string",
        description:
          "Vault-relative folder path. No absolute paths or traversal.",
      },
    },
  ),
  {
    type: "function",
    name: "create_note",
    description:
      "Create a new Markdown note in the vault. Never overwrite an existing file. Parent folders are created if needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative .md path." },
        content: {
          type: "string",
          description: "Initial Markdown content; may be empty.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "append_note",
    description:
      "Append non-empty Markdown content to an existing .md note, separating it from existing content with a blank line. Never replace existing content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative .md path." },
        content: {
          type: "string",
          description: "Non-empty Markdown content to append.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "replace_note_text",
    description:
      "Replace an exact, non-empty text fragment in an existing .md note. The old text must occur exactly once in the latest note content; otherwise nothing changes. No whole-note replacement.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative .md path." },
        oldText: {
          type: "string",
          description:
            "Exact original text, including whitespace and line breaks.",
        },
        newText: {
          type: "string",
          description: "Replacement text; may be empty to remove the fragment.",
        },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
    strict: true,
  },
];
