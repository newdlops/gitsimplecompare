# Resuming a PR operation

Squash cherry-picks and squash reverts run in an isolated temporary worktree.
PR rebase and per-commit revert operations also use this recovery flow when
local changes are present or Temporary Worktree was selected.

When a patch conflicts, Git Simple Compare opens the existing **Conflicts**
view for that temporary worktree. The view identifies the PR and destination
branch. The original working files and index stay in the original worktree.

1. Open each conflicted file. Review Current and Incoming, or edit and stage a
   manual result. In a modify/delete conflict, accepting the absent side keeps
   the deletion; accepting the existing side restores that file. Real content,
   binary and rename conflicts require an explicit resolution.
2. Save and stage the resolutions, then select **Continue PR Operation** in the
   Conflicts toolbar. The view stays available after the last file is resolved.
3. If another patch conflicts, repeat the resolution. The remaining queue is
   retained; completed patches do not need to be replayed.
4. When the queue finishes, the result is applied only if the original branch
   and starting HEAD still match. Overlapping local edits stop the application
   and keep the prepared result. Resolve the destination issue before retrying.

**Return to Working Tree** closes the recovery view without discarding the
temporary worktree. **Git Simple Compare: Resume a saved PR operation and
resolve its conflicts** reopens a saved operation, including after Reload Window.
Repeating the same PR action at the same starting HEAD reuses its saved operation.
This check runs before fetching PR objects or computing another merge result.

Squash prepares the final delta for a verified connected commit range, including
PRs with internal merges or merges from an updated base. External parents and the
exact commit set are checked before aggregation so base-only changes do not leak
into another destination. Ambiguous or disconnected histories keep the native
replay path. Real conflicts in the final delta still require file resolution.

Recovery records belong to the original worktree's Git directory. Source
commits remain pinned until completion, and recovery worktrees are locked so
temporary-worktree cleanup cannot delete unresolved work. Additional untracked
or ignored files created inside a recovery worktree are retained after completion.
Detailed paths and state changes are recorded in **Output → Git Simple Compare**.

Only records created by this version have enough information for automatic
continuation. Old temporary directories without recovery metadata are preserved
but are not adopted by guessing their destination or remaining commit queue.
An interruption during an uncertain Git write also requires inspecting the
preserved worktree; the extension does not blindly replay that write.
