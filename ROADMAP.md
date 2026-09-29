# Notalith Roadmap

This roadmap covers safe Markdown creation and editing through model tools. The guiding rule is that a model may propose a change, but Notalith must not modify the Vault until the user has reviewed and approved the exact operation.

## Goals

- Add `create_note`, `append_note`, `replace_note`, and `apply_patch`.
- Show the target path and exact content change before every write.
- Require explicit user approval for every write operation.
- Detect external edits before applying a proposal.
- Provide backup and undo capabilities.
- Keep the implementation based on public, platform-neutral Obsidian APIs.

## Non-goals

- Automatically approve model-generated writes.
- Allow unrestricted filesystem paths.
- Modify `.obsidian/` configuration.
- Execute shell commands or local programs.
- Edit binary files through Markdown tools.
- Silently overwrite a file changed after the preview was generated.

## Target workflow

```text
Model requests write tool
    → Validate Vault path and arguments
    → Read current content and revision
    → Build proposed result
    → Generate diff preview
    → Wait for user approval
    → Revalidate current revision
    → Create backup
    → Apply through Obsidian Vault API
    → Return result to model
    → Offer undo
```

Rejecting or cancelling a proposal returns a structured tool result to the model without modifying the Vault.

## Tool contracts

### `create_note`

Creates a new Markdown note.

```ts
interface CreateNoteInput {
  path: string;
  content: string;
  createFolders: boolean;
}
```

Rules:

- The path must be Vault-relative and end in `.md`.
- Existing files must never be overwritten.
- Missing parent folders are created only when `createFolders` is `true`.
- The preview displays the complete initial content.

### `append_note`

Appends Markdown to an existing note.

```ts
interface AppendNoteInput {
  path: string;
  content: string;
  ensureBlankLine: boolean;
}
```

Rules:

- The target must be an existing Markdown file.
- The diff preview shows the insertion at the end of the note.
- `ensureBlankLine` normalizes the separator without rewriting unrelated text.

### `replace_note`

Replaces the complete contents of an existing Markdown note.

```ts
interface ReplaceNoteInput {
  path: string;
  content: string;
}
```

Rules:

- This is a destructive operation and receives a stronger warning.
- The complete before/after diff must be available before approval.
- A backup is mandatory.
- Large replacements show both a summary and an expandable full diff.

### `apply_patch`

Applies one or more exact text edits to an existing Markdown note.

```ts
interface ApplyPatchInput {
  path: string;
  edits: Array<{
    oldText: string;
    newText: string;
  }>;
}
```

Rules:

- Each `oldText` must match exactly once.
- Missing or ambiguous matches reject the entire operation.
- Multiple edits are validated before any content is changed.
- Edits are applied atomically to the in-memory document.
- The resulting content is committed only after approval and conflict checks.

## Phase 1: Write-domain foundation

Build pure functions under `src/services/` for:

- Markdown path validation.
- Proposed-content generation.
- Exact-match patch application.
- Line-based diff generation.
- Revision fingerprints.
- Write-result and error types.

Revision fingerprints should include:

- Vault-relative path.
- File modification time.
- File size.
- A content hash.

### Acceptance criteria

- Traversal, absolute paths, `.obsidian/`, non-Markdown targets, and empty paths are rejected.
- Patch application is deterministic and atomic.
- Ambiguous patches return an explicit error.
- Unit tests cover Unicode, frontmatter, CRLF/LF, empty files, and large notes.

## Phase 2: Approval pipeline

Add a single write-permission pipeline to the local agent runtime.

The runtime should:

1. Pause the active tool call.
2. Emit a pending write proposal to the Chat View.
3. Wait for approve, reject, or cancel.
4. Continue the Responses API tool loop with a structured result.

Only one proposal should be active at a time. Additional model write calls remain queued in order.

### Approval UI

The approval card shows:

- Tool name.
- Target Vault path.
- Created, modified, and deleted line counts.
- Unified before/after diff.
- Warning level.
- **Approve**, **Reject**, and **Cancel response** actions.

Implementation constraints:

- Use Obsidian element helpers; do not use `innerHTML`.
- Keep styles in `styles.css`.
- Make approval actions usable with keyboard and touch.
- Never treat closing the view as approval.

### Acceptance criteria

