// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

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
	public static readonly viewType = 'copilotInsights.sidebarView';
	private _view?: vscode.WebviewView;

	constructor(private readonly _extensionUri: vscode.Uri) {}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri]
		};

		webviewView.webview.html = this._getLoadingHtml();

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
			const session = await vscode.authentication.getSession('github', ['user:email'], { createIfNone: true });
			
			if (!session) {
				this._updateWithError('Failed to authenticate with GitHub');
				return;
			}

			// Call the GitHub Copilot endpoint
			const response = await fetch('https://api.github.com/copilot_internal/user', {
				headers: {
					'Authorization': `Bearer ${session.accessToken}`,
					'Accept': 'application/json',
					'User-Agent': 'VSCode-Copilot-Insights'
				}
			});

			if (!response.ok) {
				throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
			}

			const data = await response.json() as CopilotUserData;
			this._updateWithData(data);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			this._updateWithError(errorMessage);
			vscode.window.showErrorMessage(`Failed to load Copilot data: ${errorMessage}`);
		}
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
	}

	private _calculateDaysUntilReset(resetDate: string, asOfTime: string): { days: number; hours: number; totalDays: number } {
		const reset = new Date(resetDate).getTime();
		const asOf = new Date(asOfTime).getTime();
		const diffMs = reset - asOf;
		const diffDays = diffMs / (1000 * 60 * 60 * 24);
		const days = Math.floor(diffDays);
		const hours = Math.floor((diffDays - days) * 24);
		return { days, hours, totalDays: diffDays };
	}

	private _calculateTimeSince(timestamp: string): string {
		const now = new Date().getTime();
		const then = new Date(timestamp).getTime();
		const diffMs = now - then;
		const diffMinutes = Math.floor(diffMs / (1000 * 60));
		const diffHours = Math.floor(diffMinutes / 60);
		const diffDays = Math.floor(diffHours / 24);

		if (diffDays > 0) {
			return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
		} else if (diffHours > 0) {
			return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
		} else if (diffMinutes > 0) {
			return `${diffMinutes} min${diffMinutes > 1 ? 's' : ''} ago`;
		} else {
			return 'just now';
		}
	}

	private _formatDate(dateStr: string): string {
		const date = new Date(dateStr);
		return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
	}

	private _formatDateTime(dateStr: string): string {
		const date = new Date(dateStr);
		return date.toLocaleString('en-US', { 
			year: 'numeric', 
			month: 'short', 
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			timeZoneName: 'short'
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
		const latestSnapshot = quotaSnapshotsArray.length > 0 
			? quotaSnapshotsArray[0] 
			: null;
		
		const asOfTime = latestSnapshot?.timestamp_utc || new Date().toISOString();
		const timeUntilReset = this._calculateDaysUntilReset(data.quota_reset_date_utc, asOfTime);
		const timeSince = this._calculateTimeSince(asOfTime);
		const orgCount = data.organization_list?.length || 0;
		
		// Check if data is stale (> 1 hour old)
		const isStale = new Date().getTime() - new Date(asOfTime).getTime() > 3600000;

		// Generate summary cards HTML
		const summaryCardsHtml = `
			<div class="section">
				<h2 class="section-title">Plan Details</h2>
				<div class="summary-cards">
					<div class="summary-card">
						<div class="card-label">Plan</div>
						<div class="card-value">${data.copilot_plan || 'Unknown'}</div>
					</div>
					<div class="summary-card">
						<div class="card-label">Chat</div>
						<div class="card-value">${data.chat_enabled ? 'Enabled' : 'Disabled'}</div>
					</div>
					<div class="summary-card">
						<div class="card-label">Orgs</div>
						<div class="card-value">${orgCount}${orgCount > 1 ? ' 🔗' : ''}</div>
					</div>
				</div>
			</div>
		`;

		// Generate quotas HTML
		let quotasHtml = '';
		if (quotaSnapshotsArray.length > 0) {
			quotasHtml = quotaSnapshotsArray.map(quota => {
				const quotaName = quota.quota_id.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
				
				if (quota.unlimited) {
					return `
						<div class="quota-card">
							<div class="quota-header">
								<div class="quota-title">${quotaName}</div>
								<div class="quota-badge unlimited">Unlimited</div>
							</div>
						</div>
					`;
				}

				const used = quota.entitlement - quota.remaining;
				const percentUsed = Math.round((used / quota.entitlement) * 100);
				const percentRemaining = Math.round((quota.remaining / quota.entitlement) * 100);
				
				// Calculate pacing
				let pacingHtml = '';
				if (timeUntilReset.totalDays > 0) {
					const allowedPerDay = Math.floor(quota.remaining / timeUntilReset.totalDays);
					pacingHtml = `
						<div class="quota-pacing-highlight">
							<div class="pacing-row">
								<span class="pacing-label">To last until reset:</span>
								<span class="pacing-value">≤ ${allowedPerDay}/day</span>
							</div>
							<div class="pacing-row">
								<span class="pacing-label">Reset in:</span>
								<span class="pacing-value">${timeUntilReset.days}d ${timeUntilReset.hours}h</span>
							</div>
							<div class="pacing-row">
								<span class="pacing-label">Reset Date:</span>
								<span class="pacing-value">${this._formatDateTime(data.quota_reset_date_utc)}</span>
							</div>
						</div>
					`;
				}

				return `
					<div class="quota-card">
						<div class="quota-header">
							<div class="quota-title">${quotaName}</div>
							<div class="quota-badge">${percentRemaining}% remaining</div>
						</div>
						<div class="progress-bar">
							<div class="progress-fill" style="width: ${percentRemaining}%"></div>
						</div>
						<div class="quota-stats">
							<div class="stat">
								<span class="stat-label">Remaining:</span>
								<span class="stat-value">${quota.remaining}</span>
							</div>
							<div class="stat">
								<span class="stat-label">Used:</span>
								<span class="stat-value">${used}</span>
							</div>
							<div class="stat">
								<span class="stat-label">Total:</span>
								<span class="stat-value">${quota.entitlement}</span>
							</div>
						</div>
						${pacingHtml}
						${quota.overage_permitted ? `
							<div class="quota-overage">
								<span>Overage permitted</span>
								${quota.overage_count > 0 ? `<span class="overage-count">${quota.overage_count} used</span>` : ''}
							</div>
						` : ''}
					</div>
				`;
			}).join('');
		}

		// Generate organizations HTML
		let orgsHtml = '';
		if (data.organization_list && data.organization_list.length > 0) {
			orgsHtml = `
				<div class="section">
					<h2 class="section-title">Organizations</h2>
					<div class="org-list">
						${data.organization_list.map(org => `
							<div class="org-item">
								<div class="org-name">${org.name || org.login}</div>
								<div class="org-login">@${org.login}</div>
							</div>
						`).join('')}
					</div>
				</div>
			`;
		}

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
				</style>
			</head>
			<body>
				<div class="header">
				<div class="last-updated">Last fetched: ${timeSince}</div>
			</div>

			${isStale ? `<div class="warning-banner">⚠️ Data may be stale (fetched over 1 hour ago)</div>` : ''}
					${quotasHtml || '<p style="color: var(--vscode-descriptionForeground);">No quota data available</p>'}
				</div>

				${summaryCardsHtml}

				<div class="section">
					<h2 class="section-title">Access Details</h2>
					<div class="quota-card">
						<div class="quota-stats">
							<div class="stat">
								<span class="stat-label">SKU/Access</span>
								<span class="stat-value">${data.access_type_sku || 'Unknown'}</span>
							</div>
							<div class="stat">
								<span class="stat-label">Assigned</span>
								<span class="stat-value">${this._formatDate(data.assigned_date)}</span>
							</div>
						</div>
					</div>
				</div>

				${orgsHtml}

				<div class="disclaimer">
					ℹ️ This view shows plan and quota status. It is not a usage report.
				</div>
			</body>
			</html>`;
	}
}

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
	console.log('Copilot Insights extension is now active!');

	// Register the sidebar webview provider
	const provider = new CopilotInsightsViewProvider(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(CopilotInsightsViewProvider.viewType, provider)
	);

	// Optional: Register command to refresh the view
	const refreshCommand = vscode.commands.registerCommand('vscode-copilot-insights.refresh', () => {
		provider.loadCopilotData();
	});

	context.subscriptions.push(refreshCommand);
}

// This method is called when your extension is deactivated
export function deactivate() {}
