import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let server;
let baseUrl;
let testRoot;
let totpCode;
let sentSms;

before(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'aidlink-mfa-'));
  process.env.AIDLINK_DATA_PATH = path.join(testRoot, 'data.json');
  process.env.AIDLINK_UPLOADS_PATH = path.join(testRoot, 'uploads');
  process.env.AIDLINK_TOKEN_SECRET = 'test-token-secret';
  process.env.AIDLINK_MFA_ENCRYPTION_SECRET = 'separate-test-mfa-encryption-secret';
  await writeFile(process.env.AIDLINK_DATA_PATH, JSON.stringify({
    authUsers: [],
    applicants: [],
    users: [],
    requests: [],
    notifications: [],
    facilities: [],
    auditLogs: [],
    requiredDocuments: {},
    nextAuthUserId: 1,
    nextApplicantId: 1,
    nextUserId: 1,
    nextRequestId: 1,
    nextNotificationId: 1,
    nextAuditId: 1,
  }));
  ({ totpCode } = await import('./services/applicantMfaService.js'));
  const { setSmsProviderAdapter } = await import('./services/smsNotificationService.js');
  setSmsProviderAdapter({
    name: 'test-mfa-adapter',
    async send(payload) {
      sentSms = payload;
      return { status: 'sent', providerMessageId: 'mfa-message-1' };
    },
  });
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
  return { status: response.status, body: await response.json() };
}

async function beginStepUp(token, password = 'strong-pass') {
  return request('/api/applicant/mfa/step-up/start', {
    method: 'POST',
    token,
    body: { currentPassword: password },
  });
}

