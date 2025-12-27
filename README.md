<p align="center">
	<img src="img/logo.png" width="140" alt="Copilot Insights logo" />
</p>

<h1 align="center">Copilot Insights (VS Code Extension)</h1>

<p align="center">
	Understand your GitHub Copilot plan and quotas at a glance — in the VS Code sidebar and status bar.
</p>

---

## What it does

Copilot Insights surfaces your GitHub Copilot entitlement/quota information and presents it in a VS Code-friendly UI:

- Sidebar view with quota cards and pacing guidance
- Status bar indicator for Premium Interactions (remaining / total + %)
- Auto-refresh when the view becomes visible
- Manual refresh button in the view title bar

> Note: This view shows plan and quota status. It is not a usage report.

---

## Features
- **Sidebar (Copilot Insights)**:
    - Shows your Copilot plan details
    - Lists organizations where you have Copilot access
    - Displays quota cards with progress bars and pacing guidance
    - Auto-refreshes when the view becomes visible
    - Manual refresh button in the title bar
  - **Status bar indicator**:
    - Compact view of Premium Interactions remaining/total + percentage
    - Severity icons based on remaining percentage
    - Tooltip with reset information

## Screenshots

### Sidebar (Copilot Insights)

![Copilot Insights sidebar](img/screen1.png)

### Sidebar: “Insights” view

Open the **Copilot Insights** icon in the Activity Bar.

**Quotas (top section)**
- Shows each quota (e.g. Premium Interactions, Chat, Completions)
- Handles **Unlimited** quotas correctly
- Progress bar + remaining/used/total for limited quotas
- Pacing helpers:
	- **To last until reset**: ≤ X/day
	- **Reset in**: Xd Xh
	- **Reset Date** (UTC)
	- **Weekly average** + **workday/workhour averages**

**Plan Details**
- Plan (e.g. Enterprise)
- Chat enabled
- Orgs count

**Organizations with Copilot Access**
- Lists org name + login so you can see where Copilot is enabled for you

**Access Details**
- Access / SKU
- Assigned date

**Freshness**
- “Last fetched: …” shown at the bottom
- Warning banner if data appears stale (older than 1 hour)

### Status bar

A compact status bar item shows your Premium Interactions remaining at a glance, for example:

- `Copilot: 975/1000 (98%)`

It also adapts the icon based on remaining percentage and includes a tooltip with reset information.

---

## Getting started

1. Install the extension (Marketplace / `.vsix` / local dev)
2. Open **Copilot Insights** from the Activity Bar
3. When prompted, sign in to GitHub using VS Code authentication
4. Review your plan + quotas
5. Use the refresh icon in the view title bar if needed

---

## Refresh behavior

- **Automatic:** refreshes whenever the Insights view becomes visible
- **Manual:** run **Copilot Insights: Refresh** or click the refresh icon in the view title bar

---

## How pacing is calculated (important)

Pacing is based on:

- `remaining` (from the quota snapshot)
- The time between:
	- the latest snapshot `timestamp_utc` (as-of)
	- `quota_reset_date_utc` (reset)

All displayed pacing values use `floor(...)` (rounded down) so they remain conservative.

### Daily average (all days)

- `allowedPerDay = floor(remaining / daysUntilReset)`

### Weekly average (minimum 1 week)

To avoid misleading weekly values when less than one week remains:

- `weeksRemaining = max(1, floor(daysUntilReset / 7))`
- `allowedPerWeek = floor(remaining / weeksRemaining)`

### Workday / workhour averages (Mon–Fri, 9–5)

Workdays are approximated proportionally:

- `workingDays ≈ floor(daysUntilReset * 5/7)`
- `allowedPerWorkDay = floor(remaining / workingDays)` (if `workingDays > 0`)

Working hours assume 8 hours/day (9:00–17:00):

- `totalWorkingHours = workingDays * 8`
- `allowedPerHour = floor(remaining / totalWorkingHours)` (if `totalWorkingHours > 0`)

> These workday/workhour numbers are approximations (they don’t iterate real calendar weekdays).

---

## Data source & permissions

Copilot Insights uses VS Code’s built-in GitHub authentication and calls:

- `https://api.github.com/copilot_internal/user`

Authentication is handled via VS Code’s GitHub auth provider.

---

## Troubleshooting

### “No quota data available”

- Verify you’re signed into the correct GitHub account in VS Code
- Ensure your account has Copilot enabled
- Use the refresh command/icon

### GitHub API errors (403/404)

- Your account/tenant may not have access to this endpoint
- The endpoint may change (it is internal)

---

## Development

```sh
npm install
npm run watch
```

Press **F5** in VS Code to start an Extension Development Host.

---

## License

Add your preferred license (MIT, Apache-2.0, etc.).
