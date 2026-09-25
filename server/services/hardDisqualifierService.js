import crypto from 'crypto';

export const HardDisqualifierOutcome = Object.freeze({
  CLEAR: 'clear', EVIDENCE_REQUIRED: 'evidence_required', HUMAN_REVIEW_REQUIRED: 'human_review_required',
  BLOCKED: 'blocked', EXCEPTION_APPLIED: 'exception_applied',
});

export const HardDisqualifierReasonCode = Object.freeze({
  MOTORCYCLE_DETAILS_REQUIRED: 'MOTORCYCLE_ACCIDENT_DETAILS_REQUIRED',
  MOTORCYCLE_REPORT_REQUIRED: 'MOTORCYCLE_ACCIDENT_REPORT_REQUIRED',
  NO_HELMET: 'MOTORCYCLE_NO_HELMET',
  IMPAIRMENT: 'DUI_OR_DANGEROUS_DRUG_IMPAIRMENT',
  ACTIVE_CRIME: 'ACTIVE_CRIME_OFFENSE',
  ARMED_GROUP: 'ARMED_GROUP_RESTRICTION',
  EXCEPTION_APPLIED: 'HARD_DISQUALIFIER_EXCEPTION_APPLIED',
});

export const HardDisqualifierEvidenceRule = Object.freeze({
  MOTORCYCLE_HELMET: 'motorcycle_helmet', IMPAIRMENT: 'impairment',
  ACTIVE_CRIME: 'active_crime', ARMED_GROUP: 'armed_group_restriction',
});

const evidenceTypes = Object.freeze({
  [HardDisqualifierEvidenceRule.MOTORCYCLE_HELMET]: new Set(['police_accident_report', 'traffic_accident_report']),
  [HardDisqualifierEvidenceRule.IMPAIRMENT]: new Set(['police_accident_report', 'traffic_accident_report', 'toxicology_report', 'court_record']),
  [HardDisqualifierEvidenceRule.ACTIVE_CRIME]: new Set(['official_law_enforcement_record', 'court_record']),
  [HardDisqualifierEvidenceRule.ARMED_GROUP]: new Set(['authorized_restriction_decision']),
});
const findingFields = Object.freeze({
  [HardDisqualifierEvidenceRule.MOTORCYCLE_HELMET]: new Set(['incidentType', 'helmetStatus']),
  [HardDisqualifierEvidenceRule.IMPAIRMENT]: new Set(['impairmentStatus']),
  [HardDisqualifierEvidenceRule.ACTIVE_CRIME]: new Set(['offenseStatus']),
  [HardDisqualifierEvidenceRule.ARMED_GROUP]: new Set(['decision']),
});

const normalized = (value) => String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const finding = (code, message, rule, extra = {}) => ({ code, message, rule, blocking: code !== HardDisqualifierReasonCode.MOTORCYCLE_DETAILS_REQUIRED, ...extra });
const latestEvidence = (evidence, ruleCode) => [...(evidence || [])]
  .filter((item) => (item.rule_code || item.ruleCode) === ruleCode && item.authorized === true)
  .sort((a, b) => String(b.recorded_at || b.recordedAt || '').localeCompare(String(a.recorded_at || a.recordedAt || '')))[0] || null;

export function validateHardDisqualifierPolicyConfiguration(configuration) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw Object.assign(new Error('Hard-disqualifier policy configuration must be an object.'), { code: 'INVALID_HARD_DISQUALIFIER_POLICY' });
  }
  const armed = configuration.rules?.armedGroup || {};
  if (armed.enabled === true) {
    const missing = [
      !String(armed.clientApprovalReference || '').trim() && 'client approval reference',
      !String(armed.legalApprovalReference || '').trim() && 'legal approval reference',
      !String(armed.authorizedDecisionProcess || '').trim() && 'authorized documented decision process',
    ].filter(Boolean);
    if (missing.length) throw Object.assign(new Error(`The armed-group restriction cannot be enabled without: ${missing.join(', ')}.`), { code: 'ARMED_GROUP_APPROVAL_REQUIRED' });
  }
  return configuration;
}

