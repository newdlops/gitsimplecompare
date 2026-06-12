# Handover

## Context

- Repository: VS Code extension `Git Simple Compare`.
- Worktree is intentionally dirty; do not revert unrelated user changes.
- `codeidx` MCP was unavailable during this work (`ECONNREFUSED 127.0.0.1:64303`), so local `rg`/shell inspection was used.
- Use `git -c core.fsmonitor=false ...` when reading git status/diff if fsmonitor errors appear.

## Implemented Work

### Changes Sidebar

- Added/iterated sidebar file tree behavior:
  - VS Code theme file icons in the Changes webview.
  - Single-click selection behaves like the VS Code explorer: selecting one item clears multi-selection and highlights the selected row.
  - Drag rectangle multi-select for file rows while preserving existing multi-select UX.
  - Accordion section resize handles and drag-reorder behavior.
  - Top-level meatball menu toggles visible accordion categories.
  - File-tree sections expose `View as List` / `View as Tree` in their own meatball menu.
- `ChangesViewProvider` now batches render messages and skips identical payloads.
- Render payload construction was split into:
  - `src/webview/changesRenderPayload.ts`
  - `src/webview/changesViewTypes.ts`
- `retainContextWhenHidden` is enabled for the Changes webview so switching Activity Bar views does not recreate the webview from scratch.

### Refresh And Cache Policy

- Added scoped refresh logic in `src/commands/refreshChangesView.ts`.
  - Working-tree-only events refresh only `workingChanges`.
  - Full refresh still handles repositories, stashes, and branch comparison.
  - OUTPUT logs include `changes refresh scoped`.
- Added status cache in `GitService.getStatusGroups()`.
  - Short TTL and in-flight sharing avoid repeated `git status` calls.
  - Cache is invalidated on workspace/git events and write actions.
- Added repository root resolve cache in `GitServiceRegistry`.
- File icon payloads are cached by icon theme + file path set in `src/webview/fileIconTheme.ts`.
- Removed expensive untracked-file line counting from status listing.

### Native Diff Line Checkboxes

- Line-by-line hunk selection is implemented as a native VS Code diff overlay using CDP injection.
- Fallback decoration/inlay paths were removed; checkbox UI is native overlay only.
- Checkboxes exist for additions and deletions.
- The hunk flow is integrated with HEAD/Working Tree and HEAD/index diff views:
  - Checked unstaged lines can be staged.
  - Checked staged lines can be unstaged.
  - Stage/unstage updates existing diff tabs instead of opening extra original/temp tabs.
- `src/providers/hunkCheckboxController.ts`
  - Maintains checkbox selection state.
  - Uses file-level hunk diff lookup instead of parsing the full repository diff on first render.
  - Handles visible editor groups, not only the active tab.
- `src/git/diffHunkService.ts`
  - Added `getFileWorkingDiff(relPath)` so opening a changed file only reads that file's diff.
- `src/providers/nativeDiffOverlayController.ts`
  - Sends multiple visible diff snapshots to the renderer.
- `src/providers/nativeDiffOverlayPatch.ts`
  - Patch version is `6`.
  - Renderer now finds all matching Monaco diff editors, so checkboxes appear across multiple editor columns.
  - Scroll/viewport repaint handling was narrowed to diff/editor DOM instead of a global body observer.

### Stashes

- Stash listing was changed from `git stash list` to:
  - `git reflog show --max-count=10000 --format=... refs/stash`
  - This avoids environments where `stash list` is limited to the latest item by log settings.
- Stash file cache keys now use `root + ref + hash/index`, not hash alone.
- Webview stash expanded state uses hash with ref/index fallback.
- OUTPUT logs include:
  - `stashes listed`
  - `stashes rendered`

### Logging / Instructions

- `AGENTS.md` includes project instructions.
- OUTPUT logging was added/expanded so extension state is observable.
- UI buttons added during this work should have hover tooltips per project instruction.

## Key Files

- `src/extension.ts`
  - watcher refresh scheduling, cache invalidation, `retainContextWhenHidden`.
- `src/commands/refreshChangesView.ts`
  - scoped refresh and section timing.
- `src/git/gitService.ts`
  - status cache, stash reflog listing, git operations.
- `src/git/diffHunkService.ts`
  - hunk parsing, file-level diff lookup, partial stage/unstage.
- `src/providers/hunkCheckboxController.ts`
  - checkbox state, visible diff snapshot generation.
- `src/providers/nativeDiffOverlayController.ts`
  - CDP bridge and renderer injection.
- `src/providers/nativeDiffOverlayPatch.ts`
  - renderer-side checkbox overlay script.
- `src/webview/changesViewProvider.ts`
  - webview state and render batching.
- `media/changes/changes.js`
  - Changes webview interactions and selection/tree/stash UI.

## Verification

Latest validation after the recent changes:

```sh
npm run check-types
npm run package
```

Both passed.

Earlier note: `npm run lint` was not usable because `eslint` was not available in the project environment.

## Known Risks / Follow-Up

- `media/changes/changes.js` is still very large and should be split later. It predates the latest changes and is outside the 300-600 line guideline.
- Native diff overlay uses an unofficial CDP/workbench renderer injection path. It works for the requested deployable behavior, but VS Code internals can change.
- After overlay changes, reload the Extension Development Host so renderer patch version `6` replaces older injected code.
- If checkbox placement or refresh behavior regresses, check OUTPUT logs first:
  - `native diff overlay rendered`
  - `changes refresh scoped`
  - `stashes listed`
  - `stashes rendered`
