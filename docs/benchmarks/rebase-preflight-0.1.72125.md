# Rebase Start reads and Graph button verification — 0.1.72125

The change removes a redundant Git directory query from a prepared interactive
rebase Start: eight host Git calls become seven. Both fresh checkout guards
remain. The Graph adapter also shares its initial checkout directory with its
operation check, and releases that scope before asking for confirmation.

The release also removes the consumed input todo after a successful bundled
sequence editor reaches an edit pause. Native todo state, pending rewrite exec
files and message queues remain usable. Custom helpers retain their input.

## Timing evidence

Baseline: `fec61f1a34c2964b676c83080af1b6a1e03e0ea8` (0.1.72124).
Each serial comparison used baseline/candidate/candidate/baseline order, three
samples per mode per run, 1,000 files, 1,000 history commits and six todo items.
Native Git was executed directly, without `time` or Trace2 wrappers.

| Series / median Start milliseconds | Baseline | Candidate |
| --- | ---: | ---: |
| Initial, message changes and squash | 692 | 1,002 |
| Initial, reorder | 232.5 | 379 |
| Diagnostic, message changes and squash | 914 | 944.5 |
| Diagnostic, reorder | 380 | 472.5 |

Each cell contains six samples. The second series added per-command elapsed and
synchronous spawn observations to investigate the slower direct Start results;
it uses the same observation code for both sources. Most elapsed time was spent
waiting for Native Git. These results establish the query reduction, but do not
establish a latency improvement. Node CPU also varied between series. All raw
results, including slower candidate samples, are retained in the JSON report.

## Rendered button path

A common headless harness clicks the production push, pull, fetch and Start
rebase controls. Messages pass through the callback registered with the webview,
then execute Native Git against owned repositories and local bare receivers.
The final renderer acknowledgement must match the latest publication; HEAD,
branch chips, refs, parents and local-only markers are compared with fresh reads.

| Median button click to final frame, milliseconds | Baseline | Candidate |
| --- | ---: | ---: |
| Push | 971.5 | 1,543 |
| Pull | 1,032.5 | 661 |
| Fetch | 802 | 553.5 |
| Interactive rebase | 2,897.5 | 840 |

There are only two samples per version and scenario. VS Code transport/window
APIs and picker responses are substituted; confirmation is immediate. These
observations verify the complete tested path, and are insufficient to claim a
stable general latency gain. They do not measure GitHub transfer performance.

## Existing repository observation

A separate read-only diagnosis observed 162 local branches, 2,117 remote refs
and 386 tags. A 300-commit page took 419ms; branch snapshots took 227ms and 174ms.
HEAD, refs, index and configuration fingerprints were unchanged. The tool rejects
Git mutations and network commands, disables optional locks, and emits no branch
names, commit contents or repository path. This single observation does not
measure a real mutation or rendered Graph latency.

## Functional checks

- 74 relevant Node checks passed, including normal/linked worktrees, successive
  Starts, custom helpers, pending rewrite continuation, paused native state,
  initial read failures, late external HEAD and metadata replacement.
- Four earlier Graph native/lifecycle checks passed.
- Nine named operation cases passed with Native Git and production Graph
  HTML/CSP/JS: push, pull, fetch, rebase, merge, PR squash cherry-pick, PR
  cherry-pick, cherry-pick and checkout. These were functional checks run alongside
  Node tests; their elapsed times are not comparative performance evidence.
- Graph captures at widths 390, 768 and 1,440 were inspected. Tests launched no
  foreground window and required no OS focus or extension reload.
- Node CPU measurements cover the benchmark process only, including Playwright
  transport in button cases. Git, editor, Chromium and whole-OS CPU/RSS are not
  included.

The full optimization objective remains open. This release claims fewer queries
and better temporary-file cleanup, with no general latency or CPU improvement.

Machine-readable evidence: [rebase-preflight-0.1.72125.json](rebase-preflight-0.1.72125.json).
