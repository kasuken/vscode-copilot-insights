import * as assert from "assert";
import { buildViewModel, HistoryContext, RenderConfig } from "../ui/webview/render";
import {
  AttributionState,
  CopilotUserData,
  DailyRollup,
  LocalSnapshot,
  PeriodSummary,
} from "../types";
import { makeQuota } from "./quota.test";

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
