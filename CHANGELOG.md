# Changelog

## [0.1.72159] - 2026-10-22

### Performance

- Read only HEAD and change presence for Graph virtual rows, avoiding complete
  untracked-file enumeration and a separate cold-index warmup for that consumer.
- Share complete Changes reads with Graph and promote a summary to a complete
  read when needed. Keep cancellation, invalidation and independent returned values.
- Retain a validated private directory cache across source index metadata-only
  changes. Rebind current stat fields and preserve Native checks of edits and ignores.

### Development

- Verify operation results and branch identity with independent Native Git after
  the final measured renderer frame. Separate ordinary latency, CPU and aggregate
  RSS observation; preserve and reject incomplete memory observations.
- Record all 18 operation variants on two repository sizes, including slower
  cases and initial-load tradeoffs. Overall operation-speed completion remains open.

## [0.1.72158] - 2026-10-22

### Fixes

- Allow PR row jumps in All branches while the remote branch catalog is pending,
  unavailable or restricted to validated refs after a broken ref is detected.
- Resolve only the selected commit or PR objects when the catalog is empty.
  Preserve explicit branch selections, invalid refs, HEAD, index, configuration
  and FETCH_HEAD, and record direct-target catalog fallbacks in Output.

## [0.1.72157] - 2026-10-22

### Fixes

- Stop local Graph branch recovery reads after cancellation, timeouts, output
  limits or pending process termination. Preserve the original stopping error
  instead of retrying or reporting an incomplete metadata snapshot as success.
- Check cancellation after every Native response while retaining recovery for
  genuinely broken refs and ordinary metadata failures. Log stopping phases.

### Development

- Preserve the rejected scoped tracking experiment with two balanced actual-button
  comparisons. Keep the deployed tracking strategy after latency and process-count
  results failed to justify the candidate.
- Bound temporary benchmark disk use per scenario and create synthetic upstream
  configuration in one checked write. Add opt-in readonly tracking and ref-field probes.

## [0.1.72156] - 2026-10-22

### Fixes

- Reveal the commit title horizontally when jumping to a pull request row in a
  wide Graph, including newly loaded commits, long ref badges and a previously
  scrolled viewport. Preserve horizontal position when the title is already visible.
- Keep keyboard focus, row highlighting, loading, retry and navigation cancellation
  behavior while avoiding additional Git or GitHub requests for loaded rows.

## [0.1.72155] - 2026-10-22

### Performance

- Reuse at most 24 Graph width candidates across unchanged resizes and
  short noncandidate row edits. Keep measuring actual overflow on each frame.
- Rebuild candidates when scores, ties, row membership or removals can change
  the result, including reflog annotations and complete Graph replacement.

### Development

- Add isolated and dense Graph renderer comparisons with separate CPU windows.
  Preserve all ordinary Git/button timings and separate RSS observations,
  including slower cases; overall operation speed and memory gains remain unproven.

## [0.1.72154] - 2026-10-22

### Performance

- Update PR decorations without rebuilding an unchanged open PR list for
  Graph, branch and tag messages. Keep actual PR changes, loading, search,
  reviewer controls and IME updates current when messages arrive together.
- Retain list scroll and focus. Clear the active related-section comparison
  when leaving the detail, and resolve related Graph rows in one DOM pass.

### Fixes

- Refresh related commit subjects, authors/dates, loaded state and tooltips
  when the Graph window changes, preserving changed-file DOM and keyboard focus.

### Development

- Add opt-in Node and headless renderer CPU profiles around actual clicks and
  final frames. Keep profiling separate from ordinary latency/resource runs.

## [0.1.72153] - 2026-10-22

### Fixes

- Recheck fsmonitor health when a `--config-env` variable keeps its name but
  changes value. Keep socket and include contexts separate without exposing
  environment values in logs or changing repository configuration.
- Calculate configuration slot bounds once per command snapshot. Preserve
  Native configuration precedence, recovery checks and process ownership.

### Development

- Compare actual Graph buttons with the monitor policy enabled and matched
  environments. Keep process-phase diagnostics outside the extension package.
- Record the rejected environment-copy prototype and its slower actual-button
  latency/CPU results; no overall operation speedup is claimed for this release.

## [0.1.72152] - 2026-10-22

### Fixes

- Keep Jump to Pull Request Row running when a concurrent PR list refresh
  republishes the same repository and authentication context. Preserve the
  selected row and its resolved commit so repeated jumps do not reload it.
- Continue cancelling navigation and clearing resolved commits when the
  repository or authentication context actually changes.

## [0.1.72151] - 2026-10-22

### Performance

- Keep unchanged Graph PR badges and node colors during subsequent metadata
  updates. Index PR associations only for the currently rendered Graph window
  and visit SVG nodes once instead of finding each node repeatedly.
- Preserve keyboard focus on unchanged badges and restore it when displayed PR
  metadata changes. Keep updated titles/comments, moved commit associations,
  the three-badge limit and PR row navigation current.
- Add opt-in final-host-message frame observation and dense PR button comparisons
  to the development benchmarks. Keep all measurement code out of the extension.

## [0.1.72150] - 2026-10-22

### Fixes

- Keep Jump to Pull Request Row working when an overview refresh removes a PR
  that remains visible in search results. Reuse the current search metadata,
  prefer newer overview data, and discard retained results on repository changes.
- Preserve targeted object fetching, explicit branch filters, cancellation,
  local changes and the existing loading, retry and visible-row behavior.

### Performance

- Skip the duplicate local tag query when the current complete ref snapshot
  proves there are no local tags. Keep remote tags and the Native local query
  for tagged repositories, incomplete snapshots and resumed reads.

## [0.1.72149] - 2026-10-22

### Performance

- Reuse one checked source index inspection during private working-tree status
  preparation. Keep complete checksum validation and fresh filesystem fences;
  independently validate the updated Native Git index before restoring stat data.
- Use bounded typed metadata offsets and avoid unnecessary path and padding
  objects. Preserve raw paths, long names, index formats, cancellation and Native
  fallbacks; keep parsed source data within the current read.

## [0.1.72148] - 2026-10-22

### Performance

- Apply loading, completion and error changes without rebuilding an unchanged
  Graph model or PR list. Preserve revision validation, final paint reporting,
  selection, focus, scroll position and automatic page loading.
- Keep the full render path for changed rows, edges, lanes, repository colors,
  resets and empty graphs. Reverify PR row navigation from the lightweight first
  list and missing local objects alongside the Graph update path.

## [0.1.72147] - 2026-10-22

### Performance

- Avoid unused success diffstat and rename summaries for prepared PR squash,
  revert, recovery and branch squash commits. Keep absent partial-clone blobs
  from being downloaded just to print a discarded summary.
- Disable parallel index preload only in known temporary worktrees without
  checked-out files. Keep Native refresh, message/post-commit hooks, signing,
  result-tree checks and branch/index recovery guards.
