# Notalith

Notalith is a platform-neutral Obsidian assistant powered by Azure Foundry model deployments. It provides a chat interface that can use explicit, read-only tools to work with notes, images, and modern Office documents in the current vault.

The plugin uses public Obsidian APIs and does not require Node.js, a local CLI, ACP, Electron APIs, or a locally spawned agent process at runtime.

## Features

- Azure OpenAI Responses API through an Azure Foundry deployment.
- Multiple model deployments under one Azure endpoint and API key.
- Streaming assistant responses and cancellable requests.
- Read-only Vault tools with visible execution status.
- Current-note, editor-selection, note, image, and Office attachments.
- Vision input from Vault images and images embedded in Markdown notes.
- Local DOCX, PPTX, and XLSX text/table extraction.
- Obsidian `SecretStorage` for the Azure API key.
- Desktop and mobile-compatible architecture based on public Obsidian APIs.

## Supported content

| Content              | Support                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| Markdown             | Read content, search, list, and inspect metadata                       |
| PNG, JPEG, WebP, GIF | Attach manually or let the model locate and read the image             |
| DOCX                 | Extract paragraphs and tables locally                                  |
| PPTX                 | Extract text by slide locally                                          |
| XLSX                 | Extract worksheets, cells, shared strings, and formula results locally |
| PDF                  | Not currently supported                                                |
| DOC, PPT, XLS        | Legacy binary formats are not currently supported                      |

Office files are parsed locally. Notalith sends extracted text and table data to Azure rather than uploading the original Office file. Images read by `read_image` are sent to the active vision-capable deployment.

## Read-only tools

| Tool                | Purpose                                             |
| ------------------- | --------------------------------------------------- |
| `read_note`         | Read a Markdown note by Vault-relative path         |
| `search_vault`      | Search Markdown paths and contents                  |
| `list_notes`        | List Markdown notes under an optional folder        |
| `list_files`        | List images, Office documents, or all Vault files   |
| `read_image`        | Send a Vault image to a vision-capable model        |
| `read_document`     | Extract text and tables from DOCX, PPTX, or XLSX    |
| `get_note_metadata` | Read frontmatter, headings, tags, links, and embeds |

All tool paths are validated as Vault-relative paths. Absolute paths, path traversal, and access to `.obsidian/` are rejected.

## Requirements

- Obsidian 1.11.4 or newer.
- An Azure OpenAI resource exposed through the v1 Responses API.
- At least one deployed model that supports the required features:
  - Function calling for Vault tools.
  - Image input for vision requests.
- Azure endpoint, deployment name, and API key.

Example endpoint:

```text
https://<resource-name>.openai.azure.com/openai/v1
```

The deployment name, not the underlying model family name, is sent as the Responses API `model` value.

## Manual installation

Notalith is not yet distributed through the Obsidian community plugin catalog.

1. Install dependencies and build:

   ```powershell
   npm install
   npm run build
   ```

2. Create the plugin directory in your Vault:

   ```text
   <vault>\.obsidian\plugins\notalith
   ```

3. Copy these files into that directory:

   ```text
   manifest.json
   main.js
   styles.css
   ```

4. Open **Settings → Community plugins**, reload installed plugins, and enable **Notalith**.

For local development on Windows, the project directory can be linked directly:

```powershell
New-Item -ItemType Junction `
  -Path "<vault>\.obsidian\plugins\notalith" `
  -Target "<project>\notalith"
```

## Configuration

Open **Settings → Notalith**.

1. Enter the Azure OpenAI v1 endpoint.
2. Select **Add deployment** for each Azure deployment.
3. Configure a display name and the exact Azure deployment name.
4. Enter and save the API key.
5. Select **Test connection**.

All configured deployments share the same endpoint and API key. Use the model menu beside the send button to switch deployments. Switching models starts a new Responses conversation so response IDs are never reused across deployments.

The API key is stored in Obsidian `SecretStorage`; it is not written to plugin `data.json`, notes, or chat content.

## Usage

Open Notalith from the ribbon or run **Notalith: Open chat** from the command palette.

Examples:

```text
Summarize the current note.
```

```text
Search the vault for notes about Azure Foundry and cite their paths.
```

```text
Describe test/diagram.png.
```

```text
Read reports/quarterly.xlsx and summarize each worksheet.
```

Use the toolbar to attach:

- The current Markdown note.
- The current editor selection.
- A Vault note, image, DOCX, PPTX, or XLSX file.

## Privacy and security

- Vault content is read only when explicitly attached or requested through a model tool call.
- Tool activity is shown in the chat UI.
- Notes and extracted Office content used in a request are sent to the configured Azure deployment.
- Images used in a request are Base64-encoded and sent to the configured Azure deployment.
- Office documents are limited to 25 MB.
- Images are limited to 10 MB.
- Attached notes and extracted documents are truncated according to the configured maximum character count.
- Vault content is treated as untrusted data in the system prompt.

## Development

```powershell
npm install
npm run dev
```

Production validation:

```powershell
npm test
npm run build
npm run format:check
```

When Obsidian CLI is enabled:

```powershell
obsidian plugin:reload id=notalith
obsidian dev:errors
obsidian dev:console level=error
```

## Current limitations

- Read-only Vault tools; note creation and modification are not implemented.
- No conversation persistence or session history.
- No PDF or legacy Office (`.doc`, `.ppt`, `.xls`) extraction.
- No OCR for scanned documents.
- Office extraction focuses on readable text and table values; advanced formatting, charts, macros, comments, and embedded Office media are not preserved.
- Mobile compatibility is a design target and still requires device-level validation.

See [DESIGN.md](DESIGN.md) for the full product and architecture design, and
[ROADMAP.md](ROADMAP.md) for the safe Markdown editing plan.
