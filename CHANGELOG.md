# Changelog

All notable changes to **Git Simple Compare** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Faster startup and Changes cold start**: startup activation now registers
  providers and restored-editor support without eagerly starting remote or
  expensive Git data work. The Changes shell and working state render first;
  PR comments, stash files, worktrees, and commit-hook details load later when
  they are actually needed. Local file changes now use an independent fast
  refresh lane, run status alongside repository discovery, coalesce background
  stats work, and patch only the Changes section instead of rebuilding the
  complete webview.
- **PR squash cherry-pick / revert** commit subjects now end with the PR number
  (e.g. `Cherry-Pick "…" #123`, `Revert "…" #123`), linking the commit back to
  its pull request.
- **Git Graph PR list card**: clicking the card body now opens the PR **details**
  drawer (previously it jumped to the PR's commit row). A dedicated button on the
  card still jumps to the PR's row in the graph.
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

- **Block author Code Vision**: functions, classes, interfaces, methods, and
  other language symbols now show an IntelliJ-style contributor row above the
  declaration with the primary author, date, and history counts. Tiny nested
  methods are folded into their parent block. Global variable, object, and type
  declarations are grouped by blank lines with one row above each group. Hover
  for ownership distribution, or click to expand and collapse line-by-line
  authors directly in the editor.
- **Local commit hook management and failure diagnostics**: manage standard
  file-based commit hooks from the Changes commit box (including `core.hooksPath`, linked
  worktrees, and Husky), and open lint/file-check failures directly at their
  reported file and line before retrying the commit. Full hook output remains
  available in the Git Simple Compare OUTPUT channel. Git 2.55+ `hook.*`
  configured hooks are intentionally outside this manager's scope. Safe toggles
  use Unix executable bits and never rename hook files.
- **Git Graph PR details — changed files**: toggle the changed-files list between
  **tree** and flat **list**, and **click a file to open its diff** (PR base ↔
  head) in a diff editor.
- Marketplace publishing assets: extension icon, Activity Bar icon, and a
  publisher checklist for `newdlops.git-simple-compare`.
- **AI rebase planning**: graph rebase can request an AI plan that reorders
  commits, improves messages, labels module groups, chunks large histories into
  multiple AI sessions, and warns before high-token requests.
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

### Fixed

- **Graph search dropdown re-appearing**: the branch/commit/tag search results
  list no longer pops back up on its own while text remains in the search box.
  Periodic graph redraws now only refresh the list if it is already open, instead
  of re-opening one you dismissed.
- **Commit / AI busy spinner**: while committing or generating an AI message, the
  button now shows a rotating loading spinner instead of spinning its own check /
  sparkle icon (the glyph is swapped to `codicon-loading` for the duration).
- **Changed-files list flicker/lingering after commit**: after a commit, the
  file list no longer flickers (clear → briefly reappear → clear) or lingers.
  Because our own Git CLI performs the commit/stage/unstage, VS Code's built-in
  Git cache lags briefly behind reality; for a short window after any Git state
  change (commit, stage, unstage, discard, checkout, …) the working-tree status
  is now read via the Git CLI, so no follow-up refresh can momentarily read the
  stale cache. The commit button's spinner also stays until the refresh completes.

## [0.1.0]

### Added

- Compare two branches (local/remote) and browse changed files in a tree view.
- Compare a file from the Explorer with a branch version.
- Compare the active file with a branch version.
- Editable working-tree side in file-vs-branch diffs.
