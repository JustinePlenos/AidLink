import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { hasPermission, Permissions, Roles } from './security/permissions.js';

test('workflow evaluation and confirmation permissions stay separate from applicants', () => {
  assert.equal(hasPermission(Roles.CASE_WORKER, Permissions.POLICY_EVALUATE), true);
  assert.equal(hasPermission(Roles.CASE_WORKER, Permissions.REQUESTS_PROCESS), true);
  assert.equal(hasPermission(Roles.CITIZEN, Permissions.POLICY_EVALUATE), false);
  assert.equal(hasPermission(Roles.CITIZEN, Permissions.REQUESTS_PROCESS), false);
});

test('staff workflow routes require authentication, permission, request scope, and remarks', async () => {
  const source = await fs.readFile(new URL('./server.js', import.meta.url), 'utf8');
  const evaluationRoute = source.slice(
    source.indexOf("app.post('/api/requests/:id/workflow-evaluation'"),
    source.indexOf("app.post('/api/requests/:id/workflow-evaluations/:evaluationId/confirm'"),
  );
  const confirmationRoute = source.slice(
    source.indexOf("app.post('/api/requests/:id/workflow-evaluations/:evaluationId/confirm'"),
    source.indexOf("app.get('/api/requests/:id/workflow-evaluations'"),
  );
  assert.match(evaluationRoute, /requireAuth, requirePermission\(Permissions\.POLICY_EVALUATE\)/);
  assert.match(evaluationRoute, /requestIsPermittedForStaff/);
  assert.match(evaluationRoute, /remarks\.length < 10/);
  assert.match(confirmationRoute, /requireAuth, requirePermission\(Permissions\.REQUESTS_PROCESS\)/);
  assert.match(confirmationRoute, /requestIsPermittedForStaff/);
  assert.match(confirmationRoute, /request\.status !== 'under_review'/);
  assert.doesNotMatch(evaluationRoute, /request\.status\s*=\s*['"]approved/);
});

test('approval re-evaluates the confirmed inputs before changing request status', async () => {
  const source = await fs.readFile(new URL('./server.js', import.meta.url), 'utf8');
  const handlerStart = source.indexOf("app.put('/api/requests/:id/status'");
  const handlerEnd = source.indexOf("app.post('/api/requests/:id/workflow-evaluation'", handlerStart);
  const handler = source.slice(handlerStart, handlerEnd > handlerStart ? handlerEnd : handlerStart + 30000);
  const validationIndex = handler.indexOf('workflow.validateForApproval');
  const statusAssignmentIndex = handler.indexOf('request.status = status');
  assert.ok(validationIndex >= 0, 'approval handler must validate the confirmed workflow evaluation');
  assert.ok(statusAssignmentIndex > validationIndex, 'request status must change only after workflow validation');
  assert.match(handler, /WORKFLOW_EVALUATION_CHANGED|workflowValidation\.code/);
});

test('workflow evaluations and confirmations are immutable and fingerprinted', async () => {
  const migration = await fs.readFile(new URL('./storage/migrations/009_staff_policy_workflow.sql', import.meta.url), 'utf8');
  const repository = await fs.readFile(new URL('./storage/workflowRepository.js', import.meta.url), 'utf8');
  for (const expected of [
    'workflow_policy_evaluations',
    'workflow_evaluation_confirmations',
    'input_fingerprint',
    'prevent_workflow_evaluation_mutation',
    'WORKFLOW_EVALUATION_CHANGED',
  ]) assert.match(migration, new RegExp(expected));
  for (const changedInput of ['documents', 'hardPolicy', 'coveragePolicy', 'coverageInput', 'budget']) {
    assert.match(repository, new RegExp(changedInput));
  }
  assert.match(repository, /confirmed\.input_fingerprint !== current\.inputFingerprint/);
  assert.match(repository, /code: 'WORKFLOW_EVALUATION_CHANGED'/);
});