export function validateHardDisqualifierEvidence(input) {
  const ruleCode = String(input?.ruleCode || input?.rule_code || '').trim();
  const evidenceType = String(input?.evidenceType || input?.evidence_type || '').trim();
  const sourceAuthority = String(input?.sourceAuthority || input?.source_authority || '').trim();
  const sourceReference = String(input?.sourceReference || input?.source_reference || '').trim();
  const documentId = String(input?.documentId || input?.evidence_document_id || '').trim();
  const findings = input?.findings;
  if (!evidenceTypes[ruleCode]) throw Object.assign(new Error('Select a supported hard-disqualifier rule.'), { code: 'INVALID_RULE_CODE' });
  if (!evidenceTypes[ruleCode].has(evidenceType)) throw Object.assign(new Error('The selected evidence type is not authorized for this rule.'), { code: 'UNAUTHORIZED_EVIDENCE_TYPE' });
  if (!sourceAuthority || !sourceReference || !documentId) throw Object.assign(new Error('Authorized evidence requires its issuing authority, reference, and attached request document.'), { code: 'EVIDENCE_DETAILS_REQUIRED' });
  if (!findings || typeof findings !== 'object' || Array.isArray(findings)) throw Object.assign(new Error('Structured evidence findings are required.'), { code: 'EVIDENCE_FINDINGS_REQUIRED' });
  if (Object.keys(findings).some((key) => !findingFields[ruleCode].has(key))) throw Object.assign(new Error('Evidence contains fields that are not permitted for this rule.'), { code: 'UNSUPPORTED_EVIDENCE_FINDING' });
  const result = clone(findings);
  if (ruleCode === HardDisqualifierEvidenceRule.MOTORCYCLE_HELMET) {
    if (!['motorcycle_accident', 'other_accident'].includes(normalized(findings.incidentType))) throw Object.assign(new Error('Record whether the authorized report identifies a motorcycle accident or another accident.'), { code: 'INCIDENT_TYPE_REQUIRED' });
    if (!['worn', 'not_worn', 'unknown', 'not_applicable'].includes(normalized(findings.helmetStatus))) throw Object.assign(new Error('Record the helmet finding from the authorized report.'), { code: 'HELMET_STATUS_REQUIRED' });
    result.incidentType = normalized(findings.incidentType); result.helmetStatus = normalized(findings.helmetStatus);
  } else if (ruleCode === HardDisqualifierEvidenceRule.IMPAIRMENT) {
    if (!['none', 'dui', 'dangerous_drug', 'unknown'].includes(normalized(findings.impairmentStatus))) throw Object.assign(new Error('Record the impairment finding from the authorized evidence.'), { code: 'IMPAIRMENT_STATUS_REQUIRED' });
    result.impairmentStatus = normalized(findings.impairmentStatus);
  } else if (ruleCode === HardDisqualifierEvidenceRule.ACTIVE_CRIME) {
    if (!['active', 'not_active', 'unknown'].includes(normalized(findings.offenseStatus))) throw Object.assign(new Error('Record the active-offense finding from authorized evidence.'), { code: 'OFFENSE_STATUS_REQUIRED' });
    result.offenseStatus = normalized(findings.offenseStatus);
  } else {
    if (!['restricted', 'clear', 'unknown'].includes(normalized(findings.decision))) throw Object.assign(new Error('Record only the authorized process decision.'), { code: 'AUTHORIZED_DECISION_REQUIRED' });
    result.decision = normalized(findings.decision);
  }
  return { ruleCode, evidenceType, sourceAuthority, sourceReference, documentId, findings: result };
}

