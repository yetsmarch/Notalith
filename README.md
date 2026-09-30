# Notalith

Notalith is a platform-neutral Obsidian assistant powered by your own model-provider account. It provides a chat interface with tools to read Vault content and create or edit Markdown notes.

The plugin uses public Obsidian APIs and does not require Node.js, a local CLI, ACP, Electron APIs, or a locally spawned agent process at runtime.

Notalith is free and open source under the [Apache 2.0 license](LICENSE). It has no paid features or Notalith account requirement.

## Features

- Azure OpenAI Responses, Claude Messages, native Gemini generateContent, and Chat Completions for DeepSeek, OpenAI, Grok, and OpenRouter.
- Multiple model profiles across providers, with a separate endpoint and API key for each provider.
- Streaming assistant responses and cancellable requests.
- Vault read tools and basic Markdown write tools with visible execution status.
- Current-note, editor-selection, note, image, and Office attachments.
- Vision input from Vault images and images embedded in Markdown notes when the selected model supports it.
- Local DOCX, PPTX, and XLSX text/table extraction.
- Obsidian `SecretStorage` for provider API keys.
- Desktop and mobile-compatible architecture based on public Obsidian APIs.

## Supported content

| Content              | Support                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Markdown             | Read, search, list, inspect metadata, create, append, and replace unique text                                     |
| PNG, JPEG, WebP, GIF | Attach manually to a supported model; Azure and image-enabled Claude models can also read an image through a tool |
| DOCX                 | Extract paragraphs and tables locally                                                                             |
| PPTX                 | Extract text by slide locally                                                                                     |
| XLSX                 | Extract worksheets, cells, shared strings, and formula results locally                                            |
| PDF                  | Not currently supported                                                                                           |
| DOC, PPT, XLS        | Legacy binary formats are not currently supported                                                                 |

Office files are parsed locally. Notalith sends extracted text and table data to the active provider rather than uploading the original Office file. Chat Completions and native Gemini do not accept the plugin's structured image tool result, so `read_image` is not exposed to those adapters. Manual and embedded-note images can be sent to vision-capable Azure deployments, `deepseek-flash`, and models with **Image input** enabled under Claude, OpenAI, Grok, Gemini, or OpenRouter.

## Read-only tools

| Tool                | Purpose                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `read_note`         | Read a Markdown note by Vault-relative path                       |
| `search_vault`      | Search Markdown paths and contents                                |
| `list_notes`        | List Markdown notes under an optional folder                      |
| `list_files`        | List images, Office documents, or all Vault files                 |
| `read_image`        | Send a Vault image to a provider that supports image tool results |
| `read_document`     | Extract text and tables from DOCX, PPTX, or XLSX                  |
| `get_note_metadata` | Read frontmatter, headings, tags, links, and embeds               |

All tool paths are validated as Vault-relative paths. Absolute paths, path traversal, and access to the Vault's Obsidian configuration directory are rejected.

## Markdown write tools

| Tool                | Purpose                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `create_note`       | Create a `.md` note (and missing parent folders); never overwrite a file        |
| `append_note`       | Append non-empty content to an existing `.md` note, with a blank-line separator |
| `replace_note_text` | Replace text that occurs exactly once in an existing `.md` note                 |

The model can invoke these tools without a separate approval prompt. Replacement checks the latest file content using Obsidian's atomic `Vault.process()`; missing or repeated old text fails without changing the note. There is no whole-note overwrite, deletion, move, or binary-write tool. A stopped request prevents further tools but **does not undo writes already completed**. Review important notes or keep Vault backups before asking the model to edit them.

## Requirements

- Obsidian 1.11.4 or newer.
- An API account for Azure Foundry, Anthropic (Claude), OpenAI, xAI (Grok), Google (Gemini), DeepSeek, or OpenRouter.
- At least one configured model with function calling for the plugin's Vault tools. Image requests additionally require a model with image input.
- The appropriate endpoint, model or deployment name, and provider API key.

You provide your own account and API key. Notalith does not charge you, but your model provider may; check its pricing and usage limits before sending requests. The plugin connects directly to your configured endpoint, without a Notalith-operated intermediary.

| Provider           | API used               | Default endpoint                                                             |
| ------------------ | ---------------------- | ---------------------------------------------------------------------------- |
| Azure Foundry      | Azure OpenAI Responses | Enter your own `https://<resource-name>.openai.azure.com/openai/v1` endpoint |
| DeepSeek           | Chat Completions       | `https://api.deepseek.com`                                                   |
| Claude (Anthropic) | Messages               | `https://api.anthropic.com/v1`                                               |
| OpenAI             | Chat Completions       | `https://api.openai.com/v1`                                                  |
| Grok (xAI)         | Chat Completions       | `https://api.x.ai/v1`                                                        |
| Gemini (Google)    | Native generateContent | `https://generativelanguage.googleapis.com/v1beta`                           |
| OpenRouter         | Chat Completions       | `https://openrouter.ai/api/v1`                                               |

For Azure, the **deployment name**, not the underlying model family name, is sent as the Responses API `model` value. For every other provider, enter an exact model ID available to your account. OpenRouter IDs generally include a provider prefix such as `openai/gpt-4.1-mini`. The example IDs shown in settings are placeholders, not a model catalog.

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

## Privacy and security

- Vault content is read only when explicitly attached or requested through a model tool call.
- Tool activity, including write successes and failures, is shown in the chat UI; writes do not require approval.
- Notes and extracted Office content used in a request are sent to the selected provider endpoint.
- Images used in a request are Base64-encoded and sent only to a supported model on the selected provider.
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
- Office extraction focuses on readable text and table values; advanced formatting, charts, macros, comments, and embedded Office media are not preserved.
- Mobile compatibility is a design target and still requires device-level validation.

See [DESIGN.md](DESIGN.md) for the full product and architecture design, and
[ROADMAP.md](ROADMAP.md) for the Markdown editing status and future work.
