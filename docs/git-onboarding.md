# Git onboarding

Git Simple Compare starts with its own Git CLI. VS Code's `git.enabled`,
`git.autorefresh`, and `git.autofetch` settings remain owned by the user.
Optional reuse of native status is an extension setting, not a native Git toggle.

The existing Changes sidebar is the entry point. Before a repository is found,
show a compact welcome with Clone Repository, Clone from GitHub, Open Repository,
and Initialize Repository. Keep VS Code typography, Codicons, semantic theme
tokens, shared button styles, and the existing information density. Avoid an
extra wizard or modal that repeats information available in the sidebar.

Repository setup uses the shared Git execution layer. GitHub repository selection
uses the existing VS Code GitHub authentication provider directly and does not
depend on `vscode.git` or GitHub's native Git integration. Keep credentials out of
URLs, command arguments, stored preferences, and logs. After setup, refresh the
repository registry and focus Changes; carry that handoff through folder opening.

Acceptance checks:

- All native Git settings remain byte-for-byte equivalent after activation,
  onboarding, backend selection, clone, initialization, and cancellation.
- URL clone, authenticated GitHub selection, existing repositories, and folder
  initialization work with native Git enabled or disabled, including an empty window.
- Existing destinations and existing repositories are preserved. Cancelled work
  stops its owned Git process and does not claim success.
- Show real loading, busy, empty, retry, error, cancellation, and completion states.
- Every action has a tooltip and accessible name; keyboard focus remains visible.
- Inspect the actual welcome renderer at 390, 768, and 1440 pixels, with long
  localized labels, and verify setup-to-Changes in an isolated Extension Host.
