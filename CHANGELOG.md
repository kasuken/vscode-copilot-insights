# Change Log

# [4.7.0] - 2026-07-20

### Added
- **`@insights` chat participant**: chat with Copilot Insights directly in Copilot Chat via `@insights`, with `/quota`, `/pacing`, and `/forecast` commands backed by your live quota data and local history.
- **Organization Copilot metrics (opt-in)**: a new `Copilot Insights: Show Organization Metrics` command surfaces org-level Copilot usage; set the `copilotInsights.organization` setting to enable it.
- **Reset-day notification**: an optional notification (`copilotInsights.notifyOnReset`) when your billing period rolls over and the AI credit quota resets.
- **Alert snooze**: usage threshold alerts now offer a "Snooze for 24 hours" action.
- **Scheduled history auto-export**: the local snapshot history can be exported automatically once per day via the `copilotInsights.autoExport.*` settings (JSON or CSV).

# [4.6.6] - 2026-07-07

### Changed
- **Plan Details UI**: refreshed the sidebar plan summary with a stronger plan highlight, compact feature access indicators, organization count context, and responsive layout behavior for narrow views.

# [4.6.5] - 2026-07-06

### Added
- **Burn Rate bar/line combo chart**: the Burn Rate Analysis section now compares overall and recent burn rates as bars with a target pace line for lasting until reset.

# [4.6.4] - 2026-07-06

### Added
- **Forecast Range chart**: the Weighted Prediction section now projects remaining AI credits through reset with optimistic, expected, and pessimistic burn-rate scenarios based on prediction confidence.

# [4.6.3] - 2026-07-06

### Added
- **Remaining vs Used doughnut chart**: the Sprint Burn-down section now includes a compact quota composition chart for used, remaining, and overage AI credits.

# [4.6.2] - 2026-07-06

### Added
- **Daily AI credit usage chart**: the Sprint Burn-down section now includes a compact daily bar chart that estimates credits used per day from local refresh deltas, making spikes easier to spot.

# [4.6.1] - 2026-07-06

### Changed
- **Chart rendering migrated to Chart.js**: replaced custom SVG-based history and sprint burn-down rendering with a Chart.js-powered canvas implementation while preserving existing pacing logic, trend projection, today marker, and status/legend messaging.
- **Webview asset packaging**: the Chart.js UMD bundle is now copied into `media/` during `copy-assets` so charts keep working offline under the extension webview CSP.

# [4.6.0] - 2026-07-05

### Added
- **Configurable usage alerts**: new `copilotInsights.alertThresholds` setting (default `[85]`) — set multiple thresholds (e.g. `[50, 75, 90]`); each fires once per billing period.
- **Used today + daily budget**: the Sprint Burn-down section now shows AI credits used since midnight, optionally compared against a `copilotInsights.dailyBudget`.
- **Copilot Chat integration**: a `#copilotQuota` language model tool lets Copilot Chat answer questions like “how many AI credits do I have left?” with your live quota data.
- **Export & clear history**: new commands to export the local snapshot history as JSON/CSV or clear it.
- **Status bar style picker**: `Copilot Insights: Choose Status Bar Style` with live preview while you browse the seven styles.
- **Logging**: a `Copilot Insights` output channel (with `Show Logs` command) records refreshes, alerts, migrations, and background errors.
- **Getting Started walkthrough** for new users.
- **Localization infrastructure**: contribution strings externalized to `package.nls.json`, all sidebar and notification strings routed through `vscode.l10n`, locale-aware date and relative-time formatting following your VS Code display language, and an `l10n/` bundle template for translators.

### Changed
- `Reset to Defaults` now removes setting overrides instead of writing explicit values into your settings.json.

# [4.5.0] - 2026-07-05

### Changed
- **No more scroll jumps**: the sidebar now updates in place via messages instead of re-rendering the whole page on every refresh, so your scroll position survives background polling.
- **Per-account history**: local snapshot history is now stored per GitHub account, so switching accounts no longer mixes usage data. Existing history is migrated automatically.
- **Bundled with esbuild**: faster activation and a smaller extension package.
- Internal: the extension was split from a single 2,700-line file into focused modules (API client, quota math, history, predictions, status bar, webview) with a 65-test suite and CI/release GitHub Actions workflows.

