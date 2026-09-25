import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let server;
let baseUrl;
let testRoot;
let dataPath;

const requestRecord = (overrides) => ({
  id: 'request-default', requestId: 'LINGAP-2026-00000', applicantId: 'applicant-1', applicantName: 'Applicant One', email: 'one@example.com',
  phone: '09170000000', address: 'Davao City', dateOfBirth: '1990-01-01', assistanceType: 'Hospital Assistance',
  incomeSource: 'Salary or wages', patientCircumstance: 'Disease', documents: [], documentHistory: [], correctionHistory: [],
  status: 'pending', dateSubmitted: '2026-09-01T08:00:00.000Z',
  facilityEvidence: { facilityName: 'Davao Hospital', facilityType: 'hospital', receiptDate: '2026-08-31', referenceNumber: 'R-1', receiptDocumentId: 'receipt-1', validation: { status: 'accepted_for_review', qualityAccepted: true, requestContextMatched: true, ageDays: 1, maxAgeDays: 365, validatedAt: '2026-09-01T08:00:00.000Z', authenticityVerified: false } },
  ...overrides,
});

before(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'aidlink-reporting-'));
  dataPath = path.join(testRoot, 'data.json');
  process.env.AIDLINK_DATA_PATH = dataPath;
  process.env.AIDLINK_UPLOADS_PATH = path.join(testRoot, 'uploads');
  await writeFile(dataPath, JSON.stringify({
    authUsers: [
      { id: 'admin-1', fullName: 'System Administrator', email: 'admin@example.com', password: 'admin-pass', role: 'System Administrator', active: true },
      { id: 'worker-1', fullName: 'Case Worker', email: 'worker@example.com', password: 'worker-pass', role: 'Case Worker', active: true },
    ],
    applicants: [
      { id: 'applicant-1', fullName: 'Applicant One', email: 'one@example.com', verificationStatus: 'approved', accountStatus: 'verified' },
      { id: 'applicant-2', fullName: 'Applicant Two', email: 'two@example.com', verificationStatus: 'pending', accountStatus: 'basic' },
    ], users: [], notifications: [], facilities: [], requiredDocuments: {},
    requests: [
      requestRecord({ id: 'request-1', requestId: 'LINGAP-2026-00001' }),
      requestRecord({
        id: 'request-2', requestId: 'LINGAP-2026-00002', applicantId: 'applicant-2', applicantName: 'Applicant Two', email: 'two@example.com',
        assistanceType: 'Dialysis', status: 'approved', dateSubmitted: '2026-09-02T08:00:00.000Z', processedAt: '2026-09-02T12:00:00.000Z',
        facilityEvidence: { facilityName: 'Dialysis Center', facilityType: 'other', receiptDate: '2026-09-01', referenceNumber: 'R-2', receiptDocumentId: 'receipt-2', validation: { status: 'accepted_for_review', qualityAccepted: true, requestContextMatched: true, ageDays: 1, maxAgeDays: 365, validatedAt: '2026-09-02T08:00:00.000Z', authenticityVerified: false } },
        documentHistory: [{ id: 'old-document', name: 'Old receipt', analysis: { accepted: false, issues: [{ code: 'excessive_blur', message: 'The image is excessively blurred.' }] } }],
        correctionHistory: [{ id: 'correction-1', status: 'submitted', replacements: [] }],
      }),
      requestRecord({ id: 'request-3', requestId: 'LINGAP-2026-00003', status: 'denied', dateSubmitted: '2026-09-03T08:00:00.000Z', processedAt: '2026-09-03T10:00:00.000Z' }),
      requestRecord({ id: 'request-4', requestId: 'LINGAP-2025-00004', assistanceType: 'Medicine Assistance', status: 'approved', dateSubmitted: '2025-01-01T08:00:00.000Z', processedAt: '2025-01-01T09:00:00.000Z', assignedFacility: { name: 'Legacy Pharmacy' }, facilityEvidence: null }),
    ],
    auditLogs: [{ id: 'audit-seed', requestId: 'request-2', action: 'correction_requested', performedBy: 'Case Worker', performedById: 'worker-1', performedAt: '2026-09-02T09:00:00.000Z' }],
    systemSettings: { organizationName: 'Reporting LINGAP' },
    nextAuthUserId: 3, nextApplicantId: 3, nextUserId: 1, nextRequestId: 5, nextNotificationId: 1, nextAuditId: 2,
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
  const response = await fetch(`${baseUrl}${route}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { response, body: await response.json() };
}

async function login(email, password) {
  const result = await jsonRequest('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(result.response.status, 200);
  return result.body.token;
}

test('protects reporting and calculates all initial reports from one filtered application set', async () => {
  const workerToken = await login('worker@example.com', 'worker-pass');
  const adminToken = await login('admin@example.com', 'admin-pass');
  assert.equal((await jsonRequest('/api/reports/summary', { token: workerToken })).response.status, 403);
  assert.equal((await jsonRequest('/api/reports/export', { method: 'POST', token: workerToken, body: { format: 'csv' } })).response.status, 403);

  const query = new URLSearchParams({ dateFrom: '2026-09-01', dateTo: '2026-09-30', status: 'approved', assistanceType: 'Dialysis', facility: 'Dialysis Center' });
  const result = await jsonRequest(`/api/reports/summary?${query}`, { token: adminToken });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.parameters, { dateFrom: '2026-09-01', dateTo: '2026-09-30', status: 'approved', assistanceType: 'Dialysis', facility: 'Dialysis Center' });
  assert.equal(result.body.totalRequests, 1);
  assert.deepEqual(result.body.applicationsByDate, [{ date: '2026-09-02', count: 1 }]);
  assert.deepEqual(result.body.applicationsByAssistanceType, [{ assistanceType: 'Dialysis', count: 1 }]);
  assert.equal(result.body.outcomes.approvalRate, 100);
  assert.equal(result.body.outcomes.denialRate, 0);
  assert.equal(result.body.outcomes.correctionRate, 100);
  assert.equal(result.body.outcomes.averageProcessingTimeHours, 4);
  assert.deepEqual(result.body.facilityWorkload.map((row) => [row.facility, row.total]), [['Dialysis Center', 1]]);
  assert.deepEqual(result.body.documentFailureReasons.map((row) => [row.code, row.count]), [['excessive_blur', 1]]);
  assert.equal(result.body.activeUsers.activeApplicants, 1);
  assert.equal(result.body.staffActivity.some((row) => row.name === 'Case Worker'), true);
  assert.equal(result.body.auditActivity.byAction.some((row) => row.action === 'correction_requested'), true);
  assert.equal(result.body.availableFilters.assistanceTypes.includes('Medicine Assistance'), true, 'historical types remain reportable');
});

test('validates report parameters and exports timestamped CSV and PDF with audited parameters', async () => {
  const adminToken = await login('admin@example.com', 'admin-pass');
  assert.equal((await jsonRequest('/api/reports/summary?dateFrom=2026-10-01&dateTo=2026-09-01', { token: adminToken })).response.status, 400);
  assert.equal((await jsonRequest('/api/reports/summary?status=made_up', { token: adminToken })).response.status, 400);
  assert.equal((await jsonRequest('/api/reports/summary?assistanceType=Unknown', { token: adminToken })).response.status, 400);

  const parameters = { dateFrom: '2026-09-01', dateTo: '2026-09-30', assistanceType: 'Dialysis', facility: 'Dialysis Center' };
  const csv = await fetch(`${baseUrl}/api/reports/export`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'csv', parameters }) });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /aidlink-system-report-\d{4}-\d{2}-\d{2}\.csv/);
  const csvText = await csv.text();
  assert.match(csvText, /Generated at/);
  assert.match(csvText, /Report parameters/);
  assert.match(csvText, /Applications by assistance type/);
  assert.match(csvText, /Document failure reasons/);

  const pdf = await fetch(`${baseUrl}/api/reports/export`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'pdf', parameters }) });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 8).toString(), '%PDF-1.4');

  const stored = JSON.parse(await readFile(dataPath, 'utf8'));
  const exports = stored.auditLogs.filter((entry) => entry.action === 'report_exported');
  assert.equal(exports.some((entry) => entry.details?.format === 'csv' && entry.details?.parameters?.assistanceType === 'Dialysis'), true);
  assert.equal(exports.some((entry) => entry.details?.format === 'pdf' && entry.details?.parameters?.facility === 'Dialysis Center'), true);
  assert.equal(stored.auditLogs.some((entry) => entry.action === 'report_generated' && entry.details?.generatedAt), true);
});
