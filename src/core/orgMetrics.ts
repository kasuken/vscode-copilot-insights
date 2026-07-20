import { OrgCopilotMetricsDay } from "../api/orgMetricsApi";

/** Maximum number of trailing days rendered in the org metrics document. */
export const ORG_METRICS_MAX_DAYS = 28;

/**
 * Builds a read-only Markdown report for an organization's daily Copilot
 * metrics: a header with the org name and caveats, plus a table of the last
 * {@link ORG_METRICS_MAX_DAYS} days (date, active users, engaged users).
 * Pure function so it can be unit tested.
 */
export function buildOrgMetricsMarkdown(
  org: string,
  metrics: readonly OrgCopilotMetricsDay[]
): string {
  let markdown = `# Copilot Metrics — ${org}\n\n`;
  markdown += `Daily active and engaged Copilot users for the **${org}** organization, `;
  markdown += `from the official GitHub Copilot metrics API.\n\n`;
  markdown += `> Note: metrics are aggregated by GitHub and may lag by up to 24 hours. `;
  markdown += `Orgs with fewer than 5 active Copilot users, or with the metrics API access policy disabled, return no data.\n\n`;

  if (metrics.length === 0) {
    markdown += `_No metrics data available for this organization._\n`;
    return markdown;
  }

  // Sort ascending by date and keep only the most recent days.
  const sorted = [...metrics].sort((a, b) => a.date.localeCompare(b.date));
  const recent = sorted.slice(-ORG_METRICS_MAX_DAYS);

  markdown += `| Date | Active users | Engaged users |\n`;
  markdown += `| --- | ---: | ---: |\n`;
  for (const day of recent) {
    markdown += `| ${day.date} | ${day.total_active_users} | ${day.total_engaged_users} |\n`;
  }

  markdown += `\n_Showing ${recent.length} day${recent.length === 1 ? "" : "s"} of data._\n`;
  return markdown;
}