- Share the prepared-index commit path and log its completion in Git Simple
  Compare Output. Preserve the regular preload policy for full checkouts.

## [0.1.72146] - 2026-10-22

### Fixes

- Bind completed PR, squash and rebase recovery records to the verified result
  commit. Preserve an external commit created while completion is recorded,
  together with local changes, stashes and recovery snapshots.
- Recheck the completed replay checkout before stash restoration and pending
  cleanup. Keep the pending result available when that check fails.
- Retain and reverify Jump to Pull Request Row from the lightweight first list,
  including missing local PR objects, visible row selection and Graph focus.

### Performance

- Reuse the replay queue's known result HEAD during finalization, removing one
  redundant Native Git query while preserving fresh completion checks.
- Extend opt-in resource measurements to the Git operation matrix. Remove
  retained test-mock call arguments from benchmark observation and keep all
  measurement helpers out of the installed extension.

## [0.1.72145] - 2026-10-22

### Performance

- Reuse the final HEAD already returned by completed PR commit-replay and revert
  queues, and skip restoration HEAD/state writes when no stash needs restoring.
- Retain fresh PR preflight checks, per-commit branch guards, conflict results
  and stash recovery records. Preserve the PR Graph row navigation fix from
  0.1.72144.
- Add opt-in benchmark counters for click-to-settled Node, waited native child
  and Chromium CPU, separate from uninstrumented latency measurements. Keep
  profiling code and its Native probe out of the installed extension.

## [0.1.72144] - 2026-10-22

### Fixes

- Make Jump to Pull Request Row work from the lightweight first list, before
  background commit metadata finishes. Resolve only the clicked PR's refs.
- Fetch missing PR objects from the matching repository when using All branches,
  then display their native commit window. Preserve named refs, FETCH_HEAD,
  the index, local edits and explicit branch filters.
- Keep object preparation cancellable with owned transport cleanup and time
  limits, without triggering a Graph reload that cancels its own navigation.

### Performance

- Reuse the last resolved row on repeated clicks while the PR identity is
  unchanged. Invalidate it on repository or PR changes, and skip duplicate
  object checks when a ref lookup returns the same commit IDs.

## [0.1.72143] - 2026-10-22

### Performance

- Preserve warmed untracked-directory metadata after small staging changes in
  large nested repositories by updating only the registered private index with
  Native Git. Reuse completed preparation without repeating the cold scan.
- Compare entries incrementally and batch staging-fingerprint bytes through
  a fixed 64 KiB scratch buffer while retaining existing cache identities.
- Keep the single-query path for flat repositories and sources that already
  contain Native untracked-cache metadata.

### Safety

- Verify the final command and owned index after process preparation. Keep
  private updates cancellable without emitting repository-mutation events.
- Preserve fresh source and repository fences, racy-edit detection, defensive
  fallbacks and ordinary write behavior. Bound Native updates to 128 paths and
  256 KiB, and retain contrary performance evidence alongside passing checks.

## [0.1.72142] - 2026-10-22

### Performance

- Apply local-only branch metadata to loaded Graph commits through a readonly
  cache view, avoiding full-result copies for a small displayed page.
- Adopt uniquely owned calculation results in the cache. Keep defensive Map
  and array copies for mutable callers, using a single-pass clone.
- Preserve snapshot revalidation, shared reads, cancellation, error reporting
  and separate display arrays. Track both old and new read paths in performance
  harnesses so metadata failures remain verification failures.

## [0.1.72141] - 2026-10-21

### Performance

- Skip rename similarity detection when pull, branch and PR preflight checks
  only need to know whether local changes exist.
- Consume status output as a boolean instead of retaining and decoding every
  path. Wait for successful Native Git close and create a fresh reader for each
  existing safe retry, preserving errors and the original write safety checks.

## [0.1.72140] - 2026-10-21

### Fixes

- Make Jump to Pull Request Row reveal the target, close an overlaid drawer
  and move keyboard focus to the Graph. Show localized loading and retryable
  failure states instead of silently ignoring an unavailable commit.
- Preserve merge-result priority, cancel superseded PR window reads and ignore
  late replies. Restore row highlighting after metadata updates without moving
  the user's viewport or keyboard focus again.
- Display locally available PR commits after their source branch is deleted.
  Keep explicit branch filters and avoid fetching or changing refs for a jump.
- Recheck owned macOS fsmonitor health after readiness expires. Close only an
  unresponsive owned child, retain failure cooldowns across writes and prevent
  immediate restart loops after unexpected exits.

### Performance

- Read the Graph history once for all PR commit candidates, then load one
  bounded window. Batch-check local objects only when unrestricted navigation
  cannot find a reachable candidate.
- Bypass builtin fsmonitor IPC for index mutations and index-only comparisons
  using command-scoped settings. Preserve custom hooks and repository settings.

## [0.1.72139] - 2026-10-21

### Performance

- Reduce cold working-tree status scan target batches from sixteen to four,
  matching the existing concurrency limit. Avoid repeated queued index reads
  after PR actions while preserving all paths and argument-size splitting.

### Development

- Validate actual PR buttons and Native operations against an isolated borrowed
  history with 30,311 files and 72,720 commits, without writing to the source.
- Compare remote-tag decorations with independent Native advertisements, and
  remove fresh-fetch benchmark dependence on scenario order.
- Retain every timing sample and contrary result. Git calls decrease, but PR
  replay timing/Node CPU and whole-workload RSS remain mixed; do not claim a
  general PR execution-speed or resource improvement.
- Keep Native status equivalence, index/directory fences, cancellation and
  overall-deadline tests; correct the resource observer's Chromium scope text.

## [0.1.72138] - 2026-10-21

### Performance

- Stream operation Undo index fingerprints instead of buffering the full
  stage listing and allocating a second array of every path. Preserve the
  existing UTF-8 digest, including invalid filename bytes, and unmerged stages.

### Safety

- Complete streamed results only after a successful Git close. Create fresh
  parser/hash state on each existing safe read retry, reject write commands,
  and retain cancellation, time limits and Native ref/operation checks.
- Reject incomplete stage output without storing a partial recovery identity.

### Development

- Add Native large-index and ownership/retry checks plus optional resource
  observation of benchmark Node, Git and headless renderer descendants.
  Keep observer costs separate from uninstrumented timing and retain mixed
  whole-workload CPU and latency results; this is a scoped memory/Node CPU
  improvement, not a general operation-speed claim.

## [0.1.72137] - 2026-10-21

### Performance

- Release PR action busy state and start the deferred Graph refresh when Git
  finishes, while nonmodal success/error notifications remain open.
- Run automatic prerequisite inspection after conflict handling completes.
  Cancel superseded inspections and inspections for a departed repository.