export function hardDisqualifierFingerprint({ request, evidence, policy }) {
  const relevant = {
    requestId: request?.id || null,
    patientCircumstance: request?.patient_circumstance || request?.patientCircumstance || null,
    evidence: (evidence || []).map((item) => ({
      id: item.id, ruleCode: item.rule_code || item.ruleCode, evidenceType: item.evidence_type || item.evidenceType,
      sourceAuthority: item.source_authority || item.sourceAuthority, sourceReference: item.source_reference || item.sourceReference,
      documentId: item.evidence_document_id || item.documentId, findings: item.findings, authorized: item.authorized,
      recordedAt: item.recorded_at || item.recordedAt,
    })),
    policyVersion: policy?.policy_version || policy?.policyVersion || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}

export function evaluateHardDisqualifiers({ request, evidence = [], policy = null, now = new Date() }) {
  const configuration = validateHardDisqualifierPolicyConfiguration(policy?.configuration || { rules: { armedGroup: { enabled: false } } });
  const findings = []; const requiredEvidence = [];
  const circumstance = normalized(request?.patient_circumstance || request?.patientCircumstance);
  const motorcycle = latestEvidence(evidence, HardDisqualifierEvidenceRule.MOTORCYCLE_HELMET);
  if (circumstance === 'accident') {
    if (!motorcycle) {
      findings.push(finding(HardDisqualifierReasonCode.MOTORCYCLE_DETAILS_REQUIRED, 'Authorized accident evidence must identify whether this was a motorcycle accident before approval.', HardDisqualifierEvidenceRule.MOTORCYCLE_HELMET, { blocking: false }));
      requiredEvidence.push({ ruleCode: HardDisqualifierEvidenceRule.MOTORCYCLE_HELMET, acceptedTypes: [...evidenceTypes[HardDisqualifierEvidenceRule.MOTORCYCLE_HELMET]] });
    } else if (motorcycle.findings?.incidentType === 'motorcycle_accident') {
      if (!['police_accident_report', 'traffic_accident_report'].includes(motorcycle.evidence_type || motorcycle.evidenceType)) {
        findings.push(finding(HardDisqualifierReasonCode.MOTORCYCLE_REPORT_REQUIRED, 'A police or traffic accident report is required for a motorcycle accident claim.', HardDisqualifierEvidenceRule.MOTORCYCLE_HELMET));
      } else if (motorcycle.findings?.helmetStatus === 'not_worn') {
        findings.push(finding(HardDisqualifierReasonCode.NO_HELMET, 'The authorized accident report states that the motorcycle rider was not wearing a helmet.', HardDisqualifierEvidenceRule.MOTORCYCLE_HELMET, { evidenceId: motorcycle.id }));
      } else if (motorcycle.findings?.helmetStatus !== 'worn') {
        findings.push(finding(HardDisqualifierReasonCode.MOTORCYCLE_REPORT_REQUIRED, 'The police or traffic accident report must clearly record helmet use before approval.', HardDisqualifierEvidenceRule.MOTORCYCLE_HELMET, { evidenceId: motorcycle.id }));
      }
    }
  }
  const impairment = latestEvidence(evidence, HardDisqualifierEvidenceRule.IMPAIRMENT);
  if (['dui', 'dangerous_drug'].includes(impairment?.findings?.impairmentStatus)) findings.push(finding(HardDisqualifierReasonCode.IMPAIRMENT, 'Authorized evidence records alcohol or dangerous-drug impairment for this incident.', HardDisqualifierEvidenceRule.IMPAIRMENT, { evidenceId: impairment.id }));
  const activeCrime = latestEvidence(evidence, HardDisqualifierEvidenceRule.ACTIVE_CRIME);
  if (activeCrime?.findings?.offenseStatus === 'active') findings.push(finding(HardDisqualifierReasonCode.ACTIVE_CRIME, 'Authorized law-enforcement or court evidence records an active crime offense connected to this request.', HardDisqualifierEvidenceRule.ACTIVE_CRIME, { evidenceId: activeCrime.id }));
  const armed = configuration.rules?.armedGroup || {};
  const armedDecision = latestEvidence(evidence, HardDisqualifierEvidenceRule.ARMED_GROUP);
  if (armed.enabled === true && armedDecision?.findings?.decision === 'restricted') findings.push(finding(HardDisqualifierReasonCode.ARMED_GROUP, 'The client- and legal-approved documented process returned a restricted decision.', HardDisqualifierEvidenceRule.ARMED_GROUP, { evidenceId: armedDecision.id }));
  const blocking = findings.filter((item) => item.blocking);
  const outcome = blocking.length ? (blocking.some((item) => item.code === HardDisqualifierReasonCode.MOTORCYCLE_REPORT_REQUIRED) ? HardDisqualifierOutcome.EVIDENCE_REQUIRED : HardDisqualifierOutcome.BLOCKED)
    : findings.length ? HardDisqualifierOutcome.HUMAN_REVIEW_REQUIRED : HardDisqualifierOutcome.CLEAR;
  return {
    outcome, approvalAllowed: outcome === HardDisqualifierOutcome.CLEAR,
    reasonCodes: [...new Set(findings.map((item) => item.code))], findings, requiredEvidence,
    evaluatorVersion: 'hard-disqualifiers-1', policyVersionId: policy?.id || null,
    policyVersion: policy?.policy_version || policy?.policyVersion || null,
    evidenceFingerprint: hardDisqualifierFingerprint({ request, evidence, policy }),
    evaluatedAt: new Date(now).toISOString(),
  };
}
