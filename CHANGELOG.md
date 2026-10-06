# Changelog

## [0.1.72085] - 2026-10-06

### Changed

- Align Changes region labels and conflict counts with the shared 11px label
  scale, and use the documented 4px surface radius for menus.
- Share caption and native icon size tokens, remove ineffective icon size
  overrides, and separate sidebar shell, file lists and actions into bounded
  style modules while preserving their cascade order.

### Fixed

- Position root and nested menus before giving keyboard focus so tooltips stay
  beside the focused item. Apply transitions immediately in reduced-motion mode
  to prevent a delayed menu position from leaving tooltips at the old coordinates.

## [0.1.72084] - 2026-10-06

### Changed

- Show the first complete file-history commits while the same native Git process
  continues rename-aware traversal. Preserve all final commits and statistics,
  cache only validated complete results, and retain keyboard focus and drafts
  when loading finishes.
- Fetch up to 100 commit IDs and review threads per initial PR metadata page,
  reducing supplemental requests while still following every remaining page.

### Fixed

- Mark cancelled history previews as paused instead of complete, and keep the
  loading status visible beside the file name in a short History section.
- Preserve the original PR pagination error when a fast supplemental request
  fails before its metadata batch finishes.

## [0.1.72083] - 2026-10-06

### Changed

- Reuse file history when HEAD and history interpretation are unchanged,
  preserving rename tracking and line statistics. Refresh relative dates without
  repeating the full history walk, and restore validated results after a host
  restart from a bounded, atomic, user-local cache.
- Share file history reads, limit concurrent loaders to two, and cancel obsolete
  consumers on file changes, window blur and shutdown. Prevent late results or
  errors from replacing the newly selected file.
- Show all 80 PR titles, states and branches after the first lightweight GitHub
  response. Load full metadata in bounded batches and start commit/comment
  pagination as each batch completes, preserving complete final results.
- Display unknown file counts as an ellipsis during PR loading, and preserve
  existing disabled Git actions, search focus and row state until data is ready.

## [0.1.72082] - 2026-10-06

### Fixed

- Prevent read-only Git commands from refreshing the repository index across
  text, binary, stdin and streaming execution. Allow optional index writes only
  for a registered extension-owned index, preserving staging and write commands.
- Reuse a validated private status index across Extension Host restarts to avoid
  repeated cold untracked-file scans. Continue querying Git for fresh results,
  invalidate on staging changes, and retain warmed scans through metadata-only
  index refreshes. Rebind tracked-file metadata and preserve racy-clean detection;
  keep session-local fallbacks for unsupported split and sparse index formats.
- Bound the persistent index cache to 32 files / 128 MiB with age-based cleanup,
  atomic publication and recovery from corruption or unavailable storage. Clean
  abandoned publication files without touching active sessions or user Git files.
- Record status index ownership, untracked scan mode and optional lock policy in
  Git Simple Compare OUTPUT without exposing environment values or index paths.

## [0.1.72081] - 2026-10-05

### Changed

- Inspect only the owned process group and known descendant PIDs when cancelling
  Git reads on macOS, avoiding repeated full-system process snapshots. Keep
  user, process group, executable and start-time checks before signalling;
  retain descendant cleanup and protection for writes and other applications.
- Log owned-group inspection time and process count in Git Simple Compare
  OUTPUT to distinguish cancellation inspection from Git execution delays.

## [0.1.72080] - 2026-10-05

### Fixed

- Recognize orphaned VS Code crash reporters during idle Git inspection.
  Closing the editor can leave crashpad running; its presence no longer makes
  workspace usage unavailable or cancels a verified monitor shutdown. Actual
  editor hosts, workspace mapping, terminal activity and PID/socket checks
  continue to protect active repositories.

## [0.1.72079] - 2026-10-05

### Changed

- Cancel obsolete commit and PR detail consumers on selection, drawer close,
  panel hide and window blur. Reuse one commit header query for both summary
  and complete detail, and keep other shared consumers running.
