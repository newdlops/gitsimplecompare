# Blame annotations and line history

Right-click a line number and choose **Show File Blame Annotations**, or run
`Git Simple Compare: Toggle File Blame Annotations`. The default shortcut is
**Ctrl+Alt+B**, or **Cmd+Alt+B** on macOS. This also works without language
symbols or Code Vision. An explicit file annotation view is independent of the
Code Vision visibility setting.

Choose **Hide File Blame Annotations**, toggle again, or press **Escape** in the
editor to close the owned gutter. The popup consumes Escape first, and the
binding leaves completion, rename, find, snippets and multi-selection widgets
their normal Escape behavior. No global Git blame setting is changed.

Hover or focus any line to inspect the complete identity and commit information.
Compact mode keeps blank continuation rows clickable and focusable. A group's
label repeats at its first visible line when scrolling or folding hides its start.
Narrow columns use ellipsis; full information remains available in the popup.

## Display settings

All settings below have the prefix `gitSimpleCompare.blameAnnotations.` and
can be scoped to a resource or workspace. Defaults preserve the existing gutter.

| Setting | Default | Effect |
| --- | --- | --- |
| `dateFormat` | `YYYY-MM-DD` | Also supports `DD.MM.YYYY`, `MM/DD/YYYY` and `relative`. Absolute dates use UTC; relative dates use the VS Code display language. |
| `authorName` | `full` | `first` and `last` select the first or last whitespace-separated word. Full identity stays in the popup. |
| `compact` | `false` | Label each consecutive commit group once, with a visible-boundary repeat. |
| `highlightCommit` | `false` | Highlight all lines from the cursor's commit, including nonadjacent ranges. |
| `showCommitHash` | `false` | Include the actual short commit hash. |

Settings reformat the current blame result without running Git again. Cursor
highlighting reuses an index and does not request Git or editor discovery. Only
visible rows produce gutter DOM nodes. Relative-date formatters and repeated
commit labels are reused while preparing a snapshot.

## Line History

Choose **View Line History** from a line-number menu, the editor menu or a blame
popup. The popup uses that entry's line; other entry points use the context line
or current cursor. Select a change to open that historical file's parent-to-commit
diff at the changed range. Renames use the historical filenames, and root commits
have an empty original side.

The selected line is anchored to its blamed commit, original filename and original
line. Inserting lines above it or renaming the file does not turn the request into
an unrelated current line. Additional pages retain the same immutable anchor.

History follows the first parent from that anchor. The initial page shows up to
30 relevant changes; **Load more line changes** adds 30, up to 200. Each page uses
one bounded Git line-log read. There is no automatic repository-wide history load
or remote fetch. Reads can be cancelled and have a 10-second per-read limit.

Save an edited document before requesting history. New, untracked or uncommitted
lines may have no committed history. Editing or closing the document cancels
pending reads, and an outdated document cannot open a stale selection. Git read
errors are reported in **Git Simple Compare** Output.

## Reference review

Reviewed [Git Blame Annotations](https://github.com/lkqm/vscode-gitblame-annotations)
at [`cc2c600`](https://github.com/lkqm/vscode-gitblame-annotations/tree/cc2c600a75f98a6af39c33a6082cac8c1657c0b3)
(manifest version 0.5.3). This implementation uses the existing Git Simple Compare
gutter, popup, Git execution wrapper and theme tokens; no dependency on that
extension was added.

| Reference capability | Git Simple Compare result |
| --- | --- |
| Per-line annotations and hover details | Existing gutter and complete commit popup retained. |
| Gutter menu and show/hide shortcuts | Direct file commands, line-number menu and scoped Escape added. |
| Consecutive commit labels | Optional compact groups with visible-boundary repeat. |
| Same-commit line highlighting | Optional cursor highlight using a cached range index. |
| Date and author formats | Resource settings added; full identity preserved in details. |
| File revision number | Actual short commit hash offered as the stable identifier. |
| Line history | Saved-line picker with bounded pages and historical file diffs. |
| Previous-revision annotation | Historical changes open as read-only diffs; this release does not add a second annotated historical editor mode. |