### Safety

- Bind notification Undo to the original branch, snapshot and before/after
  commits. Reject an old notice after a newer operation, preserve Native
  confirmation-time validation, and give late Undo its own busy/refresh cycle.
- Release notification callbacks on repository switch or panel disposal, bound
  pending callbacks, and avoid duplicate Undo preflight reads.

### Development

- Add lifecycle, Native late-Undo and three-viewport PR button checks. Compare
  production PR buttons with a modeled notification delay; retain every timing
  sample and distinguish notification latency from Native Git execution speed.

## [0.1.72136] - 2026-10-21

### Performance

- Bound Node buffer usage during protected Git index publication to 256 KiB,
  using the actual index size for smaller files. Continue writing through the
  owned lock handle with fsync, inode checks and atomic rename.

### Fixed

- Complete short index writes, stop zero-progress writes, and close the source
  handle after failed reads without publishing a partial index.

### Development

- Add a Native index publication resource benchmark and actual PR squash/replay
  button measurements through the production renderer and registered callback.
  Retain mixed or slower timing samples; the measured benefit is lower buffer
  usage, without a general PR latency or whole-application resource claim.

## [0.1.72135] - 2026-10-21

### Fixed

- Enforce the reusable Graph snapshot's estimated size limit before scanning
  result entries, including an empty result with a large metadata key. Preserve
  reuse for small empty results and all fresh-snapshot validation checks.

### Development

- Reproduce the empty-result boundary failure and verify the fix alongside
  Native fetch/checkout/upstream/shallow/unknown-history regressions. Performance
  measurements remain explicitly tied to the 0.1.72134 source before this guard.

## [0.1.72134] - 2026-10-21

### Performance

- Revalidate the previous local-only marker result after unchanged fetch and
  loaded checkout instead of walking the same Git DAG again. Require fresh
  local and remote metadata, identical full refs and history/executable proof.
  Apply validated markers before posting the next Graph frame.
- Read only the selected branch identity for branch menus and clone source
  lookup. Preserve a separate fresh check immediately before checkout.

### Safety

- Discard reusable candidates when upstreams, refs, replacements, shallow/graft
  boundaries, Git environment or executable selection change or are uncertain.
  Require both new metadata reads and never reuse a partial or failed result.
- Retain at most one bounded candidate; drop large results and hidden/disposed
  candidates. Preserve existing generation, cancellation and process ownership.

### Development

- Cover actual fetch/checkout, upstream and shallow changes, candidate bounds,
  existing Native operation and process-lifecycle regressions. Measure all named
  operations and final production-renderer metadata without OS focus changes.
- Observe cache readiness without invoking an adoption method from the harness.

## [0.1.72133] - 2026-10-21

### Improved

- Give PR lists a clear title/state, author/update time, reviewer and action
  hierarchy. Wrap long titles, use readable review labels and theme-based state
  icons, and expand loaded reviewers in place with keyboard and focus preserved.
- Reuse existing PR data without external avatar downloads or extra PR requests.

### Performance

- Avoid hydrating shared promisor objects while estimating a push. When local
  metadata is missing, ask the actual push server for a common commit without
  downloading objects, verify the result locally, and size only the remainder.
- Let the actual push negotiate again when a shared base was established.
  Keep this override scoped to that push and preserve the user's configuration.
- Skip index-monitor preparation for the fixed object-free negotiation query.

### Safety

- Preserve fresh source/configuration validation and destination leases. A
  negotiated base never becomes the lease for a new destination.
- Keep complete sizing on unsupported or unrelated servers. Preserve original
  errors, cancellation, read deadlines, and bounded metadata buffers.

### Development

- Cover real partial clones, staged/unstaged/untracked preservation, successful
  and rejected sequential pushes, and actual push-button/Graph comparisons.
  Retain slow samples, sandbox-related test failures and an incomplete 64MiB
  baseline UI comparison without treating them as successful timing evidence.

## [0.1.72132] - 2026-10-21

### Performance

- Check the current upstream with one Native Git read before a normal pull.
  Read the full remote branch catalog and tracking counts only when connection
  setup is needed. Keep the actual pull's fresh checkout and configuration
  validation, conflict handling and recovery checks.

### Fixed

- Preserve detached, unborn, missing and local upstream behavior while
  propagating repository and configuration failures instead of opening setup.
- Wait for the actual initial PR/stack busy lifecycle before measuring Graph
  buttons, keeping background startup reads out of the comparison interval.
  Retain the original overlapping samples as diagnostic evidence.

## [0.1.72131] - 2026-10-21

### Added

- Show PR authors, requested reviewers and latest review states in the list,
  detail header and hover. Include team names and loaded reviewers in search,
  preserve keyboard navigation, and distinguish loading, unavailable, empty
  and capped results. Reuse the existing bounded metadata batches.

### Fixed

- Discard selected merge, rebase and cherry-pick conflicts against HEAD,
  including files deleted in HEAD. Explain conflict resolution in the existing
  confirmation and preserve other staged changes, operation state and refs.
- Reject changed conflict stages or restarted operations before restoring.
  Invalidate status after partial failures and restrict untracked deletion to
  selected files inside the repository.

### Performance

- Scope small discard reads to selected paths and cap concurrent untracked
  deletions at eight. Local comparisons show lower service latency; the bulk
  case uses more Node CPU, so total resource improvement is not established.
- Add optional actual-button wait diagnostics without instrumenting normal
  operation or comparative benchmarks.

## [0.1.72130] - 2026-10-21

### Fixed

- Recheck repository metadata before publishing rebase recovery state. Stop
  linked-worktree metadata replacement from redirecting writes to another
  repository or publishing a stale snapshot.
- Exclusively own session temporary files and remove them on write or rename
  failure. Preserve the previous state and other writers' temporary files.
- Verify checkout again after loading canonical session metadata, including
  switches to another branch at the same HEAD.

### Performance

- Share private recovery paths only within one action. Reduce checkpoint reads
  from three Git processes to two, completed-result recording from four to two,
  and paused-result recording from six to three. Preserve canonical messages,
  files, fresh checkout checks and native generation validation.

### Development

- Cover recovery races, I/O failures and normal/linked worktrees with Native
  Git. Retain all actual rebase-button comparison samples: fewer processes are
  established, while consistent end-to-end latency and total CPU gains are not.

## [0.1.72129] - 2026-10-21

### Performance

- Validate interactive rebase topology and complete todo coverage in one fresh
  hash/parent query. Avoid loading unused commit bodies on a valid Start and
  remove the separate merge-range scan. Preserve full metadata for UI/recovery
  and missing-todo diagnostics.

### Fixed

- Reject malformed, truncated, duplicate and merge range records before queue
  creation. Keep both fresh checkout checks and metadata replacement guards.
- Keep failed coverage failed when diagnostic labels observe a later HEAD.

