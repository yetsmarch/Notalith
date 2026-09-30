import type { ToolDefinition } from "../types";

export const READ_ONLY_TOOLS: ToolDefinition[] = [
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