- Patch PR drawer content in place, preserve search composition, focus, scroll
  and file trees, and bound visited detail caches to 32 entries / 8 MiB.
- Reuse warmed repository names without spawning Git config queries. Validate
  remote, global/include configuration, authentication, HEAD and linked-worktree
  changes with asynchronous shared file metadata probes.
- Coalesce automatic graph fingerprint notifications into one latest follow-up,
  reuse layout checkpoints, send revisioned graph deltas, and preserve unchanged
  text rows and SVG elements when adding pages. Recover missed messages without
  another Git read.
- Limit untracked file reads to four workers while retaining every file and its
  order; cap retained line statistics at 4,096 entries / 1 MiB.
- Share in-flight hunk reads, invalidate only changed files where possible, and
  wait for replaced reads to actually close before starting their successors.
- Find GitHub CLI on the captured PATH before initializing a login shell, while
  retaining executable overrides and shell fallback.

### Fixed

- Keep changed-file statistics and the detail retry button visible in narrow
  PR drawers, and preserve selected graph rows during incremental refresh.

All notable changes to **Git Simple Compare** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.72078] - 2026-10-05

### Fixed

- Keep GitHub read slots occupied until owned CLI processes and verified
  descendants close. Include queue waits in read deadlines, cancel pending
  reads on extension shutdown, and isolate successive activation lifetimes.
- Honor fresh-read requests and shorter cache lifetimes. Separate cached
  responses by repository, server, authentication and CLI environment;
  capture the environment before queueing and detect CLI configuration changes.
- Keep repository-name lookup cancellation independent for each consumer, and
  prevent pre-cancelled Git reads from invalidating another consumer's cache.
- Reject missing PR detail pages, repeated cursors, incomplete file counts and
  HEAD/base changes during pagination. Cancel peer pages on failure while
  preserving complete file data, exact comment counts and existing page limits.

## [0.1.72077] - 2026-10-05

### Changed

- Load the same 80 Pull Requests through a light ordered identity query and
  batches of 20 complete records, with at most four concurrent requests. Keep
  cursor ordering, every commit, review comment count and early display intact.
- Start selected PR details and Explorer changed-file reads immediately using
  GitHub CLI repository placeholders, removing the preceding repository lookup
  and honoring the current `GH_REPO` selection.

### Fixed

- Reject missing or duplicate PR identities, incomplete metadata connections
  and GraphQL partial errors instead of displaying a partial successful page.
  Cancel peer requests on failure while preserving the original error.

## [0.1.72076] - 2026-10-04

### Changed

- Skip filesystem-monitor preparation for stash reflog, reference, remote-tag
  and ref-name queries. Treat these queries as cancellable reads while keeping
  reflog writes protected.
- Share idle-monitor OS inspection between Code windows, reduce lsof working
  directory output, back off after incomplete inspection, and log the failing
  inspection stage. Official monitor stop still checks fresh process/socket use.
- Reuse blame for unchanged file, HEAD and index identities for up to one minute,
  including linked worktrees. Limit retained result memory and cancel display
  consumers while the Code window is unfocused; resume with fresh CodeLens state.

## [0.1.72075] - 2026-10-04

### Fixed

- Own newly needed builtin Git filesystem monitors independently of the idle
  cleanup setting, wait for monitor/read process groups to close on shutdown,
  and prevent a preparation finishing after disposal from spawning new work.
- Fall back without starting an unmanaged daemon when monitor startup fails;
  close monitors that never become ready and preserve explicit caller hooks.
- Detect detached monitors with a home working directory, relative IPC sockets
  and linked worktrees. Count auxiliary webviews as part of their Code window.
- Let opt-in idle cleanup recover verified detached monitors from prior sessions;
  recheck window/terminal use and bind official stop to the selected Git directory
  without inheriting unrelated Git directory or socket settings.
- Prevent creation of unmanaged filesystem monitors by new worktree operations.

