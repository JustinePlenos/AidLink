import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  FacilityReasonCode,
  privatePrescriptionPricingState,
  resolveFacilityEvidence,
  validateFacilityDirectory,
} from './services/facilityRoutingService.js';
import { hasPermission, Permissions, Roles } from './security/permissions.js';

const publicDirectory = {
  requiredPrivatePartnerCount: 42,
  maxEvidenceAgeDays: 365,
  entries: [{ key: 'spmc', canonicalName: 'Southern Philippines Medical Center', aliases: ['SPMC'], tier: 'public', category: 'hospital', effectiveFrom: '1970-01-01' }],
  rules: [{ key: 'district-health-units', match: 'district health unit', tier: 'public', category: 'district_health_unit', effectiveFrom: '1970-01-01' }],
};
const evidence = (overrides = {}) => ({
  facilityName: 'SPMC', facilityTier: 'private', receiptDate: '2026-09-01',
  referenceNumber: 'R-001', receiptDocumentId: 'receipt-1', ...overrides,
});

test('resolves SPMC and district health units as public without trusting a supplied tier', () => {
  const spmc = resolveFacilityEvidence({ evidence: evidence(), directoryVersion: publicDirectory, now: '2026-09-24T00:00:00Z' });
  assert.equal(spmc.outcome, 'resolved');
  assert.equal(spmc.facility.tier, 'public');
  assert.equal(spmc.reasonCode, FacilityReasonCode.PUBLIC);

  const district = resolveFacilityEvidence({
    evidence: evidence({ facilityName: 'Buhangin District Health Unit' }),
    directoryVersion: publicDirectory, now: '2026-09-24T00:00:00Z',
  });
  assert.equal(district.facility.tier, 'public');
  assert.equal(district.facility.category, 'district_health_unit');
});

test('routes unknown and stale evidence without inventing private partners', () => {
  const unknown = resolveFacilityEvidence({ evidence: evidence({ facilityName: 'Unlisted Private Clinic' }), directoryVersion: publicDirectory, now: '2026-09-24T00:00:00Z' });
  assert.equal(unknown.outcome, 'human_review_required');
  assert.ok(unknown.reasonCodes.includes(FacilityReasonCode.PRIVATE_LIST_PENDING));
  const stale = resolveFacilityEvidence({ evidence: evidence({ receiptDate: '2024-01-01' }), directoryVersion: publicDirectory, now: '2026-09-24T00:00:00Z' });
  assert.equal(stale.outcome, 'correction_required');
  assert.equal(stale.reasonCode, FacilityReasonCode.STALE);
});

test('requires the complete authoritative 42-partner list and effective dates', () => {
  assert.throws(() => validateFacilityDirectory({
    entries: [{ key: 'one', canonicalName: 'One Clinic', tier: 'private', category: 'clinic', effectiveFrom: '2026-01-01' }],
    clientApprovalReference: 'CLIENT-1',
  }), /complete authoritative list of 42 partners/);
  const entries = Array.from({ length: 42 }, (_, index) => ({
    key: `partner-${index + 1}`, canonicalName: `Partner ${index + 1}`,
    tier: 'private', category: index === 0 ? 'clinic' : 'pharmacy', effectiveFrom: '2026-01-01',
  }));
  assert.equal(validateFacilityDirectory({ entries, clientApprovalReference: 'CLIENT-APPROVAL-42' }).privatePartnerCount, 42);
  const privateClinic = resolveFacilityEvidence({
    evidence: evidence({ facilityName: 'Partner 1' }),
    directoryVersion: { entries, clientApprovalReference: 'CLIENT-APPROVAL-42' },
    now: '2026-09-24T00:00:00Z',
  });
  assert.equal(privateClinic.facility.tier, 'private');
  assert.equal(privateClinic.facility.category, 'clinic');
});

test('keeps private-prescription pricing locked until CHO approval', () => {
  const base = { facilityTier: 'private', prescriberCategory: 'clinic', prescriptionDocumentId: 'prescription-1' };
  assert.deepEqual(privatePrescriptionPricingState({ ...base, choStatus: null }), { status: 'locked', reasonCode: FacilityReasonCode.CHO_PENDING });
  assert.deepEqual(privatePrescriptionPricingState({ ...base, choStatus: 'approved' }), { status: 'unlocked', reasonCode: FacilityReasonCode.CHO_APPROVED });
  assert.deepEqual(privatePrescriptionPricingState({ ...base, choStatus: 'rejected' }), { status: 'locked', reasonCode: FacilityReasonCode.CHO_REJECTED });
});

test('enforces facility-directory and CHO permissions', () => {
  assert.equal(hasPermission(Roles.CITIZEN, Permissions.FACILITY_DIRECTORY_VIEW), false);
  assert.equal(hasPermission(Roles.CASE_WORKER, Permissions.FACILITY_DIRECTORY_VIEW), true);
  assert.equal(hasPermission(Roles.CASE_WORKER, Permissions.FACILITY_DIRECTORY_MANAGE), false);
  assert.equal(hasPermission(Roles.CASE_WORKER, Permissions.CHO_PRESCRIPTION_VALIDATE), true);
  assert.equal(hasPermission(Roles.SYSTEM_ADMINISTRATOR, Permissions.FACILITY_DIRECTORY_MANAGE), true);
  assert.equal(hasPermission(Roles.SYSTEM_ADMINISTRATOR, Permissions.CHO_CAPABILITY_MANAGE), true);
});

test('schema migration creates immutable directory, resolution, capability, and CHO event storage', async () => {
  const sql = await fs.readFile(new URL('./storage/migrations/006_facility_classification_and_cho_routing.sql', import.meta.url), 'utf8');
  for (const required of [
    'facility_directory_versions', 'prevent_facility_directory_mutation',
    'Southern Philippines Medical Center', 'district health unit',
    'facility_resolution_results', 'staff_capabilities',
    'private_prescription_validation_events', 'partner_pricing_status',
  ]) assert.match(sql, new RegExp(required, 'i'));
});
