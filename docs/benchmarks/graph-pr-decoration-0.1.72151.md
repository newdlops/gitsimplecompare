# Graph PR decoration optimization — 0.1.72151

## Change and scope

Keep existing PR badge DOM when its three displayed PR numbers, titles and comment counts are unchanged. Restrict transient matching maps to the current Graph window and visit SVG nodes once. Preserve changed titles/counts, node colors, the three-badge limit, keyboard focus and PR row navigation. Weak keys release metadata when badges are removed.

The Native Git mutation services are unchanged. The full original push/pull/fetch/rebase/merge/PR squash/PR replay/cherry-pick/checkout objective remains active.

## Evidence

Baseline: `18f7d60d53949383ea99b9cbb683a8d436640985`. Same frozen harness and candidate media hash. One four-run B/A/A/B matrix series plus one four-run B/A/A/B series per actual-button latency/CPU mode cover 136 Native/production-DOM cases, plus four preliminary button checks. No foreground Host or OS focus changes.

The matrix covers 18 variants with 1000 files, 1000 commits, 100 branches and eight shared upstreams. The eight actual-button scenarios each show 80 PR cards. Native HEAD/ref/parent/local-only/remote-tag state is checked independently; PR fixture metadata and VS Code transport/pickers replace external UI/GitHub boundaries.

### Aggregate medians

| Scope | Before | Candidate |
|---|---:|---:|
| 18-variant service sum (ms) | 4641.0 | 4418.0 |
| 18-variant service through all-message frame sum (ms) | 8849.5 | 8549.0 |
| 8 actual buttons through all-message frame sum (ms) | 5931.0 | 5680.0 |
| Separate scoped CPU sum (ms) | 8036.197 | 7794.781 |
| Separate Chromium CPU sum (ms) | 4992.172 | 4493.646 |

These are medians of per-run sums, with two samples/source/mode. Native service-time variation is observational and is not attributed to the PR renderer. CPU and latency are separate experiments.

### All named operations

Values are median service-through-final-host-message-frame milliseconds, including service time.

| Operation | Before | Candidate |
|---|---:|---:|
| initial | 348.5 | 467.5 |
| push | 629.5 | 815.5 |
| push-tracked | 592.5 | 560.0 |
| pull | 629.0 | 534.5 |
| pull-new-history | 678.0 | 437.5 |
| pull-known-history | 377.0 | 385.5 |
| fetch | 275.0 | 450.5 |
| fetch-new-history | 568.5 | 434.5 |
| fetch-known-history | 337.5 | 223.0 |
| fetch-no-change | 344.0 | 234.5 |
| rebase | 806.5 | 1020.5 |
| merge | 475.0 | 491.0 |
| merge-no-ff | 440.5 | 362.5 |
| pr-squash-cherry-pick | 628.0 | 573.5 |
| pr-cherry-pick | 728.5 | 505.5 |
| cherry-pick | 398.5 | 304.5 |
| checkout | 220.5 | 400.5 |
| checkout-unloaded | 372.5 | 348.0 |

### Actual controls with 80 PR cards

Values are click-through-final-host-message-frame milliseconds.

| Button | Before | Candidate |
|---|---:|---:|
| push | 1154.5 | 899.5 |
| pull | 588.5 | 576.5 |
| fetch | 440.0 | 938.5 |
| interactive-rebase | 1633.0 | 1061.0 |
| fetch-no-change | 313.5 | 302.0 |
| checkout | 371.5 | 303.0 |
| pr-squash-cherry-pick | 818.5 | 872.5 |
| pr-cherry-pick | 611.5 | 727.0 |

## Isolated DOM evidence

The synthetic matching-module benchmark has 300 rows and 80 PRs with 100 commits each. Median page-mean processing per call: 1.005 → 0.397 ms. Ten unchanged calls remove 800 badge groups on each baseline page and zero on each candidate page. Timing and MutationObserver diagnostics are separate. This is not a full operation/frame/CPU/memory benchmark.

## Rejected candidate

A Native ref-format candidate was not applied: readonly 2782-ref comparison, 12 samples/source, median 160.584 → 174.182 ms. All output hashes were stable and Native remote names matched, but elapsed time increased.

## Limits and remaining work

- Product change is PR decoration reconciliation only; Native mutation services are unchanged. Service-time variation is not attributed to this UI change.
- 1000 files/1000 commits/100 branches/8 shared upstreams; local bare receivers. No actual GitHub/server/network latency or Captain mutation timing.
- Matrix has no PR overview. Eight actual button scenarios show 80 PR cards. Two independent fixture runs per source/mode; all slower samples retained.
- All-host-message metric waits two frames after the final dispatched host message, including tag/PR/menu/busy state and nonvisual messages. It is a conservative distinct boundary, not the exact time of every pixel or a replacement for Graph-model ACK.
- CPU runs are separate from basic latency. Scoped counters include Node/Playwright, waited Native work and complete stable-PID Chromium. No new aggregate memory, retained heap or peak claim.
- Microbenchmark uses a synthetic isolated PR matching module and repeated correlated calls within two page lifetimes/source; JS/DOM only, not full Graph or Native performance.
- Prior cumulative operation latency/resource limitations remain. This does not prove every named operation individually faster or the entire objective complete.

## Release checks

- Related Node tests: 53 passed; headless browser scenarios: 39 passed.
- PR decoration, changed title/count, shared-commit color/limit, newly loaded
  history, PR row navigation and dense list states checked at 390, 768 and 1440px.
- Screenshots use settled drawer transitions; mobile overlay and desktop/tablet
  side panes retain the existing product layout and controls.
- `npm run check-types` and `git diff --check` pass. Tests/builds were excluded
  from comparative timing phases. Memory minimization remains partially verified.

Raw results, frozen source hashes and artifact SHA-256 values are in the adjacent JSON report. Final media only expands Korean parameter/return documentation; esbuild-transformed runtime bytes match the measured source exactly. Functional/visual release checks and exact VSIX verification are recorded separately.