### Development

- Cover actual SHA-1/SHA-256 root rebases, original large-message preservation
  and linked metadata replacement. Record direct Start and rendered-button
  comparisons, including slower samples and a common-editor-path diagnostic;
  this release claims less metadata and fewer queries, not a general UI speedup.

## [0.1.72128] - 2026-10-21

### Performance

- Find a nearby published first-parent base when many advertised branches put
  it outside the first 64 verified tips. Reuse the existing recent-commit query
  with at most 65 rows and retain all existing exclusions plus one source-proven
  base, avoiding unnecessary history estimation and repeated push updates.

### Fixed

- Keep original DAG checks, the actual push server advertisement, fresh
  source/configuration checks and empty initial destination leases. Never
  exclude an unadvertised local base or use it as the destination lease.

### Development

- Cover a real already-published 50MiB object, staged/unstaged/untracked edits,
  concurrent destination creation and a server advertising 2,049 branches.
- Compare actual Native pushes with identical baseline/candidate fixtures and
  retain local receiver updates, scoped Node CPU and full timing samples.

## [0.1.72127] - 2026-10-21

### Fixed

- Disable lazy fetching in published-tip existence checks during push planning.
  On Git versions supporting `GIT_NO_LAZY_FETCH`, unknown promisor commits stay
  unknown instead of triggering downloads. Preserve the original DAG settings,
  cancellation, deadlines and the actual push's object-fetching policy.

### Development

- Verify final Graph metadata against an independent fresh Native snapshot and
  reject swallowed marker-read failures in service and rendered-button audits.
- Compare all 18 operation scenarios and four actual button flows three times
  per source, retaining slower samples and scoped CPU/memory measurements.
- Reproduce implicit promisor fetching with Native Git and verify both streamed
  and buffered checks leave objects, index, configuration and HEAD unchanged.

## [0.1.72126] - 2026-10-21

### Performance

- Exclude locally verified history advertised by the actual push server before
  estimating a new destination's outgoing objects. Avoid first scanning the
  entire existing history and then repeating the object-size calculation.
- Share destination and published-branch discovery when setting an upstream.
  Keep ordinary tracked pushes on their exact destination lookup.

### Fixed

- Keep published history separate from the destination lease. Preserve empty
  initial leases, source/configuration checks, push URL separation, and
  conservative handling of missing or non-commit advertised objects.
- Reject duplicate destination records before selecting a remote OID.

### Development

- Record the running extension version at activation to distinguish installed
  packages from sessions that have not reloaded.
- Compare actual pushes over an existing immutable object history using owned
  temporary bare receivers. The original repository is read-only; no checkout,
  object copy or external network transfer is required.
- Extend read-only Graph diagnosis to fingerprint, local-only and working-tree
  stages, recording aggregate metrics without source paths or file contents.

## [0.1.72125] - 2026-10-21

### Performance

- Reuse the Git directory returned by a fresh checkout read when checking for
  an existing operation. Remove one Git process from interactive rebase Start
  and a duplicate pre-confirmation path lookup, retaining fresh checkout checks.

### Fixed

- Remove consumed input todo files when the bundled sequence editor reaches a
  successful edit pause. Preserve pending rewrite commands, message queues and
  custom helpers' input lifetime.
- Preserve existing native rebase state during service inspection and propagate
  checkout read failures before creating a new operation.

### Development

- Exercise rendered push, pull, fetch and interactive rebase buttons through the
  registered extension message callback with Native Git and headless Chromium.
  Compare final HEAD, refs, parents and local-only markers with fresh reads.
- Add a read-only existing-repository diagnosis that records aggregate timings
  without branch names or commit contents. Retain contradictory timing samples;
  this release claims fewer queries, not a general latency or CPU improvement.

## [0.1.72124] - 2026-10-21

### Performance

- Copy the bundled interactive rebase todo with the system copy tool on macOS
  and Linux, avoiding one Node/Electron editor startup per rebase. Keep custom
  commit-message editing and continuation queues on the existing helper.

### Fixed

- Validate the bundled helper content before replacing its sequence editor.
  Keep custom scripts, unsupported environments and independent callers on
  their existing path. Delegate copy failures and non-file targets to the
  original helper, preserving its failure behavior.
- Preserve both fresh checkout checks, native conflict and autostash handling,
  and temporary-state cleanup around rebase Start.

### Development

- Profile actual rebase Start with a common baseline/candidate harness, keeping
  extension Node CPU, Git and waited-child CPU, per-command RSS and editor wall
  time separate. Add literal-path, custom-helper and copy-failure checks.

## [0.1.72123] - 2026-10-21

### Performance

- Pipe outgoing object IDs directly from `rev-list` into `cat-file` with
  backpressure, so push size estimation no longer retains the complete object
  list as a Buffer and string in the extension process. Preserve exact size
  validation and existing transfer plans and leases.
- Buffer Git's batch size output to avoid flushing after each object while
  keeping the extension-side input and output streaming.

### Fixed

- Drain abandoned producer output when a read pipeline stops, including when
  the producer has already exited while its consumer is blocked. Await both
  owned reads and their verified descendants before reporting cancellation.
- Reject early successful consumer exits and preserve the original Git,
  metadata-parser or timeout failure when the sibling read is cancelled.
- Preserve the former two-query deadline budget under backpressure so slow
  producers and consumers do not introduce earlier planning timeouts.

### Development

- Add Native Git size-sum and push checks, bounded-transport, blocked-output,
  cancellation, timeout and resistant parent/child process tests. Compare actual
  packed-object queries separately from synthetic large-list transport.

## [0.1.72122] - 2026-10-21

### Fixed

- Avoid splitting a new branch's already-published base history into repeated
  pushes. When the whole-history estimate crosses the size threshold, inspect
  other branches at the actual push URL and exclude locally verified published
  commits from the outgoing object estimate and sequence.
- Keep the destination lease separate from shared history. A newly created
  destination still requires an empty initial lease for sequential publication;
  concurrent remote changes remain protected.

### Performance

- Publish small new changes in one update even when an already-published base
  contains large objects. Split genuinely new large changes using only their
  new first-parent commits. Preserve full sequencing for an empty remote.
- Stream published-object metadata and bound the selected exclusion tips to 64.
  Preserve the existing paths for small histories and existing destinations.

### Development

- Add actual receiver-hook counts, a real 50MiB shared-base check, local-change
  preservation, distinct push/fetch URL, unknown-object and concurrent-creation
  tests. Record Native timings separately from Graph correctness checks.

## [0.1.72121] - 2026-10-21

### Performance

- Reuse the verified Git directory and private message-queue path within one
  interactive rebase Start. Keep both fresh checkout guards and read native
  operation files and queued messages again at every required boundary.
- Route operation detection through the shared directory reader so scoped branch
  and PR operations can also avoid repeated path-only Git processes.

