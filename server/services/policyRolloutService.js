export const PolicyRolloutMode = Object.freeze({
  DISABLED: 'disabled',
  REPORT_ONLY: 'report_only',
  ENABLED: 'enabled',
});

export const policyRolloutRules = Object.freeze([
  'thresholds',
  'facility_directory',
  'residency',
  'cooldown',
  'document_year',
  'coverage_reductions',
  'hard_rejections',
  'payer_deductions',
  'budget',
]);

const defaultRule = () => ({ mode: PolicyRolloutMode.REPORT_ONLY, approvalReference: null });
export const defaultPolicyRollout = Object.freeze({
  rules: Object.fromEntries(policyRolloutRules.map((rule) => [rule, defaultRule()])),
});

const ruleByReasonCode = new Map([
  ['ORIGINATING_OFFICE_REQUIRED', 'residency'], ['ORIGINATING_OFFICE_INACTIVE', 'residency'],
  ['RESIDENCY_OUTSIDE_BOUNDARY', 'residency'], ['RESIDENCY_REVIEW_REQUIRED', 'residency'],
  ['PATIENT_COOLDOWN_ACTIVE', 'cooldown'], ['DOCUMENT_YEAR_EXPIRED', 'document_year'],
  ['BUDGET_DEPLETED', 'budget'], ['BUDGET_POOL_NOT_CONFIGURED', 'budget'], ['ASSISTANCE_LIMIT_EXCEEDED', 'budget'],
]);

export function normalizePolicyRollout(configuration) {
  const configured = configuration?.rules && typeof configuration.rules === 'object' ? configuration.rules : {};
  return {
    rules: Object.fromEntries(policyRolloutRules.map((rule) => {
      const value = configured[rule] || {};
      const mode = Object.values(PolicyRolloutMode).includes(value.mode) ? value.mode : PolicyRolloutMode.REPORT_ONLY;
      return [rule, { mode, approvalReference: String(value.approvalReference || '').trim() || null }];
    })),
  };
}

export function validatePolicyRolloutConfiguration(configuration, previousConfiguration = null) {
  if (!configuration?.rules || typeof configuration.rules !== 'object' || Array.isArray(configuration.rules)) {
    throw Object.assign(new Error('Policy rollout configuration must contain a rules object.'), { code: 'INVALID_POLICY_ROLLOUT' });
  }
  const unknown = Object.keys(configuration.rules).filter((rule) => !policyRolloutRules.includes(rule));
  if (unknown.length) throw Object.assign(new Error(`Unsupported rollout rule: ${unknown.join(', ')}.`), { code: 'INVALID_POLICY_ROLLOUT' });
  const normalized = normalizePolicyRollout(configuration);
  for (const [rule, value] of Object.entries(normalized.rules)) {
    if (value.mode === PolicyRolloutMode.ENABLED && !value.approvalReference) {
      throw Object.assign(new Error(`Client approval reference is required before enabling ${rule.replaceAll('_', ' ')}.`), { code: 'CLIENT_APPROVAL_REQUIRED' });
    }
  }
  const previous = normalizePolicyRollout(previousConfiguration);
  const newlyEnabled = policyRolloutRules.filter((rule) => previous.rules[rule].mode !== PolicyRolloutMode.ENABLED && normalized.rules[rule].mode === PolicyRolloutMode.ENABLED);
  if (newlyEnabled.length > 1) {
    throw Object.assign(new Error('Enable only one policy rule per published version so results can be monitored and rolled back safely.'), { code: 'ONE_RULE_AT_A_TIME' });
  }
  return normalized;
}

export function rolloutMode(configuration, rule) {
  return normalizePolicyRollout(configuration).rules[rule]?.mode || PolicyRolloutMode.REPORT_ONLY;
}

export function rolloutRuleForReasonCode(reasonCode) {
  if (ruleByReasonCode.has(reasonCode)) return ruleByReasonCode.get(reasonCode);
  if (/^(NO_HELMET|DUI|DANGEROUS_DRUG|ACTIVE_CRIME|ARMED_GROUP|HARD_)/.test(reasonCode)) return 'hard_rejections';
  if (/^(VERIFIED_PAYER|PAYER_|DEDUCTION_)/.test(reasonCode)) return 'payer_deductions';
  if (/^(COVERAGE_|ROOM_|MEDICINE_|SUBSIDY_|NON_FORMULARY|OUTSIDE_PHARMACY)/.test(reasonCode)) return 'coverage_reductions';
  if (/^(FACILITY_|CHO_|PRIVATE_PRESCRIPTION|PARTNER_PRICING)/.test(reasonCode)) return 'facility_directory';
  return null;
}

const alwaysEnforcedSubmissionCodes = new Set([
  'AUTHENTICATED_APPLICANT_MISMATCH', 'BENEFICIARY_RELATIONSHIP_INVALID', 'DUPLICATE_SUBMISSION',
  'REQUIRED_DOCUMENT_MISSING', 'DOCUMENT_QUALITY_FAILED', 'RECEIPT_CONTEXT_INVALID',
]);

