import * as os from "node:os";
import * as path from "node:path";
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
import { ExportFormat, serializeHistory } from "../../core/exporter";
import { SnapshotStore } from "../../core/history";
import { getLog } from "../../log";
import { StatusBarManager } from "../statusBar";
import {
  buildViewModel,
  RenderConfig,
  renderShellHtml,
  WebviewStateMessage,
} from "./render";

export class CopilotInsightsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "copilotInsights.sidebarView";

  private _view?: vscode.WebviewView;
  private _lastData?: CopilotUserData;
  private _lastStateMessage: WebviewStateMessage = { state: "loading" };
  private readonly _premiumUsageAlertKey =
    "copilotInsights.premiumUsageAlerts";
  private readonly _lastSeenResetDateKey =
    "copilotInsights.lastSeenResetDate";
  private readonly _alertSnoozeUntilKey =
    "copilotInsights.alertSnoozeUntil";
  private readonly _lastAutoExportDateKey =
    "copilotInsights.lastAutoExportDate";
  private readonly _snapshots: SnapshotStore;
  private _pollingTimer?: ReturnType<typeof setInterval>;
  private _isLoadingCopilotData = false;
  private _lastSuccessfulFetchMs = 0;
  private _backoffMultiplier = 1;
  private static readonly _maxBackoffMultiplier = 8;
  /** Skip visibility/focus-triggered refreshes when data is fresher than this. */
  private static readonly _visibilityFreshnessSeconds = 30;

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
        this._statusBar.update(this._lastData, this._snapshots.snapshots);
        this._publishData(this._lastData);
      }

      if (affectedPolling) {
        this._restartPolling(true);
      }
    });
    this._context.subscriptions.push(configurationChangeDisposable);

    // Refresh silently when GitHub authentication sessions change (sign-in/out)
    const sessionChangeDisposable = vscode.authentication.onDidChangeSessions(
      (event) => {
        if (event.provider.id === "github") {
          void this.loadCopilotData({ silent: true });
        }
      }
    );
    this._context.subscriptions.push(sessionChangeDisposable);

    // Focus-aware polling: pause background polling while the window is
    // unfocused; resume (with a staleness-guarded silent refresh) on focus.
    const windowStateDisposable = vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        this._restartPolling();
        void this.loadCopilotData({
          silent: true,
          ifStalerThanSeconds: CopilotInsightsViewProvider._visibilityFreshnessSeconds,
        });
      } else {
        this._clearPollingTimer();
      }
    });
    this._context.subscriptions.push(windowStateDisposable);

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

    // Back off while background refreshes keep failing (1x, 2x, 4x, 8x).
    const effectiveSeconds = pollingIntervalSeconds * this._backoffMultiplier;
    this._pollingTimer = setInterval(() => {
      void this._pollOnce();
    }, effectiveSeconds * 1000);

    if (refreshImmediately) {
      void this._pollOnce();
    }
  }

  /**
   * Runs one background poll and adjusts the backoff multiplier: doubled
   * (capped at 8x) after a failure, reset to 1x after a success.
   */
  private async _pollOnce() {
    const succeeded = await this.loadCopilotData({ silent: true });
    const nextMultiplier = succeeded
      ? 1
      : Math.min(
        this._backoffMultiplier * 2,
        CopilotInsightsViewProvider._maxBackoffMultiplier
      );
    if (nextMultiplier !== this._backoffMultiplier) {
      this._backoffMultiplier = nextMultiplier;
      this._restartPolling();
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
        case "signIn":
          await this.loadCopilotData();
          break;
      }
    });

    // Refresh Copilot data silently when the view becomes visible, unless
    // the cached data is still fresh.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.loadCopilotData({
          silent: true,
          ifStalerThanSeconds: CopilotInsightsViewProvider._visibilityFreshnessSeconds,
        });
      }
    });

    // Load initial data
    this.loadCopilotData();
  }

  /**
   * Loads Copilot data and updates the status bar and webview.
   *
   * @param options.silent Never prompt for sign-in or surface errors to the user.
   * @param options.ifStalerThanSeconds Skip the fetch entirely when the last
   * successful fetch is more recent than this (used by visibility/focus
   * handlers; manual refresh always fetches).
   * @returns `false` when a fetch was attempted and failed, `true` otherwise.
   */
  public async loadCopilotData(
    options: { silent?: boolean; ifStalerThanSeconds?: number } = {}
  ): Promise<boolean> {
    if (this._isLoadingCopilotData) {
      return true;
    }

    if (
      options.ifStalerThanSeconds !== undefined &&
      this._lastSuccessfulFetchMs > 0 &&
      Date.now() - this._lastSuccessfulFetchMs < options.ifStalerThanSeconds * 1000
    ) {
      return true;
    }

    this._isLoadingCopilotData = true;

    try {
      // Get GitHub authentication session.
      // Silent loads (startup, background polling) never prompt the user;
      // interactive loads (opening the view, manual refresh) may show the sign-in flow.
      const session = await vscode.authentication.getSession(
        "github",
        ["user:email"],
        options.silent
          ? { createIfNone: false, silent: true }
          : { createIfNone: true }
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
        return true;
      }

      const data = await fetchCopilotUserData(session.accessToken);

      // Record snapshot for history tracking (per GitHub account)
      this._snapshots.setAccount(data.login);
      const premiumQ = findPremiumQuota(data.quota_snapshots);
      if (premiumQ && !premiumQ.unlimited) {
        // Store raw API values — effective quota is applied at display time only
        this._snapshots.add(premiumQ.remaining, premiumQ.entitlement);
      }

      this._lastData = data;
      this._lastSuccessfulFetchMs = Date.now();
      this._statusBar.update(data, this._snapshots.snapshots);
      this._publishData(data);
      this._maybeNotifyPremiumUsage(data);
      this._maybeNotifyQuotaReset(data);
      void this._maybeAutoExportHistory();
      getLog().debug(`Copilot data refreshed for ${data.login || "unknown user"}`);
      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";

      if (options.silent) {
        getLog().warn(`Background refresh failed: ${errorMessage}`);
        return false;
      }

      getLog().error(`Failed to load Copilot data: ${errorMessage}`);
      this._publishError(errorMessage);
      vscode.window.showErrorMessage(
        vscode.l10n.t("Failed to load Copilot data: {0}", errorMessage)
      );
      return false;
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
    // Respect an active alert snooze.
    const snoozeUntil = this._context.globalState.get<number>(this._alertSnoozeUntilKey, 0);
    if (Date.now() < snoozeUntil) {
      return;
    }

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
          vscode.l10n.t("Open details"),
          vscode.l10n.t("Snooze for 24 hours")
        )
        .then((selection) => {
          if (selection === vscode.l10n.t("Open details")) {
            vscode.commands.executeCommand("copilotInsights.sidebarView.focus");
          } else if (selection === vscode.l10n.t("Snooze for 24 hours")) {
            const until = Date.now() + 24 * 60 * 60 * 1000;
            this._context.globalState.update(this._alertSnoozeUntilKey, until);
            getLog().info("Usage alerts snoozed for 24 hours");
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

  /**
   * Shows a one-time information toast when the billing period rolls over
   * (the reset date changes). On first run the date is stored silently.
   */
  private _maybeNotifyQuotaReset(data: CopilotUserData) {
    const resetDate = data.quota_reset_date_utc || "";
    if (!resetDate) {
      return;
    }

    const lastSeen = this._context.globalState.get<string>(this._lastSeenResetDateKey);
    if (lastSeen === resetDate) {
      return;
    }

    this._context.globalState.update(this._lastSeenResetDateKey, resetDate);

    // First run — just remember the date without notifying.
    if (lastSeen === undefined) {
      return;
    }

    const notifyOnReset = vscode.workspace
      .getConfiguration("copilotInsights")
      .get<boolean>("notifyOnReset", true);
    if (!notifyOnReset) {
      return;
    }

    const premiumQuota = findPremiumQuota(data.quota_snapshots);
    if (!premiumQuota || premiumQuota.unlimited) {
      return;
    }

    const effectiveQuota = getEffectiveQuota(premiumQuota, this._getRenderConfig().customLimit);
    const credits = effectiveQuota.entitlement || effectiveQuota.quota_remaining;
    getLog().info(`Quota reset detected (new reset date: ${resetDate})`);
    vscode.window.showInformationMessage(
      vscode.l10n.t("Your Copilot quota has reset. You have {0} credits available.", credits)
    );
  }

  /**
   * Writes the snapshot history to the configured auto-export folder at most
   * once per day. Failures are logged as warnings and never surfaced as toasts.
   */
  private async _maybeAutoExportHistory() {
    const config = vscode.workspace.getConfiguration("copilotInsights");
    if (!config.get<boolean>("autoExport.enabled", false)) {
      return;
    }

    let folder = config.get<string>("autoExport.folder", "").trim();
    if (!folder) {
      return;
    }

    // Export at most once per day.
    const today = new Date().toISOString().slice(0, 10);
    const lastExportDate = this._context.globalState.get<string>(this._lastAutoExportDateKey);
    if (lastExportDate === today) {
      return;
    }

    const format: ExportFormat =
      config.get<string>("autoExport.format", "json") === "csv" ? "csv" : "json";

    if (folder === "~" || folder.startsWith("~/") || folder.startsWith("~\\")) {
      folder = path.join(os.homedir(), folder.slice(1));
    }

    const target = vscode.Uri.file(path.join(folder, `copilot-insights-history.${format}`));
    const content = serializeHistory(this._snapshots.snapshots, format);

    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
      await this._context.globalState.update(this._lastAutoExportDateKey, today);
      getLog().info(
        `Auto-exported ${this._snapshots.snapshots.length} snapshots to ${target.fsPath}`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      getLog().warn(`Auto-export failed for ${target.fsPath}: ${errorMessage}`);
    }
  }
}
