# GitHub Read Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved direct HTTP design and judge end-to-end improvements, including authentication cost, against the unchanged CLI behavior.
**Architecture:** Keep `GhExecute` as the compatibility seam. Typed descriptors travel beside existing CLI arguments. A logical read session freezes repository, transport and credential identity. Bounded HTTP resources and immutable PR snapshots live in `git/`; VS Code configuration remains in composition code. Native Git retains authentication helpers, hooks and safety checks.
**Tech Stack:** TypeScript, Node 18 `https`, a Node 18 compatible GraphQL AST parser, existing esbuild/Node tests and Extension Host harness.
**Spec:** [approved design](../specs/2026-11-01-github-http-performance-design.md)

## Global Constraints

- Work inline on the existing clean `codex/github-http-design` task branch; never merge, publish or push an unreviewed implementation.
- Preserve CLI arguments, test seams, DTOs, pagination, comments and commit meanings. Unsupported network policies select CLI before any API request.
- No raw credentials, private payloads or credential fingerprints in logs, errors or artifacts. No persistent Git authentication changes.
- Every implementation task uses meaningful RED→GREEN tests. Files stay below 600 lines, with Korean function comments and clear module boundaries.
- Existing background/interactive four-slot queues own execution until the underlying request closes. Context checks protect publication and caching.
- Settings changes use the UI workflow and English/Korean strings. Record actual rendered verification separately from unit/build checks.
- Final completion requires full tests, types, production package, fresh branch review, seven alternating performance pairs and an explicit judgment with limitations.

## Review Focus

1. A credential change during pagination must not mix accounts, cache bodies or connection contexts (Tasks 2–4).
2. Abort/timeout/body limits must close the owned request without releasing a queue slot early or destroying another request (Task 3).
3. Scope discovery, redirects, proxy/CA policies and GraphQL partial failures must never silently cross an authentication boundary (Tasks 1–4).
4. Stable head/base does not imply stable comments/reviews; only complete immutable data can be reused (Tasks 5–6).
5. Native Git optimization must preserve explicit configuration, hooks, fixed source, lease and stash recovery (Task 7).

## Task 1: Typed read requests and safe API errors

**Files:** new `src/git/githubReadRequest.ts`, `githubApiError.ts`; modify `ghRunner.ts`; new `test/githubReadRequest.test.ts`; package manifests.
**Interfaces:** `GitHubReadRequest` describes GraphQL query or REST GET, carries exact CLI arguments; `GhRunnerOptions.request` is optional. Safe errors expose typed status/kind/retry metadata and an internal structured-result accessor, never stdout/cause.

- [ ] Write tests rejecting mutation/subscription/ambiguous documents, preserving variables/CLI args, and redacting structured errors; run targeted tests. Expected: new behavior fails.
- [ ] Verify parser Node 18 support and bundle cost from official package metadata; implement AST builder and safe errors.
- [ ] Run targeted tests and types. Expected: green; commit `feat: add typed GitHub read requests`.

## Task 2: Canonical scope and per-query credential lease

**Files:** new `githubRepositoryScope.ts`, `githubCredential.ts`; modify `githubReadSession.ts`, `githubRepositoryName.ts`, `ghCli.ts`; new `test/githubReadIdentity.test.ts`.
**Interfaces:** canonical scope is keyed by verified remote/auth context. A session freezes transport and a fresh per-query credential lease; concurrent lookups share only in-flight work. Actual credential identity is opaque outside cache keys. Existing fake runners continue to receive CLI arguments.

- [ ] Write tests for CLI bootstrap, context-validated scope, GH_REPO/host isolation, frozen absent environment, token precedence, independently cancelled credential consumers, keychain replacement and secret-free errors. Expected: RED.
- [ ] Implement scope learning from successful repository URL payloads and dedicated credential adapter, preserving execution environment and deadlines.
- [ ] Run identity/session/context/repository tests. Expected: green; commit `feat: freeze GitHub read identity per query`.

## Task 3: Bounded HTTPS transport and compatibility policy

**Files:** new `githubHttpTransport.ts`, `githubHttpPool.ts`, `githubHttpPolicy.ts`, `githubHttpCache.ts` as responsibilities require; modify `githubReadCache.ts`; new `test/githubHttpTransport.test.ts`, `githubHttpPolicy.test.ts`.
**Interfaces:** transport accepts typed descriptor + lease + remaining request deadline, settles on request-resource closure, and reports safe timings. A lifetime owns pools, conditional bodies and cooldowns; existing queues retain concurrency ownership.

- [ ] Write behavioral tests with local/injected HTTPS endpoints for keep-alive reuse, same-origin REST redirects, GraphQL partial errors, body/decompression caps, 304 recovery, cooldowns, stale-socket retry, abort isolation and disposal. Test unsupported policies before network. Expected: RED.
- [ ] Implement Node 18 HTTPS transport, bounded four-context pool and ETag cache, normalized failures and one narrowly permitted retry. Keep all unsupported policies on CLI.
- [ ] Run transport, read-cache and context race tests plus types. Expected: green; commit `feat: add bounded GitHub HTTPS read transport`.

