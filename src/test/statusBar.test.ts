import * as assert from "assert";
import { formatStatusBarText, StatusBarTextOptions } from "../ui/statusBar";
import { getStatusBadge } from "../core/quota";
import { makeQuota } from "./quota.test";

function makeOptions(overrides: Partial<StatusBarTextOptions> = {}): StatusBarTextOptions {
  return {
    style: "detailed-original",
    progressBarMode: "remaining",
    showName: true,
    showNumericalQuota: true,
    showVisualIndicator: true,
    ...overrides,
  };
}

// 40% remaining, 60% used, 120/300
const quota = makeQuota();
const badge = getStatusBadge(40, true);

suite("formatStatusBarText", () => {
  test("detailed-original", () => {
    const text = formatStatusBarText(40, 60, quota, badge, makeOptions());
    assert.strictEqual(text, "$(warning) Copilot: 120/300 (40%)");
  });

  test("solid-bar", () => {
    const text = formatStatusBarText(40, 60, quota, badge, makeOptions({ style: "solid-bar" }));
    assert.strictEqual(text, "$(warning) Copilot: 120/300 ██░░░ 40%");
  });

  test("shaded-bar", () => {
    const text = formatStatusBarText(40, 60, quota, badge, makeOptions({ style: "shaded-bar" }));
    assert.strictEqual(text, "$(warning) Copilot: 120/300 ▓▓░░░ 40%");
  });

  test("minimalist", () => {
    const text = formatStatusBarText(40, 60, quota, badge, makeOptions({ style: "minimalist" }));
    assert.strictEqual(text, "$(warning) Copilot: 120/300 40%");
  });

  test("circular-ring", () => {
    const text = formatStatusBarText(40, 60, quota, badge, makeOptions({ style: "circular-ring" }));
    assert.strictEqual(text, "$(warning) Copilot: 120/300 ◔ 40%");
  });

  test("progress-capsule", () => {
    const text = formatStatusBarText(40, 60, quota, badge, makeOptions({ style: "progress-capsule" }));
    assert.strictEqual(text, "$(warning) Copilot: 120/300 ◖ 40% ◗");
  });

  test("adaptive-emoji picks mood from percent used", () => {
    const text = formatStatusBarText(40, 60, quota, badge, makeOptions({ style: "adaptive-emoji" }));
    assert.strictEqual(text, "$(warning) Copilot: 120/300 🙂 40%");
  });

  test("legacy style aliases are normalized", () => {
    const legacy = formatStatusBarText(40, 60, quota, badge, makeOptions({ style: "blocks" }));
    const modern = formatStatusBarText(40, 60, quota, badge, makeOptions({ style: "solid-bar" }));
    assert.strictEqual(legacy, modern);
  });

  test("used mode shows used quota", () => {
    const text = formatStatusBarText(40, 60, quota, badge, makeOptions({ progressBarMode: "used" }));
    assert.strictEqual(text, "$(warning) Copilot: 180/300 (60%)");
  });

  test("hides name when disabled", () => {
    const text = formatStatusBarText(40, 60, quota, badge, makeOptions({ showName: false }));
    assert.strictEqual(text, "$(warning) 120/300 (40%)");
  });

  test("visual indicator disabled returns name + quota only", () => {
    const text = formatStatusBarText(40, 60, quota, badge, makeOptions({ showVisualIndicator: false, style: "solid-bar" }));
    assert.strictEqual(text, "$(warning) Copilot: 120/300");
  });

  test("all toggles disabled returns just the icon", () => {
    const text = formatStatusBarText(40, 60, quota, badge, makeOptions({
      showName: false,
      showNumericalQuota: false,
      showVisualIndicator: false,
    }));
    assert.strictEqual(text, "$(warning)");
  });

  test("over quota shows overage amount", () => {
    const overQuota = makeQuota({ quota_remaining: 0, remaining: -25 });
    const overBadge = getStatusBadge(0, true);
    const text = formatStatusBarText(0, 100, overQuota, overBadge, makeOptions());
    assert.strictEqual(text, "$(error) Copilot: +25/300 (+25)");
  });
});
