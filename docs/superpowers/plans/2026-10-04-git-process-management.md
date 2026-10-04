# Git process management implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ship usable idle Git cleanup controls and prevent obsolete or stalled extension-owned reads from accumulating, then share expensive status reads across consumers.

**Architecture:** Keep process ownership, termination and status caching in `git/`; inject resource settings and logging at activation; use the existing native Changes settings menu and QuickPick for cleanup. Preserve mutation fences and the version 1 comparison API.

**Tech Stack:** TypeScript, Node child_process, VS Code native settings/commands, node:test, esbuild.

**Spec:** `docs/superpowers/specs/2026-10-04-git-long-session-performance-design.md` (implementation requested by the user).

## Global Constraints

- Continue the established repository workflow. Do not restart macOS or security services.
- Default automatic cleanup off; user and workspace settings; idle threshold 5 minutes, polling 1 minute.
- Never infer idle from CPU, process age or quiet stdout alone. Protect writes and unproven ownership.
- Stop eligible fsmonitor daemons using Git's official command, after identity and active-use revalidation.
- Preserve complete file lists, staged state, existing API consumers and caller-supplied index files.
- Keep modules below 600 lines, document functions in Korean, localize UI, log lifecycle transitions without credentials.
- Existing authorization includes version bump, commit, push, local installation and `vsce publish`.

## Review Focus

1. Cancellation leaves SIGTERM-resistant descendants alive: real subprocess and process-group tests.
2. Timeout accidentally kills writes or retries abandoned reads: classifier, retry and mutation tests.
3. Cleanup kills a reused PID or an active repository: identity/race/protection tests before official stop.
4. Shared cancellation or force refresh breaks another consumer: reference counting and generation race tests.
5. Private index or untracked expansion changes results: real Git fixtures compared with authoritative status.

## Task 1 — Owned execution lifecycle

- [x] Add failing real subprocess tests covering text, buffer and stream cancellation, timeout, stubborn children, spawn failure and maxBuffer.
- [x] Extract a shared spawn runner and ownership registry from `gitExec.ts`; enforce read-only deadlines, TERM/KILL escalation and close-based release.
- [x] Inject settings/logger at activation and dispose all owned reads; preserve mutation execution and lock retries.
- [x] Run targeted execution regressions and typecheck.

## Task 2 — Idle cleanup and native controls

- [x] Test cleanup ownership, active-use protection, PID reuse, selection cancellation and disabled polling.
- [x] Add a repository activity/daemon inspector and cleanup service with conservative platform fallback.
- [x] Add resource settings, user/workspace checked commands, inheritance/configuration UI and manual multi-selection with progress.
- [x] Add English/Korean contributions and runtime translations; wire disposal and output logging.
- [x] Verify native command behavior and candidate/empty/partial failure states.

## Task 3 — Shared status and cache path

- [x] Test concurrent consumers, cancellation and overlapping forced refreshes.
- [x] Add root-scoped snapshot service, complete porcelain parsing and directory-limited untracked expansion using a private index.
- [x] Preserve caller indexes and fall back on unsupported/racing index state.
- [x] Connect Changes and Graph without bypassing freshness fences; cancel delayed stats on dispose.
- [x] Compare real Git fixtures and actual repository output/timings.

## Task 4 — Automatic consumers and integration

- [x] Link blame cancellation to document, CodeLens and extension lifetimes and reuse valid requests.
- [x] Add optional shared-status API while retaining comparison API version 1.
- [x] Connect Tab Manager with old-version fallback and preserve repositories on initial status failures.
- [x] Test cancellation, API compatibility and repeated open/close stability.

## Task 5 — Release and verification

- [x] Run full relevant tests, typecheck and production build; obtain a focused fresh review of important process/cache risks.
- [x] Verify native UI functionality and rendered UI where tooling permits; report any unverified visual behavior explicitly.
- [x] Bump version, commit, push, package/install and publish with vsce.
- [x] Report installed commands/settings and measured improvements; retain outstanding OS-level diagnosis if long-session latency persists.

## Verification record

See [observed results and remaining long-session/visual checks](../../git-long-session-verification.md). Core Node tests: 889 passed. Native command and Tab Manager integration tests passed. Visual capture remains unverified; no additional test host is started under the observed memory load.

Released GSC 0.1.72074 and Tab Manager 0.1.6619: committed and pushed to main, installed locally, and published with `vsce publish --packagePath`. Built, packaged and installed extension binaries matched. Final relevant serial checks passed: 28 GSC and 5 Tab Manager. OS-level latency and extended-session verification remain open as recorded above.
