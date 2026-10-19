# PR operation performance

Measured on 2026-10-19 against 0.1.72102 (`81fcf63`) using local, disposable
Git repositories with 10,000 base files and an 80-commit PR. Each version ran
three times in alternating order. Times include the public operation service,
result application and cleanup; fixture setup and verification are excluded.
These are local fixture results, not timings from the private captain repository
or an 80-PR list query. Network fetches were not part of these scenarios.

| Scenario | 0.1.72102 mean | 0.1.72103 mean | Git processes before → after |
| --- | ---: | ---: | ---: |
| Conflict-free squash onto the exact PR base | 2,317 ms | 1,835 ms | 33 → 29 |
| Reopen the same saved conflict | 581 ms | 306 ms | 13 → 8 |

The first case reuses the verified source tree, reads branch and HEAD together,
and avoids scanning a temporary worktree whose files were never checked out.
The second case finds and validates the saved operation before materializing
source objects or computing another merge result. Genuine conflict files and
the original destination remain unchanged when reopening a saved operation.

Merged PR histories are verified through their actual parent graph, independent
of the API's commit ordering. A single external parent provides an exact closed
range directly. Multiple external parents must reduce to one independent tip,
and `rev-list` must return exactly the requested commit set. Queries cap output
at the PR size plus one. Ambiguous or disconnected histories retain the native
replay path; content, binary and rename conflicts still require resolution.

Regression coverage includes modern and legacy Git squash paths, internal
merges, base updates without importing base-only changes, single merge sources,
staged/unstaged local changes, real final conflicts, saved-operation retries,
continuation and Undo. See `test/pullRequestSquashHistory.test.ts` and
`test/pullRequestWorktreeRecovery.test.ts`.
