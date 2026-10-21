# PR Graph navigation verification — 0.1.72150

## Reproduced failure and resulting behavior

An overview refresh replaces the host pager's accumulated PR entries, while the
webview retains its current repository search results. A visible searched PR
can therefore be absent from the refreshed pager. Jump to Pull Request Row
previously lost that PR's metadata, preventing its missing objects from being
prepared and its Graph window from being displayed.

The pager now retains only the current successful search and its continuation
pages for Graph navigation. The current overview takes precedence when it has
newer metadata. Repository changes discard the retained search and invalidate
late results. This leaves the overview's displayed count and membership intact.

The Native regression uses an owned temporary repository, a local bare origin
containing an unfetched PR commit, and an isolated GitHub CLI response fixture.
It executes the registered Graph message callback for search, overview refresh,
and row navigation. The baseline f454aa1 fails the new navigation assertion;
the candidate passes. Named refs, FETCH_HEAD, index bytes, configuration and
tracked file contents remain identical across the navigation.

## Verification

- Related Node coverage: 87 distinct passing cases, including PR navigation,
  search replacement/pagination/repository reset, first-list startup, explicit
  branch filters, cancellations, Native commit windows and tag read lifecycle.
- Headless Chromium: 22 passing scenarios for PR row navigation and list
  loading, including the retained search result at 390 × 844, 768 × 1024 and
  1440 × 900. The 13 navigation scenarios were repeated after adding an explicit
  mobile drawer-transition completion check.
- Screenshots inspected for all three navigation widths and the narrow loading
  and Korean retry/error states. No frontend styles, labels or controls changed.
- `npm run check-types` and `git diff --check` pass.
- No foreground Extension Development Host or OS focus changes; no forced VS
  Code reload and no separate Marketplace status inspection.

## Bounded tag query optimization

The same complete Native ref snapshot can prove that there are no local tags.
That proof now skips one duplicate local tag query in the current Graph read.
Native coverage checks remote-only tags, newly added annotated tags, tag
addition/deletion, malformed/legacy snapshots and paused/resumed reads.

Remote tag reads remain active. Repositories with local tags keep the existing
Native local query. The proof is not retained for resumed or subsequent reads.
This is a process-count reduction; no new wall-time, CPU or memory improvement
across all Git operations is claimed. The broader operation optimization goal
remains active, with the cumulative 0.1.72149 latency limitations retained.
