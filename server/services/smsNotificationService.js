const terminalStatuses = new Set(['delivered', 'failed']);
const providerResultStatuses = new Set(['queued', 'sent', 'delivered']);

export class SmsProviderError extends Error {
  constructor(message, { code = 'provider_error', retryable = true } = {}) {
    super(message);
    this.name = 'SmsProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

const unconfiguredAdapter = {
  name: 'unconfigured',
  configured: false,
  async send() {
    throw new SmsProviderError('No SMS provider adapter is configured.', {
      code: 'provider_not_configured',
      retryable: false,
    });
  },
};

let activeAdapter = unconfiguredAdapter;

export function setSmsProviderAdapter(adapter) {
  if (!adapter) {
    activeAdapter = unconfiguredAdapter;
    return;
  }
  if (typeof adapter.name !== 'string' || !adapter.name.trim() || typeof adapter.send !== 'function') {
    throw new TypeError('An SMS adapter requires a name and async send function.');
  }
  activeAdapter = { configured: true, ...adapter, name: adapter.name.trim() };
}

export function getSmsProviderMetadata() {
  return { name: activeAdapter.name, configured: activeAdapter.configured !== false };
}

export function normalizeSmsRecipient(value) {
  const raw = String(value || '').trim();
  const compact = raw.replace(/[\s()-]/g, '');
  if (/^09\d{9}$/.test(compact)) return `+63${compact.slice(1)}`;
  if (/^63\d{10}$/.test(compact)) return `+${compact}`;
  if (/^\+\d{8,15}$/.test(compact)) return compact;
  return null;
}

function readableDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-PH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Manila',
  }).format(parsed);
}

export function buildApprovalSms({ request, settings }) {
  const tracking = request.guaranteeLetterTracking || {};
  const claimingDate = tracking.scheduledFor || 'Contact LINGAP for your claiming date';
  const claimingTime = tracking.claimingTime || settings.defaultClaimingTime;
  const claimingLocation = tracking.claimingLocation || settings.defaultClaimingLocation;
  const helpChannel = settings.smsHelpChannel;
  return [
    `AidLink: ${request.applicantName || request.requestId}, request ${request.requestId} is approved.`,
    `Claim on ${readableDate(claimingDate)} at ${claimingTime}, ${claimingLocation}.`,
    'Bring a valid government-issued ID.',
    'If another person will claim, bring an authorization letter and the authorized representative\'s valid government-issued ID.',
    `Help: ${helpChannel}.`,
    'Never share your passwords or OTPs.',
  ].join(' ');
}

export function createApprovalSmsNotification(data, request, settings, now = new Date()) {
  const createdAt = now.toISOString();
  const notification = {
    id: `sms-${data.nextSmsNotificationId++}`,
    requestId: request.id,
    requestNumber: request.requestId,
    applicantId: request.applicantId || null,
    applicantName: request.applicantName,
    recipientPhone: normalizeSmsRecipient(request.phone) || String(request.phone || '').trim(),
    message: buildApprovalSms({ request, settings }),
    event: 'request_approved',
    status: activeAdapter.configured === false ? 'pending_configuration' : 'queued',
    provider: activeAdapter.name,
    providerMessageId: null,
    attemptCount: 0,
    maxAttempts: 3,
    nextAttemptAt: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt,
    sentAt: null,
    deliveredAt: null,
    attempts: [],
  };
  data.smsNotifications.push(notification);
  return notification;
}

function retryDelayMs(attemptCount) {
  return Math.min(60 * 60 * 1000, 60 * 1000 * (2 ** Math.max(0, attemptCount - 1)));
}

async function sendWithTimeout(payload, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      activeAdapter.send(payload),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SmsProviderError('SMS provider timed out.', { code: 'provider_timeout', retryable: true })), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function sendSmsMessage({ to, body, clientReference, metadata = {}, timeoutMs = 10000 }) {
  const recipient = normalizeSmsRecipient(to);
  if (!recipient) {
    throw new SmsProviderError('Phone number is not a supported SMS destination.', {
      code: 'invalid_recipient',
      retryable: false,
    });
  }
  if (activeAdapter.configured === false) {
    throw new SmsProviderError('SMS recovery is temporarily unavailable because no provider is configured.', {
      code: 'provider_not_configured',
      retryable: false,
    });
  }
  const result = await sendWithTimeout({
    to: recipient,
    body: String(body),
    clientReference: String(clientReference),
    metadata,
  }, timeoutMs);
  return {
    provider: activeAdapter.name,
    providerMessageId: String(result?.providerMessageId || '') || null,
    status: providerResultStatuses.has(result?.status) ? result.status : 'sent',
  };
}

