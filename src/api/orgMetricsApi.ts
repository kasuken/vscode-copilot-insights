const FETCH_TIMEOUT_SECONDS = 15;

/**
 * Minimal shape of one day's entry from the official GitHub
 * "Copilot metrics for an organization" REST endpoint.
 * See https://docs.github.com/rest/copilot/copilot-metrics
 */
export interface OrgCopilotMetricsDay {
  date: string;
  total_active_users: number;
  total_engaged_users: number;
  /** Nested feature breakdowns; not needed for the summary view. */
  copilot_ide_code_completions?: unknown;
  copilot_ide_chat?: unknown;
  copilot_dotcom_chat?: unknown;
  copilot_dotcom_pull_requests?: unknown;
}

/**
 * Fetches daily Copilot usage metrics for an organization from the official
 * REST endpoint. Requires a token with the `read:org` scope, a Copilot
 * Business/Enterprise org with the metrics API enabled, and at least
 * 5 active Copilot users in the org.
 */
export async function fetchOrgCopilotMetrics(
  org: string,
  accessToken: string
): Promise<OrgCopilotMetricsDay[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_SECONDS * 1000);

  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/orgs/${encodeURIComponent(org)}/copilot/metrics`,
      {
        headers: {
          Authorization: "Bearer " + accessToken,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "VSCode-Copilot-Insights",
        },
        signal: controller.signal,
      }
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `GitHub API request timed out after ${FETCH_TIMEOUT_SECONDS} seconds`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401) {
    throw new Error(
      "GitHub authentication failed (401). Try signing out of GitHub in VS Code (Accounts menu) and signing back in."
    );
  }

  if (response.status === 403 || response.status === 404) {
    throw new Error(
      `GitHub API returned ${response.status} for org '${org}'. This usually means you lack permission to view Copilot metrics for the org, the Copilot Metrics API access policy is disabled, or the org has fewer than 5 active Copilot users.`
    );
  }

  if (!response.ok) {
    throw new Error(
      `GitHub API returned ${response.status}: ${response.statusText}`
    );
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error("Unexpected response shape from the Copilot metrics API.");
  }

  return payload as OrgCopilotMetricsDay[];
}
