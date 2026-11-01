# Remaining HTTP Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement inline, task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all eight remaining HTTP opportunities and both conditional opportunities, preserving complete data, authorization and native Git safety.
**Architecture:** Extend the existing typed read seam with opt-in REST page metadata; keep API, HTML and OAuth catalog ownership separate. Reuse branch PR selection for stack batches and editor bootstrap; publish editor API snapshots before bounded HTML enrichment. Keep native Git as the owner of object transfer and credentials.
**Tech Stack:** TypeScript, Node 18 built-ins, current GraphQL parser, esbuild, existing Node/Extension Host harnesses; no new runtime dependency.
**Spec:** [approved recommended design](../specs/2026-11-01-http-followup-optimization-design.md)

## Global Constraints

- Continue inline on `codex/github-http-design`; no automatic new release, merge or push.
- Implement H1/H2/H3/H4/M1/M2/M3/L1/D1/D2; measure complete payloads and label mock/local/public evidence.
- Node 18 target, current VS Code minimum, Korean function comments, clear git/providers/UI/commands boundaries; code files under 600 lines.
- Preserve body-only `GhExecute`, DTOs, ordered tails, full media types and forced CLI/proxy/Enterprise policy. No auth/rate failure fallback to another identity.
- Existing API queues retain four slots and ownership until actual close. Bounded caches and complete snapshots only.
- No credentials, raw private payloads or credential fingerprints in logs/artifacts; no persistent authentication changes.
- Native writes retain fixed source, current remote OID, lease, hooks, ordering and recovery. Do not perform real external writes for validation.
- Clone defaults to full; opt-in blobless preserves all refs/history/current files and requires successful native access without app OAuth injection.
- Meaningful RED→GREEN per task, affected checks per commit, final full suite/types/production/Node18/actual Host/visual checks and one fresh final review.

## Review Focus

- A cached 304 page must retain Link and full media representation; absent metadata cannot silently truncate a tail.
- Same branch names in forks, reused branches and default-branch closed PRs must match gh selection without choosing an unrelated PR.
- API-ready comments cannot become completed cache entries; stale enrichment must not paint a new file/branch/profile or collapse a thread.
- Auth cancellation/rotation, proxy-owned Agents and response-close races must not leak credentials, requests, decoders or subscribers.
- Blobless hydration must work through preflight-verified native access; OAuth-only private clones and failed/partial destinations remain usable and preserved.

## Task 1: Opt-in REST page metadata

**Files:** create `src/git/githubRestPages.ts`, `test/githubRestPages.test.ts`; modify `githubReadRequest.ts`, `githubReadRuntime.ts`, `githubHttpTransport.ts`, `githubHttpCache.ts`, relevant routing/transport tests.
**Interfaces:** optional `GitHubRestRequest.responseMode: "page"`; exported `encodeRestPage`, `decodeRestPage<T>` and `nextRestPage`. The envelope carries raw JSON body plus allowlisted metadata and a version marker; body-only requests are unchanged. CLI runtime opts into `--include` only for page descriptors.

- [x] Write regressions for body-only parity, CLI final headers, envelope allowlist, 304 Link restoration, cache-mode separation, 0/99/100/101/200/1000/1001 boundaries, unsafe/repeated/skip next URLs and headerless fallback.
- [x] Run `npm test -- test/githubRestPages.test.ts test/githubReadRouting.test.ts test/githubHttpTransport.test.ts`; verify failures are missing behavior.
- [x] Implement descriptor/CLI/HTTP/cache metadata and strict same-endpoint next-page validation; retain effective complete body on 304.
- [x] Run the same tests and `npm run check-types`; expected green.
- [x] Commit `feat: preserve REST page metadata across GitHub transports`.

## Task 2: Typed ref and prerequisite reads

**Files:** modify `pullRequestRefLookup.ts`, `pullRequestDependencyLookup.ts`; add focused ref/composition tests and extend existing dependency tests.
**Interfaces:** existing public signatures/DTOs remain; each logical query owns `createGitHubReadSession`/completion and supplies typed GraphQL. Canonical metadata may be observed from the same successful response.

- [x] Add failures proving real production composition uses HTTP after canonical discovery, one credential lease, correct placeholders, partial/error/context-change handling and unchanged prerequisite limits.
- [x] Run focused ref/dependency/integration tests; expected RED.
- [x] Connect typed descriptors, sessions and final validation without new stale-head caching.
- [x] Run focused tests and types; expected green.
- [x] Commit `perf: route ref and prerequisite reads through typed sessions`.

## Task 3: Shared branch PR lookup and Advance

