import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  deterministicDocumentAnalyzer,
  setDocumentAnalyzer,
} from './services/documentAnalyzer.js';

let server;
let baseUrl;
let testRoot;
let applicantToken;

before(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'aidlink-quality-'));
  process.env.AIDLINK_DATA_PATH = path.join(testRoot, 'data.json');
  process.env.AIDLINK_UPLOADS_PATH = path.join(testRoot, 'uploads');
  await writeFile(process.env.AIDLINK_DATA_PATH, JSON.stringify({
    authUsers: [{
      id: 'auth-admin', fullName: 'Case Worker', email: 'worker@example.com',
      password: 'worker-pass', phone: '09170000001', address: 'Davao City',
      dateOfBirth: '1985-01-01', sex: 'Female', role: 'Case Worker',
      registeredDate: '2026-01-01T00:00:00.000Z',
    }], users: [], applicants: [], requests: [], notifications: [],
    facilities: [], auditLogs: [], requiredDocuments: {}, nextAuthUserId: 2,
    nextUserId: 1, nextApplicantId: 1, nextRequestId: 1,
    nextNotificationId: 1, nextAuditId: 1,
  }));
  const { app } = await import('./server.js');
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const registration = await fetch(`${baseUrl}/api/applicant/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: 'Quality Applicant', email: 'quality@example.com',
      phone: '09170000000', address: 'Davao City',
      dateOfBirth: '1990-01-01', password: 'strong-pass',
    }),
  });
  assert.equal(registration.status, 201);
  applicantToken = (await registration.json()).token;
  await markVerified('quality@example.com');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

async function analyze(buffer, name = 'document.png', mime = 'image/png') {
  const form = new FormData();
  form.append('documentType', 'valid_id');
  form.append('document', new Blob([buffer], { type: mime }), name);
  const response = await fetch(`${baseUrl}/api/applicant/documents/analyze`, {
    method: 'POST', headers: { Authorization: `Bearer ${applicantToken}` }, body: form,
  });
  return { response, body: await response.json() };
}

async function markVerified(email) {
  const data = JSON.parse(await readFile(process.env.AIDLINK_DATA_PATH, 'utf8'));
  const applicant = data.applicants.find((item) => item.email === email);
  assert.ok(applicant);
  applicant.verificationStatus = 'approved';
  applicant.accountStatus = 'verified';
  applicant.identityVerification = { status: 'approved', document: { id: 'test-identity-document' }, decision: { decision: 'approved' }, auditNotes: [] };
  await writeFile(process.env.AIDLINK_DATA_PATH, JSON.stringify(data));
}

async function upload(buffer, name = 'document.png', mime = 'image/png', token = applicantToken, documentType = 'Valid ID') {
  const form = new FormData();
  form.append('documentType', documentType);
  form.append('documents', new Blob([buffer], { type: mime }), name);
  const response = await fetch(`${baseUrl}/api/applicant/documents`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  return { response, body: await response.json() };
}

function recentFacilityEvidence(receiptDocument) {
  return {
    facilityName: 'Test Hospital',
    facilityType: 'hospital',
    receiptDate: new Date().toISOString().slice(0, 10),
    referenceNumber: 'TEST-RECEIPT-001',
    receiptDocumentId: receiptDocument.id,
  };
}

async function patternedImage({ width = 800, height = 600, edge = 60, low = 50, high = 80 } = {}) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const border = x < 8 || y < 8 || x >= width - 8 || y >= height - 8;
      const value = border ? edge : ((Math.floor(x / 6) + Math.floor(y / 6)) % 2 ? low : high);
      const index = (y * width + x) * 3;
      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

test('blocks every severe technical defect with a problem and corrective action', async () => {
  const lowResolution = await analyze(await patternedImage({ width: 300, height: 200 }));
  const dark = await analyze(await patternedImage({ edge: 10, low: 5, high: 20 }));
  const glare = await analyze(await sharp({ create: { width: 800, height: 600, channels: 3, background: 'white' } }).png().toBuffer());
  const blurred = await analyze(await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 120, g: 120, b: 120 } } }).png().toBuffer());

  const cropPixels = Buffer.alloc(800 * 600 * 3, 0);
  for (let y = 0; y < 600; y += 1) {
    for (let x = 0; x < 800; x += 1) {
      if (x === 0 || y === 0 || x === 799 || y === 599) {
        const index = (y * 800 + x) * 3;
        cropPixels[index] = cropPixels[index + 1] = cropPixels[index + 2] = 255;
      }
    }
  }
  const cropped = await analyze(await sharp(cropPixels, { raw: { width: 800, height: 600, channels: 3 } }).png().toBuffer());
  const corrupt = await analyze(Buffer.from('not a real image'), 'corrupt.jpg', 'image/jpeg');

  const codes = new Set([lowResolution, dark, glare, blurred, cropped, corrupt]
    .flatMap(({ body }) => body.issues.map((issue) => issue.code)));
  for (const code of ['low_resolution', 'very_low_brightness', 'excessive_glare', 'excessive_blur', 'incomplete_boundaries', 'unsupported_or_corrupt_format']) {
    assert.equal(codes.has(code), true, code);
  }
  for (const result of [lowResolution, dark, glare, blurred, cropped, corrupt]) {
    assert.equal(result.response.status, 200);
    assert.equal(result.body.accepted, false);
    assert.ok(result.body.issues.every((issue) => issue.message && issue.fix));
    assert.equal(result.body.authenticityVerified, false);
  }

  const unsupported = await analyze(Buffer.from('plain text'), 'notes.txt', 'text/plain');
  assert.equal(unsupported.response.status, 400);
  assert.match(unsupported.body.message, /Export the document as PDF, JPG, or PNG/i);
});

test('accepts guidance warnings, signs the upload, and persists analysis metadata', async () => {
  const readable = await patternedImage();
  const initial = await analyze(readable);
  assert.equal(initial.body.accepted, true);
  assert.ok(initial.body.warnings.length > 0);
  assert.equal(initial.body.orientation, 'landscape');
  assert.equal(initial.body.analyzerVersion, 'aidlink-document-quality-v3');
  assert.ok(Date.parse(initial.body.analyzedAt));

  const uploaded = await upload(readable, 'valid-id.png');
  assert.equal(uploaded.response.status, 201);
  const document = uploaded.body.documents[0];
  assert.equal(document.analysis.accepted, true);
  assert.ok(document.analysis.receipt);
  const indigencyUpload = await upload(readable, 'indigency.png', 'image/png', applicantToken, 'Barangay Certificate of Indigency');
  const receiptUpload = await upload(readable, 'receipt.png', 'image/png', applicantToken, 'Recent facility receipt or billing document');
  const receiptDocument = receiptUpload.body.documents[0];

  const application = {
    assistanceType: 'Hospital Assistance',
    incomeSource: 'Salary or wages',
    patientCircumstance: 'Disease',
    documents: [document, indigencyUpload.body.documents[0], receiptDocument],
    facilityEvidence: recentFacilityEvidence(receiptDocument),
  };
  const tampered = structuredClone(application);
  tampered.documents[0].analysis.warnings.push('Applicant-edited warning');
  const rejected = await fetch(`${baseUrl}/api/applicant/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${applicantToken}` },
    body: JSON.stringify(tampered),
  });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).message, /accepted quality analysis/i);

  const submitted = await fetch(`${baseUrl}/api/applicant/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${applicantToken}` },
    body: JSON.stringify(application),
  });
  assert.equal(submitted.status, 201);

  const stored = JSON.parse(await readFile(process.env.AIDLINK_DATA_PATH, 'utf8'));
  const analysis = stored.requests[0].documents[0].analysis;
  assert.equal(analysis.accepted, true);
  assert.ok(Array.isArray(analysis.warnings));
  assert.equal(analysis.orientation, 'landscape');
  assert.equal(analysis.analyzerVersion, 'aidlink-document-quality-v3');
  assert.ok(Date.parse(analysis.analyzedAt));
  assert.equal(analysis.authenticityVerified, false);
});

test('normalizes a replaceable AI analyzer into advisory human review without authenticity decisions', async () => {
  setDocumentAnalyzer({
    id: 'future-ai-test',
    kind: 'ai',
    version: 'future-ai-test-v1',
    confidenceThreshold: 0.8,
    capabilities: ['document_classification', 'missing_pages', 'text_readability'],
    async analyze({ file, requestedType, analyzedAt, privacy }) {
      assert.equal(privacy.retainInput, false);
      assert.equal(privacy.retainDerivedImages, false);
      return {
        accepted: true,
        documentType: requestedType,
        fileName: file.originalname,
        issues: [],
        warnings: [],
        checks: { validFileContents: true },
        imageQuality: null,
        orientation: 'landscape',
        analyzedAt,
        confidence: 0.42,
        classification: { documentType: requestedType, confidence: 0.61 },
        missingPages: { detected: false, confidence: 0.55 },
        likelyUnreadableText: { detected: true, confidence: 0.52 },
        explanations: ['Text confidence is low near the lower edge.'],
        authenticityVerified: true,
        eligibilityDetermined: true,
      };
    },
  });
  try {
    const readable = await patternedImage();
    const analyzed = await analyze(readable);
    assert.equal(analyzed.response.status, 200);
    assert.equal(analyzed.body.accepted, true);
    assert.equal(analyzed.body.decision, 'human_review_required');
    assert.equal(analyzed.body.requiresHumanReview, true);
    assert.equal(analyzed.body.authenticityVerified, false);
    assert.equal(analyzed.body.eligibilityDetermined, false);
    assert.equal(analyzed.body.analyzer.kind, 'ai');
    assert.equal(analyzed.body.analyzer.version, 'future-ai-test-v1');
    assert.equal(analyzed.body.retention.inputBufferRetainedByAnalyzer, false);
    assert.match(analyzed.body.warnings.join(' '), /Case Worker must review/i);
    assert.match(analyzed.body.humanReviewReasons.join(' '), /below.*review threshold/i);

    const validId = (await upload(readable, 'ai-valid-id.png')).body.documents[0];
    const indigency = (await upload(readable, 'ai-indigency.png', 'image/png', applicantToken, 'Barangay Certificate of Indigency')).body.documents[0];
    const receipt = (await upload(readable, 'ai-receipt.png', 'image/png', applicantToken, 'Recent facility receipt or billing document')).body.documents[0];
    const submission = await fetch(`${baseUrl}/api/applicant/applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${applicantToken}` },
      body: JSON.stringify({
        assistanceType: 'Hospital Assistance',
        incomeSource: 'Salary or wages',
        patientCircumstance: 'Disease',
        documents: [validId, indigency, receipt],
        facilityEvidence: recentFacilityEvidence(receipt),
      }),
    });
    assert.equal(submission.status, 201);
    const request = await submission.json();
    assert.equal(request.documentAnalysisReview.required, true);
    assert.equal(request.documentAnalysisReview.status, 'case_worker_review_required');
    assert.equal(request.documentAnalysisReview.documents.length, 3);
  } finally {
    setDocumentAnalyzer(deterministicDocumentAnalyzer);
  }
});

test('protects stored documents with applicant ownership and staff permissions', async () => {
  const readable = await patternedImage();
  const document = (await upload(readable, 'protected-id.png')).body.documents[0];
  const target = new URL(document.url);

  const unauthenticated = await fetch(target);
  assert.equal(unauthenticated.status, 401);

  const owner = await fetch(target, {
    headers: { Authorization: `Bearer ${applicantToken}` },
  });
  assert.equal(owner.status, 200);
  assert.equal(owner.headers.get('cache-control'), 'private, no-store, max-age=0');

  const otherRegistration = await fetch(`${baseUrl}/api/applicant/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: 'Document Intruder',
      email: 'document-intruder@example.com',
      phone: '09170000008',
      address: 'Davao City',
      dateOfBirth: '1994-01-01',
      password: 'other-pass',
    }),
  });
  const otherToken = (await otherRegistration.json()).token;
  const otherApplicant = await fetch(target, {
    headers: { Authorization: `Bearer ${otherToken}` },
  });
  assert.equal(otherApplicant.status, 404);

  const staffLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'worker@example.com', password: 'worker-pass' }),
  });
  const staffToken = (await staffLogin.json()).token;
  const permittedStaff = await fetch(target, {
    headers: { Authorization: `Bearer ${staffToken}` },
  });
  assert.equal(permittedStaff.status, 404);
});

