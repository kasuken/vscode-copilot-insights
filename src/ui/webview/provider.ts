import * as vscode from "vscode";
import { CopilotUserData, DEFAULT_POLLING_INTERVAL_SECONDS } from "../../types";
import { fetchCopilotUserData } from "../../api/copilotApi";
import {
  computeQuotaStats,
  findPremiumQuota,
  getEffectiveQuota,
  normalizePollingIntervalSeconds,
} from "../../core/quota";
import { generateMarkdownSummary } from "../../core/markdown";
import { SnapshotStore } from "../../core/history";
import { getLog } from "../../log";
import { StatusBarManager } from "../statusBar";
import {
  buildViewModel,
  RenderConfig,
  renderShellHtml,
  WebviewStateMessage,
} from "./render";

const GITHUB_PROVIDER_IDS = ["github", "github-enterprise"] as const;
type GithubProviderId = (typeof GITHUB_PROVIDER_IDS)[number];

export class CopilotInsightsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "copilotInsights.sidebarView";

  private _view?: vscode.WebviewView;
  private _lastData?: CopilotUserData;
  private _lastStateMessage: WebviewStateMessage = { state: "loading" };
  private readonly _premiumUsageAlertKey =
    "copilotInsights.premiumUsageAlerts";
  private readonly _snapshots: SnapshotStore;
  private _pollingTimer?: ReturnType<typeof setInterval>;
  private _isLoadingCopilotData = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
    private readonly _statusBar: StatusBarManager
  ) {
    this._snapshots = new SnapshotStore(_context.globalState);

    // Listen for configuration changes to update the status bar and sidebar in real-time
    const configurationChangeDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
      const affectedVisual = event.affectsConfiguration('copilotInsights.statusBarLocation') ||
        event.affectsConfiguration('copilotInsights.statusBarStyle') ||
        event.affectsConfiguration('copilotInsights.progressBarMode') ||
        event.affectsConfiguration('copilotInsights.statusBar.showName') ||
        event.affectsConfiguration('copilotInsights.statusBar.showNumericalQuota') ||
        event.affectsConfiguration('copilotInsights.statusBar.showVisualIndicator') ||
        event.affectsConfiguration('copilotInsights.statusBar.enableColoredBackground') ||
        event.affectsConfiguration('copilotInsights.showMood') ||
        event.affectsConfiguration('copilotInsights.dailyBudget') ||
        event.affectsConfiguration('copilotInsights.customCreditLimit');
      const affectedPolling = event.affectsConfiguration(
        "copilotInsights.pollingIntervalSeconds"
      );

      if (event.affectsConfiguration("copilotInsights.statusBarLocation")) {
        this._statusBar.updateVisibility();
      }

      if (affectedVisual && this._lastData) {
        // Update the status bar and sidebar with the cached data
        this._statusBar.update(this._lastData);
        this._publishData(this._lastData);
      }

      if (affectedPolling) {
        this._restartPolling(true);
      }
    });
    this._context.subscriptions.push(configurationChangeDisposable);

    // Refresh silently when GitHub authentication sessions change (sign-in/out)
    const sessionChangeDisposable = vscode.authentication.onDidChangeSessions((event) => {
      if (GITHUB_PROVIDER_IDS.includes(event.provider.id as GithubProviderId)) {
        void this.loadCopilotData({ silent: true });
      }
    });
    this._context.subscriptions.push(sessionChangeDisposable);

    this._restartPolling();
  }

  public dispose() {
    this._clearPollingTimer();
  }

  /** Local snapshot history for the active account (newest first). */
  public get snapshotHistory() {
    return this._snapshots.snapshots;
  }

  /** Clears the local snapshot history and refreshes the view. */
  public clearSnapshotHistory() {
    this._snapshots.clear();
    getLog().info("Snapshot history cleared");
    if (this._lastData) {
      this._publishData(this._lastData);
    }
  }

  /**
   * Returns cached Copilot data, fetching silently when nothing is cached
   * yet. Used by the language model tool.
   */
  public async getOrFetchData(): Promise<CopilotUserData | undefined> {
    if (this._lastData) {
      return this._lastData;
    }
    await this.loadCopilotData({ silent: true });
    return this._lastData;
  }

  private _restartPolling(refreshImmediately = false) {
    this._clearPollingTimer();

    const pollingIntervalSeconds = this._getPollingIntervalSeconds();
    if (pollingIntervalSeconds === 0) {
      return;
    }

    this._pollingTimer = setInterval(() => {
      void this.loadCopilotData({ silent: true });
    }, pollingIntervalSeconds * 1000);

    if (refreshImmediately) {
      void this.loadCopilotData({ silent: true });
    }
  }

  private _clearPollingTimer() {
    if (this._pollingTimer) {
      clearInterval(this._pollingTimer);
      this._pollingTimer = undefined;
    }
  }

  private _getPollingIntervalSeconds(): number {
    const configuredValue = vscode.workspace
      .getConfiguration("copilotInsights")
      .get<number>(
        "pollingIntervalSeconds",
        DEFAULT_POLLING_INTERVAL_SECONDS
      );

    return normalizePollingIntervalSeconds(
      configuredValue,
      DEFAULT_POLLING_INTERVAL_SECONDS
    );
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

    // The shell is set once; all data updates flow through postMessage so the
    // scroll position is preserved across refreshes.
    webviewView.webview.html = renderShellHtml(webviewView.webview, this._extensionUri);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "ready":
          // The webview (re)loaded — sync it with the latest known state.
          this._postState(this._lastStateMessage);
          break;
        case "copyToClipboard":
          if (this._lastData) {
            const customLimit = this._getRenderConfig().customLimit;
            const markdown = generateMarkdownSummary(this._lastData, customLimit, vscode.env.language);
            await vscode.env.clipboard.writeText(markdown);
            vscode.window.showInformationMessage(
              vscode.l10n.t("Copilot Insights summary copied to clipboard")
            );
          }
          break;
        case "copyJsonToClipboard":
          if (this._lastData) {
            await vscode.env.clipboard.writeText(JSON.stringify(this._lastData, null, 2));
            vscode.window.showInformationMessage(
              vscode.l10n.t("Copilot Insights JSON copied to clipboard")
            );
          }
          break;
        case "signIn": {
          const preferredProvider =
            message.providerId === "github" || message.providerId === "github-enterprise"
              ? message.providerId
              : undefined;
          await this.loadCopilotData({ preferredProvider });
          break;
        }
      }
    });

    // Refresh Copilot data when view becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.loadCopilotData();
      }
    });

    // Load initial data
    this.loadCopilotData();
  }

  public async loadCopilotData(options: { silent?: boolean; preferredProvider?: GithubProviderId } = {}) {
    if (this._isLoadingCopilotData) {
      return;
    }

    this._isLoadingCopilotData = true;

    try {
      // Get GitHub authentication session.
      // Silent loads (startup, background polling) never prompt the user;
      // interactive loads (opening the view, manual refresh) may show the sign-in flow.
      const session = await this._getGitHubSession(
        options.silent === true,
        options.preferredProvider
      );

      if (!session) {
        if (options.silent) {
          // No session available without prompting — show a sign-in hint
          // instead of an error (unless we already have data to display).
          if (!this._lastData) {
            this._statusBar.showSignIn();
            this._postState({ state: "signin" });
          }
        } else {
          this._publishError(vscode.l10n.t("Failed to authenticate with GitHub"));
        }
        return;
      }

      const apiBaseUrl = vscode.workspace
        .getConfiguration("copilotInsights")
        .get<string>("apiBaseUrl", "https://api.github.com");
      const data = await fetchCopilotUserData(session.accessToken, apiBaseUrl);

      // Record snapshot for history tracking (per GitHub account)
      this._snapshots.setAccount(data.login);
      const premiumQ = findPremiumQuota(data.quota_snapshots);
      if (premiumQ && !premiumQ.unlimited) {
        // Store raw API values — effective quota is applied at display time only
        this._snapshots.add(premiumQ.remaining, premiumQ.entitlement);
      }

      this._lastData = data;
      this._statusBar.update(data);
      this._publishData(data);
      this._maybeNotifyPremiumUsage(data);
      getLog().debug(`Copilot data refreshed for ${data.login || "unknown user"}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";

      if (options.silent) {
        getLog().warn(`Background refresh failed: ${errorMessage}`);
        return;
      }

      getLog().error(`Failed to load Copilot data: ${errorMessage}`);
      this._publishError(errorMessage);
      vscode.window.showErrorMessage(
        vscode.l10n.t("Failed to load Copilot data: {0}", errorMessage)
      );
    } finally {
      this._isLoadingCopilotData = false;
    }
  }

  private _getRenderConfig(): RenderConfig {
    const config = vscode.workspace.getConfiguration("copilotInsights");
    return {
      showMood: config.get<boolean>("showMood", true),
      progressBarMode: config.get<string>("progressBarMode", "remaining"),
      customLimit: config.get<number>("customCreditLimit", 0),
      enableColoring: config.get<boolean>("statusBar.enableColoredBackground", true),
      dailyBudget: config.get<number>("dailyBudget", 0),
    };
  }

  private _publishData(data: CopilotUserData) {
    const model = buildViewModel(data, this._snapshots.snapshots, this._getRenderConfig());
    this._postState(model);
  }

  private async _getGitHubSession(
    silent: boolean,
    preferredProvider?: GithubProviderId
  ): Promise<vscode.AuthenticationSession | undefined> {
    const config = vscode.workspace.getConfiguration("copilotInsights");
    const authProvider = config.get<string>("authProvider", "auto");
    const scopes = ["user:email"];

    const configuredProvider =
      authProvider === "github" || authProvider === "github-enterprise"
        ? authProvider
        : undefined;

    const candidates = preferredProvider
      ? [preferredProvider]
      : configuredProvider
        ? [configuredProvider]
        : [...GITHUB_PROVIDER_IDS];

    for (const providerId of candidates) {
      const existingSession = await vscode.authentication.getSession(providerId, scopes, {
        createIfNone: false,
        silent: true,
      });
      if (existingSession) {
        return existingSession;
      }
    }

    if (silent) {
      return undefined;
    }

    const providerForInteractiveSignIn =
      preferredProvider ?? configuredProvider ?? (await this._pickAuthProviderForSignIn());
    if (!providerForInteractiveSignIn) {
      return undefined;
    }

    return vscode.authentication.getSession(providerForInteractiveSignIn, scopes, {
      createIfNone: true,
    });
  }

  private async _pickAuthProviderForSignIn(): Promise<GithubProviderId | undefined> {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: vscode.l10n.t("GitHub.com"),
          description: vscode.l10n.t("Use your github.com account"),
          providerId: "github" as const,
        },
        {
          label: vscode.l10n.t("GitHub Enterprise"),
          description: vscode.l10n.t("Use your GitHub Enterprise account"),
          providerId: "github-enterprise" as const,
        },
      ],
      {
        placeHolder: vscode.l10n.t("Choose an authentication provider for Copilot Insights"),
      }
    );

    return choice?.providerId;
  }

  private _publishError(error: string) {
    this._statusBar.showError(error);
    this._postState({ state: "error", message: error });
  }

  private _postState(message: WebviewStateMessage) {
    this._lastStateMessage = message;
    if (this._view) {
      void this._view.webview.postMessage({ type: "update", model: message });
    }
  }

  private _maybeNotifyPremiumUsage(data: CopilotUserData) {
    const premiumQuota = findPremiumQuota(data.quota_snapshots);
    if (!premiumQuota || premiumQuota.unlimited) {
      return;
    }

    const config = vscode.workspace.getConfiguration("copilotInsights");
    const thresholds = (config.get<number[]>("alertThresholds", [85]) ?? [])
      .filter((t) => typeof t === "number" && t > 0 && t <= 100)
      .sort((a, b) => b - a);
    if (thresholds.length === 0) {
      return;
    }

    const customLimit = this._getRenderConfig().customLimit;
    const effectiveQuota = getEffectiveQuota(premiumQuota, customLimit);
    if (!effectiveQuota.entitlement) {
      return;
    }

    const { percentUsed } = computeQuotaStats(effectiveQuota);
    const hasCustomLimit = effectiveQuota.entitlement > premiumQuota.entitlement;
    const quotaLabel = hasCustomLimit
      ? vscode.l10n.t("custom limit")
      : vscode.l10n.t("monthly quota");
    const resetDate = data.quota_reset_date_utc || "";

    // Alert state is tracked per billing period; each threshold fires once.
    const state = this._context.globalState.get<{ resetDate: string; notified: number[] }>(
      this._premiumUsageAlertKey
    );
    const notified = state?.resetDate === resetDate ? state.notified : [];

    const crossed = thresholds.filter((t) => percentUsed >= t);
    const newlyCrossed = crossed.filter((t) => !notified.includes(t));

    if (newlyCrossed.length > 0) {
      // Notify once for the highest newly crossed threshold.
      const highest = newlyCrossed[0];
      getLog().info(`Usage alert: ${percentUsed}% used crossed the ${highest}% threshold`);
      vscode.window
        .showWarningMessage(
          vscode.l10n.t(
            "Copilot AI Credits are at {0}% of your {1} (alert threshold: {2}%).",
            percentUsed,
            quotaLabel,
            highest
          ),
          vscode.l10n.t("Open details")
        )
        .then((selection) => {
          if (selection === vscode.l10n.t("Open details")) {
            vscode.commands.executeCommand("copilotInsights.sidebarView.focus");
          }
        });
      this._context.globalState.update(this._premiumUsageAlertKey, {
        resetDate,
        notified: [...notified, ...newlyCrossed],
      });
    } else if (state && state.resetDate !== resetDate) {
      // New billing period — clear the alert state.
      this._context.globalState.update(this._premiumUsageAlertKey, {
        resetDate,
        notified: [],
      });
    }
  }
}
