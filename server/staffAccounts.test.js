import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let server;
let baseUrl;
let testRoot;

before(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'aidlink-staff-'));
  process.env.AIDLINK_DATA_PATH = path.join(testRoot, 'data.json');
  process.env.AIDLINK_UPLOADS_PATH = path.join(testRoot, 'uploads');
  await writeFile(process.env.AIDLINK_DATA_PATH, JSON.stringify({
    authUsers: [
      {
        id: 'auth-root', fullName: 'Root Administrator', email: 'root@example.com',
        password: 'root-password', role: 'Administrator', registeredDate: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'auth-reviewer', fullName: 'Existing Reviewer', email: 'reviewer@example.com',
        password: 'reviewer-password', role: 'Reviewer', registeredDate: '2026-01-02T00:00:00.000Z',
      },
    ],
    users: [], applicants: [], requests: [], notifications: [], facilities: [],
    auditLogs: [], requiredDocuments: {}, nextAuthUserId: 3, nextUserId: 1,
    nextApplicantId: 1, nextRequestId: 1, nextNotificationId: 1, nextAuditId: 1,
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
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, body: await response.json() };
}

async function login(email, password) {
  return request('/api/auth/login', { method: 'POST', body: { email, password } });
}

test('public staff registration is disabled and staff management requires a System Administrator', async () => {
  const publicRegistration = await request('/api/auth/register', {
    method: 'POST',
    body: { fullName: 'Public User', email: 'public@example.com', password: 'public-password' },
  });
  assert.equal(publicRegistration.response.status, 403);
  assert.match(publicRegistration.body.message, /public staff registration is disabled/i);

  const rootLogin = await login('root@example.com', 'root-password');
  assert.equal(rootLogin.response.status, 200);
  assert.equal(rootLogin.body.user.role, 'System Administrator');
  const rootToken = rootLogin.body.token;

  const reviewerLogin = await login('reviewer@example.com', 'reviewer-password');
  assert.equal(reviewerLogin.response.status, 200);
  assert.equal(reviewerLogin.body.user.role, 'Case Worker');
  const reviewerToken = reviewerLogin.body.token;
  const reviewerDenied = await request('/api/staff', { token: reviewerToken });
  assert.equal(reviewerDenied.response.status, 403);
  const unauthenticatedDenied = await request('/api/staff', {
    method: 'POST',
    body: { fullName: 'No Token', email: 'none@example.com', password: 'password-123', role: 'Reviewer' },
  });
  assert.equal(unauthenticatedDenied.response.status, 401);

  const created = await request('/api/staff', {
    method: 'POST',
    token: rootToken,
    body: {
      fullName: 'Managed Staff',
      email: 'managed@example.com',
      password: 'temporary-password',
      role: 'Case Worker',
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.active, true);
  assert.equal(created.body.role, 'Case Worker');
  assert.equal(created.body.passwordHash, undefined);

  const caseWorkerLogin = await login('managed@example.com', 'temporary-password');
  assert.equal(caseWorkerLogin.response.status, 200);
  const caseWorkerToken = caseWorkerLogin.body.token;
  assert.equal((await request('/api/staff', { token: caseWorkerToken })).response.status, 403);
  assert.equal((await request('/api/staff', {
    method: 'POST',
    token: caseWorkerToken,
    body: { fullName: 'Forbidden Creation', email: 'forbidden@example.com', password: 'password-123', role: 'Case Worker' },
  })).response.status, 403);

  const assigned = await request(`/api/staff/${created.body.id}/role`, {
    method: 'PUT', token: rootToken, body: { role: 'System Administrator' },
  });
  assert.equal(assigned.response.status, 200);
  assert.equal(assigned.body.role, 'System Administrator');

  const initialManagedLogin = await login('managed@example.com', 'temporary-password');
  assert.equal(initialManagedLogin.response.status, 200);
  const oldManagedToken = initialManagedLogin.body.token;
  const reset = await request(`/api/staff/${created.body.id}/reset-password`, {
    method: 'POST', token: rootToken, body: { password: 'replacement-password' },
  });
  assert.equal(reset.response.status, 200);
  const invalidatedSession = await request('/api/requests', { token: oldManagedToken });
  assert.equal(invalidatedSession.response.status, 401);
  assert.equal((await login('managed@example.com', 'temporary-password')).response.status, 401);

  const newManagedLogin = await login('managed@example.com', 'replacement-password');
  assert.equal(newManagedLogin.response.status, 200);
  const newManagedToken = newManagedLogin.body.token;
  const deactivated = await request(`/api/staff/${created.body.id}/status`, {
    method: 'PATCH', token: rootToken, body: { active: false },
  });
  assert.equal(deactivated.response.status, 200);
  assert.equal(deactivated.body.active, false);
  assert.equal((await request('/api/requests', { token: newManagedToken })).response.status, 403);
  assert.equal((await login('managed@example.com', 'replacement-password')).response.status, 403);

  const reactivated = await request(`/api/staff/${created.body.id}/status`, {
    method: 'PATCH', token: rootToken, body: { active: true },
  });
  assert.equal(reactivated.response.status, 200);
  assert.equal((await login('managed@example.com', 'replacement-password')).response.status, 200);

  const selfDeactivation = await request('/api/staff/auth-root/status', {
    method: 'PATCH', token: rootToken, body: { active: false },
  });
  assert.equal(selfDeactivation.response.status, 400);

  const data = JSON.parse(await readFile(process.env.AIDLINK_DATA_PATH, 'utf8'));
  assert.equal(data.authUsers.some((user) => user.email === 'public@example.com'), false);
  const staffAudit = data.auditLogs.filter((entry) => entry.action.startsWith('staff_'));
  assert.deepEqual(staffAudit.map((entry) => entry.action), [
    'staff_created',
    'staff_role_changed',
    'staff_password_reset',
    'staff_deactivated',
    'staff_activated',
  ]);
  assert.ok(staffAudit.every((entry) => entry.performedById === 'auth-root'));
  assert.ok(data.auditLogs.some((entry) => entry.action === 'login_succeeded'));
  assert.ok(data.auditLogs.some((entry) => entry.action === 'login_failed'));
  assert.ok(data.auditLogs.every((entry) => entry.actor && entry.affectedRecord && entry.timestamp && entry.details));
});
