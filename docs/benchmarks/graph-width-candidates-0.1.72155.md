# Graph width candidates — 0.1.72155

## Change and contract

Keep at most 24 width candidates across unchanged resizes and changes to short noncandidate rows. Continue measuring their actual geometry on each scheduled frame. The existing text/child-count score and DOM-order tie policy stay the same. Rebuild when a candidate score changes, a new/changed row reaches the minimum score, a candidate is removed, or a direct child enters/leaves the row class. Actual text and child changes remain observed, including search/rebase/reflog annotations. Selection and other classes that do not change row membership leave the candidate set valid.

Reuse the existing weak score cache; no persistent whole-row list, history map, timer or Git cache is added. Detached candidates are released by the same mutation delivery. The Native backend is byte-identical to 0.1.72154. All original named operations, fresh Graph state, preservation/recovery and resource requirements remain active.

## Bounded work and dense-renderer evidence

The new 5000-row traversal contract failed on the old code and passes now: unchanged resize, decoration-only changes and short noncandidate replacement perform zero full candidate traversals. Growth/shrink, character and child changes, reflog insertion/edit/removal, class membership changes, empty/full replacement and a new first row still produce the required width. The bounded cache is verified in code and through the browser boundary; it is not a claim about total application memory.

The isolated production module benchmark uses B/A/A/B, two independent pages/source, 5000 rows and 1000 branch-like prefixes. Median of page-average callback milliseconds:

| Callback case | Before | Candidate |
|---|---:|---:|
| Unchanged | 0.960 | 0.040 |
| Short row replacement | 0.873 | 0.040 |

This measures the width module's callback JS/layout, with within-page samples correlated. Values at the timer floor do not mean zero execution cost.

The full Graph renderer comparison uses 5000 rows, 1000 branches and 250 tags. Only the width module differs; all other current renderer/fixture code is common. Eight independent browser/page lifetimes in B/A/A/B+A/B/B/A provide four samples/source. The original CDP session uses CPU rate 1 throughout. Each latency scenario has six correlated updates; a separate CPU window repeats eighteen events after warmup. All rows, long-row bounds, unchanged-row DOM, selection and graph focus are checked.

| Median per-browser frame sum (ms) | Before | Candidate |
|---|---:|---:|
| 6 unchanged resizes | 126.9 | 109.0 |
| 6 short-row metadata deltas | 130.7 | 113.4 |
| 6 candidate-growth deltas requiring rescans | 186.0 | 156.1 |
| All 18 events | 450.9 | 375.5 |
| Separate Chromium CPU (ms) | 571.372 | 562.616 |

Dense frame sums decreased, but individual browser results vary and CPU differs only -1.53%. Candidate-growth events still need a full scan; their observed timing decrease is not attributed entirely to the cache. These are warm loaded-Graph updates, not Native Git operations, first-load performance or VS Code transport. The initial shared-browser run had a first-page outlier and an ambiguously reset throttle session; its raw results are retained and excluded from comparative claims. A first harness build failed because Playwright was bundled; runtime loading fixed that build without changing production code.

## Ordinary Native and actual-button comparison

Baseline `d07ffea0afb208a54d9c5c27f6b3735e2c1b5b86`. Frozen production/harness sources, B/A/A/B, two independent fixture runs/source/mode. 1000 files, 1000 commits, 100 branches, 8 shared upstreams. The matrix has eighteen variants without an open PR overview. The eight actual controls each show 80 PR cards, with monitor policy enabled. Independent fresh Native state and production HTML/CSP/JS DOM are exact in all 136 cases. Setup, build, tests, profiling and memory sampling do not overlap ordinary latency/CPU windows. Source-control environment variables are removed and key counts match within each mode.

| Median per-run sum | Before | Candidate |
|---|---:|---:|
| Matrix service (ms) | 6441.5 | 7051.5 |
| Matrix through all-host-message frame (ms) | 11046.5 | 11867.5 |
| 8 actual controls through all-host-message frame (ms) | 7430.5 | 7475.5 |
| Separate owned CPU (ms) | 8857.817 | 8927.180 |
| Separate Chromium CPU (ms) | 4918.837 | 4980.985 |

The actual-control frame sum is +0.61%, owned CPU +0.78% and Chromium CPU +1.26%; this does not establish an overall operation speed or CPU improvement. The matrix is slower (+9.47% service, +7.43% through all host messages). These slower observations are retained. Native service variation is not attributed to this unchanged backend or used to claim a frontend benefit.

### Every matrix variant: service through all-host-message frame (ms)

