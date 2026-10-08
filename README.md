# Notalith

Notalith is a platform-neutral Obsidian assistant powered by your own model-provider account. It provides a chat interface with tools to read Vault content and create or edit Markdown notes.

The plugin uses public Obsidian APIs and does not require Node.js, a local CLI, ACP, Electron APIs, or a locally spawned agent process at runtime.

Notalith is free and open source under the [Apache 2.0 license](LICENSE). It has no paid features or Notalith account requirement.

## Features

- Azure Foundry Responses, Chat Completions and Claude Messages, native Claude Messages and Gemini generateContent, and Chat Completions for DeepSeek, OpenAI, Grok, and OpenRouter.
- Multiple model profiles across providers, with a separate endpoint and API key for each provider.
- Streaming assistant responses and cancellable requests.
- Vault read tools and basic Markdown write tools with visible execution status.
- Local backlinks, outgoing and unresolved links, combined inline/frontmatter tag counts, and note outlines.
- Full Markdown/path search with tag, frontmatter, filesystem-time and folder filters, plus safe regular expressions and pagination.
- Import images and files from the device into the Vault using Obsidian's attachment location or a configured folder, without overwriting existing files.
- Current-note, editor-selection, note, image, and Office attachments.
- Vision input from Vault images and images embedded in Markdown notes when the selected model supports it.
- Local DOCX, PPTX, and XLSX text/table extraction.
- Obsidian `SecretStorage` for provider API keys.
- Optional image-generation tool shared by all chat providers, with independent Azure/OpenAI image configuration, Vault saving and previews.
- Desktop and mobile-compatible architecture based on public Obsidian APIs.

Model, message, and attachment IDs use native `crypto.randomUUID()` where
available, with a `crypto.getRandomValues()` UUID fallback for mobile WebViews.
Failures to add or save a model are reported in a notice rather than silently
leaving the button unresponsive.

## Supported content

| Content              | Support                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Markdown             | Read, search, list, inspect metadata, create, append, and replace unique text                                     |
| PNG, JPEG, WebP, GIF | Attach manually to a supported model; Azure and image-enabled Claude models can also read an image through a tool |
| DOCX                 | Extract paragraphs and tables locally                                                                             |
| PPTX                 | Extract text by slide locally                                                                                     |
| XLSX                 | Extract worksheets, cells, shared strings, and formula results locally                                            |
| Plain text           | Attach or read MD, TXT, JSON, CSV, TSV, YAML, XML, HTML, CSS, JS, TS, LOG, INI, TOML                              |
| Other files          | Import and generate links; unsupported formats are references only, not extracted                                 |
| PDF                  | Import and link only; no content extraction                                                                       |
| DOC, PPT, XLS        | Import and link only; no legacy binary content extraction                                                         |

Office files are parsed locally. Notalith sends extracted text and table data to the active provider rather than uploading the original Office file. Chat Completions and native Gemini do not accept the plugin's structured image tool result, so `read_image` is not exposed to those adapters. Manual and embedded-note images can be sent to vision-capable Azure deployments, `deepseek-flash`, and models with **Image input** enabled under Claude, OpenAI, Grok, Gemini, or OpenRouter.

## Read-only tools

