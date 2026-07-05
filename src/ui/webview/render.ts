import * as vscode from "vscode";
import { CopilotUserData, CREDIT_COST_USD, LocalSnapshot } from "../../types";
import {
  calculateTimeSince,
  escapeHtml,
  formatDate,
  formatQuotaName,
  formatQuotaValue,
  getNonce,
} from "../../core/format";
import {
  calculateDaysUntilReset,
  computeQuotaStats,
  getEffectiveQuota,
  getMood,
  getStatusBadge,
} from "../../core/quota";
import { getSnapshotComparisons, getUsedToday } from "../../core/history";
import { getTrendPrediction, getWeightedPrediction } from "../../core/predictions";

// Localization helper. Dynamic values from core (badge labels, mood texts)
// are passed through t() at render time; translators provide those strings
// in the language bundles keyed by their English text.
const t = vscode.l10n.t;

/** Configuration snapshot needed to render the insights view. */
export interface RenderConfig {
  showMood: boolean;
  progressBarMode: string;
  customLimit: number;
  enableColoring: boolean;
  dailyBudget: number;
}

/** Serializable model posted to the webview. Each section is prebuilt HTML. */
export interface InsightsViewModel {
  state: "data";
  sections: {
    stale: string;
    quotas: string;
    history: string;
    weighted: string;
    trend: string;
    summary: string;
    orgs: string;
    access: string;
  };
  lastFetched: string;
}

export type WebviewStateMessage =
  | { state: "loading" }
  | { state: "signin" }
  | { state: "error"; message: string }
  | InsightsViewModel;

/**
 * Renders the static webview shell. This HTML is set once per webview
 * lifetime; all data arrives via postMessage so refreshes never reset the
 * scroll position.
 */
