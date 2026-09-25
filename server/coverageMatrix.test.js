import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { calculateCoverageMatrix, CoverageOutcome, CoverageReasonCode, validateCoveragePolicyConfiguration } from './services/coverageMatrixService.js';

const configuration = (overrides = {}) => ({
  status: 'active',
  publicHospitalRoomReductions: { semi_private: 0.25, private: 0.5 },
  outsidePharmacyMedicineReductionRate: 0.4,
  partialIndigentSubsidyBands: [{ code: 'band-a', rate: 0.75 }, { code: 'band-b', rate: 0.5 }],
  coverageCaps: { default: 10000, byAssistanceType: { 'Hospital Assistance': 8000 } },
  payerDeductions: { enabled: true, required: false, clientApprovalReference: 'CLIENT-PAYER-1', approvedPayerTypes: ['Approved payer'], verificationMethods: ['staff', 'integration'] },
  ...overrides,
});
const policy = (overrides) => ({ id: 'coverage-policy', policy_version: 'coverage_matrix:global:test', configuration: configuration(overrides) });
const request = (overrides = {}) => ({ id: 'request-1', assistance_type: 'Hospital Assistance', facility_tier_snapshot: 'public', ...overrides });
const input = (overrides = {}) => ({ grossAmount: 10000, payerDeductions: [], roomClass: 'standard', roomCharges: 0, medicineItems: [], subsidyBand: 'band-a', subsidyBandVerified: true, ...overrides });

test('reduces public-hospital coverage for upgraded private and semi-private rooms', () => {
  const privateRoom = calculateCoverageMatrix({ request: request(), input: input({ roomClass: 'private', roomCharges: 2000 }), policy: policy(), hardDisqualifierOutcome: 'clear' });
  assert.equal(privateRoom.eligibleBase, 9000);
  assert.equal(privateRoom.coveredAmount, 6750);
  assert.equal(privateRoom.netRemainingBalance, 3250);
  assert.ok(privateRoom.reasonCodes.includes(CoverageReasonCode.ROOM_REDUCTION));
  const semiPrivate = calculateCoverageMatrix({ request: request(), input: input({ roomClass: 'semi_private', roomCharges: 2000 }), policy: policy(), hardDisqualifierOutcome: 'clear' });
  assert.equal(semiPrivate.eligibleBase, 9500);
});

test('reduces only non-formulary or branded medicines from unaccredited outside pharmacies', () => {
  const result = calculateCoverageMatrix({ request: request(), input: input({ medicineItems: [
    { amount: 1000, formulary: false, branded: false, pharmacyAccredited: false },
    { amount: 500, formulary: true, branded: true, pharmacyAccredited: false },
    { amount: 900, formulary: false, branded: true, pharmacyAccredited: true },
  ] }), policy: policy(), hardDisqualifierOutcome: 'clear' });
  assert.equal(result.eligibleBase, 9400);
  assert.ok(result.reasonCodes.includes(CoverageReasonCode.MEDICINE_REDUCTION));
});

test('applies verified payer deductions, combined reductions, scaled subsidy, and cap in a reproducible order', () => {
  const parameters = { request: request(), input: input({
    payerDeductions: [{ payerType: 'Approved payer', amount: 2000, verified: true, verificationMethod: 'staff', reference: 'PAY-1' }],
    roomClass: 'private', roomCharges: 2000,
    medicineItems: [{ amount: 1000, formulary: false, branded: true, pharmacyAccredited: false }],
  }), policy: policy(), hardDisqualifierOutcome: 'exception_applied' };
  const first = calculateCoverageMatrix(parameters);
  const second = calculateCoverageMatrix(parameters);
  assert.deepEqual(first, second);
  assert.equal(first.patientBalance, 8000);
  assert.equal(first.eligibleBase, 6600);
  assert.equal(first.coveredAmount, 4950);
  assert.equal(first.netRemainingBalance, 3050);
  assert.equal(first.outcome, CoverageOutcome.PARTIALLY_COVERED);
});

test('handles missing payer data and ignores unverified or unapproved payer claims', () => {
  const requiredPolicy = policy({ payerDeductions: { ...configuration().payerDeductions, required: true } });
  const missing = calculateCoverageMatrix({ request: request(), input: input(), policy: requiredPolicy, hardDisqualifierOutcome: 'clear' });
  assert.equal(missing.outcome, CoverageOutcome.INELIGIBLE);
  assert.deepEqual(missing.reasonCodes, [CoverageReasonCode.PAYER_DATA_REQUIRED]);
  const ignored = calculateCoverageMatrix({ request: request(), input: input({ payerDeductions: [{ payerType: 'Applicant-entered payer', amount: 9999, verified: false, verificationMethod: 'applicant', reference: 'UNVERIFIED' }] }), policy: policy(), hardDisqualifierOutcome: 'clear' });
  assert.equal(ignored.patientBalance, 10000);
  assert.ok(ignored.reasonCodes.includes(CoverageReasonCode.PAYER_IGNORED));
});

test('applies coverage caps and safely handles zero or negative balances', () => {
  const capped = calculateCoverageMatrix({ request: request(), input: input({ grossAmount: 20000 }), policy: policy(), hardDisqualifierOutcome: 'clear' });
  assert.equal(capped.uncappedCoverage, 15000);
  assert.equal(capped.coveredAmount, 8000);
  assert.ok(capped.reasonCodes.includes(CoverageReasonCode.POLICY_CAP));
  const zero = calculateCoverageMatrix({ request: request(), input: input({ grossAmount: 0 }), policy: policy(), hardDisqualifierOutcome: 'clear' });
  assert.equal(zero.outcome, CoverageOutcome.INELIGIBLE);
  assert.equal(zero.netRemainingBalance, 0);
  assert.throws(() => calculateCoverageMatrix({ request: request(), input: input({ grossAmount: -1 }), policy: policy(), hardDisqualifierOutcome: 'clear' }), /zero or greater/i);
});

test('does not calculate before hard disqualifiers and does not enable unapproved payer policy', () => {
  const blocked = calculateCoverageMatrix({ request: request(), input: input(), policy: policy(), hardDisqualifierOutcome: 'blocked' });
  assert.equal(blocked.outcome, CoverageOutcome.INELIGIBLE);
  assert.deepEqual(blocked.reasonCodes, [CoverageReasonCode.HARD_DISQUALIFIER]);
  assert.throws(() => validateCoveragePolicyConfiguration({ ...configuration(), payerDeductions: { enabled: true, approvedPayerTypes: [], verificationMethods: ['staff'] } }), /client approval reference/i);
});

test('migration stores reproducible snapshots and keeps production values and payer deductions pending', async () => {
  const sql = await fs.readFile(new URL('./storage/migrations/008_coverage_matrix.sql', import.meta.url), 'utf8');
  for (const expected of ['coverage_input_versions', 'coverage_calculation_snapshots', 'prevent_coverage_snapshot_mutation', 'awaiting_client_values', '"enabled":false']) assert.match(sql, new RegExp(expected));
  assert.doesNotMatch(sql, /philhealth_number|philhealth_toggle/i);
});