**Files:** create `src/git/pullRequestBranchLookup.ts`, `test/pullRequestBranchLookup.test.ts`; modify `pullRequestStackAdvanceService.ts`, stack lifecycle fixtures/tests.
**Interfaces:** export `findPullRequestsForBranches(root, selectors, options, execute?)` returning selector-keyed validated PR records. Up to 20 selectors/query, first 30 CREATED_AT DESC per selector, stable OPEN-first selection; preserve owner/head/base/default-branch semantics. Current-branch selector resolution is also reusable by Task 6.

- [x] Add RED cases for 1/8/21/40 selectors, current-branch upstream/fork matching, reused/default branches, empty PRs, alias errors, cancellation and auth/rate stop behavior; assert eight normal heads use one query.
- [x] Run branch lookup and lifecycle tests; expected RED.
- [x] Implement typed bounded batches, gh-compatible selection and same-credential typed subqueries only for non-auth partial-error isolation; integrate Advance.
- [x] Run branch/lifecycle/context tests and types; compare against official gh selection fixtures/oracle where available.
- [x] Commit `perf: batch stack advance pull request discovery`.

## Task 4: Targeted Stack Submit reads

**Files:** modify `pullRequestStackSubmitService.ts`, shared branch lookup fields/options and `test/pullRequestStackLifecycle.test.ts`; add targeted submit tests if needed to keep tests focused.
**Interfaces:** consume Task 3 lookup; query only submitted heads before writes and refresh number/URL/body for those heads after ordered remote actions. Existing result and recovery types stay intact.

- [x] Write RED cases proving no all-open-1000 scan, bounded head lookup, fresh footer bodies, unchanged source/lease/hook/order, fork filtering and partial failure recovery.
- [x] Run stack submit/lifecycle and relevant push safety tests; expected RED.
- [x] Replace broad snapshot/read-per-layer phases; preserve every native write gate and current-state check.
- [x] Run same tests and types; expected green.
- [x] Commit `perf: narrow stack submit metadata reads to target heads`.

## Task 5: Bounded shared HTML context

**Files:** create `src/git/githubWebReadContext.ts`, `src/git/githubWebTransport.ts`, focused HTML transport/context tests; modify/split `githubWebHtml.ts`, `pullRequestSuggestedChangesets.ts` and parser helpers as necessary.
**Interfaces:** context owns 30s deadline, auth/URL/Accept memoization, max two body reads, resource disposal and metrics; HTML parsing functions retain their existing exported behavior. Keep fragment maximum 120/depth2 and deterministic breadth-first result order.

- [x] Add RED fixtures for repeated files URL, distinct/same credential, duplicate child fragments, out-of-order responses, gzip/br/deflate, 64MiB wire/decoded bounds, deadline/abort/redirect and request/response/decoder close.
- [x] Run focused HTML/suggestion tests; expected RED.
- [x] Implement context sharing, two-reader scheduling, Host-managed compatibility path and proven owned keep-alive Agent; split the existing 601-line suggestion module by responsibility.
- [x] Run focused tests, secret-error checks and types; expected green, no new dependency.
- [x] Commit `perf: share and bound GitHub HTML enrichment reads`.

## Task 6: Progressive editor comments with actual typed bootstrap

**Files:** modify `pullRequestReviewComments.ts`, `pullRequestCommentCache.ts`, `pullRequestCommentController.ts`; extract provider progress/presentation helpers if needed; extend `test/pullRequestCommentLoading.test.ts` and add service/composition regressions.
**Interfaces:** optional API-ready callback on the service; cache load accepts per-consumer progress subscription while retaining final Promise and existing two-minute completed-cache policy. Use Task 3 current-branch selector and typed bootstrap; Task 1 REST pages carry full media headers.

- [x] Add RED tests with deferred HTML proving API-ready precedes completion, late subscribers get the snapshot, provisional data is not completed TTL data, final failure preserves comments, stale branch/file/auth updates are ignored and one subscriber cannot cancel others.
- [x] Run comment service/loading/controller/composition targets; expected RED.
- [x] Connect progressive service/cache/controller, stable thread identity and typed production bootstrap; keep remote work alive across mere focus changes as before.
- [x] Run focused tests/types; verify known-scope production requests really use HTTP and unknown bootstrap remains consistent CLI.
- [x] Commit `perf: display API review comments before HTML enrichment`.

## Task 7: Conversation REST page integration

**Files:** modify `pullRequestPreviewConversation.ts`, relevant preview helpers and focused conversation tests.
**Interfaces:** consume Task 1 envelope and typed REST within one logical session; retain lazy tab entry, three streams, 100/page, ten-page bound, timeline fallback and original DTO ordering.

