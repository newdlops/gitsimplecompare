# Additional HTTP Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all seven additional HTTP candidates and prove reduced work while preserving complete, authorized results.

**Architecture:** Extend the existing typed read sessions and REST page envelopes, reuse complete immutable snapshots only after fresh authorization, and share bounded transport resources with explicit lifetimes. Native Git writes and PR creation remain in their existing execution paths.

**Tech Stack:** TypeScript, Node HTTPS, GitHub GraphQL/REST, esbuild, node:test, VS Code extension.

**Spec:** `docs/benchmarks/http-next-opportunities-20261101.md` (N1–N7, user requested all).

## Global Constraints

- Preserve repository/credential/policy generation boundaries, proxy and Enterprise CLI compatibility.
- Preserve cancellation isolation, response completeness, pagination caps, fresh mutable metadata and write recovery.
- Keep responsibilities in git service modules; split modules beyond 600 lines; document functions in Korean.
- Record transport and meaningful state transitions in the existing OUTPUT logger without secrets.
- Work on the existing feature branch; product UI is unchanged.

## Review Focus

- A stale cache hint must never authorize another account or repository's data.
- Headerless and 304 responses must not truncate a full final page.
- Fork branches and duplicate PR detection must preserve publish recovery behavior.
- Mixed partial GraphQL results must not be promoted to complete PR results.
- Shared HTML connections must not let one context cancel another or survive policy/disposal boundaries.

### Task 1: N1 and N2 changed files and REST termination

**Files:** `src/git/pullRequestPreviewFiles.ts`, `src/git/pullRequestPreviewRemote.ts`, `src/git/pullRequestSearchService.ts`, `test/githubReadIntegration.test.ts`, `test/pullRequestPreviewCommentPages.test.ts`, `test/prPreviewReadSafety.test.ts`, `test/githubRestPages.test.ts`.

**Interfaces:** Existing `createGitHubReadSession`, `decodeRestPage`, `nextRestPage`, and `readSessionRestApiBase`; retain current DTOs and optional test runners.

- [ ] Add failing tests: changed-files production entry uses HTTP after scope discovery; known-final 100-file pages stop in one request; commit object files and SHA associations honor Link; headerless/unknown pagination still advances.
- [ ] Run focused tests and inspect expected failures before code.
- [ ] Wrap changed-files reads in one session; opt remaining endpoints into page mode; adapt commit files to the array pagination helper without losing the object SHA check.
- [ ] Run `npm test -- test/githubReadIntegration.test.ts test/pullRequestPreviewCommentPages.test.ts test/prPreviewReadSafety.test.ts test/githubRestPages.test.ts` and typecheck; expect no failures.
- [ ] Commit verified change.

### Task 2: N3 publish reads

**Files:** `src/git/pullRequestPublishService.ts`, new `src/git/pullRequestPublishReads.ts` if needed, `test/pullRequestPreviewPublish.test.ts`, `test/githubReadIntegration.test.ts`.

**Interfaces:** Read helpers return duplicate PR identity and published metadata using independent logical sessions; preserve existing `PullRequestPublishError` phases and fallback DTO.

- [ ] Add failing production tests for HTTP preflight/postcreate, duplicate prevention, fork identity and fallback after a postcreate read failure.
- [ ] Observe RED, then replace direct read-only CLI calls with typed reads and exact created PR identity after mutation.
- [ ] Run `npm test -- test/pullRequestPreviewPublish.test.ts test/githubReadIntegration.test.ts`; expect all pass and writes unchanged.
- [ ] Commit verified change.

### Task 3: N4 mixed metadata batching

**Files:** `src/git/pullRequestListReads.ts`, `test/prListBatchLoading.test.ts`.

**Interfaces:** `readPullRequestNodes` still returns root order, uses `known` stable snapshots, preserves per-PR repair and `onBatch` delivery.

- [ ] Add failing test: a 20-item mixed warm/cold batch makes one metadata request; independently assert all fields/order and changed-anchor repair.
- [ ] Observe RED; combine per-node stable field choices in one typed GraphQL query with validated identities and complete alias errors.
- [ ] Run `npm test -- test/prListBatchLoading.test.ts`; expect all pass.
- [ ] Commit verified change.

### Task 4: N5 search overlap

**Files:** `src/git/pullRequestSearchService.ts`, `src/git/pullRequestSearchReads.ts`, `test/pullRequestSearchEfficiency.test.ts`.

**Interfaces:** One search owns an authorized complete-result registry; text and associated lookup may share PRs without caching mutable fields beyond the logical search.

- [ ] Add failing test with overlapping SHA/text PRs: no duplicate hydration, complete tail connections, no result loss; nonoverlap remains parallel.
- [ ] Observe RED; coordinate text-complete results with association hydration, including failure/cancel and differing head protections.
- [ ] Run `npm test -- test/pullRequestSearchEfficiency.test.ts`; expect all pass.
- [ ] Commit verified change.

### Task 5: N6 preview commit snapshots

**Files:** `src/git/pullRequestPreviewRemote.ts`, `src/git/githubReadSession.ts` if a hint is needed, `test/prPreviewReadSafety.test.ts`, `test/githubReadIntegration.test.ts`.

**Interfaces:** `PreviewBootstrap` retains fresh title/body/head and its bound session; snapshot retrieval uses current `gitHubSnapshotIdentity` and complete immutable commit summaries.

- [ ] Add failing warm preview test with >100 commits: fresh bootstrap occurs, redundant summary tails do not; auth/head/base changes and incomplete summaries cannot reuse.
- [ ] Observe RED; use the bounded commit snapshot store only after a fresh matching anchor and save only validated complete results.
- [ ] Run `npm test -- test/prPreviewReadSafety.test.ts test/githubReadIntegration.test.ts`; expect all pass.
- [ ] Commit verified change.

### Task 6: N7 bounded HTML Agent lifetime

**Files:** `src/git/githubWebTransport.ts`, `src/git/githubWebReadContext.ts`, new `src/git/githubWebAgentPool.ts` if needed, activation cleanup, `test/githubWebTransport.test.ts`, `test/githubWebReadContext.test.ts`.

**Interfaces:** Contexts retain their own request cancellation; a bounded pool owns only Agents, separated by trusted origin/network policy generation; activation disposal closes idle and active owned resources.

- [ ] Add failing controlled HTTPS test: two sequential contexts reuse a connection; one cancellation leaves the other working; policy change and extension disposal close the correct resources.
- [ ] Observe RED; implement max-socket/idle-TTL/bounded pool lifecycle without overriding proxy-owned/global Agent paths.
- [ ] Run `npm test -- test/githubWebTransport.test.ts test/githubWebReadContext.test.ts`; expect all pass and actual socket reuse.
- [ ] Commit verified change.

### Task 7: final verification and evidence

**Files:** `docs/benchmarks/http-next-improvements-verification-20261101.md`, existing benchmark tooling as needed.

- [ ] Run complete `npm test`, `npm run check-types`, `npm run package`; inspect all outputs.
- [ ] Record before/after request/CLI/connection counts from real service composition and controlled transport; distinguish actual network latency from deterministic work reduction.
- [ ] Obtain one fresh whole-change review, fix material findings with RED→GREEN, and rerun affected tests/full suite as justified.
- [ ] Audit N1–N7 against current source, tests, and evidence; commit final documentation. No release/version change is required by this optimization goal.