- No write occurs before explicit approval.
- Rejecting a proposal leaves the file byte-for-byte unchanged.
- Cancelling generation rejects any unresolved proposal.
- Closing or unloading the view safely rejects pending writes.

## Phase 3: Create and append

Implement the lower-risk tools first:

- `create_note`
- `append_note`

Use public Obsidian APIs:

- `Vault.createFolder()` for approved parent-folder creation.
- `Vault.create()` for new notes.
- `Vault.process()` for conflict-aware append operations.

### Acceptance criteria

- A model can propose and create a new Markdown note after approval.
- Existing paths produce an error instead of overwriting.
- Append preserves existing frontmatter and content.
- Changes appear immediately in Obsidian and metadata updates normally.
- Behavior is verified on desktop and mobile test environments.

## Phase 4: Replace and patch

Implement:

- `replace_note`
- `apply_patch`

Prefer `Vault.process()` so the latest file content is read immediately before commit. Recompute the proposal inside the process callback and reject when the approved revision no longer matches.

### Conflict behavior

If the file changes after preview:

1. Do not write.
2. Mark the proposal as conflicted.
3. Return the conflict to the model.
4. Offer to regenerate a proposal from the latest content.

Never silently rebase or force the old proposal.

### Acceptance criteria

- Approved replacements and patches produce exactly the previewed result.
- A concurrent editor change blocks the write.
- Multi-edit patches are all-or-nothing.
- Replacement and patch failures preserve the original file.

## Phase 5: Backup and undo

Before modifying an existing note, write a versioned backup to a configurable Vault folder:

```text
Notalith Backups/<original-path>/<timestamp>.md
```

Backup behavior:

- Enabled by default for `replace_note` and `apply_patch`.
- Optional for `append_note`.
- Not required for a newly created note.
- Store original path, timestamp, tool name, and revision in frontmatter.
- Use a configurable retention count and remove only expired Notalith backups.

After a successful write, show an **Undo** action. Undo is another reviewed write operation:

1. Read the backup.
2. Verify the current post-write revision.
3. Preview the restoration diff.
4. Require confirmation.
5. Restore through `Vault.process()`.

### Acceptance criteria

- Every destructive write has a readable backup.
- Undo restores the exact previous content.
- Undo refuses to overwrite later user edits.
- Retention cleanup never touches files outside the configured backup folder.

## Phase 6: History and recovery

Add a write history panel showing:

- Timestamp.
- Tool and target path.
- Approval decision.
- Before and after revisions.
- Backup path.
- Undo status.

Persist only metadata required for recovery. Do not store API keys, full chat prompts, or duplicate note content in plugin settings.

### Acceptance criteria

- Users can identify every model-initiated write.
- Failed and rejected proposals are distinguishable from successful writes.
- Missing backup files are reported explicitly.

## Phase 7: Hardening

Test:

- Desktop, iOS, and Android.
- OneDrive/iCloud/Obsidian Sync conflicts.
- Very large Markdown files.
- Rapid streaming tool calls.
- Multiple open Obsidian views.
- Plugin reload with pending approval.
- Renames and deletions between preview and approval.
- Frontmatter, wikilinks, embeds, callouts, tables, code fences, and Unicode.

Security checks:

- Treat note content and tool output as untrusted.
- Never infer approval from model text.
- Never expose a generic filesystem write tool.
- Never return success-shaped results after a failed write.
- Log write failures without logging complete private note content.

## Delivery order

| Milestone | Scope                                             | Dependency |
| --------- | ------------------------------------------------- | ---------- |
| M1        | Pure proposal, patch, diff, and revision services | None       |
| M2        | Permission state and approval card                | M1         |
| M3        | `create_note` and `append_note`                   | M1, M2     |
| M4        | `replace_note` and `apply_patch`                  | M1, M2     |
| M5        | Backup and confirmed undo                         | M3, M4     |
| M6        | Write history and recovery UI                     | M5         |
| M7        | Desktop/mobile and sync hardening                 | M3–M6      |

## Initial release gate

Markdown editing is ready for release only when:

1. Every write requires explicit approval.
2. The applied content exactly matches the approved preview.
3. Concurrent changes are detected before commit.
4. Destructive writes have recoverable backups.
5. Reject, cancel, failure, and plugin reload cannot modify a note.
6. Unit tests and real Obsidian integration tests cover all four write tools.