### Fixed

- Release temporary todo and rewrite files when message-queue initialization or
  cleanup fails. Stop cached-path access if repository metadata changes, before
  writing recovery state in a different repository.

### Development

- Add Native rebase checks for successive Starts, linked worktrees, external
  commits during preparation and metadata replacement before queue creation.
- Extend the operation benchmark to ordinary tracked push, fresh-history pull
  and checkout outside the loaded Graph page. Keep service time, first frame,
  final frame and resource measurements separate.
- Count Native Graph history reads at the Git boundary and verify that injected
  index errors reach both read boundaries even when Git has global options.

## [0.1.72120] - 2026-10-21

### Performance

- Cancel obsolete Graph tag reads on hide, loss of focus, repository changes,
  branch filters, history jumps and disposal. Wait for owned reads to close before
  starting the latest replacement, and skip superseded queued requests.
- Read at most four remote tag catalogs per query. Keep up to 128 recent idle
  remote-cache entries while protecting active consumers and closing processes.

### Fixed

- Classify remote enumeration as a read so it does not emit false write events
  and invalidate shared status results. Keep remote mutations protected.
- Skip explicit write-process termination when spawn failed without a child PID.
- Keep shared remote tag reads alive for other consumers when one view cancels.
  Terminate the read when its last consumer leaves and await actual process close.
- Resume interrupted tag metadata once when a loaded Graph returns or replaces
  its history window, without reloading completed history or repeating ready tags.
- Propagate cancellation through local tags, remote discovery and remote reads.
  Keep cancelled results out of completed cache and out of the current Graph.

### Development

- Add actual child-process cancellation checks, Native annotated/lightweight tag
  verification, cache pressure and shared-consumer tests. Record the previous
  version's orphaned reads without treating the fixture as a network benchmark.

## [0.1.72119] - 2026-10-21

### Performance

- Publish a proven Graph branch-filter catalog once per refresh. Keep separate
  pending and ready updates when remote branches still need to be read.
- Build branch-menu rows when the menu opens and defer offscreen row layout in
  ordinary mode. Release an obsolete hidden catalog when new options arrive.
- Send only fields used by the branch menu and avoid duplicating every selected
  branch name in all-branches mode.

### Fixed

- Preserve checkbox choices, compact mode, search selection, keyboard focus and
  list scroll while branch options update. Retain selected remote branches that
  have not loaded yet and reflect clear-all/select-all actions immediately.
- Keep the branch menu inside narrow windows. Disable row-layout skipping in
  VS Code screen-reader mode so the complete checkbox catalog is exposed.

### Development

- Add repeatable closed-menu and first-open browser measurements, with Native
  operation catalog counts and serialized payload sizes. Keep browser task time
  separate from benchmark Node CPU, and preserve slower prototype measurements.

## [0.1.72118] - 2026-10-20

### Performance

- Publish the first Graph history page while branch details are still loading,
  when the existing Native log and fresh ref snapshot prove the same checkout.
  Reuse the original page and keep unknown tracking values out of the UI.
- Preserve the existing reference-refresh path and its marker cache. Apply early
  publication to fresh first pages without adding marker work to loaded history.
- Skip identical branch-filter snapshots so late details keep an open menu's focus.

### Fixed

- Reject late branch details from a different checkout or ref set and reconcile
  from a fresh snapshot. Keep verified history readable on cancellation or error.
- Preserve keyboard focus on branch chips during detail updates and provide
  accurate disabled-button guidance while upstream details are unavailable.

### Development

- Record initial-history and final-frame measurements separately, with Native
  branch-read timing and exact current-branch checks in headless production HTML.
- Preserve the slower prototype measurements and CPU limitations in the report.

## [0.1.72117] - 2026-10-20

### Performance

- Stop PR pending-change checks after detecting staged changes. Read the index
  without filesystem-monitor preparation and skip the redundant working-file scan.
- Commit the index already prepared by branch squash merges, avoiding a second
  full staging pass in both current and isolated worktrees.

### Fixed

- Keep edits made after a squash merge out of automatic staging. Preserve native
  merged content while leaving unrelated tracked and untracked edits in place.
- Propagate pending-change read failures instead of treating every error as a
  positive result. Detect staged submodule pointers even with diff ignore settings.

### Development

- Add Native index-preservation, concurrent-edit and failed-read checks, plus a
  repeatable benchmark for staged, unstaged, clean and cancelling changes.

## [0.1.72116] - 2026-10-20

### Performance

- Share exact local-only commit ranges between branches with the same upstream.
  Keep single-branch reads small, bound grouped output estimates, and preserve
  the existing full-history strategy when grouping would add Git processes.
- Narrow large single-upstream ranges without reading excluded old history.
  Keep branch membership and ordering identical to native ancestry results.
- Decode only active branch memberships, reuse consecutive membership masks,
  and release processed ancestry states while keeping result arrays independent.

### Fixed

- Stop queued local-only range reads after the first failure, cancel active
  siblings and await their termination before returning the original error.
  Keep partial results out of the completed cache and log failed reads.

### Development

- Add independent native ancestry checks, real child-process cleanup tests and
  repeatable range benchmarks. Verify final Graph marker frames separately
  from the first history frame in headless operation measurements.

## [0.1.72115] - 2026-10-20

### Performance

- Read the current checkout and upstream commit together during ordinary push
  planning. Retain native fallback for missing upstreams and ambiguous HEAD names,
  plus fresh source, configuration and lease checks before every transfer.
- Reuse Git's verified index location while repository metadata and the execution
  environment stay unchanged. Read index contents and working-tree changes afresh.
- Overlap checkout and unmerged-index verification before branch and PR operations.
  Read PR conflict stages without preparing a filesystem monitor.

### Fixed

- Stop branch operations when unmerged verification fails. Preserve target
  timeout and process-access errors instead of reporting a missing branch,
  and await all preparation reads before proceeding or failing.
- Discard status results when repository metadata is repointed during a read,
  then resolve the new index without modifying either repository's actual index.

### Development

- Add repeatable five-sample push and status preparation benchmarks, repository
  replacement checks, and coverage for SHA-256 and linked-worktree push planning.

## [0.1.72114] - 2026-10-20

### Performance

- Prepare the first Graph history page alongside a native branch snapshot.
  Adopt it only after validating the current checkout and loaded local refs;
  retain the serial path for batched tracking and uncertain history.
- Bound completed Git activity records to 512 recent roots plus active roots.
  Avoid scanning old worktree history for monitor activity checks while keeping
  unfinished writes, reads and owned monitor aliases protected.

### Fixed

- Cancel unused first-page reads on hide, repository or filter changes and
  metadata failures. Keep their results outside the containment index until
  adopted, and propagate history timeouts without repeating the same read.

### Development