| Tool                   | Purpose                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| `read_note`            | Read a Markdown note by Vault-relative path                                      |
| `search_vault`         | Search Markdown paths and contents                                               |
| `list_notes`           | List Markdown notes under an optional folder                                     |
| `list_files`           | List images, Office documents, or all Vault files                                |
| `read_image`           | Send a Vault image to a provider that supports image tool results                |
| `read_document`        | Extract text and tables from DOCX, PPTX, or XLSX                                 |
| `get_note_metadata`    | Read frontmatter, headings, tags, links, and embeds                              |
| `list_directory`       | Paginate immediate files/folders, filtered by folder, note, image or Office kind |
| `get_directory_tree`   | Paginate recursive directory paths, including empty folders                      |
| `read_note_range`      | Read Markdown by inclusive line range and character continuation                 |
| `read_text_file`       | Read plain text, JSON, CSV, TSV, YAML, XML and other supported text files        |
| `get_active_note`      | Query the current Markdown note, including when chat has focus                   |
| `get_editor_selection` | Query selection text, bounds and cursor in the current Markdown editor           |
| `get_cursor_position`  | Query zero-based editor cursor coordinates                                       |
| `resolve_wikilink`     | Resolve note names, aliases, relative links, headings and block IDs              |
| `get_backlinks`        | Paginate incoming note references with occurrence counts                         |
| `get_outgoing_links`   | Paginate resolved outgoing links and embeds with occurrence counts               |
| `get_unresolved_links` | Paginate missing link targets for one note or the whole Vault                    |
| `list_tags`            | Paginate inline/frontmatter tags, counting distinct notes                        |
| `get_note_outline`     | Paginate heading text, levels and one-based line numbers                         |
| `search_notes`         | Filtered full Markdown/path search with safe RE2 expressions                     |
| `get_attachment_link`  | Generate a Markdown link or embed using Obsidian's link settings                 |

Directory tools return ordered `items`, `total`, `offset`, and `nextOffset`;
follow `nextOffset` until it is `null`. `list_directory` lists immediate children,
while `get_directory_tree` recursively returns a flat tree representation with
Vault-relative paths and entry kinds. Existing `list_files` and `list_notes`
retain their original non-paginated behavior.

Range tools use one-based inclusive `startLine`/`endLine`. Their `offset` and
`nextOffset` are character offsets within the same selected range; repeat with
unchanged line bounds to read all content, including unusually long lines.
Null bounds select the whole file. Editor coordinates are instead zero-based
`line`/`ch`. Missing notes, unavailable editors, invalid ranges, and unresolved
anchors return explicit errors.

### Knowledge relationships and enhanced search

Relationship tools use Obsidian's local metadata/link cache, so results reflect
its latest indexing state. `get_outgoing_links` returns resolved targets;
`get_unresolved_links` returns missing targets. Reference counts include repeated
links and embeds. Tags combine frontmatter and inline occurrences, deduplicated
within each note. An unindexed outline returns an explicit error; tag/search
results include `uncachedNoteCount` to identify potentially incomplete metadata.

`search_notes` scans full Markdown content and paths, without an embedding API
or a separate search index. Its filters are AND-combined: all requested tags
(optional `#`, parent tags include subtags), all frontmatter conditions, a folder
including descendants, and inclusive file creation/modification time bounds.
An empty/null query returns filter matches. Frontmatter keys support dotted
nesting; scalar equality is type-sensitive, `contains` checks an array member or
substring, and `gt`/`gte`/`lt`/`lte` compare numbers. `exists` accepts a null value.
Results are path-sorted, paginated, and include an excerpt and the one-based first
content-match line (null for filter-only/path-only matches).

Dates are `YYYY-MM-DD` (UTC midnight) or ISO timestamps with a timezone.
For an entire day, specify the end timestamp rather than that day's midnight.
With `regex=true`, queries use RE2 multiline syntax; matching defaults to
case-insensitive. Patterns are limited to 1,000 characters. Backreferences and
lookarounds are unsupported and reported as errors. The browser-compatible
RE2JS engine avoids catastrophic backtracking without Node.js or WebAssembly.
The original `search_vault` remains available with its original keyword behavior.

All tool paths are validated as Vault-relative paths. Absolute paths, path traversal, and access to the Vault's Obsidian configuration directory are rejected.

## Markdown write tools

| Tool                | Purpose                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `create_note`       | Create a `.md` note (and missing parent folders); never overwrite a file        |
| `append_note`       | Append non-empty content to an existing `.md` note, with a blank-line separator |
| `replace_note_text` | Replace text that occurs exactly once in an existing `.md` note                 |
| `create_folder`     | Create an empty folder and missing parents; existing folders are a no-op        |