## [0.1.72074] - 2026-10-04

### Added

- Add user and workspace controls for idle Git cleanup, a configurable observed
  idle interval, and a manual process picker. Automatic cleanup defaults to off;
  verified inactive monitors stop through Git's official command while active
  repositories, other windows, writes and unverified processes stay protected.
- Add a configurable 30-second read-only Git deadline and optional shared status
  API for compatible extensions, including Tab Manager.

### Fixed

- Cancel obsolete status, statistics and blame reads, wait for owned processes
  and resistant children to close, and release subscriptions and private caches
  when the extension shuts down.
- Share status reads between Changes, Graph and external consumers. Use a private
  index cache to reduce repeated file scans while preserving complete untracked
  filenames, staged state and the real index.

## [0.1.72073] - 2026-10-04

### Fixed

- Stop obsolete Graph log, status, local-branch, worktree and commit-window Git
  queries when the panel is hidden, loses focus, changes repositories or is
  disposed. Replaced reads cannot cancel newer requests or publish stale data.
- Propagate cancellation through revision stdin and damaged-ref fallback paths.
  Stop remaining sibling queries after a parallel read fails, while preserving
  real errors and treating normal cancellation as an Output state transition.

## [0.1.72072] - 2026-10-04

### Changed

- Reuse the worktree list and remote branch tips already read for the Graph
  refresh fingerprint when loading branch badges and filters, avoiding repeated
  worktree, remote-ref and common-directory processes in the same reload.
- Read commit-hook and common Git directories in one process and avoid repeating
  a missing hooksPath lookup. Preserve lexical paths, Husky aliases and fallback
  behavior for older Git versions and ambiguous path output.

### Fixed

- Terminate obsolete Graph fingerprint queries when a newer request supersedes
  them, the window loses focus, the panel is hidden or disposed, or the repository
  changes. Preserve refresh intent and log normal cancellation without showing
  a Git failure notification.

## [0.1.72071] - 2026-10-03

### Changed

- Read branch-comparison and Graph-detail file states and line counts in one Git
  diff process instead of two, sharing rename detection and preserving binary
  results and literal filenames with whitespace, tabs, newlines and arrows.
- Read the Graph's changed-worktree summary and HEAD from one porcelain-v2 status
  process, avoiding a separate HEAD lookup and unnecessary upstream-count work.
  Preserve clean, conflicted, detached and unborn-worktree behavior.

## [0.1.72070] - 2026-10-03

### Changed

- Reuse the current worktree's HEAD and branch while checking Graph changes,
  reducing the normal fingerprint read from four Git processes to two. Preserve
  fingerprint results for linked worktrees, detached HEAD and symlink paths, with
  the previous HEAD queries as a fallback for incomplete or unborn worktrees.

## [0.1.72069] - 2026-10-02

### Fixed

- Skip superseded Graph reloads before starting status, log and branch queries
  when a slow fingerprint completes after another ready event, hiding the panel,
  switching repositories or disposing it. Record the skipped generation in Output.
- Run background status reads with `GIT_OPTIONAL_LOCKS=0` to avoid unnecessary
  index writes and lock contention, including the fsmonitor fallback path.
  Preserve complete untracked file results, cancellation and executable overrides.

### Changed

- Log slow Git process startup separately from total execution time in the
  Git Simple Compare Output channel, without logging command arguments or content.

## [0.1.72068] - 2026-10-02

### Added

- Diagnose Git process startup and select a verified executable from the Changes
  menu or Command Palette. Compare three startup samples, choose user or workspace
  scope, and reset the override without changing repository or OS Git settings.
- Apply the configured executable to every shared Git execution path, including
  binary reads, streamed reads, and stdin commands, with live folder inheritance.

## [0.1.72067] - 2026-10-02

### Added

- Control the user-level default for VS Code built-in Git alongside the workspace
  option. Preserve workspace and folder overrides, show each scope's state in the
  Changes menu, and allow the user command in windows without an open workspace.

