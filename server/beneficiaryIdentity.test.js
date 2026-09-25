import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let server;
let baseUrl;
let testRoot;

before(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'aidlink-beneficiary-'));
  process.env.AIDLINK_DATA_PATH = path.join(testRoot, 'data.json');
  process.env.AIDLINK_UPLOADS_PATH = path.join(testRoot, 'uploads');
  await writeFile(process.env.AIDLINK_DATA_PATH, JSON.stringify({
    authUsers: [], users: [], applicants: [], requests: [], notifications: [],
    facilities: [], auditLogs: [], documentUploads: [], requiredDocuments: { 'Hospital Assistance': [] },
    assistanceTypeSettings: { 'Hospital Assistance': { active: true } },
    systemSettings: { receiptValidityDays: 90 },
    nextAuthUserId: 1, nextUserId: 1, nextApplicantId: 1, nextRequestId: 1,
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

async function post(route, body, token) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function register(fullName, email) {
  const response = await post('/api/applicant/auth/register', {
    fullName, email, phone: '09170000000', address: `${fullName} HOME`,
    dateOfBirth: '1990-01-01', password: 'strong-pass',
  });
  assert.equal(response.status, 201);
  const session = await response.json();
  const data = JSON.parse(await readFile(process.env.AIDLINK_DATA_PATH, 'utf8'));
  const account = data.applicants.find((item) => item.id === session.user.id);
  account.verificationStatus = 'approved';
  account.accountStatus = 'verified';
  await writeFile(process.env.AIDLINK_DATA_PATH, JSON.stringify(data));
  return session;
}

async function uploadReceipt(token) {
  const response = await post('/api/uploads', {
    name: 'recent-receipt.pdf',
    documentType: 'Recent facility receipt or billing document',
    contentBase64: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF').toString('base64'),
  }, token);
  assert.equal(response.status, 201);
  return response.json();
}

function requestBody(receipt, overrides = {}) {
  return {
    beneficiaryType: 'other',
    beneficiary: {
      fullName: 'CAROL BENEFICIARY', address: 'CAROL HOME', dateOfBirth: '2010-02-03',
      relationshipToApplicant: 'Child', sex: 'Female',
    },
    assistanceType: 'Hospital Assistance', incomeSource: 'Salary or wages',
    patientCircumstance: 'Disease', documents: [receipt],
    facilityEvidence: {
      facilityName: 'Test Hospital', facilityType: 'hospital',
      receiptDate: new Date().toISOString().slice(0, 10),
      referenceNumber: 'BENEFICIARY-TEST-1', receiptDocumentId: receipt.id,
    },
    ...overrides,
  };
}

test('two accounts on one device keep requester ownership separate from beneficiary input', async () => {
  const alice = await register('ALICE APPLICANT', 'alice@example.com');
  const bob = await register('BOB APPLICANT', 'bob@example.com');
  const receipt = await uploadReceipt(alice.token);

  const submission = await post('/api/applications', requestBody(receipt, {
    clientSubmissionId: 'mobile-beneficiary-test-0001',
    applicantId: bob.user.id,
    email: 'bob@example.com',
    phone: '09999999999',
    fullName: 'BOB APPLICANT',
  }), alice.token);
  assert.equal(submission.status, 201);
  const created = await submission.json();
  assert.equal(created.applicantId, alice.user.id);
  assert.equal(created.requester.applicantId, alice.user.id);
  assert.equal(created.requester.fullName, 'ALICE APPLICANT');
  assert.equal(created.requester.email, 'alice@example.com');
  assert.equal(created.beneficiaryType, 'other');
  assert.equal(created.beneficiary.fullName, 'CAROL BENEFICIARY');

  const retry = await post('/api/applications', requestBody(receipt, {
    clientSubmissionId: 'mobile-beneficiary-test-0001',
    applicantId: bob.user.id,
    email: 'bob@example.com',
    phone: '09999999999',
    fullName: 'BOB APPLICANT',
  }), alice.token);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).id, created.id);

  const stored = JSON.parse(await readFile(process.env.AIDLINK_DATA_PATH, 'utf8'));
  assert.equal(stored.requests.filter((item) => item.clientSubmissionId === 'mobile-beneficiary-test-0001').length, 1);

  const aliceHistory = await fetch(`${baseUrl}/api/applicant/requests`, { headers: { Authorization: `Bearer ${alice.token}` } });
  const bobHistory = await fetch(`${baseUrl}/api/applicant/requests`, { headers: { Authorization: `Bearer ${bob.token}` } });
  assert.equal(aliceHistory.status, 200);
  assert.equal(bobHistory.status, 200);
  assert.equal((await aliceHistory.json()).length, 1);
  assert.equal((await bobHistory.json()).length, 0);
});

test('validates explicit beneficiary mode and required structured fields', async () => {
  const data = JSON.parse(await readFile(process.env.AIDLINK_DATA_PATH, 'utf8'));
  const alice = data.applicants.find((item) => item.email === 'alice@example.com');
  const login = await post('/api/applicant/auth/login', { email: alice.email, password: 'strong-pass' });
  const { token } = await login.json();
  const receipt = await uploadReceipt(token);

  const missingBirthdate = requestBody(receipt);
  delete missingBirthdate.beneficiary.dateOfBirth;
  const missingResponse = await post('/api/applications', missingBirthdate, token);
  assert.equal(missingResponse.status, 400);
  assert.match((await missingResponse.json()).message, /beneficiary birthdate/i);

  const invalidMode = await post('/api/applications', requestBody(receipt, { beneficiaryType: 'unknown' }), token);
  assert.equal(invalidMode.status, 400);
  assert.match((await invalidMode.json()).message, /for yourself or for someone else/i);
});
