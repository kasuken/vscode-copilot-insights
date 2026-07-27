const DAY_MS = 24 * 60 * 60 * 1000;

export interface CreditBudgetPlanInput {
  remainingCredits: number;
  resetDate: string | number | Date;
  plannedRequestsPerDay: number;
  creditMultiplier: number;
  reserveCredits?: number;
  now?: string | number | Date;
}

export interface CreditBudgetPlan {
  daysUntilReset: number;
  availableCredits: number;
  sustainableRequestsPerDay: number;
  plannedCreditsPerDay: number;
  projectedCreditsAtReset: number;
  meetsReserve: boolean;
  hasValidReset: boolean;
}

function nonnegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function timestamp(value: string | number | Date): number {
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(result) ? result : NaN;
}

/**
 * Models an AI Credit budget through the next reset.
 *
 * Fractional days and requests are retained so callers can choose their own
 * display precision. Invalid, negative, and past-window inputs safely collapse
 * to zero rather than producing NaN or Infinity.
 */
export function calculateCreditBudgetPlan(input: CreditBudgetPlanInput): CreditBudgetPlan {
  const remainingCredits = nonnegative(input.remainingCredits);
  const reserveCredits = nonnegative(input.reserveCredits ?? 0);
  const plannedRequestsPerDay = nonnegative(input.plannedRequestsPerDay);
  const creditMultiplier =
    Number.isFinite(input.creditMultiplier) && input.creditMultiplier > 0
      ? input.creditMultiplier
      : 1;
  const now = timestamp(input.now ?? Date.now());
  const reset = timestamp(input.resetDate);
  const hasValidReset = Number.isFinite(now) && Number.isFinite(reset) && reset > now;
  const daysUntilReset = hasValidReset ? (reset - now) / DAY_MS : 0;
  const availableCredits = Math.max(0, remainingCredits - reserveCredits);
  const plannedCreditsPerDay = plannedRequestsPerDay * creditMultiplier;
  const sustainableRequestsPerDay =
    daysUntilReset > 0 ? availableCredits / daysUntilReset / creditMultiplier : 0;
  const projectedCreditsAtReset = hasValidReset
    ? remainingCredits - plannedCreditsPerDay * daysUntilReset
    : remainingCredits;

  return {
    daysUntilReset,
    availableCredits,
    sustainableRequestsPerDay,
    plannedCreditsPerDay,
    projectedCreditsAtReset,
    meetsReserve: hasValidReset && projectedCreditsAtReset >= reserveCredits,
    hasValidReset,
  };
}
