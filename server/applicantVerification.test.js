import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let server;
let baseUrl;
let testRoot;

before(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'aidlink-identity-'));
  process.env.AIDLINK_DATA_PATH = path.join(testRoot, 'data.json');
  process.env.AIDLINK_UPLOADS_PATH = path.join(testRoot, 'uploads');
  await writeFile(process.env.AIDLINK_DATA_PATH, JSON.stringify({
    authUsers: [
      { id: 'admin-1', fullName: 'System Administrator', email: 'admin@example.com', password: 'admin-pass', role: 'System Administrator' },
      { id: 'worker-1', fullName: 'Case Worker', email: 'worker@example.com', password: 'worker-pass', role: 'Case Worker' },
    ],
    applicants: [], users: [], requests: [], notifications: [], facilities: [], auditLogs: [], requiredDocuments: {},
    nextAuthUserId: 3, nextApplicantId: 1, nextUserId: 1, nextRequestId: 1, nextNotificationId: 1, nextAuditId: 1,
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
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, body: await response.json() };
}

async function login(email, password) {
  const result = await jsonRequest('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(result.response.status, 200);
  return result.body.token;
}

async function register(fullName, email) {
  const result = await jsonRequest('/api/applicant/auth/register', {
    method: 'POST',
    body: { fullName, email, phone: '09170000000', address: 'Davao City', dateOfBirth: '1990-01-01', password: 'strong-pass' },
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.user.verificationStatus, 'unverified');
  assert.equal(result.body.user.accountStatus, 'basic');
  return result.body;
}

async function uploadIdentity(token, name) {
  const form = new FormData();
  form.append('document', new Blob([Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF')], { type: 'application/pdf' }), name);
  const response = await fetch(`${baseUrl}/api/applicant/identity-verification/document`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.verificationStatus, 'pending');
  assert.equal(body.accountStatus, 'basic');
  assert.equal(body.identityVerification.document.analysis.accepted, true);
  assert.equal(body.identityVerification.document.analysis.authenticityVerified, false);
  assert.ok(body.identityVerification.document.analysis.analyzerVersion);
  assert.ok(Date.parse(body.identityVerification.document.uploadedAt));
  return body;
}

async function analyzedDocument(documentType, index, token) {
  const result = await jsonRequest('/api/uploads', {
    method: 'POST',
    body: {
      name: `supporting-${index}.pdf`,
      documentType,
      contentBase64: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF').toString('base64'),
    }, token,
  });
  assert.equal(result.response.status, 201);
  return result.body;
}

test('verifies identity, rejects stale receipts, and isolates two accounts by authenticated stable ID', async () => {
  const adminToken = await login('admin@example.com', 'admin-pass');
  const workerToken = await login('worker@example.com', 'worker-pass');
  const first = await register('First Applicant', 'first@example.com');
  const second = await register('Second Applicant', 'second@example.com');

  assert.equal((await jsonRequest('/api/applicant/requests', { token: first.token })).response.status, 403);
  const firstIdentity = await uploadIdentity(first.token, 'first-government-id.pdf');
  const secondIdentity = await uploadIdentity(second.token, 'second-government-id.pdf');

  const reviewerQueue = await jsonRequest('/api/applicant-verifications', { token: workerToken });
  assert.equal(reviewerQueue.response.status, 200);
  assert.equal(reviewerQueue.body.some((item) => item.id === firstIdentity.applicantId), true);
  const firstQueueItem = reviewerQueue.body.find((item) => item.id === firstIdentity.applicantId);
  assert.equal(firstQueueItem.identityVerification.document.url, `${baseUrl}/api/applicant-verifications/${firstIdentity.applicantId}/document`);

  const adminProof = await fetch(firstQueueItem.identityVerification.document.url, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(adminProof.status, 200);
  assert.match(adminProof.headers.get('cache-control'), /no-store/i);
  assert.match(adminProof.headers.get('content-disposition'), /^inline;/i);
  assert.ok((await adminProof.arrayBuffer()).byteLength > 0);
  assert.equal((await jsonRequest('/api/auth/me', { token: adminToken })).response.status, 200, 'previewing the proof must not invalidate the administrator session');

  const workerProof = await jsonRequest(`/api/applicant-verifications/${firstIdentity.applicantId}/document`, { token: workerToken });
  assert.equal(workerProof.response.status, 403);
  assert.equal(workerProof.body.code, 'IDENTITY_PROOF_UNAUTHORIZED');
  const applicantProof = await jsonRequest(`/api/applicant-verifications/${firstIdentity.applicantId}/document`, { token: first.token });
  assert.equal(applicantProof.response.status, 403);
  assert.equal(applicantProof.body.code, 'IDENTITY_PROOF_UNAUTHORIZED');
  const expiredProof = await jsonRequest(`/api/applicant-verifications/${firstIdentity.applicantId}/document`, { token: 'expired.invalid' });
  assert.equal(expiredProof.response.status, 401);
  assert.match(expiredProof.body.message, /session has expired/i);

  const originalIdentityPath = new URL(firstIdentity.identityVerification.document.url).pathname;
  assert.equal((await fetch(`${baseUrl}${originalIdentityPath}`, { headers: { Authorization: `Bearer ${workerToken}` } })).status, 404);
  assert.equal((await fetch(`${baseUrl}${originalIdentityPath}`, { headers: { Authorization: `Bearer ${first.token}` } })).status, 404);
  assert.equal((await fetch(`${baseUrl}${originalIdentityPath}`, { headers: { Authorization: `Bearer ${adminToken}` } })).status, 200);
  assert.equal((await jsonRequest(`/api/applicant-verifications/${firstIdentity.applicantId}/flag`, {
    method: 'POST', token: workerToken, body: { note: 'Escalated for final administrator review.' },
  })).response.status, 200);
  assert.equal((await jsonRequest(`/api/applicant-verifications/${firstIdentity.applicantId}/decision`, {
    method: 'PUT', token: workerToken, body: { decision: 'approved', notes: 'Unauthorized reviewer attempt.' },
  })).response.status, 403);

  for (const applicantId of [firstIdentity.applicantId, secondIdentity.applicantId]) {
    const decision = await jsonRequest(`/api/applicant-verifications/${applicantId}/decision`, {
      method: 'PUT', token: adminToken, body: { decision: 'approved', notes: 'Government-issued ID reviewed and approved.' },
    });
    assert.equal(decision.response.status, 200);
    assert.equal(decision.body.verificationStatus, 'approved');
    assert.equal(decision.body.accountStatus, 'verified');
    assert.equal(decision.body.identityVerification.decision.administratorId, 'admin-1');
    assert.ok(Date.parse(decision.body.identityVerification.decision.decidedAt));
  }

  const requirements = ['Valid ID', 'Barangay Certificate of Indigency', 'Recent facility receipt or billing document'];
  const documents = [];
  assert.equal((await jsonRequest('/api/uploads', { method: 'POST', body: {} })).response.status, 401);
  for (const [index, requirement] of requirements.entries()) documents.push(await analyzedDocument(requirement, index + 1, first.token));
  const receipt = documents[2];
  const application = {
    applicantId: secondIdentity.applicantId,
    email: 'second@example.com',
    assistanceType: 'Hospital Assistance',
    incomeSource: 'Salary or wages',
    patientCircumstance: 'Disease',
    documents,
    facilityEvidence: {
      facilityName: 'Receipt Hospital',
      facilityType: 'hospital',
      receiptDate: '2000-01-01',
      referenceNumber: 'RECEIPT-001',
      receiptDocumentId: receipt.id,
    },
  };
  const stale = await jsonRequest('/api/applicant/applications', { method: 'POST', token: first.token, body: application });
  assert.equal(stale.response.status, 400);
  assert.match(stale.body.message, /dated within the last 365 days/i);

  application.facilityEvidence.receiptDate = new Date().toISOString().slice(0, 10);
  const submitted = await jsonRequest('/api/applicant/applications', { method: 'POST', token: first.token, body: application });
  assert.equal(submitted.response.status, 201);
  assert.equal(submitted.body.applicantId, firstIdentity.applicantId);
  assert.equal(submitted.body.email, 'first@example.com');
  assert.equal(submitted.body.facilityEvidence.validation.authenticityVerified, false);
  const underReview = await jsonRequest(`/api/requests/${submitted.body.id}/status`, {
    method: 'PUT', token: workerToken, body: { status: 'under_review', remarks: 'Initial document review started.' },
  });
  assert.equal(underReview.response.status, 200);
  assert.equal(underReview.body.status, 'under_review');

  const stored = JSON.parse(await readFile(process.env.AIDLINK_DATA_PATH, 'utf8'));
  const storedRequest = stored.requests.find((item) => item.id === submitted.body.id);
  const completeDocuments = storedRequest.documents;
  storedRequest.documents = storedRequest.documents.filter((document) => document.documentType !== 'Barangay Certificate of Indigency');
  await writeFile(process.env.AIDLINK_DATA_PATH, JSON.stringify(stored));
  const incompleteApproval = await jsonRequest(`/api/requests/${submitted.body.id}/status`, {
    method: 'PUT',
    token: workerToken,
    body: {
      status: 'approved',
      remarks: 'This must fail because a configured requirement is missing.',
    },
  });
  assert.equal(incompleteApproval.response.status, 400);
  assert.match(incompleteApproval.body.message, /Barangay Certificate of Indigency/i);
  storedRequest.documents = completeDocuments;
  await writeFile(process.env.AIDLINK_DATA_PATH, JSON.stringify(stored));

  const firstHistory = await jsonRequest('/api/applicant/requests?email=second@example.com', { token: first.token });
  const secondHistory = await jsonRequest('/api/applicant/requests?email=first@example.com', { token: second.token });
  assert.deepEqual(firstHistory.body.map((item) => item.id), [submitted.body.id]);
  assert.deepEqual(secondHistory.body, []);
  assert.equal((await jsonRequest(`/api/applications/${submitted.body.requestId}/status?email=first@example.com`, { token: second.token })).response.status, 404);
  assert.equal((await jsonRequest(`/api/applications/${submitted.body.requestId}/status?email=second@example.com`, { token: first.token })).response.status, 200);

  const missingIdentityFile = path.basename(new URL(secondIdentity.identityVerification.document.url).pathname);
  await rm(path.join(process.env.AIDLINK_UPLOADS_PATH, missingIdentityFile), { force: true });
  const missingProof = await jsonRequest(`/api/applicant-verifications/${secondIdentity.applicantId}/document`, { token: adminToken });
  assert.equal(missingProof.response.status, 404);
  assert.equal(missingProof.body.code, 'IDENTITY_PROOF_FILE_MISSING');
  assert.match(missingProof.body.message, /upload it again/i);

  const activity = await jsonRequest('/api/audit-logs', { token: adminToken });
  const actions = new Set(activity.body.map((entry) => entry.action));
  for (const action of ['applicant_id_uploaded', 'applicant_id_flagged', 'applicant_id_approved', 'applicant_account_status_changed', 'applicant_id_document_accessed', 'applicant_id_document_access_failed']) {
    assert.equal(actions.has(action), true, action);
  }
  const identityAccessFailureReasons = new Set(activity.body.filter((entry) => entry.action === 'applicant_id_document_access_failed').map((entry) => entry.details.reason));
  assert.equal(identityAccessFailureReasons.has('unauthorized'), true);
  assert.equal(identityAccessFailureReasons.has('file_missing'), true);
});
