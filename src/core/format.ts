/** Escapes a value for safe interpolation into webview HTML. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Generates a random nonce for the webview Content-Security-Policy. */
export function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

/**
 * Returns a user-facing display name for a quota.
 * The `premium_interactions` quota now represents AI Credits under GitHub's
 * token-based billing model.
 */
export function formatQuotaName(quotaId: string): string {
  if (quotaId === "premium_interactions") {
    return "AI Credits";
  }
  if (quotaId === "completions") {
    return "Suggestions";
  }
  return quotaId
    .replace(/_/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

export function formatDate(dateStr: string, locale?: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString(locale || "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function calculateTimeSince(timestamp: string, locale?: string): string {
  const now = new Date().getTime();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  let formatter: Intl.RelativeTimeFormat;
  try {
    formatter = new Intl.RelativeTimeFormat(locale || "en", { numeric: "auto" });
  } catch {
    formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  }

  if (diffDays > 0) {
    return formatter.format(-diffDays, "day");
  } else if (diffHours > 0) {
    return formatter.format(-diffHours, "hour");
  } else if (diffMinutes > 0) {
    return formatter.format(-diffMinutes, "minute");
  }
  return formatter.format(0, "second");
}

/** Formats a quota number for display, trimming to at most 2 decimal places. */
export function formatQuotaValue(n: number): string {
  return String(parseFloat(n.toFixed(2)));
}