The model can invoke these tools without a separate approval prompt. Replacement checks the latest file content using Obsidian's atomic `Vault.process()`; missing or repeated old text fails without changing the note. There is no whole-note overwrite, deletion, move, or binary-write tool. A stopped request prevents further tools but **does not undo writes already completed**. Review important notes or keep Vault backups before asking the model to edit them.

## Requirements

- Obsidian 1.11.4 or newer.
- An API account for Azure Foundry, Anthropic (Claude), OpenAI, xAI (Grok), Google (Gemini), DeepSeek, or OpenRouter.
- At least one configured model with function calling for the plugin's Vault tools. Image requests additionally require a model with image input.
- The appropriate endpoint, model or deployment name, and provider API key.

You provide your own account and API key. Notalith does not charge you, but your model provider may; check its pricing and usage limits before sending requests. The plugin connects directly to your configured endpoint, without a Notalith-operated intermediary.

| Provider           | API used               | Default endpoint                                                             |
| ------------------ | ---------------------- | ---------------------------------------------------------------------------- |
| Azure Foundry      | Per-deployment protocol | Enter your own `https://<resource-name>.openai.azure.com/openai/v1` endpoint |
| DeepSeek           | Chat Completions       | `https://api.deepseek.com`                                                   |
| Claude (Anthropic) | Messages               | `https://api.anthropic.com/v1`                                               |
| OpenAI             | Chat Completions       | `https://api.openai.com/v1`                                                  |
| Grok (xAI)         | Chat Completions       | `https://api.x.ai/v1`                                                        |
| Gemini (Google)    | Native generateContent | `https://generativelanguage.googleapis.com/v1beta`                           |
| OpenRouter         | Chat Completions       | `https://openrouter.ai/api/v1`                                               |

For Azure, the **deployment name**, not the underlying model family name, is sent as the selected API's `model` value. For every other provider, enter an exact model ID available to your account. OpenRouter IDs generally include a provider prefix such as `openai/gpt-4.1-mini`. The example IDs shown in settings are placeholders, not a model catalog.

### Azure Foundry protocols

Choose **API protocol** for each Azure deployment: **OpenAI Responses** (the
unchanged default for existing profiles), **OpenAI Chat Completions**, or
**Claude Messages**. Deployment aliases never determine the protocol, and errors
do not trigger automatic protocol switching. Changing protocol or endpoint starts
a new conversation.

For Claude, a standard Azure resource endpoint is mapped to
`https://<resource-name>.services.ai.azure.com/anthropic/v1`; requests use
`x-api-key` and `anthropic-version: 2023-06-01`. Custom gateways require an
explicit **Endpoint override**. Overrides are API base URLs without the final
`/messages`, `/responses` or `/chat/completions` route, and use the Azure
connection's saved key. OpenAI protocols use `/openai/v1` base URLs.
Enable **Image input** only for vision-capable Chat Completions or Claude
deployments. Chat Completions does not support image tool results.

Claude thinking and redacted-thinking blocks are retained with their signatures
for subsequent turns and tool results, but are not shown as assistant text.
The implementation follows the [official Claude on Foundry API examples](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-claude)
without a runtime SDK dependency.

#### Model router

Add your router's exact deployment name (for example `model-router`), select
**OpenAI Chat Completions**, and set **Endpoint override** to
`https://<resource-name>.services.ai.azure.com/openai/v1`. This uses the v1
Chat Completions API without an `api-version` parameter and reuses the Azure
connection's saved key. The router's selected underlying model can change between
requests; the plugin continues to send the router deployment name and the full
conversation/tool history, not the selected model's name.

