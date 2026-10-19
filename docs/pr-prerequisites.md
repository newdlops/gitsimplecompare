# PR prerequisites

Use **Inspect PR prerequisites** in a PR's action menu before applying it.
When a squash or per-commit PR apply pauses with conflicts, the notification
includes relevant candidate numbers. **Inspect Prerequisites** opens the same
native list. A saved apply operation also exposes this action in the Conflicts
toolbar, including after reloading the window.

Each row shows the PR number, title, discovery reason and verification status:

- **Apply first: conflicts resolved in simulation**: applying this candidate's
  verified final delta before the selected PR produced a clean result.
- **Apply first: N conflicts remain**: that order reduced the conflict count.
- **Changes already satisfied**: applying the candidate did not change the
  destination tree. A different cherry-pick or squash hash alone is not treated
  as a missing prerequisite.
- **Possible prerequisite · unverified**: a branch, declared reference or
  conflicting file's source history suggests a relationship, but the order has
  not been verified.
- **Did not reduce the conflicts**: the candidate was checked but did not help
  this conflict. Sharing a file does not make a PR a prerequisite.

Selecting a PR opens its GitHub page. No prerequisite is automatically applied.
The list identifies the original branch and HEAD being inspected. Working files,
staged changes, branch refs and preserved conflict resolutions are left intact.

For a verified order such as **#41 → #42**, use **Return to Working Tree** if
the PR is paused, apply #41, then run #42 again. **Continue PR Operation** uses
the saved original destination and is for finishing the preserved conflict
resolution; it does not retarget that operation after another PR changes HEAD.

This diagnoses Git application conflicts, not every build or runtime dependency.
An empty result does not prove independence; intentional deletions and unrelated
edits can also cause conflicts. Offline/authentication failures and bounded or
unsupported analysis are shown as incomplete, with details in Output.

Discovery reuses loaded PRs and batches unmatched commit-to-PR associations.
It examines up to 12 source-history commits across 8 conflict paths and simulates
up to 4 candidate PRs. Candidate detail reads stop at the first 100 commits;
incomplete ranges are not guessed. A shared 15-second deadline preserves already
found candidates as unverified partial results. Cancellation stops the owned
reads. Analysis does not fetch other candidate PRs just to complete a simulation.
Normal successful apply operations do not run this diagnosis.
