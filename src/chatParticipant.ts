import * as vscode from "vscode";
import { generateMarkdownSummary } from "./core/markdown";
import {
  estimateOverage,
  getTrendPrediction,
  getWeightedPrediction,
} from "./core/predictions";
import {
  calculateDaysUntilReset,
  computeQuotaStats,
  findPremiumQuota,
  getEffectiveQuota,
} from "./core/quota";
import { formatDate } from "./core/format";
import { CopilotUserData } from "./types";
import { CopilotInsightsViewProvider } from "./ui/webview/provider";

const PARTICIPANT_ID = "copilotInsights.insights";

function getCustomLimit(): number {
  return vscode.workspace
    .getConfiguration("copilotInsights")
    .get<number>("customCreditLimit", 0);
}

function streamNoData(stream: vscode.ChatResponseStream): void {
  stream.markdown(
    vscode.l10n.t(
      "Copilot quota data is unavailable. You may need to sign in to GitHub in VS Code — open the Copilot Insights view to sign in, then try again."
    )
  );
}

function streamQuota(data: CopilotUserData, stream: vscode.ChatResponseStream): void {
  const premiumQuota = findPremiumQuota(data.quota_snapshots);
  if (!premiumQuota) {
    stream.markdown(generateMarkdownSummary(data, getCustomLimit(), vscode.env.language));
    return;
  }

  stream.markdown(`## ${vscode.l10n.t("Copilot Quota Status")}\n\n`);
  stream.markdown(`- ${vscode.l10n.t("**Plan:** {0}", data.copilot_plan || vscode.l10n.t("Unknown"))}\n`);

  if (premiumQuota.unlimited) {
    stream.markdown(`- ${vscode.l10n.t("**AI Credits:** Unlimited ∞")}\n`);
    return;
  }

  const effectiveQ = getEffectiveQuota(premiumQuota, getCustomLimit());
  const stats = computeQuotaStats(effectiveQ);

  stream.markdown(`- ${vscode.l10n.t("**Used:** {0} of {1}", stats.used, effectiveQ.entitlement)}\n`);
  if (stats.isOverQuota) {
    stream.markdown(`- ${vscode.l10n.t("**Over quota by:** {0} credits", stats.overageAmount)}\n`);
  } else {
    stream.markdown(`- ${vscode.l10n.t("**Remaining:** {0} ({1}%)", effectiveQ.remaining, stats.percentRemaining)}\n`);
  }
  stream.markdown(`- ${vscode.l10n.t("**Reset date:** {0}", formatDate(data.quota_reset_date_utc, vscode.env.language))}\n`);
}

function streamPacing(
  data: CopilotUserData,
  provider: CopilotInsightsViewProvider,
  stream: vscode.ChatResponseStream
): void {
  const history = provider.snapshotHistory;
  const trend = getTrendPrediction(history);
  const prediction = getWeightedPrediction(history, data, getCustomLimit());

  stream.markdown(`## ${vscode.l10n.t("Pacing Analysis")}\n\n`);

  if (!prediction && !trend) {
    stream.markdown(
      vscode.l10n.t(
        "Not enough local snapshot history yet to analyze pacing. History accumulates automatically as quota data is refreshed — check back after a day or two of usage."
      )
    );
    return;
  }

  if (trend) {
    stream.markdown(`- ${vscode.l10n.t("**Recent burn rate:** ~{0} credits/day", trend.recentBurnRate)}\n`);
    stream.markdown(`- ${vscode.l10n.t("**Overall burn rate:** ~{0} credits/day", trend.overallBurnRate)}\n`);
    stream.markdown(`- ${vscode.l10n.t("**Trend:** {0} ({1})", trend.trend, trend.trendIndicator)}\n`);
  }

  if (prediction) {
    stream.markdown(`- ${vscode.l10n.t("**Predicted daily usage:** ~{0} credits/day ({1} confidence)", prediction.predictedDailyUsage, prediction.confidence)}\n`);

    const timeUntilReset = calculateDaysUntilReset(
      data.quota_reset_date_utc,
      new Date().toISOString()
    );
    if (prediction.willExhaustBeforeReset && prediction.daysUntilExhaustion !== null) {
      stream.markdown(
        `\n⚠️ ${vscode.l10n.t(
          "At this pace you are on track to exhaust your AI credits in about {0} day(s) — before your quota resets in {1} day(s).",
          prediction.daysUntilExhaustion,
          Math.max(0, timeUntilReset.days)
        )}\n`
      );
    } else {
      stream.markdown(
        `\n✅ ${vscode.l10n.t(
          "At this pace your AI credits should last until the reset on {0}.",
          formatDate(data.quota_reset_date_utc, vscode.env.language)
        )}\n`
      );
    }
    stream.markdown(`\n_${prediction.confidenceReason}_\n`);
  }
}

