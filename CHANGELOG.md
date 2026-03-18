# Change Log

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
  - Stores up to 10 local snapshots of premium quota usage
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