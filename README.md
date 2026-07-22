# Git Simple Compare

Compare git branches and files with simple, **editable** diffs — right inside VS Code.

Marketplace ID: `newdlops.git-simple-compare`

## Install

- VS Code Marketplace: [Git Simple Compare](https://marketplace.visualstudio.com/items?itemName=newdlops.git-simple-compare)
- Command line: `code --install-extension newdlops.git-simple-compare`
- Manual VSIX: download or build a `.vsix`, then run `code --install-extension git-simple-compare-0.1.0.vsix`

## Features

1. **Compare branches** — pick one branch to compare with the current checkout and review native editor line markers; an advanced command keeps explicit FROM/TO comparison available.
2. **Compare a file with a branch** — right-click a file in the Explorer to diff it against a specific branch version.
3. **Compare the active file with a branch** — diff the currently open file against a branch version from the editor title bar or context menu.
4. **Edit while comparing** — in file-vs-branch diffs the working-tree side stays editable. You can also **apply the whole left (branch) version to the right (working) file in one click**.
5. **Git Graph** — a visual commit graph across all branches. Click a commit to see its details (author, message, changed files), and click a file to open that commit's diff.
6. **Native conflict overlay** — edit Result in the VS Code text editor while an in-editor overlay explains the exact Current/Incoming commits and rebase todo impact; native CodeLens actions remain available if the overlay cannot load.
7. **Interactive rebase** — edit a rebase plan in a drag-and-drop webview (reorder + pick/reword/squash/fixup/drop). Launch it from the graph ("Rebase from here") or the command palette.
8. **Split changes into commits** — pick individual diff hunks and commit them separately, repeating for the rest (a GUI for `git add -p`).
9. **AI commit plans and messages** — ask the local Claude Code or Codex CLI to split a large change set into reviewable commits, or generate a single commit message and staged PR title/body.
10. **File-based commit hook management** — inspect, create, open, enable, or disable traditional local hook files, and turn failed lint/file checks into clickable file-and-line diagnostics with Retry and full-output actions.
11. **Block author Code Vision** — show the primary Git contributor above functions, classes, interfaces, methods, and blank-line-separated global declaration groups. Click the hint to open a fixed-width author/date column beside the gutter.
12. **Pull request stack lifecycle** — draw PR flow directly on the Git Graph and automate layer/worktree creation, descendant restacks, dependency-ordered submit/sync, and post-merge advancement.

## Usage

- Command Palette (`Cmd/Ctrl+Shift+P`) → `Git Simple Compare: Compare with Current Checkout...`
- For arbitrary refs → `Git Simple Compare: Compare Any Two Branches (Advanced)...`
- Explorer → right-click a file → `Compare This File with Branch`
- Editor → right-click (or tab right-click) → `Compare Active File with Branch`
- Editor title bar → comparison icon
- Activity Bar → **Git Simple Compare** icon to see the changed-files view
- Command Palette → `Git Simple Compare: Show Git Graph` (or the graph icon in the Changes view toolbar)

### Block author Code Vision

For saved, tracked files, Git Simple Compare uses the active language extension's document symbols to place a dedicated CodeLens row above each supported source block. Top-level variables, constants, object declarations, and standalone `type` declarations are grouped until a blank line separates them, so each declaration group gets one CodeLens above its first line instead of one per line. Like IntelliJ Code Vision, the label shows the leading author, additional author count, last change date, and additional commit count. Tiny nested methods are folded into their parent block to reduce visual noise. Hover the Code Vision for the ownership distribution, or click any Code Vision to open a fixed-width column beside the gutter showing the author name and date for every line in the file. Hover an entry for full identity, commit, and summary details; click any Code Vision in the same file again to hide the column. Toggle the feature from the Changes toolbar or with `Git Simple Compare: Toggle Block Author Code Vision`; VS Code's `editor.codeLens` setting is also respected.

### Git Graph

Opens a webview showing the commit history graph across branches. Click a commit node to view its details on the right; click any changed file to open that commit's diff. The graph loads commits lazily as you scroll until it reaches the first commit. Pull request stack layers appear as chips on their head commits with dashed arrows pointing to their parent commits.

### Interactive rebase

From the Git Graph, select a commit and click **Rebase from here** (or run `Git Simple Compare: Start Interactive Rebase…`). Arrange the plan by dragging rows and choosing an action per commit — **pick / reword / squash / fixup / drop**. Requires a clean working tree and confirms before rewriting history. If conflicts occur, the rebase pauses and the **Conflicts** view takes over; resolve and Continue.

### Conflict resolution

During a merge/rebase/cherry-pick/revert, the **Conflicts** view opens Result in the native VS Code text editor with a context overlay. It identifies the commits behind Current and Incoming, keeps Base available for reference, and writes editable text through a no-follow/CAS-backed virtual file system. Binary, symlink, deleted, submodule, and other special Results open as safe read-only native documents. During a rebase the overlay also shows the original branch tip, new base, active todo step, remaining commits that touch the same path, and whether later history can change the selected Result. Current/Ours is the accumulated rebase side; Incoming/Theirs is normally the replayed commit and is labeled from the active `MERGE_HEAD`/`CHERRY_PICK_HEAD` instead when a nested operation causes the conflict. Whole-file actions use exact Git stages, while CodeLens block actions edit only one complete conflict-marker block. The native 3-way merge editor remains available as an action. Use **Continue** / **Abort** in the Conflicts view after resolving the files.

### Split changes into commits

Run `Git Simple Compare: Split Changes into Commits`. Select the diff hunks for the first commit, type a message, and commit; the remaining changes stay in your working tree so you can commit them separately. Requires no pre-staged changes (so each commit contains exactly what you select). New (untracked) files are not shown — `git add` them first.

### AI commit and PR messages

The Changes view includes an AI button next to the commit message box. It sends the staged diff to the selected AI CLI, so stage the files or hunks you want summarized first. The staged PR preview also has an AI button that fills the PR title and body.

For a larger change set, enable **AI Plan** beside the commit button or run `Git Simple Compare: AI Commit Plan`. Add optional instructions such as “keep tests with implementation” or “separate documentation,” then review the proposed commit messages and file groups. You can edit messages, reorder commits, and move files between groups before approving execution. The panel clearly shows whether the plan covers staged changes only or all staged, unstaged, and untracked changes; it rechecks the snapshot before committing and leaves newer edits untouched. Planned messages follow the same subject/body guidance and commit prompt instructions as standalone AI commit messages.

AI Plan prepares the complete commit chain privately, runs normal commit hooks for each prepared commit, then publishes the branch only after a final state check. Hooks can detect this provisional phase through `GIT_SIMPLE_COMPARE_AI_PLAN_PROVISIONAL=1` and should defer irreversible notifications or deployments when it is set. Git hook side effects outside the repository cannot be rolled back if a later hook or concurrency check stops the plan.

This feature runs local CLIs non-interactively: `claude -p` for Claude Code and `codex exec` for Codex. Use `Git Simple Compare: Configure AI CLI` or the gear button beside the AI commit button to choose the provider, login/status flow, executable path, model/profile options, reasoning effort, default response language, and extra prompt instructions. Model and reasoning pickers load metadata from the installed provider CLI. The **Commit Plan Settings** group lets each provider use a separate model and reasoning effort only for AI Plan. Leaving either empty inherits that provider's general setting; if the general setting is also empty, the CLI default is used. Profile settings still apply, and the picker warns when CLI metadata explicitly marks the selected model as incompatible with the effective reasoning effort.

If a browser callback login cannot reach localhost, use a non-callback login method in AI CLI Settings: for Claude Code choose `setup-token`, `console`, or `sso`; for Codex choose `device`, `api-key`, or `access-token`. Then run Login / Status again.

The commit-message AI button is enabled only when there are staged changes. In PR preview, the copy button copies the generated/current PR title and body to the clipboard for use on GitHub.

### Commit hooks and failed checks

Click the shield beside the commit button to manage the repository's traditional file-based commit hooks. The panel honors `core.hooksPath`, linked worktrees, and Husky's `.husky/_` layout. Git 2.55+ configured hooks declared through `hook.*` are not listed or changed. Safe toggles change only a regular Unix hook's executable bit; tracked/visible working-tree hooks, Husky proxy hooks, symbolic links, Windows hooks, and existing `.disabled` files remain open-for-editing but are not renamed or toggled.

When a commit hook rejects a commit, common ESLint, TypeScript, Ruff, Prettier, pre-commit, Husky, and file-check output is shown below the commit box. Click a reported file to open its line, fix and stage it, then choose **Retry commit**. **Show full output** opens the unabridged process output in the `Git Simple Compare` OUTPUT channel.

### The Changes view

- Toggle between **tree** and **list** layout from the view toolbar.
- Change the sort order (**name / path / status**) from the view toolbar.
- Click any file to open its diff.

### Pull request stacks

Open the layer button in the Git Graph toolbar to see a unified view of local parent metadata and GitHub PR base/head relationships. **Add Layer** creates a child branch and optional linked worktree from the selected parent. **Restack** previews and rebases that layer and all descendants with per-layer safety refs and integrated conflict Continue/Abort. **Submit / Sync** pushes root-to-leaf, creates missing PRs, updates existing bases and stack sections in PR bodies, and uses an explicit force-with-lease only for rewritten remote history. After a lower PR is merged, **Advance** promotes its children to the previous base, restacks and syncs their PRs, then offers safe local branch/worktree cleanup.

Install `gh` and run `gh auth login` before submitting. For a complete Korean walkthrough, see [PR Stack 사용 가이드](./docs/pull-request-stacks.ko.md).

### Apply Left → Right

While a file-vs-branch diff is focused, the editor title bar shows an **Apply Left to Right** (→) button. It replaces the whole working file with the branch version. The change is applied as an editor edit, so you can review, undo, or tweak it before saving.

## Language

The UI defaults to **English**. When VS Code's display language is set to Korean (`ko`), all commands and messages switch to Korean automatically. Use *"Configure Display Language"* from the Command Palette to change it.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `gitSimpleCompare.diffBase` | `twoDot` | Branch diff base (`twoDot` = direct, `threeDot` = common ancestor) |
| `gitSimpleCompare.includeRemoteBranches` | `true` | Include remote branches in the branch picker |
| `gitSimpleCompare.blameBlock.show` | `true` | Show clickable contributor Code Vision above source blocks |
| `gitSimpleCompare.aiCliProvider` | `auto` | AI CLI provider (`auto`, `claude`, or `codex`) |
| `gitSimpleCompare.aiClaudeCommand` | `claude` | Claude Code executable name or absolute path |
| `gitSimpleCompare.aiClaudeModel` | empty | Claude Code model selected from CLI metadata |
| `gitSimpleCompare.aiClaudeCommitPlanModel` | empty | Claude Code model used only for AI Plan; empty inherits `aiClaudeModel`, then the CLI default |
| `gitSimpleCompare.aiClaudeCommitPlanEffort` | `low` | Claude Code reasoning effort used only for AI Plan; empty inherits `aiClaudeEffort`, then the CLI default |
| `gitSimpleCompare.aiClaudeEffort` | empty | Claude Code reasoning effort (`low`, `medium`, `high`, `xhigh`, or `max`) |
| `gitSimpleCompare.aiClaudeSystemPrompt` | empty | Optional Claude Code system prompt appended with `--append-system-prompt` |
| `gitSimpleCompare.aiClaudeLoginMode` | `claudeai` | Claude login method (`claudeai`, `console`, `sso`, or `setup-token`) |
| `gitSimpleCompare.aiCodexCommand` | `codex` | Codex executable name or absolute path |
| `gitSimpleCompare.aiCodexModel` | empty | Codex model selected from the CLI model catalog |
| `gitSimpleCompare.aiCodexCommitPlanModel` | empty | Codex model used only for AI Plan; empty inherits `aiCodexModel`, then the CLI default |
| `gitSimpleCompare.aiCodexCommitPlanReasoningEffort` | `low` | Codex reasoning effort used only for AI Plan; empty inherits `aiCodexReasoningEffort`, then the CLI default |
| `gitSimpleCompare.aiCodexReasoningEffort` | empty | Codex reasoning effort (`low`, `medium`, `high`, `xhigh`, or `max` when supported) |
| `gitSimpleCompare.aiCodexProfile` | empty | Optional Codex config profile passed with `--profile` |
| `gitSimpleCompare.aiCodexLoginMode` | `device` | Codex login method (`device`, `browser`, `api-key`, or `access-token`) |
| `gitSimpleCompare.aiResponseLanguage` | `English` | Language for AI-generated messages |
| `gitSimpleCompare.aiCommonInstructions` | empty | Extra prompt instructions applied to commit plans, commit messages, and PR generation |
| `gitSimpleCompare.aiCommitInstructions` | empty | Extra prompt instructions applied to standalone and planned commit messages |
| `gitSimpleCompare.aiPullRequestInstructions` | empty | Extra prompt instructions applied only to PR generation |
| `gitSimpleCompare.aiCliTimeoutMs` | `120000` | Timeout for AI CLI requests |

## Development

```bash
npm install
npm run compile     # bundle
npm run watch       # incremental build
npm run check-types # type check
npm test            # hook parser and temporary-repository integration tests
```

Press `F5` in VS Code to launch the Extension Development Host.

### Coding agents

Codex reads `AGENTS.md` from the repository root. Claude Code reads `CLAUDE.md`; this repository keeps `CLAUDE.md` as a small import of `AGENTS.md` so both agents follow the same project rules. Put personal Claude Code notes in `CLAUDE.local.md`; it is ignored by git.

## Publishing

Release packaging uses publisher `newdlops`. See [docs/publishing.md](./docs/publishing.md) for the Marketplace checklist.


## License

MIT