test('enforces TOTP login, one-time recovery, SMS fallback, and step-up account changes', async () => {
  const registration = await request('/api/applicant/auth/register', {
    method: 'POST',
    body: {
      fullName: 'MFA Applicant',
      email: 'mfa@example.com',
      phone: '09171234567',
      address: 'Davao City',
      dateOfBirth: '1990-01-01',
      password: 'strong-pass',
    },
  });
  assert.equal(registration.status, 201);
  const initialToken = registration.body.token;

  const wrongPassword = await request('/api/applicant/mfa/totp/enroll/start', {
    method: 'POST',
    token: initialToken,
    body: { currentPassword: 'wrong-pass' },
  });
  assert.equal(wrongPassword.status, 401);

  const enrollment = await request('/api/applicant/mfa/totp/enroll/start', {
    method: 'POST',
    token: initialToken,
    body: { currentPassword: 'strong-pass' },
  });
  assert.equal(enrollment.status, 201);
  assert.match(enrollment.body.otpauthUri, /^otpauth:\/\/totp\//);
  assert.match(enrollment.body.qrCodeImageDataUrl, /^data:image\/png;base64,/);

  const confirmed = await request('/api/applicant/mfa/totp/enroll/confirm', {
    method: 'POST',
    token: initialToken,
    body: { code: totpCode(enrollment.body.secret) },
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.recoveryCodesShownOnce, true);
  assert.equal(confirmed.body.recoveryCodes.length, 10);
  assert.equal(confirmed.body.status.primaryMethod, 'totp');
  const enrolledToken = confirmed.body.token;
  assert.equal((await request('/api/applicant/profile', { token: initialToken })).status, 401);

  const storedAfterEnrollment = JSON.parse(await readFile(process.env.AIDLINK_DATA_PATH, 'utf8'));
  const storedApplicant = storedAfterEnrollment.applicants[0];
  assert.equal(JSON.stringify(storedApplicant).includes(enrollment.body.secret), false);
  assert.equal(JSON.stringify(storedApplicant).includes(confirmed.body.recoveryCodes[0]), false);
  assert.ok(storedApplicant.mfa.totpSecretEncrypted);
  assert.equal(storedApplicant.mfa.recoveryCodeHashes.length, 10);

  const passwordStage = await request('/api/applicant/auth/login', {
    method: 'POST',
    body: { email: 'mfa@example.com', password: 'strong-pass' },
  });
  assert.equal(passwordStage.status, 202);
  assert.equal(passwordStage.body.mfaRequired, true);
  assert.equal(passwordStage.body.token, undefined);
  assert.deepEqual(passwordStage.body.methods, ['totp', 'sms', 'recovery_code']);

  const invalid = await request('/api/applicant/auth/mfa/verify', {
    method: 'POST',
    body: { challengeToken: passwordStage.body.challengeToken, method: 'totp', code: '000000' },
  });
  assert.equal(invalid.status, 401);

  const recoveryLogin = await request('/api/applicant/auth/mfa/verify', {
    method: 'POST',
    body: { challengeToken: passwordStage.body.challengeToken, method: 'recovery_code', code: confirmed.body.recoveryCodes[0] },
  });
  assert.equal(recoveryLogin.status, 200);
  const recoveredToken = recoveryLogin.body.token;
  assert.equal(recoveryLogin.body.user.mfa.recoveryCodesRemaining, 9);
  assert.equal(recoveryLogin.body.user.mfa.totpSecretEncrypted, undefined);

  const noStepUp = await request('/api/applicant/account/contact', {
    method: 'PATCH',
    token: recoveredToken,
    body: { email: 'changed@example.com' },
  });
  assert.equal(noStepUp.status, 403);

  const stepStart = await beginStepUp(recoveredToken);
  assert.equal(stepStart.status, 202);
  const stepVerify = await request('/api/applicant/mfa/step-up/verify', {
    method: 'POST',
    token: recoveredToken,
    body: {
      challengeToken: stepStart.body.challengeToken,
      method: 'totp',
      code: totpCode(enrollment.body.secret, Date.now() + 30_000),
    },
  });
  assert.equal(stepVerify.status, 200);
  const contactChange = await request('/api/applicant/account/contact', {
    method: 'PATCH',
    token: recoveredToken,
    body: { email: 'changed@example.com', phone: '09179876543', stepUpToken: stepVerify.body.stepUpToken },
  });
  assert.equal(contactChange.status, 200);
  assert.equal(contactChange.body.user.email, 'changed@example.com');
  const changedToken = contactChange.body.token;
  assert.equal((await request('/api/applicant/profile', { token: recoveredToken })).status, 401);

  const reusedStepUp = await request('/api/applicant/account/password', {
    method: 'POST',
    token: changedToken,
    body: { newPassword: 'new-strong-pass', stepUpToken: stepVerify.body.stepUpToken },
  });
  assert.equal(reusedStepUp.status, 403);

  const smsLoginStart = await request('/api/applicant/auth/login', {
    method: 'POST',
    body: { email: 'changed@example.com', password: 'strong-pass' },
  });
  assert.equal(smsLoginStart.status, 202);
  const smsRequested = await request('/api/applicant/auth/mfa/sms/request', {
    method: 'POST',
    body: { challengeToken: smsLoginStart.body.challengeToken },
  });
  assert.equal(smsRequested.status, 202);
  assert.equal(sentSms.to, '+639179876543');
  assert.match(sentSms.body, /Never share this code/i);
  const smsCode = sentSms.body.match(/\b\d{6}\b/)[0];
  const smsLogin = await request('/api/applicant/auth/mfa/verify', {
    method: 'POST',
    body: { challengeToken: smsLoginStart.body.challengeToken, method: 'sms', code: smsCode },
  });
  assert.equal(smsLogin.status, 200);

  const passwordStepStart = await beginStepUp(smsLogin.body.token);
  const passwordStep = await request('/api/applicant/mfa/step-up/verify', {
    method: 'POST',
    token: smsLogin.body.token,
    body: {
      challengeToken: passwordStepStart.body.challengeToken,
      method: 'recovery_code',
      code: confirmed.body.recoveryCodes[1],
    },
  });
  assert.equal(passwordStep.status, 200);
  const passwordChange = await request('/api/applicant/account/password', {
    method: 'POST',
    token: smsLogin.body.token,
    body: { newPassword: 'new-strong-pass', stepUpToken: passwordStep.body.stepUpToken },
  });
  assert.equal(passwordChange.status, 200);
  assert.equal((await request('/api/applicant/profile', { token: smsLogin.body.token })).status, 401);

  assert.equal((await request('/api/applicant/auth/login', {
    method: 'POST',
    body: { email: 'changed@example.com', password: 'strong-pass' },
  })).status, 401);
  assert.equal((await request('/api/applicant/auth/login', {
    method: 'POST',
    body: { email: 'changed@example.com', password: 'new-strong-pass' },
  })).status, 202);

  const finalData = JSON.parse(await readFile(process.env.AIDLINK_DATA_PATH, 'utf8'));
  const actions = new Set(finalData.auditLogs.map((entry) => entry.action));
  for (const action of ['mfa_enrolled', 'mfa_verification_succeeded', 'mfa_verification_failed', 'mfa_recovery_started', 'mfa_recovery_completed', 'applicant_contact_changed', 'applicant_password_changed']) {
    assert.equal(actions.has(action), true, action);
  }
});
