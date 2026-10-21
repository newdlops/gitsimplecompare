# PR list UI verification — 0.1.72133

PR rows now separate the title/state, author/update time, reviewers and actions. Long titles wrap. Native theme/Codicon states use readable labels. A title button provides keyboard entry without nesting action buttons inside another button. Loaded reviewers expand and collapse in place; capped results explicitly say the list is partial. No new GitHub requests or external avatar downloads are introduced. Two date formatters are shared per locale.

## Functional checks

Final headless Chromium run: 20/20 cases across PR list loading, people, presentation and detail suites. Tested 80 rows, reviewer search, Enter/Space activation, reviewer disclosure, updates preserving disclosure/focus, partial/empty/unavailable reviewers, invalid dates, draft/open/merged/closed states, cached reopen, retry, Korean IME, streaming metadata, stale responses and all 105 changed files. Related Node checks: 11/11. Types pass.

## Visual and accessibility checks

Actual production CSS/JS in the Graph drawer fixture inspected at 390×844, 768×1024 and 1440×900. Dark dense-data states and expanded reviewers inspected; final light/390, forced-colors/768 and dark/1440 screenshots inspected separately. Layout follows drawer width using a container query. No horizontal overflow was observed. Axe reports zero violations for each themed list and the existing three detail viewport cases.

Applied ui-design-workflow, Impeccable critique and [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md). Fixed invalid search-label role and decorative-icon ARIA. Retained original failed test logs: changing button name caused a test locator failure; forced-color token mismatch caused a fixture-only contrast result. Checks were corrected without disabling rules or increasing timeouts.

Screenshots and raw audit JSON hashes are in [the release evidence](promisor-push-0.1.72133.json). No foreground Extension Development Host or live user session was opened or reloaded; host transport is mocked in these UI fixtures.
