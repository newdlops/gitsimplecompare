# Published history before object estimation — 0.1.72126

The push planner now verifies the actual server's already-published history
before estimating outgoing objects for an absent destination. It avoids a full
existing-history size walk followed by a second walk excluding the published
base. Destination leases remain separate from history exclusions.

Upstream-setting pushes share one branch advertisement. Ordinary tracked pushes
retain their exact destination query. Independent calls without upstream setup
can first probe the destination and then discover other published branches.

## Primary comparison

Baseline: `41223c589ca5070a33265a24c06c23bcd17d124d` (0.1.72125).
Two serial baseline/candidate/candidate/baseline series used the same source
commit, fixed once by the parent harness. There are four samples per version.
No timing wrappers or Trace2 instrumentation were enabled.

The source is an existing repository's immutable object history. Each case
creates two owned temporary bare repositories with object alternates pointing
to that source, adds three owned commits, and performs a real push to an owned
local receiver that already publishes the base. No source checkout or object
copy is needed. Original HEAD, refs, index and configuration remain unchanged.

| Median | Baseline | Candidate |
| --- | ---: | ---: |
| Push service including planning | 23,227ms | 8,785ms |
| Planning until ready | 19,418ms | 5,076.5ms |
| Benchmark Node CPU | 391ms | 50.5ms |
| Host Git calls | 15 | 13 |

Elapsed ranges were 14,187–33,009ms and 6,702–10,662ms respectively. Every case
returned a single confirmed update, the exact expected remote HEAD and tree,
an estimate of 786 bytes, and no owned processes left active. The source-state
fingerprint was unchanged in every case.

This fixture's receiver publishes one base branch. It does not reproduce the
actual server's complete branch catalog, network latency or transfer throughput.
The primary comparison measures the push service; it excludes Graph rendering.

## Ordinary new-branch button observations

A separate 1,000-file/1,000-commit/100-side-branch fixture exercised the production
HTML/CSP/JS push button through the registered extension message callback. All
four cases passed Native and final DOM checks for HEAD, refs and local-only
markers. These measurements precede the final restoration of narrow queries
for tracked branches; the new-upstream path uses the same advertisement flow.

| Click to final frame | Baseline | Candidate |
| --- | ---: | ---: |
| First sample | 6,845ms | 6,485ms |
| Second sample | 6,112ms | 20,357ms |

The slow candidate sample spent 14,126ms in local `ls-remote`. The measurements
do not establish an ordinary-push latency improvement. Retain both samples;
do not substitute the large-history service result for button-to-Graph timing.
The final source passed a separate functional button check. Its real Native
state and final rendered HEAD, refs and local-only markers were exact.

## Validation

The broad Node group completed with 101 passing cases and one failed query-count
assertion. That assertion found a missing read-scope hint: the outer service
handles upstream configuration itself, so the inner planner could not infer the
new-upstream flow from its write options. The caller now passes that read hint
explicitly. All 17 focused final-source checks passed after correction, covering
the failed case, published-history preservation and approval/configuration
guards. Across the broad and focused runs, 102 distinct case names are covered;
this is not a single passing 102-case run. Final typechecking passed.

The primary direct API does not request upstream setup. The final caller hint
does not change its advertisement or object-walk sequence. A final-source Native
smoke rechecked 13 Git calls, exact receiver HEAD/tree, an unchanged source-state
fingerprint and release of all owned processes. It is a functional check rather
than another comparative timing sample.

## Read-only source observations

The extended diagnosis observed 162 local branches, 2,117 remote refs, 386 tags,
nine worktrees and 30,311 index entries. Representative phase measurements were:

- History page: 368ms for 300 commits.
- Branch snapshots: 61ms and 62ms.
- Refresh fingerprint: 92ms.
- Local-only markers: 105ms.
- Authoritative status with optional index writes disabled: 821ms.
- Owned temporary private index, cold read: 631ms, matching the authoritative
  result for all eight changed paths.

The status observations run in that fixed order, disable fsmonitor and do not
prove a general cache speedup. The private path also used more benchmark Node CPU
and memory. Diagnostic output contains aggregate counts, not repository paths,
branch names, file names or commit contents.

## Scope and limits

- Preserve actual push URL selection, fresh source/configuration checks, empty
  first-destination leases, cancellation and confirmed partial-progress counts.
- Unknown and non-commit advertised objects remain excluded from history proof;
  the planner can still require a full history walk when no useful base is known.
- Node CPU and RSS cover the benchmark process only, excluding Git children,
  Chromium, concurrent total memory and whole-OS CPU. RSS deltas can be negative
  after collection; they are not peak-memory or total-memory evidence.
- External load was uncontrolled. A 48GiB machine with about 18.8GiB swap in use
  was observed during validation. No user applications were stopped or refocused.
- An initial prototype queried all heads for every push. Its faster large-history
  samples are retained separately and do not describe the final tracked-branch
  behavior or final-source timing.

Reproduce the owned-receiver experiment with `scripts/benchmark-published-snapshot.mjs`;
set `GSC_BENCH_READONLY_REPOSITORY` to an existing repository and
`GSC_BENCH_SNAPSHOT_COMMIT` to a fixed commit OID. Set `GSC_BENCH_SOURCE_REF` to the
baseline code commit when comparing sources. Write results under a temporary
directory. The original repository accepts only metadata read commands.

Machine-readable evidence: [published-push-0.1.72126.json](published-push-0.1.72126.json).
