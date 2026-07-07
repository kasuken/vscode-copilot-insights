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
  findPremiumQuota,
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

/** A single plotted series or doughnut segment, described as raw data (no colors). */
export interface ChartSeries {
  /** Semantic role; the webview maps this to theme colors and line styles. */
  role: "actual" | "ideal" | "trend" | "today" | "daily" | "used" | "remaining" | "overage" | "forecastOptimistic" | "forecastExpected" | "forecastPessimistic" | "burnOverall" | "burnRecent" | "burnTarget";
  /** Chart.js dataset type for this series. Defaults to the chart model type. */
  type?: "line" | "bar" | "doughnut";
  /** Human-readable label used in tooltips. */
  label: string;
  /** Data points in value space (x = epoch ms, y = credits). */
  points: { x: number; y: number }[];
  /** Whether to fill the area beneath the line down to the axis baseline. */
  fill: boolean;
  /** Whether the line is dashed. */
  dashed: boolean;
  /** Whether to draw point markers. */
  showPoints: boolean;
  /** Whether this series participates in hover tooltips. */
  tooltip: boolean;
}

/** An explicit axis tick: a value in data space and the label to show for it. */
export interface ChartAxisTick {
  value: number;
  label: string;
}

/**
 * Serializable description of the history chart. The extension computes the
 * data (points, ranges, ticks) while the webview resolves theme colors and
 * draws it with Chart.js, so canvas colors track the active VS Code theme.
 */
export interface ChartModel {
  id: string;
  kind: "burndown" | "snapshot" | "dailyUsage" | "remainingUsed" | "forecastRange" | "burnRateCombo";
  type: "line" | "bar" | "doughnut";
  series: ChartSeries[];
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  xTicks: ChartAxisTick[];
  yTicks: number[];
  /** Localized unit label for tooltips (e.g. "credits"). */
  unit: string;
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
  /** Data for the history chart, drawn on a canvas by the webview. */
  charts: ChartModel[];
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
	<script nonce="${nonce}" src="${mediaUri("chart.umd.min.js")}"></script>
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

  const history = renderHistorySection(data, snapshots, config);
  const weighted = renderWeightedPredictionSection(data, snapshots, config.customLimit);
  const trend = renderTrendSection(data, snapshots, config.customLimit);

  return {
    state: "data",
    sections: {
      stale: isStale
        ? `<div class="warning-banner">⚠️ ${t("Data may be stale (fetched over 1 hour ago)")}</div>`
        : "",
      quotas: renderQuotasSection(data, asOfTime, config),
      history: history.html,
      weighted: weighted.html,
      trend: trend.html,
      summary: renderSummarySection(data),
      orgs: renderOrgsSection(data),
      access: renderAccessSection(data),
    },
    charts: [...history.charts, ...weighted.charts, ...trend.charts],
    lastFetched: t("Last fetched: {0}", timeSince),
  };
}

