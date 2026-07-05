import { CopilotUserData, CREDIT_COST_USD } from "../types";
import { formatDate, formatQuotaName } from "./format";
import {
  calculateDaysUntilReset,
  computeQuotaStats,
  getEffectiveQuota,
  getStatusBadge,
} from "./quota";

export function generateMarkdownSummary(
  data: CopilotUserData,
  customLimit: number,
  locale?: string
): string {
  const quotaSnapshotsArray = data.quota_snapshots
    ? Object.values(data.quota_snapshots)
    : [];

  const latestSnapshot =
    quotaSnapshotsArray.length > 0 ? quotaSnapshotsArray[0] : null;
  const asOfTime = latestSnapshot?.timestamp_utc || new Date().toISOString();
  const timeUntilReset = calculateDaysUntilReset(
    data.quota_reset_date_utc,
    asOfTime
  );

  let markdown = `# GitHub Copilot Insights\n\n`;
  markdown += `**Generated:** ${new Date().toLocaleString()}\n\n`;

  // Plan Details
  markdown += `## Plan Details\n\n`;
  markdown += `- **Plan:** ${data.copilot_plan || "Unknown"}\n`;
  markdown += `- **Chat:** ${data.chat_enabled ? "Enabled" : "Disabled"}\n`;
  markdown += `- **CLI:** ${data.cli_enabled ? "Enabled" : "Disabled"}\n`;
  markdown += `- **MCP:** ${data.is_mcp_enabled ? "Enabled" : "Disabled"}\n`;
  markdown += `- **Preview Features:** ${data.editor_preview_features_enabled ? "Enabled" : "Disabled"}\n`;
  markdown += `- **Access/SKU:** ${data.access_type_sku || "Unknown"}\n`;
  markdown += `- **Assigned:** ${formatDate(data.assigned_date, locale)}\n\n`;

  // Quotas
  if (quotaSnapshotsArray.length > 0) {
    markdown += `## Quotas\n\n`;
    quotaSnapshotsArray.forEach((quota) => {
      const quotaName = formatQuotaName(quota.quota_id);

      markdown += `### ${quotaName}\n\n`;

      if (quota.unlimited) {
        markdown += `- **Status:** Unlimited ∞\n\n`;
      } else {
        // Apply custom AI credit limit if configured (only for premium_interactions)
        const effectiveQ = quota.quota_id === "premium_interactions"
          ? getEffectiveQuota(quota, customLimit)
          : quota;
        const { used, isOverQuota, percentRemaining, overageAmount } = computeQuotaStats(effectiveQ);
        const statusBadge = getStatusBadge(percentRemaining, true);

        if (isOverQuota) {
          markdown += `- **Status:** ${statusBadge.emoji} ${statusBadge.label} (exceeded by ${overageAmount})\n`;
          markdown += `- **Over by:** ${overageAmount}\n`;
        } else {
          markdown += `- **Status:** ${statusBadge.emoji} ${statusBadge.label} (${percentRemaining}% remaining)\n`;
          markdown += `- **Remaining:** ${effectiveQ.remaining}\n`;
        }
        markdown += `- **Used:** ${used}\n`;
        markdown += `- **Total:** ${effectiveQ.entitlement}\n`;

        if (timeUntilReset.totalDays > 0) {
          if (!isOverQuota) {
            const allowedPerDay = Math.floor(
              effectiveQ.remaining / timeUntilReset.totalDays
            );
            markdown += `- **To last until reset:** ≤ ${allowedPerDay}/day\n`;
          }
          markdown += `- **Reset in:** ${timeUntilReset.days}d ${timeUntilReset.hours}h\n`;
          markdown += `- **Reset Date:** ${formatDate(
            data.quota_reset_date_utc,
            locale
          )}\n`;
        }

        if (quota.overage_permitted) {
          markdown += `- **Overage:** Permitted`;
          if (isOverQuota) {
            const billableOverage = Math.max(0, used - quota.entitlement);
            markdown += ` (${billableOverage} billable, est. cost: $${(billableOverage * CREDIT_COST_USD).toFixed(2)})`;
          } else if (quota.overage_count > 0) {
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
