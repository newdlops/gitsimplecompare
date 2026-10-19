# Blame annotations and line history

Click **Block Author Code Vision** above a source block to open one author/date
column for the file. Click any Block Author hint in that file again to close it;
closing also cancels a pending read and never runs another Git command. The active
language extension must provide document symbols, and CodeLens must be enabled.

The legacy before-line labels, their toolbar switches and `blameLine.show` setting
are removed. A saved legacy setting cannot enable another column. Separate file
annotation show/toggle commands, line-number show/hide menus and Ctrl+Alt+B
(macOS: Cmd+Alt+B) are also removed, leaving Block Author as the single opener.
Disabling Block Author closes its gutter.

Press **Escape** in the editor or run **Hide Block Author Blame** to close the
owned gutter. The popup consumes Escape first, and the binding leaves completion,
rename, find, snippets and multi-selection widgets their normal Escape behavior.
No global Git blame setting is changed.

Hover or focus any line to inspect the complete identity and commit information.
Compact mode keeps blank continuation rows clickable and focusable. A group's
label repeats at its first visible line when scrolling or folding hides its start.
Narrow columns use ellipsis; full information remains available in the popup.

## Display settings

All settings below have the prefix `gitSimpleCompare.blameAnnotations.` and
can be scoped to a resource or workspace. Defaults preserve the existing gutter.

| Setting | Default | Effect |
| --- | --- | --- |
| `dateFormat` | `YYYY-MM-DD` | Also supports `DD.MM.YYYY`, `MM/DD/YYYY` and `relative`. Absolute dates use UTC; relative dates use the VS Code display language. |
| `authorName` | `full` | `first` and `last` select the first or last whitespace-separated word. Full identity stays in the popup. |
| `compact` | `false` | Label each consecutive commit group once, with a visible-boundary repeat. |
| `highlightCommit` | `false` | Highlight all lines from the cursor's commit, including nonadjacent ranges. |
| `showCommitHash` | `false` | Include the actual short commit hash. |

Settings reformat the current blame result without running Git again. Cursor
highlighting reuses an index and does not request Git or editor discovery. Only
visible rows produce gutter DOM nodes. Relative-date formatters and repeated
commit labels are reused while preparing a snapshot.

## Performance

Only the focused active saved file is prepared ahead of the editor's CodeLens
request. Slow document-symbol lookup overlaps with blame instead of delaying
its start. Quick empty symbol results do not start blame. Changing tabs,
editing, losing focus or disabling CodeLens releases the preload consumer.

Document symbols are cached separately from Git results. Repository refreshes
and focus recovery reuse unchanged symbols and validate completed ownership
snapshots. Opening or reopening the gutter reuses the full Code Vision result
after checking current HEAD, index, file, configuration and nested repository
boundaries. An uncertain or changed identity falls back to normal Git discovery
and blame. Inactive snapshots are bounded to eight documents and approximately
16 MiB; an active file or pending consumer is protected from eviction.
Prepared results retain the existing 60-second maximum age as well as metadata
validation; unknown identity boundaries always use the normal Git path.

Once real source blocks are confirmed, native preparation shares the existing
overlay connection and discovers the focused file's editor before the click.
Preparation creates no gutter nodes and changes no editor options. The host's
main PID is validated first; an already open inspector has no fixed 500ms wait.

Opaque listeners use a one-time observer of normal Monaco model/DOM/layout
reads during a Code Vision refresh. The refresh retains the existing data and
symbol caches. Only a visible editor with the exact requested URI is retained,
using weak editor/service references. Original method descriptors, receivers,
arguments, results and exceptions are preserved. Capture, cancellation or an
800ms timer restores the temporary methods. A compatible constructor/heap path
remains available when observation cannot capture an editor. Subsequent tabs
reuse the discovered editor service.

Large porcelain output is read one record at a time, sharing commit metadata
while keeping each result's content, original line and filename independent.
Block summaries reuse the file's range index to avoid sorting and filtering each
selected block again. Git history traversal and language-server startup still
contribute to the first Code Vision load.

Output reports `repositoryMs`, `symbolsMs`, `lookupMs`, `blameMs`, `summaryMs`,
`resolveMs`, `snapshotMs`, gutter `source` (`prepared-code-vision` or `git`) and native
`discoverySource`, `discoveryCalls`, `heapQueries`, `discoveryMs` to distinguish
those costs. `native blame editor prepared before click` also reports `connectMs`
and total preparation duration; `method-observer` identifies capture without
a heap query. No Git settings or blame cache freshness rules are weakened.
Repository/symbol/blame stages can overlap, so their durations need not add up
to `durationMs`. A prepared gutter still performs metadata validation and editor
rendering; it does not claim zero end-to-end latency.

