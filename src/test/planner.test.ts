import * as assert from "assert";
import { calculateCreditBudgetPlan } from "../core/planner";

suite("calculateCreditBudgetPlan", () => {
  const now = "2026-07-01T00:00:00Z";
  const resetDate = "2026-07-11T00:00:00Z";

  test("calculates a sustainable daily request budget at a multiplier", () => {
    const plan = calculateCreditBudgetPlan({
      remainingCredits: 120,
      reserveCredits: 20,
      resetDate,
      now,
      plannedRequestsPerDay: 8,
      creditMultiplier: 2,
    });

    assert.strictEqual(plan.daysUntilReset, 10);
    assert.strictEqual(plan.availableCredits, 100);
    assert.strictEqual(plan.sustainableRequestsPerDay, 5);
    assert.strictEqual(plan.plannedCreditsPerDay, 16);
    assert.strictEqual(plan.projectedCreditsAtReset, -40);
    assert.strictEqual(plan.meetsReserve, false);
  });

  test("retains fractional reset windows", () => {
    const plan = calculateCreditBudgetPlan({
      remainingCredits: 24,
      resetDate: "2026-07-02T12:00:00Z",
      now,
      plannedRequestsPerDay: 8,
      creditMultiplier: 1,
    });

    assert.strictEqual(plan.daysUntilReset, 1.5);
    assert.strictEqual(plan.sustainableRequestsPerDay, 16);
    assert.strictEqual(plan.projectedCreditsAtReset, 12);
    assert.strictEqual(plan.meetsReserve, true);
  });

  test("clamps an oversized reserve to no spendable credits", () => {
    const plan = calculateCreditBudgetPlan({
      remainingCredits: 10,
      reserveCredits: 50,
      resetDate,
      now,
      plannedRequestsPerDay: 0,
      creditMultiplier: 1,
    });

    assert.strictEqual(plan.availableCredits, 0);
    assert.strictEqual(plan.sustainableRequestsPerDay, 0);
    assert.strictEqual(plan.meetsReserve, false);
  });

  test("handles invalid and past reset dates without NaN or Infinity", () => {
    for (const date of ["not-a-date", "2026-06-30T00:00:00Z"]) {
      const plan = calculateCreditBudgetPlan({
        remainingCredits: 100,
        resetDate: date,
        now,
        plannedRequestsPerDay: 10,
        creditMultiplier: 0,
      });
      assert.strictEqual(plan.hasValidReset, false);
      assert.strictEqual(plan.daysUntilReset, 0);
      assert.strictEqual(plan.sustainableRequestsPerDay, 0);
      assert.strictEqual(plan.projectedCreditsAtReset, 100);
      assert.strictEqual(plan.meetsReserve, false);
    }
  });

  test("normalizes non-finite and negative numeric inputs", () => {
    const plan = calculateCreditBudgetPlan({
      remainingCredits: -10,
      reserveCredits: Number.NaN,
      resetDate,
      now,
      plannedRequestsPerDay: Number.POSITIVE_INFINITY,
      creditMultiplier: Number.NaN,
    });

    assert.strictEqual(plan.availableCredits, 0);
    assert.strictEqual(plan.plannedCreditsPerDay, 0);
    assert.strictEqual(plan.sustainableRequestsPerDay, 0);
    assert.strictEqual(plan.projectedCreditsAtReset, 0);
    assert.strictEqual(plan.meetsReserve, true);
  });
});