| Variant | Before | Candidate |
|---|---:|---:|
| initial | 325.5 | 703.5 |
| push | 1062.0 | 1509.0 |
| push-tracked | 653.5 | 623.0 |
| pull | 829.0 | 1084.0 |
| pull-new-history | 593.5 | 684.0 |
| pull-known-history | 843.5 | 525.0 |
| fetch | 503.5 | 440.0 |
| fetch-new-history | 508.5 | 394.0 |
| fetch-known-history | 311.5 | 274.0 |
| fetch-no-change | 307.5 | 376.5 |
| rebase | 721.5 | 1873.5 |
| merge | 758.5 | 495.0 |
| merge-no-ff | 343.0 | 287.5 |
| pr-squash-cherry-pick | 1068.5 | 795.5 |
| pr-cherry-pick | 957.0 | 612.0 |
| cherry-pick | 437.0 | 455.5 |
| checkout | 500.0 | 219.5 |
| checkout-unloaded | 323.0 | 516.0 |

### Every actual control: all-host-message frame (ms)

| Control | Before | Candidate |
|---|---:|---:|
| push | 1109.0 | 1912.5 |
| pull | 606.0 | 768.0 |
| fetch | 570.0 | 480.5 |
| interactive-rebase | 1803.0 | 1612.5 |
| fetch-no-change | 531.5 | 476.5 |
| checkout | 451.0 | 296.5 |
| pr-squash-cherry-pick | 1409.0 | 953.5 |
| pr-cherry-pick | 951.0 | 975.5 |

### Every actual control: separate owned CPU (ms)

| Control | Before | Candidate |
|---|---:|---:|
| push | 1294.7 | 934.9 |
| pull | 927.4 | 1088.8 |
| fetch | 1012.5 | 1209.1 |
| interactive-rebase | 1580.8 | 1923.8 |
| fetch-no-change | 655.1 | 609.1 |
| checkout | 490.4 | 476.8 |
| pr-squash-cherry-pick | 1494.4 | 1217.8 |
| pr-cherry-pick | 1402.4 | 1466.6 |

## Separate memory observation

Thirty-two additional actual-button/Native/DOM cases use a separate RSS sampler. All runs have complete observations, at least five samples/case, and source/fixture controls match. Median of each eight-control run's largest simultaneous RSS sample is 694.05 → 717.99 MiB (+3.45%). No memory reduction is claimed. Every raw sample, PID set and checksum is retained in the JSON, including the larger candidate run. Sample gaps reach about 154ms: short-lived children or peaks between samples can be missed. Summed process RSS may double-count shared pages and is neither physical memory, retained heap nor a proven peak. The sampler/ps are excluded from the owned sum.

## Functional, visual and delivery gates

- 68 headless browser cases, 23 related Node cases and typecheck pass. No ESLint dependency/config is installed; no lint pass is claimed.
- Dense checkout, branch/tag metadata, reordered/reset models, initial/pending/error history, pagination, reflog overlays, row/SVG identity, keyboard focus, scroll/selection, PR list freshness and PR row jumps are covered. Browser errors are rejected by the new contract and relevant flow tests.
- Dense checkout screens are directly inspected at 390×844, 768×1024 and 1440×900. The existing scrollable canvas, mobile graph, side detail pane, colors, controls and focus treatment remain. No new product control, layout, token or dependency is introduced. UI work follows `ui-design-workflow`; no redesign/specialist design audit is claimed.
- Two final actual checkout/PR-squash Native flows with 80 PR cards pass and capture all three viewports. The final PR-squash images are also directly inspected at all three sizes. All 170 Native/production-DOM cases use owned temporary repositories and local bare receivers only.

No Captain writes, GitHub mutations, foreground Host, OS focus switch, forced reload or Marketplace status check. The all-host-message metric waits two frames after the last delivered message, including nonvisual messages; it is distinct from the Graph-model ACK. Separate owned CPU includes Node/Playwright, OS-accounted waited Native children and stable complete Chromium PIDs; the Chromium root remains alive until after counters, avoiding double counting.

The full original goal is not complete. Broader cumulative/current measurements at actual repository scale, remaining viewport/layout costs, and stronger resource evidence remain necessary. Reproduce the module benchmark with `GSC_BENCH_SOURCE_REF=d07ffea0afb208a54d9c5c27f6b3735e2c1b5b86 node scripts/benchmark-graph-width.mjs out.json`, or the dense-renderer comparison with `GSC_BENCH_WIDTH_BASELINE=d07ffea0afb208a54d9c5c27f6b3735e2c1b5b86 node scripts/benchmark-graph-width-renderer.mjs out.json`.
