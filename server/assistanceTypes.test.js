import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assistanceTypes, isValidAssistanceType } from '../shared/assistanceTypes.js';
import {
  incomeSources,
  patientCircumstances,
  isValidIncomeSource,
  isValidPatientCircumstance,
} from '../shared/applicationIntakeOptions.js';

let server;
let baseUrl;
let testRoot;

before(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'aidlink-types-'));
  process.env.AIDLINK_DATA_PATH = path.join(testRoot, 'data.json');
  process.env.AIDLINK_UPLOADS_PATH = path.join(testRoot, 'uploads');
  await writeFile(process.env.AIDLINK_DATA_PATH, JSON.stringify({
    authUsers: [
      {
        id: 'auth-admin',
        fullName: 'Test Administrator',
        email: 'admin@example.com',
        password: 'admin-pass',
        phone: '09170000002',
        address: 'Davao City',
        dateOfBirth: '1985-01-01',
        sex: 'Female',
        role: 'System Administrator',
        registeredDate: '2025-01-01T00:00:00.000Z',
      },
      {
        id: 'auth-worker',
        fullName: 'Test Case Worker',
        email: 'worker@example.com',
        password: 'worker-pass',
        role: 'Case Worker',
        registeredDate: '2025-01-02T00:00:00.000Z',
      },
    ],
    users: [],
    applicants: [],
    requests: [{
      id: 'legacy-request',
      requestId: 'LINGAP-2025-00001',
      applicantName: 'Legacy Applicant',
      email: 'legacy@example.com',
      phone: '09170000001',
      address: 'Davao City',
      dateOfBirth: '1980-01-01',
      assistanceType: 'Medicine Assistance',
      reason: 'Legacy free-text reason',
      documents: [],
      status: 'pending',
      dateSubmitted: '2025-01-01T00:00:00.000Z',
    }],
    notifications: [],
    facilities: [],
    auditLogs: [],
    requiredDocuments: {
      'Medicine Assistance': ['Prescription', 'Medical Certificate'],
    },
    nextAuthUserId: 3,
    nextUserId: 1,
    nextApplicantId: 1,
    nextRequestId: 2,
    nextNotificationId: 1,
    nextAuditId: 1,
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
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
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

test('exports exactly the confirmed canonical assistance types', () => {
  assert.deepEqual([...assistanceTypes], [
    'Hospital Assistance',
    'Funeral Assistance',
    'Procedure',
    'Laboratory',
    'Dialysis',
    'Apparatus',
  ]);
  assert.equal(isValidAssistanceType('Medicine Assistance'), false);
  assert.equal(isValidAssistanceType('Other Assistance'), false);
  assert.equal(isValidAssistanceType('Medical Assistance'), false);
});

test('exports exactly the confirmed structured intake choices', () => {
  assert.deepEqual([...incomeSources], [
    'Salary or wages',
    'Self-employment or business',
    'Informal or daily-wage work',
    'Pension',
    'Government assistance',
    'Family or remittance support',
    'No income',
    'Other',
  ]);
  assert.deepEqual([...patientCircumstances], [
    'Accident',
    'Disease',
    'Existing health issue',
    'Injury',
    'Other',
  ]);
  assert.equal(isValidIncomeSource('Lottery winnings'), false);
  assert.equal(isValidPatientCircumstance('Unapproved category'), false);
});

test('submission routes accept canonical types and reject removed values', async () => {
  const registration = await post('/api/applicant/auth/register', {
    fullName: 'Test Applicant',
    email: 'applicant@example.com',
    phone: '09170000000',
    address: 'Davao City',
    dateOfBirth: '1990-01-01',
    password: 'strong-pass',
  });
  assert.equal(registration.status, 201);
  const { token } = await registration.json();
  await markVerified('applicant@example.com');
  const requirements = ['Valid ID', 'Barangay Certificate of Indigency', 'Recent facility receipt or billing document'];
  const analyzedDocuments = [];
  for (const [index, requirement] of requirements.entries()) {
    const analyzedUpload = await post('/api/uploads', {
      name: `document-${index + 1}.pdf`,
      documentType: requirement,
      contentBase64: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF').toString('base64'),
    }, token);
    assert.equal(analyzedUpload.status, 201);
    analyzedDocuments.push(await analyzedUpload.json());
  }
  const receiptDocument = analyzedDocuments[2];
  const common = {
    fullName: 'Test Patient',
    email: 'applicant@example.com',
    phone: '09170000000',
    address: 'Davao City',
    dateOfBirth: '1990-01-01',
    incomeSource: 'Salary or wages',
    patientCircumstance: 'Disease',
    additionalDetails: 'Optional test details',
    documents: analyzedDocuments,
    facilityEvidence: {
      facilityName: 'Canonical Test Hospital',
      facilityType: 'hospital',
      receiptDate: new Date().toISOString().slice(0, 10),
      referenceNumber: 'TYPE-TEST-001',
      receiptDocumentId: receiptDocument.id,
    },
  };

  for (const assistanceType of assistanceTypes) {
    const response = await post('/api/applicant/applications', {
      assistanceType,
      incomeSource: common.incomeSource,
      patientCircumstance: common.patientCircumstance,
      additionalDetails: common.additionalDetails,
      documents: common.documents,
      facilityEvidence: common.facilityEvidence,
    }, token);
    assert.equal(response.status, 201, assistanceType);
  }
  const legacyAccepted = await post('/api/applications', {
    ...common,
    assistanceType: 'Procedure',
  }, token);
  assert.equal(legacyAccepted.status, 201);

  for (const assistanceType of ['Medicine Assistance', 'Other Assistance', 'Medical Assistance']) {
    const authenticated = await post('/api/applicant/applications', {
      assistanceType,
      incomeSource: common.incomeSource,
      patientCircumstance: common.patientCircumstance,
      documents: common.documents,
      facilityEvidence: common.facilityEvidence,
    }, token);
    assert.equal(authenticated.status, 400, assistanceType);
    if (assistanceType === 'Medicine Assistance') {
      assert.match((await authenticated.json()).message, /no longer available/i);
    }
    const legacy = await post('/api/applications', { ...common, assistanceType }, token);
    assert.equal(legacy.status, 400, assistanceType);
    if (assistanceType === 'Medicine Assistance') {
      assert.match((await legacy.json()).message, /no longer available/i);
    }
  }

  const listResponse = await fetch(`${baseUrl}/api/assistance-types`);
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await listResponse.json(), [...assistanceTypes]);
  const requirementsResponse = await fetch(
    `${baseUrl}/api/assistance-types/required-documents`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(requirementsResponse.status, 403);

  const reasonOnly = await post('/api/applicant/applications', {
    assistanceType: 'Hospital Assistance',
    reason: 'Old clients must not bypass structured intake',
    documents: common.documents,
  }, token);
  assert.equal(reasonOnly.status, 400);

  const invalidIncome = await post('/api/applicant/applications', {
    assistanceType: 'Hospital Assistance',
    incomeSource: 'Lottery winnings',
    patientCircumstance: 'Disease',
    documents: common.documents,
  }, token);
  assert.equal(invalidIncome.status, 400);

  const invalidCircumstance = await post('/api/applications', {
    ...common,
    assistanceType: 'Hospital Assistance',
    patientCircumstance: 'Unapproved category',
  }, token);
  assert.equal(invalidCircumstance.status, 400);

  const systemLogin = await post('/api/auth/login', {
    email: 'admin@example.com',
    password: 'admin-pass',
  });
  assert.equal(systemLogin.status, 200);
  const { token: systemToken } = await systemLogin.json();
  const systemRequirements = await fetch(
    `${baseUrl}/api/assistance-types/required-documents`,
    { headers: { Authorization: `Bearer ${systemToken}` } },
  );
  assert.equal(systemRequirements.status, 200);
  assert.deepEqual(Object.keys(await systemRequirements.json()), [...assistanceTypes]);
  const staffLogin = await post('/api/auth/login', {
    email: 'worker@example.com',
    password: 'worker-pass',
  });
  assert.equal(staffLogin.status, 200);
  const { token: staffToken } = await staffLogin.json();
  const processedLegacy = await fetch(`${baseUrl}/api/requests/legacy-request/status`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${staffToken}`,
    },
    body: JSON.stringify({
      status: 'under_review',
      remarks: 'Historical request remains processable.',
    }),
  });
  assert.equal(processedLegacy.status, 200);
  assert.equal((await processedLegacy.json()).assistanceType, 'Medicine Assistance');

  const storedData = JSON.parse(await readFile(process.env.AIDLINK_DATA_PATH, 'utf8'));
  const newRequest = storedData.requests.find((request) => request.additionalDetails === common.additionalDetails);
  assert.equal(newRequest.incomeSource, 'Salary or wages');
  assert.equal(newRequest.patientCircumstance, 'Disease');
  assert.equal('reason' in newRequest, false);
  const legacyRequest = storedData.requests.find((request) => request.id === 'legacy-request');
  assert.equal(legacyRequest.reason, 'Legacy free-text reason');
  assert.equal(legacyRequest.assistanceType, 'Medicine Assistance');
  assert.equal(legacyRequest.status, 'under_review');
  assert.equal('Medicine Assistance' in storedData.requiredDocuments, false);
});
