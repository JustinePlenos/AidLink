import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  evaluateHardDisqualifiers,
  HardDisqualifierEvidenceRule,
  HardDisqualifierOutcome,
  HardDisqualifierReasonCode,
  validateHardDisqualifierEvidence,
  validateHardDisqualifierPolicyConfiguration,
} from './services/hardDisqualifierService.js';
import { hasPermission, Permissions } from './security/permissions.js';

const request = (patientCircumstance = 'Accident') => ({ id: 'request-1', patient_circumstance: patientCircumstance });
const policy = (armedGroup = { enabled: false }) => ({
  id: 'hard-policy-1', policy_version: 'hard_disqualifiers:global:v1',
  configuration: { rules: { armedGroup } },
});
const evidence = (ruleCode, evidenceType, findings, overrides = {}) => ({
  id: `evidence-${ruleCode}`, rule_code: ruleCode, evidence_type: evidenceType,
  source_authority: 'Authorized agency', source_reference: 'REF-001', evidence_document_id: 'document-1',
  findings, authorized: true, recorded_at: '2026-09-24T00:00:00.000Z', ...overrides,
});

test('motorcycle claims require an authorized police or traffic report and block no-helmet findings', () => {
  const missing = evaluateHardDisqualifiers({ request: request(), policy: policy(), evidence: [] });
  assert.equal(missing.outcome, HardDisqualifierOutcome.HUMAN_REVIEW_REQUIRED);
  assert.deepEqual(missing.reasonCodes, [HardDisqualifierReasonCode.MOTORCYCLE_DETAILS_REQUIRED]);
  assert.equal(missing.approvalAllowed, false);

  const noHelmet = evaluateHardDisqualifiers({ request: request(), policy: policy(), evidence: [
    evidence(HardDisqualifierEvidenceRule.MOTORCYCLE_HELMET, 'police_accident_report', { incidentType: 'motorcycle_accident', helmetStatus: 'not_worn' }),
  ] });
  assert.equal(noHelmet.outcome, HardDisqualifierOutcome.BLOCKED);
  assert.deepEqual(noHelmet.reasonCodes, [HardDisqualifierReasonCode.NO_HELMET]);
  assert.match(noHelmet.findings[0].message, /authorized accident report/i);

  const helmetWorn = evaluateHardDisqualifiers({ request: request(), policy: policy(), evidence: [
    evidence(HardDisqualifierEvidenceRule.MOTORCYCLE_HELMET, 'traffic_accident_report', { incidentType: 'motorcycle_accident', helmetStatus: 'worn' }),
  ] });
  assert.equal(helmetWorn.outcome, HardDisqualifierOutcome.CLEAR);
  assert.equal(helmetWorn.approvalAllowed, true);
});

test('non-motorcycle accidents and non-accident requests do not receive false no-helmet findings', () => {
  const otherAccident = evaluateHardDisqualifiers({ request: request(), policy: policy(), evidence: [
    evidence(HardDisqualifierEvidenceRule.MOTORCYCLE_HELMET, 'traffic_accident_report', { incidentType: 'other_accident', helmetStatus: 'not_applicable' }),
  ] });
  assert.equal(otherAccident.outcome, HardDisqualifierOutcome.CLEAR);
  assert.equal(evaluateHardDisqualifiers({ request: request('Disease'), policy: policy(), evidence: [] }).outcome, HardDisqualifierOutcome.CLEAR);
});

test('DUI and dangerous-drug impairment require explicit authorized evidence', () => {
  for (const impairmentStatus of ['dui', 'dangerous_drug']) {
    const result = evaluateHardDisqualifiers({ request: request('Injury'), policy: policy(), evidence: [
      evidence(HardDisqualifierEvidenceRule.IMPAIRMENT, 'toxicology_report', { impairmentStatus }),
    ] });
    assert.equal(result.outcome, HardDisqualifierOutcome.BLOCKED);
    assert.ok(result.reasonCodes.includes(HardDisqualifierReasonCode.IMPAIRMENT));
  }
  const allegationOnly = evidence(HardDisqualifierEvidenceRule.IMPAIRMENT, 'toxicology_report', { impairmentStatus: 'dui' }, { authorized: false });
  assert.equal(evaluateHardDisqualifiers({ request: request('Injury'), policy: policy(), evidence: [allegationOnly] }).outcome, HardDisqualifierOutcome.CLEAR);
});

