import { CopilotUserData } from "../types";

const COPILOT_USER_ENDPOINT = "https://api.github.com/copilot_internal/user";

function normalizeCopilotPlan(plan: unknown): string {
  const value = typeof plan === "string" ? plan.trim() : "";
  if (!value) {
    return "";
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Fetches and normalizes the Copilot account/quota data for the
 * authenticated user from GitHub's (internal, undocumented) endpoint.
 */
export async function fetchCopilotUserData(accessToken: string): Promise<CopilotUserData> {
  const response = await fetch(COPILOT_USER_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "VSCode-Copilot-Insights",
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `GitHub authentication failed (${response.status}). Try signing out of GitHub in VS Code (Accounts menu) and signing back in.`
    );
  }

  if (!response.ok) {
    throw new Error(
      `GitHub API returned ${response.status}: ${response.statusText}`
    );
  }

  const apiData = (await response.json()) as Partial<CopilotUserData>;
  return {
    ...apiData,
    login: apiData.login ?? "",
    copilot_plan: normalizeCopilotPlan(apiData.copilot_plan),
    chat_enabled: Boolean(apiData.chat_enabled),
    cli_enabled: Boolean(apiData.cli_enabled),
    is_mcp_enabled: Boolean(apiData.is_mcp_enabled),
    editor_preview_features_enabled: Boolean(apiData.editor_preview_features_enabled),
    copilotignore_enabled: Boolean(apiData.copilotignore_enabled),
    restricted_telemetry: Boolean(apiData.restricted_telemetry),
    access_type_sku: apiData.access_type_sku ?? "",
    assigned_date: apiData.assigned_date ?? "",
    organization_list: apiData.organization_list ?? [],
    quota_snapshots: apiData.quota_snapshots ?? {},
    quota_reset_date_utc: apiData.quota_reset_date_utc ?? "",
    quota_reset_date: apiData.quota_reset_date ?? "",
    token_based_billing: Boolean(apiData.token_based_billing),
    analytics_tracking_id: apiData.analytics_tracking_id,
  };
}
