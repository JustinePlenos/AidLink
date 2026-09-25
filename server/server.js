import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import { letterStatusForApplicant, classifyLetterFile, convertWordToPdf, prepareViewingPdf, hashQrToken, issueLetterQr, issuePdfAccess, verifyPdfAccess, qrState } from './services/protectedLetterService.js';
import { assistanceTypes, isValidAssistanceType, normalizeAssistanceType } from '../shared/assistanceTypes.js';
import {
  normalizeIncomeSource,
  normalizePatientCircumstance,
} from '../shared/applicationIntakeOptions.js';
import {
  applySmsDeliveryReceipt,
  attemptSmsDelivery,
  createApprovalSmsNotification,
  getSmsProviderMetadata,
  sendSmsMessage,
} from './services/smsNotificationService.js';
import {
  createAuthenticatorUri,
  createPurposeToken,
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCodes,
  generateSmsOtp,
  generateTotpSecret,
  hashMfaCode,
  safeMfaStatus,
  verifyPurposeToken,
  verifyTotpCode,
} from './services/applicantMfaService.js';
import {
  allowedDocumentTypes as analyzerAllowedDocumentTypes,
  analyzeDocument as runDocumentAnalyzer,
  disposeDocumentBuffer,
  getDocumentAnalyzerMetadata,
} from './services/documentAnalyzer.js';
import {
  buildSystemReport,
  parseReportParameters,
  reportToCsv,
  reportToPdf,
} from './services/reportingService.js';
import { createStorageFoundation } from './storage/index.js';
import {
  canonicalStaffRole,
  hasPermission,
  isSystemAdministrator,
  Permissions,
  staffRoles,
} from './security/permissions.js';
import { evaluatePolicyOnBackend } from './services/policyEvaluationService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const storageFoundation = createStorageFoundation({
  env: process.env,
  baseDirectory: path.resolve(__dirname, '..'),
});
const applicationDataStore = storageFoundation.dataStore;
const postgresSubmissionPolicyGatesEnabled = Boolean(storageFoundation.repositories);
const uploadsPath = process.env.AIDLINK_UPLOADS_PATH
  ? path.resolve(process.env.AIDLINK_UPLOADS_PATH)
  : path.resolve(__dirname, 'uploads');
const lettersPath = process.env.AIDLINK_LETTERS_PATH
  ? path.resolve(process.env.AIDLINK_LETTERS_PATH)
  : path.resolve(__dirname, 'private-letters');
const port = process.env.PORT || 5000;
const tokenSecret = process.env.AIDLINK_TOKEN_SECRET || 'aidlink-capstone-development-secret-change-before-deployment';
const mfaEncryptionSecret = process.env.AIDLINK_MFA_ENCRYPTION_SECRET || tokenSecret;
const mfaAuditSecret = String(process.env.AIDLINK_MFA_AUDIT_SECRET || '');
const smsStatusSecret = String(process.env.AIDLINK_SMS_STATUS_SECRET || '');
const tokenMaxAgeMs = 8 * 60 * 60 * 1000;
const publicBaseUrl = String(process.env.AIDLINK_PUBLIC_BASE_URL || '').replace(/\/$/, '');
const receiptRequirement = 'Recent facility receipt or billing document';
const defaultRequiredDocuments = Object.fromEntries(assistanceTypes.map((type) => [type, ['Valid ID', 'Barangay Certificate of Indigency', receiptRequirement]]));
const defaultSystemSettings = {
  organizationName: 'LINGAP CMO',
  notificationPollingSeconds: 30,
  receiptValidityDays: 365,
  defaultClaimingTime: '09:00',
  defaultClaimingLocation: 'LINGAP CMO Assistance Desk',
  smsHelpChannel: 'LINGAP CMO help desk',
};
const guaranteeLetterStatuses = ['pending', 'scheduled', 'ready_for_claiming', 'claimed', 'cancelled'];
const mfaAuditActions = new Set(['mfa_enrolled', 'mfa_disabled', 'mfa_verification_succeeded', 'mfa_verification_failed', 'mfa_recovery_started', 'mfa_recovery_completed', 'mfa_recovery_codes_regenerated']);

function requestBaseUrl(req) {
  return publicBaseUrl || `${req.protocol}://${req.get('host')}`;
}

// Keep the portal empty until a real applicant submits a request.
const temporaryRequests = [];
const temporaryAuditLogs = [];
let nextTemporaryAuditId = 1;

async function loadData() {
  const data = await applicationDataStore.read();
  let requiresSave = false;
  data.authUsers ??= [];
  data.nextAuthUserId ??= data.authUsers.length + 1;
  const hasExistingSystemAdministrator = data.authUsers.some((user) => isSystemAdministrator(user.role));
  if (data.authUsers.length && !hasExistingSystemAdministrator) {
    const bootstrapAdministrator = data.authUsers.find((user) => user.role === 'Administrator' && user.active !== false);
    if (bootstrapAdministrator) {
      bootstrapAdministrator.role = 'System Administrator';
      requiresSave = true;
    }
  }
  for (const user of data.authUsers) {
    const normalizedRole = canonicalStaffRole(user.role);
    if (user.role !== normalizedRole) {
      user.role = normalizedRole;
      requiresSave = true;
    }
    if (typeof user.active !== 'boolean') {
      user.active = true;
      requiresSave = true;
    }
    if (!Number.isInteger(user.sessionVersion) || user.sessionVersion < 1) {
      user.sessionVersion = 1;
      requiresSave = true;
    }
  }
  data.systemSettings = { ...defaultSystemSettings, ...(data.systemSettings || {}) };
  data.assistanceTypeSettings ??= Object.fromEntries(assistanceTypes.map((type) => [type, { active: true }]));
  for (const type of assistanceTypes) data.assistanceTypeSettings[type] ??= { active: true };
  data.requests = data.requests.map((request) => {
    if (request.status === 'completed') {
      request.status = 'approved';
      requiresSave = true;
    }
    delete request.amount;
    if (!Object.hasOwn(request, 'originatingOfficeId')) {
      request.originatingOfficeId = null;
      requiresSave = true;
    }
    if (!Object.hasOwn(request, 'policyVersion')) {
      request.policyVersion = request.decisionSnapshot?.policyVersion || null;
      requiresSave = true;
    }
    if (!Array.isArray(request.policyFindings)) {
      request.policyFindings = [];
      requiresSave = true;
    }
    if (!Array.isArray(request.requiredReviews)) {
      request.requiredReviews = [];
      requiresSave = true;
    }
    if (!request.decisionSnapshot || typeof request.decisionSnapshot !== 'object' || Array.isArray(request.decisionSnapshot)) {
      request.decisionSnapshot = {};
      requiresSave = true;
    }
    return request;
  });
  data.auditLogs ??= [];
  data.nextAuditId ??= data.auditLogs.length + 1;
  data.applicants ??= [];
  data.nextApplicantId ??= data.applicants.length + 1;
  for (const applicant of data.applicants) {
    if (!Number.isInteger(applicant.sessionVersion) || applicant.sessionVersion < 1) {
      applicant.sessionVersion = 1;
      requiresSave = true;
    }
    // Existing accounts predate identity verification and remain usable.
    // New registrations set an explicit unverified state and are not included.
    if (!applicant.verificationStatus) {
      applicant.verificationStatus = 'approved';
      applicant.accountStatus = 'verified';
      applicant.identityVerification = {
        status: 'approved',
        legacyGrandfathered: true,
        document: null,
        decision: null,
        auditNotes: ['Existing account retained during identity-verification rollout.'],
      };
      requiresSave = true;
    }
  }
  data.notifications ??= [];
  data.nextNotificationId ??= data.notifications.length + 1;
  data.smsNotifications ??= [];
  data.nextSmsNotificationId ??= data.smsNotifications.length + 1;
  data.documentUploads ??= [];
  data.mfaChallenges ??= [];
  data.nextMfaChallengeId ??= data.mfaChallenges.length + 1;
  data.usedStepUpTokens ??= [];
  const retainedAfter = Date.now() - (24 * 60 * 60 * 1000);
  data.mfaChallenges = data.mfaChallenges.filter((item) => new Date(item.expiresAt).getTime() >= retainedAfter);
  data.usedStepUpTokens = data.usedStepUpTokens.filter((item) => item.expiresAt > Date.now());
  data.facilities ??= [];
  data.facilities = data.facilities.map((facility) => {
    const configuredTypes = Array.isArray(facility.supportedAssistanceTypes)
      ? facility.supportedAssistanceTypes
          .filter(isValidAssistanceType)
          .map(normalizeAssistanceType)
      : [];
    return {
      operatingHours: 'Monday-Friday, 8:00 AM-5:00 PM',
      contactNumber: '',
      latitude: null,
      longitude: null,
      ...facility,
      supportedAssistanceTypes: configuredTypes.length
        ? [...new Set(configuredTypes)]
        : [...assistanceTypes],
      active: facility.active !== false,
    };
  });
  const storedRequiredDocuments = data.requiredDocuments || {};
  if (Object.keys(storedRequiredDocuments).some((type) => !isValidAssistanceType(type))) {
    requiresSave = true;
  }
  data.requiredDocuments = Object.fromEntries(assistanceTypes.map((type) => {
    const configured = Array.isArray(storedRequiredDocuments[type])
      ? storedRequiredDocuments[type].map((item) => String(item).trim()).filter(Boolean)
      : [...defaultRequiredDocuments[type]];
    if (!configured.some(isReceiptRequirement)) {
      configured.push(receiptRequirement);
      requiresSave = true;
    }
    return [type, [...new Set(configured)]];
  }));
  const legacyUrl = /https?:\/\/[^/]+(\/uploads\/.*)$/;
  for (const request of data.requests) {
    request.documents ??= [];
    request.documents = request.documents.map((document) => {
      if (!document.id) requiresSave = true;
      return {
        ...document,
        id: document.id || `document-${crypto.randomUUID()}`,
        documentType: String(document.documentType || document.name || 'supporting_document').trim(),
        name: String(document.name || document.documentType || 'Document').trim(),
        label: documentLabel(document.documentType || document.name),
        url: String(document.url || '').replace(legacyUrl, (_, suffix) => `${publicBaseUrl || 'http://localhost:5000'}${suffix}`),
      };
    });
    if (!Array.isArray(request.documentHistory)) {
      request.documentHistory = [];
      requiresSave = true;
    }
    if (!Array.isArray(request.correctionHistory)) {
      request.correctionHistory = [];
      requiresSave = true;
    }
    // Historical QR values remain readable. Protected-letter QR credentials
    // are issued only when the current letter is approved, never on reads.
  }
  if (requiresSave) await applicationDataStore.write(data);
  return data;
}