function streamForecast(
  data: CopilotUserData,
  provider: CopilotInsightsViewProvider,
  stream: vscode.ChatResponseStream
): void {
  const history = provider.snapshotHistory;
  const prediction = getWeightedPrediction(history, data, getCustomLimit());
  const premiumQuota = findPremiumQuota(data.quota_snapshots);

  stream.markdown(`## ${vscode.l10n.t("Usage Forecast")}\n\n`);

  if (!premiumQuota || premiumQuota.unlimited) {
    stream.markdown(vscode.l10n.t("Your AI credit quota is unlimited — nothing to forecast. 🎉"));
    return;
  }

  if (!prediction) {
    stream.markdown(
      vscode.l10n.t(
        "Not enough local snapshot history yet to build a forecast. History accumulates automatically as quota data is refreshed — check back after a day or two of usage."
      )
    );
    return;
  }

  stream.markdown(`- ${vscode.l10n.t("**Predicted daily usage:** ~{0} credits/day ({1} confidence)", prediction.predictedDailyUsage, prediction.confidence)}\n`);

  if (prediction.daysUntilExhaustion !== null) {
    if (prediction.willExhaustBeforeReset) {
      stream.markdown(`- ${vscode.l10n.t("**Days until exhaustion:** ~{0} — before the reset on {1}", prediction.daysUntilExhaustion, formatDate(data.quota_reset_date_utc, vscode.env.language))}\n`);
    } else {
      stream.markdown(`- ${vscode.l10n.t("**Days until exhaustion:** ~{0} — after the reset on {1}, so you should be fine", prediction.daysUntilExhaustion, formatDate(data.quota_reset_date_utc, vscode.env.language))}\n`);
    }
  }

  const overage = estimateOverage(
    premiumQuota,
    prediction.predictedDailyUsage,
    data.quota_reset_date_utc
  );
  if (overage) {
    if (overage.currentOverageCredits > 0) {
      stream.markdown(`- ${vscode.l10n.t("**Current overage:** {0} credits (~${1})", overage.currentOverageCredits, overage.currentOverageCostUsd)}\n`);
    }
    if (overage.projectedOverageCredits !== null && overage.projectedOverageCostUsd !== null) {
      stream.markdown(`- ${vscode.l10n.t("**Projected overage by reset:** {0} credits (~${1})", overage.projectedOverageCredits, overage.projectedOverageCostUsd)}\n`);
    }
  } else if (!prediction.willExhaustBeforeReset) {
    stream.markdown(`\n${vscode.l10n.t("No overage is projected for this billing period.")}\n`);
  }
}

/**
 * Registers the `@insights` chat participant. Responses are built
 * deterministically from the live quota data and local snapshot history —
 * no language model call is needed.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  provider: CopilotInsightsViewProvider
): void {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    _chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken
  ): Promise<vscode.ChatResult> => {
    const data = await provider.getOrFetchData();
    if (!data) {
      streamNoData(stream);
      return {};
    }

    switch (request.command) {
      case "pacing":
        streamPacing(data, provider, stream);
        break;
      case "forecast":
        streamForecast(data, provider, stream);
        break;
      case "quota":
        streamQuota(data, stream);
        break;
      default:
        stream.markdown(generateMarkdownSummary(data, getCustomLimit(), vscode.env.language));
        break;
    }
    return {};
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "img", "logo.png");
  context.subscriptions.push(participant);
}
