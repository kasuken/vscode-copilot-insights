# Change Log

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