test('active-crime rule uses only authorized law-enforcement or court evidence', () => {
  assert.throws(() => validateHardDisqualifierEvidence({
    ruleCode: HardDisqualifierEvidenceRule.ACTIVE_CRIME, evidenceType: 'police_accident_report',
    sourceAuthority: 'Someone', sourceReference: 'claim', documentId: 'document-1', findings: { offenseStatus: 'active' },
  }), /not authorized/i);
  const active = evaluateHardDisqualifiers({ request: request('Injury'), policy: policy(), evidence: [
    evidence(HardDisqualifierEvidenceRule.ACTIVE_CRIME, 'court_record', { offenseStatus: 'active' }),
  ] });
  assert.equal(active.outcome, HardDisqualifierOutcome.BLOCKED);
  assert.ok(active.reasonCodes.includes(HardDisqualifierReasonCode.ACTIVE_CRIME));
  const unverified = evidence(HardDisqualifierEvidenceRule.ACTIVE_CRIME, 'court_record', { offenseStatus: 'active' }, { authorized: false });
  assert.equal(evaluateHardDisqualifiers({ request: request('Injury'), policy: policy(), evidence: [unverified] }).outcome, HardDisqualifierOutcome.CLEAR);
});

test('armed-group restriction stays disabled until client and legal approval and never accepts sensitive attributes', () => {
  const decision = evidence(HardDisqualifierEvidenceRule.ARMED_GROUP, 'authorized_restriction_decision', { decision: 'restricted' });
  assert.equal(evaluateHardDisqualifiers({ request: request('Injury'), policy: policy(), evidence: [decision] }).outcome, HardDisqualifierOutcome.CLEAR);
  assert.throws(() => validateHardDisqualifierPolicyConfiguration({ rules: { armedGroup: { enabled: true } } }), /client approval reference/i);
  assert.throws(() => validateHardDisqualifierEvidence({
    ruleCode: HardDisqualifierEvidenceRule.ARMED_GROUP, evidenceType: 'authorized_restriction_decision',
    sourceAuthority: 'Approved panel', sourceReference: 'DEC-1', documentId: 'document-1',
    findings: { decision: 'restricted', groupName: 'must-not-be-stored' },
  }), /not permitted/i);
  const approvedPolicy = policy({ enabled: true, clientApprovalReference: 'CLIENT-1', legalApprovalReference: 'LEGAL-1', authorizedDecisionProcess: 'Documented panel decision v1' });
  const result = evaluateHardDisqualifiers({ request: request('Injury'), policy: approvedPolicy, evidence: [decision] });
  assert.equal(result.outcome, HardDisqualifierOutcome.BLOCKED);
  assert.ok(result.reasonCodes.includes(HardDisqualifierReasonCode.ARMED_GROUP));
});

test('ordinary Case Workers cannot make hard-disqualifier exceptions', () => {
  assert.equal(hasPermission('Case Worker', Permissions.HARD_DISQUALIFIER_EVIDENCE), true);
  assert.equal(hasPermission('Case Worker', Permissions.HARD_DISQUALIFIER_EVALUATE), true);
  assert.equal(hasPermission('Case Worker', Permissions.HARD_DISQUALIFIER_EXCEPTION), false);
  assert.equal(hasPermission('System Administrator', Permissions.HARD_DISQUALIFIER_EXCEPTION), true);
});

test('migration makes evidence, evaluations, exceptions, and audit history immutable and orders evaluation before coverage', async () => {
  const migration = await fs.readFile(new URL('./storage/migrations/007_hard_disqualifiers.sql', import.meta.url), 'utf8');
  for (const expected of ['hard_disqualifier_evidence', 'hard_disqualifier_evaluations', 'hard_disqualifier_exceptions', 'prevent_hard_disqualifier_event_mutation', 'hard_disqualifier_exception', 'armedGroup', '"enabled":false']) assert.match(migration, new RegExp(expected));
  const repositories = await fs.readFile(new URL('./storage/postgresRepositories.js', import.meta.url), 'utf8');
  const method = repositories.slice(repositories.indexOf('async recordDecision(input)'), repositories.indexOf('async releaseGuaranteeLetter(input)'));
  assert.ok(method.indexOf('evaluateHardDisqualifierInTransaction') < method.indexOf('INSERT INTO coverage_decisions'));
  assert.doesNotMatch(method, /reserveBudgetInTransaction/, 'approval must not reserve city funds before Guarantee Letter release');
});
