import crypto from 'crypto';

export const FacilityTier = Object.freeze({ PUBLIC: 'public', PRIVATE: 'private' });
export const FacilityResolutionOutcome = Object.freeze({
  RESOLVED: 'resolved',
  HUMAN_REVIEW_REQUIRED: 'human_review_required',
  CORRECTION_REQUIRED: 'correction_required',
});
export const FacilityReasonCode = Object.freeze({
  PUBLIC: 'FACILITY_RESOLVED_PUBLIC',
  PRIVATE: 'FACILITY_RESOLVED_PRIVATE',
  UNKNOWN: 'FACILITY_UNKNOWN',
  STALE: 'FACILITY_EVIDENCE_STALE',
  PRIVATE_LIST_PENDING: 'PRIVATE_PARTNER_LIST_PENDING',
  CHO_PENDING: 'CHO_VALIDATION_PENDING',
  CHO_APPROVED: 'CHO_VALIDATION_APPROVED',
  CHO_REJECTED: 'CHO_VALIDATION_REJECTED',
});

const DAY_MS = 86_400_000;
const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const validDate = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
  }
  const text = String(value || '').slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00.000Z`) : null;
  return date && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? date : null;
};
const effective = (entry, at) => {
  const from = validDate(entry.effectiveFrom) || new Date(0);
  const until = entry.effectiveUntil ? validDate(entry.effectiveUntil) : null;
  return from <= at && (!until || until >= at);
};

export function validateFacilityDirectory(directory) {
  if (!directory || typeof directory !== 'object' || Array.isArray(directory)) throw new Error('Facility directory must be an object.');
  const entries = Array.isArray(directory.entries) ? directory.entries : [];
  const privateEntries = entries.filter((entry) => entry.tier === FacilityTier.PRIVATE);
  if (privateEntries.length && privateEntries.length !== 42) {
    throw new Error('The private directory must contain the complete authoritative list of 42 partners.');
  }
  if (privateEntries.length) {
    if (!String(directory.clientApprovalReference || '').trim()) throw new Error('A client approval reference is required for the private partner directory.');
    for (const entry of privateEntries) {
      if (!entry.key || !entry.canonicalName || !validDate(entry.effectiveFrom)) {
        throw new Error('Every private partner requires a stable key, canonical name, and effective date.');
      }
    }
  }
  for (const entry of entries) {
    if (!Object.values(FacilityTier).includes(entry.tier)) throw new Error('Every directory entry requires a public or private tier.');
  }
  return { entries, privatePartnerCount: privateEntries.length };
}

export function facilityEvidenceFingerprint(evidence) {
  return crypto.createHash('sha256').update(JSON.stringify({
    facilityName: normalize(evidence?.facilityName),
    receiptDate: String(evidence?.receiptDate || ''),
    referenceNumber: normalize(evidence?.referenceNumber),
    receiptDocumentId: String(evidence?.receiptDocumentId || ''),
  })).digest('hex');
}

export function resolveFacilityEvidence({ evidence, directoryVersion, now = new Date() }) {
  const directory = directoryVersion?.directory || directoryVersion || {};
  validateFacilityDirectory(directory);
  const checkedAt = new Date(now);
  const evidenceDate = validDate(evidence?.receiptDate);
  const fingerprint = facilityEvidenceFingerprint(evidence);
  if (!evidenceDate || evidenceDate > checkedAt) {
    return { outcome: FacilityResolutionOutcome.CORRECTION_REQUIRED, reasonCode: FacilityReasonCode.STALE, evidenceFingerprint: fingerprint, findings: [{ code: FacilityReasonCode.STALE, message: 'Provide a valid receipt date that is not in the future.' }] };
  }
  const ageDays = Math.floor((Date.UTC(checkedAt.getUTCFullYear(), checkedAt.getUTCMonth(), checkedAt.getUTCDate()) - evidenceDate.getTime()) / DAY_MS);
  if (ageDays > Number(directory.maxEvidenceAgeDays ?? 365)) {
    return { outcome: FacilityResolutionOutcome.CORRECTION_REQUIRED, reasonCode: FacilityReasonCode.STALE, evidenceFingerprint: fingerprint, evidenceDate: evidenceDate.toISOString().slice(0, 10), ageDays, findings: [{ code: FacilityReasonCode.STALE, message: `Replace the facility evidence; it is ${ageDays} days old.` }] };
  }
  const suppliedName = normalize(evidence?.facilityName);
  const entry = (directory.entries || []).find((candidate) => effective(candidate, evidenceDate)
    && [candidate.canonicalName, ...(candidate.aliases || [])].map(normalize).includes(suppliedName));
  const rule = entry ? null : (directory.rules || []).find((candidate) => effective(candidate, evidenceDate)
    && suppliedName.includes(normalize(candidate.match)));
  const resolved = entry || rule;
  if (!resolved) {
    const privatePending = Number(directory.requiredPrivatePartnerCount || 0) > (directory.entries || []).filter((item) => item.tier === 'private').length;
    const reasonCodes = [FacilityReasonCode.UNKNOWN, ...(privatePending ? [FacilityReasonCode.PRIVATE_LIST_PENDING] : [])];
    return { outcome: FacilityResolutionOutcome.HUMAN_REVIEW_REQUIRED, reasonCode: FacilityReasonCode.UNKNOWN, reasonCodes, evidenceFingerprint: fingerprint, evidenceDate: evidenceDate.toISOString().slice(0, 10), findings: [{ code: FacilityReasonCode.UNKNOWN, message: 'The facility could not be matched to the effective directory and needs staff review.' }] };
  }
  return {
    outcome: FacilityResolutionOutcome.RESOLVED,
    reasonCode: resolved.tier === FacilityTier.PUBLIC ? FacilityReasonCode.PUBLIC : FacilityReasonCode.PRIVATE,
    evidenceFingerprint: fingerprint,
    evidenceDate: evidenceDate.toISOString().slice(0, 10),
    facility: { key: resolved.key, canonicalName: resolved.canonicalName || evidence.facilityName, tier: resolved.tier, category: resolved.category || 'other' },
    findings: [],
  };
}

export function privatePrescriptionPricingState({ facilityTier, prescriberCategory, prescriptionDocumentId, choStatus }) {
  const privatePrescription = facilityTier === FacilityTier.PRIVATE
    && ['clinic', 'doctor'].includes(prescriberCategory)
    && Boolean(prescriptionDocumentId);
  if (!privatePrescription) return { status: 'not_applicable', reasonCode: null };
  if (choStatus === 'approved') return { status: 'unlocked', reasonCode: FacilityReasonCode.CHO_APPROVED };
  if (choStatus === 'rejected') return { status: 'locked', reasonCode: FacilityReasonCode.CHO_REJECTED };
  return { status: 'locked', reasonCode: FacilityReasonCode.CHO_PENDING };
}
