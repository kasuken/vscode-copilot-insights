import * as vscode from "vscode";
import { CopilotUserData, QuotaSnapshot, StatusBadge } from "../types";
import { formatQuotaValue } from "../core/format";
import {
  calculateDaysUntilReset,
  computeQuotaStats,
  findPremiumQuota,
  getEffectiveQuota,
  getStatusBadge,
} from "../core/quota";

export interface StatusBarTextOptions {
  style: string;
  progressBarMode: string;
  showName: boolean;
  showNumericalQuota: boolean;
  showVisualIndicator: boolean;
}

/**
 * Formats the status bar text for the given quota state and style.
 * Pure function — all configuration is passed via `options`.
 */
export function formatStatusBarText(
  percentRemaining: number,
  percentUsed: number,
  premiumQuota: QuotaSnapshot,
  statusBadge: StatusBadge,
  options: StatusBarTextOptions
): string {
  const { progressBarMode, showName, showNumericalQuota, showVisualIndicator } = options;

  const isOverQuota = premiumQuota.remaining < 0;
  const overageAmount = isOverQuota ? parseFloat(Math.abs(premiumQuota.remaining).toFixed(1)) : 0;
  const used = premiumQuota.entitlement - premiumQuota.quota_remaining;

  // Clamp displayPercent for visual components (0-100 range)
  const rawDisplayPercent = progressBarMode === "used" ? percentUsed : percentRemaining;
  const displayPercent = Math.max(0, Math.min(100, rawDisplayPercent));

  // For text display, show the overage when over quota
  const displayPercentText = isOverQuota ? `+${overageAmount}` : `${rawDisplayPercent}%`;

  // Build the base text components based on toggles
  const namePart = showName ? "Copilot: " : "";
  const quotaPart = showNumericalQuota
    ? (isOverQuota
      ? `+${overageAmount}/${premiumQuota.entitlement}`
      : (progressBarMode === "used"
        ? `${formatQuotaValue(used)}/${premiumQuota.entitlement}`
        : `${formatQuotaValue(premiumQuota.quota_remaining)}/${premiumQuota.entitlement}`))
    : "";

  // If visual indicator is disabled, return only name + quota (no style-specific formatting or percentage)
  if (!showVisualIndicator) {
    // If we have name or quota, show them
    if (showName || showNumericalQuota) {
      return `${statusBadge.icon} ${namePart}${quotaPart}`.trim();
    }
    // If nothing to show, return just the icon
    return statusBadge.icon;
  }

  // Normalize legacy style names for backward compatibility
  let activeStyle = options.style;
  switch (options.style) {
    case "textual": activeStyle = "detailed-original"; break;
    case "blocks": activeStyle = "solid-bar"; break;
    case "graphical": activeStyle = "shaded-bar"; break;
    case "compact": activeStyle = "minimalist"; break;
    case "emoji": activeStyle = "adaptive-emoji"; break;
    case "ring": activeStyle = "circular-ring"; break;
  }

  const quotaWithSpace = quotaPart ? `${quotaPart} ` : "";

  switch (activeStyle) {
    case "solid-bar": {
      const totalBlocks = 5;
      const filledBlocks = Math.ceil((displayPercent / 100) * totalBlocks);

      let progressBar = "";
      for (let i = 0; i < totalBlocks; i++) {
        progressBar += i < filledBlocks ? "█" : "░";
      }

      return `${statusBadge.icon} ${namePart}${quotaWithSpace}${progressBar} ${displayPercentText}`;
    }

    case "shaded-bar": {
      const graphicBlocks = 5;
      const graphicFilledBlocks = Math.ceil((displayPercent / 100) * graphicBlocks);

      let graphicBar = "";
      for (let i = 0; i < graphicBlocks; i++) {
        graphicBar += i < graphicFilledBlocks ? "▓" : "░";
      }

      return `${statusBadge.icon} ${namePart}${quotaWithSpace}${graphicBar} ${displayPercentText}`;
    }

    case "adaptive-emoji": {
      let moodEmoji = "😌";
      if (isOverQuota) { moodEmoji = "💀"; }
      else if (percentUsed >= 90) { moodEmoji = "😱"; }
      else if (percentUsed >= 75) { moodEmoji = "😬"; }
      else if (percentUsed >= 50) { moodEmoji = "🙂"; }

      return `${statusBadge.icon} ${namePart}${quotaWithSpace}${moodEmoji} ${displayPercentText}`;
    }

    case "minimalist":
      return `${statusBadge.icon} ${namePart}${quotaWithSpace}${displayPercentText}`;

    case "circular-ring": {
      // Use "Large" variants: ◯, ◔, ◑, ◕, ⬤
      const ringChars = ["◯", "◔", "◑", "◕", "⬤"];
      const ringIdx = Math.min(Math.floor((displayPercent / 100) * 4.9), 4);
      const ringChar = ringChars[ringIdx];
      return `${statusBadge.icon} ${namePart}${quotaWithSpace}${ringChar} ${displayPercentText}`;
    }

    case "progress-capsule":
      return `${statusBadge.icon} ${namePart}${quotaWithSpace}◖ ${displayPercentText} ◗`;

    case "detailed-original":
    default: {
      // Build detailed text: name + quota + percentage
      const percentPart = `(${displayPercentText})`;
      if (showName || showNumericalQuota) {
        return `${statusBadge.icon} ${namePart}${quotaWithSpace}${percentPart}`;
      }
      // Fallback to just percentage if both are disabled
      return `${statusBadge.icon} ${percentPart}`;
    }
  }
}