# [4.4.0] - 2026-07-05

### Added
- **Status bar background colors**: the status bar item now actually colors its background (red when over quota, yellow below 20% remaining) when `copilotInsights.statusBar.enableColoredBackground` is enabled — previously the setting only switched icons.
- **Sign-in state**: when no GitHub session is available, the status bar and sidebar show a clear "Sign in" state with a button instead of a spinner or error.
- The extension refreshes automatically when you sign in or out of GitHub in VS Code.

### Fixed
- No more GitHub sign-in prompt at VS Code startup: authentication is silent in the background and only interactive when you open the Insights view or refresh manually.
- Clearer error message for 401/403 authentication failures, with a hint to re-authenticate.
- All API-provided values rendered in the sidebar are now HTML-escaped, and the webview Content-Security-Policy is hardened (nonce-based scripts, no remote resources).
- Codicon icons are bundled locally instead of loading from a remote CDN — the sidebar now renders fully offline.

### Removed
- Removed the non-functional `copilotInsights.autoRefreshInterval` setting. If you had it configured, the value is migrated automatically to `copilotInsights.pollingIntervalSeconds`.
- The extension no longer writes default settings into your `settings.json` on first install.

# [4.3.1] - 2026-07-04

### Added
- Added clearer explanations for unlimited Chat messages and IDE code suggestions in quota cards.

# [4.3.0] - 2026-06-18

### Added
- **Day 0 starting point**: The burn-down now seeds a default data point at the start of the billing period (full entitlement) so the chart always begins from the top-left, even before the first refresh of a new period is recorded.
- **Usage trend line**: A projected trend line extrapolates your observed burn rate to the reset date (or to the point where credits would run out), with a footnote showing the projected run-out date when applicable.

# [4.2.0] - 2026-06-18

### Changed
- **Sprint Burn-down**: Replaced the "Local Change History" section with a sprint-style burn-down chart. The current billing period acts as the "sprint": the chart plots your actual AI credit usage against an ideal burn line that trends to zero by the reset date, with a "today" marker and an at-a-glance on-track / behind-pace status. The familiar burn-down paradigm makes it easier to see whether you're pacing within budget.

# [4.1.2] - 2026-06-16

### Added
- Added clearer labels and descriptions for Copilot Chat and Suggestions quota cards.

# [4.1.1] - 2026-06-05

### Updated
- Updated screenshot in the README to reflect the new AI prediction and burn rate analysis features added in 4.1.0.

# [4.1.0] - 2026-06-04

### Added
- Estimated daily and monthly cost in USD for burn rate analysis. 

# [4.0.2] - 2026-06-03

### Added 
- Link to the official GitHub Copilot documentation for AI Credits.
  
### Changed
-  titles for model cost labels to be more descriptive:
  - Efficient (0.33x) to Efficient
  - Standard (1x) to Standard
  - Advanced (3x) to Advanced 

  # [4.0.1] - 2026-06-02

  ### Fixed
  - **"Over by" number formatting**: Overage amounts are now rounded to 1 decimal place, preventing raw floating-point values (e.g. `1.2999999999998`) from appearing in the status bar, tooltips, sidebar, and exports.

# [4.0.0] - 2026-06-01

### Changed
- **AI Credits Billing Model**: GitHub moved from "Premium Requests" to "AI Credits". The extension now uses AI Credits terminology everywhere (status bar, tooltips, sidebar, pacing, predictions, and exports).
- **Credit Cost**: Estimated overage cost now uses 1 AI credit = $0.01 USD (previously $0.04 per premium request).
- **Setting Renamed**: `copilotInsights.customPremiumLimit` is now `copilotInsights.customCreditLimit`. Existing values are migrated automatically on first launch.
- **API Fields**: Added support for the new `token_based_billing` flag and `analytics_tracking_id` field returned by the Copilot user endpoint.

# [3.9.0] - 2026-05-12

### Added
- **Extended Plan Details**: New summary cards for CLI, MCP, and Preview Features status in the Insights sidebar for a more complete view of your Copilot capabilities.
- **GitHub Login Display**: Your GitHub login is now shown in the Access Details section.
- **Copilotignore & Restricted Telemetry**: Access Details now surfaces `.copilotignore` support and restricted telemetry status.
- **Clipboard & Markdown Export**: Plan details export now includes CLI, MCP, and Preview Features status.