## [0.1.72066] - 2026-10-02

### Added

- Start or stop VS Code built-in Git from the Changes view menu or Command Palette.
  Apply the setting to the current workspace and its explicit folder overrides,
  while Git Simple Compare continues its own Git operations.

### Fixed

- Stop using built-in Git status snapshots when it is disabled, and recover
  status integration when it is enabled again, including temporary API failures.

## [0.1.72064] - 2026-09-13

### Changed

- Package the local branch inventory and stale cleanup improvements from 0.1.72063,
  plus AI Commit Plan failure log viewing and copying from 0.1.72062, for Marketplace.

## [0.1.72063] - 2026-09-13

### Changed

- Show the complete local branch inventory in Stale Cleanup, with local names,
  remote presence, worktree protection and latest commits. Add search, a stale-only
  filter, protected selection controls and explicit counts for hidden selections.
- Keep local branches visible when no remotes are configured, with unchecked status
  and deletion disabled. Preserve the existing confirmation and Git recheck flow.

## [0.1.72062] - 2026-09-11

### Added

- Read failed AI Commit Plan commit logs directly in the plan panel and copy the
  complete failure output. Keep long log previews bounded, report clipboard errors
  inline, and prevent copying a previous execution's log after a new run or session.

## [0.1.72061] - 2026-09-10

### Added

- Clean up stale local branches from the Changes menu or Command Palette.
  Compare exact branch names against every live remote, protect worktree branches,
  recheck the selection before deletion, and require a separate confirmation for
  unmerged history. Report partial failures and deleted commit IDs in OUTPUT.

## [0.1.72060] - 2026-09-10

### Fixed

- Clear stale paused rebase controls after terminal Continue or Abort, including
  operations that finish without changing HEAD. Reconcile Git operation state
  independently of graph refreshes and on focus, reveal and manual refresh.
- Observe rebase directory removal itself so terminal completion reaches the
  graph even when individual metadata file events are coalesced.
- Stop conflict decoration logs from triggering their own document refresh loop.
  Keep existing highlights visible during metadata reads and reject stale
  results for changed, closed or disposed editors.
- Await the latest coalesced conflict refresh before reporting completion.
  Discard obsolete repository results and recover correctly from partial context
  updates without publishing incomplete state.
- Validate the native operation and original todo before replacing rebase plans.
  Preserve external edits and the original todo on failed writes, and reject
  obsolete updates after external Continue, Abort or a restarted rebase.
- Recognize abbreviated rebase commands and SHA-256 commit hashes when reading
  paused state and updating remaining todo items.

### Performance

- Skip unchanged conflict tree, context and decoration updates while retaining
  fresh content notifications for changed index stages.
- Defer automatic Git content reads while conflict Result documents have unsaved
  edits, preserving their save baseline and explicit Reload behavior.
- Parse rebase todo lines once, index full commit hashes and skip repository
  reads when Continue has no UI plan to apply.

## [0.1.72059] - 2026-09-08

### Performance

- Reuse immutable conflict blob previews in a bounded cache, sharing concurrent
  reads while keeping index, attributes, operation and Result validation fresh.
- Stream large conflict source blobs with a 512 KiB preview limit while checking
  the entire stream for binary content, avoiding the buffered Git output limit.
- Prioritize visible conflict editors, limit concurrent content and metadata
  reads, and cancel obsolete reads when editors close, suspend or resolve.
- Share PR pagination slots between individual requests so large PRs cannot
  monopolize them. Publish each completed comment count before slower PRs in
  the same batch finish, preserving incomplete-data guards and cancellation.

### Fixed

- Report Stack configuration lock, permission and parsing failures instead of
  treating them as missing settings. Restore earlier changes after partial
  writes or deletion failures and report incomplete recovery.
- Cancel queued PR requests before releasing a failed request's slot and keep
  the original failure available when cancelling sibling requests.