For the tested resource, the `openai.azure.com/openai/v1` endpoint returned
deployment-not-found for the router, while the `services.ai.azure.com` v1
Chat Completions endpoint succeeded. The resource-level v1 Responses endpoint
reported that the operation was unsupported. Support through Foundry project
Responses endpoints is a separate API surface. The plugin does not silently
switch endpoints or protocols. Routing modes and candidate model pools remain
configured in Foundry, not in the plugin.

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

1. Choose a provider from the **Provider** dropdown. This only changes which settings are visible; it **does not** switch the active chat provider.
2. Enter your Azure OpenAI v1 endpoint, or keep the selected provider's default endpoint. Save its API key with **Save key**.
3. Select **Add model** and enter a display name and exact Azure deployment name or provider model ID. Several models can share a provider's endpoint and key.
4. For Claude, OpenAI, Grok, Gemini, or OpenRouter, turn on **Image input** only if that particular model supports images. Azure can send images to compatible deployments, and DeepSeek image input is limited to `deepseek-flash`.
5. Optionally select **Test** on the model. This sends a small live request to your provider, which may incur usage charges; it does not change the active model.
6. In the chat view, click **Provider · model** beside the send button. The menu groups models by provider; selecting a model switches to its provider and starts a new conversation. The model's **Use model** button in settings does the same.

Only profiles with a non-empty model ID appear in the chat menu; a saved key is still required to send a message. The settings dropdown's **(active)** marker shows which provider the current chat model uses. Azure response IDs and other providers' in-memory conversation histories are never reused across model switches. Existing Azure endpoints, deployments, active model selections, and saved keys migrate automatically.

API keys are stored in Obsidian `SecretStorage`; they are not written to plugin `data.json`, notes, or chat content. Provider reasoning metadata and Gemini thought signatures needed to continue tool calls are held only in memory, never shown in chat, and cleared with the conversation.

## Usage

### Image generation tool

Under **Settings → Notalith → Image generation**, select an Azure Foundry or
OpenAI connection and enter the image deployment/model ID (for example,
`gpt-image-2`). Image configuration is separate from the chat model menu and
reuses the selected connection's saved key. Enable **Image generation** to
expose `generate_image` to the current chat provider. Disabled or incomplete
configuration does not advertise the tool. An enabled/configured status is not
a connectivity guarantee.

