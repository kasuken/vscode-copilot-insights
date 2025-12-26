# Change Log

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