## Task 4: Production routing, settings and lifetime ownership

**Files:** read builders/callers in `pullRequestListService.ts`, `pullRequestDetail.ts`, `pullRequestSearchService.ts`, `pullRequestSearchReads.ts`, preview readers; `src/ui/gitProcessSettings.ts`; package/nls/l10n; relevant tests.
**Interfaces:** converted callers provide descriptors beside unchanged arguments. Unknown scope fixes the entire query on CLI, and successful complete bootstrap teaches the next query. Configuration generations reset only resources they own.

- [ ] Apply UI workflow before settings edits; inspect existing contribution and runtime composition patterns.
- [ ] Write routing/lifetime tests for forced CLI, proxy/CA/Enterprise fallback, no fallback after HTTP auth errors, first-query bootstrap, setting generation and stale disposer isolation. Expected: RED.
- [ ] Wire all approved PR read paths and settings, observable safe timing/count logs, i18n and disposal.
- [ ] Run routing/read compatibility tests and types. Expected: green; commit `feat: route supported GitHub reads through HTTP`.

## Task 5: Complete raw PR file snapshots

**Files:** new `githubPullRequestSnapshots.ts` (or responsibility-split snapshot modules); modify `pullRequestDetail.ts`; new `test/pullRequestFileSnapshots.test.ts`.
**Interfaces:** raw files keyed by canonical repository, number, head/base, actual auth and normalizer version; bounded 128/16MiB/4MiB. Snapshot access follows a fresh authorized anchor and never stores decorated DTOs.

- [ ] Test 738-file repeat reads at one API, fresh/deleted comments, changed anchors/count, review tails, account changes and failed/truncated/cancelled cache exclusion. Expected: RED.
- [ ] Add anchor+review first-page path, complete raw snapshot reuse and existing progress/error behavior; keep strict page validation.
- [ ] Run detail/progressive/stability/snapshot tests. Expected: green; commit `perf: reuse complete immutable PR file snapshots`.

## Task 6: Shallow warm lists and shared commit snapshots

**Files:** list/info/search/commit pagination modules; immutable snapshot module; new/updated list/search efficiency and atomic tests.
**Interfaces:** identity first, mutable metadata in batches of 20 with at most four in flight; immutable commit/file-count reuse requires complete summaries and matching anchors. Search shares the same snapshots. One anchor-race repair per PR, then fail explicitly.

- [ ] Test early shallow warm progress, fresh comments/reviews/labels, commit-tail completeness, one-time race repair, repeated mutation failure and exact/missing/text/SHA merge parity. Expected: RED.
- [ ] Implement shallow first page and immutable sharing without replacing current comment count semantics or search ordering.
- [ ] Run list/search/commit/snapshot tests and types. Expected: green; commit `perf: reduce warm PR metadata latency`.

## Task 7: Opt-in native Git proactive authentication

**Files:** new `gitHubProactiveAuth.ts`; native Git composition/execution services; settings/nls; new `test/githubGitProactiveAuth.test.ts`; existing branch/pull/push safety tests.
**Interfaces:** command-scoped override only for proven GitHub.com HTTPS targets and opted-in operations. Freeze policy at operation start; respect explicit proactiveAuth/emptyAuth/credential policies and ambiguous rewrites/targets.

- [ ] Test option off, valid HTTPS, SSH/multiple URLs, explicit policy priority, no token injection/config writes, hooks and existing lease/stash guards. Expected: RED.
- [ ] Implement conservative policy using Git-resolved targets and per-command overrides; retain native operation ownership.
- [ ] Run native auth and branch/pull/push safety tests. Expected: green; commit `feat: opt in to native Git proactive authentication`.

## Task 8: End-to-end verification, fresh review and performance judgment

**Files:** reproducible benchmark script(s), `docs/benchmarks/` results and report; approved spec status; relevant Extension Host tests.
**Interfaces:** seven alternating pairs compare identical CLI/HTTP and before/after DTO payloads. Authentication, first display, completion, repeat-open API counts and native phases are measured separately. Logs/artifacts contain public fixture aggregates only.

- [ ] Run full `GSC_VERIFY_PR_RENDERER=1 npm test`, types and production package. Expected: all required checks green, optional live skip stated.
- [ ] Run actual Extension Host compatibility/cancellation/disposal/settings checks and Node 18 checks where available; inspect rendered Settings and transitions. Record any unavailable environment precisely.
- [ ] Measure seven alternating pairs for cold/warm list, search, large detail reopen and native Git probes, including credential acquisition. Verify DTO/file/source/config equivalence.
- [ ] Build fresh whole-branch review package, dispatch one fresh reviewer as required by executing-plans, fix important findings with RED→GREEN and rerun required checks.
- [ ] Record results and default suitability honestly, mark the plan complete only when implemented and verified; commit report. Leave branch reviewable, with no automatic new publication.