- Add repeatable activity-record resource measurements and real Git coverage
  for first-page adoption, cancellation and damaged-ref fallback. Record both
  improvements and slower samples from headless Graph operation measurements.

## [0.1.72113] - 2026-10-20

### Performance

- Record a PR recovery snapshot and both latest pointers in one Git ref
  transaction on supporting Git versions, reducing three write processes to one.
  Cache only explicit unsupported-command responses for the legacy fallback.
- Skip filesystem-monitor preparation for index-free ref and object writes.
  Keep ordinary index reads and writes under the existing monitor policy.

### Fixed

- Keep existing recovery snapshots and Undo records when a snapshot transaction
  is rejected by a ref lock or hook. Update symbolic pointers directly and
  require new immutable snapshot refs instead of overwriting existing refs.

## [0.1.72112] - 2026-10-20

### Performance

- Copy large Graph ref catalogs only for the selected watcher request. Twenty
  overlapping notifications now copy one catalog while retaining independent
  cancellation, one final reload and isolated consumer metadata.

### Fixed

- Reconcile Graph history when shallow/graft metadata cannot be verified, even
  when refs are unchanged. Invalidate ancestry-derived branch markers before
  reading changed or uncertain history.
- Distinguish Git's synthetic shallow/replace annotations from real branch
  names and preserve commas in branch and tag names.
- Allow the Graph renderer's row-position and branch-color style attributes
  under its production CSP while keeping scripts restricted by nonce.

### Development

- Verify real Git operations through production Graph HTML and frame responses
  in headless Chromium. Add repeatable watcher CPU/allocation measurements.
- Remove native smoke tests' forced app activation, always-on-top and window
  movement. Stop native measurements on focus loss and require explicit
  `--allow-visible-host` before opening an Extension Development Host.

## [0.1.72111] - 2026-10-20

### Added

- View saved stash contents and staged stash changes from the Stashes menu or
  Command Palette without applying them. Read untracked files from the stash's
  third parent and preserve original paths for renamed files.
- Show loading, empty and retry states for stash files; support keyboard opening
  and keep the selected repository and commit fixed while a file picker is open.

### Performance

- Share private metadata paths within one branch or PR operation, with fresh
  checkout checks and repository identity validation at each access.
- Reuse verified graph history after fetch, pull and other actions when its
  reachable commits are unchanged. Share bounded branch metadata with direct
  fingerprints while retaining large-repository and damaged-ref fallbacks.
- Remove duplicate push preparation reads after full plan validation; retain
  fresh source/configuration checks before every transfer and upstream update.
- Bound host and webview stash metadata caches and keep menu tooltips outside
  the choices they describe.

### Fixed

- Preserve direct graph refresh requests across focus or visibility loss,
  including cancellation during fingerprint reads. Avoid partial background loads.
- Detect shallow/graft boundary changes before reusing a graph and refresh
  caches and views after partially failed Git operations.

## [0.1.72110] - 2026-10-20

### Performance

- Prepare the native editor connection and reference while Block Author is loading.
  For opaque listeners, capture the editor during a normal Code Vision refresh
  without a full heap query. Preserve method receivers, arguments, results and
  errors; restore temporary observers on capture, cancellation or their short deadline.
- Keep preparation invisible: no gutter rows or width changes until a Block Author
  click. Reuse validated Code Vision data and the editor service across tabs;
  retain metadata checks, the 60-second age limit and the compatible discovery fallback.
- Remove the inspector's unconditional 500ms wait and validate the host's main PID
  before scanning the full process table. Distinguish Helper processes and separate
  profiles, including Development Hosts whose first argument is a workspace path.
- Add an isolated real VS Code smoke for first paint, single-column toggling,
  width restoration and one Git blame read per file, plus Chromium observer
  lifecycle and method-preservation coverage.

## [0.1.72109] - 2026-10-19

### Fixed

- Restore Changes file diffs and Hunk controls when Git's filesystem monitor is
  unresponsive. Read stage-zero blob contents and missing-path checks with a
  command-scoped monitor bypass, preserving repository settings, index and files.
- Scope diff-open waits to the affected document so another ready editor group's
  Hunk controls can appear. Keep pending groups in snapshot order without drawing
  controls, and avoid guessing a file target when visible diff groups are ambiguous.
- Cover Staged/Unstaged clicks through actual Git content and Hunk generation,
  blocked monitors, overlapping opens and multiple editor groups. Verify Changes
  requests and native checkbox placement at 390, 768 and 1440 pixels.

## [0.1.72108] - 2026-10-19

### Performance

- Prepare Block Author for the focused active saved file before the editor's
  CodeLens request. Share that work with provider requests and cancel it on
  tab changes, edits, focus loss or disabling CodeLens.
- Start blame while a slow language-symbol request is pending. Keep quick
  symbol-free files free of blame processes and cancel unnecessary speculative reads.
- Reuse document symbols across repository refreshes and focus recovery.
  Validate completed ownership snapshots instead of discarding unchanged results.
- Reuse the full Code Vision blame result when opening the gutter, removing
  repeated repository discovery and blame reads. Verify HEAD, index, file,
  configuration and nested repository boundaries before reuse; fall back to
  normal Git discovery when validation fails.
- Read independent cache metadata in parallel and remove the duplicate
  identity read before Code Vision blame. Bound retained file snapshots and
  report repository, symbol and prepared-gutter timing separately in Output.

## [0.1.72107] - 2026-10-19

### Performance

- Find the active blame editor through existing event-listener receivers or
  closures before using a full heap query. Keep URI/visibility checks, reuse
  the editor service on subsequent opens and retain constructor discovery
  for opaque listeners.
- Parse large blame output without a full split array or per-line commit
  metadata copies. Preserve original lines, filenames and commit identities.
- Reuse indexed block ranges when summarizing ownership, avoiding repeated
  filtering, array copies and sorting inside each overlapping block.
- Report editor discovery source/calls/heap queries and separate Code Vision
  lookup, blame, summary and gutter preparation timings in Output.
- Add `npm run benchmark:blame -- --baseline-ref <commit>` for repeatable,
  paired 50,000-line CPU measurements with result-equivalence checks.

## [0.1.72106] - 2026-10-19

### Fixed

- Remove the legacy before-line blame decorations that could appear alongside
  the native Block Author gutter, including automatic background reads from an
  old `blameLine.show` setting.

### Changed

- Open and toggle one blame gutter through Block Author Code Vision. Clicking
  any hint in the same file closes the column or cancels its pending read.
- Remove duplicate blame toolbar switches, the retired line-label setting and
  separate file-annotation show/toggle commands, menus and Ctrl+Alt+B shortcut.
  Keep Escape, line history, commit details and annotation display settings.

## [0.1.72105] - 2026-10-19

### Added

