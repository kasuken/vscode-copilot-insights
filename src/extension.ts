// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";

interface Organization {
  login: string;
  name: string;
}

interface QuotaSnapshot {
  quota_id: string;
  timestamp_utc: string;
  entitlement: number;
  quota_remaining: number;
  remaining: number;
  percent_remaining: number;
  unlimited: boolean;
  overage_permitted: boolean;
  overage_count: number;
}

interface CopilotUserData {
  copilot_plan: string;
  chat_enabled: boolean;
  access_type_sku: string;
  assigned_date: string;
  organization_list: Organization[];
  quota_snapshots: {
    [key: string]: QuotaSnapshot;
  };
  quota_reset_date_utc: string;
  quota_reset_date: string;
  tracking_id?: string;
}

class CopilotInsightsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "copilotInsights.sidebarView";
  private _view?: vscode.WebviewView;
  private _statusBarItem: vscode.StatusBarItem;
  private readonly _premiumUsageAlertThreshold = 85;
  private readonly _premiumUsageAlertKey =
    "copilotInsights.premiumUsageAlert.resetDate";

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    // Create status bar item
    this._statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this._statusBarItem.command = "copilotInsights.sidebarView.focus";
    this._statusBarItem.text = "$(loading~spin) Copilot";
    this._statusBarItem.tooltip = "Loading Copilot insights...";
    this._statusBarItem.show();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getLoadingHtml();

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "copyToClipboard":
          if (message.data) {
            const markdown = this._generateMarkdownSummary(message.data);
            await vscode.env.clipboard.writeText(markdown);
            vscode.window.showInformationMessage(
              "Copilot Insights summary copied to clipboard"
            );
          }
          break;
      }
    });

    // Load Copilot data when view becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.loadCopilotData();
      }
    });

    // Load initial data
    this.loadCopilotData();
  }

  public async loadCopilotData() {
    try {
      // Get GitHub authentication session
      const session = await vscode.authentication.getSession(
        "github",
        ["user:email"],
        { createIfNone: true }
      );

      if (!session) {
        this._updateWithError("Failed to authenticate with GitHub");
        return;
      }

      // Call the GitHub Copilot endpoint
      const response = await fetch(
        "https://api.github.com/copilot_internal/user",
        {
          headers: {
            Authorization: `Bearer ${session.accessToken}`,
            Accept: "application/json",
            "User-Agent": "VSCode-Copilot-Insights",
          },
        }
      );

      if (!response.ok) {
        throw new Error(
          `GitHub API returned ${response.status}: ${response.statusText}`
        );
      }

      const apiData = (await response.json()) as Partial<CopilotUserData>;
      const data: CopilotUserData = {
        ...apiData,
        copilot_plan: this._normalizeCopilotPlan(apiData.copilot_plan),
        chat_enabled: Boolean(apiData.chat_enabled),
        access_type_sku: apiData.access_type_sku ?? "",
        assigned_date: apiData.assigned_date ?? "",
        organization_list: apiData.organization_list ?? [],
        quota_snapshots: apiData.quota_snapshots ?? {},
        quota_reset_date_utc: apiData.quota_reset_date_utc ?? "",
        quota_reset_date: apiData.quota_reset_date ?? "",
        tracking_id: apiData.tracking_id,
      };
      this._updateWithData(data);
      this._updateStatusBar(data);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      this._updateWithError(errorMessage);
      vscode.window.showErrorMessage(
        `Failed to load Copilot data: ${errorMessage}`
      );
    }
  }

  private _normalizeCopilotPlan(plan: unknown): string {
    const value = typeof plan === "string" ? plan.trim() : "";
    if (!value) {
      return "";
    }
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  private _updateWithData(data: CopilotUserData) {
    if (this._view) {
      this._view.webview.html = this._getHtmlForWebview(data);
    }
  }

  private _updateWithError(error: string) {
    if (this._view) {
      this._view.webview.html = this._getErrorHtml(error);
    }
    this._statusBarItem.text = "$(error) Copilot";
    this._statusBarItem.tooltip = `Error: ${error}`;
  }

  private _updateStatusBar(data: CopilotUserData) {
    // Find premium interactions quota
    const quotaSnapshotsArray = data.quota_snapshots
      ? Object.values(data.quota_snapshots)
      : [];

    const premiumQuota = quotaSnapshotsArray.find(
      (q) => q.quota_id === "premium_interactions"
    );

    if (premiumQuota && !premiumQuota.unlimited) {
      const percentRemaining = Math.round(
        (premiumQuota.remaining / premiumQuota.entitlement) * 100
      );
      const used = premiumQuota.entitlement - premiumQuota.remaining;
      const percentUsed = Math.round((used / premiumQuota.entitlement) * 100);
      const statusBadge = this._getStatusBadge(percentRemaining);

      this._statusBarItem.text = `${statusBadge.icon} Copilot: ${premiumQuota.remaining}/${premiumQuota.entitlement} (${percentRemaining}%)`;
      this._maybeNotifyPremiumUsage(data, premiumQuota, percentUsed);

      // Calculate days until reset
      const latestSnapshot = quotaSnapshotsArray[0];
      const asOfTime =
        latestSnapshot?.timestamp_utc || new Date().toISOString();
      const timeUntilReset = this._calculateDaysUntilReset(
        data.quota_reset_date_utc,
        asOfTime
      );

      this._statusBarItem.tooltip = new vscode.MarkdownString(
        `**GitHub Copilot Premium Interactions**\n\n` +
          `• Status: **${statusBadge.label}** ${statusBadge.emoji}\n` +
          `• Remaining: **${premiumQuota.remaining}** of **${premiumQuota.entitlement}** (${percentRemaining}%)\n` +
          `• Reset in: **${timeUntilReset.days}d ${timeUntilReset.hours}h**\n` +
          `• Plan: **${data.copilot_plan}**\n\n` +
          `_Click to view full details_`
      );
    } else {
      this._statusBarItem.text = "$(check) Copilot";
      this._statusBarItem.tooltip = new vscode.MarkdownString(
        `**GitHub Copilot**\n\n` +
          `• Plan: **${data.copilot_plan}**\n` +
          `• Premium Interactions: **Unlimited**\n\n` +
          `_Click to view full details_`
      );
    }
  }

  private _maybeNotifyPremiumUsage(
    data: CopilotUserData,
    premiumQuota: QuotaSnapshot,
    percentUsed: number
  ) {
    if (!premiumQuota?.entitlement || premiumQuota.unlimited) {
      return;
    }

    const resetDate = data.quota_reset_date_utc || "";
    const lastNotifiedReset = this._context.globalState.get<string>(
      this._premiumUsageAlertKey
    );

    if (
      percentUsed >= this._premiumUsageAlertThreshold &&
      lastNotifiedReset !== resetDate
    ) {
      vscode.window
        .showWarningMessage(
          `Copilot Premium requests are at ${percentUsed}% of your monthly quota.`,
          "Open details"
        )
        .then((selection) => {
          if (selection === "Open details") {
            vscode.commands.executeCommand("copilotInsights.sidebarView.focus");
          }
        });
      this._context.globalState.update(this._premiumUsageAlertKey, resetDate);
    } else if (
      lastNotifiedReset &&
      lastNotifiedReset !== resetDate &&
      percentUsed < this._premiumUsageAlertThreshold
    ) {
      this._context.globalState.update(this._premiumUsageAlertKey, undefined);
    }
  }

  private _calculateDaysUntilReset(
    resetDate: string,
    asOfTime: string
  ): { days: number; hours: number; totalDays: number } {
    const reset = new Date(resetDate).getTime();
    const asOf = new Date(asOfTime).getTime();
    const diffMs = reset - asOf;
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    const days = Math.floor(diffDays);
    const hours = Math.floor((diffDays - days) * 24);
    return { days, hours, totalDays: diffDays };
  }

  private _getMood(percentRemaining: number): { emoji: string; text: string } {
    if (percentRemaining > 75) {
      return { emoji: "😌", text: "Plenty of quota left" };
    } else if (percentRemaining > 40) {
      return { emoji: "🙂", text: "You’re fine" };
    } else if (percentRemaining > 15) {
      return { emoji: "😬", text: "Getting tight" };
    } else {
      return { emoji: "😱", text: "Danger zone" };
    }
  }

  private _getStatusBadge(percentRemaining: number): {
    emoji: string;
    icon: string;
    label: string;
    color: string;
  } {
    if (percentRemaining > 50) {
      return {
        emoji: "🟢",
        icon: "$(pass)",
        label: "Healthy",
        color: "var(--vscode-charts-green)",
      };
    } else if (percentRemaining >= 20) {
      return {
        emoji: "🟡",
        icon: "$(warning)",
        label: "Watch",
        color: "var(--vscode-charts-yellow)",
      };
    } else {
      return {
        emoji: "🔴",
        icon: "$(error)",
        label: "Risk",
        color: "var(--vscode-charts-red)",
      };
    }
  }

  private _generateMarkdownSummary(data: CopilotUserData): string {
    const quotaSnapshotsArray = data.quota_snapshots
      ? Object.values(data.quota_snapshots)
      : [];

    const latestSnapshot =
      quotaSnapshotsArray.length > 0 ? quotaSnapshotsArray[0] : null;
    const asOfTime = latestSnapshot?.timestamp_utc || new Date().toISOString();
    const timeUntilReset = this._calculateDaysUntilReset(
      data.quota_reset_date_utc,
      asOfTime
    );

    let markdown = `# GitHub Copilot Insights\n\n`;
    markdown += `**Generated:** ${new Date().toLocaleString()}\n\n`;

    // Plan Details
    markdown += `## Plan Details\n\n`;
    markdown += `- **Plan:** ${data.copilot_plan || "Unknown"}\n`;
    markdown += `- **Chat:** ${data.chat_enabled ? "Enabled" : "Disabled"}\n`;
    markdown += `- **Access/SKU:** ${data.access_type_sku || "Unknown"}\n`;
    markdown += `- **Assigned:** ${this._formatDate(data.assigned_date)}\n\n`;

    // Quotas
    if (quotaSnapshotsArray.length > 0) {
      markdown += `## Quotas\n\n`;
      quotaSnapshotsArray.forEach((quota) => {
        const quotaName = quota.quota_id
          .replace(/_/g, " ")
          .replace(/\b\w/g, (l) => l.toUpperCase());

        markdown += `### ${quotaName}\n\n`;

        if (quota.unlimited) {
          markdown += `- **Status:** Unlimited ∞\n\n`;
        } else {
          const percentRemaining = Math.round(
            (quota.remaining / quota.entitlement) * 100
          );
          const used = quota.entitlement - quota.remaining;
          const statusBadge = this._getStatusBadge(percentRemaining);

          markdown += `- **Status:** ${statusBadge.emoji} ${statusBadge.label} (${percentRemaining}% remaining)\n`;
          markdown += `- **Remaining:** ${quota.remaining}\n`;
          markdown += `- **Used:** ${used}\n`;
          markdown += `- **Total:** ${quota.entitlement}\n`;

          if (timeUntilReset.totalDays > 0) {
            const allowedPerDay = Math.floor(
              quota.remaining / timeUntilReset.totalDays
            );
            markdown += `- **To last until reset:** ≤ ${allowedPerDay}/day\n`;
            markdown += `- **Reset in:** ${timeUntilReset.days}d ${timeUntilReset.hours}h\n`;
            markdown += `- **Reset Date:** ${this._formatDate(
              data.quota_reset_date_utc
            )}\n`;
          }

          if (quota.overage_permitted) {
            markdown += `- **Overage:** Permitted`;
            if (quota.overage_count > 0) {
              markdown += ` (${quota.overage_count} used)`;
            }
            markdown += `\n`;
          }

          markdown += `\n`;
        }
      });
    }

    // Organizations
    if (data.organization_list && data.organization_list.length > 0) {
      markdown += `## Organizations with Copilot Access\n\n`;
      data.organization_list.forEach((org) => {
        markdown += `- **${org.name || org.login}** (@${org.login})\n`;
      });
      markdown += `\n`;
    }

    markdown += `---\n`;
    markdown += `*Data fetched from GitHub Copilot API*\n`;

    return markdown;
  }

  private _calculateTimeSince(timestamp: string): string {
    const now = new Date().getTime();
    const then = new Date(timestamp).getTime();
    const diffMs = now - then;
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
      return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
    } else if (diffHours > 0) {
      return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    } else if (diffMinutes > 0) {
      return `${diffMinutes} min${diffMinutes > 1 ? "s" : ""} ago`;
    } else {
      return "just now";
    }
  }

  private _formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  private _formatDateTime(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  }

  private _getLoadingHtml(): string {
    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Copilot Insights</title>
				<style>
					body {
						font-family: var(--vscode-font-family);
						padding: 20px;
						color: var(--vscode-foreground);
						background-color: var(--vscode-editor-background);
					}
					.loading {
						display: flex;
						align-items: center;
						justify-content: center;
						min-height: 200px;
						font-size: 16px;
					}
				</style>
			</head>
			<body>
				<div class="loading">Loading Copilot data...</div>
			</body>
			</html>`;
  }

  private _getErrorHtml(error: string): string {
    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Copilot Insights</title>
				<style>
					body {
						font-family: var(--vscode-font-family);
						padding: 20px;
						color: var(--vscode-foreground);
						background-color: var(--vscode-editor-background);
					}
					.error {
						color: var(--vscode-errorForeground);
						padding: 20px;
						border: 1px solid var(--vscode-errorBorder);
						background-color: var(--vscode-inputValidation-errorBackground);
						border-radius: 4px;
					}
				</style>
			</head>
			<body>
				<div class="error">
					<h2>Error Loading Copilot Data</h2>
					<p>${error}</p>
				</div>
			</body>
			</html>`;
  }

  private _getHtmlForWebview(data: CopilotUserData): string {
    // Convert quota_snapshots object to array
    const quotaSnapshotsArray = data.quota_snapshots
      ? Object.values(data.quota_snapshots)
      : [];

    // Get the most recent snapshot for timestamp
    const latestSnapshot =
      quotaSnapshotsArray.length > 0 ? quotaSnapshotsArray[0] : null;

    const asOfTime = latestSnapshot?.timestamp_utc || new Date().toISOString();
    const timeUntilReset = this._calculateDaysUntilReset(
      data.quota_reset_date_utc,
      asOfTime
    );
    const timeSince = this._calculateTimeSince(asOfTime);
    const orgCount = data.organization_list?.length || 0;

    // Check config for mood
    const showMood = vscode.workspace
      .getConfiguration("copilotInsights")
      .get("showMood", true);

    // Check if data is stale (> 1 hour old)
    const isStale =
      new Date().getTime() - new Date(asOfTime).getTime() > 3600000;

    // Generate summary cards HTML
    const summaryCardsHtml = `
			<div class="section">
				<h2 class="section-title">Plan Details</h2>
				<div class="summary-cards">
					<div class="summary-card">
						<div class="card-label" title="Your GitHub Copilot subscription plan">Plan</div>
						<div class="card-value">${data.copilot_plan || "Unknown"}</div>
					</div>
					<div class="summary-card">
						<div class="card-label" title="Access to Copilot Chat features">Chat</div>
						<div class="card-value">${data.chat_enabled ? "Enabled" : "Disabled"}</div>
					</div>
					<div class="summary-card">
						<div class="card-label" title="Organizations providing your Copilot seat">Orgs</div>
						<div class="card-value">${orgCount}${orgCount > 1 ? " 🔗" : ""}</div>
					</div>
				</div>
			</div>
		`;

    // Generate quotas HTML
    let quotasHtml = "";
    if (quotaSnapshotsArray.length > 0) {
      quotasHtml = quotaSnapshotsArray
        .map((quota) => {
          const quotaName = quota.quota_id
            .replace(/_/g, " ")
            .replace(/\b\w/g, (l) => l.toUpperCase());

          let quotaTooltip = "";
          if (quota.quota_id === "premium_interactions") {
            quotaTooltip =
              "Premium interactions are limited requests for advanced Copilot models.";
          }

          if (quota.unlimited) {
            return `
						<div class="quota-card">
							<div class="quota-header">
								<div class="quota-title" title="${quotaTooltip}">${quotaName}</div>
								<div class="quota-badge unlimited" title="You have unlimited usage for this feature">Unlimited</div>
							</div>
						</div>
					`;
          }

          const used = quota.entitlement - quota.remaining;
          const percentUsed = Math.round((used / quota.entitlement) * 100);
          const percentRemaining = Math.round(
            (quota.remaining / quota.entitlement) * 100
          );
          const statusBadge = this._getStatusBadge(percentRemaining);
          const mood = this._getMood(percentRemaining);

          // Get progress bar display mode from settings
          const progressBarMode = vscode.workspace
            .getConfiguration("copilotInsights")
            .get<string>("progressBarMode", "remaining");
          const showUsed = progressBarMode === "used";

          // Determine progress bar values based on mode
          const progressPercent = showUsed ? percentUsed : percentRemaining;
          const progressLabel = showUsed ? `${percentUsed}% used` : `${percentRemaining}% remaining`;
          
          // Determine progress bar color based on usage level (always based on usage for intuitive coloring)
          const progressBarColor = percentUsed > 80 
            ? 'var(--vscode-charts-red)' 
            : percentUsed > 50 
              ? 'var(--vscode-charts-yellow)' 
              : 'var(--vscode-charts-green)';

          // Calculate pacing
          let pacingHtml = "";
          if (timeUntilReset.totalDays > 0) {
            const allowedPerDay = Math.floor(
              quota.remaining / timeUntilReset.totalDays
            );

            // Calculate weeks remaining until reset (minimum 1 week)
            const weeksRemaining = Math.max(1, timeUntilReset.totalDays / 7);
            const allowedPerWeek = Math.floor(quota.remaining / weeksRemaining);

            // Calculate working days (Mon-Fri) until reset
            const workingDays = Math.floor(timeUntilReset.totalDays * (5 / 7)); // Approximate working days
            const allowedPerWorkDay =
              workingDays > 0 ? Math.floor(quota.remaining / workingDays) : 0;

            // Calculate working hours (Mon-Fri, 9 AM - 5 PM = 8 hours/day)
            const totalWorkingHours = workingDays * 8;
            const allowedPerHour =
              totalWorkingHours > 0
                ? Math.floor(quota.remaining / totalWorkingHours)
                : 0;

            // Calculate projections for multipliers
            const budget033 = Math.floor(
              quota.remaining / 0.33 / timeUntilReset.totalDays
            );
            const budget1 = Math.floor(quota.remaining / timeUntilReset.totalDays);
            const budget3 = Math.floor(
              quota.remaining / 3 / timeUntilReset.totalDays
            );

            pacingHtml = `
						<div class="quota-pacing-highlight">
							<div class="pacing-row">
								<span class="pacing-label" title="Maximum average daily usage to stay within quota">To last until reset:</span>
								<span class="pacing-value">≤ ${allowedPerDay}/day</span>
							</div>
							<div class="pacing-row">
								<span class="pacing-label" title="Time remaining until quota reset">Reset in:</span>
								<span class="pacing-value">${timeUntilReset.days}d ${
              timeUntilReset.hours
            }h</span>
							</div>
							<div class="pacing-row">
								<span class="pacing-label" title="Date when your monthly quota resets">Reset Date:</span>
								<span class="pacing-value">${this._formatDate(
                  data.quota_reset_date_utc
                )}</span>
							</div>
						<div class="pacing-separator" style="height: 1px; background-color: var(--vscode-panel-border); margin: 8px 0;"></div>
							<div style="font-size: 11px; font-weight: 600; margin-bottom: 6px; color: var(--vscode-foreground);">
								Projections premium requests before the reset
							</div>
							<div class="pacing-row">
								<span class="pacing-label" title="Recommended weekly limit">Weekly average:</span>
								<span class="pacing-value">≤ ${allowedPerWeek}/week</span>
							</div>
							<div class="pacing-row">
								<span class="pacing-label" title="Recommended daily limit for Mon-Fri">Work day average:</span>
								<span class="pacing-value">≤ ${allowedPerWorkDay}/day (Mon-Fri)</span>
							</div>
							<div class="pacing-row">
								<span class="pacing-label" title="Recommended hourly limit for work hours (9-5)">Work hour average:</span>
								<span class="pacing-value">≤ ${allowedPerHour}/hour (9-5)</span>
							</div>

              <div class="pacing-separator" style="height: 1px; background-color: var(--vscode-panel-border); margin: 8px 0;"></div>
              <div style="font-size: 11px; font-weight: 600; margin-bottom: 6px; color: var(--vscode-foreground);">
                Daily Capacity by Model Cost
              </div>
              <div class="pacing-row">
                <span class="pacing-label" title="Model cost multiplier: 0.33x">Efficient (0.33x):</span>
                <span class="pacing-value">~${budget033}/day</span>
              </div>
              <div class="pacing-row">
                <span class="pacing-label" title="Model cost multiplier: 1x">Standard (1x):</span>
                <span class="pacing-value">~${budget1}/day</span>
              </div>
              <div class="pacing-row">
                <span class="pacing-label" title="Model cost multiplier: 3x">Advanced (3x):</span>
                <span class="pacing-value">~${budget3}/day</span>
              </div>
						</div>
					`;
          }

          return `
					<div class="quota-card">
						<div class="quota-header">
							<div class="quota-title" title="${quotaTooltip}">${quotaName}</div>
							<div class="quota-badge">${progressLabel}</div>
						</div>
						<div class="progress-bar">
							<div class="progress-fill" style="width: ${progressPercent}%; background: ${progressBarColor};"></div>
						</div>
						<div class="quota-status">
							${
                showMood
                  ? `<span class="stat-label">Mood:</span>
								   <span class="stat-value" title="${mood.text}">${mood.emoji} ${mood.text}</span>`
                  : `<span class="stat-label" title="Usage health based on remaining quota and time">Status:</span>
								   <span class="stat-value" style="color: ${statusBadge.color};">${statusBadge.emoji} ${statusBadge.label}</span>`
              }
						</div>
						<div class="quota-stats">
							<div class="stat">
								<span class="stat-label" title="Calls available until the reset date">Remaining:</span>
								<span class="stat-value">${quota.remaining}</span>
							</div>
							<div class="stat">
								<span class="stat-label" title="Calls made since the last reset">Used:</span>
								<span class="stat-value">${used}</span>
							</div>
							<div class="stat">
								<span class="stat-label" title="Total calls allowed in this period">Total:</span>
								<span class="stat-value">${quota.entitlement}</span>
							</div>
						</div>
						${pacingHtml}
						${
              quota.overage_permitted
                ? `
							<div class="quota-overage">
								<span title="Additional usage allowed beyond standard quota">Overage permitted</span>
								${
                  quota.overage_count > 0
                    ? `<span class="overage-count">${quota.overage_count} used</span>`
                    : ""
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

    // Generate organizations HTML
    let orgsHtml = "";
    if (data.organization_list && data.organization_list.length > 0) {
      orgsHtml = `
				<div class="section">
					<h2 class="section-title">Organizations with Copilot Access</h2>
					<div class="org-list">
						${data.organization_list
              .map(
                (org) => `
							<div class="org-item">
								<div class="org-name">${org.name || org.login}</div>
								<div class="org-login">@${org.login}</div>
							</div>
						`
              )
              .join("")}
					</div>
				</div>
			`;
    }

    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://microsoft.github.io; font-src https://microsoft.github.io; script-src 'unsafe-inline';">
				<link rel="stylesheet" href="https://microsoft.github.io/vscode-codicons/dist/codicon.css">
				<title>Copilot Insights</title>
				<style>
					body {
						font-family: var(--vscode-font-family);
						padding: 12px;
						color: var(--vscode-foreground);
						background-color: var(--vscode-sideBar-background);
						font-size: 13px;
					}
					.header {
						margin-bottom: 16px;
					}
					.last-updated {
						font-size: 11px;
						color: var(--vscode-descriptionForeground);
						margin-bottom: 8px;
					}
					.warning-banner {
						background-color: var(--vscode-inputValidation-warningBackground);
						color: var(--vscode-inputValidation-warningForeground);
						border-left: 3px solid var(--vscode-inputValidation-warningBorder);
						padding: 8px;
						margin-bottom: 12px;
						border-radius: 2px;
						font-size: 12px;
					}
					.summary-cards {
						display: grid;
						grid-template-columns: 1fr 1fr 1fr;
						gap: 8px;
						margin-bottom: 16px;
					}
					.summary-card {
						background-color: var(--vscode-editor-background);
						border: 1px solid var(--vscode-panel-border);
						border-radius: 4px;
						padding: 8px;
					}
					.card-label {
						font-size: 11px;
						color: var(--vscode-descriptionForeground);
						margin-bottom: 4px;
					}
					.card-value {
						font-size: 14px;
						font-weight: 600;
					}
					.section {
						margin-bottom: 16px;
					}
					.section-title {
						font-size: 13px;
						font-weight: 600;
						margin-bottom: 8px;
						color: var(--vscode-foreground);
					}
					.quota-card {
						background-color: var(--vscode-editor-background);
						border: 1px solid var(--vscode-panel-border);
						border-radius: 4px;
						padding: 10px;
						margin-bottom: 8px;
					}
					.quota-header {
						display: flex;
						justify-content: space-between;
						align-items: center;
						margin-bottom: 8px;
					}
					.quota-title {
						font-weight: 600;
						font-size: 13px;
					}
					.quota-badge {
						font-size: 11px;
						padding: 2px 6px;
						background-color: var(--vscode-badge-background);
						color: var(--vscode-badge-foreground);
						border-radius: 10px;
					}
					.quota-badge.unlimited {
						background-color: var(--vscode-charts-green);
						color: var(--vscode-editor-background);
					}
					.progress-bar {
						height: 6px;
						background-color: var(--vscode-progressBar-background);
						border-radius: 3px;
						overflow: hidden;
						margin-bottom: 8px;
					}
					.progress-fill {
						height: 100%;
						background-color: var(--vscode-progressBar-background);
						background: linear-gradient(90deg, var(--vscode-charts-blue) 0%, var(--vscode-charts-green) 100%);
						transition: width 0.3s ease;
					}
					.quota-status {
						display: flex;
						flex-direction: column;
						margin-bottom: 8px;
						font-size: 12px;
					}
					.quota-stats {
						display: flex;
						justify-content: space-between;
						font-size: 12px;
						margin-bottom: 6px;
					}
					.stat {
						display: flex;
						flex-direction: column;
					}
					.stat-label {
						font-size: 10px;
						color: var(--vscode-descriptionForeground);
					}
					.stat-value {
						font-weight: 600;
					}
					.quota-pacing {
						font-size: 11px;
						color: var(--vscode-descriptionForeground);
						padding: 4px 0;
						font-style: italic;
					}
					.quota-pacing-highlight {
						background-color: var(--vscode-textCodeBlock-background);
						border-radius: 4px;
						padding: 8px;
						margin-top: 8px;
					}
					.pacing-row {
						display: flex;
						justify-content: space-between;
						align-items: center;
						margin-bottom: 4px;
					}
					.pacing-row:last-child {
						margin-bottom: 0;
					}
					.pacing-label {
						font-size: 11px;
						color: var(--vscode-descriptionForeground);
					}
					.pacing-value {
						font-size: 13px;
						font-weight: 700;
						color: var(--vscode-foreground);
					}
					.quota-overage {
						font-size: 11px;
						color: var(--vscode-descriptionForeground);
						padding-top: 4px;
						border-top: 1px solid var(--vscode-panel-border);
						margin-top: 4px;
						display: flex;
						justify-content: space-between;
					}
					.overage-count {
						color: var(--vscode-errorForeground);
						font-weight: 600;
					}
					.org-list {
						display: flex;
						flex-direction: column;
						gap: 6px;
					}
					.org-item {
						background-color: var(--vscode-editor-background);
						border: 1px solid var(--vscode-panel-border);
						border-radius: 4px;
						padding: 8px;
					}
					.org-name {
						font-weight: 600;
						font-size: 13px;
						margin-bottom: 2px;
					}
					.org-login {
						font-size: 11px;
						color: var(--vscode-descriptionForeground);
					}
					.metadata {
						margin-top: 16px;
						padding-top: 12px;
						border-top: 1px solid var(--vscode-panel-border);
					}
					.metadata-row {
						font-size: 11px;
						color: var(--vscode-descriptionForeground);
						margin-bottom: 4px;
					}
					.metadata-label {
						font-weight: 600;
					}
					.disclaimer {
						font-size: 10px;
						color: var(--vscode-descriptionForeground);
						font-style: italic;
						margin-top: 12px;
						padding: 8px;
						background-color: var(--vscode-editor-background);
						border-radius: 4px;
					}
					.copy-button {
						width: 100%;
						margin: 12px 0;
						padding: 8px 12px;
						background-color: var(--vscode-button-background);
						color: var(--vscode-button-foreground);
						border: none;
						border-radius: 4px;
						cursor: pointer;
						font-size: 12px;
						font-family: var(--vscode-font-family);
						display: flex;
						align-items: center;
						justify-content: center;
						gap: 6px;
					}
					.copy-button:hover {
						background-color: var(--vscode-button-hoverBackground);
					}
					.copy-button:active {
						background-color: var(--vscode-button-background);
						opacity: 0.8;
					}
					.copy-button .codicon {
						font-size: 14px;
					}
				</style>
			</head>
			<body>
				${
          isStale
            ? `<div class="warning-banner">⚠️ Data may be stale (fetched over 1 hour ago)</div>`
            : ""
        }

				<div class="section">
					<h2 class="section-title">Quotas</h2>
					${
            quotasHtml ||
            '<p style="color: var(--vscode-descriptionForeground);">No quota data available</p>'
          }
				</div>

				${summaryCardsHtml}

				${orgsHtml}

				<div class="section">
					<h2 class="section-title">Access Details</h2>
					<div class="quota-card">
						<div class="quota-stats">
							<div class="stat">
								<span class="stat-label" title="The specific SKU or access type of your subscription">SKU/Access</span>
								<span class="stat-value">${data.access_type_sku || "Unknown"}</span>
							</div>
							<div class="stat">
								<span class="stat-label" title="Date when this seat was assigned to you">Assigned</span>
								<span class="stat-value">${this._formatDate(data.assigned_date)}</span>
							</div>
						</div>
					</div>
				</div>

				<div class="disclaimer">
					ℹ️ This view shows plan and quota status. It is not a usage report.
				</div>

				<button id="copyButton" class="copy-button">
					<span class="codicon codicon-clippy"></span>
					Copy Summary to Clipboard
				</button>

				<div class="last-updated" style="text-align: center; margin-top: 8px;">
					Last fetched: ${timeSince}
				</div>

				<script>
					const vscode = acquireVsCodeApi();
					const data = ${JSON.stringify(data)};
					
					document.getElementById('copyButton').addEventListener('click', () => {
						vscode.postMessage({
							command: 'copyToClipboard',
							data: data
						});
					});
				</script>
			</body>
			</html>`;
  }
}

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
  console.log("Copilot Insights extension is now active!");

  // Register the sidebar webview provider
  const provider = new CopilotInsightsViewProvider(
    context.extensionUri,
    context
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CopilotInsightsViewProvider.viewType,
      provider
    )
  );

  // Optional: Register command to refresh the view
  const refreshCommand = vscode.commands.registerCommand(
    "vscode-copilot-insights.refresh",
    () => {
      provider.loadCopilotData();
    }
  );

  // Register command to open extension settings
  const openSettingsCommand = vscode.commands.registerCommand(
    "vscode-copilot-insights.openSettings",
    () => {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:emanuelebartolesi.vscode-copilot-insights"
      );
    }
  );

  context.subscriptions.push(refreshCommand, openSettingsCommand);
}

// This method is called when your extension is deactivated
export function deactivate() {}