function normalizedDocumentRequirement(value) {
  return String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function isReceiptRequirement(value) {
  return /\b(receipt|bill|billing|statement of account|invoice|quotation|contract)\b/i.test(String(value || ''));
}

function documentSatisfiesRequirement(document, requirement) {
  const expected = normalizedDocumentRequirement(requirement);
  const candidates = [document?.documentType, document?.label, document?.name].map(normalizedDocumentRequirement);
  return candidates.includes(expected) && normalizedDocumentRequirement(document?.analysis?.documentType) === expected;
}

function validateRequiredDocumentChecklist(documents, requirements) {
  const documentIds = documents.map((document) => String(document?.id || '').trim());
  if (documentIds.some((id) => !id) || new Set(documentIds).size !== documentIds.length) {
    return { error: 'Each configured requirement must use a distinct analyzed document.' };
  }
  const missing = requirements.filter((requirement) => !documents.some((document) => documentSatisfiesRequirement(document, requirement)));
  return missing.length ? { error: `Upload every configured requirement before submitting: ${missing.join(', ')}.` } : { value: true };
}

function validateFacilityEvidence(input, documents, receiptValidityDays, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Facility receipt details are required for this assistance request.' };
  }
  const facilityName = String(input.facilityName || '').trim();
  const facilityType = String(input.facilityType || '').trim().toLowerCase();
  const receiptDate = String(input.receiptDate || '').trim();
  const referenceNumber = String(input.referenceNumber || '').trim();
  const receiptDocumentId = String(input.receiptDocumentId || '').trim();
  if (!facilityName || !['hospital', 'pharmacy', 'other'].includes(facilityType) || !/^\d{4}-\d{2}-\d{2}$/.test(receiptDate) || !referenceNumber || !receiptDocumentId) {
    return { error: 'Facility name, facility type, receipt date, reference number, and receipt document are required.' };
  }
  const parsedDate = new Date(`${receiptDate}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== receiptDate) {
    return { error: 'Receipt date must be a valid calendar date.' };
  }
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const ageDays = Math.floor((today.getTime() - parsedDate.getTime()) / 86400000);
  if (ageDays < 0) return { error: 'Receipt date cannot be in the future.' };
  if (ageDays > receiptValidityDays) return { error: `This receipt is ${ageDays} days old. Upload a receipt dated within the last ${receiptValidityDays} days.` };
  const receiptDocument = documents.find((document) => document.id === receiptDocumentId);
  if (!receiptDocument || !isReceiptRequirement(receiptDocument.documentType || receiptDocument.label || receiptDocument.name) || !hasAcceptedDocumentAnalysis(receiptDocument)) {
    return { error: 'Select an accepted receipt or billing document from this request.' };
  }
  return {
    value: {
      facilityName,
      facilityType,
      receiptDate,
      referenceNumber,
      receiptDocumentId,
      validation: {
        status: 'accepted_for_review',
        qualityAccepted: true,
        requestContextMatched: true,
        ageDays,
        maxAgeDays: receiptValidityDays,
        validatedAt: new Date().toISOString(),
        authenticityVerified: false,
      },
    },
  };
}

function documentLabel(documentType) {
  return String(documentType || 'supporting_document').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function addNotification(data, { audience, applicantId, request, title, message }) {
  data.notifications.push({ id: `notification-${data.nextNotificationId++}`, audience, applicantId: applicantId || null, requestId: request.id, requestNumber: request.requestId, title, message, read: false, createdAt: new Date().toISOString() });
}

function isApproved(request) {
  return request.status === 'approved' || request.status === 'ready_for_claiming' || request.status === 'completed';
}

function validateGuaranteeLetterTracking(input, { requireComplete = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const claimReference = String(input.claimReference || '').trim();
  const scheduledFor = String(input.scheduledFor || '').trim();
  const status = String(input.status || 'pending').trim();
  const claimingTime = String(input.claimingTime || '').trim();
  const claimingLocation = String(input.claimingLocation || '').trim();
  if (claimReference.length > 120) {
    return { error: 'Claim reference must not exceed 120 characters.' };
  }
  if (scheduledFor && !/^\d{4}-\d{2}-\d{2}$/.test(scheduledFor)) {
    return { error: 'Guarantee-letter schedule must be a valid date.' };
  }
  const scheduledDate = scheduledFor ? new Date(`${scheduledFor}T00:00:00.000Z`) : null;
  if (scheduledDate && (Number.isNaN(scheduledDate.getTime()) || scheduledDate.toISOString().slice(0, 10) !== scheduledFor)) {
    return { error: 'Guarantee-letter schedule must be a valid date.' };
  }
  if (!guaranteeLetterStatuses.includes(status)) {
    return { error: 'Guarantee-letter status is invalid.' };
  }
  if (claimingTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(claimingTime)) {
    return { error: 'Claiming time must use the 24-hour HH:MM format.' };
  }
  if (claimingLocation.length > 200) {
    return { error: 'Claiming location must not exceed 200 characters.' };
  }
  if (requireComplete) {
    const missing = [!claimReference && 'claim reference', !scheduledFor && 'claiming date', !claimingTime && 'claiming time', !claimingLocation && 'claiming location'].filter(Boolean);
    if (missing.length) return { error: `Complete the claiming preparation before release. Missing: ${missing.join(', ')}.` };
  }
  return { value: { claimReference, scheduledFor, status, claimingTime, claimingLocation } };
}

function isQrVerificationToken(value) {
  // 32 random bytes encoded as base64url are 43 characters. This also
  // replaces the old predictable request-ID QR payloads safely.
  return /^[A-Za-z0-9_-]{43}$/.test(String(value || ''));
}

const beneficiaryTypes = new Set(['self', 'other']);

function applicationParties(body, account) {
  const supplied = body?.beneficiary && typeof body.beneficiary === 'object'
    ? body.beneficiary
    : {};
  const explicitType = String(body?.beneficiaryType || supplied.type || '').trim().toLowerCase();
  const legacyName = String(body?.fullName || '').trim();
  const inferredType = legacyName && legacyName.toLowerCase() !== String(account.fullName || '').trim().toLowerCase()
    ? 'other'
    : 'self';
  const beneficiaryType = explicitType || inferredType;
  if (!beneficiaryTypes.has(beneficiaryType)) {
    return { error: 'Choose whether the assistance is for yourself or for someone else.' };
  }

  const modernPayload = Boolean(body?.beneficiaryType || body?.beneficiary);
  const beneficiary = {
    fullName: String(supplied.fullName || body?.fullName || (beneficiaryType === 'self' ? account.fullName : '') || '').trim(),
    address: String(supplied.address || body?.address || (beneficiaryType === 'self' ? account.address : '') || '').trim(),
    dateOfBirth: String(supplied.dateOfBirth || body?.dateOfBirth || (beneficiaryType === 'self' ? account.dateOfBirth : '') || '').trim(),
    relationshipToApplicant: beneficiaryType === 'self'
      ? 'Self'
      : String(supplied.relationshipToApplicant || body?.relationshipToPatient || '').trim(),
    sex: String(supplied.sex || body?.sex || '').trim(),
  };
  const missing = [
    !beneficiary.fullName && 'beneficiary name',
    !beneficiary.dateOfBirth && 'beneficiary birthdate',
    !beneficiary.address && 'beneficiary address',
    modernPayload && beneficiaryType === 'other' && !beneficiary.relationshipToApplicant && 'requester relationship to beneficiary',
    modernPayload && !beneficiary.sex && 'beneficiary sex',
  ].filter(Boolean);
  if (missing.length) return { error: `Complete the beneficiary information. Missing: ${missing.join(', ')}.` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(beneficiary.dateOfBirth)) {
    return { error: 'Beneficiary birthdate must use the YYYY-MM-DD format.' };
  }
  const birthdate = new Date(`${beneficiary.dateOfBirth}T00:00:00.000Z`);
  if (Number.isNaN(birthdate.getTime()) || birthdate.toISOString().slice(0, 10) !== beneficiary.dateOfBirth || birthdate > new Date()) {
    return { error: 'Enter a valid beneficiary birthdate that is not in the future.' };
  }
  if (modernPayload && !['Male', 'Female'].includes(beneficiary.sex)) {
    return { error: 'Choose a supported beneficiary sex.' };
  }

  return {
    beneficiaryType,
    beneficiary,
    requester: {
      applicantId: account.id,
      fullName: String(account.fullName || '').trim(),
      email: String(account.email || '').trim().toLowerCase(),
      phone: String(account.phone || '').trim(),
    },
  };
}

function publicRequest(request) {
  const { qrCode, protectedLetter, letterHistory, ...requestWithoutQrCode } = request;
  const released = request.status === 'ready_for_claiming';
  const beneficiary = request.beneficiary || {
    fullName: request.applicantName || '',
    address: request.address || '',
    dateOfBirth: request.dateOfBirth || '',
    relationshipToApplicant: request.relationshipToPatient || '',
    sex: request.sex || '',
  };
  const requester = request.requester || {
    applicantId: request.applicantId || null,
    fullName: request.applicantName || '',
    email: request.email || '',
    phone: request.phone || '',
  };
  return {
    ...requestWithoutQrCode,
    originatingOfficeId: request.originatingOfficeId || null,
    policyVersion: request.policyVersion || request.decisionSnapshot?.policyVersion || null,
    policyFindings: Array.isArray(request.policyFindings) ? request.policyFindings : [],
    requiredReviews: Array.isArray(request.requiredReviews) ? request.requiredReviews : [],
    decisionSnapshot: request.decisionSnapshot && typeof request.decisionSnapshot === 'object' ? request.decisionSnapshot : {},
    beneficiaryType: request.beneficiaryType || null,
    beneficiary,
    requester,
    status: request.status === 'completed' ? 'approved' : request.status,
    protectedLetter: protectedLetter ? publicProtectedLetter(protectedLetter) : null,
    documents: (request.documents || []).map((document) => ({ ...document, label: document.label || documentLabel(document.documentType || document.name) })),
    ...((released || (request.status === 'approved' && !protectedLetter && request.guaranteeLetter)) ? { qrCode: letterStatusForApplicant(protectedLetter) === 'approved' || (!protectedLetter && request.guaranteeLetter) ? qrCode || null : null } : { qrCode: null }),
  };
}

function deduplicateRequestsByStableId(requests) {
  const unique = new Map();
  for (const request of requests) {
    const key = String(request.requestId || request.id || '').trim();
    if (!key) continue;
    const existing = unique.get(key);
    const requestTime = Date.parse(request.lastUpdatedAt || request.processedAt || request.dateSubmitted || '') || 0;
    const existingTime = existing
      ? Date.parse(existing.lastUpdatedAt || existing.processedAt || existing.dateSubmitted || '') || 0
      : -1;
    if (!existing || requestTime > existingTime) unique.set(key, request);
  }
  return [...unique.values()];
}

function publicProtectedLetter(letter) {
  return {
    id: letter.id, version: letter.version, status: letter.status === 'approved' ? letterStatusForApplicant(letter) : letter.status,
    sourceType: letter.sourceType, conversionStatus: letter.conversionStatus,
    uploaderId: letter.uploaderId, uploaderName: letter.uploaderName,
    uploadedAt: letter.uploadedAt, reviewedAt: letter.reviewedAt || null,
    approvedAt: letter.approvedAt || null, qrExpiresAt: letter.qrExpiresAt || null,
    name: letter.name,
  };
}

function letterAudit(data, request, actor, action, details = {}) {
  return addActivity(data, { action, actor, affectedRecord: { type: 'guarantee_letter', id: request.protectedLetter?.id || request.id, label: `${request.requestId} AidLink protected letter` }, details: { requestId: request.id, requestNumber: request.requestId, version: request.protectedLetter?.version, ...details }, legacy: { requestId: request.id, requestNumber: request.requestId } });
}

function letterFilePath(fileName) { return path.join(lettersPath, fileName); }

async function approveProtectedLetter(data, request, actor, req, release = null) {
  const letter = request.protectedLetter;
  if (!letter || letter.status !== 'confirmed' || letter.conversionStatus !== 'ready' || !letter.pdfFileName) throw new Error('Upload, preview, and confirm a valid guarantee letter before releasing claiming access.');
  const qr = release?.qr || issueLetterQr(tokenSecret, request.id, letter.version, release?.validityDays || 7);
  if (release?.expiresAt) qr.expiresAt = new Date(release.expiresAt).toISOString();
  const viewUrl = `${requestBaseUrl(req)}/api/letters/qr/${qr.token}`;
  request.qrCode = { value: viewUrl, imageDataUrl: await QRCode.toDataURL(viewUrl, { width: 360, margin: 2, errorCorrectionLevel: 'M' }) };
  letter.status = 'approved';
  letter.approvedAt = new Date().toISOString();
  letter.approvedById = actor.id;
  letter.approvedByName = actor.fullName;
  letter.qrTokenHash = qr.tokenHash;
  letter.qrExpiresAt = qr.expiresAt;
  letter.validityDays = release?.validityDays || 7;
  if (release?.reservation) request.budgetAllocation = { reservationId: release.reservation.id, budgetPoolId: release.reservation.budget_id, amount: Number(release.reservation.amount), status: release.reservation.status, expiresAt: qr.expiresAt };
  letterAudit(data, request, actor, 'guarantee_letter_approved', { conversionStatus: letter.conversionStatus });
  letterAudit(data, request, actor, 'guarantee_letter_qr_generated', { expiresAt: qr.expiresAt });
}

async function expireProtectedLetterIfDue(data, request, now = new Date()) {
  const letter = request?.protectedLetter;
  if (!letter || letter.status !== 'approved' || !letter.qrExpiresAt || new Date(letter.qrExpiresAt) > new Date(now)) return false;
  if (storageFoundation.repositories) {
    try { await storageFoundation.repositories.aidLink.expireGuaranteeLetter({ letterId: letter.id, now, actorId: 'system', actorType: 'system', justification: 'Guarantee Letter validity window expired; unused allocation returned.' }); }
    catch (error) { if (!['LETTER_NOT_FOUND'].includes(error?.code)) throw error; }
  }
  letter.status = 'expired';
  letter.expiredAt = new Date(now).toISOString();
  letter.qrTokenHash = null;
  request.qrCode = null;
  request.status = 'approved';
  request.lastUpdatedAt = new Date(now).toISOString();
  if (request.guaranteeLetterTracking) request.guaranteeLetterTracking.status = 'scheduled';
  if (request.budgetAllocation?.status === 'reserved') request.budgetAllocation.status = 'expired';
  letterAudit(data, request, null, 'guarantee_letter_expired', { expiresAt: letter.qrExpiresAt, allocationReturned: true });
  return true;
}

async function processGuaranteeLetterExpiries(now = new Date()) {
  const data = await loadData();
  let changed = false;
  for (const request of data.requests) changed = await expireProtectedLetterIfDue(data, request, now) || changed;
  if (changed) await saveData(data);
  else if (storageFoundation.repositories) await storageFoundation.repositories.aidLink.expireDueGuaranteeLetters({ now, actorId: 'system', actorType: 'system' });
  return changed;
}

async function saveData(data) {
  await applicationDataStore.write(data);
}

async function runPostgresSubmissionPolicyGates({ application, account, requiredDocuments }) {
  if (!postgresSubmissionPolicyGatesEnabled) return null;
  const result = await storageFoundation.repositories.aidLink.submitRequestWithPolicyGates({
    id: null,
    requestNumber: null,
    applicantId: account.id,
    authenticatedApplicantId: account.id,
    idempotencyKey: application.clientSubmissionId || `server-${crypto.randomUUID()}`,
    beneficiaryType: application.beneficiaryType,
    beneficiary: application.beneficiary,
    assistanceType: application.assistanceType,
    incomeSource: application.incomeSource,
    patientCircumstance: application.patientCircumstance,
    additionalDetails: application.additionalDetails,
    latitude: application.latitude,
    longitude: application.longitude,
    originatingOfficeId: account.originatingOfficeId || application.originatingOfficeId || null,
    requiredDocuments,
    facilityEvidence: application.facilityEvidence,
    documents: application.documents.map((document) => ({
      ...document,
      displayName: document.label || document.name,
      storageKey: document.storageKey || document.url,
      metadata: { documentDate: document.documentDate || null },
    })),
    submittedAt: application.dateSubmitted,
  });
  if (result.created) {
    application.id = result.request.id;
    application.requestId = result.request.request_number;
    application.clientSubmissionId = result.request.client_submission_id;
    application.originatingOfficeId = result.request.originating_office_id;
    application.policyVersion = result.request.policy_version;
    application.policyFindings = result.gateResult.findings;
    application.requiredReviews = result.gateResult.requiredReviews;
    application.decisionSnapshot = result.request.decision_snapshot;
    application.policyGateOutcome = result.gateResult.outcome;
    application.policyGateEvaluationId = result.evaluationId;
    application.cooldownUntil = result.request.cooldown_until;
    const facilityRouting = await storageFoundation.repositories.facilities.resolveRequestFacility({
      requestId: result.request.id,
      actorId: account.id,
      actorType: 'applicant',
      justification: 'Resolve validated facility evidence after the submission policy gates.',
    });
    application.facilityResolution = {
      id: facilityRouting.resolutionId,
      outcome: facilityRouting.resolution.outcome,
      reasonCode: facilityRouting.resolution.reasonCode,
      directoryVersion: facilityRouting.directoryVersion,
      facility: facilityRouting.facility ? {
        id: facilityRouting.facility.id,
        name: facilityRouting.facility.name,
        tier: facilityRouting.facility.tier,
        category: facilityRouting.facility.classification_category,
      } : null,
    };
    application.facilityTier = facilityRouting.facility?.tier || null;
    application.partnerPricingStatus = facilityRouting.pricing.status;
    application.requiredReviews = facilityRouting.requiredReviews;
    application.policyFindings = [...application.policyFindings, ...(facilityRouting.resolution.findings || [])];
  }
  return result;
}

function policyGateFailureResponse(res, result) {
  const status = result.gateResult.outcome === 'correction_required' ? 422 : 409;
  return res.status(status).json({
    message: result.gateResult.findings[0]?.message || 'The submission cannot continue until the policy-gate findings are resolved.',
    outcome: result.gateResult.outcome,
    evaluationId: result.evaluationId,
    reasonCodes: result.gateResult.reasonCodes,
    findings: result.gateResult.findings,
    requiredReviews: result.gateResult.requiredReviews,
    existingRequestReference: result.gateResult.existingRequestReference,
    cooldownEndDate: result.gateResult.cooldownEndDate,
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

async function passwordsMatch(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, key] = storedHash.split(':');
  const candidate = await hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(storedHash));
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createToken(user) {
  const payload = encode({
    sub: user.id,
    role: user.role,
    ver: user.sessionVersion || 1,
    exp: Date.now() + tokenMaxAgeMs,
  });
  const signature = crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(token) {
  const [payload, signature] = token?.split('.') ?? [];
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  return decoded.exp > Date.now() ? decoded : null;
}

function publicUser(user) {
  const { password, passwordHash, mfa, ...safeUser } = user;
  return { ...safeUser, mfa: safeMfaStatus(user) };
}

function addActivity(data, { action, actor = null, affectedRecord = null, details = {}, legacy = {} }) {
  const timestamp = new Date().toISOString();
  const actorRecord = {
    id: actor?.id || null,
    name: actor?.fullName || actor?.name || actor?.email || 'System',
    email: actor?.email || null,
    role: actor?.role || 'System',
  };
  const record = affectedRecord || { type: 'system', id: 'aidlink', label: 'AidLink system' };
  const entry = {
    id: `audit-${data.nextAuditId++}`,
    action,
    actor: actorRecord,
    affectedRecord: record,
    timestamp,
    details,
    performedBy: actorRecord.name,
    performedById: actorRecord.id,
    performedAt: timestamp,
    ...legacy,
  };
  data.auditLogs.push(entry);
  return entry;
}

function maskedPhone(value) {
  const text = String(value || '');
  return text.length > 4 ? `${'*'.repeat(Math.max(0, text.length - 4))}${text.slice(-4)}` : '****';
}

function syncRequestSmsSummary(request, sms) {
  request.approvalSms = {
    id: sms.id,
    status: sms.status,
    provider: sms.provider,
    attemptCount: sms.attemptCount,
    maxAttempts: sms.maxAttempts,
    nextAttemptAt: sms.nextAttemptAt,
    sentAt: sms.sentAt,
    deliveredAt: sms.deliveredAt,
    lastError: sms.lastError,
    updatedAt: sms.updatedAt,
  };
}

function addSmsActivity(data, sms, actor, action = 'sms_delivery_status_changed') {
  addActivity(data, {
    action,
    actor,
    affectedRecord: { type: 'sms_notification', id: sms.id, label: `${sms.requestNumber} approval SMS` },
    details: {
      requestId: sms.requestId,
      requestNumber: sms.requestNumber,
      recipient: maskedPhone(sms.recipientPhone),
      provider: sms.provider,
      providerMessageId: sms.providerMessageId,
      status: sms.status,
      attemptCount: sms.attemptCount,
      maxAttempts: sms.maxAttempts,
      nextAttemptAt: sms.nextAttemptAt,
      lastError: sms.lastError,
    },
    legacy: { requestId: sms.requestId, requestNumber: sms.requestNumber },
  });
}

async function queueApprovalSms(data, request, actor) {
  const sms = createApprovalSmsNotification(data, request, data.systemSettings);
  addSmsActivity(data, sms, actor, 'sms_notification_queued');
  await attemptSmsDelivery(sms);
  syncRequestSmsSummary(request, sms);
  addSmsActivity(data, sms, actor);
  return sms;
}

async function processAutomaticSmsRetries() {
  if (!getSmsProviderMetadata().configured) return;
  const data = await loadData();
  const now = new Date();
  const due = data.smsNotifications.filter((sms) =>
    ['queued', 'retry_scheduled', 'pending_configuration'].includes(sms.status)
    && (!sms.nextAttemptAt || new Date(sms.nextAttemptAt) <= now));
  if (!due.length) return;
  const actor = { id: null, fullName: 'SMS retry worker', role: 'System' };
  for (const sms of due) {
    await attemptSmsDelivery(sms, { now });
    const request = data.requests.find((item) => item.id === sms.requestId);
    if (request) syncRequestSmsSummary(request, sms);
    addSmsActivity(data, sms, actor, 'sms_delivery_retried');
  }
  await saveData(data);
}

function authenticationDetails(req, outcome, reason = null) {
  return {
    outcome,
    ...(reason ? { reason } : {}),
    ipAddress: req.ip || req.socket?.remoteAddress || null,
    userAgent: String(req.get('user-agent') || '').slice(0, 300) || null,
  };
}

function addMfaActivity(data, action, applicant, req, details = {}) {
  return addActivity(data, {
    action,
    actor: applicant,
    affectedRecord: { type: 'applicant_account', id: applicant.id, label: applicant.email },
    details: { ...authenticationDetails(req, action.endsWith('failed') ? 'failed' : 'success'), ...details },
  });
}

function createMfaChallenge(data, applicant, purpose) {
  const createdAt = new Date();
  const challenge = {
    id: `mfa-challenge-${data.nextMfaChallengeId++}`,
    applicantId: applicant.id,
    purpose,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + (5 * 60 * 1000)).toISOString(),
    attempts: 0,
    maxAttempts: 5,
    consumedAt: null,
    smsOtp: null,
  };
  data.mfaChallenges.push(challenge);
  const challengeToken = createPurposeToken({
    cid: challenge.id,
    sub: applicant.id,
    purpose: `mfa_${purpose}`,
    exp: new Date(challenge.expiresAt).getTime(),
  }, tokenSecret);
  return { challenge, challengeToken };
}

function resolveMfaChallenge(data, token, purpose) {
  const payload = verifyPurposeToken(token, tokenSecret, `mfa_${purpose}`);
  if (!payload) return null;
  const challenge = data.mfaChallenges.find((item) => item.id === payload.cid && item.applicantId === payload.sub && item.purpose === purpose);
  if (!challenge || challenge.consumedAt || new Date(challenge.expiresAt).getTime() <= Date.now() || challenge.attempts >= challenge.maxAttempts) return null;
  return challenge;
}

function secureCodeEquals(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function verifyApplicantFactor(applicant, challenge, method, code) {
  const mfa = applicant.mfa || {};
  if (!mfa.enabled) return { valid: false };
  if (method === 'totp') {
    const secret = decryptMfaSecret(mfa.totpSecretEncrypted, mfaEncryptionSecret);
    const counter = verifyTotpCode(secret, code, { lastCounter: mfa.lastTotpCounter ?? -1 });
    if (counter === null) return { valid: false };
    mfa.lastTotpCounter = counter;
    return { valid: true, method };
  }
  if (method === 'recovery_code') {
    const hash = hashMfaCode(code, mfaEncryptionSecret, `recovery:${applicant.id}`);
    const index = (mfa.recoveryCodeHashes || []).findIndex((item) => secureCodeEquals(item, hash));
    if (index < 0) return { valid: false };
    mfa.recoveryCodeHashes.splice(index, 1);
    return { valid: true, method };
  }
  if (method === 'sms') {
    const otp = challenge.smsOtp;
    if (!otp || new Date(otp.expiresAt).getTime() <= Date.now()) return { valid: false };
    const hash = hashMfaCode(code, mfaEncryptionSecret, `sms:${challenge.id}`);
    if (!secureCodeEquals(otp.codeHash, hash)) return { valid: false };
    challenge.smsOtp = { ...otp, usedAt: new Date().toISOString() };
    return { valid: true, method };
  }
  return { valid: false };
}

function mfaChallengeResponse(applicant, challengeToken) {
  return {
    mfaRequired: true,
    challengeToken,
    methods: ['totp', ...(applicant.phone && applicant.mfa?.smsRecoveryEnabled !== false ? ['sms'] : []), ...(applicant.mfa?.recoveryCodeHashes?.length ? ['recovery_code'] : [])],
    maskedPhone: maskedPhone(applicant.phone),
    expiresInSeconds: 300,
  };
}

function createStepUpToken(applicant) {
  const exp = Date.now() + (5 * 60 * 1000);
  return createPurposeToken({
    sub: applicant.id,
    ver: applicant.sessionVersion || 1,
    purpose: 'applicant_step_up',
    exp,
    jti: crypto.randomBytes(16).toString('base64url'),
  }, tokenSecret);
}

function validateStepUpToken(data, applicant, token) {
  const payload = verifyPurposeToken(token, tokenSecret, 'applicant_step_up');
  if (!payload || payload.sub !== applicant.id || payload.ver !== (applicant.sessionVersion || 1)) return null;
  const fingerprint = crypto.createHash('sha256').update(String(token)).digest('base64url');
  if (data.usedStepUpTokens.some((item) => item.fingerprint === fingerprint)) return null;
  return { payload, fingerprint };
}

function consumeStepUpToken(data, verified) {
  data.usedStepUpTokens.push({ fingerprint: verified.fingerprint, expiresAt: verified.payload.exp });
}

async function sendMfaSms(data, applicant, challenge, req) {
  if (!applicant.phone || applicant.mfa?.smsRecoveryEnabled === false) {
    const error = new Error('SMS recovery is not available for this account.');
    error.statusCode = 400;
    throw error;
  }
  const previous = challenge.smsOtp;
  if (previous?.sentAt && Date.now() - new Date(previous.sentAt).getTime() < 30_000) {
    const error = new Error('Wait 30 seconds before requesting another SMS code.');
    error.statusCode = 429;
    throw error;
  }
  const code = generateSmsOtp();
  const issuedAt = new Date();
  challenge.smsOtp = {
    codeHash: hashMfaCode(code, mfaEncryptionSecret, `sms:${challenge.id}`),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + (5 * 60 * 1000)).toISOString(),
    sentAt: null,
    provider: null,
    providerMessageId: null,
    deliveryStatus: 'sending',
  };
  try {
    const result = await sendSmsMessage({
      to: applicant.phone,
      body: `AidLink verification code: ${code}. It expires in 5 minutes. Never share this code, your password, or other OTPs.`,
      clientReference: challenge.id,
      metadata: { applicantId: applicant.id, event: 'applicant_mfa_recovery' },
    });
    challenge.smsOtp = {
      ...challenge.smsOtp,
      sentAt: new Date().toISOString(),
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      deliveryStatus: result.status,
    };
    addMfaActivity(data, 'mfa_recovery_started', applicant, req, {
      method: 'sms',
      challengePurpose: challenge.purpose,
      recipient: maskedPhone(applicant.phone),
      deliveryStatus: result.status,
      provider: result.provider,
    });
    return result;
  } catch (cause) {
    challenge.smsOtp = {
      ...challenge.smsOtp,
      deliveryStatus: 'failed',
      deliveryError: String(cause?.message || 'SMS delivery failed.').slice(0, 200),
    };
    addMfaActivity(data, 'mfa_verification_failed', applicant, req, {
      method: 'sms',
      stage: 'delivery',
      reason: String(cause?.code || 'sms_delivery_failed'),
    });
    const error = new Error(cause?.message || 'SMS recovery code could not be sent.');
    error.statusCode = cause?.code === 'provider_not_configured' ? 503 : 502;
    throw error;
  }
}

function addStaffAudit(data, action, actor, target, details = {}) {
  return addActivity(data, {
    action,
    actor,
    affectedRecord: { type: 'staff_account', id: target.id, label: target.email },
    details,
    legacy: { targetStaffId: target.id, targetStaffEmail: target.email, ...details },
  });
}

function inferAffectedRecord(entry) {
  if (entry.affectedRecord) return entry.affectedRecord;
  if (entry.requestId || entry.requestNumber) return { type: 'request', id: entry.requestId || entry.requestNumber, label: entry.requestNumber || entry.requestId };
  if (entry.targetStaffId || entry.targetStaffEmail) return { type: 'staff_account', id: entry.targetStaffId || entry.targetStaffEmail, label: entry.targetStaffEmail || entry.targetStaffId };
  if (entry.facilityId) return { type: 'facility', id: entry.facilityId, label: entry.facilityName || entry.facilityId };
  if (entry.documentId) return { type: 'document', id: entry.documentId, label: entry.documentName || entry.documentId };
  if (entry.assistanceType) return { type: 'assistance_type', id: entry.assistanceType, label: entry.assistanceType };
  return { type: 'system', id: 'aidlink', label: 'AidLink system' };
}

function publicActivityEntry(entry, data) {
  const knownActor = [...data.authUsers, ...data.applicants].find((user) => user.id === entry.performedById);
  const actor = entry.actor || {
    id: entry.performedById || knownActor?.id || null,
    name: entry.performedBy || knownActor?.fullName || knownActor?.name || knownActor?.email || 'System',
    email: knownActor?.email || null,
    role: knownActor?.role || 'System',
  };
  const excluded = new Set(['id', 'action', 'actor', 'affectedRecord', 'timestamp', 'details', 'performedBy', 'performedById', 'performedAt']);
  const inferredDetails = Object.fromEntries(Object.entries(entry).filter(([key]) => !excluded.has(key)));
  return {
    ...entry,
    actor,
    affectedRecord: inferAffectedRecord(entry),
    timestamp: entry.timestamp || entry.performedAt || null,
    details: entry.details || inferredDetails,
    performedBy: actor.name,
    performedAt: entry.timestamp || entry.performedAt || null,
  };
}

async function databaseActivityEntries(data) {
  if (!storageFoundation.database) return [];
  const result = await storageFoundation.database.query(`
    SELECT id, actor_id, actor_type, occurred_at, action_type,
           affected_record_type, affected_record_id, old_value, new_value,
           justification, correlation_id, metadata
    FROM audit_logs ORDER BY occurred_at DESC
  `);
  return result.rows.map((entry) => {
    const knownActor = [...data.authUsers, ...data.applicants].find((user) => user.id === entry.actor_id);
    const actor = {
      id: entry.actor_id,
      name: knownActor?.fullName || knownActor?.name || knownActor?.email || (entry.actor_type === 'system' ? 'AidLink system' : entry.actor_id),
      email: knownActor?.email || null,
      role: knownActor?.role || (entry.actor_type === 'system' ? 'System' : entry.actor_type),
    };
    return {
      id: entry.id,
      action: entry.action_type,
      actionType: entry.action_type,
      actorId: entry.actor_id,
      actor,
      affectedRecord: { type: entry.affected_record_type, id: entry.affected_record_id, label: entry.affected_record_id },
      recordId: entry.affected_record_id,
      timestamp: entry.occurred_at,
      performedBy: actor.name,
      performedAt: entry.occurred_at,
      oldValue: entry.old_value,
      newValue: entry.new_value,
      justification: entry.justification,
      details: {
        oldValue: entry.old_value,
        newValue: entry.new_value,
        justification: entry.justification,
        correlationId: entry.correlation_id,
        ...(entry.metadata || {}),
      },
    };
  });
}

const administrablePolicyKeys = new Set([
  'workflow_thresholds', 'coverage_matrix', 'submission_gates',
  'prescription_routing', 'hard_disqualifiers',
]);

function validateAdministrablePolicy(policyKey, configuration) {
  if (!administrablePolicyKeys.has(policyKey)) return 'This policy key is not available in the administrator publication console.';
  if (policyKey === 'workflow_thresholds') {
    const receiptDays = Number(configuration.receiptValidityDays);
    const staleDays = Number(configuration.staleApplicationDays);
    const confidence = Number(configuration.documentReviewConfidenceThreshold);
    if (!Number.isInteger(receiptDays) || receiptDays < 1 || receiptDays > 730) return 'Receipt validity must be from 1 through 730 days.';
    if (!Number.isInteger(staleDays) || staleDays < 1 || staleDays > 365) return 'The stale-application threshold must be from 1 through 365 days.';
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return 'The document review confidence threshold must be between 0 and 1.';
  }
  if (policyKey === 'submission_gates') {
    const cooldownDays = Number(configuration.cooldownDays);
    if (!Number.isInteger(cooldownDays) || cooldownDays < 1 || cooldownDays > 365) return 'The same-assistance cooldown must be from 1 through 365 days.';
    if (!Array.isArray(configuration.calendarYearDocumentTypes) || configuration.calendarYearDocumentTypes.some((item) => !String(item || '').trim())) return 'Provide the document types governed by the calendar-year rule.';
  }
  if (policyKey === 'prescription_routing') {
    if (configuration.privatePrescriptionRequiresCho !== true || configuration.partnerPricingRequiresChoApproval !== true) return 'Private prescriptions must require City Health Office validation before partner pricing is unlocked.';
  }
  return null;
}

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const session = verifyToken(token);
  if (!session) return res.status(401).json({ message: 'Your session has expired. Please sign in again.' });
  if (session.role === 'Applicant') {
    try {
      const applicant = (await loadData()).applicants.find((user) => user.id === session.sub);
      if (!applicant || applicant.active === false) {
        return res.status(403).json({ message: 'This applicant account is unavailable.' });
      }
      if ((session.ver ?? 1) !== (applicant.sessionVersion || 1)) {
        return res.status(401).json({ message: 'Your account security changed. Please sign in again.' });
      }
      req.auth = session;
      req.authUser = applicant;
      return next();
    } catch {
      return res.status(500).json({ message: 'Unable to validate your applicant session.' });
    }
  }
  try {
    const account = (await loadData()).authUsers.find((user) => user.id === session.sub);
    if (!account || account.active === false) {
      return res.status(403).json({ message: 'This staff account is deactivated. Contact a System Administrator.' });
    }
    if ((session.ver ?? 1) !== (account.sessionVersion || 1)) {
      return res.status(401).json({ message: 'Your password was reset. Please sign in again.' });
    }
    req.auth = {
      ...session,
      role: account.role,
      officeIds: [...new Set([
        ...(Array.isArray(account.officeIds) ? account.officeIds : []),
        ...(Array.isArray(account.assignedOfficeIds) ? account.assignedOfficeIds : []),
        account.originatingOfficeId,
      ].filter(Boolean))],
    };
    req.authUser = account;
    return next();
  } catch {
    return res.status(500).json({ message: 'Unable to validate your staff session.' });
  }
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.auth.role, permission)) {
      return res.status(403).json({ message: 'You do not have permission for this action.' });
    }
    return next();
  };
}

async function requireVerifiedApplicant(req, res, next) {
  if (req.auth.role !== 'Applicant') return res.status(403).json({ message: 'Applicant access is required.' });
  try {
    const applicant = (await loadData()).applicants.find((item) => item.id === req.auth.sub);
    if (!applicant) return res.status(404).json({ message: 'Applicant account not found.' });
    if (applicant.verificationStatus !== 'approved') {
      return res.status(403).json({
        message: 'Complete government-issued ID verification before using assistance-request features.',
        verificationRequired: true,
        verificationStatus: applicant.verificationStatus || 'unverified',
      });
    }
    req.authUser = applicant;
    return next();
  } catch {
    return res.status(500).json({ message: 'Unable to verify applicant access.' });
  }
}

function requestIsPermittedForStaff(request, auth) {
  if (hasPermission(auth.role, 'system:manage')) return true;
  if (!hasPermission(auth.role, 'requests:view')) return false;
  const originatingOfficeId = request.originatingOfficeId || request.originating_office_id || null;
  const officeIds = Array.isArray(auth.officeIds) ? auth.officeIds : [];
  if (originatingOfficeId && officeIds.length && !officeIds.includes(originatingOfficeId)) return false;
  const assignedId = request.assignedCaseWorkerId || request.assignedToId || '';
  const permittedIds = Array.isArray(request.permittedCaseWorkerIds) ? request.permittedCaseWorkerIds : [];
  return (!assignedId && permittedIds.length === 0)
    || assignedId === auth.sub
    || permittedIds.includes(auth.sub);
}

const allowedDocumentTypes = analyzerAllowedDocumentTypes;
async function analyzeDocumentContents(file, requestedType) {
  return runDocumentAnalyzer(file, requestedType);
}

function analysisReceipt(url, analysis) {
  return crypto.createHmac('sha256', tokenSecret).update(JSON.stringify({
    url,
    sha256: analysis.sha256,
    accepted: analysis.accepted,
    documentType: analysis.documentType,
    fileName: analysis.fileName,
    issues: analysis.issues,
    warnings: analysis.warnings,
    checks: analysis.checks,
    imageQuality: analysis.imageQuality,
    orientation: analysis.orientation,
    analyzerVersion: analysis.analyzerVersion,
    analyzedAt: analysis.analyzedAt,
    authenticityVerified: analysis.authenticityVerified,
    decision: analysis.decision,
    confidence: analysis.confidence,
    classification: analysis.classification,
    missingPages: analysis.missingPages,
    likelyUnreadableText: analysis.likelyUnreadableText,
    explanations: analysis.explanations,
    requiresHumanReview: analysis.requiresHumanReview,
    humanReviewReasons: analysis.humanReviewReasons,
    analyzer: analysis.analyzer,
    eligibilityDetermined: analysis.eligibilityDetermined,
    retention: analysis.retention,
  })).digest('base64url');
}

function hasAcceptedDocumentAnalysis(document) {
  const analysis = document?.analysis;
  if (!document?.url || !analysis?.accepted || !analysis.analyzerVersion || !analysis.receipt) return false;
  const expected = analysisReceipt(String(document.url), analysis);
  const actual = String(analysis.receipt);
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function documentAnalyzerReview(documents) {
  const flagged = documents
    .filter((document) => document.analysis?.requiresHumanReview === true)
    .map((document) => ({
      documentId: document.id,
      documentType: document.documentType || document.name,
      analyzerVersion: document.analysis.analyzerVersion,
      confidence: document.analysis.confidence ?? null,
      reasons: document.analysis.humanReviewReasons || [],
    }));
  return {
    required: flagged.length > 0,
    status: flagged.length > 0 ? 'case_worker_review_required' : 'not_flagged',
    documents: flagged,
  };
}
const documentFormatError = 'Unsupported file format. Export the document as PDF, JPG, or PNG, then try again.';
const analysisUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, callback) => callback(allowedDocumentTypes.has(file.mimetype) ? null : new Error(documentFormatError), allowedDocumentTypes.has(file.mimetype)) });
const applicantDocumentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 5 }, fileFilter: (_req, file, callback) => callback(allowedDocumentTypes.has(file.mimetype) ? null : new Error(documentFormatError), allowedDocumentTypes.has(file.mimetype)) });
const letterUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

function recordContainsUploadedFile(value, fileName, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  for (const child of Object.values(value)) {
    if (typeof child === 'string') {
      try {
        const pathname = new URL(child, 'http://localhost').pathname;
        if (pathname === `/uploads/${fileName}`) return true;
      } catch {
        // Ignore malformed legacy URLs.
      }
    } else if (recordContainsUploadedFile(child, fileName, seen)) {
      return true;
    }
  }
  return false;
}

function canAccessUploadedFile(data, auth, fileName) {
  if (auth.role === 'Applicant') {
    const applicant = data.applicants.find((item) => item.id === auth.sub);
    if (
      data.documentUploads.some(
        (upload) =>
          upload.applicantId === auth.sub &&
          recordContainsUploadedFile(upload, fileName),
      )
    ) {
      return true;
    }
    return data.requests.some(
      (request) =>
        request.applicantId === auth.sub &&
        recordContainsUploadedFile(request, fileName),
    );
  }
  if (hasPermission(auth.role, 'identity:approve')) {
    if (
      data.applicants.some((applicant) =>
        recordContainsUploadedFile(applicant.identityVerification, fileName),
      )
    ) {
      return true;
    }
  }
  return data.requests.some(
    (request) =>
      requestIsPermittedForStaff(request, auth) &&
      recordContainsUploadedFile(request, fileName),
  );
}

function addAuditLog(data, request, actor, previousStatus, status, remarks, details = {}) {
  return addActivity(data, {
    action: 'status_updated',
    actor,
    affectedRecord: { type: 'request', id: request.id, label: request.requestId },
    details: { previousStatus, status, remarks: remarks || '', ...details },
    legacy: { requestId: request.id, requestNumber: request.requestId, previousStatus, status, remarks: remarks || '', ...details },
  });
}

const app = express();
app.use(cors());
// Base64 expands a 10 MB document to roughly 13.4 MB. This JSON limit exists
// for the legacy public mobile upload route below; multipart applicant uploads
// remain limited independently by Multer.
app.use(express.json({ limit: '15mb' }));
app.get('/uploads/:fileName', requireAuth, async (req, res) => {
  const fileName = String(req.params.fileName || '');
  if (
    fileName !== path.basename(fileName) ||
    !/^[A-Za-z0-9._-]{1,200}$/.test(fileName)
  ) {
    return res.status(400).json({ message: 'Invalid document path.' });
  }
  try {
    const data = await loadData();
    if (!canAccessUploadedFile(data, req.auth, fileName)) {
      return res.status(404).json({ message: 'Document not found.' });
    }
    const resolved = path.resolve(uploadsPath, fileName);
    const relative = path.relative(uploadsPath, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return res.status(400).json({ message: 'Invalid document path.' });
    }
    res.set({
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
    return res.sendFile(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') return res.status(404).json({ message: 'Document not found.' });
    return res.status(500).json({ message: 'Unable to load the protected document.' });
  }
});

app.post('/api/requests/:id/letter', requireAuth, requirePermission('requests:process'), letterUpload.single('letter'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Select a PDF, DOC, or DOCX guarantee letter.' });
  let type;
  try { type = classifyLetterFile(req.file); } catch (error) { return res.status(400).json({ message: error.message }); }
  try {
    const data = await loadData();
    const request = data.requests.find((item) => item.id === req.params.id);
    const actor = data.authUsers.find((item) => item.id === req.auth.sub);
    if (!request || !actor || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    if (!['approved', 'ready_for_claiming'].includes(request.status)) return res.status(400).json({ message: 'Claiming preparation, including guarantee-letter upload, is available only after the request is approved.' });
    const previous = request.protectedLetter || null;
    const version = (previous?.version || 0) + 1;
    const id = `letter-${crypto.randomUUID()}`;
    const originalFileName = `${id}-original.${type}`;
    const pdfFileName = `${id}-view.pdf`;
    await fs.mkdir(lettersPath, { recursive: true });
    await fs.writeFile(letterFilePath(originalFileName), req.file.buffer, { flag: 'wx' });
    if (previous) {
      request.letterHistory ??= [];
      request.letterHistory.push({ ...previous, status: previous.status === 'revoked' ? 'revoked' : 'replaced', replacedAt: new Date().toISOString() });
      request.qrCode = null;
      if (request.status === 'ready_for_claiming') {
        request.status = 'approved';
        if (request.guaranteeLetterTracking) request.guaranteeLetterTracking.status = 'scheduled';
      }
    }
    request.protectedLetter = { id, version, name: req.file.originalname, sourceType: type, mimeType: req.file.mimetype, conversionStatus: 'processing', status: 'pending_review', originalFileName, pdfFileName: null, uploaderId: actor.id, uploaderName: actor.fullName, uploadedAt: new Date().toISOString(), approvedAt: null, qrTokenHash: null, qrExpiresAt: null };
    if (previous) letterAudit(data, request, actor, 'guarantee_letter_replaced', { previousVersion: previous.version, previousQrRevoked: Boolean(previous.qrTokenHash) });
    letterAudit(data, request, actor, 'guarantee_letter_uploaded', { sourceType: type, mimeType: req.file.mimetype, sizeBytes: req.file.size });
    try {
      const pdf = type === 'pdf' ? req.file.buffer : await convertWordToPdf(req.file.buffer, type);
      const viewingPdf = await prepareViewingPdf(pdf, request.requestId, version);
      await fs.writeFile(letterFilePath(pdfFileName), viewingPdf, { flag: 'wx' });
      request.protectedLetter.pdfFileName = pdfFileName;
      request.protectedLetter.conversionStatus = 'ready';
      letterAudit(data, request, actor, 'guarantee_letter_converted', { sourceType: type, pdfReady: true, watermarked: true });
      await saveData(data);
      return res.status(201).json(publicProtectedLetter(request.protectedLetter));
    } catch (error) {
      request.protectedLetter.conversionStatus = 'failed';
      request.protectedLetter.status = 'conversion_failed';
      letterAudit(data, request, actor, 'guarantee_letter_conversion_failed', { sourceType: type, reason: error.message });
      await saveData(data);
      return res.status(422).json({ message: error.message, letter: publicProtectedLetter(request.protectedLetter) });
    }
  } catch { return res.status(500).json({ message: 'Unable to store the protected guarantee letter.' }); }
});

app.get('/api/requests/:id/letter/preview', requireAuth, requirePermission('requests:view'), async (req, res) => {
  try {
    const data = await loadData();
    const request = data.requests.find((item) => item.id === req.params.id);
    if (!request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    const letter = request.protectedLetter;
    if (!letter?.pdfFileName || letter.conversionStatus !== 'ready') return res.status(409).json({ message: 'The letter PDF is pending or unavailable.' });
    letter.previewedAt = new Date().toISOString();
    letter.previewedById = req.auth.sub;
    letterAudit(data, request, req.authUser, 'guarantee_letter_reviewed', { preview: true });
    await saveData(data);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.send(await fs.readFile(letterFilePath(letter.pdfFileName)));
  } catch { return res.status(500).json({ message: 'Unable to preview the protected letter.' }); }
});

app.post('/api/requests/:id/letter/confirm', requireAuth, requirePermission('requests:process'), async (req, res) => {
  try {
    const data = await loadData();
    const request = data.requests.find((item) => item.id === req.params.id);
    const actor = data.authUsers.find((item) => item.id === req.auth.sub);
    if (!request || !actor || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    if (request.status !== 'approved') return res.status(400).json({ message: 'Confirm the guarantee letter during Step 2 after the request is approved.' });
    const letter = request.protectedLetter;
    if (!letter || letter.version !== Number(req.body?.version) || req.body?.confirmed !== true || letter.status !== 'pending_review' || letter.conversionStatus !== 'ready' || !letter.previewedAt) return res.status(400).json({ message: 'Preview the current converted PDF, then explicitly confirm its version before release.' });
    letter.status = 'confirmed';
    letter.reviewedAt = new Date().toISOString();
    letter.reviewedById = actor.id;
    letterAudit(data, request, actor, 'guarantee_letter_confirmed', { reviewedAt: letter.reviewedAt });
    await saveData(data);
    return res.json(publicRequest(request));
  } catch { return res.status(500).json({ message: 'Unable to confirm the letter.' }); }
});

app.post('/api/requests/:id/letter/revoke', requireAuth, requirePermission('requests:process'), async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ message: 'Explain why the approved letter is being revoked.' });
  try {
    const data = await loadData();
    const request = data.requests.find((item) => item.id === req.params.id);
    const actor = data.authUsers.find((item) => item.id === req.auth.sub);
    if (!request || !actor || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    if (request.protectedLetter?.status !== 'approved') return res.status(400).json({ message: 'No current approved letter is available to revoke.' });
    request.protectedLetter.status = 'revoked';
    request.protectedLetter.revokedAt = new Date().toISOString();
    request.qrCode = null;
    if (request.status === 'ready_for_claiming') {
      request.status = 'approved';
      if (request.guaranteeLetterTracking) request.guaranteeLetterTracking.status = 'scheduled';
    }
    letterAudit(data, request, actor, 'guarantee_letter_revoked', { reason, previousQrRevoked: true });
    await saveData(data);
    return res.json(publicRequest(request));
  } catch { return res.status(500).json({ message: 'Unable to revoke the letter.' }); }
});

app.get('/api/letters/pdfjs/:asset', async (req, res) => {
  const allowed = new Set(['pdf.min.mjs', 'pdf.worker.min.mjs']);
  if (!allowed.has(req.params.asset)) return res.status(404).end();
  res.type('text/javascript');
  res.set('Cache-Control', 'public, max-age=86400');
  return res.sendFile(path.resolve(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', req.params.asset));
});

app.get('/api/letters/qr/:token', async (req, res) => {
  const token = String(req.params.token || '');
  if (!isQrVerificationToken(token)) return res.status(404).type('html').send(letterUnavailablePage('unavailable'));
  try {
    const data = await loadData();
    const tokenHash = hashQrToken(token);
    const request = data.requests.find((item) => item.protectedLetter?.qrTokenHash === tokenHash || (item.letterHistory || []).some((letter) => letter.qrTokenHash === tokenHash));
    const letter = request?.protectedLetter?.qrTokenHash === tokenHash ? request.protectedLetter : request?.letterHistory?.find((item) => item.qrTokenHash === tokenHash);
    if (request && letter === request.protectedLetter && await expireProtectedLetterIfDue(data, request)) await saveData(data);
    const state = qrState(letter, token);
    if (!request || state !== 'approved' || letter !== request.protectedLetter || !isApproved(request)) {
      if (request) { letterAudit(data, request, null, 'guarantee_letter_qr_scanned', { state, tokenVersion: letter?.version }); await saveData(data); }
      return res.status(state === 'expired' || state === 'revoked' || state === 'replaced' ? 410 : 404).type('html').send(letterUnavailablePage(state));
    }
    letterAudit(data, request, null, 'guarantee_letter_qr_scanned', { state, userAgent: String(req.get('user-agent') || '').slice(0, 200) });
    const access = issuePdfAccess(tokenSecret, request.id, request.protectedLetter.version, request.protectedLetter.qrTokenHash);
    await saveData(data);
    const endpoint = `/api/letters/${encodeURIComponent(request.id)}/pdf?access=${encodeURIComponent(access)}`;
    return res.type('html').send(letterViewerPage(request, endpoint));
  } catch { return res.status(500).type('html').send(letterUnavailablePage('unavailable')); }
});

app.get('/api/letters/:requestId/pdf', async (req, res) => {
  try {
    const data = await loadData();
    const request = data.requests.find((item) => item.id === req.params.requestId);
    if (request && await expireProtectedLetterIfDue(data, request)) await saveData(data);
    const letter = request?.protectedLetter;
    if (!request || !letter || letterStatusForApplicant(letter) !== 'approved') return res.status(404).json({ message: 'The approved letter is unavailable.' });
    if (letter.status !== 'approved' || !verifyPdfAccess(tokenSecret, req.query.access, request.id, letter.version, letter.qrTokenHash)) return res.status(403).json({ message: 'This protected letter access has expired or is invalid. Scan the current QR again.' });
    letterAudit(data, request, null, 'guarantee_letter_accessed', { version: letter.version });
    await saveData(data);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    return res.send(await fs.readFile(letterFilePath(letter.pdfFileName)));
  } catch { return res.status(500).json({ message: 'Unable to open the approved letter.' }); }
});

function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function letterUnavailablePage(state) {
  const messages = { pending: 'This letter is still pending staff review.', unavailable: 'This protected letter is unavailable.', expired: 'This letter QR has expired. Ask AidLink staff for an updated QR.', revoked: 'This letter has been revoked.', replaced: 'This QR belongs to a replaced letter. Use the QR for the current version.' };
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>AidLink protected letter</title><style>body{font:16px system-ui;background:#f8fafc;color:#0f172a;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:34rem;background:white;padding:2rem;border:1px solid #e2e8f0;border-radius:16px}h1{color:#1d4ed8}</style></head><body><main class="card"><h1>AidLink protected letter</h1><p>${escapeHtml(messages[state] || messages.unavailable)}</p><p>This is an AidLink viewing status, not an official client-system guarantee-letter QR.</p></main></body></html>`;
}
function letterViewerPage(request, pdfEndpoint) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>AidLink protected letter ${escapeHtml(request.requestId)}</title><style>body{margin:0;font-family:system-ui;background:#0f172a;color:white}header{padding:14px 18px;background:#1e293b;position:sticky;top:0;z-index:2}h1{font-size:16px;margin:0}p{font-size:12px;margin:5px 0 0;color:#cbd5e1}main{max-width:950px;margin:auto;padding:14px}canvas{display:block;width:100%;height:auto;margin:0 0 14px;background:white;box-shadow:0 4px 20px #0008}#status{text-align:center;padding:3rem}</style></head><body oncontextmenu="return false"><header><h1>AidLink protected guarantee letter · ${escapeHtml(request.requestId)}</h1><p>View only. AidLink does not provide download or print controls. Screenshots, photographs, browser tools, and other copying methods cannot be completely prevented.</p></header><main id="pages"><div id="status">Opening protected letter…</div></main><script type="module">import * as pdfjs from '/api/letters/pdfjs/pdf.min.mjs';pdfjs.GlobalWorkerOptions.workerSrc='/api/letters/pdfjs/pdf.worker.min.mjs';document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&(e.key==='p'||e.key==='s'))e.preventDefault()});try{const bytes=await fetch('${pdfEndpoint}',{cache:'no-store'}).then(async r=>{if(!r.ok)throw new Error((await r.json()).message);return r.arrayBuffer()});const pdf=await pdfjs.getDocument({data:bytes}).promise;document.querySelector('#status').remove();for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n),v=page.getViewport({scale:1.5}),c=document.createElement('canvas');c.width=v.width;c.height=v.height;document.querySelector('#pages').append(c);await page.render({canvasContext:c.getContext('2d'),viewport:v}).promise}}catch(e){document.querySelector('#status').textContent=e.message||'The letter is unavailable.'}</script></body></html>`;
}

app.get('/', (_req, res) => res.json({
  name: 'AidLink API',
  status: 'ok',
  healthCheck: '/api/status',
}));
app.get('/api/status', async (_req, res) => {
  const storage = await storageFoundation.health();
  const ready = storage.status === 'ok' && (!storage.migrations || storage.migrations.status === 'current');
  return res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable', storage });
});

app.post('/api/internal/mfa-events', async (req, res) => {
  if (!mfaAuditSecret) return res.status(503).json({ message: 'MFA activity integration is not configured.' });
  const providedSecret = String(req.get('x-aidlink-mfa-audit-secret') || '');
  const supplied = Buffer.from(providedSecret);
  const expected = Buffer.from(mfaAuditSecret);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return res.status(401).json({ message: 'Invalid MFA activity credentials.' });
  }
  const action = String(req.body?.action || '');
  const actorId = String(req.body?.actorId || '');
  const targetStaffId = String(req.body?.targetStaffId || actorId);
  if (!mfaAuditActions.has(action) || !actorId || !targetStaffId) {
    return res.status(400).json({ message: 'A supported MFA action, actor, and affected staff account are required.' });
  }
  try {
    const data = await loadData();
    const actor = data.authUsers.find((user) => user.id === actorId);
    const target = data.authUsers.find((user) => user.id === targetStaffId);
    if (!actor || !target) return res.status(404).json({ message: 'MFA actor or affected staff account not found.' });
    const details = Object.fromEntries(['method', 'provider', 'recoveryMethod', 'outcome', 'reason']
      .filter((key) => req.body?.[key] !== undefined)
      .map((key) => [key, String(req.body[key]).slice(0, 200)]));
    addActivity(data, {
      action,
      actor,
      affectedRecord: { type: 'staff_account', id: target.id, label: target.email },
      details,
      legacy: { targetStaffId: target.id, targetStaffEmail: target.email },
    });
    await saveData(data);
    return res.status(201).json({ message: 'MFA activity recorded.' });
  } catch {
    return res.status(500).json({ message: 'Unable to record MFA activity.' });
  }
});

