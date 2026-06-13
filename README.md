# Git Simple Compare

Compare git branches and files with simple, **editable** diffs — right inside VS Code.


## Features

1. **Compare branches** — pick two local/remote branches, browse the changed files in a tree (or flat list), and open each file's diff.
2. **Compare a file with a branch** — right-click a file in the Explorer to diff it against a specific branch version.
3. **Compare the active file with a branch** — diff the currently open file against a branch version from the editor title bar or context menu.
4. **Edit while comparing** — in file-vs-branch diffs the working-tree side stays editable. You can also **apply the whole left (branch) version to the right (working) file in one click**.
5. **Git Graph** — a visual commit graph across all branches. Click a commit to see its details (author, message, changed files), and click a file to open that commit's diff.
6. **Conflict resolution** — during a merge/rebase/cherry-pick/revert, the Conflicts view lists unmerged files with one-click actions (open merge editor, accept ours/theirs, mark resolved) and Continue/Abort.
7. **Interactive rebase** — edit a rebase plan in a drag-and-drop webview (reorder + pick/reword/squash/fixup/drop). Launch it from the graph ("Rebase from here") or the command palette.
8. **Split changes into commits** — pick individual diff hunks and commit them separately, repeating for the rest (a GUI for `git add -p`).

## Usage

- Command Palette (`Cmd/Ctrl+Shift+P`) → `Git Simple Compare: Compare Branches`
- Explorer → right-click a file → `Compare This File with Branch`
- Editor → right-click (or tab right-click) → `Compare Active File with Branch`
- Editor title bar → comparison icon
- Activity Bar → **Git Simple Compare** icon to see the changed-files view
- Command Palette → `Git Simple Compare: Show Git Graph` (or the graph icon in the Changes view toolbar)

### Git Graph

Opens a webview showing the commit history graph across branches. Click a commit node to view its details on the right; click any changed file to open that commit's diff. The graph loads commits lazily as you scroll until it reaches the first commit.

### Interactive rebase

From the Git Graph, select a commit and click **Rebase from here** (or run `Git Simple Compare: Start Interactive Rebase…`). Arrange the plan by dragging rows and choosing an action per commit — **pick / reword / squash / fixup / drop**. Requires a clean working tree and confirms before rewriting history. If conflicts occur, the rebase pauses and the **Conflicts** view takes over; resolve and Continue.

### Conflict resolution

During a merge/rebase/cherry-pick/revert, the **Conflicts** view appears with the unmerged files. Per file: open the 3-way merge editor, **Accept Ours (`--ours`)**, **Accept Theirs (`--theirs`)**, or **Mark as Resolved**. Use **Continue** / **Abort** in the view toolbar. Note: during a rebase, `--ours`/`--theirs` are relative to the rebase (ours = the base being replayed onto), which is git's standard behavior.

### Split changes into commits

Run `Git Simple Compare: Split Changes into Commits`. Select the diff hunks for the first commit, type a message, and commit; the remaining changes stay in your working tree so you can commit them separately. Requires no pre-staged changes (so each commit contains exactly what you select). New (untracked) files are not shown — `git add` them first.

### The Changes view

- Toggle between **tree** and **list** layout from the view toolbar.
- Change the sort order (**name / path / status**) from the view toolbar.
- Click any file to open its diff.

### Apply Left → Right

While a file-vs-branch diff is focused, the editor title bar shows an **Apply Left to Right** (→) button. It replaces the whole working file with the branch version. The change is applied as an editor edit, so you can review, undo, or tweak it before saving.

## Language

The UI defaults to **English**. When VS Code's display language is set to Korean (`ko`), all commands and messages switch to Korean automatically. Use *"Configure Display Language"* from the Command Palette to change it.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `gitSimpleCompare.diffBase` | `twoDot` | Branch diff base (`twoDot` = direct, `threeDot` = common ancestor) |
| `gitSimpleCompare.includeRemoteBranches` | `true` | Include remote branches in the branch picker |

## Development

```bash
npm install
npm run compile     # bundle
npm run watch       # incremental build
npm run check-types # type check
```

Press `F5` in VS Code to launch the Extension Development Host.


## License

MIT