- Open file blame directly from the line-number menu, Command Palette or
  Ctrl+Alt+B (macOS: Cmd+Alt+B), including files without language symbols.
  Escape closes owned annotations without changing global settings.
- Configure author/date formats, short commit hashes, compact consecutive
  commit labels and cursor-commit line highlighting using the current theme.
- Open Line History from the editor, line-number menu or blame popup. Trace
  the saved line's original position through historical edits and renames,
  load additional changes on demand and open the selected historical file diff.

### Changed

- Reformat cached annotations without rerunning blame. Reuse relative-date
  formatters and index commit ranges once instead of scanning on cursor moves.
- Batch visible-row measurements, preserve focusable per-line actions in
  compact mode and repeat labels at the visible group boundary.
- Decode C-quoted Git filenames correctly and render root-commit diffs with
  an empty original side even when the empty-tree object is absent.

## [0.1.72104] - 2026-10-19

### Added

- Inspect PR prerequisites from the PR action menu and preserved apply-operation
  toolbar. Conflict notifications identify candidate PR numbers and distinguish
  verified application order from unverified relationships.
- Find candidates through loaded stack relationships, conflicting source-file
  history, commit-to-PR associations and explicit prerequisite references.
- Simulate candidate-then-PR application without changing working files, index
  or branch refs. Distinguish satisfied changes, resolved/reduced conflicts and
  unrelated edits, including prior squash applications under different hashes.

### Changed

- Reuse loaded PR metadata, batch GitHub discovery/detail requests and bound the
  diagnosis. Preserve partial results when the shared deadline is reached, and
  keep cancellation and unavailable metadata distinct from no prerequisites.
- Run automatic diagnosis only after apply conflicts; successful PR operations
  keep their existing path without extra prerequisite or GitHub reads.
- Check unmerged index entries directly instead of scanning working files.

## [0.1.72103] - 2026-10-19

### Changed

- Apply verified PR merge histories as one final squash delta, including base
  updates and unordered commit lists, to avoid intermediate replay conflicts.
- Validate the external parent boundary and exact commit range before combining
  a merged history; exclude base-only changes from other destination branches.
- Find saved PR operations before object preparation, fetching or merge-tree
  calculation, including squash, rebase and revert preparation.
- Read the destination branch and HEAD together, reuse the verified PR tree at
  its exact base, and skip redundant temporary-worktree scans for computed trees.

### Fixed

- Replay a verified single merge source without guessing its mainline on older
  Git versions. Preserve real final-delta conflicts and existing recovery/Undo
  protections for staged and unstaged local changes.

## [0.1.72102] - 2026-10-19

### Changed

- Resume conflicted temporary PR operations directly in the existing Conflicts
  view, with Continue PR Operation and Return to Working Tree actions.
- Save the remaining squash/rebase/revert queue and original destination so
  conflict resolution can continue after reloading the window. Repeated actions
  reuse a saved operation instead of recreating the same conflicting worktree.
- Keep all squash apply/revert operations isolated, including clean working trees.

### Fixed

- Continue genuine modify/delete and content conflicts after explicit file
  resolution, including multiple conflicts across a PR's remaining commits.
- Keep the Conflicts view and PR continuation action visible after resolving the
  last file. Preserve original local changes, staged additions and prepared results.
- Recheck the destination branch and HEAD while the real index lock is held;
  refuse unrelated or replaced Git operations and protect pending recovery
  worktrees from cleanup. Keep source commits reachable until recovery finishes.

## [0.1.72101] - 2026-10-19

### Changed

- Calculate squash cherry-picks and squash reverts from the complete, verified
  PR delta, avoiding conflicts caused only by intermediate commits.
- Prepare conflict-free squash results without checking out a second copy of
  the repository or scanning the current working tree before applying them.
- Batch revert parent checks and current-branch containment queries instead of
  starting separate Git processes for every PR commit.
- Keep commit-by-commit rebase behavior and fall back to native replay for
  unsupported Git versions or PR histories that cannot be safely aggregated.

### Fixed

- Treat deletion-only edits to an already deleted regular file as satisfied
  after checking the conflict type, modes, exact source blobs and line counts.
  Preserve content, binary, mode and rename conflicts for manual resolution.
- Keep prepared PR results and recovery snapshots when concurrent edits or
  branch changes prevent applying them. Verify the committed tree before
  changing the destination branch, and retain existing Undo protections.
- Protect staged new files while applying temporary-worktree results,
  including additions outside sparse-checkout patterns.

## [0.1.72100] - 2026-10-19

### Changed

- Refresh HEAD and branch badges after checkout and push without waiting for
  working-tree status or commit-containment preparation. Reuse loaded history
  only when current ref tips and known parent links prove it is unchanged.
- Share action refreshes with the graph lifecycle so matching watcher events
  do not reload the same result, and defer hidden-panel reads until visible.
- Reconcile pagination with Git's current ordering after history reuse, and
  include stash, recovery refs and linked-worktree HEADs in refresh decisions.

### Fixed

- Notify the open graph immediately after Changes checkout, branch rebase,
  squash merge and Undo, including failed or conflict-paused operations.
- Preserve fresh HEAD, remote aliases and renamed branch badges while keeping
  late status results from overwriting newer operations.

## [0.1.72099] - 2026-10-19

### Changed

- Return the first complete working-tree snapshot in large repositories without
  waiting for Git to build an optional untracked-directory cache. Bound native
  Git enumeration to four concurrent reads and preserve ignore rules, nested
  repositories, literal filenames and staged changes.
- Prepare the directory cache afterward in a separate extension-owned index,
  then reuse it for later reads and new sessions without changing the real index.
- Share the configured overall read deadline across the initial scan, honor an
  unlimited timeout, and cancel queued and running work when the read ends.

## [0.1.72098] - 2026-10-19

### Changed

- Read the first working-tree snapshot without waiting for filesystem monitor
  startup or its response check. Check monitor health in parallel with a full
  scan of the extension-owned status index.
- Reuse a confirmed healthy monitor for later reads while preserving custom
  monitor hooks, command-scoped fallback, cancellation and process cleanup.

## [0.1.72097] - 2026-10-19

### Changed

- Share filesystem monitor preparation between working-tree status and literal
  untracked-file expansion to avoid a second wait for the same stalled monitor.
- Keep configuration-specific monitor preparation separate while preserving
  the original commands' filename matching and complete file results.

## [0.1.72096] - 2026-10-19

### Changed

- Start the initial GitHub PR request alongside rebase restoration and local
  stack loading, while preserving complete metadata and final snapshot order.
- Check built-in filesystem monitor responses before the first index operation
  and bypass an unresponsive monitor within the command scope.
- Read conflict stages and Undo index snapshots without filesystem monitor IPC.

### Fixed

- Keep a completed native rebase separate from failed-start recovery when Undo
  recording or local-change restoration fails afterward.
