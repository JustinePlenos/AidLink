export const PolicyReasonCode = Object.freeze({
  FOUNDATION_ONLY: 'POLICY_FOUNDATION_ONLY',
  NOT_CONFIGURED: 'POLICY_NOT_CONFIGURED',
  EVIDENCE_REVIEW_REQUIRED: 'EVIDENCE_REVIEW_REQUIRED',
  INPUT_INCOMPLETE: 'POLICY_INPUT_INCOMPLETE',
  LEGACY_METADATA_DEFAULTED: 'LEGACY_REQUEST_METADATA_DEFAULTED',
});

export const PolicyDecisionArea = Object.freeze({
  ELIGIBILITY: 'eligibility',
  COVERAGE: 'coverage',
  EXPIRY: 'expiry',
  BUDGET: 'budget',
});

export const PolicyEvaluationOutcome = Object.freeze({
  ADVISORY: 'advisory',
  REVIEW_REQUIRED: 'review_required',
  NOT_APPLICABLE: 'not_applicable',
});

const knownReasonCodes = new Set(Object.values(PolicyReasonCode));

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export class PolicyEvaluator {
  async evaluate(_context) {
    throw new Error('PolicyEvaluator.evaluate must be implemented.');
  }
}

export class AdvisoryPolicyEvaluator extends PolicyEvaluator {
  constructor({ name = 'aidlink-deterministic-policy', version = 'foundation-1' } = {}) {
    super();
    this.name = name;
    this.version = version;
  }

  async evaluate(context) {
    const policy = context.policy || null;
    const finding = policy
      ? { code: PolicyReasonCode.FOUNDATION_ONLY, area: 'system', severity: 'information', blocking: false }
      : { code: PolicyReasonCode.NOT_CONFIGURED, area: 'system', severity: 'review', blocking: false };
    return {
      evaluatorName: this.name,
      evaluatorVersion: this.version,
      outcome: policy ? PolicyEvaluationOutcome.ADVISORY : PolicyEvaluationOutcome.REVIEW_REQUIRED,
      policyVersionId: policy?.id || null,
      policyVersion: policy?.policy_version || policy?.policyVersion || null,
      findings: [finding],
      requiredReviews: policy ? [] : [{ type: 'policy_configuration_review', reasonCode: finding.code }],
      decisions: Object.fromEntries(Object.values(PolicyDecisionArea).map((area) => [area, 'not_evaluated'])),
      evaluatedAt: new Date().toISOString(),
    };
  }
}

export function normalizePolicyEvaluation(result) {
  const findings = Array.isArray(result?.findings) ? result.findings.map((finding) => {
    if (!knownReasonCodes.has(finding?.code)) throw new Error(`Unknown policy reason code: ${finding?.code || 'missing'}.`);
    if (finding.blocking === true) throw new Error('Blocking policy findings are not enabled in the shared foundation.');
    return { ...clone(finding), blocking: false };
  }) : [];
  if (!Object.values(PolicyEvaluationOutcome).includes(result?.outcome)) throw new Error('Unsupported policy evaluation outcome.');
  const decisions = clone(result.decisions || {});
  for (const area of Object.values(PolicyDecisionArea)) {
    if ((decisions[area] || 'not_evaluated') !== 'not_evaluated') {
      throw new Error('The foundation evaluator cannot make eligibility, coverage, expiry, or budget decisions yet.');
    }
    decisions[area] = 'not_evaluated';
  }
  return Object.freeze({
    evaluatorName: String(result.evaluatorName || ''),
    evaluatorVersion: String(result.evaluatorVersion || ''),
    outcome: result.outcome,
    policyVersionId: result.policyVersionId || null,
    policyVersion: result.policyVersion || null,
    findings,
    requiredReviews: clone(result.requiredReviews || []),
    decisions,
    evaluatedAt: result.evaluatedAt || new Date().toISOString(),
  });
}

export async function evaluatePolicyOnBackend(context, evaluator = new AdvisoryPolicyEvaluator()) {
  if (!context?.request?.id) throw new Error('A persisted request is required for policy evaluation.');
  return normalizePolicyEvaluation(await evaluator.evaluate(clone(context)));
}

export function normalizeLegacyPolicyMetadata(request) {
  const decisionSnapshot = request?.decisionSnapshot && typeof request.decisionSnapshot === 'object' && !Array.isArray(request.decisionSnapshot)
    ? clone(request.decisionSnapshot)
    : {};
  return {
    ...clone(request || {}),
    originatingOfficeId: request?.originatingOfficeId || null,
    policyVersion: request?.policyVersion || decisionSnapshot.policyVersion || null,
    policyFindings: Array.isArray(request?.policyFindings) ? clone(request.policyFindings) : [],
    requiredReviews: Array.isArray(request?.requiredReviews) ? clone(request.requiredReviews) : [],
    decisionSnapshot,
  };
}