# [3.8.7] - 2026-04-10

### Added
- **Custom Premium Limit Setting**: Added `copilotInsights.customPremiumLimit` so you can define a higher monthly premium request budget (for example, when overage is enabled).

### Changed
- **Effective Quota Calculations**: Premium quota cards, percentages, pacing guidance, and usage indicators now honor the configured custom premium limit when it is higher than the plan entitlement.
- **Configuration Reactivity**: Sidebar and status bar visuals now refresh when `copilotInsights.customPremiumLimit` changes.

### Fixed
- **Reset to Defaults Coverage**: "Reset to Defaults" now also resets `copilotInsights.customPremiumLimit` to `0`.

# [3.8.6] - 2026-04-10

### Added
- **Configurable Polling Interval (Seconds)**: Added `copilotInsights.pollingIntervalSeconds` to control background refresh cadence in seconds, with `0` to disable polling.

### Changed
- **Silent Background Refresh**: Background polling now refreshes data without auth prompts or error toasts.
- **Polling Lifecycle Management**: Polling timer is now managed by the view provider and restarts when polling settings change.
- **Extension Kind**: Declared extension runtime kind as `ui`.

### Fixed
- **No Overlapping Fetches**: Prevented concurrent refresh requests during background polling.
- **Reset to Defaults Coverage**: "Reset to Defaults" now restores `copilotInsights.pollingIntervalSeconds` to its default value.

# [3.8.5] - 2026-03-31

### Changed
- **Increased Snapshot History**: Local snapshot history now stores up to 90 snapshots (previously 10) for richer trend and prediction data.

# [3.8.4] - 2026-03-30

### Added
- **Disable Status Bar Coloring**: New `copilotInsights.statusBar.enableColoredBackground` setting to turn off the red/yellow background coloring on the status bar item. Useful for users with an overage budget who don't want the toolbar to turn red when standard PRU runs out.

# [3.7.4] - 2026-03-20

### Added
- **Automatic Background Refresh**: Copilot data now refreshes periodically after activation so the status bar stays current even when the Insights view is not opened for a while.
- **Auto Refresh Interval Setting**: Added `copilotInsights.autoRefreshInterval` to control how often Copilot data is refreshed automatically in the background.

# [3.7.3] - 2026-03-16

### Changed
- **Quota Card Ordering**: Quotas in the Insights view are now sorted so **Premium Interactions** appears first for faster visibility of the most important limit.

# [3.7.1] - 2026-03-10

### Added
- **Insights View Icon**: Added an icon for the Copilot Insights sidebar view for better discoverability in the activity UI.

### Changed
- **Fractional Quota Precision**: Premium quota remaining, used values, and percentages now preserve fractional precision in the sidebar and status bar to better match GitHub Copilot's reported usage.

# [3.7.0] - 2026-03-09

### Added
- **JSON Clipboard Export**: Copy the raw Copilot Insights payload as formatted JSON directly from the sidebar.

## [3.6.0] - 2026-02-05

### Added
- **Overage Cost Estimation**: Premium quota cards now show estimated overage cost when your plan allows usage beyond the included quota.
- **Quota Exceeded Summary**: Over-quota states now show a focused summary with overage amount, total used, and reset timing.

### Changed
- Improved overage messaging so permitted overages and blocked premium usage are easier to distinguish.

# [3.5.0] - 2026-02-04

### Added
- **Quota Usage Breakdown**: See a breakdown of premium usage by day and by organization.
- **Advanced Error Reporting**: More detailed error messages and troubleshooting tips in the sidebar.
- **Snapshot Export Improvements**: Export quota snapshots with timestamps for better tracking.
- **Accessibility Enhancements**: Improved keyboard navigation and screen reader support in the sidebar view.

### Changed
- UI polish for quota breakdown and error banners.
- Minor performance improvements for sidebar refresh.

## [3.0.0] - 2026-01-28

### Added
- **Weighted Prediction**: Estimates daily premium usage, with confidence level and exhaustion forecast.
- **Burn Rate Analysis**: Detects if usage is accelerating, slowing, or stable, comparing recent and average burn rates.
- **Visual Trend Chart**: Enhanced local quota history with a line chart and improved snapshot filtering.
- **Sidebar & Status Bar Enhancements**: More real-time updates, better configuration handling, and improved error feedback.

