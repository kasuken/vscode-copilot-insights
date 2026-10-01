import * as vscode from "vscode";

export interface GitHubHostConfig {
  /** The VS Code authentication provider ID ("github" or "github-enterprise"). */
  authProviderId: string;
  /** The API base URL (e.g. "https://api.github.com" or "https://api.tenant.ghe.com"). */
  apiBaseUrl: string;
}

/**
 * Derives API base URL and auth provider from the built-in
 * `github-enterprise.uri` setting (the same one VS Code's GitHub
 * Authentication extension reads).
 *
 * - unset / github.com → api.github.com, provider "github"
 * - *.ghe.com (GHE Cloud with data residency) → api.<host>, provider "github-enterprise"
 * - any other host (GHES on-prem) → <host>/api/v3, provider "github-enterprise"
 */
export function getGitHubHostConfig(): GitHubHostConfig {
  const enterpriseUri = vscode.workspace
    .getConfiguration()
    .get<string>("github-enterprise.uri");

  if (!enterpriseUri) {
    return { authProviderId: "github", apiBaseUrl: "https://api.github.com" };
  }

  let url: URL;
  try {
    url = new URL(enterpriseUri);
  } catch {
    return { authProviderId: "github", apiBaseUrl: "https://api.github.com" };
  }

  const authority = url.host;
  if (!authority || authority === "github.com" || authority === "www.github.com" || authority === "api.github.com") {
    return { authProviderId: "github", apiBaseUrl: "https://api.github.com" };
  }

  const isGheCloud = /\.ghe\.com$/i.test(authority);
  const apiBaseUrl = isGheCloud
    ? `https://api.${authority}`
    : `https://${authority}/api/v3`;

  return { authProviderId: "github-enterprise", apiBaseUrl };
}
