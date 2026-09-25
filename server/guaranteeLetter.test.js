import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { convertWordToPdf } from './services/protectedLetterService.js';

let server;
let baseUrl;
let testRoot;
let dataPath;
let lettersPath;
function passwordHash(password) { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`; }

before(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'aidlink-protected-letter-'));
  dataPath = path.join(testRoot, 'data.json');
  lettersPath = path.join(testRoot, 'private-letters');
  process.env.AIDLINK_DATA_PATH = dataPath;
  process.env.AIDLINK_UPLOADS_PATH = path.join(testRoot, 'uploads');
  process.env.AIDLINK_LETTERS_PATH = lettersPath;
  await writeFile(dataPath, JSON.stringify({
    authUsers: [
      { id: 'worker-1', fullName: 'Assigned Worker', email: 'worker@example.com', password: 'worker-pass', role: 'Case Worker' },
      { id: 'worker-2', fullName: 'Other Worker', email: 'other@example.com', password: 'other-pass', role: 'Case Worker' },
      { id: 'admin-1', fullName: 'System Administrator', email: 'admin@example.com', password: 'admin-pass', role: 'System Administrator' },
    ],
    applicants: [
      { id: 'applicant-1', fullName: 'Letter Applicant', email: 'letter@example.com', passwordHash: passwordHash('applicant-pass'), role: 'Applicant', verificationStatus: 'approved', accountStatus: 'verified' },
      { id: 'applicant-2', fullName: 'Other Applicant', email: 'other-applicant@example.com', passwordHash: passwordHash('applicant-pass'), role: 'Applicant', verificationStatus: 'approved', accountStatus: 'verified' },
    ], users: [], notifications: [], facilities: [], auditLogs: [],
    requiredDocuments: { 'Hospital Assistance': [] },
    requests: [
      { id: 'request-1', requestId: 'LINGAP-2026-00001', applicantId: 'applicant-1', applicantName: 'Letter Applicant', email: 'letter@example.com', phone: '09170000000', address: 'Davao', dateOfBirth: '1990-01-01', assistanceType: 'Hospital Assistance', incomeSource: 'Salary or wages', patientCircumstance: 'Disease', documents: [{ id: 'request-1-receipt', name: 'receipt.pdf', documentType: 'Recent facility receipt or billing document', analysis: { documentType: 'Recent facility receipt or billing document' } }], status: 'pending', assignedCaseWorkerId: 'worker-1', dateSubmitted: '2026-09-14T00:00:00.000Z' },
      { id: 'request-2', requestId: 'LINGAP-2026-00002', applicantId: 'applicant-2', applicantName: 'Other Applicant', email: 'other-applicant@example.com', phone: '09170000001', address: 'Davao', dateOfBirth: '1990-01-01', assistanceType: 'Hospital Assistance', documents: [], status: 'pending', assignedCaseWorkerId: 'worker-2', dateSubmitted: '2026-09-14T00:00:00.000Z' },
      { id: 'historical-request', requestId: 'LINGAP-2025-00001', applicantName: 'Historical Applicant', email: 'old@example.com', phone: '09170000002', address: 'Davao', dateOfBirth: '1980-01-01', assistanceType: 'Hospital Assistance', documents: [], status: 'approved', dateSubmitted: '2025-05-01T00:00:00.000Z', guaranteeLetter: { name: 'legacy-guarantee.pdf', url: 'https://legacy.example/legacy-guarantee.pdf' } },
    ],
    nextAuthUserId: 4, nextApplicantId: 3, nextUserId: 1, nextRequestId: 3, nextNotificationId: 1, nextAuditId: 1,
  }));
  const { app } = await import('./server.js');
  server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
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
async function login(route, email, password) {
  const result = await jsonRequest(route, { method: 'POST', body: { email, password } });
  assert.equal(result.response.status, 200);
  return result.body.token;
}
async function pdfBytes() {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 500]);
  return Buffer.from(await pdf.save());
}
async function upload(requestId, token, bytes, name, mimeType) {
  const form = new FormData();
  form.append('letter', new Blob([bytes], { type: mimeType }), name);
  return fetch(`${baseUrl}/api/requests/${requestId}/letter`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
}
function tracking() { return { claimReference: 'CLAIM-001', scheduledFor: '2026-09-20', status: 'scheduled', claimingTime: '09:00', claimingLocation: 'AidLink desk' }; }

test('separates review approval from claiming preparation and releases protected access only when Step 2 is complete', async () => {
  const worker = await login('/api/auth/login', 'worker@example.com', 'worker-pass');
  const otherWorker = await login('/api/auth/login', 'other@example.com', 'other-pass');
  const admin = await login('/api/auth/login', 'admin@example.com', 'admin-pass');
  const applicant = await login('/api/applicant/auth/login', 'letter@example.com', 'applicant-pass');
  const otherApplicant = await login('/api/applicant/auth/login', 'other-applicant@example.com', 'applicant-pass');
  const pdf = await pdfBytes();

  const historical = await jsonRequest('/api/requests/historical-request', { token: admin });
  assert.equal(historical.body.guaranteeLetter.name, 'legacy-guarantee.pdf');
  const uploadBeforeApproval = await upload('request-1', worker, pdf, 'too-early.pdf', 'application/pdf');
  assert.equal(uploadBeforeApproval.status, 400);
  assert.match((await uploadBeforeApproval.json()).message, /only after.*approved/i);
  const underReview = await jsonRequest('/api/requests/request-1/status', { method: 'PUT', token: worker, body: { status: 'under_review', remarks: 'Reviewing eligibility and submitted evidence.' } });
  assert.equal(underReview.response.status, 200);
  assert.equal(underReview.body.status, 'under_review');
  const approved = await jsonRequest('/api/requests/request-1/status', { method: 'PUT', token: worker, body: { status: 'approved', remarks: 'Eligibility review is complete and approved.' } });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.status, 'approved');
  assert.equal(approved.body.protectedLetter, null);
  assert.equal(approved.body.qrCode, null);
  assert.equal(approved.body.approvalSms, undefined);
  const applicantBeforePreparation = await jsonRequest('/api/applicant/requests/request-1', { token: applicant });
  assert.equal(applicantBeforePreparation.body.status, 'approved');
  assert.equal(applicantBeforePreparation.body.qrCode, null);

  const progressive = await jsonRequest('/api/requests/request-1/guarantee-letter-tracking', { method: 'PUT', token: worker, body: { claimReference: 'CLAIM-001', status: 'pending' } });
  assert.equal(progressive.response.status, 200);
  assert.equal(progressive.body.status, 'approved');
  assert.equal(progressive.body.guaranteeLetterTracking.claimReference, 'CLAIM-001');
  assert.equal(progressive.body.guaranteeLetterTracking.scheduledFor, '');
  const incompleteRelease = await jsonRequest('/api/requests/request-1/claiming/release', { method: 'POST', token: worker });
  assert.equal(incompleteRelease.response.status, 400);
  assert.match(incompleteRelease.body.message, /missing: claiming date, claiming time, claiming location/i);
  assert.equal((await upload('request-1', otherWorker, pdf, 'letter.pdf', 'application/pdf')).status, 404);
  assert.equal((await upload('request-1', admin, pdf, 'letter.pdf', 'application/pdf')).status, 403);
  assert.equal((await upload('request-1', worker, Buffer.from('not-a-pdf'), 'letter.pdf', 'application/pdf')).status, 400);

  const firstUpload = await upload('request-1', worker, pdf, 'letter.pdf', 'application/pdf');
  assert.equal(firstUpload.status, 201);
  const first = await firstUpload.json();
  assert.equal(first.version, 1);
  assert.equal(first.conversionStatus, 'ready');
  assert.equal(first.status, 'pending_review');
  assert.equal((await jsonRequest('/api/requests/request-1/letter/confirm', { method: 'POST', token: worker, body: { version: 1, confirmed: true } })).response.status, 400);
  assert.equal((await fetch(`${baseUrl}/api/requests/request-1/letter/preview`, { headers: { Authorization: `Bearer ${applicant}` } })).status, 403);
  const preview = await fetch(`${baseUrl}/api/requests/request-1/letter/preview`, { headers: { Authorization: `Bearer ${worker}` } });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'application/pdf');
  assert.equal((await PDFDocument.load(await preview.arrayBuffer())).getPageCount(), 1);
  const confirmed = await jsonRequest('/api/requests/request-1/letter/confirm', { method: 'POST', token: worker, body: { version: 1, confirmed: true } });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.protectedLetter.status, 'confirmed');
  assert.equal(confirmed.body.qrCode, null);

  const completedTracking = await jsonRequest('/api/requests/request-1/guarantee-letter-tracking', { method: 'PUT', token: worker, body: tracking() });
  assert.equal(completedTracking.response.status, 200);
  assert.equal(completedTracking.body.status, 'approved');
  assert.equal(completedTracking.body.qrCode, null);
  const released = await jsonRequest('/api/requests/request-1/claiming/release', { method: 'POST', token: worker });
  assert.equal(released.response.status, 200);
  assert.equal(released.body.status, 'ready_for_claiming');
  assert.equal(released.body.protectedLetter.status, 'approved');
  assert.equal(released.body.guaranteeLetterTracking.status, 'ready_for_claiming');
  assert.match(released.body.qrCode.value, /\/api\/letters\/qr\/[A-Za-z0-9_-]{43}$/);
  const oldQr = released.body.qrCode.value;
  const qrPath = new URL(oldQr).pathname;
  const viewer = await fetch(`${baseUrl}${qrPath}`);
  assert.equal(viewer.status, 200);
  const html = await viewer.text();
  assert.match(html, /AidLink protected guarantee letter/);
  assert.doesNotMatch(html, /download="|window\.print|print\(\)/);
  const encodedPdfPath = html.match(/\/api\/letters\/request-1\/pdf\?access=[^']+/)?.[0];
  assert.ok(encodedPdfPath);
  assert.equal((await fetch(`${baseUrl}/api/letters/request-1/pdf`)).status, 403);
  const protectedPdf = await fetch(`${baseUrl}${encodedPdfPath}`);
  assert.equal(protectedPdf.status, 200);
  assert.equal(protectedPdf.headers.get('content-disposition'), 'inline');
  assert.equal(protectedPdf.headers.get('cache-control').includes('no-store'), true);
  assert.equal((await PDFDocument.load(await protectedPdf.arrayBuffer())).getPageCount(), 1);
  assert.equal((await jsonRequest('/api/applicant/requests/request-1', { token: otherApplicant })).response.status, 404);
  const ownRequest = await jsonRequest('/api/applicant/requests/request-1', { token: applicant });
  assert.equal(ownRequest.body.status, 'ready_for_claiming');
  assert.equal(ownRequest.body.qrCode.value, oldQr);
  assert.equal(ownRequest.body.protectedLetter.status, 'approved');
  assert.equal(JSON.stringify(ownRequest.body).includes('originalFileName'), false);
  assert.equal(JSON.stringify(ownRequest.body).includes('pdfFileName'), false);
  assert.equal((await readdir(process.env.AIDLINK_UPLOADS_PATH)).length, 0, 'letter files are not put in public upload storage');
  const original = (await readdir(lettersPath)).find((name) => name.endsWith('-original.pdf'));
  assert.ok(original);
  assert.equal((await fetch(`${baseUrl}/uploads/${original}`, { headers: { Authorization: `Bearer ${applicant}` } })).status, 404);

  const replacementUpload = await upload('request-1', worker, pdf, 'replacement.pdf', 'application/pdf');
  assert.equal(replacementUpload.status, 201);
  assert.equal((await fetch(`${baseUrl}${qrPath}`)).status, 410);
  assert.equal((await fetch(`${baseUrl}${encodedPdfPath}`)).status, 404);
  assert.equal((await jsonRequest('/api/applicant/requests/request-1', { token: applicant })).body.protectedLetter.status, 'pending_review');
  assert.equal((await jsonRequest('/api/applicant/requests/request-1', { token: applicant })).body.status, 'approved');
  await fetch(`${baseUrl}/api/requests/request-1/letter/preview`, { headers: { Authorization: `Bearer ${worker}` } });
  const replacementConfirmed = await jsonRequest('/api/requests/request-1/letter/confirm', { method: 'POST', token: worker, body: { version: 2, confirmed: true } });
  assert.equal(replacementConfirmed.response.status, 200);
  assert.equal(replacementConfirmed.body.protectedLetter.status, 'confirmed');
  assert.equal(replacementConfirmed.body.qrCode, null);
  const replacementReleased = await jsonRequest('/api/requests/request-1/claiming/release', { method: 'POST', token: worker });
  assert.equal(replacementReleased.response.status, 200);
  assert.equal(replacementReleased.body.status, 'ready_for_claiming');
  const newQr = replacementReleased.body.qrCode.value;
  assert.notEqual(newQr, oldQr);
  assert.equal((await fetch(`${baseUrl}${new URL(newQr).pathname}`)).status, 200);
  const expiringData = JSON.parse(await readFile(dataPath, 'utf8'));
  expiringData.requests.find((item) => item.id === 'request-1').protectedLetter.qrExpiresAt = '2020-01-01T00:00:00.000Z';
  await writeFile(dataPath, JSON.stringify(expiringData));
  assert.equal((await fetch(`${baseUrl}${new URL(newQr).pathname}`)).status, 410);
  expiringData.requests.find((item) => item.id === 'request-1').protectedLetter.qrExpiresAt = '2099-01-01T00:00:00.000Z';
  await writeFile(dataPath, JSON.stringify(expiringData));
  const revoked = await jsonRequest('/api/requests/request-1/letter/revoke', { method: 'POST', token: worker, body: { reason: 'Corrected wording is required.' } });
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.body.protectedLetter.status, 'revoked');
  assert.equal(revoked.body.status, 'approved');
  assert.equal((await fetch(`${baseUrl}${new URL(newQr).pathname}`)).status, 410);
  assert.equal((await jsonRequest('/api/applicant/requests/request-1', { token: applicant })).body.qrCode, null);

  const stored = JSON.parse(await readFile(dataPath, 'utf8'));
  const record = stored.requests.find((item) => item.id === 'request-1');
  assert.equal(record.letterHistory.length, 1);
  assert.equal(record.letterHistory[0].status, 'replaced');
  assert.equal(record.protectedLetter.version, 2);
  assert.equal(record.protectedLetter.sourceType, 'pdf');
  assert.equal(record.protectedLetter.approvedById, worker && 'worker-1');
  const actions = new Set(stored.auditLogs.filter((entry) => entry.requestId === 'request-1').map((entry) => entry.action));
  for (const action of ['request_approved', 'guarantee_letter_tracking_updated', 'guarantee_letter_uploaded', 'guarantee_letter_converted', 'guarantee_letter_reviewed', 'guarantee_letter_confirmed', 'claiming_preparation_released', 'guarantee_letter_approved', 'guarantee_letter_qr_generated', 'guarantee_letter_qr_scanned', 'guarantee_letter_accessed', 'guarantee_letter_replaced', 'guarantee_letter_revoked']) assert.equal(actions.has(action), true, action);
});

test('supports Word-to-PDF through LibreOffice adapter and records conversion failure without approval', async () => {
  const source = Buffer.from('PK\x03\x04fake-docx');
  const validPdf = await pdfBytes();
  const converted = await convertWordToPdf(source, 'docx', { run: async (_office, args) => { await writeFile(path.join(args[args.length - 2], 'source.pdf'), validPdf); } });
  assert.equal((await PDFDocument.load(converted)).getPageCount(), 1);
  await assert.rejects(() => convertWordToPdf(source, 'docx', { officePath: path.join(testRoot, 'missing-soffice') }), /LibreOffice/);
  const worker = await login('/api/auth/login', 'worker@example.com', 'worker-pass');
  const failed = await upload('request-1', worker, source, 'letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(failed.status, 422);
  const details = await failed.json();
  assert.match(details.message, /Word conversion failed|LibreOffice/);
  assert.equal(details.letter.conversionStatus, 'failed');
  const stored = JSON.parse(await readFile(dataPath, 'utf8'));
  assert.equal(stored.requests.find((item) => item.id === 'request-1').protectedLetter.sourceType, 'docx');
  assert.equal(stored.auditLogs.some((entry) => entry.action === 'guarantee_letter_conversion_failed'), true);
});