function renderSummarySection(data: CopilotUserData): string {
  const orgCount = data.organization_list?.length || 0;
  const enabledText = (value: boolean) => (value ? t("Enabled") : t("Disabled"));
  const statusClass = (value: boolean) => (value ? "is-enabled" : "is-disabled");

  return `
		<div class="section">
			<h2 class="section-title">${t("Plan Details")}</h2>
      <div class="plan-summary">
        <div class="summary-card summary-card-primary">
					<div class="card-label" title="${t("Your GitHub Copilot subscription plan")}">${t("Plan")}</div>
					<div class="card-value">${escapeHtml(data.copilot_plan) || t("Unknown")}</div>
          <div class="card-meta">${t("Copilot access for this account")}</div>
				</div>
        <div class="summary-access-grid" aria-label="${t("Copilot feature access")}">
          <div class="access-pill ${statusClass(data.chat_enabled)}" title="${t("Access to Copilot Chat features")}">
            <span class="access-name">${t("Chat")}</span>
            <span class="access-state">${enabledText(data.chat_enabled)}</span>
          </div>
          <div class="access-pill ${statusClass(data.cli_enabled)}" title="${t("Access to Copilot CLI features")}">
            <span class="access-name">${t("CLI")}</span>
            <span class="access-state">${enabledText(data.cli_enabled)}</span>
          </div>
          <div class="access-pill ${statusClass(data.is_mcp_enabled)}" title="${t("Model Context Protocol support")}">
            <span class="access-name">${t("MCP")}</span>
            <span class="access-state">${enabledText(data.is_mcp_enabled)}</span>
          </div>
          <div class="access-pill ${statusClass(data.editor_preview_features_enabled)}" title="${t("Editor preview features access")}">
            <span class="access-name">${t("Preview")}</span>
            <span class="access-state">${enabledText(data.editor_preview_features_enabled)}</span>
          </div>
        </div>
        <div class="summary-card summary-card-compact">
					<div class="card-label" title="${t("Organizations providing your Copilot seat")}">${t("Orgs")}</div>
          <div class="card-value">${orgCount}</div>
          <div class="card-meta">${orgCount === 1 ? t("organization") : t("organizations")}</div>
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

function renderTrendSection(
  data: CopilotUserData,
  snapshots: readonly LocalSnapshot[],
  customLimit: number
): { html: string; charts: ChartModel[] } {
  const trend = getTrendPrediction(snapshots);

  if (!trend) {
    return { html: "", charts: [] };
  }

  const burnRateChart = buildBurnRateComboChartModel(data, trend, customLimit);
  const burnRateChartHtml = burnRateChart
    ? '<div class="snapshot-chart">' +
    '<div class="chart-title">' + burnRateChart.title + '</div>' +
    '<div class="chart-canvas-wrap chart-canvas-wrap-compact"><canvas id="' + burnRateChart.model.id + '"></canvas></div>' +
    burnRateChart.legendHtml +
    burnRateChart.footnoteHtml +
    '</div>'
    : "";

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

  const html = `
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
					${burnRateChartHtml}
				</div>
			</div>
		</div>
	`;

  return { html, charts: burnRateChart ? [burnRateChart.model] : [] };
}

function buildBurnRateComboChartModel(
  data: CopilotUserData,
  trend: { recentBurnRate: number; overallBurnRate: number },
  customLimit: number
): ChartResult | null {
  const premiumQuota = findPremiumQuota(data.quota_snapshots);
  if (!premiumQuota || premiumQuota.unlimited) {
    return null;
  }

  const resetTime = new Date(data.quota_reset_date_utc).getTime();
  const now = Date.now();
  if (!Number.isFinite(resetTime) || resetTime <= now) {
    return null;
  }

  const effectiveQuota = getEffectiveQuota(premiumQuota, customLimit);
  const daysUntilReset = (resetTime - now) / (1000 * 60 * 60 * 24);
  if (!(daysUntilReset > 0)) {
    return null;
  }

  const targetBurnRate = Math.max(0, effectiveQuota.remaining) / daysUntilReset;
  const yMax = Math.max(trend.overallBurnRate, trend.recentBurnRate, targetBurnRate, 1) * 1.2;

  const model: ChartModel = {
    id: "burnRateComboChart",
    kind: "burnRateCombo",
    type: "bar",
    series: [
      {
        role: "burnOverall",
        type: "bar",
        label: t("Overall average"),
        points: [{ x: 0, y: trend.overallBurnRate }],
        fill: false,
        dashed: false,
        showPoints: false,
        tooltip: true,
      },
      {
        role: "burnRecent",
        type: "bar",
        label: t("Recent burn rate"),
        points: [{ x: 1, y: trend.recentBurnRate }],
        fill: false,
        dashed: false,
        showPoints: false,
        tooltip: true,
      },
      {
        role: "burnTarget",
        type: "line",
        label: t("Target pace"),
        points: [
          { x: -0.35, y: targetBurnRate },
          { x: 1.35, y: targetBurnRate },
        ],
        fill: false,
        dashed: true,
        showPoints: false,
        tooltip: true,
      },
    ],
    xMin: -0.5,
    xMax: 1.5,
    yMin: 0,
    yMax,
    xTicks: [
      { value: 0, label: t("Overall") },
      { value: 1, label: t("Recent") },
    ],
    yTicks: [0, yMax / 2, yMax],
    unit: t("credits/day"),
  };

  const legendHtml =
    '<div class="burndown-legend">' +
    '<span class="legend-item"><span class="legend-dot legend-burn-overall"></span>' + t("Overall") + '</span>' +
    '<span class="legend-item"><span class="legend-dot legend-burn-recent"></span>' + t("Recent") + '</span>' +
    '<span class="legend-item"><span class="legend-swatch legend-burn-target"></span>' + t("Target pace") + '</span>' +
    '</div>';
  const footnoteHtml = '<div class="chart-footnote">' + t("Target pace: {0} credits/day to last until reset", formatQuotaValue(targetBurnRate)) + '</div>';

  return {
    model,
    title: t("Burn Rate vs Target Pace"),
    legendHtml,
    footnoteHtml,
  };
}

function renderWeightedPredictionSection(
  data: CopilotUserData,
  snapshots: readonly LocalSnapshot[],
  customLimit: number
): { html: string; charts: ChartModel[] } {
  const prediction = getWeightedPrediction(snapshots, data, customLimit);

  if (!prediction) {
    return { html: "", charts: [] };
  }

  const forecastChart = buildForecastRangeChartModel(data, prediction.predictedDailyUsage, prediction.confidence, customLimit);
  const forecastHtml = forecastChart
    ? '<div class="snapshot-chart">' +
    '<div class="chart-title">' + forecastChart.title + '</div>' +
    '<div class="chart-canvas-wrap chart-canvas-wrap-compact"><canvas id="' + forecastChart.model.id + '"></canvas></div>' +
    forecastChart.legendHtml +
    forecastChart.footnoteHtml +
    '</div>'
    : "";

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

  const html = `
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
					${forecastHtml}
				</div>
			</div>
		</div>
	`;

  return { html, charts: forecastChart ? [forecastChart.model] : [] };
}

function buildForecastRangeChartModel(
  data: CopilotUserData,
  predictedDailyUsage: number,
  confidence: "low" | "medium" | "high",
  customLimit: number
): ChartResult | null {
  if (!(predictedDailyUsage > 0)) {
    return null;
  }

  const premiumQuota = findPremiumQuota(data.quota_snapshots);
  if (!premiumQuota || premiumQuota.unlimited) {
    return null;
  }

  const resetTime = new Date(data.quota_reset_date_utc).getTime();
  const now = Date.now();
  if (!Number.isFinite(resetTime) || resetTime <= now) {
    return null;
  }

  const effectiveQuota = getEffectiveQuota(premiumQuota, customLimit);
  if (!(effectiveQuota.entitlement > 0)) {
    return null;
  }

  const currentRemaining = Math.max(0, effectiveQuota.remaining);
  const daysUntilReset = (resetTime - now) / (1000 * 60 * 60 * 24);
  const uncertainty = confidence === "high" ? 0.15 : confidence === "medium" ? 0.3 : 0.5;
  const optimisticRate = predictedDailyUsage * (1 - uncertainty);
  const pessimisticRate = predictedDailyUsage * (1 + uncertainty);

  const projectedPoints = (dailyRate: number) => {
    const remainingAtReset = Math.max(0, currentRemaining - dailyRate * daysUntilReset);
    if (dailyRate > 0 && remainingAtReset === 0 && currentRemaining > 0) {
      const zeroTime = now + currentRemaining / dailyRate * 24 * 60 * 60 * 1000;
      if (zeroTime < resetTime) {
        return [
          { x: now, y: currentRemaining },
          { x: zeroTime, y: 0 },
          { x: resetTime, y: 0 },
        ];
      }
    }
    return [
      { x: now, y: currentRemaining },
      { x: resetTime, y: remainingAtReset },
    ];
  };

  const fmtDate = (ms: number) => {
    const d = new Date(ms);
    return (d.getMonth() + 1) + "/" + d.getDate();
  };
  const formatRate = (rate: number) => formatQuotaValue(rate);

  const model: ChartModel = {
    id: "forecastRangeChart",
    kind: "forecastRange",
    type: "line",
    series: [
      {
        role: "forecastOptimistic",
        label: t("Optimistic ({0}/day)", formatRate(optimisticRate)),
        points: projectedPoints(optimisticRate),
        fill: false,
        dashed: true,
        showPoints: false,
        tooltip: true,
      },
      {
        role: "forecastExpected",
        label: t("Expected ({0}/day)", formatRate(predictedDailyUsage)),
        points: projectedPoints(predictedDailyUsage),
        fill: false,
        dashed: false,
        showPoints: false,
        tooltip: true,
      },
      {
        role: "forecastPessimistic",
        label: t("Pessimistic ({0}/day)", formatRate(pessimisticRate)),
        points: projectedPoints(pessimisticRate),
        fill: false,
        dashed: true,
        showPoints: false,
        tooltip: true,
      },
    ],
    xMin: now,
    xMax: resetTime,
    yMin: 0,
    yMax: Math.max(effectiveQuota.entitlement, currentRemaining, 1),
    xTicks: [
      { value: now, label: t("Today") },
      { value: resetTime, label: fmtDate(resetTime) + ' (' + t("reset") + ')' },
    ],
    yTicks: [0, Math.max(effectiveQuota.entitlement, currentRemaining, 1) / 2, Math.max(effectiveQuota.entitlement, currentRemaining, 1)],
    unit: t("credits"),
  };

  const legendHtml =
    '<div class="burndown-legend">' +
    '<span class="legend-item"><span class="legend-swatch legend-forecast-optimistic"></span>' + t("Optimistic") + '</span>' +
    '<span class="legend-item"><span class="legend-swatch legend-forecast-expected"></span>' + t("Expected") + '</span>' +
    '<span class="legend-item"><span class="legend-swatch legend-forecast-pessimistic"></span>' + t("Pessimistic") + '</span>' +
    '</div>';
  const footnoteHtml = '<div class="chart-footnote">' + t("Forecast range through reset, based on {0} confidence", t(confidence)) + '</div>';

  return {
    model,
    title: t("Forecast Range"),
    legendHtml,
    footnoteHtml,
  };
}

function renderHistorySection(
  data: CopilotUserData,
  snapshots: readonly LocalSnapshot[],
  config: RenderConfig
): { html: string; charts: ChartModel[] } {
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
  const remainingUsedChart = buildRemainingUsedChartModel(data, config);
  const chartResult = buildBurndownChartModel(data, snapshots) ?? buildSnapshotChartModel(snapshots);
  const dailyUsageChart = buildDailyUsageChartModel(data, snapshots, config);

  let chartHtml = "";
  const charts: ChartModel[] = [];
  if (remainingUsedChart) {
    charts.push(remainingUsedChart.model);
    chartHtml =
      '<div class="snapshot-chart">' +
      '<div class="chart-title">' + remainingUsedChart.title + '</div>' +
      '<div class="chart-canvas-wrap chart-canvas-wrap-doughnut"><canvas id="' + remainingUsedChart.model.id + '"></canvas></div>' +
      remainingUsedChart.legendHtml +
      remainingUsedChart.footnoteHtml +
      '</div>';
  }
  if (chartResult) {
    charts.push(chartResult.model);
    chartHtml +=
      '<div class="snapshot-chart">' +
      '<div class="chart-title">' + chartResult.title + '</div>' +
      '<div class="chart-canvas-wrap"><canvas id="' + chartResult.model.id + '"></canvas></div>' +
      chartResult.legendHtml +
      chartResult.footnoteHtml +
      '</div>';
  }
  if (dailyUsageChart) {
    charts.push(dailyUsageChart.model);
    chartHtml +=
      '<div class="snapshot-chart">' +
      '<div class="chart-title">' + dailyUsageChart.title + '</div>' +
      '<div class="chart-canvas-wrap chart-canvas-wrap-compact"><canvas id="' + dailyUsageChart.model.id + '"></canvas></div>' +
      dailyUsageChart.legendHtml +
      dailyUsageChart.footnoteHtml +
      '</div>';
  }

  const html = '<div class="section">' +
    '<h2 class="section-title">' + t("Sprint Burn-down") + '</h2>' +
    '<div class="quota-card">' +
    '<div class="snapshot-history">' +
    lastRefreshRow + yesterdayRow + todayRow +
    chartHtml +
    '</div></div></div>';

  return { html, charts };
}

/** A built chart: the data model for the webview plus prebuilt section HTML. */
interface ChartResult {
  model: ChartModel;
  title: string;
  legendHtml: string;
  footnoteHtml: string;
}

function buildRemainingUsedChartModel(data: CopilotUserData, config: RenderConfig): ChartResult | null {
  const premiumQuota = data.quota_snapshots
    ? Object.values(data.quota_snapshots).find(q => q.quota_id === "premium_interactions")
    : undefined;
  if (!premiumQuota || premiumQuota.unlimited) {
    return null;
  }

  const effectiveQuota = getEffectiveQuota(premiumQuota, config.customLimit);
  const { used, isOverQuota, overageAmount } = computeQuotaStats(effectiveQuota);
  if (!(effectiveQuota.entitlement > 0)) {
    return null;
  }

  const inQuotaUsed = Math.min(Math.max(used, 0), effectiveQuota.entitlement);
  const remaining = Math.max(effectiveQuota.remaining, 0);
  const series: ChartSeries[] = [
    {
      role: "used",
      type: "doughnut",
      label: t("Used"),
      points: [{ x: 0, y: inQuotaUsed }],
      fill: false,
      dashed: false,
      showPoints: false,
      tooltip: true,
    },
    {
      role: "remaining",
      type: "doughnut",
      label: t("Remaining"),
      points: [{ x: 1, y: remaining }],
      fill: false,
      dashed: false,
      showPoints: false,
      tooltip: true,
    },
  ];

  if (isOverQuota && overageAmount > 0) {
    series.push({
      role: "overage",
      type: "doughnut",
      label: t("Overage"),
      points: [{ x: 2, y: overageAmount }],
      fill: false,
      dashed: false,
      showPoints: false,
      tooltip: true,
    });
  }

  const model: ChartModel = {
    id: "remainingUsedChart",
    kind: "remainingUsed",
    type: "doughnut",
    series,
    xMin: 0,
    xMax: 0,
    yMin: 0,
    yMax: effectiveQuota.entitlement,
    xTicks: [],
    yTicks: [],
    unit: t("credits"),
  };

  const legendHtml =
    '<div class="burndown-legend">' +
    '<span class="legend-item"><span class="legend-dot legend-used"></span>' + t("Used") + '</span>' +
    '<span class="legend-item"><span class="legend-dot legend-remaining"></span>' + t("Remaining") + '</span>' +
    (isOverQuota ? '<span class="legend-item"><span class="legend-dot legend-overage"></span>' + t("Overage") + '</span>' : '') +
    '</div>';
  const footnoteHtml = '<div class="chart-footnote">' + t("{0} of {1} credits used", formatQuotaValue(used), formatQuotaValue(effectiveQuota.entitlement)) + '</div>';

  return {
    model,
    title: t("Remaining vs Used"),
    legendHtml,
    footnoteHtml,
  };
}

function buildSnapshotChartModel(snapshots: readonly LocalSnapshot[]): ChartResult | null {
  if (snapshots.length < 2) {
    return null;
  }

  // Filter out snapshots with invalid entitlement (keep negative remaining for overage tracking)
  const validSnapshots = snapshots.filter(s => s.premium_entitlement > 0);
  if (validSnapshots.length < 2) {
    return null;
  }

  const ordered = [...validSnapshots].reverse();
  const count = ordered.length;

  const vals = ordered.map(s => s.premium_remaining);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const range = maxV - minV || 1;
  const yMin = minV - range * 0.1;
  const yMax = maxV + range * 0.1;

  const points = ordered.map(s => ({ x: new Date(s.timestamp).getTime(), y: s.premium_remaining }));
  const xMin = points[0].x;
  const xMax = points[points.length - 1].x;

  const formatOldest = (ts: string): string => {
    const d = new Date(ts);
    const mins = (Date.now() - d.getTime()) / (1000 * 60);
    const hrs = mins / 60;
    if (mins < 1) { return "<1m ago"; }
    if (mins < 60) { return Math.floor(mins) + "m ago"; }
    if (hrs < 24) { return Math.floor(hrs) + "h ago"; }
    return Math.floor(hrs / 24) + "d ago";
  };

  const model: ChartModel = {
    id: "insightsChart",
    kind: "snapshot",
    type: "line",
    series: [
      {
        role: "actual",
        label: t("AI Credits"),
        points,
        fill: true,
        dashed: false,
        showPoints: true,
        tooltip: true,
      },
    ],
    xMin,
    xMax,
    yMin,
    yMax,
    xTicks: [
      { value: xMin, label: formatOldest(ordered[0].timestamp) },
      { value: xMax, label: "now" },
    ],
    yTicks: [yMin, (yMin + yMax) / 2, yMax],
    unit: t("credits"),
  };

  return {
    model,
    title: t("AI Credits Over Time"),
    legendHtml: "",
    footnoteHtml: '<div class="chart-footnote">' + t("{0} snapshots · Based on local refreshes", count) + '</div>',
  };
}

/**
 * Builds the sprint-style burn-down chart model for the current billing period.
 *
 * The billing window acts as the "sprint": it starts roughly one calendar
 * month before the quota reset date and ends on the reset date. The ideal
 * line burns the full AI credit entitlement down to zero over that window,
 * and the actual line plots recorded snapshots against it so users can see
 * at a glance whether they are pacing ahead of or behind budget.
 *
 * Returns null when the data needed to anchor the sprint window (a valid
 * reset date and a positive entitlement) is unavailable, so the caller can
 * fall back to the time-based chart.
 */
function buildBurndownChartModel(data: CopilotUserData, snapshots: readonly LocalSnapshot[]): ChartResult | null {
  if (snapshots.length < 2) {
    return null;
  }

  // The most recent snapshot defines the current sprint's total budget.
  const validSnapshots = snapshots.filter(s => s.premium_entitlement > 0);
  if (validSnapshots.length < 2) {
    return null;
  }

  const entitlement = validSnapshots[0].premium_entitlement;
  if (!(entitlement > 0)) {
    return null;
  }

  // Anchor the sprint window to the reset date. Without it we can't draw an
  // ideal burn line, so the caller falls back to the time-based chart.
  const resetTime = new Date(data.quota_reset_date_utc).getTime();
  if (!Number.isFinite(resetTime)) {
    return null;
  }

  // Sprint start = one calendar month before the reset date.
  const startDate = new Date(resetTime);
  startDate.setMonth(startDate.getMonth() - 1);
  const startTime = startDate.getTime();
  const periodMs = resetTime - startTime;
  if (!(periodMs > 0)) {
    return null;
  }

  const now = Date.now();
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  // Keep only snapshots that fall inside the current sprint window, oldest first.
  const realInWindow = validSnapshots
    .filter(s => {
      const ts = new Date(s.timestamp).getTime();
      return Number.isFinite(ts) && ts >= startTime && ts <= resetTime;
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
    return null;
  }

  const series: ChartSeries[] = [];

  // Ideal burn line: full entitlement at sprint start -> 0 at reset.
  series.push({
    role: "ideal",
    label: t("Ideal"),
    points: [
      { x: startTime, y: entitlement },
      { x: resetTime, y: 0 },
    ],
    fill: false,
    dashed: true,
    showPoints: false,
    tooltip: false,
  });

  // Actual burn line from recorded snapshots.
  series.push({
    role: "actual",
    label: t("Actual"),
    points: inWindow.map(s => ({ x: s.t, y: clamp(s.remaining, 0, entitlement) })),
    fill: true,
    dashed: false,
    showPoints: true,
    tooltip: true,
  });

  // Trend line: project the observed burn rate forward to the reset date (or
  // to the point where credits would hit zero, whichever comes first).
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

    series.push({
      role: "trend",
      label: t("Trend"),
      points: [
        { x: lastTrend.t, y: clamp(lastTrend.remaining, 0, entitlement) },
        { x: endTime, y: clamp(endRemaining, 0, entitlement) },
      ],
      fill: false,
      dashed: false,
      showPoints: false,
      tooltip: false,
    });
    trendLegend = '<span class="legend-item"><span class="legend-swatch legend-trend"></span>' + t("Trend") + '</span>';

    if (zeroTime < resetTime) {
      const d = new Date(zeroTime);
      trendFootnote = ' · ' + t("projected to run out {0}", (d.getMonth() + 1) + '/' + d.getDate());
    }
  }

  // "Today" marker (only when we're inside the sprint window): a vertical line
  // drawn as a two-point series spanning the full height.
  if (now >= startTime && now <= resetTime) {
    series.push({
      role: "today",
      label: "today",
      points: [
        { x: now, y: 0 },
        { x: now, y: entitlement },
      ],
      fill: false,
      dashed: true,
      showPoints: false,
      tooltip: false,
    });
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

  const fmtDate = (ms: number) => {
    const d = new Date(ms);
    return (d.getMonth() + 1) + "/" + d.getDate();
  };

  const model: ChartModel = {
    id: "insightsChart",
    kind: "burndown",
    type: "line",
    series,
    xMin: startTime,
    xMax: resetTime,
    yMin: 0,
    yMax: entitlement,
    xTicks: [
      { value: startTime, label: fmtDate(startTime) },
      { value: resetTime, label: fmtDate(resetTime) + ' (reset)' },
    ],
    yTicks: [0, entitlement / 2, entitlement],
    unit: t("credits"),
  };

  const legendHtml =
    '<div class="burndown-legend">' +
    '<span class="legend-item"><span class="legend-swatch legend-actual"></span>' + t("Actual") + '</span>' +
    '<span class="legend-item"><span class="legend-swatch legend-ideal"></span>' + t("Ideal") + '</span>' +
    trendLegend +
    '</div>';
  const footnoteHtml = '<div class="chart-footnote" style="color:' + statusColor + ';">' + statusText + trendFootnote + '</div>';

  return {
    model,
    title: t("AI Credits Burn-down"),
    legendHtml,
    footnoteHtml,
  };
}

function buildDailyUsageChartModel(
  data: CopilotUserData,
  snapshots: readonly LocalSnapshot[],
  config: RenderConfig
): ChartResult | null {
  if (snapshots.length < 2) {
    return null;
  }

  const validSnapshots = snapshots
    .filter(s => s.premium_entitlement > 0)
    .map(s => ({ t: new Date(s.timestamp).getTime(), remaining: s.premium_remaining }))
    .filter(s => Number.isFinite(s.t))
    .sort((a, b) => a.t - b.t);
  if (validSnapshots.length < 2) {
    return null;
  }

  let startTime = validSnapshots[0].t;
  const resetTime = new Date(data.quota_reset_date_utc).getTime();
  if (Number.isFinite(resetTime)) {
    const startDate = new Date(resetTime);
    startDate.setMonth(startDate.getMonth() - 1);
    if (startDate.getTime() < resetTime) {
      startTime = startDate.getTime();
    }
  }

  const dayKey = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const formatDay = (ms: number) => {
    const d = new Date(ms);
    return (d.getMonth() + 1) + "/" + d.getDate();
  };

  const dailyUsage = new Map<number, number>();
  for (let i = 1; i < validSnapshots.length; i++) {
    const prev = validSnapshots[i - 1];
    const curr = validSnapshots[i];
    if (curr.t < startTime || curr.t > (Number.isFinite(resetTime) ? resetTime : Date.now())) {
      continue;
    }
    const used = prev.remaining - curr.remaining;
    if (used <= 0) {
      continue;
    }
    const key = dayKey(curr.t);
    dailyUsage.set(key, (dailyUsage.get(key) ?? 0) + used);
  }

  if (dailyUsage.size === 0) {
    return null;
  }

  const points = [...dailyUsage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([x, y]) => ({ x, y }));
  const maxUsed = Math.max(...points.map(p => p.y));
  const yMax = Math.max(maxUsed, config.dailyBudget > 0 ? config.dailyBudget : 0) * 1.15 || 1;
  const xMin = points[0].x - 12 * 60 * 60 * 1000;
  const xMax = points[points.length - 1].x + 12 * 60 * 60 * 1000;

  const xTicks: ChartAxisTick[] = points.length === 1
    ? [{ value: points[0].x, label: formatDay(points[0].x) }]
    : [
      { value: points[0].x, label: formatDay(points[0].x) },
      { value: points[points.length - 1].x, label: formatDay(points[points.length - 1].x) },
    ];

  const model: ChartModel = {
    id: "dailyUsageChart",
    kind: "dailyUsage",
    type: "bar",
    series: [
      {
        role: "daily",
        type: "bar",
        label: t("Used"),
        points,
        fill: false,
        dashed: false,
        showPoints: false,
        tooltip: true,
      },
    ],
    xMin,
    xMax,
    yMin: 0,
    yMax,
    xTicks,
    yTicks: [0, yMax / 2, yMax],
    unit: t("credits"),
  };

  return {
    model,
    title: t("Daily AI Credit Usage"),
    legendHtml: "",
    footnoteHtml: '<div class="chart-footnote">' + t("Estimated from local refresh deltas") + '</div>',
  };
}