app.post('/api/applicant/documents/analyze', requireAuth, requirePermission('applicant:documents'), requireVerifiedApplicant, analysisUpload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'A document is required.' });
  const requestedType = String(req.body?.documentType || 'supporting_document').trim();
  try {
    return res.json(await analyzeDocumentContents(req.file, requestedType));
  } finally {
    disposeDocumentBuffer(req.file);
  }
});

// Compatibility upload route for older authenticated mobile clients. It uses
// the same verified-account gate and blocking analysis as the multipart route.
app.post('/api/uploads', requireAuth, requirePermission('applicant:documents'), requireVerifiedApplicant, async (req, res) => {
  const originalName = path.basename(String(req.body?.name || '')).trim();
  const contentBase64 = String(req.body?.contentBase64 || '').replace(/\s/g, '');
  const extension = path.extname(originalName).toLowerCase();
  const allowedExtensions = new Set(['.pdf', '.jpg', '.jpeg', '.png']);
  if (!originalName || !contentBase64 || !allowedExtensions.has(extension)) {
    return res.status(400).json({ message: documentFormatError });
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) {
    return res.status(400).json({ message: 'The document data is invalid.' });
  }
  let contents;
  try {
    contents = Buffer.from(contentBase64, 'base64');
    if (!contents.length || contents.length > 10 * 1024 * 1024) {
      return res.status(400).json({ message: 'Each document must be 10 MB or smaller.' });
    }
    const mimeTypesByExtension = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
    };
    const documentType = String(req.body?.documentType || 'supporting_document').trim();
    const analysis = await analyzeDocumentContents({
      buffer: contents,
      size: contents.length,
      mimetype: mimeTypesByExtension[extension],
      originalname: originalName,
    }, documentType);
    if (!analysis.accepted) {
      const firstIssue = analysis.issues[0];
      return res.status(422).json({
        message: `${firstIssue.message} ${firstIssue.fix}`,
        analysis,
      });
    }
    await fs.mkdir(uploadsPath, { recursive: true });
    const storedName = `${crypto.randomUUID()}${extension}`;
    await fs.writeFile(path.join(uploadsPath, storedName), contents);
    const url = `${requestBaseUrl(req)}/uploads/${storedName}`;
    analysis.receipt = analysisReceipt(url, analysis);
    const documentId = `document-${crypto.randomUUID()}`;
    const data = await loadData();
    data.documentUploads.push({
      documentId,
      applicantId: req.auth.sub,
      url,
      createdAt: new Date().toISOString(),
      attachedRequestId: null,
    });
    await saveData(data);
    return res.status(201).json({
      id: documentId,
      name: originalName,
      url,
      documentType,
      analysis,
    });
  } catch {
    return res.status(500).json({ message: 'Unable to store the document.' });
  } finally {
    contents?.fill(0);
    if (req.body) req.body.contentBase64 = '';
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });
  try {
    const data = await loadData();
    const normalizedEmail = String(email).trim().toLowerCase();
    const user = data.authUsers.find((item) => item.email.toLowerCase() === normalizedEmail);
    const attemptedActor = user || { id: null, fullName: normalizedEmail, email: normalizedEmail, role: 'Unknown' };
    if (!user) {
      addActivity(data, { action: 'login_failed', actor: attemptedActor, affectedRecord: { type: 'staff_session', id: normalizedEmail, label: normalizedEmail }, details: authenticationDetails(req, 'failed', 'invalid_credentials') });
      await saveData(data);
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const validPassword = user.passwordHash
      ? await passwordsMatch(password, user.passwordHash)
      : user.password === password;
    if (!validPassword) {
      addActivity(data, { action: 'login_failed', actor: attemptedActor, affectedRecord: { type: 'staff_session', id: user.id, label: user.email }, details: authenticationDetails(req, 'failed', 'invalid_credentials') });
      await saveData(data);
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    if (user.active === false) {
      addActivity(data, { action: 'login_failed', actor: user, affectedRecord: { type: 'staff_session', id: user.id, label: user.email }, details: authenticationDetails(req, 'failed', 'account_deactivated') });
      await saveData(data);
      return res.status(403).json({ message: 'This staff account is deactivated. Contact a System Administrator.' });
    }

    // Upgrade legacy demo accounts to a salted hash after their first successful login.
    if (!user.passwordHash) {
      user.passwordHash = await hashPassword(password);
      delete user.password;
    }
    addActivity(data, { action: 'login_succeeded', actor: user, affectedRecord: { type: 'staff_session', id: user.id, label: user.email }, details: authenticationDetails(req, 'success') });
    await saveData(data);
    return res.json({ user: publicUser(user), token: createToken(user) });
  } catch {
    return res.status(500).json({ message: 'Unable to complete login.' });
  }
});

app.get('/api/auth/me', requireAuth, requirePermission('staff:identity'), (req, res) => {
  return res.json(publicUser(req.authUser));
});

app.post('/api/auth/logout', requireAuth, requirePermission('staff:identity'), async (req, res) => {
  try {
    const data = await loadData();
    const actor = data.authUsers.find((user) => user.id === req.auth.sub);
    if (!actor) return res.status(404).json({ message: 'Staff account not found.' });
    addActivity(data, { action: 'logout', actor, affectedRecord: { type: 'staff_session', id: actor.id, label: actor.email }, details: authenticationDetails(req, 'success') });
    await saveData(data);
    return res.json({ message: 'Logout recorded.' });
  } catch {
    return res.status(500).json({ message: 'Unable to record logout.' });
  }
});

app.post('/api/auth/register', (_req, res) => {
  return res.status(403).json({ message: 'Public staff registration is disabled. Contact a System Administrator.' });
});

app.get('/api/staff', requireAuth, requirePermission('staff:manage'), async (_req, res) => {
  try {
    const data = await loadData();
    return res.json(data.authUsers.map(publicUser).sort((a, b) => a.fullName.localeCompare(b.fullName)));
  } catch {
    return res.status(500).json({ message: 'Unable to load staff accounts.' });
  }
});

app.post('/api/staff', requireAuth, requirePermission('staff:manage'), async (req, res) => {
  const { fullName, email, password, role = 'Case Worker', phone = '', address = '', dateOfBirth = '', sex = '' } = req.body || {};
  if (![fullName, email, password].every((value) => String(value || '').trim())) {
    return res.status(400).json({ message: 'Full name, email, and temporary password are required.' });
  }
  if (String(password).length < 8) return res.status(400).json({ message: 'Temporary password must contain at least 8 characters.' });
  if (!staffRoles.includes(role)) return res.status(400).json({ message: 'Select a valid staff role.' });
  try {
    const data = await loadData();
    const normalizedEmail = String(email).trim().toLowerCase();
    if (data.authUsers.some((user) => user.email.toLowerCase() === normalizedEmail)) {
      return res.status(409).json({ message: 'A staff account with that email already exists.' });
    }
    const actor = data.authUsers.find((user) => user.id === req.auth.sub);
    if (!actor || !isSystemAdministrator(actor.role)) return res.status(403).json({ message: 'Only a System Administrator can create staff accounts.' });
    const staff = {
      id: `auth-${data.nextAuthUserId++}`,
      fullName: String(fullName).trim(),
      email: normalizedEmail,
      passwordHash: await hashPassword(password),
      phone: String(phone).trim(),
      address: String(address).trim(),
      dateOfBirth: String(dateOfBirth).trim(),
      sex: String(sex).trim(),
      role,
      active: true,
      sessionVersion: 1,
      registeredDate: new Date().toISOString(),
    };
    data.authUsers.push(staff);
    addStaffAudit(data, 'staff_created', actor, staff, { assignedRole: role });
    await saveData(data);
    return res.status(201).json(publicUser(staff));
  } catch {
    return res.status(500).json({ message: 'Unable to create the staff account.' });
  }
});

app.patch('/api/staff/:id/status', requireAuth, requirePermission('staff:manage'), async (req, res) => {
  if (typeof req.body?.active !== 'boolean') return res.status(400).json({ message: 'Active must be boolean.' });
  try {
    const data = await loadData();
    const actor = data.authUsers.find((user) => user.id === req.auth.sub);
    const staff = data.authUsers.find((user) => user.id === req.params.id);
    if (!actor || !isSystemAdministrator(actor.role)) return res.status(403).json({ message: 'Only a System Administrator can change staff access.' });
    if (!staff) return res.status(404).json({ message: 'Staff account not found.' });
    if (staff.id === actor.id && req.body.active === false) return res.status(400).json({ message: 'You cannot deactivate your own account.' });
    if (staff.active === req.body.active) return res.json(publicUser(staff));
    if (!req.body.active && isSystemAdministrator(staff.role)) {
      const otherActiveSystemAdministrators = data.authUsers.filter((user) => user.id !== staff.id && user.active !== false && isSystemAdministrator(user.role));
      if (!otherActiveSystemAdministrators.length) return res.status(400).json({ message: 'At least one active System Administrator is required.' });
    }
    staff.active = req.body.active;
    addStaffAudit(data, staff.active ? 'staff_activated' : 'staff_deactivated', actor, staff);
    await saveData(data);
    return res.json(publicUser(staff));
  } catch {
    return res.status(500).json({ message: 'Unable to change staff access.' });
  }
});

app.put('/api/staff/:id/role', requireAuth, requirePermission('staff:manage'), async (req, res) => {
  const role = String(req.body?.role || '');
  if (!staffRoles.includes(role)) return res.status(400).json({ message: 'Select a valid staff role.' });
  try {
    const data = await loadData();
    const actor = data.authUsers.find((user) => user.id === req.auth.sub);
    const staff = data.authUsers.find((user) => user.id === req.params.id);
    if (!actor || !isSystemAdministrator(actor.role)) return res.status(403).json({ message: 'Only a System Administrator can assign staff roles.' });
    if (!staff) return res.status(404).json({ message: 'Staff account not found.' });
    if (staff.id === actor.id && staff.role !== role) return res.status(400).json({ message: 'You cannot change your own System Administrator role.' });
    if (isSystemAdministrator(staff.role) && !isSystemAdministrator(role)) {
      const otherActiveSystemAdministrators = data.authUsers.filter((user) => user.id !== staff.id && user.active !== false && isSystemAdministrator(user.role));
      if (!otherActiveSystemAdministrators.length) return res.status(400).json({ message: 'At least one active System Administrator is required.' });
    }
    const previousRole = staff.role;
    staff.role = role;
    addStaffAudit(data, 'staff_role_changed', actor, staff, { previousRole, assignedRole: role });
    await saveData(data);
    return res.json(publicUser(staff));
  } catch {
    return res.status(500).json({ message: 'Unable to assign the staff role.' });
  }
});

