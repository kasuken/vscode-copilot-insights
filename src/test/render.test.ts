import * as assert from "assert";
import { buildViewModel, HistoryContext, RenderConfig, renderShellHtml } from "../ui/webview/render";
import * as vscode from "vscode";
import {
  AttributionState,
  CopilotUserData,
  DailyRollup,
  LocalSnapshot,
  PeriodSummary,
} from "../types";
import { makeQuota } from "./quota.test";

suite("Observation, confidence and budget rendering", () => {
  test("escapes workspace and branch labels and distinguishes gap observations", () => {
    const now = Date.now();
    const history: HistoryContext = {
      rollups: [], periods: [], timelineEnabled: true,
      observations: {
        intervals: [
          { start: now - 120000, end: now - 60000, credits: 10, gap: false, project: "<img src=x onerror=alert(1)>", branch: "\"<script>bad</script>" },
          { start: now - 60000, end: now, credits: 20, gap: true },
        ], gaps: 1, firstObserved: now - 120000, lastChange: now,
      },
      lastSuccessfulFetch: now,
    };
    const model = buildViewModel(makeUserData(), [], makeConfig(), history);
    assert.ok(model.sections.timeline.includes("&lt;img"));
    assert.ok(model.sections.timeline.includes("&lt;script&gt;"));
    assert.ok(!model.sections.timeline.includes("<img"));
    assert.ok(model.sections.timeline.includes('title="Estimated branch: &quot;&lt;script&gt;bad&lt;/script&gt;"'));
    assert.ok(model.sections.timeline.includes('title="Estimated project: &lt;img src=x onerror=alert(1)&gt;"'));
    assert.ok(model.sections.timeline.includes("Unattributed"));
    assert.ok(model.sections.timeline.includes("not a real-time spike"));
    assert.ok(model.sections.confidence.includes("10.00 of 30.00 (33.3%)"));
    assert.ok(model.sections.confidence.includes("partial"));
    assert.ok(model.sections.confidence.includes("does not mean real-time"));
  });

  test("cached rerenders preserve fetch and balance-change timestamps and failed-refresh confidence", () => {
    const fetch = Date.now() - 600000;
    const history: HistoryContext = {
      rollups: [], periods: [], timelineEnabled: true, lastSuccessfulFetch: fetch,
      refreshFailed: true,
      observations: { intervals: [], gaps: 0, firstObserved: fetch, lastChange: fetch - 600000 },
    };
    const first = buildViewModel(makeUserData(), [], makeConfig(), history);
    const second = buildViewModel(makeUserData(), [], makeConfig({ personalBudget: 100 }), history);
    assert.strictEqual(first.sections.confidence, second.sections.confidence);
    assert.ok(second.sections.confidence.includes("latest refresh failed"));
    assert.ok(second.sections.confidence.includes("Last successful fetch"));
    assert.ok(second.sections.confidence.includes("Last observed balance change"));
  });

  test("disabled tracking hides timeline but retains fetch confidence", () => {
    const model = buildViewModel(makeUserData(), [], makeConfig(), {
      rollups: [], periods: [], timelineEnabled: false, observations: { intervals: [], gaps: 0 }, lastSuccessfulFetch: Date.now(),
    });
    assert.strictEqual(model.sections.timeline, "");
    assert.ok(model.sections.confidence.includes("tracking is disabled"));
  });

  test("below-allowance personal targets do not alter quota, overage or forecast sections", () => {
    const data = makeUserData({ quota_snapshots: {
      premium_interactions: makeQuota({ entitlement: 300, remaining: -20, quota_remaining: 0, overage_permitted: true }),
    } });
    const original = buildViewModel(data, [], makeConfig({ customLimit: 500 }));
    const budget = buildViewModel(data, [], makeConfig({ customLimit: 500, personalBudget: 100 }));
    for (const section of ["quotas", "overage", "weighted", "trend", "periods"] as const) {
      assert.strictEqual(budget.sections[section], original.sections[section]);
    }
    assert.ok(budget.sections.budget.includes('Included plan allowance</span><span class="prediction-value">300.00 credits'));
    assert.ok(budget.sections.budget.includes('Personal monthly target</span><span class="prediction-value">100.00 credits'));
    assert.ok(budget.sections.budget.includes('Left to target</span><span class="prediction-value">0.00 credits'));
    assert.ok(budget.sections.budget.includes('Used from reported balance</span><span class="prediction-value">320.00 credits'));
    assert.ok(budget.sections.budget.includes('Custom advisory limit</span><span class="prediction-value">500.00 credits'));
    assert.ok(budget.sections.budget.includes("do not change or enforce GitHub billing"));
  });

  test("reuses quota cards and compact metric rows with visible caveats and failure states", () => {
    const model = buildViewModel(makeUserData(), [], makeConfig(), {
      rollups: [], periods: [], refreshFailed: true, trackingInterrupted: true,
      observations: { intervals: [], gaps: 3 },
    });
    for (const section of ["budget", "confidence", "timeline"] as const) {
      const html = model.sections[section];
      assert.ok(html.startsWith('<section class="section"><h2 class="section-title">'));
      for (const cls of ["quota-card observation-card", "quota-header", "quota-title", "quota-badge", "quota-description"]) {
        assert.ok(html.includes(`class="${cls}"`), `missing ${cls} in ${section}`);
      }
      assert.ok(!html.includes("observation-panel"));
      assert.ok(html.includes('<details class="observation-details"><summary>'));
    }
    const visible = model.sections.confidence.split("<details")[0];
    assert.ok(visible.includes("latest refresh failed"));
    assert.ok(visible.includes("tracking gap since the last valid"));
    assert.ok(visible.includes('Tracking gaps</span><span class="prediction-value">3'));
    assert.ok(visible.includes("updates can be delayed"));
    assert.ok(model.sections.budget.split("<details")[0].includes("not GitHub billing controls"));
    assert.ok(model.sections.timeline.split("<details")[0].includes("attribution is approximate"));
    assert.ok(model.sections.budget.includes('class="quota-pacing-highlight"'));
    assert.ok(model.sections.budget.includes('class="pacing-row"'));
  });

  test("empty and zero observations do not imply usage or attribution coverage", () => {
    const now = Date.now();
    for (const intervals of [[], [{ start: now - 60000, end: now, credits: 0, gap: false }]]) {
      const model = buildViewModel(makeUserData(), [], makeConfig(), {
        rollups: [], periods: [], observations: { intervals, gaps: 0 },
      });
      assert.ok(model.sections.confidence.includes("0.00 of 0.00 (0%)"));
      assert.ok(model.sections.confidence.includes("Not observed"));
      assert.ok(model.sections.timeline.includes("No balance drops observed"));
      assert.ok(!model.sections.timeline.includes("<ol"));
      assert.ok(!model.sections.confidence.includes("NaN"));
    }
  });

  test("timeline uses one same-day date, explicit cross-day dates and exact accessible instants", () => {
    const start = new Date(2026, 9, 20, 10, 20, 30, 123).getTime();
    const end = start + 60000;
    const nextDay = new Date(2026, 9, 21, 10, 20).getTime();
    const render = (until: number) => buildViewModel(makeUserData(), [], makeConfig(), {
      rollups: [], periods: [],
      observations: { intervals: [{ start, end: until, credits: 2.5, gap: true }], gaps: 1 },
      lastSuccessfulFetch: end,
    });
    const sameDay = render(end);
    const dateLabel = (when: number) => new Date(when).toLocaleDateString(vscode.env.language, { month: "short", day: "numeric", year: "numeric" });
    const visibleText = (html: string) => html.replace(/<[^>]*>/g, "");
    assert.strictEqual(visibleText(sameDay.sections.timeline).split(dateLabel(start)).length - 1, 1);
    const crossDay = render(nextDay).sections.timeline;
    assert.ok(visibleText(crossDay).includes(dateLabel(start)));
    assert.ok(visibleText(crossDay).includes(dateLabel(nextDay)));
    assert.ok(sameDay.sections.timeline.includes(`(${new Date(start).toISOString()})`));
    assert.ok(sameDay.sections.timeline.includes(`(${new Date(end).toISOString()})`));
    assert.ok(sameDay.sections.timeline.includes('aria-label="'));
    assert.ok(sameDay.sections.timeline.includes('tabindex="0"'));
    assert.ok(sameDay.sections.timeline.split("<details")[0].includes("not a real-time spike"));
    assert.ok(sameDay.sections.confidence.includes(`datetime="${new Date(end).toISOString()}"`));
  });

  test("timeline remains newest-first and bounded to 100 positive drops", () => {
    const start = Date.now() - 200 * 60000;
    const intervals = Array.from({ length: 102 }, (_, i) => ({
      start: start + i * 60000, end: start + (i + 1) * 60000, credits: i, gap: false,
    }));
    const html = buildViewModel(makeUserData(), [], makeConfig(), {
      rollups: [], periods: [], observations: { intervals, gaps: 0 },
    }).sections.timeline;
    assert.strictEqual((html.match(/<li>/g) ?? []).length, 100);
    assert.ok(html.indexOf(">101.00 credits") < html.indexOf(">100.00 credits"));
    assert.ok(!html.includes(">1.00 credits"));
    assert.ok(!html.includes(">0.00 credits"));
  });

  test("unset targets and zero workday capacity remain explicit; unsupported quotas omit budget", () => {
    const config = makeConfig({ workCalendar: { weekdays: [], daysOff: [], reserve: 0, personalBudget: 0 } });
    const html = buildViewModel(makeUserData(), [], config).sections.budget;
    assert.ok(html.includes('Personal monthly target</span><span class="prediction-value">Not set'));
    assert.ok(!html.includes("Left to target"));
    assert.ok(html.includes('Remaining workdays</span><span class="pacing-value">0'));
    assert.ok(html.includes('Per workday</span><span class="pacing-value">0.00 credits'));
    for (const quota of [makeQuota({ unlimited: true }), makeQuota({ entitlement: 0 })]) {
      assert.strictEqual(buildViewModel(makeUserData({ quota_snapshots: { premium_interactions: quota } }), [], config).sections.budget, "");
    }
    assert.strictEqual(buildViewModel(makeUserData({ quota_snapshots: {} }), [], config).sections.budget, "");
  });

  test("quota and breakdown remain before the new supporting sections in the shell", () => {
    const webview = { cspSource: "test", asWebviewUri: (uri: vscode.Uri) => uri } as vscode.Webview;
    const html = renderShellHtml(webview, vscode.Uri.file("/extension"));
    assert.ok(html.indexOf('id="section-quotas"') < html.indexOf('id="section-quotaBreakdown"'));
    for (const section of ["budget", "confidence", "timeline"]) {
      assert.ok(html.indexOf('id="section-quotaBreakdown"') < html.indexOf(`id="section-${section}"`));
    }
  });
});

