# Notalith Markdown Editing Roadmap

Notalith currently exposes three basic Markdown write tools to the model. They use public Obsidian Vault APIs and run without a separate approval step. The chat displays tool activity, but the user should keep backups of important notes: there is no built-in undo or write history yet.

## Implemented

| Tool                | Required arguments           | Behavior                                                                                             |
| ------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `create_note`       | `path`, `content`            | Create a new `.md` note, creating missing parent folders; fail if it exists. `content` may be empty. |
| `append_note`       | `path`, `content`            | Append non-empty content to an existing `.md` note, separated by a blank line.                       |
| `replace_note_text` | `path`, `oldText`, `newText` | Replace one exact occurrence in an existing `.md` note; `newText` may be empty.                      |

All paths must be Vault-relative and end in `.md`; absolute paths, traversal, empty path segments, and the Obsidian configuration directory are rejected. Append and replace run within `Vault.process()` so the latest file content is used, without overwriting intervening changes. Exact replacement fails without writing if the old text is missing, occurs more than once, or is identical to the new text. A model tool failure is visible in chat and returned to the model as an error, not as a successful edit.

Stopping a request prevents later tool calls; it **cannot roll back a write already completed**. Creating a note may create parent folders before a later failure or cancellation. These tools do not offer whole-note replacement, move, rename, deletion, binary edits, or writes outside the Vault.

## Remaining work

- Test writing in a real isolated Obsidian Vault on desktop and mobile, including sync conflicts and active editor changes; unit tests alone do not prove those integrations.
- Consider recoverable backups, undo, and write history before adding more powerful editing operations.
- Explore scoped frontmatter and editor-selection edits after defining their exact conflict and recovery behavior.
- Keep unrestricted file writes, whole-note overwrite, delete, move, and binary edits out of the basic model tool set.

## Release checks for basic editing

1. Verify new notes cannot replace existing files and only safe `.md` paths can be written.
2. Verify append and exact replacement use current content and reject ambiguous or missing matches without changes.
3. Verify write failures are visible and a stopped request cannot run later tools; document that completed writes remain.
4. Run automated checks and perform isolated desktop/mobile Vault tests before claiming either platform is verified.