export async function attemptSmsDelivery(notification, { force = false, now = new Date(), timeoutMs = 10000 } = {}) {
  if (terminalStatuses.has(notification.status)) return { attempted: false, reason: 'terminal_status' };
  if (activeAdapter.configured === false) {
    notification.status = 'pending_configuration';
    notification.provider = activeAdapter.name;
    notification.nextAttemptAt = null;
    notification.lastError = 'No SMS provider adapter is configured.';
    notification.updatedAt = now.toISOString();
    return { attempted: false, reason: 'provider_not_configured' };
  }
  if (!force && notification.nextAttemptAt && new Date(notification.nextAttemptAt) > now) {
    return { attempted: false, reason: 'not_due' };
  }
  if (notification.attemptCount >= notification.maxAttempts) {
    notification.status = 'failed';
    notification.nextAttemptAt = null;
    notification.updatedAt = now.toISOString();
    return { attempted: false, reason: 'attempt_limit' };
  }
  const recipient = normalizeSmsRecipient(notification.recipientPhone);
  if (!recipient) {
    notification.status = 'failed';
    notification.lastError = 'Applicant phone number is not a supported SMS destination.';
    notification.nextAttemptAt = null;
    notification.updatedAt = now.toISOString();
    return { attempted: false, reason: 'invalid_recipient' };
  }
  notification.status = 'sending';
  notification.provider = activeAdapter.name;
  notification.attemptCount += 1;
  notification.updatedAt = now.toISOString();
  try {
    const result = await sendWithTimeout({
      to: recipient,
      body: notification.message,
      clientReference: notification.id,
      metadata: { requestId: notification.requestId, requestNumber: notification.requestNumber, event: notification.event },
    }, timeoutMs);
    const status = providerResultStatuses.has(result?.status) ? result.status : 'sent';
    const completedAt = new Date().toISOString();
    notification.status = status;
    notification.providerMessageId = String(result?.providerMessageId || '') || null;
    notification.sentAt = status === 'sent' || status === 'delivered' ? completedAt : notification.sentAt;
    notification.deliveredAt = status === 'delivered' ? completedAt : null;
    notification.nextAttemptAt = null;
    notification.lastError = null;
    notification.updatedAt = completedAt;
    notification.attempts.push({ attempt: notification.attemptCount, status, attemptedAt: completedAt, provider: notification.provider, providerMessageId: notification.providerMessageId });
    return { attempted: true, status };
  } catch (error) {
    const failedAt = new Date().toISOString();
    const retryable = error?.retryable !== false;
    const exhausted = notification.attemptCount >= notification.maxAttempts;
    notification.status = retryable && !exhausted ? 'retry_scheduled' : 'failed';
    notification.lastError = String(error?.message || 'SMS delivery failed.').slice(0, 300);
    notification.nextAttemptAt = notification.status === 'retry_scheduled'
      ? new Date(new Date(failedAt).getTime() + retryDelayMs(notification.attemptCount)).toISOString()
      : null;
    notification.updatedAt = failedAt;
    notification.attempts.push({
      attempt: notification.attemptCount,
      status: notification.status,
      attemptedAt: failedAt,
      provider: notification.provider,
      errorCode: String(error?.code || 'provider_error'),
      error: notification.lastError,
      retryable,
      nextAttemptAt: notification.nextAttemptAt,
    });
    return { attempted: true, status: notification.status, error: notification.lastError };
  }
}

export function applySmsDeliveryReceipt(notification, { providerMessageId, status, error = '', now = new Date() }) {
  if (!['delivered', 'failed'].includes(status)) throw new TypeError('Delivery receipt status must be delivered or failed.');
  if (!providerMessageId || notification.providerMessageId !== providerMessageId) return false;
  const timestamp = now.toISOString();
  const providerFailed = status === 'failed';
  const retryableFailure = providerFailed && notification.attemptCount < notification.maxAttempts;
  notification.status = retryableFailure ? 'retry_scheduled' : status;
  notification.updatedAt = timestamp;
  notification.deliveredAt = status === 'delivered' ? timestamp : null;
  notification.lastError = providerFailed ? String(error || 'Provider reported delivery failure.').slice(0, 300) : null;
  notification.nextAttemptAt = retryableFailure
    ? new Date(now.getTime() + retryDelayMs(notification.attemptCount)).toISOString()
    : null;
  notification.attempts.push({ attempt: notification.attemptCount, status: notification.status, providerStatus: status, attemptedAt: timestamp, provider: notification.provider, providerMessageId, deliveryReceipt: true, nextAttemptAt: notification.nextAttemptAt, ...(notification.lastError ? { error: notification.lastError } : {}) });
  return true;
}