### Changed
- Smarter local quota history: improved filtering and more accurate comparisons.
- UI/UX refinements and bug fixes for a smoother experience.

## [2.0.0] - 2026-01-13

### Added
- **Local Snapshot History**: Track premium interactions over time with automatic snapshot recording
  - Stores up to 90 local snapshots of premium quota usage
  - Visual line chart showing premium interactions trend over time
  - "Since last refresh" comparison showing change from previous data fetch
  - "Since yesterday" comparison (when 24h+ data available)
  - Smart filtering: only records snapshots when values change (ignores duplicates and zero values)
  - Color-coded changes: red for decreases (quota used), green for increases (quota restored/reset)
  - Positioned prominently after Quotas section for quick visibility
  - All data stored locally - no external syncing
  - Clear "Based on local refreshes" disclaimer

### Changed
- Improved visual hierarchy with snapshot history section in a card layout
- Enhanced chart formatting with relative time labels (e.g., "2h ago", "1d ago")

## [1.8.0] - 2026-01-12

### Added
- Status bar customization settings for location and visual style
- Multiple status bar style options: detailed, progress capsule, circular ring, solid bar, shaded bar, minimalist, and adaptive emoji
- Ability to position status bar on left, right, or both sides
- Granular control over status bar elements (name, numerical quota, visual indicator)

### Changed
- Enhanced status bar configuration with more flexible display options
- Improved visual feedback with multiple indicator styles

## [1.7.0] - 2026-01-09

### Added
- Progress bar display mode setting: show **Remaining** (default) or **Used** quota in the quota progress bars.
- Settings (gear) button in the Insights view title bar to open Copilot Insights settings.

## [1.6.0] - 2026-01-09

### Added
- “What does this mean?” tooltips on key quota UI labels (e.g., Unlimited, Premium interactions, Reset Date, and other critical fields)
- Optional “Quota mood” indicator (😌 / 🙂 / 😬 / 😱) to summarize quota risk at a glance
- Daily capacity projections for common premium model multipliers (0.33x, 1x, 3x)

### Changed
- Reset Date display now shows the date only (no time)

## [1.5.0]

### Added
- "Copy Summary to Clipboard" button in the sidebar view
- Export Copilot insights as formatted Markdown with all plan details, quotas, status badges, and organization information
- One-click copy to clipboard functionality for easy sharing and documentation

## [1.4.0]

### Added
- Status badges for quota health visualization:
  - 🟢 Healthy (>50% remaining)
  - 🟡 Watch (20-50% remaining)
  - 🔴 Risk (<20% remaining)
- Status indicator now appears in the status bar tooltip and quota cards in the sidebar

## [1.3.1]

### Changed
- Copilot plan names are normalized to start with an uppercase letter across the UI.

### Fixed
- Premium usage warning resets correctly when a new billing cycle starts, preventing stale alerts.

## [1.2.0]

### Added
- One-time warning when Premium requests exceed 85% of the monthly quota, with a quick link to open the Insights view.

## [1.0.1]

### Added
- Section title "Projections premium requests before the reset" to better organize pacing guidance in quota cards.

## [1.0.0]

### Added
- Sidebar webview (Copilot Insights) showing plan, access details, organizations, and quotas.
- Quota cards for limited/unlimited quotas (progress bar + remaining/used/total).
- Pacing guidance for quotas:
	- Daily average to last until reset
	- Weekly average (minimum 1 week)
	- Workday average (Mon–Fri, approximate)
	- Work hour average (Mon–Fri 9–5, approximate)
- Status bar indicator for Premium Interactions (remaining/total + percent) with severity icons and tooltip.
- Auto-refresh when the view becomes visible.
- Refresh action in the view title bar.

### Changed
- Improved sidebar layout and section ordering (Quotas at top; Plan Details and Organizations sections).
- Moved “Last fetched” to the bottom of the view.

### Fixed
- Correctly handle `quota_snapshots` returned as an object map (not an array).
- Fixed weekly pacing calculation to avoid inflated values when less than one week remains.