test('allows only the owner to replace requested documents and preserves the full audit trail', async () => {
  const readable = await patternedImage();
  const firstUpload = await upload(readable, 'valid-id.png');
  const secondUpload = await upload(readable, 'indigency.png', 'image/png', applicantToken, 'Barangay Certificate of Indigency');
  const receiptUpload = await upload(readable, 'receipt.png', 'image/png', applicantToken, 'Recent facility receipt or billing document');
  assert.equal(firstUpload.response.status, 201);
  assert.equal(secondUpload.response.status, 201);
  assert.equal(receiptUpload.response.status, 201);
  const receiptDocument = receiptUpload.body.documents[0];
  const originalDocuments = [firstUpload.body.documents[0], secondUpload.body.documents[0], receiptDocument];

  const submitted = await fetch(`${baseUrl}/api/applicant/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${applicantToken}` },
    body: JSON.stringify({
      assistanceType: 'Hospital Assistance', incomeSource: 'Salary or wages',
      patientCircumstance: 'Disease', documents: originalDocuments,
      facilityEvidence: recentFacilityEvidence(receiptDocument),
    }),
  });
  assert.equal(submitted.status, 201);
  const request = await submitted.json();

  const staffLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'worker@example.com', password: 'worker-pass' }),
  });
  assert.equal(staffLogin.status, 200);
  const staffToken = (await staffLogin.json()).token;

  const missingDocumentsResponse = await fetch(`${baseUrl}/api/requests/${request.id}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` },
    body: JSON.stringify({ status: 'correction_requested', remarks: 'Replace the unreadable document with a clear copy.', correctionDocumentIds: [] }),
  });
  assert.equal(missingDocumentsResponse.status, 400);
  assert.match((await missingDocumentsResponse.json()).message, /select at least one document/i);

  const missingRemarkResponse = await fetch(`${baseUrl}/api/requests/${request.id}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` },
    body: JSON.stringify({ status: 'correction_requested', remarks: '   ', correctionDocumentIds: [request.documents[0].id] }),
  });
  assert.equal(missingRemarkResponse.status, 400);
  assert.match((await missingRemarkResponse.json()).message, /correction remark/i);
  const unchangedAfterValidation = JSON.parse(await readFile(process.env.AIDLINK_DATA_PATH, 'utf8')).requests.find((item) => item.id === request.id);
  assert.equal(unchangedAfterValidation.status, 'pending');
  assert.equal(unchangedAfterValidation.correctionRequest, undefined);

  const correctionResponse = await fetch(`${baseUrl}/api/requests/${request.id}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` },
    body: JSON.stringify({
      status: 'correction_requested',
      remarks: 'Replace the blurred Valid ID and keep every edge visible.',
      correctionDocumentIds: [request.documents[0].id],
    }),
  });
  assert.equal(correctionResponse.status, 200);
  const correctionRequest = await correctionResponse.json();
  assert.equal(correctionRequest.status, 'correction_requested');
  assert.deepEqual(correctionRequest.correctionRequest.documents.map((item) => item.documentId), [request.documents[0].id]);
  assert.equal(correctionRequest.correctionRequest.remark, 'Replace the blurred Valid ID and keep every edge visible.');
  assert.equal(correctionRequest.correctionRequest.requestedBy, 'Case Worker');
  assert.ok(Date.parse(correctionRequest.correctionRequest.requestedAt));

  const notifications = await fetch(`${baseUrl}/api/applicant/notifications`, {
    headers: { Authorization: `Bearer ${applicantToken}` },
  });
  assert.equal(notifications.status, 200);
  assert.match((await notifications.json())[0].message, /Replace.*Valid Id/i);

  const otherRegistration = await fetch(`${baseUrl}/api/applicant/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName: 'Other Applicant', email: 'other@example.com', phone: '09170000009', address: 'Davao City', dateOfBirth: '1992-01-01', password: 'other-pass' }),
  });
  assert.equal(otherRegistration.status, 201);
  const otherToken = (await otherRegistration.json()).token;
  await markVerified('other@example.com');
  const forbidden = await upload(readable, 'stolen-replacement.png', 'image/png', otherToken);
  assert.equal(forbidden.response.status, 201);
  const forbiddenForm = new FormData();
  forbiddenForm.append('document', new Blob([readable], { type: 'image/png' }), 'stolen-replacement.png');
  const forbiddenReplacement = await fetch(`${baseUrl}/api/applicant/requests/${request.id}/corrections/documents/${request.documents[0].id}`, {
    method: 'POST', headers: { Authorization: `Bearer ${otherToken}` }, body: forbiddenForm,
  });
  assert.equal(forbiddenReplacement.status, 404);
  const forbiddenSubmit = await fetch(`${baseUrl}/api/applicant/requests/${request.id}/corrections/submit`, {
    method: 'POST', headers: { Authorization: `Bearer ${otherToken}` },
  });
  assert.equal(forbiddenSubmit.status, 404);

  const unrelatedForm = new FormData();
  unrelatedForm.append('document', new Blob([readable], { type: 'image/png' }), 'unrelated-indigency.png');
  const unrelatedReplacement = await fetch(`${baseUrl}/api/applicant/requests/${request.id}/corrections/documents/${request.documents[1].id}`, {
    method: 'POST', headers: { Authorization: `Bearer ${applicantToken}` }, body: unrelatedForm,
  });
  assert.equal(unrelatedReplacement.status, 400);
  assert.match((await unrelatedReplacement.json()).message, /not currently eligible for replacement/i);

  const darkImage = await patternedImage({ edge: 10, low: 5, high: 20 });
  const failedForm = new FormData();
  failedForm.append('document', new Blob([darkImage], { type: 'image/png' }), 'dark-id.png');
  const failedReplacement = await fetch(`${baseUrl}/api/applicant/requests/${request.id}/corrections/documents/${request.documents[0].id}`, {
    method: 'POST', headers: { Authorization: `Bearer ${applicantToken}` }, body: failedForm,
  });
  assert.equal(failedReplacement.status, 422);
  assert.match((await failedReplacement.json()).message, /bright, even lighting/i);

  const replacementForm = new FormData();
  replacementForm.append('document', new Blob([readable], { type: 'image/png' }), 'replacement-id.png');
  const replacementResponse = await fetch(`${baseUrl}/api/applicant/requests/${request.id}/corrections/documents/${request.documents[0].id}`, {
    method: 'POST', headers: { Authorization: `Bearer ${applicantToken}` }, body: replacementForm,
  });
  assert.equal(replacementResponse.status, 201);
  const replacement = (await replacementResponse.json()).replacementDocument;
  assert.equal(replacement.replacesDocumentId, request.documents[0].id);
  assert.equal(replacement.analysis.accepted, true);

  const correctionsSubmitted = await fetch(`${baseUrl}/api/applicant/requests/${request.id}/corrections/submit`, {
    method: 'POST', headers: { Authorization: `Bearer ${applicantToken}` },
  });
  assert.equal(correctionsSubmitted.status, 200);
  const corrected = await correctionsSubmitted.json();
  assert.equal(corrected.status, 'under_review');
  assert.equal(corrected.documents[0].id, replacement.id);
  assert.equal(corrected.documents[1].id, request.documents[1].id);

  const multipleCorrectionResponse = await fetch(`${baseUrl}/api/requests/${request.id}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` },
    body: JSON.stringify({
      status: 'correction_requested',
      remarks: 'Replace both the Valid ID and indigency certificate with complete, readable copies.',
      correctionDocumentIds: [corrected.documents[0].id, corrected.documents[1].id],
    }),
  });
  assert.equal(multipleCorrectionResponse.status, 200);
  const multipleCorrection = await multipleCorrectionResponse.json();
  assert.equal(multipleCorrection.status, 'correction_requested');
  assert.deepEqual(multipleCorrection.correctionRequest.documents.map((item) => item.documentId), [corrected.documents[0].id, corrected.documents[1].id]);

  const unrelatedReceiptForm = new FormData();
  unrelatedReceiptForm.append('document', new Blob([readable], { type: 'image/png' }), 'unrelated-receipt.png');
  const unrelatedReceiptReplacement = await fetch(`${baseUrl}/api/applicant/requests/${request.id}/corrections/documents/${corrected.documents[2].id}`, {
    method: 'POST', headers: { Authorization: `Bearer ${applicantToken}` }, body: unrelatedReceiptForm,
  });
  assert.equal(unrelatedReceiptReplacement.status, 400);

  const multipleReplacementDocuments = [];
  for (const [index, document] of multipleCorrection.correctionRequest.documents.entries()) {
    const form = new FormData();
    form.append('document', new Blob([readable], { type: 'image/png' }), `multiple-replacement-${index + 1}.png`);
    const response = await fetch(`${baseUrl}/api/applicant/requests/${request.id}/corrections/documents/${document.documentId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${applicantToken}` }, body: form,
    });
    assert.equal(response.status, 201);
    multipleReplacementDocuments.push((await response.json()).replacementDocument);
  }
  const multipleCorrectionsSubmitted = await fetch(`${baseUrl}/api/applicant/requests/${request.id}/corrections/submit`, {
    method: 'POST', headers: { Authorization: `Bearer ${applicantToken}` },
  });
  assert.equal(multipleCorrectionsSubmitted.status, 200);
  const multiplyCorrected = await multipleCorrectionsSubmitted.json();
  assert.equal(multiplyCorrected.status, 'under_review');
  assert.deepEqual(multiplyCorrected.documents.slice(0, 2).map((item) => item.id), multipleReplacementDocuments.map((item) => item.id));
  assert.equal(multiplyCorrected.documents[2].id, corrected.documents[2].id);

  const data = JSON.parse(await readFile(process.env.AIDLINK_DATA_PATH, 'utf8'));
  const storedRequest = data.requests.find((item) => item.id === request.id);
  assert.equal(storedRequest.documentHistory[0].id, request.documents[0].id);
  assert.equal(storedRequest.documentHistory.length, 3);
  assert.equal(storedRequest.correctionHistory.length, 2);
  assert.equal(storedRequest.correctionHistory.every((item) => item.requestedBy === 'Case Worker'), true);
  const audit = data.auditLogs.filter((item) => item.requestId === request.id);
  assert.deepEqual(audit.map((item) => item.action), [
    'application_submitted',
    'correction_requested', 'correction_document_uploaded', 'corrections_submitted',
    'correction_requested', 'correction_document_uploaded', 'correction_document_uploaded', 'corrections_submitted',
  ]);
  assert.equal(audit[1].performedBy, 'Case Worker');
  assert.equal(audit[7].performedBy, 'Quality Applicant');
  assert.equal(audit[3].previousDocuments[0].id, request.documents[0].id);
  assert.equal(audit[3].replacementDocuments[0].id, replacement.id);
  assert.equal(audit[7].previousDocuments.length, 2);
  assert.equal(audit[7].replacementDocuments.length, 2);
});
