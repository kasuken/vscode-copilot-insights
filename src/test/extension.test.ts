import * as assert from "assert";

import { normalizePollingIntervalSeconds } from "../extension";

suite("Extension Test Suite", () => {
  test("normalizes valid polling intervals", () => {
    assert.strictEqual(normalizePollingIntervalSeconds(undefined), 60);
    assert.strictEqual(normalizePollingIntervalSeconds(60), 60);
    assert.strictEqual(normalizePollingIntervalSeconds(0), 0);
    assert.strictEqual(normalizePollingIntervalSeconds(-15), 0);
    assert.strictEqual(normalizePollingIntervalSeconds(1.4), 1);
    assert.strictEqual(normalizePollingIntervalSeconds(1.6), 2);
  });

  test("falls back when the configured interval is invalid", () => {
    assert.strictEqual(normalizePollingIntervalSeconds(Number.NaN), 60);
    assert.strictEqual(
      normalizePollingIntervalSeconds(Number.POSITIVE_INFINITY),
      60
    );
    assert.strictEqual(normalizePollingIntervalSeconds(undefined, 120), 120);
  });
});
