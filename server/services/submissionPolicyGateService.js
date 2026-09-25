import crypto from 'crypto';

export const SubmissionGateOutcome = Object.freeze({
  PASSED: 'passed',
  CORRECTION_REQUIRED: 'correction_required',
  HUMAN_REVIEW_REQUIRED: 'human_review_required',
  BLOCKED: 'blocked',
});

export const SubmissionGateReasonCode = Object.freeze({
  APPLICANT_MISMATCH: 'AUTHENTICATED_APPLICANT_MISMATCH',
  BENEFICIARY_RELATIONSHIP_INVALID: 'BENEFICIARY_RELATIONSHIP_INVALID',
  ORIGINATING_OFFICE_REQUIRED: 'ORIGINATING_OFFICE_REQUIRED',
  ORIGINATING_OFFICE_INACTIVE: 'ORIGINATING_OFFICE_INACTIVE',
  RESIDENCY_OUTSIDE_BOUNDARY: 'RESIDENCY_OUTSIDE_BOUNDARY',
  RESIDENCY_REVIEW_REQUIRED: 'RESIDENCY_REVIEW_REQUIRED',
  REQUIRED_DOCUMENT_MISSING: 'REQUIRED_DOCUMENT_MISSING',
  DOCUMENT_QUALITY_FAILED: 'DOCUMENT_QUALITY_FAILED',
  DOCUMENT_REVIEW_REQUIRED: 'DOCUMENT_REVIEW_REQUIRED',
  RECEIPT_CONTEXT_INVALID: 'RECEIPT_CONTEXT_INVALID',
  DOCUMENT_YEAR_EXPIRED: 'DOCUMENT_YEAR_EXPIRED',
  DUPLICATE_SUBMISSION: 'DUPLICATE_SUBMISSION',
  PATIENT_COOLDOWN_ACTIVE: 'PATIENT_COOLDOWN_ACTIVE',
  RESIDENCY_OVERRIDE_APPLIED: 'RESIDENCY_OVERRIDE_APPLIED',
});

const DAY_MS = 86_400_000;
const activeRequestStatuses = new Set(['pending', 'under_review', 'correction_requested', 'approved', 'ready_for_claiming']);

