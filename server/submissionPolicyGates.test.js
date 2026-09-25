import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  evaluateSubmissionPolicyGates,
  patientIdentityKey,
  SubmissionGateOutcome,
  SubmissionGateReasonCode,
  validateResidencyBoundary,
} from './services/submissionPolicyGateService.js';

const receiptType = 'Recent facility receipt or billing document';
const validInput = (overrides = {}) => ({
  applicantId: 'applicant-1',
  beneficiaryType: 'other',
  beneficiary: {
    fullName: 'Patient One', dateOfBirth: '1990-01-02',
    address: 'Barangay Uno, District 1, Davao City', relationshipToApplicant: 'Parent',
  },
  assistanceType: 'Medical Assistance',
  latitude: 7.1,
  longitude: 125.6,
  documents: [{
    id: 'receipt-1', name: receiptType, documentType: receiptType,
    analysis: { accepted: true, outcome: 'accepted', documentType: receiptType },
  }],
  facilityEvidence: {
    facilityName: 'District Hospital', facilityType: 'hospital',
    receiptDate: '2026-01-03', referenceNumber: 'R-001', receiptDocumentId: 'receipt-1',
  },
  ...overrides,
});

const office = (overrides = {}) => ({
  id: 'office-1', office_type: 'district_satellite', active: true,
  residency_boundary: { barangays: ['Barangay Uno'], cities: ['Davao City'] },
  ...overrides,
});

const context = (input = validInput(), overrides = {}) => ({
  authenticatedApplicantId: 'applicant-1', input,
  originatingOffice: office(), requiredDocuments: [receiptType],
  calendarYearDocumentTypes: [receiptType], now: '2026-12-20T00:00:00.000Z',
  ...overrides,
});

test('validates authenticated ownership and beneficiary relationship', () => {
  const mismatch = evaluateSubmissionPolicyGates(context(validInput(), { authenticatedApplicantId: 'applicant-2' }));
  assert.equal(mismatch.outcome, SubmissionGateOutcome.BLOCKED);
  assert.ok(mismatch.reasonCodes.includes(SubmissionGateReasonCode.APPLICANT_MISMATCH));

  const invalidRelationship = validInput({
    beneficiaryType: 'self',
    beneficiary: { ...validInput().beneficiary, relationshipToApplicant: 'Parent' },
  });
  const relationship = evaluateSubmissionPolicyGates(context(invalidRelationship));
  assert.equal(relationship.outcome, SubmissionGateOutcome.BLOCKED);
  assert.ok(relationship.reasonCodes.includes(SubmissionGateReasonCode.BENEFICIARY_RELATIONSHIP_INVALID));
  assert.equal(patientIdentityKey(validInput().beneficiary), patientIdentityKey({ ...validInput().beneficiary, address: 'Changed address' }));
});

test('validates district satellite offices and configured address or polygon boundaries', () => {
  assert.equal(validateResidencyBoundary({ barangays: ['Barangay Uno'] }, { address: 'Barangay Uno, Davao' }).status, 'inside');
  assert.equal(validateResidencyBoundary({ barangays: ['Barangay Dos'] }, { address: 'Barangay Uno, Davao' }).status, 'outside');
  assert.equal(validateResidencyBoundary({ polygon: [[125, 7], [126, 7], [126, 8], [125, 8]] }, { longitude: 125.5, latitude: 7.5 }).status, 'inside');

  const wrongOffice = evaluateSubmissionPolicyGates(context(validInput(), { originatingOffice: office({ office_type: 'central' }) }));
  assert.equal(wrongOffice.outcome, SubmissionGateOutcome.BLOCKED);
  const ambiguousBoundary = evaluateSubmissionPolicyGates(context(validInput(), { originatingOffice: office({ residency_boundary: {} }) }));
  assert.equal(ambiguousBoundary.outcome, SubmissionGateOutcome.HUMAN_REVIEW_REQUIRED);
  const outside = evaluateSubmissionPolicyGates(context(validInput(), { originatingOffice: office({ residency_boundary: { barangays: ['Barangay Dos'] } }) }));
  assert.equal(outside.outcome, SubmissionGateOutcome.BLOCKED);
  assert.ok(outside.reasonCodes.includes(SubmissionGateReasonCode.RESIDENCY_OUTSIDE_BOUNDARY));
  const overridden = evaluateSubmissionPolicyGates(context(validInput(), {
    originatingOffice: office({ residency_boundary: { barangays: ['Barangay Dos'] } }),
    residencyOverride: { authorized: true, actorId: 'worker-1', reason: 'Verified barangay certificate.' },
  }));
  assert.equal(overridden.outcome, SubmissionGateOutcome.PASSED);
  assert.ok(overridden.reasonCodes.includes(SubmissionGateReasonCode.RESIDENCY_OVERRIDE_APPLIED));
});

