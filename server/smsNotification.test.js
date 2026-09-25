import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let server;
let baseUrl;
let testRoot;
let smsService;
const sends = [];

before(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'aidlink-sms-'));
  process.env.AIDLINK_DATA_PATH = path.join(testRoot, 'data.json');
  process.env.AIDLINK_UPLOADS_PATH = path.join(testRoot, 'uploads');
  process.env.AIDLINK_SMS_STATUS_SECRET = 'sms-delivery-test-secret';
  await writeFile(process.env.AIDLINK_DATA_PATH, JSON.stringify({
    authUsers: [
      { id: 'worker-1', fullName: 'Assigned Case Worker', email: 'worker@example.com', password: 'worker-pass', role: 'Case Worker' },
      { id: 'other-1', fullName: 'Other Case Worker', email: 'other@example.com', password: 'other-pass', role: 'Case Worker' },
      { id: 'admin-1', fullName: 'System Administrator', email: 'admin@example.com', password: 'admin-pass', role: 'System Administrator' },
    ],
    applicants: [], users: [], notifications: [], requests: [{
      id: 'request-1',
      requestId: 'LINGAP-2026-00001',
      applicantId: 'applicant-1',
      applicantName: 'JUAN DELA CRUZ',
      email: 'juan@example.com',
      phone: '09171234567',
      address: 'Davao City',
      dateOfBirth: '1990-01-01',
      assistanceType: 'Hospital Assistance',
      incomeSource: 'Salary or wages',
      patientCircumstance: 'Disease',
      documents: [{ id: 'request-1-receipt', name: 'receipt.pdf', documentType: 'Recent facility receipt or billing document', analysis: { documentType: 'Recent facility receipt or billing document' } }],
      status: 'under_review',
      assignedCaseWorkerId: 'worker-1',
      dateSubmitted: '2026-09-14T00:00:00.000Z',
      protectedLetter: {
        id: 'letter-sms-1', version: 1, name: 'approved-letter.pdf', sourceType: 'pdf', mimeType: 'application/pdf',
        conversionStatus: 'ready', status: 'confirmed', originalFileName: 'private-original.pdf', pdfFileName: 'private-view.pdf',
        uploaderId: 'worker-1', uploaderName: 'Assigned Case Worker', uploadedAt: '2026-09-14T01:00:00.000Z',
        approvedAt: null, qrTokenHash: null, qrExpiresAt: null,
      },
    }],
    auditLogs: [], requiredDocuments: { 'Hospital Assistance': [] }, facilities: [],
    nextAuthUserId: 4, nextApplicantId: 1, nextUserId: 1, nextRequestId: 2, nextNotificationId: 1, nextAuditId: 1,
  }));
  smsService = await import('./services/smsNotificationService.js');
  smsService.setSmsProviderAdapter({
    name: 'test-adapter',
    configured: true,
    async send(payload) {
      sends.push(payload);
      if (sends.length === 1) {
        throw new smsService.SmsProviderError('Temporary provider outage.', { code: 'temporary_outage', retryable: true });
      }
      return { status: 'sent', providerMessageId: 'provider-message-1' };
    },
  });
  const { app } = await import('./server.js');
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  smsService?.setSmsProviderAdapter(null);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

async function jsonRequest(route, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, body: await response.json() };
}

async function login(email, password) {
  const result = await jsonRequest('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(result.response.status, 200);
  return result.body.token;
}

test('queues provider-neutral approval SMS, retries transient failure, records delivery and audit status', async () => {
  const workerToken = await login('worker@example.com', 'worker-pass');
  const otherToken = await login('other@example.com', 'other-pass');
  const adminToken = await login('admin@example.com', 'admin-pass');
  const approved = await jsonRequest('/api/requests/request-1/status', {
    method: 'PUT',
    token: workerToken,
    body: {
      status: 'approved',
      remarks: 'Approved after complete review.',
    },
  });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.status, 'approved');
  assert.equal(approved.body.approvalSms, undefined);
  assert.equal(sends.length, 0, 'approval alone must not send claiming instructions');
  const tracking = await jsonRequest('/api/requests/request-1/guarantee-letter-tracking', { method: 'PUT', token: workerToken, body: {
    claimReference: 'CLAIM-2026-001', scheduledFor: '2026-09-20', claimingTime: '13:30', claimingLocation: 'LINGAP CMO Window 3', status: 'scheduled',
  } });
  assert.equal(tracking.response.status, 200);
  const ready = await jsonRequest('/api/requests/request-1/claiming/release', { method: 'POST', token: workerToken });
  assert.equal(ready.response.status, 200);
  assert.equal(ready.body.status, 'ready_for_claiming');
  assert.equal(ready.body.approvalSms.status, 'retry_scheduled');
  assert.equal(ready.body.approvalSms.attemptCount, 1);
  assert.ok(ready.body.approvalSms.nextAttemptAt);
  assert.equal(sends[0].to, '+639171234567');
  for (const phrase of ['JUAN DELA CRUZ', 'LINGAP-2026-00001', 'approved', 'September 20, 2026', '13:30', 'LINGAP CMO Window 3', 'valid government-issued ID', 'authorization letter', 'authorized representative', 'LINGAP CMO help desk', 'passwords or OTPs']) {
    assert.match(sends[0].body, new RegExp(phrase, 'i'), phrase);
  }

  assert.equal((await jsonRequest(`/api/sms-notifications/${ready.body.approvalSms.id}/retry`, { method: 'POST', token: otherToken })).response.status, 404);
  const retried = await jsonRequest(`/api/sms-notifications/${ready.body.approvalSms.id}/retry`, { method: 'POST', token: workerToken });
  assert.equal(retried.response.status, 200);
  assert.equal(retried.body.status, 'sent');
  assert.equal(retried.body.attemptCount, 2);
  assert.equal(retried.body.provider, 'test-adapter');
  assert.equal(retried.body.providerMessageId, 'provider-message-1');

  assert.equal((await jsonRequest('/api/internal/sms-delivery-status', {
    method: 'POST',
    body: { providerMessageId: 'provider-message-1', status: 'delivered' },
    headers: { 'x-aidlink-sms-status-secret': 'wrong' },
  })).response.status, 401);
  const receipt = await jsonRequest('/api/internal/sms-delivery-status', {
    method: 'POST',
    body: { providerMessageId: 'provider-message-1', status: 'delivered' },
    headers: { 'x-aidlink-sms-status-secret': 'sms-delivery-test-secret' },
  });
  assert.equal(receipt.response.status, 200);
  assert.equal(receipt.body.status, 'delivered');
  assert.ok(receipt.body.deliveredAt);

  const request = await jsonRequest('/api/requests/request-1', { token: workerToken });
  assert.equal(request.body.approvalSms.status, 'delivered');
  const messages = await jsonRequest('/api/sms-notifications', { token: adminToken });
  assert.equal(messages.body.length, 1);
  assert.equal(messages.body[0].attempts.length, 3);
  const audit = await jsonRequest('/api/audit-logs', { token: adminToken });
  const actions = audit.body.map((entry) => entry.action);
  for (const action of ['sms_notification_queued', 'sms_delivery_status_changed', 'sms_delivery_retried', 'sms_delivery_receipt_received']) {
    assert.equal(actions.includes(action), true, action);
  }
});