## [0.1.72058] - 2026-09-08

### Performance

- Open conflict Result editors as soon as index content and save identities are
  ready. Load commit sources and remaining rebase analysis in the background,
  with explicit loading and retry states that preserve Result edits.
- Coalesce overlapping conflict refreshes and reuse source-validated metadata
  when only Result changes. Skip unchanged editor repaints and discard metadata
  from closed, resolved or replaced sessions.
- Refresh Changes once after graph rebase actions, limiting reads to affected
  sections and including stash updates on completion or recovery failure.
- Reuse the freshly resolved Git directory and HEAD within each operation
  identity capture. Preserve fresh validation before Continue, Skip and Abort.
- Batch review-thread count pages for up to four PRs per GitHub request and
  publish completed commit details while slower comment pages continue loading.
  Refreshes still recount current comments and share the four-request limit.

### Fixed

- Serialize local Stack metadata deletions and recovery writes so they do not
  compete for the same Git config lock and intermittently leave a relationship.

## [0.1.72057] - 2026-09-08

### Performance

- Load rebase commit metadata and file statistics in two Git processes, preserving
  root commits, first-parent merge diffs, empty commits, renames and literal paths.
  Recheck the current commit range before starting without rereading file diffs.
- Read unresolved paths directly from the index. Skip unused untracked-file
  discovery in rebase diagnostics and resolve the worktree Git directory once per
  todo read instead of once per state file.
- Deliver rebase results and focus conflicts while Graph and Changes refresh in
  the background. Release the mutation guard after Git and recovery finish;
  graph refresh delays or failures no longer hold up the next conflict action.
- Avoid repeating detailed diagnostics when focusing known conflicts or reporting
  completion. Log Git control time, plan loading, conflict focus and graph refresh
  durations in the Git Simple Compare output channel.

## [0.1.72056] - 2026-09-08

### Performance

- Show the first PR list response while large PRs finish loading their remaining
  commits and comments. Incomplete totals stay pending, and PR Git actions become
  available after the complete commit snapshot is ready.
- Reopening the PR list within 30 seconds reuses the visible data. Refreshes reuse
  complete commit lists only when the repository, base and head still match;
  concurrent list reads share the bounded GitHub request queue.
- Fetch preview repository information, title, body and the first commit-summary
  page together. Prepare local Git context alongside remote reads, reducing a
  typical preview's initial GitHub calls from five to three.

### Fixed

- Keep visible PR rows and offer retry when background pagination fails. Preserve
  search focus and Korean IME input when the complete list arrives. Unlock the
  list toolbar after the first response, and clear loading when a refresh keeps
  the same data without sending the full payload again.
- Reject base changes during commit pagination before treating a snapshot as
  complete or reusing it for Git operations.

## [0.1.72055] - 2026-09-07

### Fixed

- PR search completes commit pagination against the same head before returning
  results. Incomplete commit lists cannot be applied, and force-pushed PRs replace
  the old commit snapshot instead of combining unrelated histories.
- Searches are cancelled when superseded or when the graph leaves the repository.
  Late search results cannot overwrite another repository's PR list.
- Undo of a PR on another local branch checks the expected OID during the final
  ref update and preserves branches used by other worktrees, rebases or bisects.
- Stack rollback records its intent before restoring refs and uses its own reflog
  receipt to resume after checkpoint I/O failures. Temporary worktree cleanup can
  also resume after an interrupted state write.

### Performance

- PR previews initially load commit summaries and changed files. Commit patches
  and the conversation load when their tabs need them, with explicit loading,
  error and retry states. Successful empty commits do not trigger reload loops.
- Preview reads share in-flight requests and bounded caches, reuse review comments,
  and limit concurrent GitHub reads to four. Cancellation stops unused requests;
  refreshing mutable PR data preserves reusable commit OID entries.

## [0.1.72054] - 2026-09-07

### Fixed