export function renderShellHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const mediaUri = (...parts: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", ...parts));

  return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${mediaUri("codicons", "codicon.css")}">
	<link rel="stylesheet" href="${mediaUri("main.css")}">
	<title>Copilot Insights</title>
</head>
<body>
	<div id="state-loading" class="state loading">${t("Loading Copilot data...")}</div>

	<div id="state-signin" class="state signin hidden">
		<p>${t("Sign in with GitHub to see your Copilot plan, quotas, and usage insights.")}</p>
		<button id="signInButton">${t("Sign in with GitHub")}</button>
	</div>

	<div id="state-error" class="state hidden">
		<div class="error">
			<h2>${t("Error Loading Copilot Data")}</h2>
			<p id="error-message"></p>
		</div>
	</div>

	<div id="state-data" class="state hidden">
		<div id="section-stale"></div>
		<div id="section-quotas"></div>
		<div id="section-history"></div>
		<div id="section-weighted"></div>
		<div id="section-trend"></div>
		<div id="section-summary"></div>
		<div id="section-orgs"></div>
		<div id="section-access"></div>

		<div class="disclaimer">
			ℹ️ ${t("This view shows plan and quota status. It is not a usage report.")}
		</div>

		<button id="copyButton" class="copy-button">
			<span class="codicon codicon-clippy"></span>
			${t("Copy Summary to Clipboard")}
		</button>

		<button id="copyJsonButton" class="copy-button copy-button-secondary">
			<span class="codicon codicon-json"></span>
			${t("Copy JSON to Clipboard")}
		</button>

		<div id="last-updated" class="last-updated"></div>
	</div>

	<script nonce="${nonce}" src="${mediaUri("main.js")}"></script>
</body>
</html>`;
}

/** Builds the full data-state view model with prebuilt section HTML. */
export function buildViewModel(
  data: CopilotUserData,
  snapshots: readonly LocalSnapshot[],
  config: RenderConfig
): InsightsViewModel {
  const quotaSnapshotsArray = data.quota_snapshots
    ? Object.values(data.quota_snapshots)
    : [];

  const latestSnapshot =
    quotaSnapshotsArray.length > 0 ? quotaSnapshotsArray[0] : null;

  const asOfTime = latestSnapshot?.timestamp_utc || new Date().toISOString();
  const timeSince = calculateTimeSince(asOfTime, vscode.env.language);

  // Check if data is stale (> 1 hour old)
  const isStale =
    new Date().getTime() - new Date(asOfTime).getTime() > 3600000;

  return {
    state: "data",
    sections: {
      stale: isStale
        ? `<div class="warning-banner">⚠️ ${t("Data may be stale (fetched over 1 hour ago)")}</div>`
        : "",
      quotas: renderQuotasSection(data, asOfTime, config),
      history: renderHistorySection(data, snapshots, config),
      weighted: renderWeightedPredictionSection(data, snapshots, config.customLimit),
      trend: renderTrendSection(snapshots),
      summary: renderSummarySection(data),
      orgs: renderOrgsSection(data),
      access: renderAccessSection(data),
    },
    lastFetched: t("Last fetched: {0}", timeSince),
  };
}

function renderSummarySection(data: CopilotUserData): string {
  const orgCount = data.organization_list?.length || 0;
  const enabledText = (value: boolean) => (value ? t("Enabled") : t("Disabled"));

  return `
		<div class="section">
			<h2 class="section-title">${t("Plan Details")}</h2>
			<div class="summary-cards">
				<div class="summary-card">
					<div class="card-label" title="${t("Your GitHub Copilot subscription plan")}">${t("Plan")}</div>
					<div class="card-value">${escapeHtml(data.copilot_plan) || t("Unknown")}</div>
				</div>
				<div class="summary-card">
					<div class="card-label" title="${t("Access to Copilot Chat features")}">${t("Chat")}</div>
					<div class="card-value">${enabledText(data.chat_enabled)}</div>
				</div>
				<div class="summary-card">
					<div class="card-label" title="${t("Access to Copilot CLI features")}">${t("CLI")}</div>
					<div class="card-value">${enabledText(data.cli_enabled)}</div>
				</div>
				<div class="summary-card">
					<div class="card-label" title="${t("Model Context Protocol support")}">${t("MCP")}</div>
					<div class="card-value">${enabledText(data.is_mcp_enabled)}</div>
				</div>
				<div class="summary-card">
					<div class="card-label" title="${t("Editor preview features access")}">${t("Preview")}</div>
					<div class="card-value">${enabledText(data.editor_preview_features_enabled)}</div>
				</div>
				<div class="summary-card">
					<div class="card-label" title="${t("Organizations providing your Copilot seat")}">${t("Orgs")}</div>
					<div class="card-value">${orgCount}${orgCount > 1 ? " 🔗" : ""}</div>
				</div>
			</div>
		</div>
	`;
}

function renderOrgsSection(data: CopilotUserData): string {
  if (!data.organization_list || data.organization_list.length === 0) {
    return "";
  }

  return `
		<div class="section">
			<h2 class="section-title">${t("Organizations with Copilot Access")}</h2>
			<div class="org-list">
				${data.organization_list
      .map(
        (org) => `
					<div class="org-item">
						<div class="org-name">${escapeHtml(org.name || org.login)}</div>
						<div class="org-login">@${escapeHtml(org.login)}</div>
					</div>
				`
      )
      .join("")}
			</div>
		</div>
	`;
}

function renderAccessSection(data: CopilotUserData): string {
  const enabledText = (value: boolean) => (value ? t("Enabled") : t("Disabled"));

  return `
		<div class="section">
			<h2 class="section-title">${t("Access Details")}</h2>
			<div class="quota-card">
				<div class="quota-stats">
					${data.login ? `<div class="stat">
						<span class="stat-label" title="${t("Your GitHub login")}">${t("Login")}</span>
						<span class="stat-value">${escapeHtml(data.login)}</span>
					</div>` : ""}
					<div class="stat">
						<span class="stat-label" title="${t("The specific SKU or access type of your subscription")}">${t("SKU/Access")}</span>
						<span class="stat-value">${escapeHtml(data.access_type_sku) || t("Unknown")}</span>
					</div>
					<div class="stat">
						<span class="stat-label" title="${t("Date when this seat was assigned to you")}">${t("Assigned")}</span>
						<span class="stat-value">${formatDate(data.assigned_date, vscode.env.language)}</span>
					</div>
					<div class="stat">
						<span class="stat-label" title="${t("Whether .copilotignore is supported")}">.copilotignore</span>
						<span class="stat-value">${enabledText(data.copilotignore_enabled)}</span>
					</div>
					<div class="stat">
						<span class="stat-label" title="${t("Whether telemetry is restricted for your organization")}">${t("Restricted Telemetry")}</span>
						<span class="stat-value">${data.restricted_telemetry ? t("Yes") : t("No")}</span>
					</div>
				</div>
			</div>
		</div>
	`;
}

function renderQuotasSection(
  data: CopilotUserData,
  asOfTime: string,
  config: RenderConfig
): string {
  const quotaSnapshotsArray = data.quota_snapshots
    ? Object.values(data.quota_snapshots)
    : [];

  const timeUntilReset = calculateDaysUntilReset(
    data.quota_reset_date_utc,
    asOfTime
  );

  let quotasHtml = "";
  if (quotaSnapshotsArray.length > 0) {
    // Sort so AI Credits appears first
    const sortedQuotas = [...quotaSnapshotsArray].sort((a, b) => {
      if (a.quota_id === "premium_interactions") { return -1; }
      if (b.quota_id === "premium_interactions") { return 1; }
      return 0;
    });
    quotasHtml = sortedQuotas
      .map((quota) => {
        const quotaName = escapeHtml(formatQuotaName(quota.quota_id));

        let quotaTooltip = "";
        if (quota.quota_id === "premium_interactions") {
          quotaTooltip = t("AI credits are consumed by Copilot features. Different models consume credits at different rates.");
        } else if (quota.quota_id === "chat") {
          quotaTooltip = t("Chat covers prompts and responses in Copilot Chat conversations.");
        } else if (quota.quota_id === "completions") {
          quotaTooltip = t("Suggestions are inline code suggestions shown while you type in the editor.");
        }

        const quotaDescription = quota.quota_id === "chat"
          ? t("Chat is your interactive Copilot conversation usage.")
          : quota.quota_id === "completions"
            ? t("Suggestions are inline code proposals while you type.")
            : "";

        if (quota.unlimited) {
          const unlimitedDescription = quota.quota_id === "chat"
            ? t("Chat messages are not limited by message count, but calls to premium AI models and other metered Copilot capabilities may consume GitHub AI Credits.")
            : quota.quota_id === "completions"
              ? t("Code suggestions in the IDE are included with this plan and do not consume GitHub AI Credits.")
              : t("This plan includes this feature without a tracked monthly balance. GitHub AI Credits may still apply separately to premium models and metered capabilities.");
          return `
					<div class="quota-card">
						<div class="quota-header">
							<div class="quota-title" title="${quotaTooltip}">${quotaName}</div>
							<div class="quota-badge unlimited" title="${t("You have unlimited usage for this feature")}">${t("Unlimited")}</div>
						</div>
						${quotaDescription ? `<div class="quota-description">${quotaDescription}</div>` : ""}
						<div class="quota-description">${unlimitedDescription}</div>
					</div>
				`;
        }

        // Apply custom AI credit limit if configured (only for premium_interactions)
        const effectiveQ = quota.quota_id === "premium_interactions"
          ? getEffectiveQuota(quota, config.customLimit)
          : quota;
        const { used, isOverQuota, percentRemaining, percentUsed, overageAmount } = computeQuotaStats(effectiveQ);
        const statusBadge = getStatusBadge(percentRemaining, config.enableColoring);
        const effectiveEntitlement = effectiveQ.entitlement;
        const effectiveRemaining = effectiveQ.remaining;
        const mood = getMood(percentRemaining);

        const showUsed = config.progressBarMode === "used";

        // Determine progress bar values based on mode (clamp to valid range)
        const clampedPercentUsed = Math.min(percentUsed, 100);
        const clampedPercentRemaining = Math.max(percentRemaining, 0);
        const progressPercent = showUsed ? clampedPercentUsed : clampedPercentRemaining;

        // For the label, show overage info when over quota
        let progressLabel: string;
        if (isOverQuota) {
          progressLabel = t("Over by {0}", overageAmount);
        } else {
          progressLabel = showUsed ? t("{0}% used", percentUsed) : t("{0}% remaining", percentRemaining);
        }

        // Determine progress bar color based on usage level (always based on usage for intuitive coloring)
        const progressBarColor = isOverQuota || percentUsed > 80
          ? 'var(--vscode-charts-red)'
          : percentUsed > 50
            ? 'var(--vscode-charts-yellow)'
            : 'var(--vscode-charts-green)';

        // Calculate pacing - only show recommendations when there's remaining quota
        let pacingHtml = "";
        if (timeUntilReset.totalDays > 0) {
          if (isOverQuota) {
            // Show overage summary instead of pacing recommendations
            const planEntitlementOver = quota.entitlement;
            const hasCustomLimitOver = effectiveEntitlement > planEntitlementOver;
            const overageRequestsOver = Math.max(0, used - planEntitlementOver);
            const currentCostOver = overageRequestsOver * CREDIT_COST_USD;

            pacingHtml = `
					<div class="quota-pacing-highlight" style="border-left: 3px solid var(--vscode-charts-red);">
						<div style="font-size: 12px; font-weight: 600; margin-bottom: 8px; color: var(--vscode-charts-red);">
							⚠️ ${hasCustomLimitOver ? t("Custom Limit Exceeded") : t("Quota Exceeded")}
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${hasCustomLimitOver ? t("Amount over the custom limit of {0}", effectiveEntitlement) : t("Amount over the monthly quota of {0}", planEntitlementOver)}">${hasCustomLimitOver ? t("Over limit by:") : t("Over quota by:")}</span>
							<span class="pacing-value" style="color: var(--vscode-charts-red);">${t("{0} credits", overageAmount)}</span>
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Total usage this period")}">${t("Total used:")}</span>
							<span class="pacing-value">${t("{0} of {1}", used, effectiveEntitlement)}${hasCustomLimitOver ? ' (' + t("plan: {0}", planEntitlementOver) + ')' : ''}</span>
						</div>
						<div class="pacing-separator" style="height: 1px; background-color: var(--vscode-panel-border); margin: 8px 0;"></div>
						<div style="font-size: 12px; font-weight: 600; margin-bottom: 6px; color: var(--vscode-foreground);">
							💰 ${t("Estimated Cost")}
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Credits beyond your plan's built-in {0} entitlement (billed at ${1}/credit)", planEntitlementOver, CREDIT_COST_USD)}">${t("Billable overage:")}</span>
							<span class="pacing-value">${t("{0} beyond plan ({1})", overageRequestsOver, planEntitlementOver)}</span>
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Current estimated cost at ${0}/credit", CREDIT_COST_USD)}">${t("Current cost:")}</span>
							<span class="pacing-value" style="color: var(--vscode-charts-orange);">$${currentCostOver.toFixed(2)}</span>
						</div>
						<div class="pacing-separator" style="height: 1px; background-color: var(--vscode-panel-border); margin: 8px 0;"></div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Time remaining until quota reset")}">${t("Reset in:")}</span>
							<span class="pacing-value">${t("{0}d {1}h", timeUntilReset.days, timeUntilReset.hours)}</span>
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Date when your monthly quota resets")}">${t("Reset Date:")}</span>
							<span class="pacing-value">${formatDate(data.quota_reset_date_utc, vscode.env.language)}</span>
						</div>
						${quota.overage_permitted ? `
						<div class="pacing-separator" style="height: 1px; background-color: var(--vscode-panel-border); margin: 8px 0;"></div>
						<div style="font-size: 11px; color: var(--vscode-descriptionForeground);">
							✓ ${t("Overage is permitted for your plan. AI credits will continue to work.")}
						</div>
						` : `
						<div class="pacing-separator" style="height: 1px; background-color: var(--vscode-panel-border); margin: 8px 0;"></div>
						<div style="font-size: 11px; color: var(--vscode-charts-red);">
							✗ ${t("Overage is not permitted. AI credits may be limited until reset.")}
						</div>
						`}
					</div>
				`;
          } else {
            const allowedPerDay = Math.floor(
              effectiveRemaining / timeUntilReset.totalDays
            );

            // Calculate weeks remaining until reset (minimum 1 week)
            const weeksRemaining = Math.max(1, timeUntilReset.totalDays / 7);
            const allowedPerWeek = Math.floor(effectiveRemaining / weeksRemaining);

            // Calculate working days (Mon-Fri) until reset
            const workingDays = Math.floor(timeUntilReset.totalDays * (5 / 7)); // Approximate working days
            const allowedPerWorkDay =
              workingDays > 0 ? Math.floor(effectiveRemaining / workingDays) : 0;

            // Calculate working hours (Mon-Fri, 9 AM - 5 PM = 8 hours/day)
            const totalWorkingHours = workingDays * 8;
            const allowedPerHour =
              totalWorkingHours > 0
                ? Math.floor(effectiveRemaining / totalWorkingHours)
                : 0;

            // Calculate projections for multipliers
            const budget033 = Math.floor(
              effectiveRemaining / 0.33 / timeUntilReset.totalDays
            );
            const budget1 = Math.floor(effectiveRemaining / timeUntilReset.totalDays);
            const budget3 = Math.floor(
              effectiveRemaining / 3 / timeUntilReset.totalDays
            );

            // Show estimated cost when custom limit exceeds plan entitlement
            const planEntitlement = quota.entitlement;
            const hasCustomLimit = effectiveEntitlement > planEntitlement;
            const overageRequests = Math.max(0, used - planEntitlement);
            const currentCost = overageRequests * CREDIT_COST_USD;
            const maxOverageRequests = effectiveEntitlement - planEntitlement;
            const budgetCost = maxOverageRequests * CREDIT_COST_USD;

            pacingHtml = `
					<div class="quota-pacing-highlight">
						${hasCustomLimit ? `
						<div style="font-size: 12px; font-weight: 600; margin-bottom: 6px; color: var(--vscode-foreground);">
							💰 ${t("Estimated Cost (limit: {0}, plan: {1})", effectiveEntitlement, planEntitlement)}
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Credits beyond your plan's built-in {0} entitlement", planEntitlement)}">${t("Overage credits:")}</span>
							<span class="pacing-value">${t("{0} of {1}", overageRequests, maxOverageRequests)}</span>
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Current estimated cost at ${0}/credit", CREDIT_COST_USD)}">${t("Current cost:")}</span>
							<span class="pacing-value" style="color: ${currentCost > 0 ? 'var(--vscode-charts-orange)' : 'var(--vscode-foreground)'};">$${currentCost.toFixed(2)}</span>
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Maximum cost if you use all {0} credits", effectiveEntitlement)}">${t("Budget cap:")}</span>
							<span class="pacing-value">$${budgetCost.toFixed(2)}</span>
						</div>
						<div class="pacing-separator" style="height: 1px; background-color: var(--vscode-panel-border); margin: 8px 0;"></div>
						` : ''}
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Maximum average daily usage to stay within quota")}">${t("To last until reset:")}</span>
							<span class="pacing-value">${t("≤ {0}/day", allowedPerDay)}</span>
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Time remaining until quota reset")}">${t("Reset in:")}</span>
							<span class="pacing-value">${t("{0}d {1}h", timeUntilReset.days, timeUntilReset.hours)}</span>
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Date when your monthly quota resets")}">${t("Reset Date:")}</span>
							<span class="pacing-value">${formatDate(data.quota_reset_date_utc, vscode.env.language)}</span>
						</div>
						<div class="pacing-separator" style="height: 1px; background-color: var(--vscode-panel-border); margin: 8px 0;"></div>
						<div style="font-size: 11px; font-weight: 600; margin-bottom: 6px; color: var(--vscode-foreground);">
							${t("Projected AI credits before the reset")}
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Recommended weekly limit")}">${t("Weekly average:")}</span>
							<span class="pacing-value">${t("≤ {0}/week", allowedPerWeek)}</span>
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Recommended daily limit for Mon-Fri")}">${t("Work day average:")}</span>
							<span class="pacing-value">${t("≤ {0}/day (Mon-Fri)", allowedPerWorkDay)}</span>
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Recommended hourly limit for work hours (9-5)")}">${t("Work hour average:")}</span>
							<span class="pacing-value">${t("≤ {0}/hour (9-5)", allowedPerHour)}</span>
						</div>

						<div class="pacing-separator" style="height: 1px; background-color: var(--vscode-panel-border); margin: 8px 0;"></div>
						<div style="font-size: 11px; font-weight: 600; margin-bottom: 6px; color: var(--vscode-foreground);">
							${t("Daily Capacity by Model Cost")}
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Model cost efficient")}">${t("Efficient:")}</span>
							<span class="pacing-value">${t("~{0}/day", budget033)}</span>
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Model cost standard")}">${t("Standard:")}</span>
							<span class="pacing-value">${t("~{0}/day", budget1)}</span>
						</div>
						<div class="pacing-row">
							<span class="pacing-label" title="${t("Model cost advanced")}">${t("Advanced:")}</span>
							<span class="pacing-value">${t("~{0}/day", budget3)}</span>
						</div>
						<div style="margin-top: 6px; font-size: 11px; text-align: right;">
							<a href="https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing" style="color: var(--vscode-textLink-foreground); text-decoration: none;" title="${t("Models and pricing table")}">${t("Official models and pricing")}</a>
						</div>
					</div>
				`;
          }
        }

        return `
				<div class="quota-card">
					<div class="quota-header">
						<div class="quota-title" title="${quotaTooltip}">${quotaName}</div>
						<div class="quota-badge">${progressLabel}</div>
					</div>
					${quotaDescription ? `<div class="quota-description">${quotaDescription}</div>` : ""}
					<div class="progress-bar">
						<div class="progress-fill" style="width: ${progressPercent}%; background: ${progressBarColor};"></div>
					</div>
					<div class="quota-status">
						${config.showMood
            ? `<span class="stat-label">${t("Mood:")}</span>
							   <span class="stat-value" title="${t(mood.text)}">${mood.emoji} ${t(mood.text)}</span>`
            : `<span class="stat-label" title="${t("Usage health based on remaining quota and time")}">${t("Status:")}</span>
							   <span class="stat-value" style="color: ${statusBadge.color};">${statusBadge.emoji} ${t(statusBadge.label)}</span>`
          }
					</div>
					<div class="quota-stats">
						<div class="stat">
							${isOverQuota
              ? `<span class="stat-label" title="${t("Amount over your monthly quota")}" style="color: var(--vscode-charts-red);">${t("Over by:")}</span>
							   <span class="stat-value" style="color: var(--vscode-charts-red);">${overageAmount}</span>`
              : `<span class="stat-label" title="${t("AI credits available until the reset date")}">${t("Remaining:")}</span>
							   <span class="stat-value">${formatQuotaValue(effectiveRemaining)}</span>`
            }
						</div>
						<div class="stat">
							<span class="stat-label" title="${t("AI credits used since the last reset")}">${t("Used:")}</span>
							<span class="stat-value">${formatQuotaValue(used)}</span>
						</div>
						<div class="stat">
							<span class="stat-label" title="${t("Total AI credits allowed in this period")}">${t("Total:")}</span>
							<span class="stat-value">${effectiveEntitlement}</span>
						</div>
					</div>
					${pacingHtml}
					${quota.overage_permitted
            ? `
						<div class="quota-overage">
							<span title="${t("Additional usage allowed beyond standard quota")}">${t("Overage permitted")}</span>
							${isOverQuota
              ? `<span class="overage-count" style="color: var(--vscode-charts-orange);" title="${t("Estimated cost: {0} credits beyond plan at ${1}/credit", Math.max(0, used - quota.entitlement), CREDIT_COST_USD)}">${t("${0} est.", (Math.max(0, used - quota.entitlement) * CREDIT_COST_USD).toFixed(2))}</span>`
              : (quota.overage_count > 0
                ? `<span class="overage-count">${t("{0} used", quota.overage_count)}</span>`
                : "")
            }
						</div>
					`
            : ""
          }
				</div>
			`;
      })
      .join("");
  }

  return `
		<div class="section">
			<h2 class="section-title">${t("Quotas")}</h2>
			${quotasHtml ||
    `<p style="color: var(--vscode-descriptionForeground);">${t("No quota data available")}</p>`
    }
		</div>
	`;
}

function renderTrendSection(snapshots: readonly LocalSnapshot[]): string {
  const trend = getTrendPrediction(snapshots);

  if (!trend) {
    return "";
  }

  const trendStyles = {
    accelerating: {
      color: 'var(--vscode-charts-red)',
      icon: '⚡',
      label: t('Accelerating'),
      message: t('Recent usage is higher than average')
    },
    slowing: {
      color: 'var(--vscode-charts-green)',
      icon: '🐢',
      label: t('Slowing Down'),
      message: t('Recent usage is lower than average')
    },
    stable: {
      color: 'var(--vscode-charts-blue)',
      icon: '📊',
      label: t('Stable'),
      message: t('Usage remains consistent')
    }
  };

  const trendInfo = trendStyles[trend.trend];

  const trendIndicatorText = trend.trend === "stable"
    ? t("No significant change")
    : trend.trend === "accelerating"
      ? t("+{0}% vs average", Math.round(Math.abs((trend.recentBurnRate - trend.overallBurnRate) / (trend.overallBurnRate || 1) * 100)))
      : t("-{0}% vs average", Math.round(Math.abs((trend.recentBurnRate - trend.overallBurnRate) / (trend.overallBurnRate || 1) * 100)));

  const recentCostPerDay = (trend.recentBurnRate * CREDIT_COST_USD).toFixed(2);
  const overallCostPerDay = (trend.overallBurnRate * CREDIT_COST_USD).toFixed(2);
  const projectedMonthlyCost = (trend.recentBurnRate * CREDIT_COST_USD * 30).toFixed(2);

  return `
		<div class="section">
			<h2 class="section-title">${t("Burn Rate Analysis")}</h2>
			<div class="quota-card">
				<div class="prediction-container">
					<div class="trend-indicator">
						<span class="trend-icon">${trendInfo.icon}</span>
						<span class="trend-label" style="color: ${trendInfo.color};">${trendInfo.label}</span>
					</div>
					<div class="trend-message">${trendInfo.message}</div>
					<div class="pacing-separator" style="height: 1px; background-color: var(--vscode-panel-border); margin: 8px 0;"></div>
					<div class="prediction-row">
						<span class="prediction-label">${t("Recent burn rate:")}</span>
						<span class="prediction-value">${t("{0} credits/day (~${1}/day)", trend.recentBurnRate, recentCostPerDay)}</span>
					</div>
					<div class="prediction-row">
						<span class="prediction-label">${t("Overall average:")}</span>
						<span class="prediction-value">${t("{0} credits/day (~${1}/day)", trend.overallBurnRate, overallCostPerDay)}</span>
					</div>
					<div class="prediction-row">
						<span class="prediction-label">${t("Projected monthly cost:")}</span>
						<span class="prediction-value">~$${projectedMonthlyCost}</span>
					</div>
					<div class="prediction-row">
						<span class="prediction-label">${t("Trend:")}</span>
						<span class="prediction-value">${trendIndicatorText}</span>
					</div>
					<div class="prediction-footer">
						${t("Based on {0} measurements from local history", trend.dataPoints)}
					</div>
				</div>
			</div>
		</div>
	`;
}

function renderWeightedPredictionSection(
  data: CopilotUserData,
  snapshots: readonly LocalSnapshot[],
  customLimit: number
): string {
  const prediction = getWeightedPrediction(snapshots, data, customLimit);

  if (!prediction) {
    return "";
  }

  // Confidence badge styling
  const confidenceStyles = {
    low: { color: 'var(--vscode-charts-red)', label: t('Low Accuracy') },
    medium: { color: 'var(--vscode-charts-yellow)', label: t('Medium Accuracy') },
    high: { color: 'var(--vscode-charts-green)', label: t('High Accuracy') }
  };
  const conf = confidenceStyles[prediction.confidence];

  // Rebuild the confidence reason locally so it can be localized
  const confidenceReason = prediction.confidence === "low"
    ? t("Limited data: only {0} data points available", prediction.dataPoints)
    : t("Based on {0} data points from local history", prediction.dataPoints);

  // Determine if current usage pattern is sustainable
  const sustainabilityMsg = prediction.willExhaustBeforeReset
    ? `<span style="color: var(--vscode-charts-red);">⚠️ ${t("May exhaust before reset")}</span>`
    : `<span style="color: var(--vscode-charts-green);">✓ ${t("On track for reset")}</span>`;

  // Exhaustion estimate
  let exhaustionHtml = '';
  if (prediction.daysUntilExhaustion !== null) {
    exhaustionHtml = `
			<div class="prediction-row">
				<span class="prediction-label">${t("Est. days until exhausted:")}</span>
				<span class="prediction-value">${t("{0} days", prediction.daysUntilExhaustion)}</span>
			</div>
		`;
  }

  return `
		<div class="section">
			<h2 class="section-title">${t("Weighted Prediction")}</h2>
			<div class="quota-card">
				<div class="prediction-container">
					<div class="prediction-header">
						<span class="prediction-title">${t("Predicted Daily Usage")}</span>
						<span class="confidence-badge" style="color: ${conf.color};" title="${confidenceReason}">${conf.label}</span>
					</div>
					<div class="prediction-main">
						<span class="prediction-number">${prediction.predictedDailyUsage}</span>
						<span class="prediction-unit">${t("credits/day")}</span>
					</div>
					<div class="pacing-separator" style="height: 1px; background-color: var(--vscode-panel-border); margin: 8px 0;"></div>
					<div class="prediction-row">
						<span class="prediction-label">${t("Est. daily cost:")}</span>
						<span class="prediction-value">~$${(prediction.predictedDailyUsage * CREDIT_COST_USD).toFixed(2)}/day</span>
					</div>
					<div class="prediction-row">
						<span class="prediction-label">${t("Projected monthly cost:")}</span>
						<span class="prediction-value">~$${(prediction.predictedDailyUsage * CREDIT_COST_USD * 30).toFixed(2)}</span>
					</div>
					${exhaustionHtml}
					<div class="prediction-row">
						<span class="prediction-label">${t("Sustainability:")}</span>
						<span class="prediction-value">${sustainabilityMsg}</span>
					</div>
					<div class="prediction-footer">
						${confidenceReason}
					</div>
				</div>
			</div>
		</div>
	`;
}

function renderHistorySection(
  data: CopilotUserData,
  snapshots: readonly LocalSnapshot[],
  config: RenderConfig
): string {
  if (snapshots.length < 2) {
    return "";
  }

  const comp = getSnapshotComparisons(snapshots);

  let lastRefreshRow = "";
  if (comp.sinceLastRefresh !== null) {
    const cls = comp.sinceLastRefresh < 0 ? "negative" : comp.sinceLastRefresh > 0 ? "positive" : "";
    const val = comp.sinceLastRefresh === 0 ? t("No change") : t("{0} credits", (comp.sinceLastRefresh > 0 ? "+" : "") + comp.sinceLastRefresh);
    lastRefreshRow = '<div class="snapshot-row"><span class="snapshot-label">' + t("Since last refresh:") + '</span><span class="snapshot-value ' + cls + '">' + val + '</span></div>';
  }

  let yesterdayRow = "";
  if (comp.sinceYesterday !== null) {
    const cls = comp.sinceYesterday < 0 ? "negative" : comp.sinceYesterday > 0 ? "positive" : "";
    const val = comp.sinceYesterday === 0 ? t("No change") : t("{0} credits", (comp.sinceYesterday > 0 ? "+" : "") + comp.sinceYesterday);
    yesterdayRow = '<div class="snapshot-row"><span class="snapshot-label">' + t("Since yesterday:") + '</span><span class="snapshot-value ' + cls + '">' + val + '</span></div>';
  }

  // "Used today" (since local midnight), with optional daily budget comparison.
  let todayRow = "";
  const usedToday = getUsedToday(snapshots);
  if (usedToday !== null) {
    if (config.dailyBudget > 0) {
      const overBudget = usedToday > config.dailyBudget;
      const cls = overBudget ? "negative" : "positive";
      const budgetText = overBudget
        ? t("{0} of {1} budget — over budget", usedToday, config.dailyBudget)
        : t("{0} of {1} budget", usedToday, config.dailyBudget);
      todayRow = '<div class="snapshot-row"><span class="snapshot-label">' + t("Used today:") + '</span><span class="snapshot-value ' + cls + '">' + budgetText + '</span></div>';
    } else {
      todayRow = '<div class="snapshot-row"><span class="snapshot-label">' + t("Used today:") + '</span><span class="snapshot-value">' + t("{0} credits", usedToday) + '</span></div>';
    }
  }

  // Prefer the sprint burn-down chart; fall back to the time-based chart when
  // we don't have a valid reset date to anchor the "sprint" window.
  const chartHtml = renderBurndownChart(data, snapshots) || renderSnapshotChart(snapshots);

  return '<div class="section">' +
    '<h2 class="section-title">' + t("Sprint Burn-down") + '</h2>' +
    '<div class="quota-card">' +
    '<div class="snapshot-history">' +
    lastRefreshRow + yesterdayRow + todayRow +
    chartHtml +
    '</div></div></div>';
}

function renderSnapshotChart(snapshots: readonly LocalSnapshot[]): string {
  if (snapshots.length < 2) {
    return "";
  }

  // Filter out snapshots with invalid entitlement (keep negative remaining for overage tracking)
  const validSnapshots = snapshots.filter(s => s.premium_entitlement > 0);
  if (validSnapshots.length < 2) {
    return "";
  }

  const ordered = [...validSnapshots].reverse();
  const count = ordered.length;

  const width = 280;
  const height = 100;
  const pad = { top: 10, right: 10, bottom: 25, left: 40 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;

  const vals = ordered.map(s => s.premium_remaining);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const range = maxV - minV || 1;

  const yMin = minV - range * 0.1;
  const yMax = maxV + range * 0.1;
  const yRange = yMax - yMin || 1;

  const pts = ordered.map((s, i) => {
    const x = pad.left + (i / (count - 1)) * cw;
    const y = pad.top + ch - ((s.premium_remaining - yMin) / yRange) * ch;
    return { x, y, v: s.premium_remaining, t: s.timestamp };
  });

  let linePath = "";
  pts.forEach((p, i) => {
    linePath += (i === 0 ? "M" : "L") + " " + p.x.toFixed(1) + " " + p.y.toFixed(1) + " ";
  });

  const lastPt = pts[pts.length - 1];
  const areaPath = linePath + "L " + lastPt.x.toFixed(1) + " " + (height - pad.bottom) + " L " + pad.left + " " + (height - pad.bottom) + " Z";

  const yLabels = [
    { val: Math.round(yMax), y: pad.top },
    { val: Math.round((yMax + yMin) / 2), y: pad.top + ch / 2 },
    { val: Math.round(yMin), y: pad.top + ch }
  ];

  const formatTime = (ts: string, isOldest: boolean): string => {
    const d = new Date(ts);
    const now = new Date();
    const mins = (now.getTime() - d.getTime()) / (1000 * 60);
    const hrs = mins / 60;
    // For the oldest point, always show relative time even if recent
    if (isOldest) {
      if (mins < 1) { return "<1m ago"; }
      if (mins < 60) { return Math.floor(mins) + "m ago"; }
      if (hrs < 24) { return Math.floor(hrs) + "h ago"; }
      return Math.floor(hrs / 24) + "d ago";
    }
    // For the newest point, show "now"
    return "now";
  };

  let gridLines = "";
  let yLabelsSvg = "";
  yLabels.forEach(l => {
    gridLines += '<line x1="' + pad.left + '" y1="' + l.y + '" x2="' + (width - pad.right) + '" y2="' + l.y + '" stroke="var(--vscode-panel-border)" stroke-dasharray="2,2" opacity="0.5"/>';
    yLabelsSvg += '<text x="' + (pad.left - 5) + '" y="' + (l.y + 3) + '" text-anchor="end" fill="var(--vscode-descriptionForeground)" font-size="9">' + l.val + '</text>';
  });

  let circles = "";
  pts.forEach(p => {
    circles += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="3" fill="var(--vscode-charts-blue)" class="chart-point"/>';
  });

  return '<div class="snapshot-chart">' +
    '<div class="chart-title">' + t("AI Credits Over Time") + '</div>' +
    '<svg width="' + width + '" height="' + height + '" class="history-chart">' +
    '<defs><linearGradient id="areaGrad" x1="0%" y1="0%" x2="0%" y2="100%">' +
    '<stop offset="0%" style="stop-color:var(--vscode-charts-blue);stop-opacity:0.3"/>' +
    '<stop offset="100%" style="stop-color:var(--vscode-charts-blue);stop-opacity:0.05"/>' +
    '</linearGradient></defs>' +
    gridLines + yLabelsSvg +
    '<path d="' + areaPath + '" fill="url(#areaGrad)"/>' +
    '<path d="' + linePath + '" fill="none" stroke="var(--vscode-charts-blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    circles +
    '<text x="' + pad.left + '" y="' + (height - 5) + '" text-anchor="start" fill="var(--vscode-descriptionForeground)" font-size="9">' + formatTime(ordered[0].timestamp, true) + '</text>' +
    '<text x="' + (width - pad.right) + '" y="' + (height - 5) + '" text-anchor="end" fill="var(--vscode-descriptionForeground)" font-size="9">now</text>' +
    '</svg>' +
    '<div class="chart-footnote">' + t("{0} snapshots · Based on local refreshes", count) + '</div>' +
    '</div>';
}

/**
 * Renders a sprint-style burn-down chart for the current billing period.
 *
 * The billing window acts as the "sprint": it starts roughly one calendar
 * month before the quota reset date and ends on the reset date. The ideal
 * line burns the full AI credit entitlement down to zero over that window,
 * and the actual line plots recorded snapshots against it so users can see
 * at a glance whether they are pacing ahead of or behind budget.
 *
 * Returns an empty string when the data needed to anchor the sprint window
 * (a valid reset date and a positive entitlement) is unavailable, so the
 * caller can fall back to the time-based chart.
 */
function renderBurndownChart(data: CopilotUserData, snapshots: readonly LocalSnapshot[]): string {
  if (snapshots.length < 2) {
    return "";
  }

  // The most recent snapshot defines the current sprint's total budget.
  const validSnapshots = snapshots.filter(s => s.premium_entitlement > 0);
  if (validSnapshots.length < 2) {
    return "";
  }

  const entitlement = validSnapshots[0].premium_entitlement;
  if (!(entitlement > 0)) {
    return "";
  }

  // Anchor the sprint window to the reset date. Without it we can't draw an
  // ideal burn line, so the caller falls back to the time-based chart.
  const resetTime = new Date(data.quota_reset_date_utc).getTime();
  if (!Number.isFinite(resetTime)) {
    return "";
  }

  // Sprint start = one calendar month before the reset date.
  const startDate = new Date(resetTime);
  startDate.setMonth(startDate.getMonth() - 1);
  const startTime = startDate.getTime();
  const periodMs = resetTime - startTime;
  if (!(periodMs > 0)) {
    return "";
  }

  const now = Date.now();
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  // Keep only snapshots that fall inside the current sprint window, oldest first.
  const realInWindow = validSnapshots
    .filter(s => {
      const t = new Date(s.timestamp).getTime();
      return Number.isFinite(t) && t >= startTime && t <= resetTime;
    })
    .map(s => ({ t: new Date(s.timestamp).getTime(), remaining: s.premium_remaining }))
    .sort((a, b) => a.t - b.t);

  // Seed a default data point on day 0 of the sprint (full entitlement) so the
  // burn-down always starts from the top-left corner, even before the first
  // refresh of the new billing period is recorded.
  const inWindow = [...realInWindow];
  if (inWindow.length === 0 || inWindow[0].t > startTime) {
    inWindow.unshift({ t: startTime, remaining: entitlement });
  }

  if (inWindow.length < 2) {
    return "";
  }

  const width = 280;
  const height = 120;
  const pad = { top: 12, right: 12, bottom: 28, left: 40 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;

  const xAt = (t: number) => pad.left + (clamp(t, startTime, resetTime) - startTime) / periodMs * cw;
  const yAt = (remaining: number) => pad.top + ch - clamp(remaining, 0, entitlement) / entitlement * ch;

  // Ideal burn line: full entitlement at sprint start -> 0 at reset.
  const idealStart = { x: pad.left, y: yAt(entitlement) };
  const idealEnd = { x: pad.left + cw, y: yAt(0) };

  // Actual burn line from recorded snapshots.
  const pts = inWindow.map(s => ({ x: xAt(s.t), y: yAt(s.remaining) }));
  let actualPath = "";
  pts.forEach((p, i) => {
    actualPath += (i === 0 ? "M" : "L") + " " + p.x.toFixed(1) + " " + p.y.toFixed(1) + " ";
  });
  const lastPt = pts[pts.length - 1];
  const areaPath = actualPath + "L " + lastPt.x.toFixed(1) + " " + (height - pad.bottom) + " L " + pts[0].x.toFixed(1) + " " + (height - pad.bottom) + " Z";

  // Grid + y-axis labels (0, half, full entitlement).
  const yLabels = [
    { val: Math.round(entitlement), y: pad.top },
    { val: Math.round(entitlement / 2), y: pad.top + ch / 2 },
    { val: 0, y: pad.top + ch }
  ];
  let gridLines = "";
  let yLabelsSvg = "";
  yLabels.forEach(l => {
    gridLines += '<line x1="' + pad.left + '" y1="' + l.y + '" x2="' + (width - pad.right) + '" y2="' + l.y + '" stroke="var(--vscode-panel-border)" stroke-dasharray="2,2" opacity="0.5"/>';
    yLabelsSvg += '<text x="' + (pad.left - 5) + '" y="' + (l.y + 3) + '" text-anchor="end" fill="var(--vscode-descriptionForeground)" font-size="9">' + l.val + '</text>';
  });

  // "Today" marker (only when we're inside the sprint window).
  let todayMarker = "";
  if (now >= startTime && now <= resetTime) {
    const tx = xAt(now).toFixed(1);
    todayMarker =
      '<line x1="' + tx + '" y1="' + pad.top + '" x2="' + tx + '" y2="' + (pad.top + ch) + '" stroke="var(--vscode-charts-orange)" stroke-width="1" stroke-dasharray="3,2" opacity="0.7"/>' +
      '<text x="' + tx + '" y="' + (pad.top - 3) + '" text-anchor="middle" fill="var(--vscode-charts-orange)" font-size="8">today</text>';
  }

  let circles = "";
  pts.forEach(p => {
    circles += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="2.5" fill="var(--vscode-charts-blue)" class="chart-point"/>';
  });

  // Trend line: project the observed burn rate forward to the reset date (or
  // to the point where credits would hit zero, whichever comes first).
  let trendLine = "";
  let trendLegend = "";
  let trendFootnote = "";
  const rateSource = realInWindow.length >= 2 ? realInWindow : inWindow;
  const firstTrend = rateSource[0];
  const lastTrend = rateSource[rateSource.length - 1];
  const trendMs = lastTrend.t - firstTrend.t;
  if (trendMs > 0 && lastTrend.remaining < firstTrend.remaining) {
    const ratePerMs = (firstTrend.remaining - lastTrend.remaining) / trendMs;
    const msToZero = lastTrend.remaining / ratePerMs;
    const zeroTime = lastTrend.t + msToZero;

    let endTime: number;
    let endRemaining: number;
    if (zeroTime < resetTime) {
      endTime = zeroTime;
      endRemaining = 0;
    } else {
      endTime = resetTime;
      endRemaining = lastTrend.remaining - ratePerMs * (resetTime - lastTrend.t);
    }

    const tx1 = xAt(lastTrend.t).toFixed(1);
    const ty1 = yAt(lastTrend.remaining).toFixed(1);
    const tx2 = xAt(endTime).toFixed(1);
    const ty2 = yAt(endRemaining).toFixed(1);
    trendLine = '<line x1="' + tx1 + '" y1="' + ty1 + '" x2="' + tx2 + '" y2="' + ty2 + '" stroke="var(--vscode-charts-purple)" stroke-width="2.5" stroke-linecap="round" opacity="1"/>';
    trendLegend = '<span class="legend-item"><span class="legend-swatch legend-trend"></span>' + t("Trend") + '</span>';

    if (zeroTime < resetTime) {
      const d = new Date(zeroTime);
      trendFootnote = ' · ' + t("projected to run out {0}", (d.getMonth() + 1) + '/' + d.getDate());
    }
  }

  // On-track status: compare actual remaining now vs the ideal line at "now".
  const fractionElapsed = clamp((now - startTime) / periodMs, 0, 1);
  const idealRemainingNow = entitlement * (1 - fractionElapsed);
  const actualRemainingNow = validSnapshots[0].premium_remaining;
  const delta = actualRemainingNow - idealRemainingNow;
  let statusText: string;
  let statusColor: string;
  if (now >= resetTime) {
    statusText = t("Sprint complete · awaiting reset");
    statusColor = "var(--vscode-descriptionForeground)";
  } else if (delta >= entitlement * 0.05) {
    statusText = t("On track · {0} credits ahead of pace", Math.round(delta));
    statusColor = "var(--vscode-charts-green)";
  } else if (delta <= -entitlement * 0.05) {
    statusText = t("Behind pace · {0} credits over budget", Math.round(Math.abs(delta)));
    statusColor = "var(--vscode-charts-red)";
  } else {
    statusText = t("On pace with the ideal burn-down");
    statusColor = "var(--vscode-descriptionForeground)";
  }

  const fmtDate = (t: number) => {
    const d = new Date(t);
    return (d.getMonth() + 1) + "/" + d.getDate();
  };

  return '<div class="snapshot-chart">' +
    '<div class="chart-title">' + t("AI Credits Burn-down") + '</div>' +
    '<svg width="' + width + '" height="' + height + '" class="history-chart">' +
    '<defs><linearGradient id="burnAreaGrad" x1="0%" y1="0%" x2="0%" y2="100%">' +
    '<stop offset="0%" style="stop-color:var(--vscode-charts-blue);stop-opacity:0.3"/>' +
    '<stop offset="100%" style="stop-color:var(--vscode-charts-blue);stop-opacity:0.05"/>' +
    '</linearGradient></defs>' +
    gridLines + yLabelsSvg +
    // Ideal burn line (subtle dashed reference).
    '<line x1="' + idealStart.x.toFixed(1) + '" y1="' + idealStart.y.toFixed(1) + '" x2="' + idealEnd.x.toFixed(1) + '" y2="' + idealEnd.y.toFixed(1) + '" stroke="var(--vscode-descriptionForeground)" stroke-width="1" stroke-dasharray="5,4" opacity="0.5"/>' +
    todayMarker +
    '<path d="' + areaPath + '" fill="url(#burnAreaGrad)"/>' +
    '<path d="' + actualPath + '" fill="none" stroke="var(--vscode-charts-blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    trendLine +
    circles +
    '<text x="' + pad.left + '" y="' + (height - 5) + '" text-anchor="start" fill="var(--vscode-descriptionForeground)" font-size="9">' + fmtDate(startTime) + '</text>' +
    '<text x="' + (width - pad.right) + '" y="' + (height - 5) + '" text-anchor="end" fill="var(--vscode-descriptionForeground)" font-size="9">' + fmtDate(resetTime) + ' (reset)</text>' +
    '</svg>' +
    '<div class="burndown-legend">' +
    '<span class="legend-item"><span class="legend-swatch legend-actual"></span>' + t("Actual") + '</span>' +
    '<span class="legend-item"><span class="legend-swatch legend-ideal"></span>' + t("Ideal") + '</span>' +
    trendLegend +
    '</div>' +
    '<div class="chart-footnote" style="color:' + statusColor + ';">' + statusText + trendFootnote + '</div>' +
    '</div>';
}
