const DAY_MS = 86_400_000;

export const BudgetReasonCode = Object.freeze({
  POOL_NOT_CONFIGURED: 'BUDGET_POOL_NOT_CONFIGURED',
  DEPLETED: 'BUDGET_DEPLETED',
  ASSISTANCE_LIMIT_EXCEEDED: 'ASSISTANCE_LIMIT_EXCEEDED',
  INVALID_VALIDITY: 'GUARANTEE_LETTER_VALIDITY_INVALID',
});

const money = (value) => Math.round(Number(value) * 100) / 100;

export function validateBudgetPool(input) {
  const allocatedAmount = money(input.allocatedAmount);
  const assistanceLimit = money(input.assistanceLimit);
  const depletionThresholdAmount = money(input.depletionThresholdAmount);
  const validityDays = Number(input.guaranteeLetterValidityDays);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(input.effectiveFrom || '')) ? new Date(`${input.effectiveFrom}T00:00:00.000Z`) : null;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(input.effectiveUntil || '')) ? new Date(`${input.effectiveUntil}T23:59:59.999Z`) : null;
  if (!String(input.name || '').trim()) throw Object.assign(new Error('Enter a budget-pool name.'), { code: 'BUDGET_NAME_REQUIRED' });
  if (!Number.isFinite(allocatedAmount) || allocatedAmount <= 0) throw Object.assign(new Error('Allocated budget must be greater than zero.'), { code: 'BUDGET_AMOUNT_INVALID' });
  if (!Number.isFinite(assistanceLimit) || assistanceLimit <= 0 || assistanceLimit > allocatedAmount) throw Object.assign(new Error('The per-request assistance limit must be greater than zero and no more than the pool allocation.'), { code: 'ASSISTANCE_LIMIT_INVALID' });
  if (!Number.isFinite(depletionThresholdAmount) || depletionThresholdAmount < 0 || depletionThresholdAmount >= allocatedAmount) throw Object.assign(new Error('The depletion threshold must be zero or greater and lower than the pool allocation.'), { code: 'DEPLETION_THRESHOLD_INVALID' });
  if (!Number.isInteger(validityDays) || validityDays < 3 || validityDays > 14) throw Object.assign(new Error('Guarantee Letter validity must be from 3 through 14 days.'), { code: BudgetReasonCode.INVALID_VALIDITY });
  if (!start || Number.isNaN(start.getTime()) || !end || Number.isNaN(end.getTime()) || end < start) throw Object.assign(new Error('Enter valid effective start and end dates.'), { code: 'BUDGET_EFFECTIVE_DATES_INVALID' });
  if (String(input.justification || '').trim().length < 10) throw Object.assign(new Error('Enter a budget configuration justification of at least 10 characters.'), { code: 'BUDGET_JUSTIFICATION_REQUIRED' });
  return { allocatedAmount, assistanceLimit, depletionThresholdAmount, validityDays, start, end };
}

export function budgetAvailability(pool, requestedAmount = 0) {
  const allocated = money(pool.allocated_amount ?? pool.allocatedAmount);
  const reserved = money(pool.reserved_amount ?? pool.reservedAmount ?? 0);
  const spent = money(pool.spent_amount ?? pool.spentAmount ?? 0);
  const threshold = money(pool.depletion_threshold_amount ?? pool.depletionThresholdAmount ?? 0);
  const limitValue = pool.assistance_limit ?? pool.assistanceLimit;
  const limit = limitValue == null ? null : money(limitValue);
  const available = money(allocated - reserved - spent);
  const allocatable = money(Math.max(0, available - threshold));
  const amount = money(requestedAmount || 0);
  if (limit != null && amount > limit) return { allowed: false, reasonCode: BudgetReasonCode.ASSISTANCE_LIMIT_EXCEEDED, allocated, reserved, spent, available, allocatable, threshold, assistanceLimit: limit };
  if (available <= threshold || amount > allocatable) return { allowed: false, reasonCode: BudgetReasonCode.DEPLETED, allocated, reserved, spent, available, allocatable, threshold, assistanceLimit: limit };
  return { allowed: true, reasonCode: null, allocated, reserved, spent, available, allocatable, threshold, assistanceLimit: limit };
}

export function guaranteeLetterExpiry(releasedAt, validityDays) {
  const days = Number(validityDays);
  if (!Number.isInteger(days) || days < 3 || days > 14) throw Object.assign(new Error('Guarantee Letter validity must be from 3 through 14 days.'), { code: BudgetReasonCode.INVALID_VALIDITY });
  const released = new Date(releasedAt);
  if (Number.isNaN(released.getTime())) throw new Error('A valid Guarantee Letter release time is required.');
  return new Date(released.getTime() + days * DAY_MS);
}

export function guaranteeLetterExpired(expiresAt, now = new Date()) {
  return new Date(now).getTime() >= new Date(expiresAt).getTime();
}