- Merge, cherry-pick and revert Abort, plus cherry-pick/revert Skip, preserve
  discarded working files and staged blobs in recovery backups. Ignored files that overlap recovery
  targets are included; unsafe directory replacements stop before Git runs.
- Completed PR and branch Undo stop before resetting separately staged edits,
  including content kept only in the index. Working files and snapshots remain
  available so changes can be committed or stashed before retrying.
- Rebase edit amends verify the worktree, native operation generation, original
  todo item and expected HEAD. A stale edit request cannot amend the next commit.
  Failed, cancelled or incomplete editor saves leave rebase paused.
- Stack checkpoint failures retain the active Git operation, working edits and
  recovery refs. Automatic rollback no longer runs an unprotected Abort, and
  both the original error and recovery failure are reported.
- Graph Continue, Skip and Abort share branch, PR and stack recovery follow-up
  with the Conflicts commands. Completion includes stash restoration and pending
  cleanup; recovery failures are reported separately from native Git completion.
- Graph sessions are bound to the native rebase they started. General control
  commands record session completion, and old or unverified plans are not
  restored onto a later rebase.

## [0.1.72053] - 2026-09-07

### Fixed

- Continue, Skip and Abort verify the worktree and native Git operation
  generation. Confirmation cannot control a replacement operation, and pending
  PR, branch and stack recovery only follows a verified extension action.
  Unverified or externally finished operations retain their recovery data.
- Rebase Abort and Undo stop for unrelated new working edits. Discarded
  resolution files and index blobs are backed up under the worktree Git
  directory's `gitsimplecompare/operation-recovery`; Output logs the location.
  Deferred PR abort recovery uses a protected reset to preserve local edits.
- Rebase edit amends exclude unrelated staged files. Temporary edit sessions
  verify the original worktree and index before applying changes, preserving
  both versions when another edit intervenes.
- Stack rollback checks every layer against its recorded result before
  restoring branches. Later user commits, dirty worktrees and backup refs are
  preserved when automatic recovery cannot proceed safely.
- Interactive plans remain bound to their original worktree, branch and HEAD.
  Unsupported merge-containing plans stop before starting Git. Autostash
  restoration conflicts keep visible recovery guidance instead of reporting
  completion or offering controls for a rebase that has already ended.

## [0.1.72052] - 2026-09-07

### Fixed

- Failed rebase startup no longer hard-resets files or switches back over a
  user's newer branch selection. New edits, staged changes and later commits
  retain their recovery snapshot and stash. Safe startup recovery restores the
  original staged and unstaged state while preserving the initial Git error.
- PR Undo now verifies the operation ID, worktree, HEAD and Git operation
  generation. Unrelated rebases, cherry-picks, reverts, stash conflicts and
  newly staged changes stop Undo without discarding manual work. Confirmation
  stays bound to the original operation, and stash restoration requires the
  matching immutable snapshot. Completed, conflicted and continued PR actions
  record their own recovery state; older snapshots without ownership metadata
  remain available for manual recovery.

## [0.1.72051] - 2026-09-07

### Fixed

- Branch Undo verifies the operation ID, worktree, HEAD and active Git operation
  before restoring its snapshot. Unrelated stash conflicts, restarted rebases,
  newer commits and newly staged changes are preserved. Confirmation cannot
  accidentally approve an operation created while the dialog was open.
- A failed squash commit retains its recovery snapshot and staged result.
  Undo preserves unrelated working edits; a failed temporary squash leaves
  the user's original staged changes outside automatic recovery.
- Stash actions, lazy file loading and file diffs retain the selected repository
  and commit hash when stash numbers or the active repository change. Pop and
  branch creation delete the selected stash only after successful application.
  Failed reads remain retryable, and stale selections stop with an error.
- Partial binary stage, unstage, discard and split commit treat selected
  filenames literally. Per-file and full diff queries now produce consistent
  binary headers for change validation.
- PR Undo refuses to move a branch checked out in another worktree.
- Closing a Changes menu with Enter or Escape no longer raises an exception;
  Escape restores focus even after the pointer leaves a stash row.

