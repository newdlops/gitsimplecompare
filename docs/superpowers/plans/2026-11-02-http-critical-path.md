# HTTP Critical Path Implementation Plan

**Release scope update (2026-11-02):** The user's latest instruction is to version,
commit, push and deploy the current work. Version 0.1.72186 includes P1 and P2
only. P3–P6 below remain planned follow-up work and are not claimed as complete.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete P1–P6 from the approved remaining HTTP opportunities, retaining authorized complete data and proving reduced work or critical-path time.

**Architecture:** Keep existing typed sessions, bounded snapshots and transport limits. Overlap independent continuations, reuse only freshly authorized immutable data, and retain REST fallback where rename or OAuth contracts require it.

**Tech Stack:** TypeScript, node:test, esbuild, GitHub REST/GraphQL, local HTTP/TLS fixtures.

**Spec:** `docs/benchmarks/http-opportunities-20261102.md` (user requested all six).

## Global Constraints

- Preserve fresh auth/repository/head/base/count boundaries; no body access based only on hints.
- Preserve complete pagination, rename/copy old paths, file caps, error identity, cancellation and actual close.
- Keep search request concurrency 4, HTML concurrency 2, fragment depth 2 and URL limit 120.
- Preserve existing OAuth repository visibility, ordering, paging, ETag benefit and independence from Git/gh.
- No product UI or release/version change is required. Work on `codex/http-critical-path` in the existing checkout.

## Review Focus

- A connection failure cancels its siblings and leaves no queued/active request behind.
- A different account or changed anchor cannot consume a hinted snapshot.
- Parallel fragment completion cannot change merge priority or depth/URL admission.
- Inspector discovery cannot select a fast target without the actual PID/profile checks.
- OAuth owner/collaborator/org/team visibility and warm 304 behavior must not regress.

### Task 1: P1 search continuations

**Files:** `src/git/pullRequestSearchReads.ts`, `src/git/pullRequestSearchService.ts`, `test/searchContinuationPipeline.test.ts`.
**Interfaces:** `completeSearchPullRequests` keeps the DTO and same-search scope. Its owned continuation runner combines cancellation with the outer search runner and inherits session identity.

- [x] Add failing tests for commit/review start overlap, complete results, sibling cancellation on either error, and existing 4-request cap.
- [x] Observe RED, run continuations together, await actual cleanup and preserve first failure.
- [x] Run focused search/session tests; expect no failures; commit.

### Task 2: P2 Explorer file snapshots

**Files:** `src/git/pullRequestPreviewFiles.ts`, `src/git/githubPullRequestSnapshots.ts` as needed, `test/githubReadIntegration.test.ts` and `test/prComparisonSnapshots.test.ts`.
**Interfaces:** Existing changed-files reader and DTO; reuse `gitHubFileSnapshotHint`, fresh GraphQL anchor and current session identity.

- [x] Add RED: previously cached 1000 non-rename files use one fresh anchor instead of REST pages.
- [x] Add rename/copy/unknown-state, partial count, changed auth/head/base, empty cache and file-cap fallback tests.
- [x] Implement guarded conversion only when all required REST DTO fields are represented; otherwise retain REST.
- [x] Run focused detail/changed-files/session tests; expect complete identical DTOs; commit.

### Task 3: P3 warm preview bootstrap

**Files:** `src/git/pullRequestPreviewRemote.ts`, `src/git/githubReadSession.ts`, `src/git/pullRequestService.ts`, preview integration tests.
**Interfaces:** Bootstrap retains fresh title/body/head/base and its bound session. Query-shape hints never return snapshot bodies before current authorization.

- [ ] RED: warm bootstrap omits `commits(first:100)` while cold bootstrap remains one combined request.
- [ ] Verify stale hints/auth changes repair a missing snapshot and changed head/base cannot mix results.
- [ ] Propagate bounded hint metadata through existing wrappers; implement thin query plus complete-cache miss repair.
- [ ] Run focused preview/session tests and verify body bytes reduction; commit.

### Task 4: P4 fragment pipeline

**Files:** `src/git/githubWebHtml.ts`, `test/githubWebReadContext.test.ts`.
**Interfaces:** Same HTML read DTO and deterministic breadth-first output ordering, URL safety, depth and total admission limits.

- [ ] RED: a fast parent's child starts while an unrelated sibling remains pending.
- [ ] Implement dynamic bounded discovery with stable output/admission ordering, deduplication and owned cancellation.
- [ ] Test cycles, overlapping child URLs, depth/URL cap, errors and reordered completion; run HTML suites; commit.

### Task 5: P5 inspector discovery

**Files:** `src/providers/nativeDiffOverlayInspector.ts`, inspector unit tests.
**Interfaces:** Same verified target URL; return only after PID match and cleanup of owned losing probes.

- [ ] RED: a verified target is selected before a deliberately delayed unrelated HTTP response.
- [ ] Process completed probes incrementally while retaining hint preference, safe ports/profile/PID checks and existing request bounds.
- [ ] Verify cancellation, wrong PID, stale hints, missing target and actual losing socket close; run inspector tests; commit.

### Task 6: P6 OAuth catalog projection experiment and selection

**Files:** OAuth catalog transport/query helper, `src/git/githubRepositoryCatalog.ts`, catalog tests and paired fixture evidence.
**Interfaces:** Existing `listPage(token,page,signal)` contract and cached REST reauthorization remain valid. GraphQL projection must preserve complete owner/collaborator/org/team-visible result sets with the same OAuth identity.

- [ ] Establish API/query and permission/page parity; add failing DTO/visibility/order/cursor/error tests before product changes.
- [ ] Compare cold projected bytes/parse cost against REST and warm conditional 304, including scopes/rate limits.
- [ ] Select and implement the measured beneficial route with safe compatibility fallback; if parity or benefit fails, document the actual failed experiment and retain the better REST route as the spec requires.
- [ ] Run catalog/independent onboarding tests, preserve OAuth-only ownership/cancel and commit the verified outcome.

### Task 7: final evidence and review

- [ ] Compare before/after payloads, requests, bytes, start/finish order and representative p50/p95 using controlled fixtures; label live versus simulated measurements.
- [ ] Obtain one fresh whole-change read-only review after focused checks; fix material findings by RED→GREEN.
- [ ] Freeze source and run `GSC_VERIFY_PR_RENDERER=1 npm test`, `npm run check-types`, `npm run package` with appropriate process/network permission.
- [ ] Audit all six requirements, commit final evidence, keep the feature branch, remove only this plan's generated scratch and complete the goal.