app.post('/api/staff/:id/reset-password', requireAuth, requirePermission('staff:manage'), async (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < 8) return res.status(400).json({ message: 'The new temporary password must contain at least 8 characters.' });
  try {
    const data = await loadData();
    const actor = data.authUsers.find((user) => user.id === req.auth.sub);
    const staff = data.authUsers.find((user) => user.id === req.params.id);
    if (!actor || !isSystemAdministrator(actor.role)) return res.status(403).json({ message: 'Only a System Administrator can reset staff passwords.' });
    if (!staff) return res.status(404).json({ message: 'Staff account not found.' });
    staff.passwordHash = await hashPassword(password);
    delete staff.password;
    staff.sessionVersion = (staff.sessionVersion || 1) + 1;
    staff.passwordChangedAt = new Date().toISOString();
    addStaffAudit(data, 'staff_password_reset', actor, staff);
    await saveData(data);
    return res.json({ message: 'Password reset. Existing sessions for this account are no longer valid.' });
  } catch {
    return res.status(500).json({ message: 'Unable to reset the staff password.' });
  }
});

app.post('/api/applicant/auth/register', async (req, res) => {
  const { fullName, email, phone, address, dateOfBirth, password } = req.body;
  if (![fullName, email, phone, address, dateOfBirth, password].every((value) => String(value || '').trim())) {
    return res.status(400).json({ message: 'All applicant registration fields are required.' });
  }
  if (String(password).length < 8) return res.status(400).json({ message: 'Password must contain at least 8 characters.' });
  try {
    const data = await loadData();
    const normalizedEmail = String(email).trim().toLowerCase();
    if (data.applicants.some((item) => item.email === normalizedEmail)) {
      return res.status(409).json({ message: 'An applicant account with that email already exists.' });
    }
    const applicant = {
      id: `applicant-${data.nextApplicantId++}`,
      fullName: String(fullName).trim(),
      email: normalizedEmail,
      phone: String(phone).trim(),
      address: String(address).trim(),
      dateOfBirth,
      passwordHash: await hashPassword(password),
      role: 'Applicant',
      sessionVersion: 1,
      registeredDate: new Date().toISOString(),
      verificationStatus: 'unverified',
      accountStatus: 'basic',
      identityVerification: {
        status: 'unverified',
        document: null,
        decision: null,
        auditNotes: [],
      },
    };
    data.applicants.push(applicant);
    addActivity(data, { action: 'applicant_account_created', actor: applicant, affectedRecord: { type: 'applicant_account', id: applicant.id, label: applicant.email }, details: { registrationChannel: 'mobile', accountStatus: 'basic', verificationStatus: 'unverified' } });
    await saveData(data);
    return res.status(201).json({ user: publicUser(applicant), token: createToken(applicant) });
  } catch {
    return res.status(500).json({ message: 'Unable to register applicant.' });
  }
});

app.post('/api/applicant/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });
  try {
    const data = await loadData();
    const normalizedEmail = String(email).trim().toLowerCase();
    const applicant = data.applicants.find((item) => item.email === normalizedEmail);
    if (!applicant || !(await passwordsMatch(password, applicant.passwordHash))) {
      addActivity(data, { action: 'applicant_login_failed', actor: applicant || { id: null, fullName: normalizedEmail, email: normalizedEmail, role: 'Applicant' }, affectedRecord: { type: 'applicant_session', id: applicant?.id || normalizedEmail, label: normalizedEmail }, details: authenticationDetails(req, 'failed', 'invalid_credentials') });
      await saveData(data);
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    if (applicant.mfa?.enabled === true) {
      const { challengeToken } = createMfaChallenge(data, applicant, 'login');
      addMfaActivity(data, 'mfa_challenge_issued', applicant, req, { purpose: 'login', primaryMethod: 'totp' });
      await saveData(data);
      return res.status(202).json(mfaChallengeResponse(applicant, challengeToken));
    }
    addActivity(data, { action: 'applicant_login_succeeded', actor: applicant, affectedRecord: { type: 'applicant_session', id: applicant.id, label: applicant.email }, details: authenticationDetails(req, 'success') });
    await saveData(data);
    return res.json({ user: publicUser(applicant), token: createToken(applicant) });
  } catch {
    return res.status(500).json({ message: 'Unable to complete applicant login.' });
  }
});

app.post('/api/applicant/auth/mfa/sms/request', async (req, res) => {
  try {
    const data = await loadData();
    const challenge = resolveMfaChallenge(data, req.body.challengeToken, 'login');
    if (!challenge) return res.status(401).json({ message: 'The MFA challenge is invalid, expired, or already used. Sign in again.' });
    const applicant = data.applicants.find((item) => item.id === challenge.applicantId);
    if (!applicant?.mfa?.enabled) return res.status(401).json({ message: 'The MFA challenge is no longer valid.' });
    try {
      const delivery = await sendMfaSms(data, applicant, challenge, req);
      await saveData(data);
      return res.status(202).json({ message: 'A verification code was sent to the registered phone number.', deliveryStatus: delivery.status, expiresInSeconds: 300 });
    } catch (error) {
      await saveData(data);
      return res.status(error.statusCode || 502).json({ message: error.message });
    }
  } catch {
    return res.status(500).json({ message: 'Unable to request an SMS verification code.' });
  }
});

app.post('/api/applicant/auth/mfa/verify', async (req, res) => {
  const method = String(req.body.method || 'totp');
  try {
    const data = await loadData();
    const challenge = resolveMfaChallenge(data, req.body.challengeToken, 'login');
    if (!challenge) return res.status(401).json({ message: 'The MFA challenge is invalid, expired, or already used. Sign in again.' });
    const applicant = data.applicants.find((item) => item.id === challenge.applicantId);
    if (!applicant?.mfa?.enabled) return res.status(401).json({ message: 'The MFA challenge is no longer valid.' });
    const result = verifyApplicantFactor(applicant, challenge, method, req.body.code);
    if (!result.valid) {
      challenge.attempts += 1;
      addMfaActivity(data, 'mfa_verification_failed', applicant, req, { method, purpose: 'login', attempts: challenge.attempts, maxAttempts: challenge.maxAttempts });
      await saveData(data);
      return res.status(401).json({ message: challenge.attempts >= challenge.maxAttempts ? 'Too many invalid verification attempts. Sign in again.' : 'The verification code is invalid or expired.' });
    }
    challenge.consumedAt = new Date().toISOString();
    addMfaActivity(data, 'mfa_verification_succeeded', applicant, req, { method, purpose: 'login' });
    if (method === 'sms' || method === 'recovery_code') addMfaActivity(data, 'mfa_recovery_completed', applicant, req, { method, purpose: 'login' });
    addActivity(data, { action: 'applicant_login_succeeded', actor: applicant, affectedRecord: { type: 'applicant_session', id: applicant.id, label: applicant.email }, details: authenticationDetails(req, 'success') });
    await saveData(data);
    return res.json({ user: publicUser(applicant), token: createToken(applicant) });
  } catch {
    return res.status(500).json({ message: 'Unable to verify the MFA code.' });
  }
});

app.get('/api/applicant/mfa', requireAuth, requirePermission('applicant:profile'), async (req, res) => {
  return res.json(safeMfaStatus(req.authUser));
});

app.post('/api/applicant/mfa/totp/enroll/start', requireAuth, requirePermission('applicant:profile'), async (req, res) => {
  try {
    const data = await loadData();
    const applicant = data.applicants.find((item) => item.id === req.auth.sub);
    if (!applicant || !(await passwordsMatch(req.body.currentPassword, applicant.passwordHash))) {
      if (applicant) {
        addMfaActivity(data, 'mfa_verification_failed', applicant, req, { method: 'password', purpose: 'enrollment' });
        await saveData(data);
      }
      return res.status(401).json({ message: 'Current password is incorrect.' });
    }
    if (applicant.mfa?.enabled) return res.status(409).json({ message: 'Authenticator MFA is already enabled.' });
    const secret = generateTotpSecret();
    const expiresAt = new Date(Date.now() + (10 * 60 * 1000)).toISOString();
    applicant.mfa = {
      enabled: false,
      smsRecoveryEnabled: true,
      pendingEnrollment: { secretEncrypted: encryptMfaSecret(secret, mfaEncryptionSecret), expiresAt },
    };
    const issuer = data.systemSettings.organizationName || 'AidLink';
    const otpauthUri = createAuthenticatorUri({ issuer, email: applicant.email, secret });
    addMfaActivity(data, 'mfa_enrollment_started', applicant, req, { method: 'totp', expiresAt });
    await saveData(data);
    return res.status(201).json({
      secret,
      otpauthUri,
      qrCodeImageDataUrl: await QRCode.toDataURL(otpauthUri, { width: 280, margin: 2 }),
      expiresAt,
      message: 'Add this account to your authenticator app, then enter its 6-digit code.',
    });
  } catch {
    return res.status(500).json({ message: 'Unable to start authenticator enrollment.' });
  }
});

app.post('/api/applicant/mfa/totp/enroll/confirm', requireAuth, requirePermission('applicant:profile'), async (req, res) => {
  try {
    const data = await loadData();
    const applicant = data.applicants.find((item) => item.id === req.auth.sub);
    const pending = applicant?.mfa?.pendingEnrollment;
    if (!pending || new Date(pending.expiresAt).getTime() <= Date.now()) {
      return res.status(400).json({ message: 'Authenticator enrollment expired. Start again.' });
    }
    const secret = decryptMfaSecret(pending.secretEncrypted, mfaEncryptionSecret);
    const counter = verifyTotpCode(secret, req.body.code);
    if (counter === null) {
      addMfaActivity(data, 'mfa_verification_failed', applicant, req, { method: 'totp', purpose: 'enrollment' });
      await saveData(data);
      return res.status(401).json({ message: 'The authenticator code is invalid or expired.' });
    }
    const recoveryCodes = generateRecoveryCodes();
    applicant.mfa = {
      enabled: true,
      primaryMethod: 'totp',
      smsRecoveryEnabled: true,
      totpSecretEncrypted: encryptMfaSecret(secret, mfaEncryptionSecret),
      lastTotpCounter: counter,
      recoveryCodeHashes: recoveryCodes.map((code) => hashMfaCode(code, mfaEncryptionSecret, `recovery:${applicant.id}`)),
      enrolledAt: new Date().toISOString(),
    };
    applicant.sessionVersion = (applicant.sessionVersion || 1) + 1;
    addMfaActivity(data, 'mfa_enrolled', applicant, req, { method: 'totp', smsFallbackEnabled: Boolean(applicant.phone), recoveryCodeCount: recoveryCodes.length });
    addMfaActivity(data, 'mfa_verification_succeeded', applicant, req, { method: 'totp', purpose: 'enrollment' });
    await saveData(data);
    return res.json({
      status: safeMfaStatus(applicant),
      recoveryCodes,
      recoveryCodesShownOnce: true,
      token: createToken(applicant),
      message: 'MFA is enabled. Save these recovery codes now; they will not be shown again.',
    });
  } catch {
    return res.status(500).json({ message: 'Unable to confirm authenticator enrollment.' });
  }
});

app.post('/api/applicant/mfa/step-up/start', requireAuth, requirePermission('applicant:profile'), async (req, res) => {
  try {
    const data = await loadData();
    const applicant = data.applicants.find((item) => item.id === req.auth.sub);
    if (!applicant || !(await passwordsMatch(req.body.currentPassword, applicant.passwordHash))) {
      if (applicant) {
        addMfaActivity(data, 'mfa_verification_failed', applicant, req, { method: 'password', purpose: 'step_up' });
        await saveData(data);
      }
      return res.status(401).json({ message: 'Current password is incorrect.' });
    }
    if (!applicant.mfa?.enabled) {
      addMfaActivity(data, 'mfa_verification_succeeded', applicant, req, { method: 'password', purpose: 'step_up' });
      await saveData(data);
      return res.json({ stepUpToken: createStepUpToken(applicant), expiresInSeconds: 300 });
    }
    const { challengeToken } = createMfaChallenge(data, applicant, 'step_up');
    addMfaActivity(data, 'mfa_challenge_issued', applicant, req, { purpose: 'step_up', primaryMethod: 'totp' });
    await saveData(data);
    return res.status(202).json(mfaChallengeResponse(applicant, challengeToken));
  } catch {
    return res.status(500).json({ message: 'Unable to start step-up verification.' });
  }
});

app.post('/api/applicant/mfa/step-up/sms/request', requireAuth, requirePermission('applicant:profile'), async (req, res) => {
  try {
    const data = await loadData();
    const challenge = resolveMfaChallenge(data, req.body.challengeToken, 'step_up');
    if (!challenge || challenge.applicantId !== req.auth.sub) return res.status(401).json({ message: 'The step-up challenge is invalid or expired.' });
    const applicant = data.applicants.find((item) => item.id === req.auth.sub);
    try {
      const delivery = await sendMfaSms(data, applicant, challenge, req);
      await saveData(data);
      return res.status(202).json({ message: 'A verification code was sent to the registered phone number.', deliveryStatus: delivery.status, expiresInSeconds: 300 });
    } catch (error) {
      await saveData(data);
      return res.status(error.statusCode || 502).json({ message: error.message });
    }
  } catch {
    return res.status(500).json({ message: 'Unable to request an SMS verification code.' });
  }
});

app.post('/api/applicant/mfa/step-up/verify', requireAuth, requirePermission('applicant:profile'), async (req, res) => {
  const method = String(req.body.method || 'totp');
  try {
    const data = await loadData();
    const challenge = resolveMfaChallenge(data, req.body.challengeToken, 'step_up');
    if (!challenge || challenge.applicantId !== req.auth.sub) return res.status(401).json({ message: 'The step-up challenge is invalid or expired.' });
    const applicant = data.applicants.find((item) => item.id === req.auth.sub);
    const result = verifyApplicantFactor(applicant, challenge, method, req.body.code);
    if (!result.valid) {
      challenge.attempts += 1;
      addMfaActivity(data, 'mfa_verification_failed', applicant, req, { method, purpose: 'step_up', attempts: challenge.attempts, maxAttempts: challenge.maxAttempts });
      await saveData(data);
      return res.status(401).json({ message: 'The verification code is invalid or expired.' });
    }
    challenge.consumedAt = new Date().toISOString();
    addMfaActivity(data, 'mfa_verification_succeeded', applicant, req, { method, purpose: 'step_up' });
    if (method === 'sms' || method === 'recovery_code') addMfaActivity(data, 'mfa_recovery_completed', applicant, req, { method, purpose: 'step_up' });
    await saveData(data);
    return res.json({ stepUpToken: createStepUpToken(applicant), expiresInSeconds: 300 });
  } catch {
    return res.status(500).json({ message: 'Unable to complete step-up verification.' });
  }
});

app.post('/api/applicant/mfa/recovery-codes', requireAuth, requirePermission('applicant:profile'), async (req, res) => {
  try {
    const data = await loadData();
    const applicant = data.applicants.find((item) => item.id === req.auth.sub);
    if (!applicant?.mfa?.enabled) return res.status(409).json({ message: 'Enable authenticator MFA before generating recovery codes.' });
    const verified = validateStepUpToken(data, applicant, req.body.stepUpToken);
    if (!verified) return res.status(403).json({ message: 'Fresh step-up verification is required.' });
    const recoveryCodes = generateRecoveryCodes();
    applicant.mfa.recoveryCodeHashes = recoveryCodes.map((code) => hashMfaCode(code, mfaEncryptionSecret, `recovery:${applicant.id}`));
    consumeStepUpToken(data, verified);
    applicant.sessionVersion += 1;
    addMfaActivity(data, 'mfa_recovery_codes_regenerated', applicant, req, { recoveryCodeCount: recoveryCodes.length });
    await saveData(data);
    return res.json({ recoveryCodes, recoveryCodesShownOnce: true, token: createToken(applicant), status: safeMfaStatus(applicant) });
  } catch {
    return res.status(500).json({ message: 'Unable to regenerate recovery codes.' });
  }
});

app.delete('/api/applicant/mfa', requireAuth, requirePermission('applicant:profile'), async (req, res) => {
  try {
    const data = await loadData();
    const applicant = data.applicants.find((item) => item.id === req.auth.sub);
    const verified = validateStepUpToken(data, applicant, req.body.stepUpToken);
    if (!verified) return res.status(403).json({ message: 'Fresh step-up verification is required.' });
    consumeStepUpToken(data, verified);
    applicant.mfa = { enabled: false, smsRecoveryEnabled: true };
    applicant.sessionVersion += 1;
    addMfaActivity(data, 'mfa_disabled', applicant, req, { previousMethod: 'totp' });
    await saveData(data);
    return res.json({ token: createToken(applicant), status: safeMfaStatus(applicant) });
  } catch {
    return res.status(500).json({ message: 'Unable to disable MFA.' });
  }
});

app.patch('/api/applicant/account/contact', requireAuth, requirePermission('applicant:profile'), async (req, res) => {
  try {
    const data = await loadData();
    const applicant = data.applicants.find((item) => item.id === req.auth.sub);
    const verified = validateStepUpToken(data, applicant, req.body.stepUpToken);
    if (!verified) return res.status(403).json({ message: 'Fresh step-up verification is required to change email or phone number.' });
    const email = req.body.email === undefined ? applicant.email : String(req.body.email).trim().toLowerCase();
    const phone = req.body.phone === undefined ? applicant.phone : String(req.body.phone).trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email address.' });
    if (!phone) return res.status(400).json({ message: 'A phone number is required.' });
    if (data.applicants.some((item) => item.id !== applicant.id && item.email === email)) return res.status(409).json({ message: 'That email address is already registered.' });
    const previousEmail = applicant.email;
    const previousPhone = maskedPhone(applicant.phone);
    applicant.email = email;
    applicant.phone = phone;
    consumeStepUpToken(data, verified);
    applicant.sessionVersion += 1;
    addMfaActivity(data, 'applicant_contact_changed', applicant, req, { previousEmail, newEmail: email, previousPhone, newPhone: maskedPhone(phone) });
    await saveData(data);
    return res.json({ user: publicUser(applicant), token: createToken(applicant) });
  } catch {
    return res.status(500).json({ message: 'Unable to update applicant contact details.' });
  }
});

app.post('/api/applicant/account/password', requireAuth, requirePermission('applicant:profile'), async (req, res) => {
  if (String(req.body.newPassword || '').length < 8) return res.status(400).json({ message: 'New password must contain at least 8 characters.' });
  try {
    const data = await loadData();
    const applicant = data.applicants.find((item) => item.id === req.auth.sub);
    const verified = validateStepUpToken(data, applicant, req.body.stepUpToken);
    if (!verified) return res.status(403).json({ message: 'Fresh step-up verification is required to change your password.' });
    applicant.passwordHash = await hashPassword(req.body.newPassword);
    consumeStepUpToken(data, verified);
    applicant.sessionVersion += 1;
    addMfaActivity(data, 'applicant_password_changed', applicant, req);
    await saveData(data);
    return res.json({ message: 'Password changed. Other sessions are no longer valid.', token: createToken(applicant) });
  } catch {
    return res.status(500).json({ message: 'Unable to change applicant password.' });
  }
});

app.get('/api/applicant/identity-verification', requireAuth, requirePermission('applicant:profile'), async (req, res) => {
  try {
    const applicant = (await loadData()).applicants.find((item) => item.id === req.auth.sub);
    if (!applicant) return res.status(404).json({ message: 'Applicant account not found.' });
    return res.json({
      applicantId: applicant.id,
      accountStatus: applicant.accountStatus,
      verificationStatus: applicant.verificationStatus,
      identityVerification: applicant.identityVerification,
    });
  } catch {
    return res.status(500).json({ message: 'Unable to load identity verification.' });
  }
});

app.post('/api/applicant/identity-verification/document', requireAuth, requirePermission('applicant:profile'), applicantDocumentUpload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Upload a valid government-issued ID.' });
  try {
    const analysis = await analyzeDocumentContents(req.file, 'Government-issued ID');
    if (!analysis.accepted) {
      const issue = analysis.issues[0];
      return res.status(422).json({ message: `${issue.message} ${issue.fix}`, analysis });
    }
    const data = await loadData();
    const applicant = data.applicants.find((item) => item.id === req.auth.sub);
    if (!applicant) return res.status(404).json({ message: 'Applicant account not found.' });
    await fs.mkdir(uploadsPath, { recursive: true });
    const storedName = `${crypto.randomUUID()}${path.extname(req.file.originalname).toLowerCase()}`;
    await fs.writeFile(path.join(uploadsPath, storedName), req.file.buffer);
    const url = `${requestBaseUrl(req)}/uploads/${storedName}`;
    analysis.receipt = analysisReceipt(url, analysis);
    const document = {
      id: `identity-document-${crypto.randomUUID()}`,
      name: req.file.originalname,
      url,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      documentType: 'Government-issued ID',
      uploadedAt: new Date().toISOString(),
      analysis,
    };
    const previousStatus = applicant.verificationStatus || 'unverified';
    const previousAccountStatus = applicant.accountStatus || 'basic';
    applicant.verificationStatus = 'pending';
    applicant.accountStatus = 'basic';
    applicant.identityVerification = {
      status: 'pending',
      document,
      decision: null,
      auditNotes: [...(applicant.identityVerification?.auditNotes || [])],
    };
    addActivity(data, {
      action: 'applicant_id_uploaded',
      actor: applicant,
      affectedRecord: { type: 'applicant_account', id: applicant.id, label: applicant.email },
      details: { documentId: document.id, fileName: document.name, mimeType: document.mimeType, sizeBytes: document.sizeBytes, analysisAccepted: true, analyzerVersion: analysis.analyzerVersion, previousStatus, verificationStatus: 'pending' },
    });
    if (previousStatus !== 'pending') {
      addActivity(data, {
        action: 'applicant_account_status_changed',
        actor: applicant,
        affectedRecord: { type: 'applicant_account', id: applicant.id, label: applicant.email },
        details: { previousAccountStatus, accountStatus: 'basic', previousVerificationStatus: previousStatus, verificationStatus: 'pending' },
      });
    }
    await saveData(data);
    return res.status(201).json({ applicantId: applicant.id, accountStatus: applicant.accountStatus, verificationStatus: applicant.verificationStatus, identityVerification: applicant.identityVerification });
  } catch {
    return res.status(500).json({ message: 'Unable to store the identity document.' });
  } finally {
    disposeDocumentBuffer(req.file);
  }
});

app.post('/api/applicant/documents', requireAuth, requirePermission('applicant:documents'), requireVerifiedApplicant, applicantDocumentUpload.array('documents', 5), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ message: 'At least one document is required.' });
  const requestedType = String(req.body?.documentType || 'supporting_document').trim();
  try {
    const analyses = await Promise.all(req.files.map((file) => analyzeDocumentContents(file, requestedType)));
    const failed = analyses.find((analysis) => !analysis.accepted);
    if (failed) {
      const firstIssue = failed.issues[0];
      return res.status(422).json({
        message: `${firstIssue.message} ${firstIssue.fix}`,
        analysis: failed,
      });
    }
    await fs.mkdir(uploadsPath, { recursive: true });
    const baseUrl = requestBaseUrl(req);
    const documents = [];
    for (let index = 0; index < req.files.length; index += 1) {
      const file = req.files[index];
      const storedName = `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`;
      await fs.writeFile(path.join(uploadsPath, storedName), file.buffer);
      const url = `${baseUrl}/uploads/${storedName}`;
      const analysis = { ...analyses[index] };
      analysis.receipt = analysisReceipt(url, analysis);
      documents.push({ id: `document-${crypto.randomUUID()}`, name: file.originalname, url, documentType: requestedType, analysis });
    }
    const data = await loadData();
    const actor = data.applicants.find((applicant) => applicant.id === req.auth.sub);
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      data.documentUploads.push({
        documentId: document.id,
        applicantId: req.auth.sub,
        url: document.url,
        createdAt: new Date().toISOString(),
        attachedRequestId: null,
      });
      addActivity(data, {
        action: 'document_uploaded',
        actor,
        affectedRecord: { type: 'document', id: document.id, label: document.name },
        details: { documentType: document.documentType, sizeBytes: req.files[index].size, analysisAccepted: document.analysis.accepted, analyzerVersion: document.analysis.analyzerVersion },
        legacy: { documentId: document.id, documentName: document.name },
      });
    }
    await saveData(data);
    return res.status(201).json({ documents });
  } catch {
    return res.status(500).json({ message: 'Unable to analyze and store the document. Please try again.' });
  } finally {
    for (const file of req.files || []) disposeDocumentBuffer(file);
  }
});

