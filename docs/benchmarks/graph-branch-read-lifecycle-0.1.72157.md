# Graph branch read lifecycle — 0.1.72157

The baseline is `59f09c88def10decf8097555ccd5c1e53713dba4` (0.1.72156).
The complete operation-speed, fresh Graph, safety and resource objective remains
active. This release removes unnecessary recovery attempts after a stopped read;
it does not establish an overall wall-time or memory reduction across all operations.

## Stopped reads

The local branch reader previously treated lifecycle failures as possible broken
refs. An initial timeout could attempt raw refs, tip validation and metadata reads.
Failures in those later steps could also replace the stopping error with the first
error or turn metadata failure into an incomplete successful snapshot.

Cancellation, `ETIMEDOUT`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, `GIT_READ_STOPPING`
and `ABORT_ERR` now stop the pipeline at every boundary. The same stopping error is
preserved. Cancellation is checked after each Native response so late data cannot
be returned as a current snapshot. OUTPUT records `graph branch snapshot stopped`
with the phase and reason, without ref names or raw stderr.

Ordinary errors retain the existing broken-ref isolation policy. Ordinary metadata
failure still permits healthy refs to be shown. Successful ordinary reads keep
their single Native query; the fix adds no background polling or retained cache.
Mutation, stash, index publication and recovery-ref logic are unchanged.

The new deterministic contracts inject stopping errors and late cancellation at
the primary, raw-ref, tip-validation and metadata boundaries. Before the fix,
24 contracts failed and the ordinary-metadata recovery control passed. The final
related suite passes all 98 cases, including real broken refs, tracking counts,
Graph cancellation/first pages and PR object-only navigation.

## Rejected tracking candidate

The earlier candidate used scoped sequential upstream/tip reads and expanded batch
eligibility to mostly equal independent upstreams. It was not shipped. Eight
completed jobs run separate sparse and dense B/A/A/B comparisons with actual
rendered push, fetch, interactive-rebase and PR squash buttons. All 32 results match
fresh Native state and final production Graph DOM. Both sources use the same checked
fixture setup and measurement harness.

| Shape | Final-frame sum median change | Handler sum median change | Git call-count sum median change |
| --- | ---: | ---: | ---: |
| Sparse: 16 shared upstreams | +2.41% | −6.27% | +16.67% |
| Dense: 1,000 shared upstreams | −1.38% | +21.56% | +0.48% |

Each job has 5,000 files, 10,000 history commits, 1,000 side branches and 80 displayed
PR cards, with monitor policy enabled. The sparse case has only 376 aggregate
ahead/behind commits across its shared-upstream branches. Total history/branch
count alone was therefore insufficient to justify the extra queries.

There is strong system timing variation and only two jobs per source/shape. These
are descriptive medians, without a statistical-significance, CPU or memory claim.
The deployed tracking strategy is retained. The full scoped prototype and tests
are archived at `/private/tmp/gsc-goal57-rejected-scoped-tracking`; the compact raw
results are retained in [the evaluation data](graph-tracking-evaluation-0.1.72157.json).
The earlier stopped comparison remains separate; it is not counted as complete.

## Final verification and limits

- `npm run check-types` and `git diff --check` pass.
- Related Node suite: 98 passing cases. Raw logs are
  `/private/tmp/gsc-goal57-lifecycle-before.log` and
  `/private/tmp/gsc-goal57-lifecycle-final.log`.
- Headless Chromium: 40 passing initial-loading, state-only Graph and PR-row-jump
  cases, including the 390×844, 768×1024 and 1440×900 navigation viewports.
  No frontend assets or visual design change in this release.
- The final fixed-source driver covers the full 18 Native/production-renderer
  variants, including push, pull, fetch, rebase, merge, PR squash/replay, cherry-pick
  and checkout. It separately exercises eight actual controls with 80 PR cards at
  the larger repository scale. These final runs are functional verification;
  concurrent functional checks mean their timings are not comparative evidence.
  The loaded-checkout case selects a noncurrent branch from Native Git's first
  300 commits before the product renders. It retains the original topic when
  present; equal timestamps can place it outside that page at 1,000 branches,
  in which case a synthetic one-file side branch is used. Ref tips and dates are
  not rewritten. The earlier fixed-topic setup failure is preserved separately;
  all eight controls are rerun at the same large scale after fixing the harness.
  The matrix separately covers checkout of an unloaded target.
- Actual Captain validation is read-only. All four stable reads match the independent
  Native branch snapshot: 164 local branches, 70 tracked/not-gone, one Native query
  per read. HEAD, refs, index and configuration hashes remain unchanged. This is
  not an operation-speed or GitHub/network measurement. Names and subjects are not
  copied into this report. Lazy fetch and optional Git writes are disabled.
- No foreground Extension Development Host, OS focus changes, forced reload or
  separate Marketplace inspection is used.

Opt-in `scripts/benchmark-readonly-tracking.mjs` and
`scripts/benchmark-ref-fields.mjs` preserve the field-cost/read-only diagnostics
without adding extension runtime dependencies. Synthetic fixture upstream config
is written once and checked by Native Git; each owned scenario is removed after
its oracle and resource cleanup, reducing accumulated benchmark disk usage.
