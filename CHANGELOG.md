# Changelog

All notable changes to **Git Simple Compare** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Staged pull request preview now starts without a target branch. Select a
  target branch first to load changed files and commits, avoiding expensive
  initial diffs when the default base is far from the current branch.
- **Changes view is now a webview** for richer display: the file list scrolls
  **horizontally** (long paths are no longer truncated) and **+/- line counts
  are colored** (green additions, red deletions) alongside a color-coded status.
  Folders are collapsible; From/To/Compare remain interactive. Fully localized.
  Styled to match VS Code's native tree/list — **codicon** icons, list/tree
  theme colors (hover, indent guides), and theme-aware From/To rows.
  Organized as a collapsible **accordion** (Explorer/Source Control style):
  - **Repositories** — workspace git repos with their current branch (like the
    SCM repositories list); click to set the active repo.
  - **Compare Branches** — From/To selectors, Compare, **and the branch
    comparison result** (changed files; click to open the branch diff).
  - **Changes** — the active repo's **working-tree changes** (like Source
    Control's Changes); click to open HEAD ↔ working diff. Auto-refreshes on
    save / editor switch.

  Section collapse state is remembered.
- **Explicit From/To setup**: the Changes view now starts with editable
  **From / To** rows and a **Compare** action, so you set both branches
  explicitly before comparing. The quick two-step picker now shows titled
  steps ("Compare Branches 1/2: choose FROM", etc.).
- **Richer change rows**: changed files show a color-coded status icon
  (added/modified/deleted/renamed) and **+additions −deletions** line counts.

### Added

- Marketplace publishing assets: extension icon, Activity Bar icon, and a
  publisher checklist for `newdlops.git-simple-compare`.
- **AI commit and PR messages**: generate commit messages from staged changes
  and staged PR titles/bodies through local Claude Code or Codex CLI providers.
- **Staged pull request preview**: inspect PR title/body, changed files, commits,
  and copy the generated PR message for GitHub.
- **Branch and PR operations**: branch squash merge, branch rebase merge, PR
  rebase, squash cherry-pick, and undo support for preserved local changes.
- **Split changes into commits**: select diff hunks and commit them separately.
- **Interactive rebase (drag UI)**: from the Git Graph ("Rebase from here") or the
  `Start Interactive Rebase…` command, edit a plan in a webview — drag to reorder
  and choose pick / reword / squash / fixup / drop per commit. Runs
  non-interactively; if conflicts occur the rebase pauses and the Conflicts view
  takes over. Requires a clean working tree and confirms before rewriting history.
- **Conflict resolution view**: lists unmerged files during a merge/rebase/
  cherry-pick/revert. Per file: open the 3-way merge editor, accept ours
  (`--ours`), accept theirs (`--theirs`), or mark resolved. Continue or abort
  the in-progress operation from the view toolbar.
- **Git Graph**: a webview showing the commit history graph across branches.
  Click a commit to see its details (author, message, changed files with line
  stats); click a file to open that commit's diff. Configurable via
  `gitSimpleCompare.graph.maxCommits`.
- **Changes view layout**: toggle between tree and list views, and sort changed
  files by name, path, or status. The choice is remembered across sessions.
- **Editor context entry points**: compare the active file with a branch from the
  editor right-click menu and the editor tab right-click menu.
- **Apply Left → Right**: a one-click button in file-vs-branch diffs that replaces
  the working file with the branch version (applied as an undoable editor edit).
- **Localization**: English is the default UI language, with full Korean
  translations applied automatically when VS Code's display language is `ko`.

## [0.1.0]

### Added

- Compare two branches (local/remote) and browse changed files in a tree view.
- Compare a file from the Explorer with a branch version.
- Compare the active file with a branch version.
- Editable working-tree side in file-vs-branch diffs.