app.post('/api/applicant/applications', requireAuth, requirePermission('applicant:applications'), requireVerifiedApplicant, async (req, res) => {
  const clientSubmissionId = String(req.body?.clientSubmissionId || '').trim();
  if (clientSubmissionId && !/^[A-Za-z0-9._:-]{16,128}$/.test(clientSubmissionId)) {
    return res.status(400).json({ message: 'The submission identifier is invalid. Refresh the form and try again.' });
  }
  const {
    assistanceType,
    incomeSource,
    patientCircumstance,
    additionalDetails = '',
    latitude = null,
    longitude = null,
    documents = [],
    facilityEvidence = null,
  } = req.body;
  const normalizedAssistanceType = normalizeAssistanceType(assistanceType);
  const normalizedIncomeSource = normalizeIncomeSource(incomeSource);
  const normalizedPatientCircumstance = normalizePatientCircumstance(patientCircumstance);
  if (!normalizedAssistanceType || !normalizedIncomeSource || !normalizedPatientCircumstance) {
    return res.status(400).json({ message: 'Assistance type, income source, and patient circumstance are required and must use supported values.' });
  }
  if (normalizedAssistanceType === 'Medicine Assistance') {
    return res.status(400).json({ message: 'Medicine Assistance is no longer available for new applications.' });
  }
  if (!isValidAssistanceType(normalizedAssistanceType)) {
    return res.status(400).json({ message: 'Unsupported assistance type.' });
  }
  if (!postgresSubmissionPolicyGatesEnabled && (!Array.isArray(documents) || !documents.length || documents.some((document) => !document?.name || !hasAcceptedDocumentAnalysis(document)))) {
    return res.status(400).json({ message: 'Every supporting document must have a valid, accepted quality analysis. Replace any failed or unanalyzed document.' });
  }
  try {
    const data = await loadData();
    if (data.assistanceTypeSettings[normalizedAssistanceType]?.active === false) {
      return res.status(400).json({ message: 'This assistance type is not currently accepting new applications.' });
    }
    const account = data.applicants.find((item) => item.id === req.auth.sub);
    if (!account) return res.status(404).json({ message: 'Applicant account not found.' });
    const existingSubmission = clientSubmissionId
      ? data.requests.find((item) => item.applicantId === account.id && item.clientSubmissionId === clientSubmissionId)
      : null;
    if (existingSubmission && !postgresSubmissionPolicyGatesEnabled) return res.status(200).json(existingSubmission);
    if (account.verificationStatus !== 'approved') {
      return res.status(403).json({ message: 'Government-issued ID verification must be approved before submitting a request.', verificationRequired: true, verificationStatus: account.verificationStatus });
    }
    const parties = applicationParties(req.body, account);
    if (parties.error) return res.status(400).json({ message: parties.error });
    const checklist = postgresSubmissionPolicyGatesEnabled
      ? { value: true }
      : validateRequiredDocumentChecklist(documents, data.requiredDocuments[normalizedAssistanceType] || []);
    if (checklist.error && !postgresSubmissionPolicyGatesEnabled) return res.status(400).json({ message: checklist.error });
    const evidence = postgresSubmissionPolicyGatesEnabled
      ? { value: facilityEvidence || {} }
      : validateFacilityEvidence(facilityEvidence, documents, data.systemSettings.receiptValidityDays);
    if (evidence.error && !postgresSubmissionPolicyGatesEnabled) return res.status(400).json({ message: evidence.error });
    let applicant = data.users.find((user) => user.email === account.email);
    if (!applicant) {
      applicant = {
        id: `user-${data.nextUserId++}`,
        name: account.fullName,
        email: account.email,
        phone: account.phone,
        address: account.address,
        dateOfBirth: account.dateOfBirth,
        registeredDate: account.registeredDate,
        totalApplications: 0,
      };
      data.users.push(applicant);
    }
    applicant.totalApplications += 1;
    const application = {
      id: `request-${data.nextRequestId++}`,
      requestId: `LINGAP-${new Date().getFullYear()}-${String(data.nextRequestId - 1).padStart(5, '0')}`,
      applicantId: account.id,
      clientSubmissionId: clientSubmissionId || null,
      requester: parties.requester,
      beneficiaryType: parties.beneficiaryType,
      beneficiary: parties.beneficiary,
      applicantName: parties.beneficiary.fullName,
      email: account.email,
      phone: account.phone,
      address: parties.beneficiary.address,
      dateOfBirth: parties.beneficiary.dateOfBirth,
      relationshipToPatient: parties.beneficiary.relationshipToApplicant,
      sex: parties.beneficiary.sex,
      assistanceType: normalizedAssistanceType,
      incomeSource: normalizedIncomeSource,
      patientCircumstance: normalizedPatientCircumstance,
      additionalDetails: String(additionalDetails || '').trim(),
      latitude: latitude === null ? null : Number(latitude),
      longitude: longitude === null ? null : Number(longitude),
      documents: documents.map(({ id, name, url, documentType, analysis }) => ({ id: String(id || `document-${crypto.randomUUID()}`), name: String(name).trim(), url: String(url).trim(), documentType: String(documentType || name).trim(), analysis })),
      documentAnalysisReview: documentAnalyzerReview(documents),
      facilityEvidence: evidence.value || facilityEvidence || {},
      originatingOfficeId: account.originatingOfficeId || null,
      policyVersion: null,
      policyFindings: [],
      requiredReviews: [],
      decisionSnapshot: {},
      status: 'pending',
      dateSubmitted: new Date().toISOString(),
    };
    const gatedSubmission = await runPostgresSubmissionPolicyGates({
      application,
      account,
      requiredDocuments: data.requiredDocuments[normalizedAssistanceType] || [],
    });
    if (gatedSubmission && !gatedSubmission.created) return policyGateFailureResponse(res, gatedSubmission);
    for (const upload of data.documentUploads) {
      if (
        upload.applicantId === account.id &&
        application.documents.some((document) => document.id === upload.documentId)
      ) {
        upload.attachedRequestId = application.id;
      }
    }
    data.requests.push(application);
    addActivity(data, {
      action: 'application_submitted',
      actor: account,
      affectedRecord: { type: 'request', id: application.id, label: application.requestId },
      details: { assistanceType: application.assistanceType, beneficiaryType: application.beneficiaryType, beneficiaryName: application.beneficiary.fullName, facilityName: application.facilityEvidence.facilityName, receiptDate: application.facilityEvidence.receiptDate, documentCount: application.documents.length, analyzerHumanReviewRequired: application.documentAnalysisReview.required, documents: application.documents.map((document) => ({ id: document.id, name: document.name, documentType: document.documentType })) },
      legacy: { requestId: application.id, requestNumber: application.requestId },
    });
    addNotification(data, { audience: 'admin', request: application, title: 'New assistance request', message: `${parties.requester.fullName} submitted ${application.requestId} for ${parties.beneficiary.fullName}.` });
    await saveData(data);
    return res.status(201).json(application);
  } catch {
    return res.status(500).json({ message: 'Unable to submit the application.' });
  }
});

app.get('/api/applicant/requests', requireAuth, requirePermission('applicant:requests'), requireVerifiedApplicant, async (req, res) => {
  try {
    const requests = deduplicateRequestsByStableId(
      (await loadData()).requests.filter((request) => request.applicantId === req.auth.sub),
    );
    return res.json(requests.sort((a, b) => b.dateSubmitted.localeCompare(a.dateSubmitted)).map(publicRequest));
  } catch {
    return res.status(500).json({ message: 'Unable to load application history.' });
  }
});

app.get('/api/applicant/requests/:id', requireAuth, requirePermission('applicant:requests'), requireVerifiedApplicant, async (req, res) => {
  try {
    const request = (await loadData()).requests.find((item) => item.id === req.params.id && item.applicantId === req.auth.sub);
    if (!request) return res.status(404).json({ message: 'Application not found.' });
    const notifications = (await loadData()).notifications.filter((item) => item.audience === 'applicant' && item.applicantId === req.auth.sub && item.requestId === request.id);
    return res.json({ ...publicRequest(request), notifications });
  } catch {
    return res.status(500).json({ message: 'Unable to load application.' });
  }
});

app.post('/api/applicant/requests/:id/corrections/documents/:documentId', requireAuth, requirePermission('applicant:requests'), requireVerifiedApplicant, applicantDocumentUpload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Select a replacement document.' });
  try {
    const data = await loadData();
    const request = data.requests.find((item) => item.id === req.params.id && item.applicantId === req.auth.sub);
    const applicant = data.applicants.find((item) => item.id === req.auth.sub);
    if (!request || !applicant) return res.status(404).json({ message: 'Correction request not found.' });
    const correction = request.correctionRequest;
    const requestedDocument = correction?.documents?.find((item) => item.documentId === req.params.documentId);
    const previousDocument = request.documents.find((item) => item.id === req.params.documentId);
    if (request.status !== 'correction_requested' || !correction || !requestedDocument || !previousDocument) {
      return res.status(400).json({ message: 'This document is not currently eligible for replacement.' });
    }

    const analysis = await analyzeDocumentContents(req.file, previousDocument.documentType || previousDocument.name);
    if (!analysis.accepted) {
      const firstIssue = analysis.issues[0];
      return res.status(422).json({ message: `${firstIssue.message} ${firstIssue.fix}`, analysis });
    }
    await fs.mkdir(uploadsPath, { recursive: true });
    const storedName = `${crypto.randomUUID()}${path.extname(req.file.originalname).toLowerCase()}`;
    await fs.writeFile(path.join(uploadsPath, storedName), req.file.buffer);
    const url = `${requestBaseUrl(req)}/uploads/${storedName}`;
    analysis.receipt = analysisReceipt(url, analysis);
    const replacement = {
      id: `document-${crypto.randomUUID()}`,
      name: req.file.originalname,
      url,
      documentType: previousDocument.documentType || previousDocument.name,
      label: previousDocument.label || documentLabel(previousDocument.documentType || previousDocument.name),
      analysis,
      replacesDocumentId: previousDocument.id,
      correctionRequestId: correction.id,
      uploadedAt: new Date().toISOString(),
      uploadedById: applicant.id,
    };
    correction.replacements ??= [];
    const earlierReplacement = correction.replacements.find((item) => item.replacesDocumentId === previousDocument.id) || null;
    correction.replacements = correction.replacements.filter((item) => item.replacesDocumentId !== previousDocument.id);
    correction.replacements.push(replacement);
    request.lastUpdatedAt = replacement.uploadedAt;
    addAuditLog(data, request, applicant, request.status, request.status, `Replacement uploaded for ${replacement.label}.`, {
      action: 'correction_document_uploaded',
      correctionRequestId: correction.id,
      previousDocument: { ...previousDocument },
      replacementDocument: { ...replacement },
      ...(earlierReplacement ? { supersededPendingReplacement: earlierReplacement } : {}),
    });
    addNotification(data, { audience: 'admin', request, title: 'Correction document uploaded', message: `${request.requestId}: ${replacement.label} was replaced and is awaiting correction submission.` });
    await saveData(data);
    return res.status(201).json({ request: publicRequest(request), replacementDocument: replacement });
  } catch {
    return res.status(500).json({ message: 'Unable to store the replacement document.' });
  } finally {
    disposeDocumentBuffer(req.file);
  }
});

app.post('/api/applicant/requests/:id/corrections/submit', requireAuth, requirePermission('applicant:requests'), requireVerifiedApplicant, async (req, res) => {
  try {
    const data = await loadData();
    const request = data.requests.find((item) => item.id === req.params.id && item.applicantId === req.auth.sub);
    const applicant = data.applicants.find((item) => item.id === req.auth.sub);
    if (!request || !applicant) return res.status(404).json({ message: 'Correction request not found.' });
    const correction = request.correctionRequest;
    if (request.status !== 'correction_requested' || !correction) {
      return res.status(400).json({ message: 'This request is not awaiting corrections.' });
    }
    const replacements = correction.replacements || [];
    const missing = correction.documents.filter((item) => !replacements.some((replacement) => replacement.replacesDocumentId === item.documentId));
    if (missing.length) {
      return res.status(400).json({ message: `Replace all requested documents before submitting corrections. Still required: ${missing.map((item) => item.label || item.name).join(', ')}.` });
    }

    const previousStatus = request.status;
    const previousDocuments = [];
    const submittedReplacements = [];
    for (const requested of correction.documents) {
      const index = request.documents.findIndex((item) => item.id === requested.documentId);
      const replacement = replacements.find((item) => item.replacesDocumentId === requested.documentId);
      if (index < 0 || !replacement || !hasAcceptedDocumentAnalysis(replacement)) {
        return res.status(400).json({ message: 'A requested replacement is missing a valid quality analysis. Upload it again.' });
      }
      const previousDocument = { ...request.documents[index], supersededAt: new Date().toISOString(), correctionRequestId: correction.id };
      previousDocuments.push(previousDocument);
      request.documentHistory ??= [];
      request.documentHistory.push(previousDocument);
      const submittedDocument = { ...replacement, submittedAt: new Date().toISOString() };
      request.documents[index] = submittedDocument;
      if (request.facilityEvidence?.receiptDocumentId === requested.documentId) {
        request.facilityEvidence.receiptDocumentId = submittedDocument.id;
      }
      submittedReplacements.push(submittedDocument);
    }

    const submittedAt = new Date().toISOString();
    request.status = 'under_review';
    request.remarks = 'The applicant submitted all requested document corrections.';
    request.lastUpdatedAt = submittedAt;
    request.correctionHistory ??= [];
    request.correctionHistory.push({ ...correction, status: 'submitted', submittedAt });
    delete request.correctionRequest;
    addAuditLog(data, request, applicant, previousStatus, request.status, request.remarks, {
      action: 'corrections_submitted',
      correctionRequestId: correction.id,
      previousDocuments,
      replacementDocuments: submittedReplacements,
    });
    addNotification(data, { audience: 'admin', request, title: 'Corrections submitted', message: `${request.requestId} returned to Under Review after all requested documents were replaced.` });
    await saveData(data);
    return res.json(publicRequest(request));
  } catch {
    return res.status(500).json({ message: 'Unable to submit the document corrections.' });
  }
});

app.get('/api/applicant/profile', requireAuth, requirePermission('applicant:profile'), async (req, res) => {
  try {
    const applicant = (await loadData()).applicants.find((item) => item.id === req.auth.sub);
    return applicant ? res.json(publicUser(applicant)) : res.status(404).json({ message: 'Applicant account not found.' });
  } catch { return res.status(500).json({ message: 'Unable to load applicant profile.' }); }
});

app.get('/api/applicant/notifications', requireAuth, requirePermission('applicant:notifications'), requireVerifiedApplicant, async (req, res) => {
  try {
    const items = (await loadData()).notifications
      .filter((item) => item.audience === 'applicant' && item.applicantId === req.auth.sub)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return res.json(items);
  } catch { return res.status(500).json({ message: 'Unable to load applicant notifications.' }); }
});

// Compatibility endpoint used by older applicant clients. Authentication and
// the stable applicant ID still own every request; editable patient/email
// fields never determine who can retrieve it.
app.post('/api/applications', requireAuth, requirePermission('applicant:applications'), requireVerifiedApplicant, async (req, res) => {
  const clientSubmissionId = String(req.body?.clientSubmissionId || '').trim();
  if (clientSubmissionId && !/^[A-Za-z0-9._:-]{16,128}$/.test(clientSubmissionId)) {
    return res.status(400).json({ message: 'The submission identifier is invalid. Refresh the form and try again.' });
  }
  const {
    beneficiaryType,
    beneficiary,
    fullName,
    email,
    phone,
    address,
    dateOfBirth,
    relationshipToPatient,
    sex,
    assistanceType,
    incomeSource,
    patientCircumstance,
    additionalDetails = '',
    latitude = null,
    longitude = null,
    documents = [],
    facilityEvidence = null,
  } = req.body;
  const normalizedAssistanceType = normalizeAssistanceType(assistanceType);
  const normalizedIncomeSource = normalizeIncomeSource(incomeSource);
  const normalizedPatientCircumstance = normalizePatientCircumstance(patientCircumstance);
  if (![normalizedAssistanceType, normalizedIncomeSource, normalizedPatientCircumstance].every((value) => String(value || '').trim())) {
    return res.status(400).json({ message: 'Assistance type, income source, and patient circumstance are required and must use supported values.' });
  }
  if (normalizedAssistanceType === 'Medicine Assistance') {
    return res.status(400).json({ message: 'Medicine Assistance is no longer available for new applications.' });
  }
  if (!isValidAssistanceType(normalizedAssistanceType)) {
    return res.status(400).json({ message: 'Unsupported assistance type.' });
  }
  if (!postgresSubmissionPolicyGatesEnabled && (!Array.isArray(documents) || documents.length === 0)) {
    return res.status(400).json({ message: 'At least one supporting document is required.' });
  }
  if (!postgresSubmissionPolicyGatesEnabled && documents.some((document) => !document?.name || !hasAcceptedDocumentAnalysis(document))) {
    return res.status(400).json({ message: 'Every supporting document must have a valid, accepted quality analysis. Replace any failed or unanalyzed document.' });
  }
  try {
    const data = await loadData();
    if (data.assistanceTypeSettings[normalizedAssistanceType]?.active === false) {
      return res.status(400).json({ message: 'This assistance type is not currently accepting new applications.' });
    }
    const account = data.applicants.find((item) => item.id === req.auth.sub);
    if (!account) return res.status(404).json({ message: 'Applicant account not found.' });
    const existingSubmission = clientSubmissionId
      ? data.requests.find((item) => item.applicantId === account.id && item.clientSubmissionId === clientSubmissionId)
      : null;
    if (existingSubmission && !postgresSubmissionPolicyGatesEnabled) return res.status(200).json(existingSubmission);
    const parties = applicationParties({ ...req.body, beneficiaryType, beneficiary, fullName, email, phone, address, dateOfBirth, relationshipToPatient, sex }, account);
    if (parties.error) return res.status(400).json({ message: parties.error });
    const checklist = postgresSubmissionPolicyGatesEnabled
      ? { value: true }
      : validateRequiredDocumentChecklist(documents, data.requiredDocuments[normalizedAssistanceType] || []);
    if (checklist.error && !postgresSubmissionPolicyGatesEnabled) return res.status(400).json({ message: checklist.error });
    const evidence = postgresSubmissionPolicyGatesEnabled
      ? { value: facilityEvidence || {} }
      : validateFacilityEvidence(facilityEvidence, documents, data.systemSettings.receiptValidityDays);
    if (evidence.error && !postgresSubmissionPolicyGatesEnabled) return res.status(400).json({ message: evidence.error });
    const normalizedEmail = String(account.email).trim().toLowerCase();
    let applicant = data.users.find((user) => user.email.toLowerCase() === normalizedEmail);
    if (!applicant) {
      applicant = {
        id: `user-${data.nextUserId++}`,
        name: account.fullName,
        email: normalizedEmail,
        phone: account.phone,
        address: account.address,
        dateOfBirth: account.dateOfBirth,
        registeredDate: new Date().toISOString(),
        totalApplications: 0,
      };
      data.users.push(applicant);
    }
    applicant.totalApplications += 1;
    const requestNumber = `LINGAP-${new Date().getFullYear()}-${String(data.nextRequestId).padStart(5, '0')}`;
    const application = {
      id: `request-${data.nextRequestId++}`,
      requestId: requestNumber,
      applicantId: account.id,
      clientSubmissionId: clientSubmissionId || null,
      requester: parties.requester,
      beneficiaryType: parties.beneficiaryType,
      beneficiary: parties.beneficiary,
      applicantName: parties.beneficiary.fullName,
      email: normalizedEmail,
      phone: account.phone,
      address: parties.beneficiary.address,
      dateOfBirth: parties.beneficiary.dateOfBirth,
      relationshipToPatient: parties.beneficiary.relationshipToApplicant,
      sex: parties.beneficiary.sex,
      assistanceType: normalizedAssistanceType,
      incomeSource: normalizedIncomeSource,
      patientCircumstance: normalizedPatientCircumstance,
      additionalDetails: String(additionalDetails || '').trim(),
      latitude: latitude === null ? null : Number(latitude),
      longitude: longitude === null ? null : Number(longitude),
      documents: documents.map((document) => ({ id: String(document.id || `document-${crypto.randomUUID()}`), name: String(document.name).trim(), url: String(document.url).trim(), documentType: String(document.documentType || document.name).trim(), analysis: document.analysis })),
      documentAnalysisReview: documentAnalyzerReview(documents),
      facilityEvidence: evidence.value || facilityEvidence || {},
      originatingOfficeId: account.originatingOfficeId || null,
      policyVersion: null,
      policyFindings: [],
      requiredReviews: [],
      decisionSnapshot: {},
      status: 'pending',
      dateSubmitted: new Date().toISOString(),
    };
    const gatedSubmission = await runPostgresSubmissionPolicyGates({
      application,
      account,
      requiredDocuments: data.requiredDocuments[normalizedAssistanceType] || [],
    });
    if (gatedSubmission && !gatedSubmission.created) return policyGateFailureResponse(res, gatedSubmission);
    for (const upload of data.documentUploads) {
      if (
        upload.applicantId === account.id &&
        application.documents.some((document) => document.id === upload.documentId)
      ) {
        upload.attachedRequestId = application.id;
      }
    }
    data.requests.push(application);
    addActivity(data, {
      action: 'application_submitted',
      actor: account,
      affectedRecord: { type: 'request', id: application.id, label: application.requestId },
      details: { channel: 'mobile', assistanceType: application.assistanceType, beneficiaryType: application.beneficiaryType, beneficiaryName: application.beneficiary.fullName, facilityName: application.facilityEvidence.facilityName, receiptDate: application.facilityEvidence.receiptDate, documentCount: application.documents.length, analyzerHumanReviewRequired: application.documentAnalysisReview.required, documents: application.documents.map((document) => ({ id: document.id, name: document.name, documentType: document.documentType })) },
      legacy: { requestId: application.id, requestNumber: application.requestId },
    });
    addNotification(data, { audience: 'admin', request: application, title: 'New assistance request', message: `${parties.requester.fullName} submitted ${application.requestId} for ${parties.beneficiary.fullName}.` });
    await saveData(data);
    return res.status(201).json(application);
  } catch {
    return res.status(500).json({ message: 'Unable to submit the application.' });
  }
});

// Legacy reference-number lookup remains token-bound. An editable email can
// never be used to retrieve another applicant's request.
app.get('/api/applications/:requestId/status', requireAuth, requirePermission('applicant:requests'), requireVerifiedApplicant, async (req, res) => {
  try {
    const request = (await loadData()).requests.find((item) =>
      item.requestId === req.params.requestId && item.applicantId === req.auth.sub);
    if (!request) return res.status(404).json({ message: 'Application not found.' });
    return res.json({
      requestId: request.requestId,
      status: request.status,
      remarks: request.remarks || '',
      lastUpdatedAt: request.lastUpdatedAt || request.dateSubmitted,
      guaranteeLetter: request.guaranteeLetter || null,
      guaranteeLetterTracking: request.guaranteeLetterTracking || null,
      protectedLetter: request.protectedLetter ? publicProtectedLetter(request.protectedLetter) : null,
      qrCode: letterStatusForApplicant(request.protectedLetter) === 'approved' || (!request.protectedLetter && request.guaranteeLetter) ? request.qrCode || null : null,
      notifications: (await loadData()).notifications.filter((item) => item.requestId === request.id && item.applicantId === req.auth.sub),
    });
  } catch {
    return res.status(500).json({ message: 'Unable to load application status.' });
  }
});

app.get('/api/requests', requireAuth, requirePermission('requests:view'), async (req, res) => {
  try {
    const requests = [...(await loadData()).requests, ...temporaryRequests]
      .filter((request) => requestIsPermittedForStaff(request, req.auth))
      .map(publicRequest)
      .sort((a, b) => b.dateSubmitted.localeCompare(a.dateSubmitted));
    return res.json(requests);
  } catch { return res.status(500).json({ message: 'Unable to load requests.' }); }
});