`test/blockBlameLatency.test.ts` controls repository (400 ms), symbol (1,200 ms)
and blame (300 ms) completion to verify a 1,500 ms serial dependency becomes
1,200 ms with overlap. Real temporary Git repositories verify that repeated
gutter toggles add no discovery or blame calls and that file, HEAD, index,
configuration, language, document and nested-repository changes reject stale
results. These are regression checks, not timings from a user's VS Code window.

`npm run test:extension -- --blame` opens a separate VS Code profile and temporary
Git repository. It runs the real Block Author command immediately after the hint
is returned and again after preparation in another file, then checks actual
renderer rows, a single column, toggle/width cleanup, the owning main PID and
one Git blame read per file. Timings and screenshots are saved under
`test-results/native-blame`; focus interruptions are recorded separately.

A local 0.1.72110 run with a committed 103-line TypeScript fixture recorded:

| Command to first nonempty native paint | Time | Heap queries | Git blame reads |
| --- | ---: | ---: | ---: |
| First Block Author command in a fresh profile | 30 ms | 0 | 1 |
| Next file after native preparation | 16 ms | 0 | 1 |

Both clicks had no focus interruption, retained one gutter and restored the
original editor methods and width. These timings cover command-to-paint;
VS Code startup, symbol lookup and pre-click preparation are recorded separately.

For a reproducible CPU comparison with 0.1.72106, run:

```sh
npm run benchmark:blame -- --baseline-ref 42079aa
```

The benchmark uses 50,000 synthetic lines, 100 commits and 400 overlapping
blocks, verifies identical parser/summary results, warms the functions and
alternates the version order across 11 samples. It reports median milliseconds.
The unchanged gutter stage is a control for timing noise. These are local CPU
measurements and do not measure Git, editor discovery or end-to-end UI latency.
Without `--baseline-ref`, it measures the current checkout only. Temporary
bundles are removed on completion; the working tree is never checked out.

## Line History

Choose **View Line History** from a line-number menu, the editor menu or a blame
popup. The popup uses that entry's line; other entry points use the context line
or current cursor. Select a change to open that historical file's parent-to-commit
diff at the changed range. Renames use the historical filenames, and root commits
have an empty original side.

The selected line is anchored to its blamed commit, original filename and original
line. Inserting lines above it or renaming the file does not turn the request into
an unrelated current line. Additional pages retain the same immutable anchor.

History follows the first parent from that anchor. The initial page shows up to
30 relevant changes; **Load more line changes** adds 30, up to 200. Each page uses
one bounded Git line-log read. There is no automatic repository-wide history load
or remote fetch. Reads can be cancelled and have a 10-second per-read limit.

Save an edited document before requesting history. New, untracked or uncommitted
lines may have no committed history. Editing or closing the document cancels
pending reads, and an outdated document cannot open a stale selection. Git read
errors are reported in **Git Simple Compare** Output.

## Reference review

Reviewed [Git Blame Annotations](https://github.com/lkqm/vscode-gitblame-annotations)
at [`cc2c600`](https://github.com/lkqm/vscode-gitblame-annotations/tree/cc2c600a75f98a6af39c33a6082cac8c1657c0b3)
(manifest version 0.5.3). This implementation uses the existing Git Simple Compare
gutter, popup, Git execution wrapper and theme tokens; no dependency on that
extension was added.

| Reference capability | Git Simple Compare result |
| --- | --- |
| Per-line annotations and hover details | Existing gutter and complete commit popup retained. |
| Gutter menu and show/hide shortcuts | Block Author clicks toggle the single gutter; scoped Escape closes it. Separate show controls were removed in 0.1.72106. |
| Consecutive commit labels | Optional compact groups with visible-boundary repeat. |
| Same-commit line highlighting | Optional cursor highlight using a cached range index. |
| Date and author formats | Resource settings added; full identity preserved in details. |
| File revision number | Actual short commit hash offered as the stable identifier. |
| Line history | Saved-line picker with bounded pages and historical file diffs. |
| Previous-revision annotation | Historical changes open as read-only diffs; this release does not add a second annotated historical editor mode. |
