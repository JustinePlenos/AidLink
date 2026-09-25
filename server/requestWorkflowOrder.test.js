import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let server;
let baseUrl;
let testRoot;

before(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'aidlink-workflow-order-'));
  process.env.AIDLINK_DATA_PATH = path.join(testRoot, 'data.json');
  process.env.AIDLINK_UPLOADS_PATH = path.join(testRoot, 'uploads');
  process.env.AIDLINK_LETTERS_PATH = path.join(testRoot, 'letters');
  const request = (id, applicantId) => ({
    id, requestId: `LINGAP-${id}`, applicantId, applicantName: applicantId, email: `${applicantId}@example.com`, phone: '09170000000', address: 'Davao', dateOfBirth: '1990-01-01',
    assistanceType: 'Hospital Assistance', incomeSource: 'Salary or wages', patientCircumstance: 'Disease', status: 'pending', assignedCaseWorkerId: 'worker-1', dateSubmitted: '2026-09-16T00:00:00.000Z',
    documents: [
      { id: `${id}-document`, name: 'valid-id.pdf', documentType: 'Valid ID', label: 'Valid ID', url: `/uploads/${id}-document.pdf`, analysis: { documentType: 'Valid ID' } },
      { id: `${id}-receipt`, name: 'receipt.pdf', documentType: 'Recent facility receipt or billing document', label: 'Recent facility receipt or billing document', url: `/uploads/${id}-receipt.pdf`, analysis: { documentType: 'Recent facility receipt or billing document' } },
    ], documentHistory: [], correctionHistory: [],
  });
  await writeFile(process.env.AIDLINK_DATA_PATH, JSON.stringify({
    authUsers: [{ id: 'worker-1', fullName: 'Case Worker', email: 'worker@example.com', password: 'worker-pass', role: 'Case Worker' }],
    applicants: [], users: [], notifications: [], facilities: [], auditLogs: [], requiredDocuments: { 'Hospital Assistance': ['Valid ID'] },
    requests: [request('pending-review', 'applicant-1'), request('correction', 'applicant-2'), request('approval', 'applicant-3'), request('denial', 'applicant-4')],
    nextAuthUserId: 2, nextApplicantId: 5, nextUserId: 1, nextRequestId: 5, nextNotificationId: 1, nextAuditId: 1,
  }));
  const { app } = await import('./server.js');
  server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

async function request(route, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { response, body: await response.json() };
}

test('enforces Step 1 transitions before Step 2 claiming preparation', async () => {
  const login = await request('/api/auth/login', { method: 'POST', body: { email: 'worker@example.com', password: 'worker-pass' } });
  assert.equal(login.response.status, 200);
  const token = login.body.token;
  const status = (id, next, remarks, extra = {}) => request(`/api/requests/${id}/status`, { method: 'PUT', token, body: { status: next, remarks, ...extra } });

  const underReview = await status('pending-review', 'under_review', 'Investigation and document review started.');
  assert.equal(underReview.response.status, 200);
  assert.equal(underReview.body.status, 'under_review');
  assert.equal(underReview.body.guaranteeLetterTracking, undefined);
  assert.equal(underReview.body.protectedLetter, null);

  assert.equal((await status('approval', 'approved', 'Attempted to skip review.')).response.status, 400);
  assert.equal((await status('approval', 'under_review', 'Eligibility review started.')).response.status, 200);
  const approved = await status('approval', 'approved', 'Eligibility review completed and approved.');
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.status, 'approved');
  assert.equal(approved.body.qrCode, null);
  assert.equal(approved.body.protectedLetter, null);

  assert.equal((await status('correction', 'under_review', 'Reviewing the submitted document.')).response.status, 200);
  const correction = await status('correction', 'correction_requested', 'Replace the incomplete ID with all edges visible.', { correctionDocumentIds: ['correction-document'] });
  assert.equal(correction.response.status, 200);
  assert.equal(correction.body.status, 'correction_requested');

  assert.equal((await status('denial', 'under_review', 'Eligibility review started.')).response.status, 200);
  const denied = await status('denial', 'denied', 'Request denied after completed eligibility review.');
  assert.equal(denied.response.status, 200);
  assert.equal(denied.body.status, 'denied');

  for (const id of ['pending-review', 'correction', 'denial']) {
    const blocked = await request(`/api/requests/${id}/guarantee-letter-tracking`, { method: 'PUT', token, body: { claimReference: 'CLAIM-1' } });
    assert.equal(blocked.response.status, 400, id);
  }
  const progressive = await request('/api/requests/approval/guarantee-letter-tracking', { method: 'PUT', token, body: { claimReference: 'CLAIM-PARTIAL' } });
  assert.equal(progressive.response.status, 200);
  assert.equal(progressive.body.status, 'approved');
  assert.equal(progressive.body.guaranteeLetterTracking.scheduledFor, '');
  const incompleteRelease = await request('/api/requests/approval/claiming/release', { method: 'POST', token });
  assert.equal(incompleteRelease.response.status, 400);
  assert.match(incompleteRelease.body.message, /complete the claiming preparation/i);
  const stillApproved = await request('/api/requests/approval', { token });
  assert.equal(stillApproved.body.status, 'approved');
  assert.equal(stillApproved.body.qrCode, null);
});