test('enforces required documents, quality, receipt context, and calendar-year expiry', () => {
  const missing = evaluateSubmissionPolicyGates(context(validInput({ documents: [] })));
  assert.equal(missing.outcome, SubmissionGateOutcome.CORRECTION_REQUIRED);
  assert.ok(missing.reasonCodes.includes(SubmissionGateReasonCode.REQUIRED_DOCUMENT_MISSING));

  const poorDocument = validInput();
  poorDocument.documents[0].analysis = { accepted: false, outcome: 'rejected', documentType: receiptType };
  const poor = evaluateSubmissionPolicyGates(context(poorDocument));
  assert.equal(poor.outcome, SubmissionGateOutcome.CORRECTION_REQUIRED);
  assert.ok(poor.reasonCodes.includes(SubmissionGateReasonCode.DOCUMENT_QUALITY_FAILED));

  const januaryInDecember = evaluateSubmissionPolicyGates(context(validInput()));
  assert.equal(januaryInDecember.outcome, SubmissionGateOutcome.PASSED);
  const afterBoundary = evaluateSubmissionPolicyGates(context(validInput(), { now: '2027-01-01T00:00:00.000Z' }));
  assert.equal(afterBoundary.outcome, SubmissionGateOutcome.CORRECTION_REQUIRED);
  assert.ok(afterBoundary.reasonCodes.includes(SubmissionGateReasonCode.DOCUMENT_YEAR_EXPIRED));

  const wrongReceipt = validInput({ facilityEvidence: { ...validInput().facilityEvidence, receiptDocumentId: 'missing' } });
  assert.ok(evaluateSubmissionPolicyGates(context(wrongReceipt)).reasonCodes.includes(SubmissionGateReasonCode.RECEIPT_CONTEXT_INVALID));
});

test('returns the existing reference or cooldown end without making an approval decision', () => {
  const duplicate = evaluateSubmissionPolicyGates(context(validInput(), {
    existingActiveRequest: { request_number: 'LINGAP-2026-00009', status: 'pending' },
  }));
  assert.equal(duplicate.outcome, SubmissionGateOutcome.BLOCKED);
  assert.equal(duplicate.existingRequestReference, 'LINGAP-2026-00009');

  const cooldown = evaluateSubmissionPolicyGates(context(validInput(), { cooldownEndDate: '2026-12-31T00:00:00.000Z' }));
  assert.equal(cooldown.outcome, SubmissionGateOutcome.BLOCKED);
  assert.equal(cooldown.cooldownEndDate, '2026-12-31T00:00:00.000Z');
  assert.equal(Object.hasOwn(cooldown, 'approvalStatus'), false);

  const expired = evaluateSubmissionPolicyGates(context(validInput(), { cooldownEndDate: '2026-12-19T00:00:00.000Z' }));
  assert.equal(expired.outcome, SubmissionGateOutcome.PASSED);
});

test('schema migration creates transactional gate, guard, override, and office-boundary storage', async () => {
  const sql = await fs.readFile(new URL('./storage/migrations/004_submission_policy_gates.sql', import.meta.url), 'utf8');
  for (const required of [
    'residency_boundary', 'originating_office_id', 'patient_identity_key',
    'request_submission_guards', 'submission_policy_gate_evaluations',
    'submission_policy_gate_overrides', 'cooldown_end_date', 'submission_gates:global:v1',
  ]) assert.match(sql, new RegExp(required, 'i'));
});
