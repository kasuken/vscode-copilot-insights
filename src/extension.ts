import * as os from "node:os";
import * as vscode from "vscode";
import { StatusBarManager } from "./ui/statusBar";
import { CopilotInsightsViewProvider } from "./ui/webview/provider";
import { CopilotQuotaTool } from "./lmTool";
import { registerChatParticipant } from "./chatParticipant";
import { fetchOrgCopilotMetrics } from "./api/orgMetricsApi";
import { buildOrgMetricsMarkdown } from "./core/orgMetrics";
import {
  ExportFormat,
  serializeAttribution,
  serializeHistory,
  serializePeriods,
  serializeRollups,
} from "./core/exporter";
import { getLog } from "./log";

/** Runs one-time settings migrations, guarded by global-state flags. */
function runMigrations(context: vscode.ExtensionContext) {
  // One-time migration: rename copilotInsights.customPremiumLimit -> customCreditLimit
  const MIGRATION_KEY = "copilotInsights.customLimitMigrated";
  const hasMigratedCustomLimit = context.globalState.get<boolean>(MIGRATION_KEY, false);
  if (!hasMigratedCustomLimit) {
    const config = vscode.workspace.getConfiguration("copilotInsights");
    const legacy = config.inspect<number>("customPremiumLimit");
    const legacyGlobal = legacy?.globalValue;
    const newValue = config.inspect<number>("customCreditLimit")?.globalValue;
    if (typeof legacyGlobal === "number" && legacyGlobal > 0 && (newValue === undefined || newValue === 0)) {
      config.update("customCreditLimit", legacyGlobal, vscode.ConfigurationTarget.Global);
    }
    context.globalState.update(MIGRATION_KEY, true);
  }

  // One-time migration: legacy autoRefreshInterval (minutes; the setting was
  // never functional) -> pollingIntervalSeconds
  const AUTO_REFRESH_MIGRATION_KEY = "copilotInsights.autoRefreshMigrated";
  if (!context.globalState.get<boolean>(AUTO_REFRESH_MIGRATION_KEY, false)) {
    const config = vscode.workspace.getConfiguration("copilotInsights");
    const legacyMinutes = config.inspect<number>("autoRefreshInterval")?.globalValue;
    const currentSeconds = config.inspect<number>("pollingIntervalSeconds")?.globalValue;
    if (typeof legacyMinutes === "number" && legacyMinutes > 0 && currentSeconds === undefined) {
      config.update(
        "pollingIntervalSeconds",
        Math.round(legacyMinutes * 60),
        vscode.ConfigurationTarget.Global
      );
      getLog().info(`Migrated autoRefreshInterval (${legacyMinutes}m) to pollingIntervalSeconds`);
    }
    context.globalState.update(AUTO_REFRESH_MIGRATION_KEY, true);
  }
}

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(getLog());

  const statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  // Register the sidebar webview provider
  const provider = new CopilotInsightsViewProvider(
    context.extensionUri,
    context,
    statusBar
  );
  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CopilotInsightsViewProvider.viewType,
      provider
    )
  );

  runMigrations(context);

  // Language model tool so Copilot Chat can answer quota questions
  context.subscriptions.push(
    vscode.lm.registerTool("insights_getCopilotQuota", new CopilotQuotaTool(provider))
  );

  // Chat participant so users can ask @insights about quota, pacing, forecast
  registerChatParticipant(context, provider);

  // Trigger initial data load to populate status bars.
  // Silent: never prompt for GitHub sign-in at startup — interactive auth
  // happens when the user opens the view or refreshes manually.
  provider.loadCopilotData({ silent: true });

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

  // Register command to reset all settings to defaults
  const resetDefaultsCommand = vscode.commands.registerCommand(
    "vscode-copilot-insights.resetToDefaults",
    async () => {
      const result = await vscode.window.showWarningMessage(
        vscode.l10n.t("Reset all Copilot Insights settings to defaults?"),
        vscode.l10n.t("Reset"),
        vscode.l10n.t("Cancel")
      );

      if (result === vscode.l10n.t("Reset")) {
        const config = vscode.workspace.getConfiguration("copilotInsights");
        // Remove all user overrides so package.json defaults apply again
        const settings = [
          "showMood",
          "progressBarMode",
          "pollingIntervalSeconds",
          "statusBarLocation",
          "statusBarStyle",
          "statusBar.showName",
          "statusBar.showNumericalQuota",
          "statusBar.showVisualIndicator",
          "statusBar.enableColoredBackground",
          "customCreditLimit",
          "alertThresholds",
          "dailyBudget",
          "notifyOnReset",
          "autoExport.enabled",
          "autoExport.folder",
          "autoExport.format",
        ];
        await Promise.all(
          settings.map((setting) =>
            config.update(setting, undefined, vscode.ConfigurationTarget.Global)
          )
        );

        vscode.window.showInformationMessage(
          vscode.l10n.t("Copilot Insights settings reset to defaults.")
        );
        // Refresh the display
        provider.loadCopilotData();
      }
    }
  );

  // Export local usage history: daily rollups (the full billing period),
  // archived billing periods, or the raw snapshot window.
  const exportHistoryCommand = vscode.commands.registerCommand(
    "vscode-copilot-insights.exportHistory",
    async () => {
      const snapshots = provider.snapshotHistory;
      const rollups = provider.rollupHistory;
      const periods = provider.periodHistory;
      const attribution = provider.attributionState;
      const attributionRows = attribution?.buckets.length ?? 0;

      if (snapshots.length === 0 && rollups.length === 0) {
        vscode.window.showInformationMessage(
          vscode.l10n.t("No local usage history to export yet. History accumulates as quota data is refreshed.")
        );
        return;
      }

      interface ExportChoice extends vscode.QuickPickItem {
        ext: ExportFormat;
        file: string;
        count: number;
        serialize: (format: ExportFormat) => string;
      }

      const choices: ExportChoice[] = [
        {
          label: vscode.l10n.t("Daily usage — CSV"),
          description: vscode.l10n.t("One row per day, {0} days", rollups.length),
          ext: "csv",
          file: "copilot-insights-daily",
          count: rollups.length,
          serialize: (format) => serializeRollups(rollups, format),
        },
        {
          label: vscode.l10n.t("Daily usage — JSON"),
          description: vscode.l10n.t("One object per day, {0} days", rollups.length),
          ext: "json",
          file: "copilot-insights-daily",
          count: rollups.length,
          serialize: (format) => serializeRollups(rollups, format),
        },
        {
          label: vscode.l10n.t("Project attribution — CSV"),
          description: vscode.l10n.t("One row per project and branch, {0} rows", attributionRows),
          ext: "csv",
          file: "copilot-insights-projects",
          count: attributionRows,
          serialize: (format) => serializeAttribution(attribution, format),
        },
        {
          label: vscode.l10n.t("Billing periods — CSV"),
          description: vscode.l10n.t("One row per completed period, {0} periods", periods.length),
          ext: "csv",
          file: "copilot-insights-periods",
          count: periods.length,
          serialize: (format) => serializePeriods(periods, format),
        },
        {
          label: vscode.l10n.t("Raw snapshots — JSON"),
          description: vscode.l10n.t("Recent snapshots only, {0} entries", snapshots.length),
          ext: "json",
          file: "copilot-insights-history",
          count: snapshots.length,
          serialize: (format) => serializeHistory(snapshots, format),
        },
        {
          label: vscode.l10n.t("Raw snapshots — CSV"),
          description: vscode.l10n.t("Recent snapshots only, {0} entries", snapshots.length),
          ext: "csv",
          file: "copilot-insights-history",
          count: snapshots.length,
          serialize: (format) => serializeHistory(snapshots, format),
        },
      ];

      const choice = await vscode.window.showQuickPick(choices, {
        placeHolder: vscode.l10n.t("Choose what to export"),
      });
      if (!choice) {
        return;
      }

      if (choice.count === 0) {
        vscode.window.showInformationMessage(
          vscode.l10n.t("Nothing to export for that selection yet.")
        );
        return;
      }

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(
          vscode.Uri.file(os.homedir()),
          `${choice.file}.${choice.ext}`
        ),
        filters: choice.ext === "json" ? { JSON: ["json"] } : { CSV: ["csv"] },
      });
      if (!uri) {
        return;
      }

      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(choice.serialize(choice.ext), "utf8")
      );
      getLog().info(`Exported ${choice.count} records to ${uri.fsPath}`);
      vscode.window.showInformationMessage(
        vscode.l10n.t("Exported {0} records.", choice.count)
      );
    }
  );

  // Clear the local snapshot history
  const clearHistoryCommand = vscode.commands.registerCommand(
    "vscode-copilot-insights.clearHistory",
    async () => {
      const result = await vscode.window.showWarningMessage(
        vscode.l10n.t("Clear all locally stored Copilot Insights usage history, including daily rollups and archived billing periods? This cannot be undone."),
        { modal: true },
        vscode.l10n.t("Clear")
      );
      if (result === vscode.l10n.t("Clear")) {
        provider.clearSnapshotHistory();
        vscode.window.showInformationMessage(
          vscode.l10n.t("Copilot Insights usage history cleared.")
        );
      }
    }
  );

  // Status bar style picker with live preview
  const chooseStyleCommand = vscode.commands.registerCommand(
    "vscode-copilot-insights.chooseStatusBarStyle",
    () => {
      const config = vscode.workspace.getConfiguration("copilotInsights");
      const original = config.get<string>("statusBarStyle", "detailed-original");

      const styles: { label: string; description: string; value: string }[] = [
        { label: "Detailed (original)", description: "$(pass) Copilot: 20/100 (80%)", value: "detailed-original" },
        { label: "Progress Capsule", description: "◖ 80% ◗", value: "progress-capsule" },
        { label: "Circular Ring", description: "◔ 80%", value: "circular-ring" },
        { label: "Solid Bar", description: "████░ 80%", value: "solid-bar" },
        { label: "Shaded Bar", description: "▓▓▓▓░ 80%", value: "shaded-bar" },
        { label: "Minimalist", description: "80%", value: "minimalist" },
        { label: "Adaptive Emoji", description: "😌 80%", value: "adaptive-emoji" },
      ];

      const quickPick = vscode.window.createQuickPick();
      quickPick.title = vscode.l10n.t("Copilot Insights: Status Bar Style");
      quickPick.placeholder = vscode.l10n.t("Highlight a style to preview it in the status bar");
      quickPick.items = styles.map((s) => ({ label: s.label, description: s.description }));
      quickPick.activeItems = quickPick.items.filter(
        (item) => styles.find((s) => s.label === item.label)?.value === original
      );

      const styleForItem = (item: vscode.QuickPickItem | undefined) =>
        styles.find((s) => s.label === item?.label)?.value;

      quickPick.onDidChangeActive((active) => {
        const style = styleForItem(active[0]);
        if (style) {
          // Live preview: in-memory only, no settings churn; cleared on hide
          statusBar.previewStyle(style);
        }
      });
      quickPick.onDidAccept(() => {
        const style = styleForItem(quickPick.selectedItems[0]);
        if (style) {
          void config.update("statusBarStyle", style, vscode.ConfigurationTarget.Global);
        }
        quickPick.hide();
      });
      quickPick.onDidHide(() => {
        // Clear the in-memory preview: on accept the persisted setting takes
        // over, on cancel this restores the configured style.
        statusBar.previewStyle(undefined);
        quickPick.dispose();
      });
      quickPick.show();
    }
  );

  // Opt-in: fetch and show org-level Copilot metrics (official REST API).
  // Only ever called from this command — never automatically.
  const showOrgMetricsCommand = vscode.commands.registerCommand(
    "vscode-copilot-insights.showOrgMetrics",
    async () => {
      const config = vscode.workspace.getConfiguration("copilotInsights");
      let org = config.get<string>("organization", "").trim();

      if (!org) {
        const input = await vscode.window.showInputBox({
          title: vscode.l10n.t("Copilot Insights: Organization Metrics"),
          prompt: vscode.l10n.t("Enter the GitHub organization slug to fetch Copilot metrics for"),
          placeHolder: vscode.l10n.t("e.g. my-org"),
          ignoreFocusOut: true,
        });
        if (!input || !input.trim()) {
          return;
        }
        org = input.trim();
        await config.update("organization", org, vscode.ConfigurationTarget.Global);
      }

      try {
        const session = await vscode.authentication.getSession(
          "github",
          ["read:org"],
          { createIfNone: true }
        );
        const metrics = await fetchOrgCopilotMetrics(org, session.accessToken);
        const content = buildOrgMetricsMarkdown(org, metrics);
        const document = await vscode.workspace.openTextDocument({
          language: "markdown",
          content,
        });
        await vscode.window.showTextDocument(document, { preview: false });
        getLog().info(`Fetched org Copilot metrics for '${org}' (${metrics.length} days)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        getLog().error(`Failed to fetch org Copilot metrics for '${org}': ${message}`);
        vscode.window.showErrorMessage(
          vscode.l10n.t("Failed to fetch Copilot metrics for '{0}': {1}", org, message)
        );
      }
    }
  );

  // Show the extension's log output channel
  const showLogsCommand = vscode.commands.registerCommand(
    "vscode-copilot-insights.showLogs",
    () => {
      getLog().show();
    }
  );

  context.subscriptions.push(
    refreshCommand,
    openSettingsCommand,
    resetDefaultsCommand,
    exportHistoryCommand,
    clearHistoryCommand,
    chooseStyleCommand,
    showOrgMetricsCommand,
    showLogsCommand
  );
}

// This method is called when your extension is deactivated
export function deactivate() { }
