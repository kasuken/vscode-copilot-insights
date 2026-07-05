import * as os from "node:os";
import * as vscode from "vscode";
import { StatusBarManager } from "./ui/statusBar";
import { CopilotInsightsViewProvider } from "./ui/webview/provider";
import { CopilotQuotaTool } from "./lmTool";
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
        ];
        for (const setting of settings) {
          await config.update(setting, undefined, vscode.ConfigurationTarget.Global);
        }

        vscode.window.showInformationMessage(
          vscode.l10n.t("Copilot Insights settings reset to defaults.")
        );
        // Refresh the display
        provider.loadCopilotData();
      }
    }
  );

  // Export the local snapshot history as JSON or CSV
  const exportHistoryCommand = vscode.commands.registerCommand(
    "vscode-copilot-insights.exportHistory",
    async () => {
      const history = provider.snapshotHistory;
      if (history.length === 0) {
        vscode.window.showInformationMessage(
          vscode.l10n.t("No local snapshot history to export yet. History accumulates as quota data is refreshed.")
        );
        return;
      }

      const format = await vscode.window.showQuickPick(
        [
          { label: "JSON", description: vscode.l10n.t("Full snapshot objects"), ext: "json" },
          { label: "CSV", description: vscode.l10n.t("timestamp, remaining, entitlement"), ext: "csv" },
        ],
        { placeHolder: vscode.l10n.t("Choose an export format") }
      );
      if (!format) {
        return;
      }

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(
          vscode.Uri.file(os.homedir()),
          `copilot-insights-history.${format.ext}`
        ),
        filters: format.ext === "json" ? { JSON: ["json"] } : { CSV: ["csv"] },
      });
      if (!uri) {
        return;
      }

      const content = format.ext === "json"
        ? JSON.stringify(history, null, 2)
        : [
          "timestamp,premium_remaining,premium_entitlement",
          ...history.map((s) => `${s.timestamp},${s.premium_remaining},${s.premium_entitlement}`),
        ].join("\n");

      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      getLog().info(`Exported ${history.length} snapshots to ${uri.fsPath}`);
      vscode.window.showInformationMessage(
        vscode.l10n.t("Exported {0} snapshots.", history.length)
      );
    }
  );

  // Clear the local snapshot history
  const clearHistoryCommand = vscode.commands.registerCommand(
    "vscode-copilot-insights.clearHistory",
    async () => {
      const result = await vscode.window.showWarningMessage(
        vscode.l10n.t("Clear all locally stored Copilot Insights snapshot history? This cannot be undone."),
        { modal: true },
        vscode.l10n.t("Clear")
      );
      if (result === vscode.l10n.t("Clear")) {
        provider.clearSnapshotHistory();
        vscode.window.showInformationMessage(
          vscode.l10n.t("Copilot Insights snapshot history cleared.")
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

      let accepted = false;
      quickPick.onDidChangeActive((active) => {
        const style = styleForItem(active[0]);
        if (style) {
          // Live preview: apply immediately; reverted on cancel
          void config.update("statusBarStyle", style, vscode.ConfigurationTarget.Global);
        }
      });
      quickPick.onDidAccept(() => {
        accepted = true;
        const style = styleForItem(quickPick.selectedItems[0]);
        if (style) {
          void config.update("statusBarStyle", style, vscode.ConfigurationTarget.Global);
        }
        quickPick.hide();
      });
      quickPick.onDidHide(() => {
        if (!accepted) {
          void config.update("statusBarStyle", original, vscode.ConfigurationTarget.Global);
        }
        quickPick.dispose();
      });
      quickPick.show();
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
    showLogsCommand
  );
}

// This method is called when your extension is deactivated
export function deactivate() { }