- [ ] Add RED boundaries, exact-multiple no-empty-tail, full media, 304, malformed Link, tail failure, account/context change and forced CLI cases.
- [ ] Run preview/conversation/composition tests; expected RED.
- [ ] Wire metadata-aware pages and final context validation; report a real remaining-tail limit instead of claiming complete truncated data.
- [ ] Run affected preview tests and types; expected green.
- [ ] Commit `perf: reuse typed REST pagination for PR conversations`.

## Task 8: OAuth catalog conditional reuse

**Files:** modify/split `githubRepositoryCatalog.ts`, `commands/repositorySetup.ts`; extend `test/githubRepositoryCatalog.test.ts` and command lifecycle tests.
**Interfaces:** retain `listPage` and injected fetch; add owned cache/singleflight/dispose. Cache max32 pages/4MiB/1MiB per page/2min idle. Always reauthorize a reopening with conditional GET; no stale private list before authorization.

- [ ] Add RED cases for 200→304 body/Link reuse, no-body 304 once-only repair, token/account isolation, expiry/LRU/oversize, auth invalidation, rate cooldown, independent cancellation and owned-only dispose.
- [ ] Run catalog/command tests; expected RED.
- [ ] Implement bounded representation cache and in-flight sharing using current OAuth fetch, without gh/Git dependency.
- [ ] Run focused tests/types; expected green.
- [ ] Commit `perf: revalidate OAuth repository pages with bounded cache`.

## Task 9: Inspector successful-port hints

**Files:** modify `nativeDiffOverlayInspector.ts`, `nativeOverlayConnection.ts`; create a small hint store if needed; extend `test/nativeInspectorDiscovery.test.ts`.
**Interfaces:** optional profile identity on discovery; max16 lifetime hints keyed PID/profile/port set. Every hint hit still probes actual PID; discard failed hints and preserve existing discovery/cooldown/socket sharing.

- [ ] Add RED probes for non-default reconnect, duplicate default/hint, PID mismatch, profile mismatch, closed port, configured-port changes, abort and dispose.
- [ ] Run inspector/retry/blame preparation tests; expected RED.
- [ ] Implement validated hints and lifecycle removal without permanent settings or skipped ownership checks.
- [ ] Run same tests and types; expected green.
- [ ] Commit `perf: reuse verified inspector port hints on reconnect`.

## Task 10: Optional full-history blobless clone

**Files:** modify/split `repositorySetupService.ts`, `commands/repositorySetup.ts`, package contribution/nls/l10n; add clone capability/preflight helper and controlled smart HTTP fixture/tests.
**Interfaces:** `cloneMode?: "full" | "blobless"` in command and clone options; native setting `gitSimpleCompare.cloneMode` defaults full. Full mode adds no probes. Blobless requires Git>=2.46, HTTP(S), and native read access in <=5s without app OAuth injection or interactive askpass; otherwise select full before clone.

- [ ] Add RED cases for default parity, frozen choice, Git floor, URL/protocol selection, native access probe without OAuth, timeout/cancel/full fallback, no destination retry/deletion and secret diagnostics.
- [ ] Add RED smart HTTP checks for refs/all parents/current checkout equality, old-blob hydration with native access, unsupported filter and OAuth-only-private fallback.
- [ ] Implement filtered clone and EN/KO native Settings descriptions, preserving current destination/auth/cancellation policies.
- [ ] Run setup/command/integration/types and render Settings; expected green with same history and explicit later-network wording.
- [ ] Commit `feat: add verified optional blobless repository cloning`.

## Task 11: Whole-scope verification and performance judgment

**Files:** actual Host smoke helpers/specs, reproducible benchmark(s), `docs/benchmarks/` results, plan/spec status.
**Interfaces:** map each of H1/H2/H3/H4/M1/M2/M3/L1/D1/D2 to implementation, functional proof and actual or controlled performance evidence; all before/after comparisons validate the complete applicable payload.

- [ ] Run full `GSC_VERIFY_PR_RENDERER=1 npm test`, types, production package and Node18 relevant tests. State optional skips or missing tooling precisely.
- [ ] Run actual EN/KO Host: progressive comments/delayed failure/stale file/thread expansion, forced CLI/supported HTTP/dispose, Settings full/blobless controls. Inspect 1440×900 and 900×700 function and appearance separately.
- [ ] Measure at least three alternating pairs or deterministic request-count comparisons for each candidate; include authorization, end-to-end completion, bytes, clone checkout and hydration. Label mock/local/public evidence and disclose regressions.
- [ ] Dispatch one fresh whole-branch reviewer per executing-plans; regrade findings, fix Important/Critical with RED→GREEN and final full green suite; no re-review loop.
- [ ] Commit verified results and completion map, collect all rulings/deferred minors, clean only this plan workspace, retain reviewable branch.
