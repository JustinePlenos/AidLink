import crypto from 'crypto';
import { WorkflowEvaluationRepository } from './repositoryContracts.js';
import { evaluateHardDisqualifiers } from '../services/hardDisqualifierService.js';
import { calculateCoverageMatrix } from '../services/coverageMatrixService.js';
import { normalizePolicyRollout, rolloutMode, rolloutRuleForReasonCode, PolicyRolloutMode } from '../services/policyRolloutService.js';

const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const fingerprint = (value) => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
async function audit(client, entry) {
  await client.query(`INSERT INTO audit_logs (id,actor_id,actor_type,action_type,affected_record_type,affected_record_id,new_value,justification) VALUES ($1,$2,'staff',$3,$4,$5,$6,$7)`, [id('audit'), entry.actorId, entry.action, entry.type, entry.recordId, entry.value, entry.justification]);
}

export class PostgresWorkflowEvaluationRepository extends WorkflowEvaluationRepository {
  constructor(database) { super(); this.database = database; }

  async evaluateRequest(input) {
    const remarks = String(input.remarks || '').trim();
    if (!input.actorId || remarks.length < 10) throw Object.assign(new Error('Evaluation remarks of at least 10 characters are required.'), { code: 'EVALUATION_REMARKS_REQUIRED' });
    return this.database.withTransaction(async (client) => {
      const request = (await client.query('SELECT * FROM requests WHERE id=$1 FOR UPDATE', [input.requestId])).rows[0];
      if (!request) throw Object.assign(new Error('Request not found.'), { code: 'REQUEST_NOT_FOUND' });
      const policies = (await client.query(`SELECT DISTINCT ON (policy_key) * FROM policy_configurations WHERE policy_key IN ('hard_disqualifiers','coverage_matrix','policy_rollout') AND active=true AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now()) AND (assistance_type IS NULL OR assistance_type=$1) ORDER BY policy_key,(assistance_type IS NOT NULL) DESC,version DESC`, [request.assistance_type])).rows;
      const hardPolicy = policies.find((item) => item.policy_key === 'hard_disqualifiers') || null;
      const coveragePolicy = policies.find((item) => item.policy_key === 'coverage_matrix') || null;
      const rolloutPolicy = policies.find((item) => item.policy_key === 'policy_rollout') || null;
      const rollout = normalizePolicyRollout(rolloutPolicy?.configuration);
      const hardEvidence = (await client.query('SELECT * FROM hard_disqualifier_evidence WHERE request_id=$1 ORDER BY recorded_at', [request.id])).rows;
      const hard = evaluateHardDisqualifiers({ request, evidence: hardEvidence, policy: hardPolicy });
      const exception = (await client.query('SELECT * FROM hard_disqualifier_exceptions WHERE request_id=$1 AND evidence_fingerprint=$2 ORDER BY created_at DESC LIMIT 1', [request.id, hard.evidenceFingerprint])).rows[0];
      const hardOutcome = exception && hard.outcome === 'blocked' ? 'exception_applied' : hard.outcome;
      const coverageInput = (await client.query('SELECT * FROM coverage_input_versions WHERE request_id=$1 ORDER BY version DESC LIMIT 1', [request.id])).rows[0] || null;
      let coverage;
      if (!coveragePolicy) coverage = { outcome: 'ineligible', calculationEnabled: false, reasonCodes: ['COVERAGE_MATRIX_PENDING_CLIENT_VALUES'], adjustments: [{ code: 'COVERAGE_MATRIX_PENDING_CLIENT_VALUES', message: 'No effective coverage policy is available.' }] };
      else if (coveragePolicy.configuration?.status === 'active' && !coverageInput) coverage = { outcome: 'ineligible', calculationEnabled: true, reasonCodes: ['VERIFIED_PAYER_DATA_REQUIRED'], adjustments: [{ code: 'VERIFIED_PAYER_DATA_REQUIRED', message: 'Verified coverage and payer inputs are required.' }] };
      else coverage = calculateCoverageMatrix({ request, input: coverageInput?.input_data || {}, policy: coveragePolicy, hardDisqualifierOutcome: hardOutcome });
      const documents = (await client.query(`SELECT d.id,d.document_type,d.sha256,d.version,d.supersedes_document_id,d.metadata,d.uploaded_at,a.outcome AS analysis_outcome,a.analyzer_version FROM documents d LEFT JOIN LATERAL (SELECT * FROM document_analyses x WHERE x.document_id=d.id ORDER BY x.analyzed_at DESC LIMIT 1) a ON true WHERE d.request_id=$1 ORDER BY d.id`, [request.id])).rows;
      const budgets = (await client.query(`SELECT id,allocated_amount,reserved_amount,spent_amount,period_start,period_end,updated_at FROM budgets WHERE (assistance_type IS NULL OR assistance_type=$1) AND period_start<=current_date AND period_end>=current_date ORDER BY id`, [request.assistance_type])).rows;
      const inputFingerprint = fingerprint({ request: { assistanceType: request.assistance_type, facilityTier: request.facility_tier_snapshot, facilityResolutionId: request.facility_resolution_id, partnerPricingStatus: request.partner_pricing_status }, documents, hardEvidence, hardPolicy: hardPolicy && { version: hardPolicy.policy_version, configuration: hardPolicy.configuration }, coveragePolicy: coveragePolicy && { version: coveragePolicy.policy_version, configuration: coveragePolicy.configuration }, coverageInput: coverageInput && { id: coverageInput.id, version: coverageInput.version, input: coverageInput.input_data }, budgets });
      const flags = [];
      if (!['clear', 'exception_applied'].includes(hardOutcome)) flags.push({ code: 'WORKFLOW_EVIDENCE_REVIEW_REQUIRED', message: 'Hard-disqualifier evidence requires human review.', rolloutRule: 'hard_rejections' });
      if (!coverage.calculationEnabled || coverage.outcome === 'ineligible') {
        const payerFinding = (coverage.reasonCodes || []).some((code) => rolloutRuleForReasonCode(code) === 'payer_deductions');
        flags.push({ code: 'WORKFLOW_COVERAGE_CONFIRMATION_REQUIRED', message: 'Coverage is not ready for confirmation.', rolloutRule: payerFinding ? 'payer_deductions' : 'coverage_reductions' });
      }
      if (documents.some((item) => ['manual_review', 'review_required'].includes(item.analysis_outcome))) flags.push({ code: 'WORKFLOW_EVIDENCE_REVIEW_REQUIRED', message: 'A document-quality result requires human review.' });
      if (request.partner_pricing_status === 'locked') flags.push({ code: 'WORKFLOW_EVIDENCE_REVIEW_REQUIRED', message: 'Partner pricing remains locked pending validation.', rolloutRule: 'facility_directory' });
      const enforcedFlags = flags.filter((item) => !item.rolloutRule || rolloutMode(rollout, item.rolloutRule) === PolicyRolloutMode.ENABLED);
      const reportOnlyFlags = flags.filter((item) => item.rolloutRule && rolloutMode(rollout, item.rolloutRule) !== PolicyRolloutMode.ENABLED);
      const findings = [...hard.findings, ...flags];
      const reasonCodes = [...new Set([...hard.reasonCodes, ...(coverage.reasonCodes || []), ...flags.map((item) => item.code)])];
      const reportOnlyReasonCodes = [...new Set([
        ...hard.reasonCodes.filter((code) => rolloutMode(rollout, rolloutRuleForReasonCode(code) || 'hard_rejections') !== PolicyRolloutMode.ENABLED),
        ...(coverage.reasonCodes || []).filter((code) => {
          const rule = rolloutRuleForReasonCode(code) || 'coverage_reductions';
          return rolloutMode(rollout, rule) !== PolicyRolloutMode.ENABLED;
        }),
        ...reportOnlyFlags.map((item) => item.code),
      ])];
      const enforcedReasonCodes = reasonCodes.filter((code) => !reportOnlyReasonCodes.includes(code));
      const requiredEvidence = [...hard.requiredEvidence];
      if (coveragePolicy?.configuration?.status === 'active' && !coverageInput) requiredEvidence.push({ type: 'verified_coverage_inputs', reasonCode: 'VERIFIED_PAYER_DATA_REQUIRED' });
      const outcome = enforcedFlags.length ? 'human_review_required' : 'ready_for_decision';
      const evaluationId = input.id || id('workflow-evaluation');
      const policyVersion = { hardDisqualifiers: hardPolicy?.policy_version || null, coverageMatrix: coveragePolicy?.policy_version || null, rollout: rolloutPolicy?.policy_version || null };
      await client.query(`INSERT INTO workflow_policy_evaluations (id,request_id,outcome,findings,required_evidence,coverage,reason_codes,policy_versions,human_review_flags,input_fingerprint,evaluator_version,remarks,evaluated_by,rollout_snapshot,enforced_reason_codes,report_only_reason_codes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'staff-workflow-2',$11,$12,$13,$14,$15)`, [evaluationId, request.id, outcome, JSON.stringify(findings), JSON.stringify(requiredEvidence), JSON.stringify(coverage), JSON.stringify(reasonCodes), JSON.stringify(policyVersion), JSON.stringify(enforcedFlags), inputFingerprint, remarks, input.actorId, rollout, JSON.stringify(enforcedReasonCodes), JSON.stringify(reportOnlyReasonCodes)]);
      await client.query('UPDATE requests SET latest_workflow_evaluation_id=$2,updated_at=now() WHERE id=$1', [request.id, evaluationId]);
      await audit(client, { actorId: input.actorId, action: input.approvalCheck ? 'workflow_policy_reevaluated' : 'workflow_policy_evaluated', type: 'workflow_policy_evaluation', recordId: evaluationId, value: { requestId: request.id, outcome, reasonCodes, enforcedReasonCodes, reportOnlyReasonCodes, policyVersion, inputFingerprint }, justification: remarks });
      return { evaluationId, requestId: request.id, outcome, findings, requiredEvidence, coverage, reasonCodes, enforcedReasonCodes, reportOnlyReasonCodes, rolloutSnapshot: rollout, policyVersion, humanReviewFlags: enforcedFlags, reportOnlyFlags, humanReviewRequired: enforcedFlags.length > 0, inputFingerprint };
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async confirmEvaluation(input) {
    const remarks = String(input.remarks || '').trim();
    if (input.evidenceReviewed !== true || input.coverageConfirmed !== true || remarks.length < 10) throw Object.assign(new Error('Confirm evidence review and coverage, and enter remarks of at least 10 characters.'), { code: 'CONFIRMATION_DETAILS_REQUIRED' });
    return this.database.withTransaction(async (client) => {
      const evaluation = (await client.query('SELECT e.*,r.status AS request_status FROM workflow_policy_evaluations e JOIN requests r ON r.id=e.request_id WHERE e.id=$1 AND e.request_id=$2 FOR SHARE', [input.evaluationId, input.requestId])).rows[0];
      if (!evaluation) throw Object.assign(new Error('Workflow evaluation not found.'), { code: 'EVALUATION_NOT_FOUND' });
      if (evaluation.request_status !== 'under_review') throw Object.assign(new Error('Move the request under review before confirming evidence and coverage.'), { code: 'INVALID_STATE' });
      if (evaluation.outcome !== 'ready_for_decision') throw Object.assign(new Error('Resolve all human-review findings before confirming coverage.'), { code: 'EVALUATION_NOT_READY' });
      const confirmationId = input.id || id('workflow-confirmation');
      const result = (await client.query(`INSERT INTO workflow_evaluation_confirmations (id,evaluation_id,request_id,evidence_reviewed,coverage_confirmed,remarks,confirmed_by) VALUES ($1,$2,$3,true,true,$4,$5) RETURNING *`, [confirmationId, evaluation.id, input.requestId, remarks, input.actorId])).rows[0];
      await client.query('UPDATE requests SET latest_workflow_confirmation_id=$2,updated_at=now() WHERE id=$1', [input.requestId, confirmationId]);
      await audit(client, { actorId: input.actorId, action: 'workflow_coverage_confirmed', type: 'workflow_evaluation_confirmation', recordId: confirmationId, value: { requestId: input.requestId, evaluationId: evaluation.id, inputFingerprint: evaluation.input_fingerprint }, justification: remarks });
      return result;
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async validateForApproval(input) {
    const confirmed = (await this.database.query(`SELECT c.*,e.input_fingerprint FROM workflow_evaluation_confirmations c JOIN workflow_policy_evaluations e ON e.id=c.evaluation_id WHERE c.request_id=$1 ORDER BY c.confirmed_at DESC LIMIT 1`, [input.requestId])).rows[0];
    const current = await this.evaluateRequest({ ...input, approvalCheck: true, remarks: 'Automatic policy re-evaluation immediately before approval.' });
    if (!confirmed) return { approvalAllowed: false, code: 'WORKFLOW_EVALUATION_REQUIRED', message: 'Evaluate the request and confirm evidence and coverage before approval.', current };
    if (confirmed.input_fingerprint !== current.inputFingerprint) return { approvalAllowed: false, code: 'WORKFLOW_EVALUATION_CHANGED', message: 'Documents, policy, deductions, or budget changed. Review and confirm the new evaluation before approval.', current };
    if (current.humanReviewRequired) return { approvalAllowed: false, code: 'WORKFLOW_EVALUATION_REQUIRED', message: 'The current evaluation still requires human review.', current };
    return { approvalAllowed: true, current, confirmationId: confirmed.id };
  }

  async getRequestHistory({ requestId }) {
    const [evaluations, confirmations] = await Promise.all([this.database.query('SELECT * FROM workflow_policy_evaluations WHERE request_id=$1 ORDER BY evaluated_at DESC', [requestId]), this.database.query('SELECT * FROM workflow_evaluation_confirmations WHERE request_id=$1 ORDER BY confirmed_at DESC', [requestId])]);
    return { evaluations: evaluations.rows, confirmations: confirmations.rows };
  }

  async recordDecisionComparison({ requestId, actorId, staffDecision }) {
    if (!['approved', 'denied'].includes(staffDecision)) throw new Error('A final staff decision is required for report-only comparison.');
    return this.database.withTransaction(async (client) => {
      const evaluation = (await client.query('SELECT * FROM workflow_policy_evaluations WHERE request_id=$1 ORDER BY evaluated_at DESC LIMIT 1', [requestId])).rows[0];
      if (!evaluation) return null;
      const coverage = evaluation.coverage || {};
      const reasons = Array.isArray(evaluation.reason_codes) ? evaluation.reason_codes : [];
      const predictedDecision = coverage.outcome === 'ineligible' || reasons.some((code) => rolloutRuleForReasonCode(code) === 'hard_rejections') ? 'deny_or_review' : 'approve';
      const matched = (predictedDecision === 'approve' && staffDecision === 'approved') || (predictedDecision === 'deny_or_review' && staffDecision === 'denied');
      const comparisonId = id('policy-comparison');
      await client.query(`INSERT INTO policy_decision_comparisons (id,request_id,workflow_evaluation_id,predicted_decision,staff_decision,matched,reason_codes,rollout_snapshot,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [comparisonId, requestId, evaluation.id, predictedDecision, staffDecision, matched, JSON.stringify(reasons), evaluation.rollout_snapshot || {}, actorId]);
      await audit(client, { actorId, action: 'policy_report_only_decision_compared', type: 'policy_decision_comparison', recordId: comparisonId, value: { requestId, predictedDecision, staffDecision, matched, reasonCodes: reasons }, justification: 'Compare report-only policy output with the Case Worker decision.' });
      return { id: comparisonId, requestId, predictedDecision, staffDecision, matched };
    });
  }

  async listDecisionComparisons({ limit = 100 } = {}) {
    const result = await this.database.query('SELECT * FROM policy_decision_comparisons ORDER BY compared_at DESC LIMIT $1', [Math.min(500, Math.max(1, Number(limit) || 100))]);
    return result.rows;
  }
}
