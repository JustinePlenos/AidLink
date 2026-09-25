import crypto from 'node:crypto';

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const totpPeriodSeconds = 30;
const totpDigits = 6;

function keyFor(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encodePayload(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function createPurposeToken(payload, secret) {
  const encoded = encodePayload(payload);
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyPurposeToken(token, secret, expectedPurpose) {
  try {
    const [encoded, signature] = String(token || '').split('.');
    if (!encoded || !signature) return null;
    const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (payload.purpose !== expectedPurpose || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function encryptMfaSecret(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((item) => item.toString('base64url')).join('.');
}

export function decryptMfaSecret(value, secret) {
  const [iv, tag, encrypted] = String(value || '').split('.').map((item) => Buffer.from(item, 'base64url'));
  if (!iv?.length || !tag?.length || !encrypted?.length) throw new Error('Invalid encrypted MFA secret.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let index = 0; index < bits.length; index += 5) {
    output += base32Alphabet[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
  }
  return output;
}

function base32Decode(value) {
  const normalized = String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const character of normalized) {
    const index = base32Alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid base32 secret.');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function totpCode(secret, at = Date.now(), counterOverride = null) {
  const counter = counterOverride ?? Math.floor(at / 1000 / totpPeriodSeconds);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** totpDigits)).padStart(totpDigits, '0');
}

export function verifyTotpCode(secret, code, { at = Date.now(), lastCounter = -1, window = 1 } = {}) {
  const normalized = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  const current = Math.floor(at / 1000 / totpPeriodSeconds);
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = current + offset;
    if (counter <= lastCounter) continue;
    const expected = totpCode(secret, at, counter);
    if (crypto.timingSafeEqual(Buffer.from(normalized), Buffer.from(expected))) return counter;
  }
  return null;
}

export function createAuthenticatorUri({ issuer, email, secret }) {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${totpDigits}&period=${totpPeriodSeconds}`;
}

export function hashMfaCode(code, secret, context = 'recovery') {
  return crypto.createHmac('sha256', keyFor(secret))
    .update(`${context}:${String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')}`)
    .digest('base64url');
}

export function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const value = crypto.randomBytes(6).toString('hex').toUpperCase();
    return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
  });
}

export function generateSmsOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function safeMfaStatus(applicant) {
  const mfa = applicant.mfa || {};
  return {
    enabled: mfa.enabled === true,
    primaryMethod: mfa.enabled ? 'totp' : null,
    smsFallbackAvailable: mfa.enabled === true && mfa.smsRecoveryEnabled !== false && Boolean(applicant.phone),
    recoveryCodesRemaining: Array.isArray(mfa.recoveryCodeHashes) ? mfa.recoveryCodeHashes.length : 0,
    enrolledAt: mfa.enrolledAt || null,
  };
}