function makeConfig(overrides: Partial<RenderConfig> = {}): RenderConfig {
  return {
    showMood: true,
    progressBarMode: "remaining",
    customLimit: 0,
    enableColoring: true,
    dailyBudget: 0,
    ...overrides,
  };
}

function makeUserData(overrides: Partial<CopilotUserData> = {}): CopilotUserData {
  return {
    login: "octocat",
    copilot_plan: "Pro",
    chat_enabled: true,
    cli_enabled: true,
    is_mcp_enabled: true,
    editor_preview_features_enabled: true,
    copilotignore_enabled: false,
    restricted_telemetry: false,
    access_type_sku: "pro",
    assigned_date: "2025-01-01T00:00:00Z",
    organization_list: [],
    quota_snapshots: {
      premium_interactions: makeQuota({ quota_remaining: 120, remaining: 120 }),
    },
    quota_reset_date_utc: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
    quota_reset_date: "",
    ...overrides,
  };
}

/** Local `YYYY-MM-DD` for a day offset from today. */
function dateKey(daysAgo: number): string {
  const day = new Date();
  day.setDate(day.getDate() - daysAgo);
  return [
    day.getFullYear(),
    `${day.getMonth() + 1}`.padStart(2, "0"),
    `${day.getDate()}`.padStart(2, "0"),
  ].join("-");
}

