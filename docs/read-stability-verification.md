# Git / GitHub read stability verification

Version: 0.1.72078. Baseline: 0.1.72077 (`f1d28a1`). Date: 2026-10-05.

## Changes and preserved performance policy

- A cancelled/timed-out GitHub consumer settles immediately. Its actual CLI
  retains its execution slot until owned processes and verified descendants
  close. Queue waits are part of the existing 30-second deadline.
- Read CLIs use a separate ownership registry and POSIX process group. Normal
  successful reads add no `ps` calls or GitHub round trips. Cancellation requests
  TERM, then escalates only for verified owned processes after one second.
- Background and interactive reads still have separate four-slot queues. The
  same 80 ordered PRs, metadata batches of 20 and full commit/comment pagination
  remain in use. The completed-response cache retains its 128-entry / 16 MiB cap.
- Fresh reads bypass completed responses; shorter TTL consumers reject older
  cache entries. Environment snapshots and hashed context keys separate hosts,
  repositories, credentials and executable choices. CLI config file metadata
  invalidates changed authentication/configuration without reading credentials.
  Environment/configuration precedence follows the
  [GitHub CLI environment manual](https://cli.github.com/manual/gh_help_environment).
- Extension disposal cancels queued and active GitHub reads and awaits actual
  closure alongside existing Git cleanup. An old activation cannot dispose the
  next activation's cache.
- Repository-name consumers cancel independently; failed/incomplete responses
  are not retained. Already-cancelled Git force/change calls cannot invalidate
  an active consumer or cause an unnecessary follow-up Git invocation.
- PR detail pages include head/base anchors in the same existing requests. Missing
  connections, invalid scalars, partial GraphQL errors, repeated cursors, count
  mismatches and ref changes fail explicitly. Independent file/thread tails
  remain parallel, and failure cancels the peer with the original error preserved.

## Verification

The initial cache/Git regression run reproduced nine failures. The focused
post-fix run passed 41 tests, including actual SIGTERM-resistant CLI parents and
children with independent stdio, repeated awaited disposal, UTF-8 chunk boundaries,
output limits, write protection, consumer cancellation and complete detail data.

Type checking and the extension bundle build passed. The complete Node regression
run passed **977 tests, zero failures, zero skips** in 176862 ms, with three workers
and a 15-minute whole-run cap. It ran outside the sandbox so OS ownership inspection
could execute, using `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`.

## Actual GitHub data comparison

Both versions were bundled separately from their source and executed through the
normal shared runners against the same `captain` repository. API responses were
compared in memory in full; artifacts contain counts, timings and hashes only.

Two list pairs returned the same complete 80 PR records, 473 commit OIDs and 566
comments, with identical repository, cursor, order and every DTO field. Each list
pass performed the same eight read requests for the current dataset. The selected
PR #38080 retained all 134 files, 23 file review comments and 24 total comments.
Explorer retained all 134 files and rename metadata. All full-response comparisons
passed; neither detail pagination flag nor Explorer truncation flag was set.

| Read | Before | After |
| --- | ---: | ---: |
| First list pair, first usable records | 4015 ms | 3998 ms |
| First list pair, complete result | 4887 ms | 4922 ms |
| Second list pair, first usable records | 3428 ms | 4095 ms |
| Second list pair, complete result | 4439 ms | 4920 ms |
| Selected PR detail, initial pair | 1645 ms | 2320 ms |
| Explorer changed files | 2304 ms | 1849 ms |

Three further detail pairs alternated execution order after the regression run.
Baseline times were 8587, 3724 and 4729 ms; new times were 3536, 1768 and 2112 ms.
All three complete responses matched. Observed medians were 4729 ms before and
2112 ms after. Network and OS scheduling vary substantially between reads; these
measurements show no sustained added delay and are not a fixed latency guarantee
or proof that the stability change itself caused the timing improvement.

Local evidence: `/private/tmp/gsc-stability-red.log`,
`/private/tmp/gsc-stability-focused.log`, `/private/tmp/gsc-stability-full.log`,
`/private/tmp/gsc-stability-comparison.json`,
`/private/tmp/gsc-stability-detail-timing.json`.

## Limits

No additional VS Code development/test windows, macOS reboot or SentinelOne
restart was performed. UI code and user settings were unchanged; live UI visual
verification and multi-day soak testing are not claimed. Forced descendant cleanup
is verified on macOS/POSIX; Windows uses the directly owned child. External Git
processes and security-service queues remain outside this ownership policy. If
the OS prevents an owned process from closing, its slot stays occupied and queued
consumers time out; the extension cannot force the OS to release that process.

## Release

- Source commit: `c4a14df` (pushed to `origin/main`).
- VSIX: `/private/tmp/gitsimplecompare-0.1.72078.vsix`, 120 files; source, tests,
  docs, dependencies and source maps are excluded.
- VSIX SHA-256: `d262d0791187ecb50fdd4f440a5e56d47aeeaac73d090714810c70ae669efb41`.
- Bundle SHA-256: `63843edde7402af57b785c14c82fcbaaba1cb42cf15eac6266973b57e1229f2c`.
  The source build, VSIX bundle and installed bundle match.
- Installed: `/Users/lky/.vscode/extensions/newdlops.gitsimplecompare-0.1.72078`.
  Installation succeeded; existing Code windows still require a reload to use it.
- `env NODE_OPTIONS=--use-system-ca vsce publish --packagePath
  /private/tmp/gitsimplecompare-0.1.72078.vsix` succeeded (observed 06:30 UTC).
- Marketplace public manifest returned HTTP 200 and identified
  `newdlops.gitsimplecompare` version `0.1.72078` (verified 06:35 UTC).
  Public registration processing completed after the initial temporary 404s.
- The isolated validation worktree was removed after merging; logs and standalone
  comparison artifacts remain in `/private/tmp`.
