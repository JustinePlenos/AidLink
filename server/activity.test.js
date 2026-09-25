import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let server;
let baseUrl;
let testRoot;

before(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'aidlink-activity-'));
  process.env.AIDLINK_DATA_PATH = path.join(testRoot, 'data.json');
  process.env.AIDLINK_UPLOADS_PATH = path.join(testRoot, 'uploads');
  process.env.AIDLINK_MFA_AUDIT_SECRET = 'activity-test-provider-secret';
  await writeFile(process.env.AIDLINK_DATA_PATH, JSON.stringify({
    authUsers: [
      { id: 'system-1', fullName: 'System Administrator', email: 'system@example.com', password: 'system-pass', role: 'System Administrator' },
      { id: 'worker-1', fullName: 'Case Worker', email: 'worker@example.com', password: 'worker-pass', role: 'Case Worker' },
    ],
    applicants: [], users: [], notifications: [], facilities: [], requiredDocuments: {},
    requests: [{
      id: 'request-1', requestId: 'LINGAP-2026-00001', applicantName: 'Audit Applicant', email: 'audit@example.com',
      phone: '09170000000', address: 'Davao City', dateOfBirth: '1990-01-01', assistanceType: 'Hospital Assistance',
      incomeSource: 'Salary or wages', patientCircumstance: 'Disease', documents: [], status: 'pending',
      assignedCaseWorkerId: 'worker-1', dateSubmitted: '2026-09-14T00:00:00.000Z',
    }],
    auditLogs: [],
    nextAuthUserId: 3, nextApplicantId: 1, nextUserId: 1, nextRequestId: 2, nextNotificationId: 1, nextAuditId: 1,
  }));
  const { app } = await import('./server.js');
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

async function request(route, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, body: await response.json() };
}

async function login(email, password) {
  const result = await request('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(result.response.status, 200);
  return result.body.token;
}

test('records and returns a normalized administrator-only activity ledger', async () => {
  const mfaEvent = async (action, details) => fetch(`${baseUrl}/api/internal/mfa-events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-aidlink-mfa-audit-secret': 'activity-test-provider-secret' },
    body: JSON.stringify({ action, actorId: 'system-1', targetStaffId: 'system-1', ...details }),
  });
  assert.equal((await fetch(`${baseUrl}/api/internal/mfa-events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-aidlink-mfa-audit-secret': 'wrong-secret' }, body: JSON.stringify({ action: 'mfa_enrolled', actorId: 'system-1' }) })).status, 401);
  assert.equal((await mfaEvent('mfa_enrolled', { method: 'totp', provider: 'test-provider' })).status, 201);
  assert.equal((await mfaEvent('mfa_recovery_completed', { recoveryMethod: 'recovery_code', outcome: 'success' })).status, 201);

  const systemToken = await login('system@example.com', 'system-pass');
  const workerToken = await login('worker@example.com', 'worker-pass');

  assert.equal((await request('/api/audit-logs', { token: workerToken })).response.status, 403);

  const staff = await request('/api/staff', {
    method: 'POST', token: systemToken,
    body: { fullName: 'Temporary Worker', email: 'temporary@example.com', password: 'temporary-pass', role: 'Case Worker' },
  });
  assert.equal(staff.response.status, 201);
  assert.equal((await request(`/api/staff/${staff.body.id}/role`, { method: 'PUT', token: systemToken, body: { role: 'System Administrator' } })).response.status, 200);
  assert.equal((await request(`/api/staff/${staff.body.id}/status`, { method: 'PATCH', token: systemToken, body: { active: false } })).response.status, 200);

  assert.equal((await request('/api/requests/request-1/status', { method: 'PUT', token: workerToken, body: { status: 'under_review', remarks: 'Audit document review completed.' } })).response.status, 200);
  assert.equal((await request('/api/system/settings', { method: 'PUT', token: systemToken, body: { organizationName: 'Audit LINGAP', notificationPollingSeconds: 45, receiptValidityDays: 365 } })).response.status, 200);

  const registration = await request('/api/applicant/auth/register', { method: 'POST', body: { fullName: 'Document Applicant', email: 'document@example.com', phone: '09170000001', address: 'Davao City', dateOfBirth: '1990-01-01', password: 'applicant-pass' } });
  assert.equal(registration.response.status, 201);
  const identityForm = new FormData();
  identityForm.append('document', new Blob([Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF')], { type: 'application/pdf' }), 'government-id.pdf');
  const identityUpload = await fetch(`${baseUrl}/api/applicant/identity-verification/document`, { method: 'POST', headers: { Authorization: `Bearer ${registration.body.token}` }, body: identityForm });
  assert.equal(identityUpload.status, 201);
  const applicantId = (await identityUpload.json()).applicantId;
  assert.equal((await request(`/api/applicant-verifications/${applicantId}/decision`, { method: 'PUT', token: workerToken, body: { decision: 'approved', notes: 'Case Workers cannot approve identity.' } })).response.status, 403);
  assert.equal((await request(`/api/applicant-verifications/${applicantId}/decision`, { method: 'PUT', token: systemToken, body: { decision: 'approved', notes: 'Government ID reviewed for the audit test.' } })).response.status, 200);
  const documentForm = new FormData();
  documentForm.append('documentType', 'Valid ID');
  documentForm.append('documents', new Blob([Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF')], { type: 'application/pdf' }), 'valid-id.pdf');
  const uploaded = await fetch(`${baseUrl}/api/applicant/documents`, { method: 'POST', headers: { Authorization: `Bearer ${registration.body.token}` }, body: documentForm });
  assert.equal(uploaded.status, 201);

  assert.equal((await request('/api/reports/summary', { token: systemToken })).response.status, 200);
  assert.equal((await request('/api/reports/export', { method: 'POST', token: systemToken })).response.status, 200);
  assert.equal((await request('/api/auth/logout', { method: 'POST', token: systemToken })).response.status, 200);

  const activity = await request('/api/audit-logs', { token: systemToken });
  assert.equal(activity.response.status, 200);
  const actions = new Set(activity.body.map((entry) => entry.action));
  for (const action of ['mfa_enrolled', 'mfa_recovery_completed', 'login_succeeded', 'logout', 'staff_created', 'staff_role_changed', 'staff_deactivated', 'status_updated', 'document_uploaded', 'applicant_id_uploaded', 'applicant_id_approved', 'applicant_account_status_changed', 'system_settings_updated', 'report_generated', 'report_exported']) {
    assert.equal(actions.has(action), true, action);
  }
  for (const entry of activity.body) {
    assert.equal(typeof entry.actor.name, 'string');
    assert.equal(typeof entry.action, 'string');
    assert.equal(typeof entry.affectedRecord.type, 'string');
    assert.equal(typeof entry.affectedRecord.label, 'string');
    assert.equal(typeof entry.timestamp, 'string');
    assert.equal(typeof entry.details, 'object');
  }
});
