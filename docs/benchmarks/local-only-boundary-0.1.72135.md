# Local-only boundary follow-up — 0.1.72135

The final candidate-retention review found that an empty map skipped the size check inside entry iteration. A large metadata key could therefore exceed the estimated budget. Check key/history size before the loop as well. Small empty maps continue to reuse normally.

The regression fails on 0.1.72134 (7 pass / 1 fail). Final scoped checks pass 12/12, covering both sides of the empty-map bound, existing membership bounds/freshness, actual Native fetch/checkout/upstream/shallow changes and consecutive unknown history with early prefetch disabled. Types pass. Only one runtime source line changed after the parent performance run.

[Parent measurements](local-only-revalidation-0.1.72134.md) remain tied to commit 4024a6535c1817652cd107dbf481f6f937e35526: three samples per source, unchanged fetch final Graph 1854→1290 ms and loaded checkout 738→307 ms; host calls 6→4 and 9→7, extra DAG reads 2→0. These timings and its 36 Native/renderer plus 16 actual-control cases were not repeated for this boundary guard and are not described as final-guard timing.

The parent 0.1.72134 artifact was published with CLI acknowledgement. The superseding 0.1.72135 VSIX is the local installation target. No Marketplace status checks, foreground host, OS focus changes or forced reload. Full multi-operation latency/resource work remains active. Source/evidence hashes and exact scopes are in [JSON](local-only-boundary-0.1.72135.json).
