import * as assert from "assert";
import { CopilotInsightsViewProvider } from "../ui/webview/provider";
import { InsightsViewModel, RenderConfig, WebviewStateMessage } from "../ui/webview/render";
import { CopilotUserData } from "../types";
import { WorkspaceIntervalTracker } from "../ui/workspaceContext";
import { makeQuota } from "./quota.test";

// Exercise publishing/lifecycle without starting polling, signing in, or touching user settings.
interface ProviderHarness {
  _lastData?: CopilotUserData;
  _lastSuccessfulFetchMs: number;
  _lastStateMessage: WebviewStateMessage;
  _refreshFailed: boolean;
  _accountGeneration: number;
  _focusedSinceLastObservation: boolean;
  _previousBalance?: unknown;
  _snapshots: unknown;
  _observations: unknown;
  _workspaceTracker: unknown;
  _statusBar: unknown;
  _inflightLoad?: { promise: Promise<boolean>; silent: boolean };
  _getRenderConfig(): RenderConfig;
  _getAttributionMode(): string;
  _publishData(data: CopilotUserData): void;
  _reloadAccount(): void;
  loadCopilotData(): Promise<boolean>;
  clearSnapshotHistory(): void;
}

suite("Provider observation lifecycle", () => {
  let provider: ProviderHarness;
  const fetched = Date.now() - 600_000;
  const data: CopilotUserData = {
    login: "alice", copilot_plan: "Pro", chat_enabled: true, cli_enabled: true,
    is_mcp_enabled: false, editor_preview_features_enabled: false, copilotignore_enabled: false,
    restricted_telemetry: false, access_type_sku: "pro", assigned_date: "",
    organization_list: [], quota_snapshots: { premium_interactions: makeQuota() },
    quota_reset_date_utc: "2026-11-01T00:00:00Z", quota_reset_date: "",
  };
  setup(() => {
    provider = Object.create(CopilotInsightsViewProvider.prototype) as ProviderHarness;
    provider._lastData = data;
    provider._lastSuccessfulFetchMs = fetched;
    provider._refreshFailed = false;
    provider._accountGeneration = 0;
    provider._getRenderConfig = () => ({ showMood: true, progressBarMode: "remaining", customLimit: 0, enableColoring: true, dailyBudget: 0 });
    provider._getAttributionMode = () => "off";
    provider._snapshots = { snapshots: [], rollups: [], periods: [], clear() {} };
    provider._observations = {
      data: { intervals: [], gaps: 0, firstObserved: fetched, lastChange: fetched - 600_000 },
      enabled: true, trackingInterrupted: false, interrupt() {}, clear() {},
    };
    provider._workspaceTracker = { invalidate() {} };
    provider._statusBar = { showSignIn() {} };
  });

  test("cached publishes do not turn config changes into fresh successful fetches", () => {
    provider._publishData(data);
    const first = provider._lastStateMessage as InsightsViewModel;
    provider._getRenderConfig = () => ({ showMood: false, progressBarMode: "used", customLimit: 0, enableColoring: false, dailyBudget: 10 });
    provider._refreshFailed = true;
    provider._publishData(data);
    const second = provider._lastStateMessage as InsightsViewModel;
    assert.strictEqual(provider._lastSuccessfulFetchMs, fetched);
    assert.strictEqual(first.lastFetched, second.lastFetched);
    assert.ok(second.sections.confidence.includes("latest refresh failed"));
  });

  test("clear history also clears timeline and continuity without changing the fetch time", () => {
    let snapshots = false;
    let observations = false;
    provider._snapshots = { snapshots: [], rollups: [], periods: [], clear() { snapshots = true; } };
    provider._observations = { data: { intervals: [], gaps: 0 }, enabled: true, clear() { observations = true; } };
    provider._previousBalance = {};
    provider.clearSnapshotHistory();
    assert.ok(snapshots && observations);
    assert.strictEqual(provider._previousBalance, undefined);
    assert.strictEqual(provider._lastSuccessfulFetchMs, fetched);
  });

  test("account changes hide old data and wait for old requests before reloading", async () => {
    let resolve!: (value: boolean) => void;
    provider._inflightLoad = { promise: new Promise<boolean>(done => { resolve = done; }), silent: true };
    let loads = 0;
    provider.loadCopilotData = async () => { loads++; return true; };
    provider._reloadAccount();
    assert.strictEqual(provider._lastData, undefined);
    assert.strictEqual(provider._lastSuccessfulFetchMs, 0);
    assert.strictEqual(provider._accountGeneration, 1);
    assert.strictEqual(provider._lastStateMessage.state, "loading");
    assert.strictEqual(loads, 0);
    resolve(true);
    await provider._inflightLoad.promise;
    await Promise.resolve();
    assert.strictEqual(loads, 1);
  });
});

suite("Workspace context continuity", () => {
  test("A to B to A is not a stable interval even when endpoint labels match", () => {
    const tracker = Object.create(WorkspaceIntervalTracker.prototype) as {
      signature: string; stable: boolean; current(): string; check(): void; reset(): void;
    };
    let current = "A";
    tracker.current = () => current;
    tracker.reset();
    tracker.check();
    assert.strictEqual(tracker.stable, true);
    current = "B";
    tracker.check();
    current = "A";
    tracker.check();
    assert.strictEqual(tracker.stable, false);
    tracker.reset();
    assert.strictEqual(tracker.stable, true);
  });
});