app.get('/api/requests/:id', requireAuth, requirePermission('requests:view'), async (req, res) => {
  try {
    const request = temporaryRequests.find((item) => item.id === req.params.id)
      ?? (await loadData()).requests.find((item) => item.id === req.params.id);
    if (!request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    return res.json(publicRequest(request));
  } catch { return res.status(500).json({ message: 'Unable to load request.' }); }
});

app.get('/api/requests/:id/audit', requireAuth, requirePermission('requests:audit'), async (req, res) => {
  try {
    const data = await loadData();
    const request = temporaryRequests.find((item) => item.id === req.params.id) ?? data.requests.find((item) => item.id === req.params.id);
    if (!request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    return res.json([...data.auditLogs, ...temporaryAuditLogs].filter((log) => log.requestId === req.params.id).sort((a, b) => b.performedAt.localeCompare(a.performedAt)));
  } catch { return res.status(500).json({ message: 'Unable to load audit history.' }); }
});

app.put('/api/requests/:id/status', requireAuth, requirePermission('requests:process'), async (req, res) => {
  const { status, remarks = '', correctionDocumentIds = [] } = req.body || {};
  if (req.body?.facilityId) return res.status(400).json({ message: 'Facility assignment is no longer part of request processing. Review the submitted receipt evidence instead.' });
  if (!['under_review', 'correction_requested', 'approved', 'denied'].includes(status)) return res.status(400).json({ message: 'Invalid request status.' });
  const trimmedRemarks = String(remarks).trim();
  if (!trimmedRemarks) return res.status(400).json({ message: status === 'correction_requested' ? 'Enter a correction remark that clearly explains what the applicant must fix.' : 'Decision remarks are required.' });
  if (status === 'correction_requested' && trimmedRemarks.length < 10) return res.status(400).json({ message: 'Add more detail to the correction remark so the applicant knows what to fix.' });
  let requestedDocumentIds = [];
  try {
    const parsed = typeof correctionDocumentIds === 'string' ? JSON.parse(correctionDocumentIds) : correctionDocumentIds;
    requestedDocumentIds = Array.isArray(parsed) ? [...new Set(parsed.map((value) => String(value).trim()).filter(Boolean))] : [];
  } catch {
    return res.status(400).json({ message: 'Correction document selection is invalid.' });
  }
  if (status === 'correction_requested' && !requestedDocumentIds.length) return res.status(400).json({ message: 'Select at least one document that the applicant must replace.' });
  try {
    const data = await loadData();
    const temporaryRequest = temporaryRequests.find((item) => item.id === req.params.id);
    const request = temporaryRequest ?? data.requests.find((item) => item.id === req.params.id);
    const actor = data.authUsers.find((item) => item.id === req.auth.sub);
    if (!request || !actor || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request or Case Worker not found.' });
    if (status === 'correction_requested' && !['pending', 'under_review'].includes(request.status)) {
      return res.status(400).json({ message: 'Corrections can only be requested while an application is pending or under review.' });
    }
    if (status === 'under_review' && request.status !== 'pending') {
      return res.status(400).json({ message: 'Only a pending request can be moved into review.' });
    }
    if (['approved', 'denied'].includes(status) && request.status !== 'under_review') {
      return res.status(400).json({ message: 'Complete Step 1 by moving the request under review before approving or denying it.' });
    }
    if (request.status === 'correction_requested') {
      return res.status(400).json({ message: 'The applicant must submit the requested corrections before this status can change.' });
    }
    let selectedDocuments = [];
    if (status === 'correction_requested') {
      if (!request.applicantId) return res.status(400).json({ message: 'This legacy request is not linked to an applicant account and cannot receive in-app corrections.' });
      selectedDocuments = requestedDocumentIds.map((documentId) => request.documents.find((document) => document.id === documentId));
      if (selectedDocuments.some((document) => !document)) return res.status(400).json({ message: 'One or more selected documents no longer belong to this request.' });
    } else if (status === 'approved') {
      const checklist = validateRequiredDocumentChecklist(
        request.documents || [],
        data.requiredDocuments[request.assistanceType] || [],
      );
      if (checklist.error) return res.status(400).json({ message: checklist.error });
      // TEMPORARY DEMO BYPASS: allow approval without facility evidence validation.
      // Restore the original validation before final release or production use.
      if (request.facilityEvidence) {
        request.facilityEvidence = request.facilityEvidence;
      }
      if (storageFoundation.repositories?.hardDisqualifiers) {
        const hardResult = await storageFoundation.repositories.hardDisqualifiers.evaluateRequest({
          requestId: request.id,
          actorId: actor.id,
          justification: 'Evaluate hard disqualifiers before request approval.',
        });
        if (!hardResult.approvalAllowed) {
          return res.status(409).json({
            code: 'HARD_DISQUALIFIER_BLOCKED',
            message: hardResult.findings[0]?.message || 'This request cannot be approved until the hard-disqualifier findings are resolved.',
            outcome: hardResult.outcome,
            evaluationId: hardResult.evaluationId,
            reasonCodes: hardResult.reasonCodes,
            findings: hardResult.findings,
            requiredEvidence: hardResult.requiredEvidence,
          });
        }
        request.hardDisqualifierOutcome = hardResult.outcome;
        request.hardDisqualifierEvaluationId = hardResult.evaluationId;
        request.hardDisqualifierReasonCodes = hardResult.reasonCodes;
        const coveragePolicy = await storageFoundation.repositories.policies.getEffectivePolicy({ policyKey: 'coverage_matrix', assistanceType: request.assistanceType, at: new Date() });
        if (coveragePolicy?.configuration?.status === 'active') {
          let coverageResult;
          try {
            coverageResult = await storageFoundation.repositories.coverage.calculateRequest({ requestId: request.id, actorId: actor.id, justification: 'Calculate the coverage matrix after hard-disqualifier clearance and before approval.' });
          } catch (error) {
            if (error?.code === 'COVERAGE_INPUT_REQUIRED') return res.status(409).json({ code: error.code, message: error.message });
            throw error;
          }
          if (coverageResult.outcome === 'ineligible') return res.status(409).json({ code: 'COVERAGE_INELIGIBLE', message: coverageResult.adjustments[0]?.message || 'The active coverage matrix returned ineligible.', coverage: coverageResult });
          request.coverageMatrixOutcome = coverageResult.outcome;
          request.coverageSnapshotId = coverageResult.snapshotId;
          request.coveredAmount = coverageResult.coveredAmount;
          request.netRemainingBalance = coverageResult.netRemainingBalance;
        }
        const workflowValidation = await storageFoundation.repositories.workflow.validateForApproval({ requestId: request.id, actorId: actor.id });
        if (!workflowValidation.approvalAllowed) return res.status(409).json({ code: workflowValidation.code, message: workflowValidation.message, evaluation: workflowValidation.current });
      }
    }
    const previousStatus = request.status;
    request.status = status;
    request.remarks = trimmedRemarks;
    request.lastUpdatedAt = new Date().toISOString();
    let correctionDetails = {};
    if (status === 'correction_requested') {
      const correctionRequest = {
        id: `correction-${crypto.randomUUID()}`,
        status: 'requested',
        remark: request.remarks,
        requestedAt: request.lastUpdatedAt,
        requestedBy: actor.fullName,
        requestedById: actor.id,
        documents: selectedDocuments.map((document) => ({ documentId: document.id, documentType: document.documentType, name: document.name, label: document.label || documentLabel(document.documentType || document.name) })),
        replacements: [],
      };
      request.correctionRequest = correctionRequest;
      correctionDetails = {
        action: 'correction_requested',
        correctionRequestId: correctionRequest.id,
        selectedDocuments: selectedDocuments.map((document) => ({ ...document })),
      };
    } else if (status === 'approved') {
      request.processedBy = actor.fullName;
      request.processedAt = request.lastUpdatedAt;
      correctionDetails = { action: 'request_approved', reviewCompletedAt: request.processedAt, nextStep: 'claiming_preparation' };
    }
    addNotification(data, {
      audience: 'applicant',
      applicantId: request.applicantId,
      request,
      title: status === 'correction_requested' ? 'Document corrections requested' : status === 'approved' ? 'Request approved' : status === 'denied' ? 'Request denied' : 'Request under review',
      message: status === 'correction_requested'
        ? `${request.requestId}: Replace ${request.correctionRequest.documents.map((item) => item.label).join(', ')}. ${request.remarks}`
        : status === 'approved'
          ? `${request.requestId} passed review. Claiming preparation and the protected guarantee letter are still pending.`
          : `${request.requestId} is now ${status.replace('_', ' ')}.`,
    });
    if (temporaryRequest) {
      temporaryAuditLogs.push({
        id: `temporary-audit-${nextTemporaryAuditId++}`,
        requestId: request.id,
        requestNumber: request.requestId,
        action: 'status_updated',
        previousStatus,
        status,
        remarks: request.remarks,
        performedBy: actor.fullName,
        performedById: actor.id,
        performedAt: request.lastUpdatedAt,
      });
    } else {
      addAuditLog(data, request, actor, previousStatus, status, request.remarks, correctionDetails);
      await saveData(data);
      if (storageFoundation.database) {
        await storageFoundation.database.query(
          'UPDATE requests SET status = $2, processed_by = CASE WHEN $2 IN (\'approved\',\'denied\') THEN $3 ELSE processed_by END, processed_at = CASE WHEN $2 IN (\'approved\',\'denied\') THEN now() ELSE processed_at END, updated_at = now() WHERE id = $1',
          [request.id, status, actor.id],
        );
      }
    }
    return res.json(publicRequest(request));
  } catch { return res.status(500).json({ message: 'Unable to update request status.' }); }
});

app.put('/api/requests/:id/guarantee-letter-tracking', requireAuth, requirePermission('requests:process'), async (req, res) => {
  try {
    const data = await loadData();
    const temporaryRequest = temporaryRequests.find((item) => item.id === req.params.id);
    const request = temporaryRequest ?? data.requests.find((item) => item.id === req.params.id);
    const actor = data.authUsers.find((item) => item.id === req.auth.sub);
    if (!request || !actor || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request or Case Worker not found.' });
    if (request.status !== 'approved') return res.status(400).json({ message: 'Claiming preparation can only be edited after Step 1 approval and before final release.' });
    const previousGuaranteeLetterTracking = request.guaranteeLetterTracking ? { ...request.guaranteeLetterTracking } : null;
    const trackingResult = validateGuaranteeLetterTracking({ ...(previousGuaranteeLetterTracking || {}), ...(req.body || {}) });
    if (trackingResult.error) return res.status(400).json({ message: trackingResult.error });
    const updatedAt = new Date().toISOString();
    request.guaranteeLetterTracking = {
      ...trackingResult.value,
      status: trackingResult.value.status === 'ready_for_claiming' ? 'scheduled' : trackingResult.value.status,
      updatedAt,
      updatedBy: actor.fullName,
      updatedById: actor.id,
    };
    request.lastUpdatedAt = updatedAt;
    const auditDetails = {
      action: 'guarantee_letter_tracking_updated',
      previousGuaranteeLetterTracking,
      guaranteeLetterTracking: { ...request.guaranteeLetterTracking },
    };
    const auditRemarks = `External guarantee-letter tracking updated to ${request.guaranteeLetterTracking.status.replaceAll('_', ' ')}.`;
    if (temporaryRequest) {
      temporaryAuditLogs.push({
        id: `temporary-audit-${nextTemporaryAuditId++}`,
        requestId: request.id,
        requestNumber: request.requestId,
        previousStatus: request.status,
        status: request.status,
        remarks: auditRemarks,
        performedBy: actor.fullName,
        performedById: actor.id,
        performedAt: updatedAt,
        ...auditDetails,
      });
    } else {
      addAuditLog(data, request, actor, request.status, request.status, auditRemarks, auditDetails);
      await saveData(data);
    }
    return res.json(publicRequest(request));
  } catch {
    return res.status(500).json({ message: 'Unable to update external guarantee-letter tracking.' });
  }
});

app.post('/api/requests/:id/claiming/release', requireAuth, requirePermission('requests:process'), async (req, res) => {
  try {
    const data = await loadData();
    const request = data.requests.find((item) => item.id === req.params.id);
    const actor = data.authUsers.find((item) => item.id === req.auth.sub);
    if (!request || !actor || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    if (request.status !== 'approved') return res.status(400).json({ message: 'Only an approved request in Step 2 can be released for claiming.' });
    const trackingResult = validateGuaranteeLetterTracking(request.guaranteeLetterTracking, { requireComplete: true });
    if (trackingResult.error) return res.status(400).json({ message: trackingResult.error });
    if (request.protectedLetter?.status !== 'confirmed' || request.protectedLetter?.conversionStatus !== 'ready') {
      return res.status(400).json({ message: 'Upload, preview, and confirm the current guarantee letter before final release.' });
    }
    const previousStatus = request.status;
    const releasedAt = new Date().toISOString();
    const qr = issueLetterQr(tokenSecret, request.id, request.protectedLetter.version, 3, releasedAt);
    let controlledRelease = null;
    if (storageFoundation.repositories) {
      controlledRelease = await storageFoundation.repositories.aidLink.releaseGuaranteeLetter({
        requestId: request.id,
        letterId: request.protectedLetter.id,
        letter: {
          version: request.protectedLetter.version,
          sourceMimeType: request.protectedLetter.mimeType || (request.protectedLetter.sourceType === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
          originalStorageKey: `private-letters/${request.protectedLetter.originalFileName}`,
          pdfStorageKey: `private-letters/${request.protectedLetter.pdfFileName}`,
          uploadedAt: request.protectedLetter.uploadedAt,
          reviewedAt: request.protectedLetter.reviewedAt,
          metadata: { originalName: request.protectedLetter.name, sourceType: request.protectedLetter.sourceType },
        },
        claimingDate: trackingResult.value.scheduledFor,
        claimingTime: trackingResult.value.claimingTime,
        claimingLocation: trackingResult.value.claimingLocation,
        qrTokenHash: qr.tokenHash,
        releasedAt,
        actorId: actor.id,
        justification: 'Claiming details and the protected Guarantee Letter were approved for release.',
      });
    }
    await approveProtectedLetter(data, request, actor, req, controlledRelease ? { ...controlledRelease, qr } : { qr, validityDays: 7 });
    request.status = 'ready_for_claiming';
    request.lastUpdatedAt = releasedAt;
    request.guaranteeLetterTracking = {
      ...trackingResult.value,
      status: 'ready_for_claiming',
      updatedAt: releasedAt,
      updatedBy: actor.fullName,
      updatedById: actor.id,
      releasedAt,
      releasedBy: actor.fullName,
      releasedById: actor.id,
    };
    addAuditLog(data, request, actor, previousStatus, request.status, 'Claiming details and the protected guarantee letter were approved for release.', {
      action: 'claiming_preparation_released',
      guaranteeLetterTracking: { ...request.guaranteeLetterTracking },
      letterVersion: request.protectedLetter.version,
      budgetAllocation: request.budgetAllocation || null,
    });
    addNotification(data, {
      audience: 'applicant',
      applicantId: request.applicantId,
      request,
      title: 'Approved for claiming',
      message: `${request.requestId} is ready for claiming on ${request.guaranteeLetterTracking.scheduledFor} at ${request.guaranteeLetterTracking.claimingTime}, ${request.guaranteeLetterTracking.claimingLocation}.`,
    });
    await queueApprovalSms(data, request, actor);
    await saveData(data);
    return res.json(publicRequest(request));
  } catch (error) {
    const status = ['BUDGET_POOL_NOT_CONFIGURED', 'BUDGET_DEPLETED', 'ASSISTANCE_LIMIT_EXCEEDED', 'COVERAGE_AMOUNT_REQUIRED', 'GUARANTEE_LETTER_VALIDITY_INVALID'].includes(error?.code) ? 409 : 500;
    return res.status(status).json({ code: error?.code || 'CLAIMING_RELEASE_FAILED', message: error instanceof Error ? error.message : 'Unable to release the request for claiming.', ...(error?.budget ? { budget: error.budget } : {}) });
  }
});

app.get('/api/budgets', requireAuth, requirePermission(Permissions.CONFIGURATION_MANAGE), async (req, res) => {
  if (!storageFoundation.repositories) return res.status(503).json({ message: 'Budget configuration requires PostgreSQL.' });
  try { return res.json(await storageFoundation.repositories.aidLink.listBudgetPools({ includeInactive: req.query.includeInactive === 'true' })); }
  catch { return res.status(500).json({ message: 'Unable to load city budget pools.' }); }
});

app.post('/api/budgets', requireAuth, requirePermission(Permissions.CONFIGURATION_MANAGE), async (req, res) => {
  if (!storageFoundation.repositories) return res.status(503).json({ message: 'Budget configuration requires PostgreSQL.' });
  if (req.body?.confirmed !== true) return res.status(400).json({ code: 'PUBLICATION_CONFIRMATION_REQUIRED', message: 'Confirm that the budget values and effective dates are ready to publish.' });
  try {
    const pool = await storageFoundation.repositories.aidLink.createBudgetPool({ ...req.body, actorId: req.auth.sub });
    return res.status(201).json(pool);
  } catch (error) {
    const status = ['BUDGET_PERIOD_OVERLAP', 'BUDGET_NAME_REQUIRED', 'BUDGET_AMOUNT_INVALID', 'ASSISTANCE_LIMIT_INVALID', 'DEPLETION_THRESHOLD_INVALID', 'GUARANTEE_LETTER_VALIDITY_INVALID', 'BUDGET_EFFECTIVE_DATES_INVALID', 'BUDGET_JUSTIFICATION_REQUIRED'].includes(error?.code) ? 400 : 500;
    return res.status(status).json({ code: error?.code || 'BUDGET_CONFIGURATION_FAILED', message: error instanceof Error ? error.message : 'Unable to create the budget pool.' });
  }
});

app.get('/api/assistance-types/required-documents', requireAuth, requirePermission('configuration:manage'), async (_req, res) => {
  try { return res.json((await loadData()).requiredDocuments); } catch { return res.status(500).json({ message: 'Unable to load document requirements.' }); }
});

app.get('/api/assistance-types', async (_req, res) => {
  try {
    const data = await loadData();
    return res.json(assistanceTypes.filter((type) => data.assistanceTypeSettings[type]?.active !== false));
  } catch {
    return res.status(500).json({ message: 'Unable to load assistance types.' });
  }
});

app.get('/api/applicant/assistance-types/:type/required-documents', requireAuth, requirePermission('applicant:applications'), requireVerifiedApplicant, async (req, res) => {
  const type = normalizeAssistanceType(req.params.type);
  if (!type || !isValidAssistanceType(type)) return res.status(404).json({ message: 'Assistance type not found.' });
  try {
    const data = await loadData();
    if (data.assistanceTypeSettings[type]?.active === false) return res.status(409).json({ message: 'This assistance type is not accepting new requests.' });
    return res.json({ assistanceType: type, requiredDocuments: data.requiredDocuments[type] || [], receiptValidityDays: data.systemSettings.receiptValidityDays });
  } catch {
    return res.status(500).json({ message: 'Unable to load application requirements.' });
  }
});

app.put('/api/assistance-types/:type/required-documents', requireAuth, requirePermission('configuration:manage'), async (req, res) => {
  const type = String(req.params.type);
  const documents = req.body?.documents;
  if (!assistanceTypes.includes(type) || !Array.isArray(documents) || !documents.length || documents.some((item) => !String(item).trim())) return res.status(400).json({ message: 'A valid assistance type and document list are required.' });
  if (!documents.some(isReceiptRequirement)) return res.status(400).json({ message: 'Each assistance type must require a recent receipt or billing document so the facility and transaction can be validated.' });
  try {
    const data = await loadData();
    const previousDocuments = [...(data.requiredDocuments[type] || [])];
    data.requiredDocuments[type] = [...new Set(documents.map((item) => String(item).trim()))];
    addActivity(data, { action: 'required_documents_updated', actor: req.authUser, affectedRecord: { type: 'assistance_type', id: type, label: type }, details: { previousDocuments, documents: [...data.requiredDocuments[type]] }, legacy: { assistanceType: type } });
    await saveData(data);
    return res.json({ type, documents: data.requiredDocuments[type] });
  } catch { return res.status(500).json({ message: 'Unable to update document requirements.' }); }
});

app.get('/api/policies/:policyKey/effective', requireAuth, requirePermission(Permissions.POLICY_VIEW), async (req, res) => {
  if (!storageFoundation.repositories) return res.status(503).json({ message: 'Policy storage is unavailable until PostgreSQL is configured.' });
  const policyKey = String(req.params.policyKey || '').trim();
  const assistanceType = req.query.assistanceType ? String(req.query.assistanceType).trim() : null;
  const at = req.query.at ? new Date(String(req.query.at)) : new Date();
  if (!/^[a-z0-9_.:-]{2,80}$/i.test(policyKey) || Number.isNaN(at.getTime())) {
    return res.status(400).json({ message: 'Provide a valid policy key and evaluation date.' });
  }
  try {
    const policy = await storageFoundation.repositories.policies.getEffectivePolicy({ policyKey, assistanceType, at });
    if (!policy) return res.status(404).json({ message: 'No effective policy version was found.' });
    return res.json({
      id: policy.id,
      policyKey: policy.policy_key,
      policyVersion: policy.policy_version,
      assistanceType: policy.assistance_type,
      configuration: policy.configuration,
      effectiveDate: policy.effective_date,
      effectiveUntil: policy.effective_until,
      actorId: policy.actor_id,
      justification: policy.justification,
    });
  } catch {
    return res.status(500).json({ message: 'Unable to load the effective policy.' });
  }
});

app.get('/api/policies/:policyKey/versions', requireAuth, requirePermission(Permissions.POLICY_VIEW), async (req, res) => {
  if (!storageFoundation.repositories) return res.status(503).json({ message: 'Policy storage is unavailable until PostgreSQL is configured.' });
  const policyKey = String(req.params.policyKey || '').trim();
  const assistanceType = req.query.assistanceType ? String(req.query.assistanceType).trim() : null;
  if (!administrablePolicyKeys.has(policyKey)) return res.status(400).json({ message: 'This policy is not available in the administrator publication console.' });
  try {
    const versions = await storageFoundation.repositories.policies.listPolicyVersions({ policyKey, assistanceType });
    return res.json(versions.map((policy) => ({
      id: policy.id, policyKey: policy.policy_key, policyVersion: policy.policy_version,
      assistanceType: policy.assistance_type, configuration: policy.configuration,
      effectiveDate: policy.effective_date, effectiveUntil: policy.effective_until,
      actorId: policy.actor_id, justification: policy.justification, publishedAt: policy.published_at || policy.created_at,
    })));
  } catch {
    return res.status(500).json({ message: 'Unable to load policy-version history.' });
  }
});

app.post('/api/policies/:policyKey/versions', requireAuth, requirePermission(Permissions.POLICY_CONFIGURE), async (req, res) => {
  if (!storageFoundation.repositories) return res.status(503).json({ message: 'Policy storage is unavailable until PostgreSQL is configured.' });
  const policyKey = String(req.params.policyKey || '').trim();
  const assistanceType = req.body?.assistanceType ? String(req.body.assistanceType).trim() : null;
  const configuration = req.body?.configuration;
  const justification = String(req.body?.justification || '').trim();
  const effectiveDate = req.body?.effectiveDate ? new Date(String(req.body.effectiveDate)) : null;
  if (!/^[a-z0-9_.:-]{2,80}$/i.test(policyKey)) return res.status(400).json({ message: 'Provide a valid policy key.' });
  if (!administrablePolicyKeys.has(policyKey)) return res.status(400).json({ message: 'This policy key cannot be published from the administration console.' });
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return res.status(400).json({ message: 'Policy configuration must be an object.' });
  if (justification.length < 10) return res.status(400).json({ message: 'Enter a policy publication justification of at least 10 characters.' });
  if (!effectiveDate || Number.isNaN(effectiveDate.getTime())) return res.status(400).json({ message: 'Provide the policy effective date.' });
  if (req.body?.confirmed !== true) return res.status(400).json({ code: 'PUBLICATION_CONFIRMATION_REQUIRED', message: 'Confirm that this policy version is ready to publish.' });
  const validationMessage = validateAdministrablePolicy(policyKey, configuration);
  if (validationMessage) return res.status(400).json({ message: validationMessage });
  try {
    const created = await storageFoundation.repositories.policies.createPolicyVersion({
      policyKey, assistanceType, configuration, effectiveDate,
      effectiveUntil: req.body?.effectiveUntil || null,
      actorId: req.auth.sub, justification,
    });
    return res.status(201).json(created);
  } catch (error) {
    const status = ['INVALID_HARD_DISQUALIFIER_POLICY', 'ARMED_GROUP_APPROVAL_REQUIRED', 'INVALID_COVERAGE_POLICY', 'PAYER_APPROVAL_REQUIRED', 'INVALID_PAYER_VERIFICATION', 'APPLICANT_PAYER_FIELD_FORBIDDEN'].includes(error?.code) ? 400 : 500;
    return res.status(status).json({ message: error instanceof Error ? error.message : 'Unable to create the policy version.' });
  }
});

app.post('/api/requests/:id/hard-disqualifier-evidence', requireAuth, requirePermission(Permissions.HARD_DISQUALIFIER_EVIDENCE), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories?.hardDisqualifiers) return res.status(503).json({ message: 'Hard-disqualifier evidence storage requires PostgreSQL.' });
  const justification = String(req.body?.justification || '').trim();
  if (justification.length < 10) return res.status(400).json({ message: 'Enter a clear justification for recording this authorized evidence.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id = $1', [req.params.id])).rows[0];
    if (!request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    const recorded = await storageFoundation.repositories.hardDisqualifiers.recordEvidence({
      requestId: request.id, actorId: req.auth.sub, justification,
      ruleCode: req.body?.ruleCode, evidenceType: req.body?.evidenceType,
      sourceAuthority: req.body?.sourceAuthority, sourceReference: req.body?.sourceReference,
      documentId: req.body?.documentId, findings: req.body?.findings,
    });
    return res.status(201).json(recorded);
  } catch (error) {
    const status = ['INVALID_RULE_CODE', 'UNAUTHORIZED_EVIDENCE_TYPE', 'EVIDENCE_DETAILS_REQUIRED', 'EVIDENCE_FINDINGS_REQUIRED', 'UNSUPPORTED_EVIDENCE_FINDING', 'INCIDENT_TYPE_REQUIRED', 'HELMET_STATUS_REQUIRED', 'IMPAIRMENT_STATUS_REQUIRED', 'OFFENSE_STATUS_REQUIRED', 'AUTHORIZED_DECISION_REQUIRED'].includes(error?.code) ? 400
      : error?.code === 'EVIDENCE_DOCUMENT_MISMATCH' ? 409 : 500;
    return res.status(status).json({ code: error?.code || 'EVIDENCE_RECORDING_FAILED', message: error instanceof Error ? error.message : 'Unable to record the authorized evidence.' });
  }
});

app.post('/api/requests/:id/hard-disqualifiers/evaluate', requireAuth, requirePermission(Permissions.HARD_DISQUALIFIER_EVALUATE), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories?.hardDisqualifiers) return res.status(503).json({ message: 'Hard-disqualifier evaluation requires PostgreSQL.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id = $1', [req.params.id])).rows[0];
    if (!request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    const result = await storageFoundation.repositories.hardDisqualifiers.evaluateRequest({
      requestId: request.id, actorId: req.auth.sub,
      justification: 'Authorized staff requested hard-disqualifier evaluation.',
    });
    return res.status(201).json(result);
  } catch (error) {
    return res.status(error?.code === 'REQUEST_NOT_FOUND' ? 404 : 500).json({ code: error?.code || 'EVALUATION_FAILED', message: error instanceof Error ? error.message : 'Unable to evaluate hard disqualifiers.' });
  }
});

app.get('/api/requests/:id/hard-disqualifiers', requireAuth, requirePermission(Permissions.REQUESTS_AUDIT), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories?.hardDisqualifiers) return res.status(503).json({ message: 'Hard-disqualifier history requires PostgreSQL.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id = $1', [req.params.id])).rows[0];
    if (!request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    return res.json(await storageFoundation.repositories.hardDisqualifiers.getRequestHistory({ requestId: request.id }));
  } catch {
    return res.status(500).json({ message: 'Unable to load hard-disqualifier history.' });
  }
});