### Changed

- Automatic branch Undo requires an operation record created in this worktree.
  Older snapshots remain in Git for manual recovery instead of being inferred
  as the owner of current changes.

## [0.1.72050] - 2026-09-07

### Changed

- Remote checkout now gives the new tracking branch its original name.
  An existing local branch is renamed to `<name>-stale-<old-commit-hash>`,
  with a numeric suffix when that archive name is already taken. Existing
  commits, branch settings, reflogs, and linked worktree files are preserved.
- The checkout confirmation shows the existing branch's archive name.
  A failed checkout restores the old name when no new branch was created;
  a hook failure after checkout preserves the completed Git state. Concurrent
  remote checkouts within one extension host are serialized across worktrees.

## [0.1.72049] - 2026-09-07

### Fixed

- Stage, unstage, and discard treat selected filenames literally. Brackets
  and Git pathspec syntax cannot expand a selection to other files.
- Pull recovery is tied to the original branch, worktree, and operation.
  Stale confirmations and unrelated conflicts cannot reset another branch.
  Recovery applies the saved stash by object ID even when its list position
  changes. Older snapshots without operation metadata remain in the stash
  for manual recovery.
- Push validates the approved branch, commit, and destination settings before
  sending an explicit commit ID. A branch switch during push cannot change
  its source or set upstream on another branch. Force-with-lease retains the
  remote commit known when the push was prepared, including after a fetch.
- Git failures retain exit codes, process signals, and original causes.
  Commit messages containing `index.lock` no longer trigger false retries;
  commands that can already have run hooks or changed remote state are not
  replayed after lock failures. Standard-input and binary-output commands
  also honor cancellation.
- Pull distinguishes missing upstream branches from authentication and
  transport failures. Unset Git profile values are identified by exit code.
- Failed file reads no longer become cached empty documents. Files absent
  from a valid ref, including the empty base before the first commit, still
  display correctly in comparisons.

## [0.1.72048] - 2026-09-06

### Fixed

- GitHub Web Session no longer opens automatically when optional suggested
  changeset requests fail, including a 404 with a saved session. Refreshing,
  changing branches, or reopening VS Code keeps existing authentication and
  API review comments available without repeated login prompts.
- The **Configure GitHub Web Session** command remains available for manual
  setup. Its description explains that browser sign-in and the saved session
  are separate; a saved session is no longer labeled as verified active.

## [0.1.72047] - 2026-09-06

### Changed

- **Faster GitHub PR loading**: Git Graph reads repository metadata with the
  PR list, removing two separate remote metadata requests from initial loading.
  Local stack information is available without waiting for GitHub.
- Local stack parent settings are read in one Git command instead of two
  commands per branch, reducing process overhead in repositories with many
  local branches.
- PR pages still contain up to 80 entries. Each entry starts with smaller
  commit and review-thread pages; additional pages run with at most four
  concurrent requests and retain the full commit order and comment counts.
- Unresponsive PR list requests stop after 30 seconds per request. Failed
  refreshes retain the last successful list, and OUTPUT logs include query
  timings, completion status, and request counts.

### Fixed

- Repeated pagination cursors fail instead of fetching indefinitely. Large
  review discussions no longer silently stop counting after 20 pages.

## [0.1.72046] - 2026-09-05

### Changed

- The Marketplace listing is named **Git Simple Compare & Graph** and uses
  the new ID `newdlops.gitsimplecompare`.
  Users of `newdlops.git-simple-compare` need to install the new listing once;
  updates do not transfer automatically between extension IDs.
- Installation links and instructions now point to the new package.
  Existing `gitSimpleCompare.*` settings and commands retain their names.

## [0.1.72045] - 2026-09-05

### Changed

