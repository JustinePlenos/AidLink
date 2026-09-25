import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { budgetAvailability, guaranteeLetterExpired, guaranteeLetterExpiry, validateBudgetPool } from './services/budgetAllocationService.js';
import { issueLetterQr } from './services/protectedLetterService.js';

const pool = (overrides = {}) => ({ allocated_amount: 100, reserved_amount: 20, spent_amount: 10, depletion_threshold_amount: 5, assistance_limit: 40, ...overrides });

test('validates configured budget pools and strict 3 through 14 day validity', () => {
  const base = { name: 'Hospital 2026', allocatedAmount: 100, assistanceLimit: 40, depletionThresholdAmount: 5, effectiveFrom: '2026-01-01', effectiveUntil: '2026-12-31', justification: 'Approved annual city budget pool.' };
  assert.equal(validateBudgetPool({ ...base, guaranteeLetterValidityDays: 3 }).validityDays, 3);
  assert.equal(validateBudgetPool({ ...base, guaranteeLetterValidityDays: 14 }).validityDays, 14);
  assert.throws(() => validateBudgetPool({ ...base, guaranteeLetterValidityDays: 2 }), /3 through 14/);
  assert.throws(() => validateBudgetPool({ ...base, guaranteeLetterValidityDays: 15 }), /3 through 14/);
  assert.throws(() => validateBudgetPool({ ...base, depletionThresholdAmount: 100, guaranteeLetterValidityDays: 7 }), /threshold/i);
});

test('enforces assistance limits and depletion thresholds', () => {
  assert.equal(budgetAvailability(pool(), 40).allowed, true);
  assert.equal(budgetAvailability(pool(), 41).reasonCode, 'ASSISTANCE_LIMIT_EXCEEDED');
  assert.equal(budgetAvailability(pool({ reserved_amount: 94, spent_amount: 0 }), 1).allowed, true);
  assert.equal(budgetAvailability(pool({ reserved_amount: 95, spent_amount: 0 }), 0).reasonCode, 'BUDGET_DEPLETED');
  assert.equal(budgetAvailability(pool({ reserved_amount: 94, spent_amount: 0 }), 2).reasonCode, 'BUDGET_DEPLETED');
});

test('expires at the exact 3-day and 14-day boundaries', () => {
  const released = new Date('2026-09-25T00:00:00.000Z');
  const threeDays = guaranteeLetterExpiry(released, 3);
  const fourteenDays = guaranteeLetterExpiry(released, 14);
  assert.equal(threeDays.toISOString(), '2026-09-28T00:00:00.000Z');
  assert.equal(fourteenDays.toISOString(), '2026-10-09T00:00:00.000Z');
  assert.equal(guaranteeLetterExpired(threeDays, new Date('2026-09-27T23:59:59.999Z')), false);
  assert.equal(guaranteeLetterExpired(threeDays, new Date('2026-09-28T00:00:00.000Z')), true);
  assert.equal(guaranteeLetterExpired(fourteenDays, new Date('2026-10-09T00:00:00.000Z')), true);
  assert.equal(new Date(issueLetterQr('secret', 'request', 1, 14, released).expiresAt).toISOString(), fourteenDays.toISOString());
  assert.throws(() => issueLetterQr('secret', 'request', 1, 30, released), /3 through 14/);
});

test('migration and release path tie allocations to letters with complete audit actions', async () => {
  const migration = await fs.readFile(new URL('./storage/migrations/010_controlled_budget_allocation.sql', import.meta.url), 'utf8');
  const repository = await fs.readFile(new URL('./storage/postgresRepositories.js', import.meta.url), 'utf8');
  const server = await fs.readFile(new URL('./server.js', import.meta.url), 'utf8');
  for (const expected of ['assistance_limit', 'depletion_threshold_amount', 'guarantee_letter_validity_days', 'guarantee_letter_id', 'expires_at', 'BUDGET_DEPLETED']) assert.match(migration, new RegExp(expected));
  assert.match(repository, /SERIALIZABLE/);
  assert.match(repository, /FOR UPDATE/);
  assert.match(repository, /budget_reserved/);
  assert.match(repository, /budget_allocation_released/);
  assert.match(repository, /guarantee_letter_expired/);
  assert.doesNotMatch(repository.slice(repository.indexOf('async recordDecision(input)'), repository.indexOf('async releaseGuaranteeLetter(input)')), /reserveBudgetInTransaction/);
  assert.match(server, /app\.post\('\/api\/budgets', requireAuth, requirePermission\(Permissions\.CONFIGURATION_MANAGE\)/);
  assert.match(server, /processGuaranteeLetterExpiries/);
});
