# Local-only revalidation — 0.1.72134

After Git cache invalidation, retain one bounded completed marker result as untrusted. Require both new local and remote reads, identical branch/upstream/ahead/gone metadata, full ref/OID set, shallow/graft/metadata/Git environment identity, executable selection and PATH before reusing it. Unknown or changed proof re-runs the original calculation. Validated markers attach before Graph publication.

Branch menus and clone source lookup now read the selected branch identity without full tracking metadata. Checkout retains its separate fresh preflight. Marker application was moved to a pure Git data module to keep source files at or below600 lines.

## Actual button comparison

Production HTML/CSP/JS and actual registered callback; baseline 965a7245b4b47d3f4effa7dae8bf26751263df83, final source/harness hashes and every sample in [JSON](local-only-revalidation-0.1.72134.json). Serial B/A/A/B/B/A, n3/source,1000files/1000commits/100branches/48shared upstreams. No instrumented wrapper is enabled.

| Operation | Click to final Graph median | Host Git calls (all samples) | Extra DAG reads |
|---|---:|---|---|
| fetch-no-change | 1854 → 1290ms | 6/6/6 → 4/4/4 | 2 → 0 |
| checkout | 738 → 307ms | 9/9/9 → 7/7/7 | 2 → 0 |

Slow samples and parent Node CPU values remain in JSON. These are owned-local-fixture results, not Captain/GitHub throughput or total CPU/RSS evidence. No extra validation Git process or timer was added; prior-map retention is bounded by4096entries,65536memberships and4MiB conservative estimated size, with large/hidden/disposed candidates dropped.

## Correctness and negative evidence

- Core112pass/0fail, final focused15pass/0fail (overlap),113 distinct passing test names across final scoped groups. Types pass. Native unchanged fetch and loaded checkout keep exact markers, index/untracked contents and fresh HEAD/refs. Changed upstream/shallow boundaries force recalculation. Unknown history is tested across consecutive refreshes with early prefetch disabled.
- The same new Native regression fails twice on the previous release because it still performs2DAG reads. Its safety case passes.
- Two18-case Native/production-renderer matrices cover push, tracked push, pull, fetch, rebase, both merge modes, PR squash/replay, cherry-pick and loaded/unloaded checkout, including history-change/no-change variants. All36final states match an independent fresh Native oracle; unchanged visible checkout reads no history page, fresh/deep paths read exactly one. These matrices provide functional coverage, not a broad paired latency claim.
- Four additional actual push/pull/fetch/interactive-rebase controls also match final Native state. Three actual Graph screenshots were inspected at390/768/1440px with commit selection/Escape after measurement.
- The initial comparison stopped because the nominally unchanged fetch created origin/HEAD. Native probing confirmed the added ref, and the candidate correctly rejected reuse. Git's default followRemoteHEAD=create permits this initialization ([Git2.53 configuration documentation](https://git-scm.com/docs/git-config/2.53.0#Documentation/git-config.txt-remoteltnamegtfollowRemoteHEAD)). The corrected fixture prepares that ref before initial Graph loading and independently asserts the full ref set is unchanged after the timed fetch. Original failed samples and diagnostics remain retained.
- Readiness observation now reads completion state directly rather than calling a product adoption method. The same harness is used across both sources.

The narrow390px capture retains the existing desktop Graph horizontal scrolling and split detail pane; metadata columns can lie outside the initial visible area. No layout or theme redesign is claimed in this backend refresh change.

No user worktree mutations, foreground host, OS focus/reload or Marketplace status checks. The complete multi-operation speed/freshness/stability/resource goal remains active; current whole-application resource and broad repeated latency evidence remain incomplete.