- **Remote branch checkout avoids local name collisions**: selecting
  `origin/master` when `master` already exists now creates and checks out
  `master-<short-commit-hash>`. Further collisions use `-2`, `-3`, and so on.
  Existing local branches are preserved, and each new branch tracks the
  selected remote branch. This applies to both Git Graph and Changes checkout.
- Git Graph previews the available local branch name before checkout and
  reports the actual created name afterward, including when another branch
  takes the proposed name while the confirmation is open.

## [0.1.72043] - 2026-09-05

### Fixed

- **Accurate commit branch membership**: Git Graph now uses its fast cached
  branch list only after the selected commit and both branch catalogs are fully
  indexed. Partially loaded history and direct commit-detail reads use Git to
  avoid missing branches or incorrectly showing an empty list.
- Branch catalog changes and Graph hiding now discard cached branch-membership
  lookups. Branches moved beyond the loaded history are checked against Git,
  while checkout changes on known tips retain the fast indexed path.
- Temporary Git failures during branch-membership lookup are logged in the
  Git Simple Compare OUTPUT channel and retried on the next selection. A late
  failure from an earlier lookup cannot remove a newer cached result.

## [0.1.72042] - 2026-09-05

### Added

- **Git Graph performance diagnostics** now records fingerprint, local and
  remote branch reads, status, log, layout, extension-to-webview transport,
  render, and frame timings in the Git Simple Compare OUTPUT channel.
- **Damaged local ref isolation** keeps healthy commits and branches available
  when one local branch points to a missing object, with an accessible Graph
  warning and a direct path to the diagnostic OUTPUT channel.

### Changed

- **Faster branch and Graph loading** now reads the current branch in the same
  branch snapshot, caches repeated branch pickers, resolves all local-only
  commit memberships in one DAG traversal, and loads the first commit page only
  once after local and remote branch catalogs complete in parallel.
- Remote branch catalogs are reused until their semantic remote-ref fingerprint
  changes, while remote tag reads use a bounded five-minute cache with
  single-flight requests and explicit refresh after tag mutations.

### Fixed

- Superseded, hidden, repository-switched, and manually refreshed Graph loads
  now cancel or ignore stale Git work and cannot overwrite the newest render or
  refresh baseline.
- A broken Git fsmonitor daemon is detected from successful or failed status
  diagnostics and bypassed with a temporary command-scoped setting, without
  changing the user's repository or global Git configuration.

## [0.1.72041] - 2026-09-04

### Fixed

- **VS Code cache cleanup on desktop** now accepts VS Code's
  `vscode-userdata` global-storage URI and starts the cache scan instead of
  incorrectly reporting that a desktop or remote Node extension host is
  required.

## [0.1.72040] - 2026-09-03

### Fixed

- **Block blame alignment**: clicking a block author Code Vision now places
  line-by-line author/date labels in a dedicated editor gutter column. The
  column follows Monaco's visible line rows through scrolling, CodeLens, and
  folding without inserting blame text into the source body.

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

- **Safe VS Code cache cleanup**: inspect regenerable workbench, renderer/GPU,
  webview, and extension-download caches by size, select which groups to remove,
  and preserve settings, installed extensions, projects, workspace state, and
  backups. The command is available from the Git Simple Compare view title and
  the Command Palette, with Korean localization and explicit confirmation.
- **Staged commit hook preflight**: run `pre-commit` and available commit-message
  hooks against an isolated sibling copy of the Git index before committing.
  Full successful or failed output is kept in the Git Simple Compare OUTPUT
  channel, and failures reuse the clickable file/line diagnostics with a
  dedicated **Run checks again** action.
- **Block author Code Vision**: functions, classes, interfaces, methods, and
  other language symbols now show an IntelliJ-style contributor row above the
  declaration with the primary author, date, and history counts. Tiny nested
  methods are folded into their parent block. Global variable, object, and type
  declarations are grouped by blank lines with one row above each group. Hover
  for ownership distribution, or click to show and hide a file-wide author/date
  column aligned to every visible line in the editor gutter, with full blame
  details on hover.
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