const normalized = (value) => String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
const isReceiptType = (value) => /\b(receipt|bill|billing|statement of account|invoice|quotation|contract)\b/i.test(String(value || ''));
const dateOnly = (value) => {
  const text = String(value || '').slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00.000Z`) : null;
  return date && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? date : null;
};

export function patientIdentityKey(beneficiary) {
  const identity = `${normalized(beneficiary?.fullName)}|${String(beneficiary?.dateOfBirth || '').slice(0, 10)}`;
  return crypto.createHash('sha256').update(identity).digest('hex');
}

export function submissionFingerprint(input) {
  const material = {
    applicantId: input.applicantId,
    patientIdentityKey: patientIdentityKey(input.beneficiary),
    assistanceType: normalized(input.assistanceType),
    receiptReference: normalized(input.facilityEvidence?.referenceNumber),
    receiptDate: String(input.facilityEvidence?.receiptDate || ''),
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

function pointInPolygon(longitude, latitude, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = ((yi > latitude) !== (yj > latitude))
      && (longitude < ((xj - xi) * (latitude - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

export function validateResidencyBoundary(boundary, residency) {
  if (!boundary || typeof boundary !== 'object' || !Object.keys(boundary).length) return { status: 'review' };
  const coordinates = boundary.polygon || boundary.geoJson?.coordinates?.[0];
  if (Array.isArray(coordinates) && coordinates.length >= 3) {
    const longitude = Number(residency?.longitude);
    const latitude = Number(residency?.latitude);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return { status: 'review' };
    return { status: pointInPolygon(longitude, latitude, coordinates) ? 'inside' : 'outside' };
  }
  const address = normalized(residency?.address);
  const groups = [boundary.postalCodes, boundary.cities, boundary.barangays, boundary.districtCodes, boundary.addressPatterns]
    .map((values) => (Array.isArray(values) ? values.map(normalized).filter(Boolean) : []))
    .filter((values) => values.length);
  if (!address || !groups.length) return { status: 'review' };
  return { status: groups.every((values) => values.some((candidate) => address.includes(candidate))) ? 'inside' : 'outside' };
}

function documentDate(document, facilityEvidence) {
  if (document?.id === facilityEvidence?.receiptDocumentId) return dateOnly(facilityEvidence.receiptDate);
  return dateOnly(document?.documentDate || document?.issuedAt || document?.metadata?.documentDate || document?.analysis?.documentDate);
}

function qualityStatus(document) {
  const analysis = document?.analysis || {};
  if (analysis.accepted === false || ['rejected', 'failed'].includes(analysis.outcome)) return 'failed';
  if (analysis.humanReviewRequired || ['manual_review', 'review_required'].includes(analysis.outcome)) return 'review';
  return analysis.accepted === true || ['accepted', 'warning'].includes(analysis.outcome) ? 'accepted' : 'failed';
}

function documentMatches(document, requirement) {
  const expected = normalized(requirement);
  return [document?.documentType, document?.label, document?.name].map(normalized).includes(expected)
    && (!document?.analysis?.documentType || normalized(document.analysis.documentType) === expected);
}

function finding(code, message, field, extra = {}) {
  return { code, message, field, ...extra };
}

export function evaluateSubmissionPolicyGates(context) {
  const now = new Date(context.now || Date.now());
  const input = context.input || {};
  const findings = [];
  const requiredReviews = [];
  let blocked = false;
  let correction = false;
  let review = false;

  if (!context.authenticatedApplicantId || context.authenticatedApplicantId !== input.applicantId) {
    blocked = true;
    findings.push(finding(SubmissionGateReasonCode.APPLICANT_MISMATCH, 'The authenticated applicant does not own this submission.', 'applicantId'));
  }
  const beneficiaryType = input.beneficiaryType === 'other' ? 'other' : 'self';
  const relationship = normalized(input.beneficiary?.relationshipToApplicant);
  if ((beneficiaryType === 'self' && relationship !== 'self') || (beneficiaryType === 'other' && (!relationship || relationship === 'self'))) {
    blocked = true;
    findings.push(finding(SubmissionGateReasonCode.BENEFICIARY_RELATIONSHIP_INVALID, 'Confirm the requester’s relationship to the beneficiary.', 'beneficiary.relationshipToApplicant'));
  }

  if (context.existingActiveRequest) {
    blocked = true;
    findings.push(finding(SubmissionGateReasonCode.DUPLICATE_SUBMISSION, 'An active request already exists for this patient and assistance type.', 'request'));
  } else if (context.cooldownEndDate && new Date(context.cooldownEndDate) > now) {
    blocked = true;
    findings.push(finding(SubmissionGateReasonCode.PATIENT_COOLDOWN_ACTIVE, 'This patient is still within the configured submission cooldown.', 'request'));
  }

  const office = context.originatingOffice;
  if (!office || office.office_type !== 'district_satellite') {
    blocked = true;
    findings.push(finding(SubmissionGateReasonCode.ORIGINATING_OFFICE_REQUIRED, 'Select an active district satellite office for residency review.', 'originatingOfficeId'));
  } else if (office.active === false) {
    blocked = true;
    findings.push(finding(SubmissionGateReasonCode.ORIGINATING_OFFICE_INACTIVE, 'The originating district satellite office is inactive.', 'originatingOfficeId'));
  } else {
    const residency = validateResidencyBoundary(office.residency_boundary || office.residencyBoundary || office.metadata?.residencyBoundary, {
      address: input.beneficiary?.address,
      latitude: input.latitude,
      longitude: input.longitude,
    });
    if (residency.status === 'outside') {
      if (context.residencyOverride?.authorized && String(context.residencyOverride.reason || '').trim()) {
        findings.push(finding(SubmissionGateReasonCode.RESIDENCY_OVERRIDE_APPLIED, 'Residency was accepted through an authorized staff override.', 'beneficiary.address'));
      } else {
        blocked = true;
        findings.push(finding(SubmissionGateReasonCode.RESIDENCY_OUTSIDE_BOUNDARY, 'The address is outside the configured district boundary.', 'beneficiary.address'));
      }
    } else if (residency.status === 'review') {
      review = true;
      findings.push(finding(SubmissionGateReasonCode.RESIDENCY_REVIEW_REQUIRED, 'Residency needs staff review because the configured boundary could not be matched automatically.', 'beneficiary.address'));
      requiredReviews.push({ type: 'residency_review', reasonCode: SubmissionGateReasonCode.RESIDENCY_REVIEW_REQUIRED });
    }
  }

  const documents = Array.isArray(input.documents) ? input.documents : [];
  const requirements = Array.isArray(context.requiredDocuments) ? context.requiredDocuments : [];
  for (const requirement of requirements) {
    const document = documents.find((item) => documentMatches(item, requirement));
    if (!document) {
      correction = true;
      findings.push(finding(SubmissionGateReasonCode.REQUIRED_DOCUMENT_MISSING, `Upload the required document: ${requirement}.`, 'documents', { requirement }));
      continue;
    }
    const quality = qualityStatus(document);
    if (quality === 'failed') {
      correction = true;
      findings.push(finding(SubmissionGateReasonCode.DOCUMENT_QUALITY_FAILED, `Replace ${requirement} with a readable accepted document.`, 'documents', { documentId: document.id, requirement }));
    } else if (quality === 'review') {
      review = true;
      findings.push(finding(SubmissionGateReasonCode.DOCUMENT_REVIEW_REQUIRED, `${requirement} needs Case Worker review.`, 'documents', { documentId: document.id, requirement }));
      requiredReviews.push({ type: 'document_review', documentId: document.id, reasonCode: SubmissionGateReasonCode.DOCUMENT_REVIEW_REQUIRED });
    }
  }

  const evidence = input.facilityEvidence || {};
  const receipt = documents.find((item) => item.id === evidence.receiptDocumentId);
  if (!receipt || !isReceiptType(receipt.documentType || receipt.label || receipt.name)
      || !String(evidence.facilityName || '').trim()
      || !['hospital', 'pharmacy', 'other'].includes(String(evidence.facilityType || '').toLowerCase())
      || !String(evidence.referenceNumber || '').trim()
      || (evidence.assistanceType && normalized(evidence.assistanceType) !== normalized(input.assistanceType))) {
    correction = true;
    findings.push(finding(SubmissionGateReasonCode.RECEIPT_CONTEXT_INVALID, 'Provide a receipt tied to the facility and this assistance request.', 'facilityEvidence'));
  }

  const calendarYearTypes = new Set((context.calendarYearDocumentTypes?.length
    ? context.calendarYearDocumentTypes
    : requirements.filter(isReceiptType)).map(normalized));
  for (const document of documents) {
    if (!calendarYearTypes.has(normalized(document.documentType || document.label || document.name))) continue;
    const issued = documentDate(document, evidence);
    if (!issued || issued > now || issued.getUTCFullYear() !== now.getUTCFullYear()) {
      correction = true;
      findings.push(finding(SubmissionGateReasonCode.DOCUMENT_YEAR_EXPIRED, `Replace ${document.label || document.name || document.documentType}; it must be dated in ${now.getUTCFullYear()}.`, 'documents', { documentId: document.id, activeYear: now.getUTCFullYear() }));
    }
  }

  const outcome = blocked ? SubmissionGateOutcome.BLOCKED
    : correction ? SubmissionGateOutcome.CORRECTION_REQUIRED
      : review ? SubmissionGateOutcome.HUMAN_REVIEW_REQUIRED
        : SubmissionGateOutcome.PASSED;
  return {
    outcome,
    reasonCodes: [...new Set(findings.map((item) => item.code))],
    findings,
    requiredReviews,
    existingRequestReference: context.existingActiveRequest?.request_number || context.existingActiveRequest?.requestId || null,
    cooldownEndDate: context.cooldownEndDate ? new Date(context.cooldownEndDate).toISOString() : null,
    evaluatorVersion: 'submission-gates-1',
    evaluatedAt: now.toISOString(),
  };
}

export function isActiveRequestStatus(status) {
  return activeRequestStatuses.has(status);
}

export function cooldownEnd(submittedAt, cooldownDays) {
  return new Date(new Date(submittedAt).getTime() + Math.max(0, Number(cooldownDays) || 0) * DAY_MS);
}