app.post('/api/requests/:id/hard-disqualifiers/:evaluationId/exception', requireAuth, requirePermission(Permissions.HARD_DISQUALIFIER_EXCEPTION), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories?.hardDisqualifiers) return res.status(503).json({ message: 'Hard-disqualifier exceptions require PostgreSQL.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id = $1', [req.params.id])).rows[0];
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    const exception = await storageFoundation.repositories.hardDisqualifiers.recordException({
      requestId: request.id, evaluationId: req.params.evaluationId, actorId: req.auth.sub,
      evidenceAuthority: req.body?.evidenceAuthority, evidenceReference: req.body?.evidenceReference,
      evidenceDocumentId: req.body?.evidenceDocumentId, justification: req.body?.justification,
    });
    return res.status(201).json(exception);
  } catch (error) {
    const status = error?.code === 'EXCEPTION_PERMISSION_REQUIRED' ? 403
      : error?.code === 'EVALUATION_NOT_FOUND' ? 404
        : ['EXCEPTION_EVIDENCE_REQUIRED', 'EXCEPTION_NOT_ALLOWED', 'EXCEPTION_EXISTS', 'EVIDENCE_DOCUMENT_MISMATCH'].includes(error?.code) ? 409 : 500;
    return res.status(status).json({ code: error?.code || 'EXCEPTION_FAILED', message: error instanceof Error ? error.message : 'Unable to record the hard-disqualifier exception.' });
  }
});

app.put('/api/staff/:id/capabilities/hard-disqualifier-exception', requireAuth, requirePermission(Permissions.HARD_DISQUALIFIER_EXCEPTION_MANAGE), async (req, res) => {
  if (!storageFoundation.repositories?.hardDisqualifiers) return res.status(503).json({ message: 'Exception-authority management requires PostgreSQL.' });
  const active = req.body?.active;
  const justification = String(req.body?.justification || '').trim();
  if (typeof active !== 'boolean' || !justification) return res.status(400).json({ message: 'Active status and a capability-change justification are required.' });
  if (active && req.params.id === req.auth.sub) return res.status(409).json({ message: 'You cannot grant hard-disqualifier exception authority to yourself. Ask another authorized System Administrator.' });
  try {
    return res.json(await storageFoundation.repositories.hardDisqualifiers.setExceptionCapability({
      staffId: req.params.id, actorId: req.auth.sub, active, justification,
    }));
  } catch (error) {
    const status = error?.code === 'INVALID_EXCEPTION_CAPABILITY_TARGET' ? 409 : 500;
    return res.status(status).json({ code: error?.code || 'CAPABILITY_CHANGE_FAILED', message: error instanceof Error ? error.message : 'Unable to change exception authority.' });
  }
});

app.post('/api/requests/:id/coverage-inputs', requireAuth, requirePermission(Permissions.REQUESTS_PROCESS), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories?.coverage) return res.status(503).json({ message: 'Coverage input storage requires PostgreSQL.' });
  const justification = String(req.body?.justification || '').trim();
  const verificationSource = String(req.body?.verificationSource || 'staff').trim();
  if (justification.length < 10) return res.status(400).json({ message: 'Enter a clear justification for the verified coverage inputs.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id = $1', [req.params.id])).rows[0];
    if (!request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    const recorded = await storageFoundation.repositories.coverage.recordVerifiedInput({ requestId: request.id, actorId: req.auth.sub, verificationSource, justification, inputData: req.body?.inputData });
    return res.status(201).json(recorded);
  } catch (error) {
    const status = ['COVERAGE_VERIFICATION_REQUIRED', 'COVERAGE_INPUT_REQUIRED'].includes(error?.code) ? 400 : error?.code === 'REQUEST_NOT_FOUND' ? 404 : 500;
    return res.status(status).json({ code: error?.code || 'COVERAGE_INPUT_FAILED', message: error instanceof Error ? error.message : 'Unable to record coverage inputs.' });
  }
});

app.post('/api/requests/:id/coverage-calculation', requireAuth, requirePermission(Permissions.POLICY_EVALUATE), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories?.coverage) return res.status(503).json({ message: 'Coverage calculation requires PostgreSQL.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id = $1', [req.params.id])).rows[0];
    if (!request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    const result = await storageFoundation.repositories.coverage.calculateRequest({ requestId: request.id, actorId: req.auth.sub, justification: 'Authorized staff requested a reproducible coverage calculation.' });
    return res.status(201).json(result);
  } catch (error) {
    const status = error?.code === 'REQUEST_NOT_FOUND' ? 404 : ['COVERAGE_INPUT_REQUIRED', 'COVERAGE_POLICY_NOT_FOUND', 'INVALID_COVERAGE_INPUT'].includes(error?.code) ? 409 : 500;
    return res.status(status).json({ code: error?.code || 'COVERAGE_CALCULATION_FAILED', message: error instanceof Error ? error.message : 'Unable to calculate coverage.' });
  }
});

app.get('/api/requests/:id/coverage-history', requireAuth, requirePermission(Permissions.REQUESTS_AUDIT), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories?.coverage) return res.status(503).json({ message: 'Coverage history requires PostgreSQL.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id = $1', [req.params.id])).rows[0];
    if (!request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    return res.json(await storageFoundation.repositories.coverage.getRequestHistory({ requestId: request.id }));
  } catch { return res.status(500).json({ message: 'Unable to load coverage calculation history.' }); }
});

app.post('/api/requests/:id/policy-evaluation', requireAuth, requirePermission(Permissions.POLICY_EVALUATE), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories) return res.status(503).json({ message: 'Policy evaluation is unavailable until PostgreSQL is configured.' });
  const policyKey = String(req.body?.policyKey || 'assistance_workflow').trim();
  if (!/^[a-z0-9_.:-]{2,80}$/i.test(policyKey)) return res.status(400).json({ message: 'Provide a valid policy key.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id = $1', [req.params.id])).rows[0];
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    if (!requestIsPermittedForStaff(request, req.auth)) return res.status(403).json({ message: 'You do not have permission to evaluate this request.' });
    const policy = request.policy_version_id
      ? await storageFoundation.repositories.policies.getPolicyVersion({ id: request.policy_version_id })
      : await storageFoundation.repositories.policies.getEffectivePolicy({ policyKey, assistanceType: request.assistance_type, at: new Date() });
    const evaluation = await evaluatePolicyOnBackend({ request, policy });
    const recorded = await storageFoundation.repositories.policies.recordPolicyEvaluation({
      requestId: request.id,
      originatingOfficeId: request.originating_office_id,
      actorId: req.auth.sub,
      justification: 'Authorized staff requested backend policy evaluation.',
      ...evaluation,
    });
    return res.status(201).json({ ...evaluation, evaluationId: recorded.id });
  } catch (error) {
    return res.status(500).json({ message: error instanceof Error ? error.message : 'Unable to evaluate the request policy.' });
  }
});

app.post('/api/requests/:id/policy-re-evaluation', requireAuth, requirePermission(Permissions.POLICY_CONFIGURE), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories) return res.status(503).json({ message: 'Policy re-evaluation is unavailable until PostgreSQL is configured.' });
  const policyKey = String(req.body?.policyKey || 'assistance_workflow').trim();
  const justification = String(req.body?.justification || '').trim();
  if (req.body?.confirmed !== true) return res.status(400).json({ message: 'Confirm the authorized policy re-evaluation.' });
  if (justification.length < 10) return res.status(400).json({ message: 'Enter a re-evaluation justification of at least 10 characters.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id = $1', [req.params.id])).rows[0];
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    const policy = await storageFoundation.repositories.policies.getEffectivePolicy({ policyKey, assistanceType: request.assistance_type, at: new Date() });
    const evaluation = await evaluatePolicyOnBackend({ request, policy });
    const recorded = await storageFoundation.repositories.policies.recordPolicyEvaluation({
      requestId: request.id, originatingOfficeId: request.originating_office_id,
      actorId: req.auth.sub, justification, authorizedReEvaluation: true, ...evaluation,
    });
    return res.status(201).json({ ...evaluation, evaluationId: recorded.id, authorizedReEvaluation: true });
  } catch (error) {
    const status = error?.code === 'REQUEST_NOT_FOUND' ? 404 : 500;
    return res.status(status).json({ code: error?.code || 'POLICY_REEVALUATION_FAILED', message: error instanceof Error ? error.message : 'Unable to create the policy re-evaluation.' });
  }
});

app.get('/api/requests/:id/policy-evaluations', requireAuth, requirePermission('requests:audit'), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories) return res.status(503).json({ message: 'Policy history is unavailable until PostgreSQL is configured.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id = $1', [req.params.id])).rows[0];
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    if (!requestIsPermittedForStaff(request, req.auth)) return res.status(403).json({ message: 'You do not have permission to view this request history.' });
    return res.json(await storageFoundation.repositories.policies.getRequestPolicyHistory({ requestId: request.id }));
  } catch {
    return res.status(500).json({ message: 'Unable to load policy evaluation history.' });
  }
});

app.post('/api/requests/:id/workflow-evaluation', requireAuth, requirePermission(Permissions.POLICY_EVALUATE), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories?.workflow) return res.status(503).json({ message: 'Staff policy evaluation requires PostgreSQL.' });
  const remarks = String(req.body?.remarks || '').trim();
  if (remarks.length < 10) return res.status(400).json({ code: 'EVALUATION_REMARKS_REQUIRED', message: 'Enter evaluation remarks of at least 10 characters.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id=$1', [req.params.id])).rows[0];
    if (!request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    if (!['pending', 'under_review'].includes(request.status)) return res.status(409).json({ message: 'Policy evaluation is available only while a request is pending or under review.' });
    return res.status(201).json(await storageFoundation.repositories.workflow.evaluateRequest({ requestId: request.id, actorId: req.auth.sub, remarks }));
  } catch (error) {
    const status = error?.code === 'REQUEST_NOT_FOUND' ? 404 : error?.code === 'EVALUATION_REMARKS_REQUIRED' ? 400 : 500;
    return res.status(status).json({ code: error?.code || 'WORKFLOW_EVALUATION_FAILED', message: error instanceof Error ? error.message : 'Unable to evaluate the request.' });
  }
});

app.post('/api/requests/:id/workflow-evaluations/:evaluationId/confirm', requireAuth, requirePermission(Permissions.REQUESTS_PROCESS), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories?.workflow) return res.status(503).json({ message: 'Coverage confirmation requires PostgreSQL.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id=$1', [req.params.id])).rows[0];
    if (!request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    if (request.status !== 'under_review') return res.status(409).json({ message: 'Move the request under review before confirming evidence and coverage.' });
    const confirmation = await storageFoundation.repositories.workflow.confirmEvaluation({ requestId: request.id, evaluationId: req.params.evaluationId, actorId: req.auth.sub, evidenceReviewed: req.body?.evidenceReviewed, coverageConfirmed: req.body?.coverageConfirmed, remarks: req.body?.remarks });
    return res.status(201).json(confirmation);
  } catch (error) {
    const status = error?.code === 'EVALUATION_NOT_FOUND' ? 404 : ['CONFIRMATION_DETAILS_REQUIRED', 'EVALUATION_NOT_READY'].includes(error?.code) ? 409 : 500;
    return res.status(status).json({ code: error?.code || 'WORKFLOW_CONFIRMATION_FAILED', message: error instanceof Error ? error.message : 'Unable to confirm evidence and coverage.' });
  }
});

app.get('/api/requests/:id/workflow-evaluations', requireAuth, requirePermission(Permissions.REQUESTS_AUDIT), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories?.workflow) return res.status(503).json({ message: 'Workflow evaluation history requires PostgreSQL.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id=$1', [req.params.id])).rows[0];
    if (!request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    return res.json(await storageFoundation.repositories.workflow.getRequestHistory({ requestId: request.id }));
  } catch { return res.status(500).json({ message: 'Unable to load workflow evaluation history.' }); }
});

app.get('/api/policy-gates/evaluations', requireAuth, requirePermission(Permissions.POLICY_OVERRIDE), async (req, res) => {
  if (!storageFoundation.database) return res.status(503).json({ message: 'Policy-gate history is unavailable until PostgreSQL is configured.' });
  const requestedOutcome = String(req.query.outcome || 'blocked');
  if (!['blocked', 'correction_required', 'human_review_required', 'passed'].includes(requestedOutcome)) {
    return res.status(400).json({ message: 'Select a valid policy-gate outcome.' });
  }
  try {
    const result = await storageFoundation.database.query(`
      SELECT e.*, o.name AS originating_office_name,
             EXISTS (SELECT 1 FROM submission_policy_gate_overrides x WHERE x.evaluation_id = e.id) AS overridden
      FROM submission_policy_gate_evaluations e
      LEFT JOIN offices o ON o.id = e.originating_office_id
      WHERE e.outcome = $1 ORDER BY e.evaluated_at DESC LIMIT 100
    `, [requestedOutcome]);
    const officeIds = Array.isArray(req.auth.officeIds) ? req.auth.officeIds : [];
    return res.json(result.rows.filter((item) => !item.originating_office_id || !officeIds.length || officeIds.includes(item.originating_office_id)));
  } catch {
    return res.status(500).json({ message: 'Unable to load policy-gate evaluations.' });
  }
});

app.post('/api/policy-gates/:id/residency-override', requireAuth, requirePermission(Permissions.POLICY_OVERRIDE), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories) return res.status(503).json({ message: 'Residency override is unavailable until PostgreSQL is configured.' });
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ message: 'Enter the reason for overriding the residency finding.' });
  try {
    const evaluation = (await storageFoundation.database.query(
      'SELECT id, originating_office_id FROM submission_policy_gate_evaluations WHERE id = $1',
      [req.params.id],
    )).rows[0];
    if (!evaluation) return res.status(404).json({ message: 'Policy-gate evaluation not found.' });
    const officeIds = Array.isArray(req.auth.officeIds) ? req.auth.officeIds : [];
    if (evaluation.originating_office_id && officeIds.length && !officeIds.includes(evaluation.originating_office_id)) {
      return res.status(403).json({ message: 'You are not assigned to the originating district office.' });
    }
    const override = await storageFoundation.repositories.aidLink.overrideSubmissionPolicyGate({
      evaluationId: evaluation.id,
      actorId: req.auth.sub,
      reason,
    });
    return res.status(201).json({
      id: override.id,
      evaluationId: override.evaluation_id,
      reason: override.reason,
      createdAt: override.created_at,
      message: 'Residency override recorded. The applicant may retry the same submission.',
    });
  } catch (error) {
    const status = ['OVERRIDE_NOT_ALLOWED', 'OFFICE_REQUIRED'].includes(error?.code) ? 409
      : error?.code === 'OVERRIDE_EXISTS' ? 409 : 500;
    return res.status(status).json({ message: error instanceof Error ? error.message : 'Unable to record the residency override.' });
  }
});

app.get('/api/offices', requireAuth, requirePermission('requests:view'), async (_req, res) => {
  if (!storageFoundation.database) return res.status(503).json({ message: 'Office configuration is unavailable until PostgreSQL is configured.' });
  try {
    const result = await storageFoundation.database.query(`
      SELECT id, office_code, name, office_type, district_code, active,
             residency_boundary, boundary_version, metadata, created_at, updated_at
      FROM offices ORDER BY name
    `);
    return res.json(result.rows);
  } catch {
    return res.status(500).json({ message: 'Unable to load district offices.' });
  }
});

app.put('/api/offices/:id', requireAuth, requirePermission(Permissions.OFFICES_MANAGE), async (req, res) => {
  if (!storageFoundation.database) return res.status(503).json({ message: 'Office configuration is unavailable until PostgreSQL is configured.' });
  const officeCode = String(req.body?.officeCode || '').trim();
  const name = String(req.body?.name || '').trim();
  const officeType = String(req.body?.officeType || 'district_satellite').trim();
  const districtCode = String(req.body?.districtCode || '').trim() || null;
  const active = req.body?.active !== false;
  const boundary = req.body?.residencyBoundary;
  const justification = String(req.body?.justification || '').trim();
  const effectiveFrom = req.body?.effectiveFrom ? new Date(String(req.body.effectiveFrom)) : null;
  if (!officeCode || !name || !['central', 'district_satellite'].includes(officeType)) {
    return res.status(400).json({ message: 'Office code, name, and a valid office type are required.' });
  }
  if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary) || (officeType === 'district_satellite' && !Object.keys(boundary).length)) {
    return res.status(400).json({ message: 'Configure a residency boundary for each district satellite office.' });
  }
  if (justification.length < 10) return res.status(400).json({ message: 'Enter a residency policy justification of at least 10 characters.' });
  if (!effectiveFrom || Number.isNaN(effectiveFrom.getTime())) return res.status(400).json({ message: 'Provide the residency boundary effective date.' });
  if (req.body?.confirmed !== true) return res.status(400).json({ message: 'Confirm that this residency boundary version is ready to publish.' });
  try {
    const office = await storageFoundation.database.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`office-boundary:${req.params.id}`]);
      const previous = (await client.query('SELECT * FROM offices WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0] || null;
      const boundaryVersion = Number((await client.query('SELECT COALESCE(max(version),0)+1 AS next_version FROM office_boundary_versions WHERE office_id=$1', [req.params.id])).rows[0].next_version);
      const result = await client.query(`
        INSERT INTO offices (id, office_code, name, office_type, district_code, active, residency_boundary, boundary_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (id) DO UPDATE SET office_code = EXCLUDED.office_code, name = EXCLUDED.name,
          office_type = EXCLUDED.office_type, district_code = EXCLUDED.district_code,
          active = EXCLUDED.active, residency_boundary = EXCLUDED.residency_boundary,
          boundary_version = EXCLUDED.boundary_version, updated_at = now()
        RETURNING *
      `, [req.params.id, officeCode, name, officeType, districtCode, active, boundary, boundaryVersion]);
      const versionId = `office-boundary-${crypto.randomUUID()}`;
      const versionName = `residency:${officeCode}:v${boundaryVersion}`;
      await client.query(`INSERT INTO office_boundary_versions (id,office_id,version,boundary_version,effective_from,effective_until,boundary,actor_id,old_value,new_value,justification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$7,$10)`, [versionId, req.params.id, boundaryVersion, versionName, effectiveFrom, req.body?.effectiveUntil || null, boundary, req.auth.sub, previous?.residency_boundary || null, justification]);
      await client.query(`
        INSERT INTO audit_logs (
          id, actor_id, actor_type, action_type, affected_record_type,
          affected_record_id, old_value, new_value, justification
        ) VALUES ($1,$2,'staff',$3,'office',$4,$5,$6,$7)
      `, [`audit-${crypto.randomUUID()}`, req.auth.sub,
        'residency_policy_version_published', versionId,
        previous?.residency_boundary || null, { boundaryVersion: versionName, officeId: req.params.id, effectiveFrom, boundary }, justification]);
      return { ...result.rows[0], publishedBoundaryVersion: versionName, effectiveFrom };
    }, { isolationLevel: 'SERIALIZABLE' });
    return res.json(office);
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ message: 'That office code is already in use.' });
    return res.status(500).json({ message: 'Unable to save the district office configuration.' });
  }
});

app.put('/api/applicants/:id/originating-office', requireAuth, requirePermission(Permissions.OFFICES_MANAGE), async (req, res) => {
  if (!storageFoundation.database) return res.status(503).json({ message: 'Office assignment is unavailable until PostgreSQL is configured.' });
  const officeId = String(req.body?.officeId || '').trim();
  const justification = String(req.body?.justification || '').trim();
  if (!officeId || !justification) return res.status(400).json({ message: 'Select a district office and enter an assignment reason.' });
  try {
    const updated = await applicationDataStore.transaction(async (data, client) => {
      const applicant = data.applicants.find((item) => item.id === req.params.id);
      if (!applicant) throw Object.assign(new Error('Applicant account not found.'), { code: 'APPLICANT_NOT_FOUND' });
      const office = (await client.query(`SELECT * FROM offices WHERE id = $1 AND office_type = 'district_satellite' AND active = true`, [officeId])).rows[0];
      if (!office) throw Object.assign(new Error('Select an active district satellite office.'), { code: 'OFFICE_NOT_FOUND' });
      const previousOfficeId = applicant.originatingOfficeId || null;
      applicant.originatingOfficeId = officeId;
      await client.query('UPDATE applicants SET originating_office_id = $2, updated_at = now() WHERE id = $1', [applicant.id, officeId]);
      await client.query(`
        INSERT INTO audit_logs (
          id, actor_id, actor_type, action_type, affected_record_type,
          affected_record_id, old_value, new_value, justification
        ) VALUES ($1,$2,'staff','applicant_originating_office_assigned','applicant',$3,$4,$5,$6)
      `, [`audit-${crypto.randomUUID()}`, req.auth.sub, applicant.id,
        { originatingOfficeId: previousOfficeId }, { originatingOfficeId: officeId }, justification]);
      addActivity(data, {
        action: 'applicant_originating_office_assigned', actor: req.authUser,
        affectedRecord: { type: 'applicant', id: applicant.id, label: applicant.fullName },
        details: { previousOfficeId, originatingOfficeId: officeId, justification },
      });
      return { applicantId: applicant.id, originatingOfficeId: officeId, officeName: office.name };
    });
    return res.json(updated);
  } catch (error) {
    if (error?.code === 'APPLICANT_NOT_FOUND') return res.status(404).json({ message: error.message });
    if (error?.code === 'OFFICE_NOT_FOUND') return res.status(400).json({ message: error.message });
    return res.status(500).json({ message: 'Unable to assign the originating district office.' });
  }
});

app.get('/api/facility-directory/effective', requireAuth, requirePermission(Permissions.FACILITY_DIRECTORY_VIEW), async (req, res) => {
  if (!storageFoundation.repositories) return res.status(503).json({ message: 'Facility directory is unavailable until PostgreSQL is configured.' });
  const at = req.query.at ? new Date(String(req.query.at)) : new Date();
  if (Number.isNaN(at.getTime())) return res.status(400).json({ message: 'Provide a valid directory date.' });
  try {
    const directory = await storageFoundation.repositories.facilities.getEffectiveDirectory({ at });
    if (!directory) return res.status(404).json({ message: 'No effective facility directory was found.' });
    return res.json({
      id: directory.id,
      version: directory.version,
      directoryVersion: directory.directory_version,
      effectiveFrom: directory.effective_from,
      effectiveUntil: directory.effective_until,
      directory: directory.directory,
      authoritativeSource: directory.authoritative_source,
      justification: directory.justification,
    });
  } catch {
    return res.status(500).json({ message: 'Unable to load the facility directory.' });
  }
});

app.post('/api/facility-directory/versions', requireAuth, requirePermission(Permissions.FACILITY_DIRECTORY_MANAGE), async (req, res) => {
  if (!storageFoundation.repositories) return res.status(503).json({ message: 'Facility directory is unavailable until PostgreSQL is configured.' });
  const directory = req.body?.directory;
  const authoritativeSource = String(req.body?.authoritativeSource || '').trim();
  const justification = String(req.body?.justification || '').trim();
  const effectiveFrom = req.body?.effectiveFrom ? new Date(String(req.body.effectiveFrom)) : null;
  if (!directory || typeof directory !== 'object' || Array.isArray(directory)) return res.status(400).json({ message: 'Provide the complete facility directory.' });
  if (!authoritativeSource || justification.length < 10) return res.status(400).json({ message: 'Authoritative source and a justification of at least 10 characters are required.' });
  if (!effectiveFrom || Number.isNaN(effectiveFrom.getTime())) return res.status(400).json({ message: 'Provide the directory effective date.' });
  if (req.body?.confirmed !== true) return res.status(400).json({ message: 'Confirm that this facility directory is ready to publish.' });
  try {
    const created = await storageFoundation.repositories.facilities.createDirectoryVersion({
      directory, authoritativeSource, justification, effectiveFrom,
      effectiveUntil: req.body?.effectiveUntil || null, actorId: req.auth.sub,
    });
    return res.status(201).json({
      id: created.id, version: created.version, directoryVersion: created.directory_version,
      effectiveFrom: created.effective_from, directory: created.directory,
    });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Unable to create the facility directory version.' });
  }
});

app.post('/api/requests/:id/facility-resolution', requireAuth, requirePermission('requests:process'), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories) return res.status(503).json({ message: 'Facility resolution is unavailable until PostgreSQL is configured.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id = $1', [req.params.id])).rows[0];
    if (!request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    const result = await storageFoundation.repositories.facilities.resolveRequestFacility({
      requestId: request.id, actorId: req.auth.sub, actorType: 'staff',
      justification: 'Case Worker requested facility evidence resolution.',
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error instanceof Error ? error.message : 'Unable to resolve the facility evidence.' });
  }
});

app.get('/api/requests/:id/facility-routing', requireAuth, requirePermission('requests:view'), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories) return res.status(503).json({ message: 'Facility routing is unavailable until PostgreSQL is configured.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id = $1', [req.params.id])).rows[0];
    if (!request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    return res.json(await storageFoundation.repositories.facilities.getRequestRoutingStatus({ requestId: request.id }));
  } catch {
    return res.status(500).json({ message: 'Unable to load facility routing status.' });
  }
});

app.post('/api/requests/:id/cho-prescription-validation', requireAuth, requirePermission(Permissions.CHO_PRESCRIPTION_VALIDATE), async (req, res) => {
  if (!storageFoundation.database || !storageFoundation.repositories) return res.status(503).json({ message: 'CHO validation is unavailable until PostgreSQL is configured.' });
  const status = String(req.body?.status || '').trim();
  const reason = String(req.body?.reason || '').trim();
  if (!['approved', 'rejected'].includes(status) || !reason) return res.status(400).json({ message: 'Choose approved or rejected and enter the CHO decision reason.' });
  try {
    const request = (await storageFoundation.database.query('SELECT * FROM requests WHERE id = $1', [req.params.id])).rows[0];
    if (!request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'Request not found.' });
    return res.json(await storageFoundation.repositories.facilities.recordChoPrescriptionDecision({
      requestId: request.id, actorId: req.auth.sub, status, reason,
    }));
  } catch (error) {
    const statusCode = error?.code === 'CHO_PERMISSION_REQUIRED' ? 403
      : ['CHO_NOT_REQUIRED', 'PRESCRIPTION_NOT_FOUND'].includes(error?.code) ? 409 : 500;
    return res.status(statusCode).json({ message: error instanceof Error ? error.message : 'Unable to record the CHO decision.' });
  }
});

