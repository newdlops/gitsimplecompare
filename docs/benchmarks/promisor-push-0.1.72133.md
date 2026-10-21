# Partial-clone push verification — 0.1.72133

The final source first tries object-size estimation without lazy fetching. Missing promisor metadata triggers a bounded, object-free negotiation with the actual push server; locally verified common commits exclude shared history. The actual push negotiates again. Fresh source/configuration checks and destination leases remain independent. Unsupported negotiation retains original complete sizing.

The fixed negotiation command disables FETCH_HEAD, refspecs, tags, pruning, commit-graph writes, submodules and automatic maintenance. Only this exact command shape is classified as a cancellable read; normal fetch stays protected. This follows [Native Git fetch documentation](https://git-scm.com/docs/git-fetch/2.53.0).

## Actual button comparison

Baseline 08b73cac7683e10649d12d587b87a8968fef759c; final source hashes and all raw samples are in [the JSON report](promisor-push-0.1.72133.json). Order: B/A/A/B/B/A, three samples per source, separate owned file:// fixtures with eight missing 1MiB shared blobs. Production HTML/CSP/JS, actual button and registered extension callback, final publication ACK and fresh Native metadata oracle. No real user worktree writes.

| Measurement | Before | After |
|---|---:|---:|
| Handler median | 10172ms | 7837ms |
| Final Graph median | 10543ms | 8432ms |
| Host Git calls | 24/24/24 | 29/29/29 |
| Missing shared blobs after push | 0 | 8 |

All source index bytes, staged/unstaged/untracked changes and Native final state were preserved. The host call count increases because explicit verification is counted; internal lazy-fetch children are outside that count. Physical pack growth and all CPU/timing samples, including slower results, are retained in JSON. Uncompressed object size is not wire size. Parent Node CPU is not total application CPU/RSS.

## Functional and failure evidence

- 131 distinct passing Node checks across scoped groups, including 12 final Native promisor scenarios and 11 PR/shared-surface checks. Core group originally had 92 passes and one 10s sandbox cancellation timeout; the identical test passed with process-inspection permission. Native child ps was denied with EPERM. Budgets stayed unchanged.
- Four ordinary actual push/pull/fetch/rebase controls preserve exact Native state. Final six partial-clone actual button flows preserve user changes. Earlier six comparison samples and trace smoke remain separate evidence.
- Real tag/no-tag, tree-less, numeric boolean, unsupported protocol, unrelated server, malformed ACK, cancellation/deadline, changed source, empty new-destination lease, successful and rejected sequential pushes are covered.
- The 64MiB baseline browser closed and exceeded its 240s outer budget. Cause is unproven; no paired speed claim. A separate candidate functional run completes one actual push with no blob hydration or source changes.
- Initial missing-blob regex failures and expected old-source preservation failure remain recorded.

The broad multi-operation optimization goal remains active. Actual Captain stays read-only; no Marketplace status checks, OS focus changes or forced reloads.
