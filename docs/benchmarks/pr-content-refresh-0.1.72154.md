# Graph PR content refresh — 0.1.72154

## Change

Graph, branch and tag messages update PR decorations without regenerating an unchanged PR overview. PR data, loading, search, reviewer controls and detail state continue to update their content. A pending content change survives a later Graph-only message and IME composition; directly opening/rendering the overview consumes that change.

Related commits in an open PR detail now refresh their loaded state, subject, author/date and tooltip when the Graph window changes. Resolve requested rows in one bounded DOM pass and compare the generated related section before updating the detail. Existing file DOM and keyboard focus remain. Keep only the active related-section comparison; clear it when closing or changing the detail/context.

The Native backend is unchanged. The full original named-operation, Graph freshness, safety and resource objective remains active.

## Profile evidence and acceptance

Three actual controls (push, fetch, PR squash) were profiled before/after through their registered message callbacks, Native Git and final renderer frames. Before, the renderer sampled unchanged `renderOverviewDetail`/`updateHtml` work. After, that path was not sampled. Separate browser contracts observe zero overview HTML updates for three Graph-only messages, while genuine PR updates still render once. The previous code failed six of twelve new cases; the final thirteen-case contract passes.

Profiles are diagnostic only. Node inspector start/stop/transport overhead is visible; sampled self times are neither exact CPU attribution nor comparative wall-time evidence. Node and renderer profiling cannot run with scoped resource counters. Profile files and source hashes are recorded in the adjacent JSON.

## Separate ordinary measurements

Baseline `d9bc76be0a4e3e7ca2f2cdc096d539df9d6eca3f`. Same frozen harness and product source throughout twelve sequential B/A/A/B jobs. Two independent fixture runs/source/mode: 72 service/Native/DOM cases across eighteen variants and 64 actual-button cases across separate latency and CPU modes. Every actual control starts with 80 rendered PR cards and active Native monitor policy. Source-control environment variables are removed before execution; environment key counts match within each mode. No build/test/profile sampling overlaps these comparisons.

| Median of per-run sums | Before | Candidate |
|---|---:|---:|
| 18-variant service (ms) | 3027.5 | 3174.0 |
| 18-variant service through final host-message frame (ms) | 5953.0 | 6382.0 |
| 8 actual controls through final host-message frame (ms) | 5728.0 | 5043.5 |
| Separate owned CPU sum (ms) | 7906.290 | 7000.755 |
| Separate Chromium CPU sum (ms) | 4568.659 | 3806.476 |

The dense actual-control frame sum decreased 11.95%, owned CPU 11.45% and Chromium CPU 16.68%. These bounded observations support removing proven redundant PR work. They do not prove every control faster. Matrix timings without an open overview became slower (+4.84% service, +7.21% through all-host-message frame); Native service variation is not attributed to this frontend change.

### Every matrix variant

Median service-through-final-host-message-frame milliseconds, including service time. No PR overview is shown in this matrix.

| Variant | Before | Candidate |
|---|---:|---:|
| initial | 287.5 | 324.0 |
| push | 414.5 | 616.5 |
| push-tracked | 334.0 | 420.0 |
| pull | 360.0 | 381.5 |
| pull-new-history | 343.5 | 406.5 |
| pull-known-history | 283.5 | 283.0 |
| fetch | 236.0 | 230.0 |
| fetch-new-history | 383.0 | 427.5 |
| fetch-known-history | 263.0 | 318.5 |
| fetch-no-change | 235.5 | 230.5 |
| rebase | 560.0 | 508.5 |
| merge | 368.5 | 385.5 |
| merge-no-ff | 271.5 | 281.0 |
| pr-squash-cherry-pick | 548.0 | 537.0 |
| pr-cherry-pick | 438.0 | 468.5 |
| cherry-pick | 231.0 | 200.0 |
| checkout | 173.0 | 140.5 |
| checkout-unloaded | 222.5 | 223.0 |

### Actual controls with 80 PR cards

Median click-through-final-host-message-frame milliseconds. Slower pull, fetch and PR squash observations are retained.

| Control | Before | Candidate |
|---|---:|---:|
| push | 808.0 | 486.0 |
| pull | 594.5 | 968.5 |
| fetch | 398.0 | 611.0 |
| interactive-rebase | 1772.5 | 923.0 |
| fetch-no-change | 371.5 | 361.5 |
| checkout | 345.0 | 282.5 |
| pr-squash-cherry-pick | 753.0 | 883.5 |
| pr-cherry-pick | 685.5 | 527.5 |

### Actual-control CPU, separate run

Median owned CPU milliseconds. Slower interactive-rebase and PR replay observations are retained.

| Control | Before | Candidate |
|---|---:|---:|
| push | 1125.3 | 692.8 |
| pull | 1357.7 | 1231.1 |
| fetch | 1150.3 | 766.2 |
| interactive-rebase | 1107.1 | 1199.3 |
| fetch-no-change | 468.3 | 335.1 |
| checkout | 511.1 | 319.9 |
| pr-squash-cherry-pick | 1107.0 | 1081.1 |
| pr-cherry-pick | 1079.3 | 1375.4 |

## Functional and visual verification

- 59 related headless browser cases pass, plus the final thirteen-case repeat after adding focus/settled captures; seven related Node checks and `npm run check-types` pass.
- Graph-only refresh, both PR/Graph message orders, manual overview opening, IME, loading/error/retry, metadata replacement, reviewers, action state and PR-row navigation are exercised.
- Related commits transition unloaded → loaded → unloaded. Existing file DOM and related-button keyboard focus are preserved.
- Dense overview and loaded-related-detail screens are directly inspected at 390×844, 768×1024 and 1440×900. The existing tokens, density, controls, mobile drawer and wider side panes remain; no new buttons or layout system are introduced. Browser page errors are rejected. Related theme/axe cases remain in the suite.
- UI work uses `ui-design-workflow`; this is an existing-interface performance/freshness change. No new design direction or dependency was needed.

## Limits and remaining work

Owned temporary repositories and local bare receivers only. Captain is unchanged; no actual GitHub mutation/network timing, foreground Host, OS focus switch, forced reload or Marketplace status check was used.

The all-host-message metric observes two frames after the last delivered message, including nonvisual messages. It is distinct from Graph-model ACK. Separate CPU windows include Node/Playwright, OS-accounted waited Native children and complete stable-PID Chromium counters. After-await Node RSS/heap values are not retained heap or aggregate process-tree peak memory, and no new such memory reduction is claimed.

Keep all original operations in scope. Cumulative performance at actual repository scale and aggregate-memory minimization still need stronger evidence; this change does not complete the entire objective.
