# Change Log

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