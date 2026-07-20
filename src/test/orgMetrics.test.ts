import * as assert from "assert";
import { OrgCopilotMetricsDay } from "../api/orgMetricsApi";
import { buildOrgMetricsMarkdown, ORG_METRICS_MAX_DAYS } from "../core/orgMetrics";

function makeDay(overrides: Partial<OrgCopilotMetricsDay> = {}): OrgCopilotMetricsDay {
  return {
    date: "2026-07-01",
    total_active_users: 42,
    total_engaged_users: 30,
    ...overrides,
  };
}

suite("buildOrgMetricsMarkdown", () => {
  test("includes the org name in the header", () => {
    const md = buildOrgMetricsMarkdown("acme-corp", [makeDay()]);
    assert.ok(md.startsWith("# Copilot Metrics — acme-corp"));
    assert.ok(md.includes("**acme-corp**"));
  });

  test("shows a placeholder when there is no data", () => {
    const md = buildOrgMetricsMarkdown("acme-corp", []);
    assert.ok(md.includes("No metrics data available"));
    assert.ok(!md.includes("| Date |"));
  });

  test("renders a table row per day with active and engaged users", () => {
    const md = buildOrgMetricsMarkdown("acme-corp", [
      makeDay({ date: "2026-07-01", total_active_users: 10, total_engaged_users: 7 }),
      makeDay({ date: "2026-07-02", total_active_users: 12, total_engaged_users: 9 }),
    ]);
    assert.ok(md.includes("| Date | Active users | Engaged users |"));
    assert.ok(md.includes("| 2026-07-01 | 10 | 7 |"));
    assert.ok(md.includes("| 2026-07-02 | 12 | 9 |"));
    assert.ok(md.includes("Showing 2 days of data."));
  });

  test("sorts rows ascending by date", () => {
    const md = buildOrgMetricsMarkdown("acme-corp", [
      makeDay({ date: "2026-07-03" }),
      makeDay({ date: "2026-07-01" }),
      makeDay({ date: "2026-07-02" }),
    ]);
    const first = md.indexOf("| 2026-07-01 |");
    const second = md.indexOf("| 2026-07-02 |");
    const third = md.indexOf("| 2026-07-03 |");
    assert.ok(first !== -1 && first < second && second < third);
  });

  test("keeps only the most recent days beyond the limit", () => {
    const days: OrgCopilotMetricsDay[] = [];
    for (let i = 1; i <= ORG_METRICS_MAX_DAYS + 5; i++) {
      const day = String(i).padStart(2, "0");
      days.push(makeDay({ date: `2026-06-${day}` }));
    }
    const md = buildOrgMetricsMarkdown("acme-corp", days);
    assert.ok(!md.includes("| 2026-06-05 |"));
    assert.ok(md.includes("| 2026-06-06 |"));
    assert.ok(md.includes(`| 2026-06-${ORG_METRICS_MAX_DAYS + 5} |`));
    assert.ok(md.includes(`Showing ${ORG_METRICS_MAX_DAYS} days of data.`));
  });

  test("uses singular wording for a single day", () => {
    const md = buildOrgMetricsMarkdown("acme-corp", [makeDay()]);
    assert.ok(md.includes("Showing 1 day of data."));
  });
});