app.put('/api/staff/:id/capabilities/cho-prescription-validation', requireAuth, requirePermission(Permissions.CHO_CAPABILITY_MANAGE), async (req, res) => {
  if (!storageFoundation.repositories) return res.status(503).json({ message: 'CHO capability management is unavailable until PostgreSQL is configured.' });
  const active = req.body?.active;
  const justification = String(req.body?.justification || '').trim();
  if (typeof active !== 'boolean' || !justification) return res.status(400).json({ message: 'Active status and a capability-change justification are required.' });
  try {
    return res.json(await storageFoundation.repositories.facilities.setChoValidatorCapability({
      staffId: req.params.id, actorId: req.auth.sub, active, justification,
    }));
  } catch (error) {
    const statusCode = error?.code === 'STAFF_NOT_FOUND' ? 404 : 500;
    return res.status(statusCode).json({ message: error instanceof Error ? error.message : 'Unable to change CHO validation access.' });
  }
});

app.get('/api/system/configuration', requireAuth, requirePermission('configuration:manage'), async (_req, res) => {
  try {
    const data = await loadData();
    return res.json({
      assistanceTypes: assistanceTypes.map((type) => ({
        name: type,
        active: data.assistanceTypeSettings[type]?.active !== false,
        requiredDocuments: data.requiredDocuments[type] || [],
      })),
      systemSettings: data.systemSettings,
    });
  } catch {
    return res.status(500).json({ message: 'Unable to load system configuration.' });
  }
});

app.put('/api/assistance-types/:type/status', requireAuth, requirePermission('configuration:manage'), async (req, res) => {
  const type = String(req.params.type);
  if (!assistanceTypes.includes(type) || typeof req.body?.active !== 'boolean') {
    return res.status(400).json({ message: 'A valid assistance type and active status are required.' });
  }
  try {
    const data = await loadData();
    const previousActive = data.assistanceTypeSettings[type]?.active !== false;
    data.assistanceTypeSettings[type] = { active: req.body.active };
    addActivity(data, { action: req.body.active ? 'assistance_type_activated' : 'assistance_type_deactivated', actor: req.authUser, affectedRecord: { type: 'assistance_type', id: type, label: type }, details: { previousActive, active: req.body.active }, legacy: { assistanceType: type } });
    await saveData(data);
    return res.json({ name: type, active: req.body.active, requiredDocuments: data.requiredDocuments[type] || [] });
  } catch {
    return res.status(500).json({ message: 'Unable to update the assistance type.' });
  }
});

app.get('/api/system/settings', requireAuth, requirePermission('system:manage'), async (_req, res) => {
  try {
    return res.json((await loadData()).systemSettings);
  } catch {
    return res.status(500).json({ message: 'Unable to load system settings.' });
  }
});

app.put('/api/system/settings', requireAuth, requirePermission('system:manage'), async (req, res) => {
  try {
    const data = await loadData();
    const organizationName = String(req.body?.organizationName ?? data.systemSettings.organizationName).trim();
    const notificationPollingSeconds = Number(req.body?.notificationPollingSeconds ?? data.systemSettings.notificationPollingSeconds);
    const receiptValidityDays = Number(req.body?.receiptValidityDays ?? data.systemSettings.receiptValidityDays);
    const defaultClaimingTime = String(req.body?.defaultClaimingTime ?? data.systemSettings.defaultClaimingTime).trim();
    const defaultClaimingLocation = String(req.body?.defaultClaimingLocation ?? data.systemSettings.defaultClaimingLocation).trim();
    const smsHelpChannel = String(req.body?.smsHelpChannel ?? data.systemSettings.smsHelpChannel).trim();
    if (!organizationName || !Number.isInteger(notificationPollingSeconds) || notificationPollingSeconds < 10 || notificationPollingSeconds > 3600 || !Number.isInteger(receiptValidityDays) || receiptValidityDays < 1 || receiptValidityDays > 730 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(defaultClaimingTime) || !defaultClaimingLocation || defaultClaimingLocation.length > 200 || !smsHelpChannel || smsHelpChannel.length > 160) {
      return res.status(400).json({ message: 'Provide a valid organization name, polling interval, receipt-validity period, default claiming time/location, and SMS help channel.' });
    }
    const previousSettings = { ...data.systemSettings };
    data.systemSettings = { organizationName, notificationPollingSeconds, receiptValidityDays, defaultClaimingTime, defaultClaimingLocation, smsHelpChannel };
    addActivity(data, { action: 'system_settings_updated', actor: req.authUser, affectedRecord: { type: 'system_settings', id: 'system-settings', label: 'System settings' }, details: { previous: previousSettings, current: { ...data.systemSettings } } });
    await saveData(data);
    return res.json(data.systemSettings);
  } catch {
    return res.status(500).json({ message: 'Unable to update system settings.' });
  }
});

app.get('/api/system/sms-provider', requireAuth, requirePermission('system:manage'), (_req, res) => {
  return res.json(getSmsProviderMetadata());
});

app.get('/api/system/document-analyzer', requireAuth, requirePermission('system:manage'), (_req, res) => {
  return res.json({
    ...getDocumentAnalyzerMetadata(),
    policy: {
      lowConfidenceOutcome: 'case_worker_review_required',
      authenticityDecision: 'never_automated',
      eligibilityDecision: 'never_automated',
      inputRetention: 'in_memory_only_during_analysis',
    },
  });
});

app.get('/api/sms-notifications', requireAuth, requirePermission('sms:manage'), async (req, res) => {
  try {
    const data = await loadData();
    const permittedRequestIds = new Set(data.requests.filter((request) => requestIsPermittedForStaff(request, req.auth)).map((request) => request.id));
    return res.json(data.smsNotifications
      .filter((sms) => hasPermission(req.auth.role, 'system:manage') || permittedRequestIds.has(sms.requestId))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  } catch {
    return res.status(500).json({ message: 'Unable to load SMS notification status.' });
  }
});

app.post('/api/sms-notifications/retry-due', requireAuth, requirePermission('sms:manage'), async (req, res) => {
  try {
    const data = await loadData();
    const actor = data.authUsers.find((item) => item.id === req.auth.sub);
    const now = new Date();
    const permittedRequestIds = new Set(data.requests.filter((request) => requestIsPermittedForStaff(request, req.auth)).map((request) => request.id));
    const due = data.smsNotifications.filter((sms) =>
      (hasPermission(req.auth.role, 'system:manage') || permittedRequestIds.has(sms.requestId))
      && ['queued', 'retry_scheduled', 'pending_configuration'].includes(sms.status)
      && (!sms.nextAttemptAt || new Date(sms.nextAttemptAt) <= now));
    for (const sms of due) {
      await attemptSmsDelivery(sms, { now });
      const request = data.requests.find((item) => item.id === sms.requestId);
      if (request) syncRequestSmsSummary(request, sms);
      addSmsActivity(data, sms, actor);
    }
    await saveData(data);
    return res.json({ processed: due.length, notifications: due });
  } catch {
    return res.status(500).json({ message: 'Unable to retry due SMS notifications.' });
  }
});

app.post('/api/sms-notifications/:id/retry', requireAuth, requirePermission('sms:manage'), async (req, res) => {
  try {
    const data = await loadData();
    const actor = data.authUsers.find((item) => item.id === req.auth.sub);
    const sms = data.smsNotifications.find((item) => item.id === req.params.id);
    const request = sms ? data.requests.find((item) => item.id === sms.requestId) : null;
    if (!sms || !request || !requestIsPermittedForStaff(request, req.auth)) return res.status(404).json({ message: 'SMS notification not found.' });
    if (sms.status === 'delivered') return res.status(400).json({ message: 'A delivered SMS does not need to be retried.' });
    if (sms.status === 'failed') {
      if (sms.attemptCount >= sms.maxAttempts) sms.maxAttempts += 1;
      sms.status = 'retry_scheduled';
    }
    await attemptSmsDelivery(sms, { force: true });
    syncRequestSmsSummary(request, sms);
    addSmsActivity(data, sms, actor, 'sms_delivery_retried');
    await saveData(data);
    return res.json(sms);
  } catch {
    return res.status(500).json({ message: 'Unable to retry SMS delivery.' });
  }
});

app.post('/api/internal/sms-delivery-status', async (req, res) => {
  if (!smsStatusSecret || String(req.get('x-aidlink-sms-status-secret') || '') !== smsStatusSecret) {
    return res.status(401).json({ message: 'Invalid SMS delivery-status credentials.' });
  }
  const providerMessageId = String(req.body?.providerMessageId || '').trim();
  const status = String(req.body?.status || '').trim().toLowerCase();
  if (!providerMessageId || !['delivered', 'failed'].includes(status)) {
    return res.status(400).json({ message: 'Provider message ID and delivered or failed status are required.' });
  }
  try {
    const data = await loadData();
    const sms = data.smsNotifications.find((item) => item.providerMessageId === providerMessageId);
    if (!sms || !applySmsDeliveryReceipt(sms, { providerMessageId, status, error: req.body?.error })) {
      return res.status(404).json({ message: 'SMS notification not found.' });
    }
    const request = data.requests.find((item) => item.id === sms.requestId);
    if (request) syncRequestSmsSummary(request, sms);
    addSmsActivity(data, sms, { id: null, fullName: `SMS provider: ${sms.provider}`, role: 'System' }, 'sms_delivery_receipt_received');
    await saveData(data);
    return res.json({ id: sms.id, status: sms.status, deliveredAt: sms.deliveredAt });
  } catch {
    return res.status(500).json({ message: 'Unable to record SMS delivery status.' });
  }
});

app.get('/api/system/runtime-settings', requireAuth, requirePermission('staff:identity'), async (_req, res) => {
  try {
    const { organizationName, notificationPollingSeconds } = (await loadData()).systemSettings;
    return res.json({ organizationName, notificationPollingSeconds });
  } catch {
    return res.status(500).json({ message: 'Unable to load runtime settings.' });
  }
});

app.get('/api/notifications', requireAuth, requirePermission('staff-notifications:view'), async (req, res) => {
  try {
    const data = await loadData();
    const permittedRequestIds = new Set(data.requests.filter((request) => requestIsPermittedForStaff(request, req.auth)).map((request) => request.id));
    const items = data.notifications
      .filter((item) => item.audience === 'admin')
      .filter((item) => hasPermission(req.auth.role, 'system:manage') || !item.requestId || permittedRequestIds.has(item.requestId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return res.json(items);
  } catch { return res.status(500).json({ message: 'Unable to load notifications.' }); }
});

app.put('/api/notifications/:id/read', requireAuth, requirePermission('staff-notifications:view'), async (req, res) => {
  try {
    const data = await loadData();
    const permittedRequestIds = new Set(data.requests.filter((request) => requestIsPermittedForStaff(request, req.auth)).map((request) => request.id));
    const item = data.notifications.find((notification) =>
      notification.id === req.params.id
      && notification.audience === 'admin'
      && (hasPermission(req.auth.role, 'system:manage') || !notification.requestId || permittedRequestIds.has(notification.requestId)));
    if (!item) return res.status(404).json({ message: 'Notification not found.' });
    item.read = true;
    await saveData(data);
    return res.json(item);
  } catch { return res.status(500).json({ message: 'Unable to update notification.' }); }
});

app.get('/api/qr/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!isQrVerificationToken(token)) return res.status(404).json({ valid: false, message: 'Approved request not found.' });
    const request = (await loadData()).requests.find((item) => item.qrCode?.value === token && isApproved(item) && (!item.protectedLetter || item.protectedLetter.status === 'approved'));
    if (!request) return res.status(404).json({ valid: false, message: 'Approved request not found.' });
    return res.json({ valid: true, requestId: request.requestId, applicantName: request.applicantName, assistanceType: request.assistanceType });
  } catch { return res.status(500).json({ valid: false, message: 'Unable to verify QR code.' }); }
});

function identityProofActivity(data, applicant, actor, action, details = {}) {
  return addActivity(data, {
    action,
    actor,
    affectedRecord: { type: 'applicant_identity_proof', id: applicant?.id || 'unknown', label: applicant?.email || 'Unknown applicant identity proof' },
    details,
    legacy: { applicantId: applicant?.id || null, applicantEmail: applicant?.email || null },
  });
}

function identityProofFileName(document) {
  try {
    const pathname = new URL(String(document?.url || ''), 'http://localhost').pathname;
    if (!pathname.startsWith('/uploads/')) return null;
    const fileName = decodeURIComponent(pathname.slice('/uploads/'.length));
    return fileName === path.basename(fileName) && /^[A-Za-z0-9._-]{1,200}$/.test(fileName) ? fileName : null;
  } catch { return null; }
}

app.get('/api/applicant-verifications/:id/document', requireAuth, async (req, res) => {
  try {
    const data = await loadData();
    const applicant = data.applicants.find((item) => item.id === req.params.id);
    const actor = data.authUsers.find((item) => item.id === req.auth.sub) || req.authUser;
    if (!hasPermission(req.auth.role, 'identity:approve')) {
      identityProofActivity(data, applicant, actor, 'applicant_id_document_access_failed', { reason: 'unauthorized', statusCode: 403 });
      await saveData(data);
      return res.status(403).json({ code: 'IDENTITY_PROOF_UNAUTHORIZED', message: 'Only an authorized System Administrator can open applicant identity proof.' });
    }
    if (!applicant?.identityVerification?.document) {
      identityProofActivity(data, applicant, actor, 'applicant_id_document_access_failed', { reason: 'missing_record', statusCode: 404 });
      await saveData(data);
      return res.status(404).json({ code: 'IDENTITY_PROOF_MISSING', message: 'No identity-proof file is recorded for this applicant.' });
    }
    const document = applicant.identityVerification.document;
    const fileName = identityProofFileName(document);
    if (!fileName) {
      identityProofActivity(data, applicant, actor, 'applicant_id_document_access_failed', { reason: 'unavailable_location', statusCode: 503, documentId: document.id });
      await saveData(data);
      return res.status(503).json({ code: 'IDENTITY_PROOF_UNAVAILABLE', message: 'The identity proof is stored in an unavailable or unsupported location. Ask a System Administrator to restore or replace the file.' });
    }
    const resolved = path.resolve(uploadsPath, fileName);
    const relative = path.relative(uploadsPath, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      identityProofActivity(data, applicant, actor, 'applicant_id_document_access_failed', { reason: 'unsafe_path', statusCode: 503, documentId: document.id });
      await saveData(data);
      return res.status(503).json({ code: 'IDENTITY_PROOF_UNAVAILABLE', message: 'The identity-proof storage path is unavailable.' });
    }
    try { await fs.access(resolved); } catch {
      identityProofActivity(data, applicant, actor, 'applicant_id_document_access_failed', { reason: 'file_missing', statusCode: 404, documentId: document.id, fileName });
      await saveData(data);
      return res.status(404).json({ code: 'IDENTITY_PROOF_FILE_MISSING', message: 'The identity-proof record exists, but its file is missing. Ask the applicant to upload it again.' });
    }
    identityProofActivity(data, applicant, actor, 'applicant_id_document_accessed', { documentId: document.id, fileName, mimeType: document.mimeType || null });
    await saveData(data);
    res.set({
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Disposition': `inline; filename="${String(document.name || 'identity-proof').replace(/["\\\r\n]/g, '_')}"`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
    if (document.mimeType) res.type(document.mimeType);
    return res.sendFile(resolved);
  } catch {
    return res.status(503).json({ code: 'IDENTITY_PROOF_UNAVAILABLE', message: 'The identity-proof service is temporarily unavailable. Try again, then contact a System Administrator if the problem continues.' });
  }
});

app.get('/api/applicant-verifications', requireAuth, requirePermission('requestors:view'), async (req, res) => {
  try {
    const data = await loadData();
    return res.json(data.applicants.map((applicant) => ({
      ...publicUser(applicant),
      identityVerification: applicant.identityVerification ? {
        ...applicant.identityVerification,
        document: applicant.identityVerification.document ? {
          ...applicant.identityVerification.document,
          url: `${requestBaseUrl(req)}/api/applicant-verifications/${encodeURIComponent(applicant.id)}/document`,
        } : null,
      } : null,
    })).sort((a, b) => String(b.identityVerification?.document?.uploadedAt || b.registeredDate).localeCompare(String(a.identityVerification?.document?.uploadedAt || a.registeredDate))));
  } catch {
    return res.status(500).json({ message: 'Unable to load applicant verifications.' });
  }
});

app.post('/api/applicant-verifications/:id/flag', requireAuth, requirePermission('requestors:view'), async (req, res) => {
  const note = String(req.body?.note || '').trim();
  if (!note) return res.status(400).json({ message: 'A flag or escalation note is required.' });
  try {
    const data = await loadData();
    const actor = data.authUsers.find((item) => item.id === req.auth.sub);
    const applicant = data.applicants.find((item) => item.id === req.params.id);
    if (!actor || !applicant) return res.status(404).json({ message: 'Applicant or staff account not found.' });
    applicant.identityVerification ??= { status: applicant.verificationStatus || 'unverified', document: null, decision: null, auditNotes: [] };
    const auditNote = { note, type: 'flag', createdAt: new Date().toISOString(), createdBy: actor.fullName, createdById: actor.id };
    applicant.identityVerification.auditNotes = [...(applicant.identityVerification.auditNotes || []), auditNote];
    addActivity(data, { action: 'applicant_id_flagged', actor, affectedRecord: { type: 'applicant_account', id: applicant.id, label: applicant.email }, details: auditNote });
    await saveData(data);
    return res.json({ ...publicUser(applicant), identityVerification: applicant.identityVerification });
  } catch {
    return res.status(500).json({ message: 'Unable to flag identity verification.' });
  }
});

app.put('/api/applicant-verifications/:id/decision', requireAuth, requirePermission('identity:approve'), async (req, res) => {
  const decision = String(req.body?.decision || '').trim().toLowerCase();
  const notes = String(req.body?.notes || '').trim();
  if (!['approved', 'rejected'].includes(decision) || !notes) return res.status(400).json({ message: 'Approval or rejection and audit notes are required.' });
  try {
    const data = await loadData();
    const actor = data.authUsers.find((item) => item.id === req.auth.sub);
    const applicant = data.applicants.find((item) => item.id === req.params.id);
    if (!actor || !applicant) return res.status(404).json({ message: 'Applicant or administrator not found.' });
    if (!applicant.identityVerification?.document) return res.status(400).json({ message: 'The applicant has not uploaded a government-issued ID.' });
    const previousVerificationStatus = applicant.verificationStatus || 'unverified';
    const previousAccountStatus = applicant.accountStatus || 'basic';
    const decisionAt = new Date().toISOString();
    applicant.verificationStatus = decision;
    applicant.accountStatus = decision === 'approved' ? 'verified' : 'basic';
    applicant.identityVerification.status = decision;
    applicant.identityVerification.decision = {
      decision,
      administratorId: actor.id,
      administratorName: actor.fullName,
      decidedAt: decisionAt,
      notes,
    };
    applicant.identityVerification.auditNotes = [...(applicant.identityVerification.auditNotes || []), { note: notes, type: decision, createdAt: decisionAt, createdBy: actor.fullName, createdById: actor.id }];
    addActivity(data, {
      action: decision === 'approved' ? 'applicant_id_approved' : 'applicant_id_rejected',
      actor,
      affectedRecord: { type: 'applicant_account', id: applicant.id, label: applicant.email },
      details: { previousVerificationStatus, verificationStatus: decision, notes, documentId: applicant.identityVerification.document.id },
    });
    if (previousVerificationStatus !== decision || previousAccountStatus !== applicant.accountStatus) {
      addActivity(data, {
        action: 'applicant_account_status_changed',
        actor,
        affectedRecord: { type: 'applicant_account', id: applicant.id, label: applicant.email },
        details: { previousAccountStatus, accountStatus: applicant.accountStatus, previousVerificationStatus, verificationStatus: decision },
      });
    }
    await saveData(data);
    return res.json({ ...publicUser(applicant), identityVerification: applicant.identityVerification });
  } catch {
    return res.status(500).json({ message: 'Unable to record the identity-verification decision.' });
  }
});

app.get('/api/users', requireAuth, requirePermission('requestors:view'), async (req, res) => {
  try {
    const data = await loadData();
    const permittedEmails = new Set(data.requests.filter((request) => requestIsPermittedForStaff(request, req.auth)).map((request) => request.email.toLowerCase()));
    return res.json(data.users.filter((user) => hasPermission(req.auth.role, 'system:manage') || permittedEmails.has(user.email.toLowerCase())).map((user) => {
      const applicant = data.applicants.find((item) => item.email === user.email.toLowerCase());
      return { ...user, verificationStatus: applicant?.verificationStatus || 'legacy', accountStatus: applicant?.accountStatus || 'legacy' };
    }));
  } catch { return res.status(500).json({ message: 'Unable to load users.' }); }
});

app.get('/api/users/:id/requests', requireAuth, requirePermission('requestors:view'), async (req, res) => {
  try {
    const data = await loadData();
    const user = data.users.find((item) => item.id === req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    const requests = data.requests
      .filter((request) => request.email.toLowerCase() === user.email.toLowerCase())
      .filter((request) => requestIsPermittedForStaff(request, req.auth))
      .sort((a, b) => b.dateSubmitted.localeCompare(a.dateSubmitted));
    return res.json(requests);
  } catch {
    return res.status(500).json({ message: 'Unable to load user requests.' });
  }
});

app.get('/api/audit-logs', requireAuth, requirePermission('audit:system'), async (req, res) => {
  try {
    const data = await loadData();
    const combined = [...data.auditLogs.map((entry) => publicActivityEntry(entry, data)), ...await databaseActivityEntries(data)];
    const unique = [...new Map(combined.map((entry) => [entry.id, entry])).values()];
    const dateFrom = req.query.dateFrom ? new Date(`${req.query.dateFrom}T00:00:00.000Z`) : null;
    const dateTo = req.query.dateTo ? new Date(`${req.query.dateTo}T23:59:59.999Z`) : null;
    const actionType = String(req.query.actionType || '').trim();
    return res.json(unique.filter((entry) => {
      const at = entry.timestamp ? new Date(entry.timestamp) : null;
      return (!dateFrom || (at && at >= dateFrom)) && (!dateTo || (at && at <= dateTo)) && (!actionType || entry.action === actionType);
    }).sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || ''))));
  } catch {
    return res.status(500).json({ message: 'Unable to load system audit activity.' });
  }
});

async function createAuditedReport(req, action, rawParameters = {}, format = 'json') {
  const data = await loadData();
  const parameters = parseReportParameters(rawParameters, data);
  const generatedAt = new Date().toISOString();
  const databaseAudits = await databaseActivityEntries(data);
  const report = buildSystemReport({ ...data, auditLogs: [...data.auditLogs, ...databaseAudits] }, parameters, generatedAt);
  addActivity(data, {
    action,
    actor: req.authUser,
    affectedRecord: { type: 'system_report', id: generatedAt, label: 'System administrator report' },
    details: { format, scope: 'system_reporting', parameters, resultCount: report.totalRequests, generatedAt },
  });
  await saveData(data);
  return report;
}

app.get('/api/reports/summary', requireAuth, requirePermission('reports:generate'), async (req, res) => {
  try {
    return res.json(await createAuditedReport(req, 'report_generated', req.query, 'json'));
  } catch (error) {
    if (error?.code === 'INVALID_REPORT_PARAMETERS') return res.status(400).json({ message: error.message });
    return res.status(500).json({ message: 'Unable to generate the system report.' });
  }
});

app.post('/api/reports/export', requireAuth, requirePermission('reports:generate'), async (req, res) => {
  try {
    const format = String(req.body?.format || 'json').toLowerCase();
    if (!['json', 'csv', 'pdf'].includes(format)) return res.status(400).json({ message: 'Export format must be JSON, CSV, or PDF.' });
    const report = await createAuditedReport(req, 'report_exported', req.body?.parameters || req.body || {}, format);
    const fileDate = report.generatedAt.slice(0, 10);
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="aidlink-system-report-${fileDate}.csv"`);
      return res.send(reportToCsv(report));
    }
    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="aidlink-system-report-${fileDate}.pdf"`);
      return res.send(reportToPdf(report));
    }
    return res.json(report);
  } catch (error) {
    if (error?.code === 'INVALID_REPORT_PARAMETERS') return res.status(400).json({ message: error.message });
    return res.status(500).json({ message: 'Unable to export the system report.' });
  }
});

await fs.mkdir(uploadsPath, { recursive: true });
await fs.mkdir(lettersPath, { recursive: true });
app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ message: 'The document is larger than 10 MB. Reduce the file size while keeping the text readable, then try again.' });
  }
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'The document is larger than 10 MB. Reduce the file size while keeping the text readable, then try again.'
      : `The document could not be uploaded: ${error.message}. Choose a replacement file and try again.`;
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ message });
  }
  if (error?.message === documentFormatError) {
    return res.status(400).json({ message: error.message });
  }
  return res.status(500).json({ message: 'Unexpected server error.' });
});
export { app, storageFoundation };

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    await storageFoundation.initialize();
    app.listen(port, '0.0.0.0', () => console.log(`Backend server running at http://localhost:${port}`));
    void processAutomaticSmsRetries().catch(() => undefined);
    const smsRetryTimer = setInterval(() => {
      void processAutomaticSmsRetries().catch(() => undefined);
    }, 60 * 1000);
    smsRetryTimer.unref();
    void processGuaranteeLetterExpiries().catch(() => undefined);
    const letterExpiryTimer = setInterval(() => { void processGuaranteeLetterExpiries().catch(() => undefined); }, 60 * 1000);
    letterExpiryTimer.unref();
  } catch (error) {
    const actionable = [
      'PostgreSQL migrations are not current.',
      'Legacy data has not been imported.',
      'The imported database is not marked verified.',
      'The configured JSON data file is unavailable.',
    ].find((prefix) => String(error?.message || '').startsWith(prefix));
    console.error(`Backend startup failed: ${actionable ? error.message : 'Storage initialization failed. Check the configured storage service.'}`);
    process.exitCode = 1;
  }
}