/**
 * Owns the left/right status bar items: text, tooltips, background color,
 * visibility, and the usage alert threshold display states.
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly _rightItem: vscode.StatusBarItem;
  private readonly _leftItem: vscode.StatusBarItem;

  constructor() {
    this._rightItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this._rightItem.command = "copilotInsights.sidebarView.focus";
    this._rightItem.text = "$(loading~spin) Copilot";
    this._rightItem.tooltip = vscode.l10n.t("Loading Copilot insights...");

    this._leftItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      -100 // Lower priority to position it appropriately on the left
    );
    this._leftItem.command = "copilotInsights.sidebarView.focus";
    this._leftItem.text = "$(loading~spin) Copilot";
    this._leftItem.tooltip = vscode.l10n.t("Loading Copilot insights...");

    this.updateVisibility();
  }

  get items(): vscode.StatusBarItem[] {
    return [this._rightItem, this._leftItem];
  }

  dispose() {
    this._rightItem.dispose();
    this._leftItem.dispose();
  }

  updateVisibility() {
    const location = vscode.workspace
      .getConfiguration("copilotInsights")
      .get<string>("statusBarLocation", "right");

    switch (location) {
      case "left":
        this._rightItem.hide();
        this._leftItem.show();
        break;
      case "both":
        this._rightItem.show();
        this._leftItem.show();
        break;
      case "right":
      default:
        this._rightItem.show();
        this._leftItem.hide();
        break;
    }
  }

  showSignIn() {
    this.updateVisibility();

    const signInText = `$(account) ${vscode.l10n.t("Copilot: Sign in")}`;
    const signInTooltip = vscode.l10n.t(
      "Sign in to GitHub to see Copilot insights — click to open the view"
    );
    for (const item of this.items) {
      item.text = signInText;
      item.tooltip = signInTooltip;
      item.backgroundColor = undefined;
    }
  }

  showError(error: string) {
    this.updateVisibility();

    for (const item of this.items) {
      item.text = "$(error) Copilot";
      item.tooltip = vscode.l10n.t("Error: {0}", error);
      item.backgroundColor = undefined;
    }
  }

  update(data: CopilotUserData) {
    this.updateVisibility();

    const config = vscode.workspace.getConfiguration("copilotInsights");
    const premiumQuota = findPremiumQuota(data.quota_snapshots);

    if (premiumQuota && !premiumQuota.unlimited) {
      const customLimit = config.get<number>("customCreditLimit", 0);
      const enableColoring = config.get<boolean>("statusBar.enableColoredBackground", true);
      const eq = getEffectiveQuota(premiumQuota, customLimit);
      const { used, isOverQuota, percentRemaining, percentUsed, overageAmount } = computeQuotaStats(eq);
      const statusBadge = getStatusBadge(percentRemaining, enableColoring);
      const hasCustomLimit = eq.entitlement > premiumQuota.entitlement;
      const t = vscode.l10n.t;
      const customLimitNote = hasCustomLimit
        ? `\n• ${t("Custom limit: **{0}** (plan: {1})", eq.entitlement, premiumQuota.entitlement)}`
        : '';

      const textOptions: StatusBarTextOptions = {
        style: config.get<string>("statusBarStyle", "detailed-original"),
        progressBarMode: config.get<string>("progressBarMode", "remaining"),
        showName: config.get<boolean>("statusBar.showName", true),
        showNumericalQuota: config.get<boolean>("statusBar.showNumericalQuota", true),
        showVisualIndicator: config.get<boolean>("statusBar.showVisualIndicator", true),
      };

      // If all toggles are disabled, hide the status bar
      if (!textOptions.showName && !textOptions.showNumericalQuota && !textOptions.showVisualIndicator) {
        this._rightItem.hide();
        this._leftItem.hide();
        return;
      }

      const text = formatStatusBarText(percentRemaining, percentUsed, eq, statusBadge, textOptions);

      // Calculate days until reset
      const quotaSnapshotsArray = data.quota_snapshots ? Object.values(data.quota_snapshots) : [];
      const latestSnapshot = quotaSnapshotsArray[0];
      const asOfTime = latestSnapshot?.timestamp_utc || new Date().toISOString();
      const timeUntilReset = calculateDaysUntilReset(data.quota_reset_date_utc, asOfTime);

      const backgroundColor = this._getBackgroundColor(percentRemaining, enableColoring);

      this._rightItem.text = text;
      this._rightItem.backgroundColor = backgroundColor;
      this._rightItem.tooltip = new vscode.MarkdownString(
        `**${t("GitHub Copilot AI Credits")}**\n\n` +
        `• ${t("Status: **{0}** {1}", t(statusBadge.label), statusBadge.emoji)}\n` +
        (isOverQuota
          ? `• ${t("Over by: **{0}** ({1} of {2} used)", overageAmount, used, eq.entitlement)}\n`
          : `• ${t("Remaining: **{0}** of **{1}** ({2}%)", eq.remaining, eq.entitlement, percentRemaining)}\n`) +
        `• ${t("Reset in: **{0}d {1}h**", timeUntilReset.days, timeUntilReset.hours)}\n` +
        `• ${t("Plan: **{0}**", data.copilot_plan)}` +
        customLimitNote + `\n\n` +
        `_${t("Click to view full details")}_`
      );

      this._leftItem.text = text;
      this._leftItem.backgroundColor = backgroundColor;
      this._leftItem.tooltip = new vscode.MarkdownString(
        `**${t("GitHub Copilot Usage")}**\n\n` +
        `• ${t("Used: **{0}** of **{1}** ({2}%)", used, eq.entitlement, percentUsed)}\n` +
        (isOverQuota
          ? `• ${t("Over by: **{0}**", overageAmount)}\n`
          : `• ${t("Remaining: **{0}** ({1}%)", eq.remaining, percentRemaining)}\n`) +
        `• ${t("Status: **{0}** {1}", t(statusBadge.label), statusBadge.emoji)}` +
        customLimitNote + `\n\n` +
        `_${t("Click to view full details")}_`
      );
    } else {
      // For unlimited plans
      const t = vscode.l10n.t;
      const unlimitedTooltip = new vscode.MarkdownString(
        `**GitHub Copilot**\n\n` +
        `• ${t("Plan: **{0}**", data.copilot_plan)}\n` +
        `• ${t("AI Credits: **Unlimited**")}\n\n` +
        `_${t("Click to view full details")}_`
      );

      for (const item of this.items) {
        item.text = "$(check) Copilot";
        item.tooltip = unlimitedTooltip;
        item.backgroundColor = undefined;
      }
    }
  }

  /**
   * Returns the status bar background color for the current quota level:
   * red when over quota, yellow when remaining drops below 20% (Risk tier).
   */
  private _getBackgroundColor(
    percentRemaining: number,
    enableColoring: boolean
  ): vscode.ThemeColor | undefined {
    if (!enableColoring) {
      return undefined;
    }

    if (percentRemaining <= 0) {
      return new vscode.ThemeColor("statusBarItem.errorBackground");
    }
    if (percentRemaining < 20) {
      return new vscode.ThemeColor("statusBarItem.warningBackground");
    }
    return undefined;
  }
}
