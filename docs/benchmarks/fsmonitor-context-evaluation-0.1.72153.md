# Fsmonitor context and preparation evaluation — 0.1.72153

## Delivered behavior

A `--config-env` mapping can retain its environment variable name while changing its socket or include value. Health reuse previously omitted that value. Hash its current value with the command context, so a different endpoint receives a fresh bounded probe. Joined and separate option forms are covered; secrets are not emitted in keys or logs. Native precedence, configured hooks, repository configuration and process ownership remain intact.

Compute each configuration-slot loop bound once from its existing environment snapshot. Keep complete environment copies and all existing recovery metadata/HEAD/ref fences. The final preparation comparison does **not** establish a consistent CPU or wall-time benefit. No overall speedup is claimed for this release.

The complete original push/pull/fetch/rebase/merge/PR squash/PR replay/cherry-pick/checkout and Graph freshness/resource objective remains active.

## Rejected prototype

The earlier prototype replaced complete environment copies with selective reads in monitor preparation and recovery-path identity. Preparation-only measurements were favorable. Broader actual-button results did not prove an improvement, so that implementation was removed. Its exact patch, frozen hashes and all per-case observations are preserved in the adjacent JSON. They do not describe shipped performance.

Baseline: `86c36e8a18d09f6f0b5ed1e26a38eeb0d521ed79`. Frozen shared harness; B/A/A/B matrix and separate latency/CPU series, followed by A/B/B/A actual-button confirmation. Matrix: two independent runs/source; actual-button latency and CPU: four independent runs/source/mode. Eight controls each display 80 PR cards with the Native monitor policy enabled. Environment key counts match within every mode; source-selection variables are removed before measurement.

| Rejected prototype scope, median of per-run sums | Before | Prototype |
|---|---:|---:|
| 18-variant service (ms) | 5805.5 | 4425.5 |
| 18-variant service through final host-message frame (ms) | 10986.5 | 8383.5 |
| 8 actual buttons through final host-message frame (ms) | 6686.0 | 6939.5 |
| Separate owned CPU sum (ms) | 8975.159 | 9140.927 |
| Separate Node CPU sum (ms) | 1017.429 | 1171.273 |

Actual-button frame sum increased 3.79%; owned CPU increased 1.85%; Node CPU increased 15.12%. Attribution to one underlying function is not established. Favorable service-only and micro results are insufficient to accept this prototype; the slower samples are retained.

### Rejected prototype: every matrix variant

Median service-through-final-host-message-frame milliseconds, including service time.

| Variant | Before | Prototype |
|---|---:|---:|
| initial | 314.5 | 483.0 |
| push | 708.0 | 700.0 |
| push-tracked | 822.0 | 499.0 |
| pull | 570.0 | 739.0 |
| pull-new-history | 713.0 | 632.5 |
| pull-known-history | 385.0 | 636.0 |
| fetch | 299.0 | 381.0 |
| fetch-new-history | 804.5 | 517.0 |
| fetch-known-history | 267.5 | 309.0 |
| fetch-no-change | 296.0 | 239.0 |
| rebase | 1162.0 | 551.5 |
| merge | 676.0 | 519.5 |
| merge-no-ff | 565.0 | 300.0 |
| pr-squash-cherry-pick | 991.5 | 634.0 |
| pr-cherry-pick | 1011.5 | 464.5 |
| cherry-pick | 578.5 | 245.0 |
| checkout | 261.0 | 270.5 |
| checkout-unloaded | 561.5 | 263.0 |

### Rejected prototype: actual controls

Median click-through-final-host-message-frame milliseconds.

| Control | Before | Prototype |
|---|---:|---:|
| push | 756.5 | 1355.0 |
| pull | 705.5 | 820.5 |
| fetch | 621.0 | 594.5 |
| interactive-rebase | 1599.0 | 1520.5 |
| fetch-no-change | 432.5 | 317.0 |
| checkout | 352.5 | 280.0 |
| pr-squash-cherry-pick | 933.5 | 897.0 |
| pr-cherry-pick | 874.0 | 963.0 |

## Final verification

- 62 related safety tests pass: mapped endpoint invalidation, settings precedence, healthy/stalled daemon handling, Native writes, recovery metadata, external completion commits and atomic snapshots.
- The new endpoint regression failed twice before the fix. Final joined/separate mapping cases pass. Prior unrelated helper tests belong to the rejected prototype.
- Final 18-variant service/Native/production-DOM and eight actual-button cases all pass independently. Their timings are functional observations, not a new before/after speed or CPU claim.
- Final public preparation API B/A/A/B uses two processes/source and five correlated inner samples after warmup. All 86 environment keys match and each measured phase has zero Native Git calls. Complete copies remain; no consistent final CPU benefit is established.
- `npm run check-types` passes. Final Korean parameter/return documentation transforms to exactly the measured runtime code. Fresh screenshot/visual sign-off is not claimed for this backend-only change.

## Limits and next work

All receivers and writes are owned temporary fixtures. Captain is unchanged. No actual GitHub/network mutation timing, foreground Host, OS focus switch, forced reload or Marketplace status inspection was used.

The final-host-message boundary observes two frames after the last delivered host message, including nonvisual messages; it is distinct from a Graph-model ACK. CPU counters cover Node/Playwright, OS-accounted waited Native children and complete stable-PID Chromium counters in separate runs. They do not establish retained heap or aggregate process-tree peak memory.

The first preparation-only trial with unequal source-control environment counts is excluded. Historical mixed results remain valid limitations. Continue investigating actual click/Graph CPU before accepting another broad preparation optimization; all named operations, safety and resource requirements remain in scope.
