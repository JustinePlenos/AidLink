import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let server;
let baseUrl;
let testRoot;

before(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'aidlink-rbac-'));
  process.env.AIDLINK_DATA_PATH = path.join(testRoot, 'data.json');
  process.env.AIDLINK_UPLOADS_PATH = path.join(testRoot, 'uploads');
  const request = (id, email, assignment = {}) => ({
    id,
    requestId: `LINGAP-2026-${id.slice(-1).padStart(5, '0')}`,
    applicantName: id,
    email,
    phone: '09170000000',
    address: 'Davao City',
    dateOfBirth: '1990-01-01',
    assistanceType: 'Hospital Assistance',
    incomeSource: 'Salary or wages',
    patientCircumstance: 'Disease',
    documents: [],
    status: 'pending',
    dateSubmitted: '2026-09-13T00:00:00.000Z',
    ...assignment,
  });
  await writeFile(process.env.AIDLINK_DATA_PATH, JSON.stringify({
    authUsers: [
      { id: 'auth-system', fullName: 'System Administrator', email: 'system@example.com', password: 'system-password', role: 'System Administrator' },
      { id: 'auth-worker', fullName: 'Assigned Worker', email: 'worker@example.com', password: 'worker-password', role: 'Case Worker' },
      { id: 'auth-other', fullName: 'Other Worker', email: 'other@example.com', password: 'other-password', role: 'Case Worker' },
    ],
    users: [
      { id: 'user-1', name: 'request-1', email: 'one@example.com', phone: '', address: '', dateOfBirth: '', registeredDate: '', totalApplications: 1 },
      { id: 'user-2', name: 'request-2', email: 'two@example.com', phone: '', address: '', dateOfBirth: '', registeredDate: '', totalApplications: 1 },
      { id: 'user-3', name: 'request-3', email: 'three@example.com', phone: '', address: '', dateOfBirth: '', registeredDate: '', totalApplications: 1 },
    ],
    applicants: [],
    requests: [
      request('request-1', 'one@example.com'),
      request('request-2', 'two@example.com', { assignedCaseWorkerId: 'auth-worker' }),
      request('request-3', 'three@example.com', { assignedCaseWorkerId: 'auth-other' }),
    ],
    notifications: [], facilities: [], auditLogs: [], requiredDocuments: {},
    nextAuthUserId: 4, nextUserId: 4, nextApplicantId: 1, nextRequestId: 4,
    nextNotificationId: 1, nextAuditId: 1,
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

async function jsonRequest(route, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, body: await response.json() };
}

async function login(email, password) {
  const result = await jsonRequest('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(result.response.status, 200);
  return result.body.token;
}

test('separates request processing from system administration at every backend boundary', async () => {
  const workerToken = await login('worker@example.com', 'worker-password');
  const systemToken = await login('system@example.com', 'system-password');

  const workerRequests = await jsonRequest('/api/requests', { token: workerToken });
  assert.equal(workerRequests.response.status, 200);
  assert.deepEqual(workerRequests.body.map((item) => item.id).sort(), ['request-1', 'request-2']);
  assert.equal((await jsonRequest('/api/requests/request-3', { token: workerToken })).response.status, 404);

  const reviewed = await jsonRequest('/api/requests/request-2/status', {
    method: 'PUT', token: workerToken,
    body: { status: 'under_review', remarks: 'Documents reviewed by the assigned Case Worker.' },
  });
  assert.equal(reviewed.response.status, 200);
  assert.equal((await jsonRequest('/api/requests/request-2/audit', { token: workerToken })).response.status, 200);
  assert.equal((await jsonRequest('/api/users', { token: workerToken })).body.length, 2);

  for (const route of ['/api/staff', '/api/system/configuration', '/api/system/settings', '/api/audit-logs', '/api/reports/summary']) {
    assert.equal((await jsonRequest(route, { token: workerToken })).response.status, 403, route);
  }
  const systemRequests = await jsonRequest('/api/requests', { token: systemToken });
  assert.equal(systemRequests.response.status, 200);
  assert.equal(systemRequests.body.length, 3);
  assert.equal((await jsonRequest('/api/requests/request-1/status', {
    method: 'PUT', token: systemToken,
    body: { status: 'under_review', remarks: 'System administrators do not process requests.' },
  })).response.status, 403);

  assert.equal((await jsonRequest('/api/staff', { token: systemToken })).response.status, 200);
  assert.equal((await jsonRequest('/api/audit-logs', { token: systemToken })).response.status, 200);
  assert.equal((await jsonRequest('/api/reports/summary', { token: systemToken })).response.status, 200);
  assert.equal((await jsonRequest('/api/system/settings', {
    method: 'PUT',
    token: systemToken,
    body: { organizationName: 'LINGAP Operations', notificationPollingSeconds: 60, receiptValidityDays: 365 },
  })).response.status, 200);
  assert.equal((await jsonRequest('/api/assistance-types/Hospital%20Assistance/status', {
    method: 'PUT', token: systemToken, body: { active: false },
  })).response.status, 200);
  const publicTypes = await jsonRequest('/api/assistance-types');
  assert.equal(publicTypes.body.includes('Hospital Assistance'), false);
  const inactiveSubmission = await jsonRequest('/api/applications', {
    method: 'POST',
    body: {
      fullName: 'Blocked Applicant',
      email: 'blocked@example.com',
      phone: '09170000000',
      address: 'Davao City',
      dateOfBirth: '1990-01-01',
      assistanceType: 'Hospital Assistance',
      incomeSource: 'Salary or wages',
      patientCircumstance: 'Disease',
      documents: [],
    },
  });
  assert.equal(inactiveSubmission.response.status, 401);
  assert.match(inactiveSubmission.body.message, /sign in again/i);
});