function makeRollups(usedPerDay: number[]): DailyRollup[] {
  // Oldest first, ending yesterday.
  return usedPerDay.map((used, i) => ({
    date: dateKey(usedPerDay.length - i),
    used,
    endRemaining: 300 - usedPerDay.slice(0, i + 1).reduce((a, b) => a + b, 0),
    entitlement: 300,
    samples: 8,
    blocks: [0, 0, used, 0, 0, 0],
  }));
}

function makeSnapshots(remainingValues: number[]): LocalSnapshot[] {
  const now = Date.now();
  return remainingValues.map((remaining, i) => ({
    timestamp: new Date(now - i * 60 * 60 * 1000).toISOString(),
    premium_remaining: remaining,
    premium_entitlement: 300,
  }));
}

function makePeriod(overrides: Partial<PeriodSummary> = {}): PeriodSummary {
  return {
    resetDate: "2026-08-01T00:00:00Z",
    startDate: "2026-07-01",
    endDate: "2026-07-31",
    entitlement: 300,
    totalUsed: 100,
    peakDayDate: "2026-07-15",
    peakDayUsed: 25,
    daysObserved: 20,
    overageCredits: 0,
    partial: false,
    ...overrides,
  };
}

suite("buildViewModel", () => {
  test("renders every section without a durable history", () => {
    const model = buildViewModel(makeUserData(), [], makeConfig());

    assert.strictEqual(model.state, "data");
    assert.ok(model.sections.quotas.length > 0);
    // No tracked period yet, so the comparison stays out of the way.
    assert.strictEqual(model.sections.periods, "");
  });

  test("no longer emits a budget planner section", () => {
    const model = buildViewModel(makeUserData(), makeSnapshots([120, 150]), makeConfig());
    const html = Object.values(model.sections).join("");

    assert.ok(!html.includes("planner"), "planner markup should be gone");
    assert.ok(!("planner" in model.sections), "planner section key should be gone");
  });

  test("renders the billing periods section from rollups", () => {
    const history: HistoryContext = {
      rollups: makeRollups([20, 30, 40]),
      periods: [],
      currentPeriod: { resetDate: "2026-10-01T00:00:00Z", startDate: dateKey(5), partial: false },
    };

    const model = buildViewModel(
      makeUserData(),
      makeSnapshots([120, 150]),
      makeConfig(),
      history
    );

    assert.ok(model.sections.periods.includes("Billing Periods"));
    // 20 + 30 + 40 credits used across the tracked days.
    assert.ok(
      model.sections.periods.includes("90"),
      `expected the period total in: ${model.sections.periods}`
    );
    // Without an archived period there is nothing to compare against.
    assert.ok(!model.sections.periods.includes("vs last period"));
  });

  test("compares against the previous period once one is archived", () => {
    const history: HistoryContext = {
      rollups: makeRollups([20, 30, 40]),
      periods: [makePeriod({ totalUsed: 60, daysObserved: 3 })],
      currentPeriod: { resetDate: "2026-10-01T00:00:00Z", startDate: dateKey(5), partial: false },
    };

    const model = buildViewModel(
      makeUserData(),
      makeSnapshots([120, 150]),
      makeConfig(),
      history
    );

    assert.ok(model.sections.periods.includes("vs last period"));
    // 90 this period against 60 last period: up 30 (+50%).
    assert.ok(model.sections.periods.includes("is-up"));
  });

  test("omits the periods section for an unlimited quota", () => {
    const data = makeUserData({
      quota_snapshots: {
        premium_interactions: makeQuota({ unlimited: true }),
      },
    });
    const history: HistoryContext = {
      rollups: makeRollups([20, 30]),
      periods: [],
      currentPeriod: { resetDate: "2026-10-01T00:00:00Z", startDate: dateKey(5), partial: false },
    };

    assert.strictEqual(buildViewModel(data, [], makeConfig(), history).sections.periods, "");
  });

  test("draws the daily usage chart from rollups", () => {
    const history: HistoryContext = {
      rollups: makeRollups([20, 30, 40]),
      periods: [],
    };

    const model = buildViewModel(
      makeUserData(),
      makeSnapshots([120, 150]),
      makeConfig(),
      history
    );

    const dailyChart = model.charts.find((chart) => chart.kind === "dailyUsage");
    assert.ok(dailyChart, "expected a daily usage chart");
    assert.strictEqual(dailyChart.series[0].points.length, 3);
  });
});