- Preserve the completed branch, stash and recovery snapshot for safe follow-up
  processing, and prevent uncertain stash restoration from running twice.
- Suppress stale PR and rebase publications after repository changes or disposal.

## [0.1.72095] - 2026-10-18

### Changed

- Display the first Git Graph history without waiting for working-tree status.
  Keep commit selection and pagination available while virtual rows load.
- Show independent loading, paused and unavailable working-tree states with
  localized recovery guidance while keeping commit history visible.

### Fixed

- Preserve loaded history, selection and the visible commit when working-tree
  rows arrive after the initial graph.
- Resume pending status after an unsuccessful commit-window jump, retain status
  errors across focus changes and avoid posting to disposed graph webviews.

## [0.1.72094] - 2026-10-18

### Changed

- Finalize the maintenance release containing the PR refresh and multi-file
  hunk optimizations from 0.1.72093.

## [0.1.72093] - 2026-10-18

### Changed

- Refresh an unchanged 80-PR page in one GitHub request. Reuse complete commit
  lists and file counts only after checking the latest repository, head, base
  and target branch; always refresh titles, states, labels and review comments.
- Fetch full metadata only for changed PRs while preserving list order, cursor,
  complete pagination and cancellation. Keep the initial loading path lightweight.
- Batch selected-file hunk validation and whole-file unstage operations to avoid
  starting separate Git processes for every selected path.

### Fixed

- Preserve rename detection compatibility, literal filenames and fresh checks
  after index-lock retries during multi-file hunk actions.
- Restore deleted index entries correctly, retain unselected lines when
  unstaging new files and preserve both sections of file-type changes.
- Require whole-file unstage for file-type changes so partial selections cannot
  unstage additional content.

## [0.1.72092] - 2026-10-18

### Changed

- Prepare push plans without traversing the upstream commit history, and reuse
  the current configuration read to retain the lightweight path for small repos.

### Fixed

- Preserve native Git handling of missing, moved, tagged and corrupt upstream
  objects, custom tracking mappings and unusual remote names during push planning.

## [0.1.72091] - 2026-10-18

### Changed

- Reduce Git preparation and refresh work for checkout, rebase/merge, push,
  fetch and pull. Batch tracking counts for large branch lists and keep small
  or already current lists on the lightweight read path.
- Avoid redundant message editor startup during rebase when commit messages
  remain unchanged, and reuse verified worktree paths for custom messages.
- Share conflict metadata and content reads, cancel obsolete requests and
  refresh saved resolutions without repeatedly scanning unchanged documents.
- Keep Graph checkout updates local to changed rows and reuse existing graph
  layout, file-list state and keyboard focus. Virtualize large Changes and
  rebase file lists while preserving the complete selection and edit plan.

### Fixed

- Preserve rebase messages for SHA-256 repositories and keep custom-message
  queues correct across edit pauses, conflicts and linked worktrees.
- Keep cancellation, undo and recovery checks intact while reducing duplicate
  repository queries, and reject obsolete refresh results after context changes.
- Align the PR preview design-contract test with the current Graph-to-Preview
  navigation rule instead of an obsolete narrative phrase.

## [0.1.72090] - 2026-10-09

### Added

- Start with Git Simple Compare from the Source Control welcome. Clone by URL
  or SSH, choose public/private/organization GitHub repositories, open an
  existing repository, or initialize a folder through the extension's own Git.
- Connect completed setup to Changes, including after opening a folder or
  adding a repository to the workspace. Offer progress, cancellation, retry
  and Git executable diagnosis while preserving existing folders and files.
- Automatically push commits oldest first when a normal push has multiple
  outgoing commits and at least 50 MiB of new Git objects before compression.
  Show confirmed progress, stop on failure or cancellation, and resume from the
  actual remote tip while protecting concurrent updates with explicit leases.

### Changed

- Use the extension's own Git CLI by default. The optional VS Code Git status
  reuse setting leaves `git.enabled`, `git.autorefresh` and `git.autofetch`
  unchanged, including existing user and workspace overrides.
- Share simultaneous repository discovery, reject obsolete cache results,
  remove duplicate onboarding refreshes and keep branch reads fresh.
- Consolidate push validation and stream object-size metadata to reduce repeated
  Git execution and output buffering while retaining source/destination checks.

### Fixed

- Keep startup clone and initialization available with built-in Git disabled,
  using independent GitHub authentication and transient clone credentials.
- Preserve repository paths containing newlines during combined discovery and
  honor reduced-motion preferences in onboarding progress indicators.

## [0.1.72089] - 2026-10-07

### Changed

- Match the native Git blame hover with author identity, relative and exact dates,
  the complete commit message, co-authors and actual file/addition/deletion counts.
  Use VS Code theme colors for statistics and native Codicons for commit actions.
- Load commit details only when a gutter entry opens. Share pending and completed
  reads for the same commit, bound the cache and reject obsolete hover responses.
- Open all files changed by the selected commit, copy its full hash, open supported
  remote commit pages and access blame settings, including with built-in Git disabled.

### Fixed

- Keep keyboard focus during detail loading and retry, retain actions below long
  messages, and prevent Escape from reopening a hover under an unmoved pointer.
- Distinguish working-tree lines and empty commits without offering invalid actions.

## [0.1.72088] - 2026-10-07

### Changed

- Reduce repeated blame metadata and aggregate source-block ownership through a
  shared line index. Reuse the native editor service and update visible gutter
  rows in place to reduce loading and scrolling work.
- Retry document symbols briefly while a language extension starts, and cancel
  obsolete blame consumers when editors close, change or hide the gutter.

### Fixed

- Show a native-themed commit popup on gutter hover, click or keyboard focus,
  including the full commit ID, author, email, date and summary. Preserve focus
  inside the popup and dismiss stale details when the editor changes.
- Restore working-tree colors, status badges and tooltips in the default Explorer,
  editor tabs and Tab Manager's Explorer when built-in Git is disabled. Share the
  existing status cache and refresh on saved edits, external changes, staging and
  commits even while the Changes view is hidden.
- Respect workspace and decoration settings, release fallback decorations when
  built-in Git resumes, and prevent the Projects catalog from scanning repositories
  outside the current workspace.

## [0.1.72086] - 2026-10-06

### Fixed

- Recognize verified folderless VS Code windows during idle Git inspection.
  Check Code's empty-window backup record and read its editor state without
  modifying the database, so a Welcome window no longer blocks all cleanup.
- Protect local files, unsaved associated files and both sides of diffs in
  folderless windows. Recheck empty-window evidence before stopping a monitor,
  and preserve it when a document or workspace opens during inspection.
- Keep unknown windows, unsupported editor formats and incomplete OS observations
  protected. Record safe failure codes and verified empty-window counts in Output,
  and separate the new inspection cache from earlier failure backoff records.

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