Azure uses the deployment-specific Images API with the configurable
`2025-04-01-preview` version by default. A standard `/openai/v1` connection base
URL is accepted and converted to the deployment route; a custom image endpoint
override should be the Azure resource base URL. OpenAI uses its API base URL
and `/images/generations`. The implementation follows the
[official Azure image-generation examples](https://learn.microsoft.com/azure/foundry/openai/how-to/dall-e).

The first version supports text-to-image, one PNG per request, three preset sizes
and low/medium/high quality. Choose parameters supported by your deployment;
editing, masks and batch generation are not implemented. The **Test** button
generates and discards one low-quality test image and can incur charges.
No image request is made just by configuring or enabling the tool.

Ask any function-calling chat model to generate an image. The plugin saves it
using the existing attachment folder/location rules and non-overwriting names,
then returns only the saved path and embed link to the chat model, not Base64
image data. The chat displays an image card independently of the model's text.
Use **Copy embed link** or **Insert into note**; insertion explicitly selects a
Markdown note and appends an embed. Generation itself never changes a note.
If explicitly requested, the chat agent can insert the returned embed using
the existing Markdown write tools.

Generation requests are not automatically retried. After an image failure,
further generation attempts in that chat turn are blocked to avoid accidental
duplicate billing. If generation succeeds but saving fails, the image is kept
in memory with **Retry save** and **Discard** actions in chat and settings.
Retrying save does not call the image API again. Save or discard the pending
image before another generation; reloading or unloading the plugin loses an
unsaved image. Cancellation stops subsequent saves/edits where possible, but
Obsidian's non-streaming request cannot cancel a server-side billed generation,
and already saved images or completed note edits are not undone.

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

```text
Create notes/meeting.md with today's meeting outline.
```

```text
Append a follow-up section to notes/meeting.md, then replace the exact text "Action: TBD" with "Action: review the draft".
```

Use the toolbar to attach:

- The current Markdown note.
- The current editor selection.
- A Vault note, image, DOCX, PPTX, or XLSX file.
- A supported plain-text file, or a reference to another Vault file.

### Import files from your device

Click **Import files into vault** (upload icon) to open the device's file picker;
select one or more images or files. Files are saved locally before being attached
to the composer. The size limit is **25 MB per imported file**. Images sent to
the model still have a **10 MB** limit. Unsupported formats, including PDFs and
legacy Office, can be stored and linked but their contents are not extracted or
sent to the model.

**Imported attachment folder** in settings overrides the destination with a
Vault-relative folder. Leave it empty to follow Obsidian's attachment setting
relative to the current Markdown note. Missing folders are created and duplicate
filenames receive an available name; existing files are never overwritten.
Invalid/protected paths and import failures are reported explicitly.

Use the link icon on an attachment chip to copy a link for the current note.
Models can also call `get_attachment_link`. Links use Obsidian's configured
Markdown/wikilink format. Importing or generating a link does **not** insert it
into a note, and removing a chip does **not** delete the imported file.
Import alone does not send file contents to a provider; sending the chat does.
Downloading attachments from URLs is not implemented.

## Privacy and security

- Vault content is read only when explicitly attached or requested through a model tool call.
- Tool activity, including write successes and failures, is shown in the chat UI; writes do not require approval.
- Notes and extracted Office content used in a request are sent to the selected provider endpoint.
- Images used in a request are Base64-encoded and sent only to a supported model on the selected provider.
- Office documents are limited to 25 MB.
- Images are limited to 10 MB.
- Attached notes and extracted documents are truncated according to the configured maximum character count.
- Imported plain-text attachments share that character limit; models can continue reading with `read_text_file`.
- Knowledge/search processing is local, but tool results and attached content used in a chat are sent to the chosen provider.
- No embeddings are generated and there is no automatic Vault upload.
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
npm run lint
npm run format:check
```

When Obsidian CLI is enabled:

```powershell
obsidian plugin:reload id=notalith
obsidian dev:errors
obsidian dev:console level=error
```

## Community release

Before submitting to the [Obsidian Community directory](https://docs.obsidian.md/plugins/releasing/submit-plugin):

1. Verify the plugin with configured models in Obsidian on desktop and mobile, and run the production validation commands above.
2. Keep `package.json`, `manifest.json`, and `versions.json` aligned on the release version. Publish a GitHub release tagged with the exact `manifest.json` version (without a `v` prefix) and upload `main.js`, `manifest.json`, and `styles.css` as release assets. `main.js` is generated by `npm run build` and is not committed to Git.
3. Submit the public GitHub repository through the Obsidian Community developer dashboard, select **Optional payments** because external model providers may charge users, and address any automated review feedback.

## Current limitations

- Markdown writes are limited to creating, appending, and unique exact-text replacement; no whole-note replacement, delete, move, built-in backup, or undo.
- Chat Completions and native Gemini models cannot use `read_image` through tools. Azure and image-enabled Claude models can use it. Only `deepseek-flash` supports DeepSeek image attachments; Claude, OpenAI, Grok, Gemini, and OpenRouter require per-model image opt-in.
- No conversation persistence or session history.
- No PDF or legacy Office (`.doc`, `.ppt`, `.xls`) extraction.
- No OCR for scanned documents.
- No semantic/embedding search or URL-based attachment downloads.
- Office extraction focuses on readable text and table values; advanced formatting, charts, macros, comments, and embedded Office media are not preserved.
- Mobile compatibility is a design target and still requires device-level validation.

See [DESIGN.md](DESIGN.md) for the full product and architecture design, and
[ROADMAP.md](ROADMAP.md) for the Markdown editing status and future work.