suite("buildViewModel attribution", () => {
  const currentPeriod = {
    resetDate: "2026-10-01T00:00:00Z",
    startDate: dateKey(5),
    partial: false,
  };

  function withAttribution(buckets: AttributionState["buckets"]): HistoryContext {
    return {
      rollups: makeRollups([20, 30, 40]),
      periods: [],
      currentPeriod,
      attribution: { resetDate: currentPeriod.resetDate, buckets },
    };
  }

  test("omits the section when attribution is switched off", () => {
    const history: HistoryContext = {
      rollups: makeRollups([20, 30, 40]),
      periods: [],
      currentPeriod,
    };

    const model = buildViewModel(makeUserData(), [], makeConfig(), history);
    assert.strictEqual(model.sections.attribution, "");
  });

  test("omits the section when nothing has been attributed yet", () => {
    const model = buildViewModel(makeUserData(), [], makeConfig(), withAttribution([]));
    assert.strictEqual(model.sections.attribution, "");
  });

  test("lists projects with their share of the period", () => {
    const model = buildViewModel(
      makeUserData(),
      [],
      makeConfig(),
      withAttribution([
        { project: "api", branch: "main", credits: 45, lastDate: dateKey(1) },
        { project: "web", branch: "main", credits: 27, lastDate: dateKey(1) },
      ])
    );

    const html = model.sections.attribution;
    assert.ok(html.includes("Where Your Credits Went"));
    assert.ok(html.includes("api"), "expected the project name");
    assert.ok(html.includes("web"), "expected the second project name");
    // 45 of the 90 credits the rollups recorded for the period.
    assert.ok(html.includes("50%"), `expected a 50% share in: ${html}`);
  });

  test("shows the unattributed remainder", () => {
    const model = buildViewModel(
      makeUserData(),
      [],
      makeConfig(),
      withAttribution([{ project: "api", branch: "main", credits: 60, lastDate: dateKey(1) }])
    );

    // 90 used this period, 60 attributed -> 30 unattributed.
    assert.ok(model.sections.attribution.includes("Unattributed"));
    assert.ok(model.sections.attribution.includes("is-unattributed"));
  });

  test("labels usage recorded with no folder open", () => {
    const model = buildViewModel(
      makeUserData(),
      [],
      makeConfig(),
      withAttribution([{ project: "", branch: "", credits: 90, lastDate: dateKey(1) }])
    );

    assert.ok(model.sections.attribution.includes("No folder open"));
  });

  test("escapes project names", () => {
    const model = buildViewModel(
      makeUserData(),
      [],
      makeConfig(),
      withAttribution([
        { project: "<img src=x onerror=alert(1)>", branch: "main", credits: 90, lastDate: dateKey(1) },
      ])
    );

    assert.ok(!model.sections.attribution.includes("<img"), "project names must be escaped");
    assert.ok(model.sections.attribution.includes("&lt;img"));
  });

  test("omits the section for an unlimited quota", () => {
    const data = makeUserData({
      quota_snapshots: { premium_interactions: makeQuota({ unlimited: true }) },
    });

    const model = buildViewModel(
      data,
      [],
      makeConfig(),
      withAttribution([{ project: "api", branch: "main", credits: 45, lastDate: dateKey(1) }])
    );

    assert.strictEqual(model.sections.attribution, "");
  });
});