export function applySubmissionRollout(rawResult, configuration) {
  const rollout = normalizePolicyRollout(configuration);
  const enforcedReasonCodes = [];
  const reportOnlyReasonCodes = [];
  for (const code of rawResult.reasonCodes || []) {
    const rule = rolloutRuleForReasonCode(code);
    if (!rule || alwaysEnforcedSubmissionCodes.has(code) || rollout.rules[rule].mode === PolicyRolloutMode.ENABLED) enforcedReasonCodes.push(code);
    else reportOnlyReasonCodes.push(code);
  }
  const enforced = new Set(enforcedReasonCodes);
  const correctionCodes = new Set(['REQUIRED_DOCUMENT_MISSING', 'DOCUMENT_QUALITY_FAILED', 'RECEIPT_CONTEXT_INVALID', 'DOCUMENT_YEAR_EXPIRED']);
  const blockingCodes = new Set(['AUTHENTICATED_APPLICANT_MISMATCH', 'BENEFICIARY_RELATIONSHIP_INVALID', 'DUPLICATE_SUBMISSION', 'PATIENT_COOLDOWN_ACTIVE', 'ORIGINATING_OFFICE_REQUIRED', 'ORIGINATING_OFFICE_INACTIVE', 'RESIDENCY_OUTSIDE_BOUNDARY', 'BUDGET_DEPLETED']);
  const outcome = [...enforced].some((code) => blockingCodes.has(code)) ? 'blocked'
    : [...enforced].some((code) => correctionCodes.has(code)) ? 'correction_required'
      : (rawResult.outcome === 'human_review_required' || reportOnlyReasonCodes.length) ? 'human_review_required' : 'passed';
  return {
    ...rawResult,
    outcome,
    rawOutcome: rawResult.outcome,
    enforcementMode: reportOnlyReasonCodes.length ? PolicyRolloutMode.REPORT_ONLY : PolicyRolloutMode.ENABLED,
    enforcedReasonCodes,
    reportOnlyReasonCodes,
    rolloutSnapshot: rollout,
  };
}

export function applicantPolicyOutcome(source = {}) {
  const status = String(source.status || '');
  const letterStatus = source.protectedLetter?.status || source.protected_letter_status;
  const coverage = source.coverage || source.coverageResult || {};
  const reportCodes = source.reportOnlyReasonCodes || source.report_only_reason_codes || source.decisionSnapshot?.reportOnlyReasonCodes || [];
  if (letterStatus === 'expired') return { state: 'guarantee_letter_expired', title: 'Claiming access expired', message: 'Your claiming letter is no longer available because its access period ended.', nextStep: 'Contact the AidLink help desk or your Case Worker for the next step.' };
  if (status === 'correction_requested') return { state: 'correction_required', title: 'Corrections needed', message: 'A Case Worker needs you to replace one or more documents before review can continue.', nextStep: 'Open the correction request, replace only the listed documents, then submit your corrections.' };
  if ((source.reasonCodes || []).includes('PATIENT_COOLDOWN_ACTIVE')) return { state: 'cooldown', title: 'Please wait before sending the same request', message: `A request for the same patient and assistance type was submitted recently.${source.cooldownEndDate ? ` You may try again after ${new Date(source.cooldownEndDate).toLocaleDateString('en-PH')}.` : ''}`, nextStep: source.existingRequestReference ? `Check request ${source.existingRequestReference} for updates.` : 'Check your request history for updates.' };
  if ((source.reasonCodes || []).includes('BUDGET_DEPLETED')) return { state: 'budget_block', title: 'Funds are not currently available', message: 'Funds for this assistance type are not available at this time.', nextStep: 'Contact the AidLink help desk or try again when a new budget period opens.' };
  if (coverage.outcome === 'partially_covered' || source.coverageMatrixOutcome === 'partially_covered') return { state: 'partial_coverage', title: 'Partial assistance calculated', message: 'Current approved rules may cover only part of the verified remaining balance.', nextStep: 'A Case Worker will confirm the amount before the request is finalized.', coveredAmount: coverage.coveredAmount ?? source.coveredAmount ?? null, netRemainingBalance: coverage.netRemainingBalance ?? source.netRemainingBalance ?? null };
  if (coverage.outcome === 'ineligible' || source.coverageMatrixOutcome === 'ineligible') return { state: 'ineligible', title: 'Request needs a final eligibility decision', message: 'The current review indicates that this request may not qualify under the approved rules.', nextStep: 'A Case Worker will confirm the result and provide the next step.' };
  if (source.policyGateOutcome === 'human_review_required' || source.humanReviewRequired || reportCodes.length) return { state: 'human_review', title: 'Staff review needed', message: 'A Case Worker needs to review the submitted information. No final decision has been made.', nextStep: 'Watch this request and your notifications for an update.' };
  return null;
}
