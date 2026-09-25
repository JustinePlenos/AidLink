import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  canManageRole,
  hasPermission,
  Permissions,
  Roles,
} from './security/permissions.js';
import {
  AdvisoryPolicyEvaluator,
  evaluatePolicyOnBackend,
  normalizeLegacyPolicyMetadata,
  normalizePolicyEvaluation,
  PolicyReasonCode,
} from './services/policyEvaluationService.js';

test('enforces Citizen, Case Worker, and the combined System Administrator permissions', () => {
  assert.equal(hasPermission('Applicant', Permissions.APPLICANT_REQUESTS), true);
  assert.equal(hasPermission(Roles.CITIZEN, Permissions.POLICY_VIEW), false);
  assert.equal(hasPermission(Roles.CASE_WORKER, Permissions.REQUESTS_PROCESS), true);
  assert.equal(hasPermission(Roles.CASE_WORKER, Permissions.POLICY_CONFIGURE), false);
  assert.equal(hasPermission(Roles.SYSTEM_ADMINISTRATOR, Permissions.POLICY_CONFIGURE), true);
  assert.equal(hasPermission(Roles.SYSTEM_ADMINISTRATOR, Permissions.POLICY_EVALUATE), true);
  assert.equal(hasPermission(Roles.SYSTEM_ADMINISTRATOR, Permissions.OFFICES_MANAGE), true);
  assert.equal(hasPermission('Super Admin', Permissions.OFFICES_MANAGE), true);
  assert.equal(canManageRole(Roles.SYSTEM_ADMINISTRATOR, Roles.SYSTEM_ADMINISTRATOR), true);
});

test('backend policy evaluator is typed, advisory, and enables no blocking decisions', async () => {
  const result = await evaluatePolicyOnBackend({
    request: { id: 'request-1', assistanceType: 'Medical Assistance' },
    policy: { id: 'policy-1', policy_version: 'workflow:global:v1' },
  }, new AdvisoryPolicyEvaluator());
  assert.equal(result.policyVersion, 'workflow:global:v1');
  assert.equal(result.findings[0].code, PolicyReasonCode.FOUNDATION_ONLY);
  assert.equal(result.findings[0].blocking, false);
  assert.deepEqual(new Set(Object.values(result.decisions)), new Set(['not_evaluated']));
  assert.throws(() => normalizePolicyEvaluation({
    ...result,
    findings: [{ code: PolicyReasonCode.FOUNDATION_ONLY, blocking: true }],
  }), /Blocking policy findings are not enabled/);
});

test('legacy requests remain readable with safe policy metadata defaults', () => {
  const normalized = normalizeLegacyPolicyMetadata({
    id: 'legacy-request',
    decisionSnapshot: { policyVersion: 'legacy:v1', retained: true },
  });
  assert.equal(normalized.id, 'legacy-request');
  assert.equal(normalized.policyVersion, 'legacy:v1');
  assert.deepEqual(normalized.policyFindings, []);
  assert.deepEqual(normalized.requiredReviews, []);
  assert.equal(normalized.originatingOfficeId, null);
  assert.equal(normalized.decisionSnapshot.retained, true);
});

test('policy migration defines version history, district offices, request snapshots, and audit-ready evaluations', async () => {
  const sql = await fs.readFile(new URL('./storage/migrations/002_policy_workflow_foundation.sql', import.meta.url), 'utf8');
  for (const required of [
    'CREATE TABLE offices', 'district_satellite', 'policy_version',
    'effective_date', 'actor_id', 'old_value', 'new_value', 'justification',
    'originating_office_id', 'policy_findings', 'required_reviews',
    'decision_snapshot', 'CREATE TABLE policy_reason_codes', 'CREATE TABLE policy_evaluations',
  ]) assert.match(sql, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
});
