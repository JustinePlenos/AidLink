import crypto from 'crypto';
import { AidLinkRepository, CoverageMatrixRepository, FacilityRoutingRepository, HardDisqualifierRepository, PolicyRepository, UnitOfWork } from './repositoryContracts.js';
import {
  cooldownEnd,
  evaluateSubmissionPolicyGates,
  isActiveRequestStatus,
  patientIdentityKey,
  submissionFingerprint,
  SubmissionGateOutcome,
  SubmissionGateReasonCode,
} from '../services/submissionPolicyGateService.js';
import {
  privatePrescriptionPricingState,
  resolveFacilityEvidence,
  validateFacilityDirectory,
} from '../services/facilityRoutingService.js';
import {
  evaluateHardDisqualifiers,
  HardDisqualifierOutcome,
  HardDisqualifierReasonCode,
  validateHardDisqualifierEvidence,
  validateHardDisqualifierPolicyConfiguration,
} from '../services/hardDisqualifierService.js';
import { calculateCoverageMatrix, validateCoveragePolicyConfiguration } from '../services/coverageMatrixService.js';
import { PostgresWorkflowEvaluationRepository } from './workflowRepository.js';
import { budgetAvailability, guaranteeLetterExpiry, validateBudgetPool } from '../services/budgetAllocationService.js';
import { applySubmissionRollout, validatePolicyRolloutConfiguration } from '../services/policyRolloutService.js';

const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;

async function appendAudit(client, entry) {
  await client.query(`
    INSERT INTO audit_logs (
      id, actor_id, actor_type, action_type, affected_record_type,
      affected_record_id, old_value, new_value, justification, correlation_id, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  `, [
    entry.id || id('audit'), entry.actorId || 'system', entry.actorType || 'system', entry.actionType,
    entry.recordType, entry.recordId, entry.oldValue ?? null, entry.newValue ?? null,
    entry.justification ?? null, entry.correlationId ?? null, entry.metadata || {},
  ]);
}

async function reserveBudgetInTransaction(client, input) {
  const existing = await client.query(
    'SELECT * FROM budget_reservations WHERE budget_id = $1 AND idempotency_key = $2',
    [input.budgetId, input.idempotencyKey],
  );
  if (existing.rows[0]) return { reservation: existing.rows[0], replayed: true };
  const budgetResult = await client.query('SELECT * FROM budgets WHERE id = $1 FOR UPDATE', [input.budgetId]);
  const budget = budgetResult.rows[0];
  if (!budget) throw Object.assign(new Error('Budget not found.'), { code: 'BUDGET_NOT_FOUND' });
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error('Reservation amount must be greater than zero.'), { code: 'INVALID_AMOUNT' });
  const effectiveAt = new Date(input.effectiveAt || Date.now());
  if (budget.active === false || new Date(`${budget.period_start}T00:00:00.000Z`) > effectiveAt || new Date(`${budget.period_end}T23:59:59.999Z`) < effectiveAt) throw Object.assign(new Error('The selected budget pool is not effective for this release date.'), { code: 'BUDGET_NOT_EFFECTIVE' });
  const availability = budgetAvailability(budget, amount);
  if (!availability.allowed) {
    const message = availability.reasonCode === 'ASSISTANCE_LIMIT_EXCEEDED'
      ? `The approved amount exceeds this pool's per-request assistance limit.`
      : `The city budget available for this assistance has reached its depletion threshold. Try again after an administrator funds a new effective pool.`;
    throw Object.assign(new Error(message), { code: availability.reasonCode, budget: availability });
  }

  const reservationId = input.id || id('budget-reservation');
  const inserted = await client.query(`
    INSERT INTO budget_reservations (id, budget_id, request_id, amount, idempotency_key, guarantee_letter_id, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
  `, [reservationId, input.budgetId, input.requestId, amount, input.idempotencyKey, input.guaranteeLetterId || null, input.expiresAt || null]);
  await client.query('UPDATE budgets SET reserved_amount = reserved_amount + $2, updated_at = now() WHERE id = $1', [input.budgetId, amount]);
  await appendAudit(client, {
    actorId: input.actorId, actorType: input.actorType || 'staff', actionType: 'budget_reserved',
    recordType: 'budget_reservation', recordId: reservationId, newValue: { requestId: input.requestId, amount, budgetId: input.budgetId, guaranteeLetterId: input.guaranteeLetterId || null, expiresAt: input.expiresAt || null, remainingAllocatable: availability.allocatable - amount },
    justification: input.justification, correlationId: input.correlationId,
  });
  return { reservation: inserted.rows[0], replayed: false };
}

async function effectiveBudgetPool(client, assistanceType, at = new Date(), { lock = false } = {}) {
  const query = `SELECT * FROM budgets WHERE active=true AND period_start <= $2::date AND period_end >= $2::date AND (assistance_type=$1 OR assistance_type IS NULL) ORDER BY (assistance_type IS NOT NULL) DESC, period_start DESC, created_at DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`;
  return (await client.query(query, [assistanceType, new Date(at).toISOString().slice(0, 10)])).rows[0] || null;
}

async function releaseReservationInTransaction(client, reservation, input = {}) {
  if (!reservation || reservation.status !== 'reserved') return { reservation, replayed: true };
  const nextStatus = input.status === 'released' ? 'released' : 'expired';
  await client.query(`UPDATE budget_reservations SET status=$2,released_at=$3,release_reason=$4,updated_at=$3 WHERE id=$1`, [reservation.id, nextStatus, input.releasedAt || new Date(), input.reason || 'Unused Guarantee Letter allocation returned to the active budget pool.']);
  await client.query('UPDATE budgets SET reserved_amount=reserved_amount-$2,updated_at=now() WHERE id=$1', [reservation.budget_id, reservation.amount]);
  await appendAudit(client, { actorId: input.actorId || 'system', actorType: input.actorType || 'system', actionType: 'budget_allocation_released', recordType: 'budget_reservation', recordId: reservation.id, oldValue: { status: 'reserved', amount: Number(reservation.amount) }, newValue: { status: nextStatus, budgetId: reservation.budget_id, returnedAmount: Number(reservation.amount), letterId: reservation.guarantee_letter_id }, justification: input.reason || 'Unused Guarantee Letter allocation returned to the active budget pool.' });
  return { reservation: { ...reservation, status: nextStatus }, replayed: false };
}

async function evaluateHardDisqualifierInTransaction(client, input) {
  const request = (await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [input.requestId])).rows[0];
  if (!request) throw Object.assign(new Error('Request not found.'), { code: 'REQUEST_NOT_FOUND' });
  const policy = (await client.query(`
    SELECT * FROM policy_configurations
    WHERE policy_key = 'hard_disqualifiers' AND active = true
      AND effective_from <= now() AND (effective_until IS NULL OR effective_until > now())
      AND (assistance_type IS NULL OR assistance_type = $1)
    ORDER BY (assistance_type IS NOT NULL) DESC, version DESC LIMIT 1
  `, [request.assistance_type])).rows[0] || null;
  const evidence = (await client.query(`
    SELECT * FROM hard_disqualifier_evidence WHERE request_id = $1 ORDER BY recorded_at ASC
  `, [request.id])).rows;
  const evaluation = evaluateHardDisqualifiers({ request, evidence, policy });
  const exception = (await client.query(`
    SELECT * FROM hard_disqualifier_exceptions
    WHERE request_id = $1 AND evidence_fingerprint = $2
    ORDER BY created_at DESC LIMIT 1
  `, [request.id, evaluation.evidenceFingerprint])).rows[0] || null;
  const evaluationId = input.id || id('hard-disqualifier-evaluation');
  await client.query(`
    INSERT INTO hard_disqualifier_evaluations (
      id, request_id, policy_version_id, policy_version, outcome, reason_codes,
      findings, required_evidence, evidence_fingerprint, evaluator_version,
      evaluated_by, evaluated_at, correlation_id, exception_applied_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
  `, [evaluationId, request.id, evaluation.policyVersionId, evaluation.policyVersion,
    evaluation.outcome, JSON.stringify(evaluation.reasonCodes), JSON.stringify(evaluation.findings),
    JSON.stringify(evaluation.requiredEvidence), evaluation.evidenceFingerprint, evaluation.evaluatorVersion,
    input.actorId || null, evaluation.evaluatedAt, input.correlationId || null, exception?.id || null]);
  const exceptionApplied = Boolean(exception && evaluation.outcome === HardDisqualifierOutcome.BLOCKED);
  const effectiveOutcome = exceptionApplied ? HardDisqualifierOutcome.EXCEPTION_APPLIED : evaluation.outcome;
  const reasonCodes = exceptionApplied
    ? [...new Set([...evaluation.reasonCodes, HardDisqualifierReasonCode.EXCEPTION_APPLIED])]
    : evaluation.reasonCodes;
  await client.query(`
    UPDATE requests SET hard_disqualifier_outcome = $2, hard_disqualifier_evaluation_id = $3,
      hard_disqualifier_exception_id = $4, updated_at = now() WHERE id = $1
  `, [request.id, effectiveOutcome, evaluationId, exception?.id || null]);
  await appendAudit(client, {
    actorId: input.actorId || 'system', actorType: input.actorId ? 'staff' : 'system',
    actionType: 'hard_disqualifiers_evaluated', recordType: 'request', recordId: request.id,
    oldValue: { outcome: request.hard_disqualifier_outcome, evaluationId: request.hard_disqualifier_evaluation_id },
    newValue: { outcome: effectiveOutcome, rawOutcome: evaluation.outcome, reasonCodes, evaluationId, exceptionId: exception?.id || null },
    justification: input.justification || 'Evaluate hard disqualifiers before coverage or approval.',
    correlationId: input.correlationId,
  });
  return { ...evaluation, outcome: effectiveOutcome, rawOutcome: evaluation.outcome,
    approvalAllowed: evaluation.outcome === HardDisqualifierOutcome.CLEAR || exceptionApplied,
    reasonCodes, evaluationId, exceptionId: exception?.id || null };
}

async function calculateCoverageInTransaction(client, input) {
  const request = (await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [input.requestId])).rows[0];
  if (!request) throw Object.assign(new Error('Request not found.'), { code: 'REQUEST_NOT_FOUND' });
  const policy = (await client.query(`
    SELECT * FROM policy_configurations WHERE policy_key = 'coverage_matrix' AND active = true
      AND effective_from <= now() AND (effective_until IS NULL OR effective_until > now())
      AND (assistance_type IS NULL OR assistance_type = $1)
    ORDER BY (assistance_type IS NOT NULL) DESC, version DESC LIMIT 1
  `, [request.assistance_type])).rows[0];
  if (!policy) throw Object.assign(new Error('No effective coverage-matrix policy exists.'), { code: 'COVERAGE_POLICY_NOT_FOUND' });
  const inputVersion = (await client.query('SELECT * FROM coverage_input_versions WHERE request_id = $1 ORDER BY version DESC LIMIT 1', [request.id])).rows[0];
  if (!inputVersion) throw Object.assign(new Error('Verified coverage inputs are required before calculating coverage.'), { code: 'COVERAGE_INPUT_REQUIRED' });
  const result = calculateCoverageMatrix({ request, input: inputVersion.input_data, policy, hardDisqualifierOutcome: request.hard_disqualifier_outcome });
  const snapshotId = input.id || id('coverage-snapshot');
  await client.query(`
    INSERT INTO coverage_calculation_snapshots (
      id, request_id, input_version_id, policy_version_id, policy_version,
      hard_disqualifier_evaluation_id, calculator_version, input_snapshot,
      policy_snapshot, result, calculated_by, correlation_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  `, [snapshotId, request.id, inputVersion.id, policy.id, policy.policy_version,
    request.hard_disqualifier_evaluation_id, result.calculatorVersion || 'coverage-matrix-1',
    inputVersion.input_data, policy.configuration, result, input.actorId || null, input.correlationId || null]);
  await client.query('UPDATE requests SET coverage_matrix_outcome = $2, coverage_snapshot_id = $3, updated_at = now() WHERE id = $1', [request.id, result.outcome, snapshotId]);
  await appendAudit(client, {
    actorId: input.actorId || 'system', actorType: input.actorId ? 'staff' : 'system',
    actionType: 'coverage_matrix_calculated', recordType: 'coverage_calculation_snapshot', recordId: snapshotId,
    oldValue: { outcome: request.coverage_matrix_outcome, snapshotId: request.coverage_snapshot_id },
    newValue: { requestId: request.id, outcome: result.outcome, coveredAmount: result.coveredAmount,
      netRemainingBalance: result.netRemainingBalance, reasonCodes: result.reasonCodes,
      policyVersion: policy.policy_version, inputVersion: inputVersion.version },
    justification: input.justification || 'Calculate coverage from verified inputs and the effective policy.', correlationId: input.correlationId,
  });
  return { ...result, snapshotId, inputVersionId: inputVersion.id, inputVersion: inputVersion.version, policyVersionId: policy.id };
}

export class PostgresUnitOfWork extends UnitOfWork {
  constructor(database) { super(); this.database = database; }
  transaction(work, options) { return this.database.withTransaction(work, options); }
}

export class PostgresAidLinkRepository extends AidLinkRepository {
  constructor(database) { super(); this.database = database; }

  async submitRequest(input) {
    if (!input.idempotencyKey) throw new Error('A request submission idempotency key is required.');
    return this.database.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`request:${input.applicantId}:${input.idempotencyKey}`]);
      const existing = await client.query(
        'SELECT * FROM requests WHERE applicant_id = $1 AND client_submission_id = $2',
        [input.applicantId, input.idempotencyKey],
      );
      if (existing.rows[0]) return { request: existing.rows[0], replayed: true };

      const requestId = input.id || id('request');
      const beneficiaryId = input.beneficiary?.id || id('beneficiary');
      await client.query(`
        INSERT INTO beneficiaries (
          id, requester_applicant_id, full_name, date_of_birth, address,
          relationship_to_applicant, is_requester, legacy_payload
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [beneficiaryId, input.applicantId, input.beneficiary.fullName, input.beneficiary.dateOfBirth || null,
        input.beneficiary.address || null, input.beneficiary.relationshipToApplicant || null,
        Boolean(input.beneficiary.isRequester), input.beneficiary.legacyPayload || {}]);

      const inserted = await client.query(`
        INSERT INTO requests (
          id, request_number, applicant_id, beneficiary_id, assistance_type, status,
          income_source, patient_circumstance, additional_details, facility_id,
          facility_name_snapshot, facility_type_snapshot, receipt_date, receipt_reference,
          policy_version_id, policy_version, policy_findings, required_reviews,
          decision_snapshot, originating_office_id, client_submission_id, submitted_at
        ) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,COALESCE($21,now()))
        RETURNING *
      `, [requestId, input.requestNumber, input.applicantId, beneficiaryId, input.assistanceType,
        input.incomeSource || null, input.patientCircumstance || null, input.additionalDetails || null,
        input.facilityId || null, input.facilityName || null, input.facilityType || null,
        input.receiptDate || null, input.receiptReference || null, input.policyVersionId || null,
        input.policyVersion || null, JSON.stringify(input.policyFindings || []),
        JSON.stringify(input.requiredReviews || []), input.decisionSnapshot || {},
        input.originatingOfficeId || null, input.idempotencyKey, input.submittedAt || null]);

      for (const document of input.documents || []) {
        const documentId = document.id || id('document');
        await client.query(`
          INSERT INTO documents (
            id, request_id, applicant_id, document_type, display_name, storage_provider,
            storage_key, mime_type, byte_size, sha256, uploaded_by, metadata
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `, [documentId, requestId, input.applicantId, document.documentType, document.displayName,
          document.storageProvider || 'private_filesystem', document.storageKey, document.mimeType || null,
          document.byteSize ?? null, document.sha256 || null, input.applicantId, document.metadata || {}]);
        if (document.analysis) {
          await client.query(`
            INSERT INTO document_analyses (
              id, document_id, analyzer_name, analyzer_version, outcome, warnings,
              failures, orientation, metrics, confidence, analyzed_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,now()))
          `, [document.analysis.id || id('analysis'), documentId, document.analysis.analyzerName,
            document.analysis.analyzerVersion, document.analysis.outcome, JSON.stringify(document.analysis.warnings || []),
            JSON.stringify(document.analysis.failures || []), document.analysis.orientation || null,
            document.analysis.metrics || {}, document.analysis.confidence ?? null, document.analysis.analyzedAt || null]);
        }
      }
      await appendAudit(client, {
        actorId: input.applicantId, actorType: 'applicant', actionType: 'request_submitted',
        recordType: 'request', recordId: requestId, newValue: { status: 'pending', assistanceType: input.assistanceType },
        justification: input.justification || 'Applicant submitted an assistance request.', correlationId: input.correlationId,
      });
      return { request: inserted.rows[0], replayed: false };
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async submitRequestWithPolicyGates(input) {
    if (!input.idempotencyKey) throw new Error('A request submission idempotency key is required.');
    const patientKey = patientIdentityKey(input.beneficiary);
    const fingerprint = submissionFingerprint(input);
    return this.database.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`submission-gate:${input.applicantId}:${patientKey}:${input.assistanceType}`]);
      const applicant = (await client.query('SELECT * FROM applicants WHERE id = $1 FOR UPDATE', [input.applicantId])).rows[0];
      if (!applicant) throw Object.assign(new Error('Authenticated applicant not found.'), { code: 'APPLICANT_NOT_FOUND' });
      const globalIdempotent = (await client.query(`
        SELECT r.*, b.full_name AS beneficiary_full_name, b.date_of_birth AS beneficiary_date_of_birth
        FROM requests r JOIN beneficiaries b ON b.id = r.beneficiary_id
        WHERE r.applicant_id = $1 AND r.client_submission_id = $2 LIMIT 1
      `, [input.applicantId, input.idempotencyKey])).rows[0] || null;

      const policy = (await client.query(`
        SELECT * FROM policy_configurations
        WHERE policy_key = 'submission_gates' AND active = true
          AND (assistance_type IS NULL OR assistance_type = $1)
          AND effective_from <= $2 AND (effective_until IS NULL OR effective_until > $2)
        ORDER BY (assistance_type IS NOT NULL) DESC, version DESC LIMIT 1
      `, [input.assistanceType, input.now || new Date()])).rows[0] || null;
      const configuration = policy?.configuration || {};
      const cooldownDays = Number(configuration.cooldownDays ?? input.cooldownDays ?? 30);

      await client.query(`
        INSERT INTO request_submission_guards (applicant_id, patient_identity_key, assistance_type)
        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING
      `, [input.applicantId, patientKey, input.assistanceType]);
      const guard = (await client.query(`
        SELECT * FROM request_submission_guards
        WHERE applicant_id = $1 AND patient_identity_key = $2 AND assistance_type = $3 FOR UPDATE
      `, [input.applicantId, patientKey, input.assistanceType])).rows[0];

      const history = (await client.query(`
        SELECT r.*, b.full_name AS beneficiary_full_name, b.date_of_birth AS beneficiary_date_of_birth
        FROM requests r JOIN beneficiaries b ON b.id = r.beneficiary_id
        WHERE r.applicant_id = $1 AND r.assistance_type = $2
        ORDER BY r.submitted_at DESC
      `, [input.applicantId, input.assistanceType])).rows
        .filter((row) => row.patient_identity_key === patientKey || patientIdentityKey({
          fullName: row.beneficiary_full_name,
          dateOfBirth: row.beneficiary_date_of_birth,
        }) === patientKey);
      const idempotent = globalIdempotent || history.find((row) => row.client_submission_id === input.idempotencyKey) || null;
      const active = idempotent || history.find((row) => isActiveRequestStatus(row.status)) || null;
      const latest = history[0] || null;
      const calculatedCooldown = latest ? cooldownEnd(latest.submitted_at, cooldownDays) : null;
      const cooldownEndDate = guard?.cooldown_until && new Date(guard.cooldown_until) > (calculatedCooldown || new Date(0))
        ? new Date(guard.cooldown_until)
        : calculatedCooldown;

      const officeId = input.originatingOfficeId || applicant.originating_office_id || null;
      const office = officeId
        ? (await client.query(`
          SELECT o.*,
                 COALESCE(v.boundary, o.residency_boundary) AS residency_boundary,
                 COALESCE(v.version, o.boundary_version) AS boundary_version
          FROM offices o
          LEFT JOIN LATERAL (
            SELECT boundary, version FROM office_boundary_versions
            WHERE office_id = o.id AND effective_from <= $2
              AND (effective_until IS NULL OR effective_until > $2)
            ORDER BY version DESC LIMIT 1
          ) v ON true
          WHERE o.id = $1
        `, [officeId, input.now || new Date()])).rows[0] || null
        : null;
      const priorOverride = (await client.query(`
        SELECT o.actor_id, o.reason, o.created_at, e.originating_office_id
        FROM submission_policy_gate_overrides o
        JOIN submission_policy_gate_evaluations e ON e.id = o.evaluation_id
        WHERE e.applicant_id = $1 AND e.submission_fingerprint = $2
        ORDER BY o.created_at DESC LIMIT 1
      `, [input.applicantId, fingerprint])).rows[0] || null;
      const residencyOverride = priorOverride && priorOverride.originating_office_id === officeId
        ? { authorized: true, actorId: priorOverride.actor_id, reason: priorOverride.reason }
        : null;

      let gateResult = evaluateSubmissionPolicyGates({
        authenticatedApplicantId: input.authenticatedApplicantId,
        input: { ...input, applicantId: input.applicantId },
        originatingOffice: office,
        requiredDocuments: input.requiredDocuments || [],
        calendarYearDocumentTypes: configuration.calendarYearDocumentTypes || [],
        existingActiveRequest: active,
        cooldownEndDate,
        residencyOverride,
        now: input.now || new Date(),
      });
      const applicableBudget = await effectiveBudgetPool(client, input.assistanceType, input.now || new Date());
      if (gateResult.outcome === SubmissionGateOutcome.PASSED && applicableBudget) {
        const budget = budgetAvailability(applicableBudget);
        if (!budget.allowed) gateResult = { ...gateResult, outcome: SubmissionGateOutcome.BLOCKED, reasonCodes: [...gateResult.reasonCodes, 'BUDGET_DEPLETED'], findings: [...gateResult.findings, { code: 'BUDGET_DEPLETED', message: 'The city budget for this assistance type is temporarily depleted. Contact the LINGAP help desk or submit after a new budget period is opened.', field: 'assistanceType', budgetPoolId: applicableBudget.id }], budget: { poolId: applicableBudget.id, available: budget.available, depletionThreshold: budget.threshold } };
      }
      const rolloutPolicy = (await client.query(`
        SELECT * FROM policy_configurations
        WHERE policy_key = 'policy_rollout' AND active = true
          AND (assistance_type IS NULL OR assistance_type = $1)
          AND effective_from <= $2 AND (effective_until IS NULL OR effective_until > $2)
        ORDER BY (assistance_type IS NOT NULL) DESC, version DESC LIMIT 1
      `, [input.assistanceType, input.now || new Date()])).rows[0] || null;
      gateResult = applySubmissionRollout(gateResult, rolloutPolicy?.configuration);
      const evaluationId = input.evaluationId || id('submission-gate');
      const candidateKey = crypto.createHash('sha256').update(`${patientKey}:${input.assistanceType}`).digest('hex');
      const inputSnapshot = {
        beneficiaryType: input.beneficiaryType,
        patientIdentityKey: patientKey,
        assistanceType: input.assistanceType,
        originatingOfficeId: officeId,
        requiredDocuments: input.requiredDocuments || [],
        documents: (input.documents || []).map((document) => ({
          id: document.id, documentType: document.documentType,
          qualityOutcome: document.analysis?.outcome || (document.analysis?.accepted ? 'accepted' : 'rejected'),
          documentDate: document.documentDate || document.metadata?.documentDate || null,
        })),
        receipt: input.facilityEvidence ? {
          receiptDate: input.facilityEvidence.receiptDate,
          referenceNumber: input.facilityEvidence.referenceNumber,
          receiptDocumentId: input.facilityEvidence.receiptDocumentId,
        } : null,
      };
      await client.query(`
        INSERT INTO submission_policy_gate_evaluations (
          id, applicant_id, candidate_key, existing_request_id, existing_request_reference,
          submission_fingerprint, originating_office_id, boundary_version,
          policy_version_id, policy_version, outcome, reason_codes, findings,
          required_reviews, cooldown_end_date, input_snapshot, evaluator_version, evaluated_at,
          raw_outcome, enforcement_mode, enforced_reason_codes, report_only_reason_codes, rollout_snapshot
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      `, [evaluationId, input.applicantId, candidateKey, active?.id || latest?.id || null,
        gateResult.existingRequestReference, fingerprint, officeId, office?.boundary_version || null,
        policy?.id || null, policy?.policy_version || null, gateResult.outcome,
        JSON.stringify(gateResult.reasonCodes), JSON.stringify(gateResult.findings),
        JSON.stringify(gateResult.requiredReviews), gateResult.cooldownEndDate,
        inputSnapshot, gateResult.evaluatorVersion, gateResult.evaluatedAt,
        gateResult.rawOutcome, gateResult.enforcementMode, JSON.stringify(gateResult.enforcedReasonCodes),
        JSON.stringify(gateResult.reportOnlyReasonCodes), gateResult.rolloutSnapshot]);
      await appendAudit(client, {
        actorId: input.applicantId, actorType: 'applicant', actionType: 'submission_policy_gates_evaluated',
        recordType: 'submission_policy_gate_evaluation', recordId: evaluationId,
        newValue: { outcome: gateResult.outcome, rawOutcome: gateResult.rawOutcome, reasonCodes: gateResult.reasonCodes,
          enforcedReasonCodes: gateResult.enforcedReasonCodes, reportOnlyReasonCodes: gateResult.reportOnlyReasonCodes,
          existingRequestReference: gateResult.existingRequestReference, cooldownEndDate: gateResult.cooldownEndDate,
          originatingOfficeId: officeId, policyVersion: policy?.policy_version || null,
          rolloutPolicyVersion: rolloutPolicy?.policy_version || null },
        justification: 'Backend pre-submission policy gates evaluated.', correlationId: input.correlationId,
      });

      if ([SubmissionGateOutcome.BLOCKED, SubmissionGateOutcome.CORRECTION_REQUIRED].includes(gateResult.outcome)) {
        return { created: false, replayed: Boolean(idempotent), request: active || null, evaluationId, gateResult };
      }

      const requestId = input.id || id('request');
      const beneficiaryId = input.beneficiary?.id || id('beneficiary');
      const submittedAt = new Date(input.submittedAt || input.now || Date.now());
      const calendarYear = submittedAt.getUTCFullYear();
      const counter = (await client.query(`
        INSERT INTO request_number_counters (calendar_year, next_value) VALUES ($1, 2)
        ON CONFLICT (calendar_year) DO UPDATE SET next_value = request_number_counters.next_value + 1
        RETURNING next_value - 1 AS sequence_value
      `, [calendarYear])).rows[0];
      const requestNumber = input.requestNumber || `LINGAP-${calendarYear}-${String(counter.sequence_value).padStart(5, '0')}`;
      await client.query(`
        INSERT INTO beneficiaries (
          id, requester_applicant_id, full_name, date_of_birth, address,
          relationship_to_applicant, is_requester, legacy_payload
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [beneficiaryId, input.applicantId, input.beneficiary.fullName, input.beneficiary.dateOfBirth || null,
        input.beneficiary.address || null, input.beneficiary.relationshipToApplicant || null,
        input.beneficiaryType !== 'other', input.beneficiary.legacyPayload || {}]);
      const requestResult = await client.query(`
        INSERT INTO requests (
          id, request_number, applicant_id, beneficiary_id, assistance_type, status,
          income_source, patient_circumstance, additional_details, facility_name_snapshot,
          facility_type_snapshot, receipt_date, receipt_reference, policy_version_id,
          policy_version, policy_findings, required_reviews, decision_snapshot,
          originating_office_id, client_submission_id, patient_identity_key,
          submission_fingerprint, policy_gate_outcome, cooldown_until, submitted_at
        ) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
        RETURNING *
      `, [requestId, requestNumber, input.applicantId, beneficiaryId, input.assistanceType,
        input.incomeSource || null, input.patientCircumstance || null, input.additionalDetails || null,
        input.facilityEvidence?.facilityName || null, input.facilityEvidence?.facilityType || null,
        input.facilityEvidence?.receiptDate || null, input.facilityEvidence?.referenceNumber || null,
        policy?.id || null, policy?.policy_version || null, JSON.stringify(gateResult.findings),
        JSON.stringify(gateResult.requiredReviews), {
          stage: 'submission_policy_gates', outcome: gateResult.outcome,
          rawOutcome: gateResult.rawOutcome,
          reportOnlyReasonCodes: gateResult.reportOnlyReasonCodes,
          enforcedReasonCodes: gateResult.enforcedReasonCodes,
          rolloutPolicyVersion: rolloutPolicy?.policy_version || null,
          rolloutSnapshot: gateResult.rolloutSnapshot,
          policyVersion: policy?.policy_version || null, findings: gateResult.findings,
          requiredReviews: gateResult.requiredReviews, evaluatedAt: gateResult.evaluatedAt,
        }, officeId, input.idempotencyKey, patientKey, fingerprint, gateResult.outcome,
        cooldownEnd(submittedAt, cooldownDays), submittedAt]);
      for (const document of input.documents || []) {
        const documentId = document.id || id('document');
        await client.query(`
          INSERT INTO documents (
            id, request_id, applicant_id, document_type, display_name, storage_provider,
            storage_key, mime_type, byte_size, sha256, uploaded_by, metadata
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (id) DO UPDATE SET request_id = EXCLUDED.request_id
        `, [documentId, requestId, input.applicantId, document.documentType,
          document.displayName || document.name || document.documentType,
          document.storageProvider || 'private_filesystem', document.storageKey || document.url,
          document.mimeType || null, document.byteSize ?? null, document.analysis?.sha256 || document.sha256 || null,
          input.applicantId, { ...(document.metadata || {}), source: 'applicant_submission' }]);
        if (document.analysis) {
          await client.query(`
            INSERT INTO document_analyses (
              id, document_id, analyzer_name, analyzer_version, outcome, warnings,
              failures, orientation, metrics, confidence, analyzed_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,now()))
            ON CONFLICT (document_id, analyzer_name, analyzer_version) DO NOTHING
          `, [document.analysis.id || id('analysis'), documentId,
            document.analysis.analyzerName || 'aidlink-document-analyzer',
            document.analysis.analyzerVersion || 'unknown',
            document.analysis.outcome || (document.analysis.accepted ? 'accepted' : 'rejected'),
            JSON.stringify(document.analysis.warnings || []), JSON.stringify(document.analysis.issues || document.analysis.failures || []),
            document.analysis.orientation || null, document.analysis.metrics || document.analysis.checks || {},
            document.analysis.confidence ?? null, document.analysis.analyzedAt || null]);
        }
      }
      await client.query('UPDATE submission_policy_gate_evaluations SET request_id = $2 WHERE id = $1', [evaluationId, requestId]);
      await client.query(`
        UPDATE request_submission_guards SET current_request_id = $4, cooldown_until = $5, updated_at = now()
        WHERE applicant_id = $1 AND patient_identity_key = $2 AND assistance_type = $3
      `, [input.applicantId, patientKey, input.assistanceType, requestId, cooldownEnd(submittedAt, cooldownDays)]);
      await appendAudit(client, {
        actorId: input.applicantId, actorType: 'applicant', actionType: 'request_submitted',
        recordType: 'request', recordId: requestId,
        newValue: { status: 'pending', requestNumber, assistanceType: input.assistanceType,
          policyGateOutcome: gateResult.outcome, originatingOfficeId: officeId },
        justification: 'Applicant submission passed the backend creation gate.', correlationId: input.correlationId,
      });
      return { created: true, replayed: false, request: requestResult.rows[0], beneficiary: { id: beneficiaryId, ...input.beneficiary }, evaluationId, gateResult };
    }, { isolationLevel: 'SERIALIZABLE', retries: 3 });
  }

  async overrideSubmissionPolicyGate(input) {
    const reason = String(input.reason || '').trim();
    if (!reason) throw Object.assign(new Error('An override reason is required.'), { code: 'OVERRIDE_REASON_REQUIRED' });
    return this.database.withTransaction(async (client) => {
      const evaluation = (await client.query(
        'SELECT * FROM submission_policy_gate_evaluations WHERE id = $1 FOR UPDATE',
        [input.evaluationId],
      )).rows[0];
      if (!evaluation) throw Object.assign(new Error('Policy-gate evaluation not found.'), { code: 'EVALUATION_NOT_FOUND' });
      const reasonCodes = Array.isArray(evaluation.reason_codes) ? evaluation.reason_codes : [];
      if (!reasonCodes.some((code) => [SubmissionGateReasonCode.RESIDENCY_OUTSIDE_BOUNDARY, SubmissionGateReasonCode.RESIDENCY_REVIEW_REQUIRED].includes(code))) {
        throw Object.assign(new Error('Only a residency finding can be overridden at this stage.'), { code: 'OVERRIDE_NOT_ALLOWED' });
      }
      if (!evaluation.originating_office_id) throw Object.assign(new Error('Record the originating district satellite office before overriding residency.'), { code: 'OFFICE_REQUIRED' });
      const overrideId = input.id || id('submission-gate-override');
      const inserted = await client.query(`
        INSERT INTO submission_policy_gate_overrides (id, evaluation_id, actor_id, reason)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (evaluation_id) DO NOTHING RETURNING *
      `, [overrideId, input.evaluationId, input.actorId, reason]);
      if (!inserted.rows[0]) throw Object.assign(new Error('This residency finding already has an override.'), { code: 'OVERRIDE_EXISTS' });
      await appendAudit(client, {
        actorId: input.actorId, actorType: 'staff', actionType: 'submission_residency_overridden',
        recordType: 'submission_policy_gate_evaluation', recordId: input.evaluationId,
        oldValue: { outcome: evaluation.outcome, reasonCodes },
        newValue: { overrideId, originatingOfficeId: evaluation.originating_office_id },
        justification: reason, correlationId: input.correlationId,
      });
      return inserted.rows[0];
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async replaceDocument(input) {
    if (!input.idempotencyKey) throw new Error('A document replacement idempotency key is required.');
    return this.database.withTransaction(async (client) => {
      const requestResult = await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [input.requestId]);
      const request = requestResult.rows[0];
      if (!request || request.applicant_id !== input.applicantId) {
        throw Object.assign(new Error('The document does not belong to this applicant request.'), { code: 'NOT_AUTHORIZED' });
      }
      const requirement = await client.query(`
        SELECT cdr.*, cr.status AS correction_status
        FROM correction_document_requirements cdr
        JOIN correction_requests cr ON cr.id = cdr.correction_id
        WHERE cdr.correction_id = $1 AND cdr.document_id = $2 AND cr.request_id = $3
        FOR UPDATE
      `, [input.correctionId, input.originalDocumentId, input.requestId]);
      if (!requirement.rows[0] || requirement.rows[0].correction_status !== 'open') {
        throw Object.assign(new Error('This document was not requested for replacement.'), { code: 'INVALID_REPLACEMENT' });
      }
      const replay = await client.query(`
        SELECT dr.*, d.* FROM document_replacements dr
        JOIN documents d ON d.id = dr.replacement_document_id
        WHERE dr.correction_id = $1 AND dr.original_document_id = $2 AND dr.idempotency_key = $3
      `, [input.correctionId, input.originalDocumentId, input.idempotencyKey]);
      if (replay.rows[0]) return { document: replay.rows[0], replayed: true };

      const original = await client.query('SELECT * FROM documents WHERE id = $1 AND request_id = $2', [input.originalDocumentId, input.requestId]);
      if (!original.rows[0]) throw Object.assign(new Error('Original document not found.'), { code: 'DOCUMENT_NOT_FOUND' });
      const documentId = input.document.id || id('document');
      await client.query(`
        INSERT INTO documents (
          id, request_id, applicant_id, document_type, display_name, storage_provider, storage_key,
          mime_type, byte_size, sha256, version, supersedes_document_id, uploaded_by, metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      `, [documentId, input.requestId, input.applicantId, original.rows[0].document_type,
        input.document.displayName || original.rows[0].display_name, input.document.storageProvider || 'private_filesystem',
        input.document.storageKey, input.document.mimeType || null, input.document.byteSize ?? null,
        input.document.sha256 || null, Number(original.rows[0].version) + 1, input.originalDocumentId,
        input.applicantId, input.document.metadata || {}]);
      if (input.document.analysis) {
        const analysis = input.document.analysis;
        await client.query(`
          INSERT INTO document_analyses
            (id, document_id, analyzer_name, analyzer_version, outcome, warnings, failures, orientation, metrics, confidence)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [analysis.id || id('analysis'), documentId, analysis.analyzerName, analysis.analyzerVersion,
          analysis.outcome, JSON.stringify(analysis.warnings || []), JSON.stringify(analysis.failures || []), analysis.orientation || null,
          analysis.metrics || {}, analysis.confidence ?? null]);
      }
      await client.query(`
        INSERT INTO document_replacements
          (id, correction_id, original_document_id, replacement_document_id, idempotency_key, replaced_by)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [input.replacementId || id('replacement'), input.correctionId, input.originalDocumentId,
        documentId, input.idempotencyKey, input.applicantId]);
      await client.query(`
        UPDATE correction_document_requirements SET replacement_document_id = $3
        WHERE correction_id = $1 AND document_id = $2
      `, [input.correctionId, input.originalDocumentId, documentId]);
      const remaining = await client.query(
        'SELECT count(*)::integer AS count FROM correction_document_requirements WHERE correction_id = $1 AND replacement_document_id IS NULL',
        [input.correctionId],
      );
      if (remaining.rows[0].count === 0) {
        await client.query(`UPDATE correction_requests SET status = 'submitted', submitted_at = now() WHERE id = $1`, [input.correctionId]);
        await client.query(`UPDATE requests SET status = 'under_review', updated_at = now() WHERE id = $1`, [input.requestId]);
      }
      await appendAudit(client, {
        actorId: input.applicantId, actorType: 'applicant', actionType: 'document_replaced',
        recordType: 'document', recordId: documentId,
        oldValue: { documentId: input.originalDocumentId }, newValue: { documentId },
        justification: input.justification || 'Applicant submitted a requested document replacement.', correlationId: input.correlationId,
      });
      return { document: { id: documentId }, replayed: false, correctionComplete: remaining.rows[0].count === 0 };
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async requestCorrection(input) {
    const documentIds = [...new Set((input.documentIds || []).map(String).filter(Boolean))];
    if (!documentIds.length) throw new Error('Select at least one document that must be replaced.');
    if (!String(input.remark || '').trim()) throw new Error('A correction remark is required.');
    return this.database.withTransaction(async (client) => {
      const request = (await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [input.requestId])).rows[0];
      if (!request) throw Object.assign(new Error('Request not found.'), { code: 'REQUEST_NOT_FOUND' });
      if (!['pending', 'under_review'].includes(request.status)) {
        throw Object.assign(new Error('Corrections can only be requested for a pending or under-review request.'), { code: 'INVALID_STATE' });
      }
      const documents = await client.query(
        'SELECT id FROM documents WHERE request_id = $1 AND id = ANY($2::text[])',
        [input.requestId, documentIds],
      );
      if (documents.rows.length !== documentIds.length) {
        throw Object.assign(new Error('One or more selected documents do not belong to this request.'), { code: 'INVALID_DOCUMENT_SELECTION' });
      }
      const correctionId = input.id || id('correction');
      await client.query(`
        INSERT INTO correction_requests (id, request_id, requested_by, remark)
        VALUES ($1,$2,$3,$4)
      `, [correctionId, input.requestId, input.actorId, String(input.remark).trim()]);
      for (const documentId of documentIds) {
        await client.query(
          'INSERT INTO correction_document_requirements (correction_id, document_id) VALUES ($1,$2)',
          [correctionId, documentId],
        );
      }
      await client.query(`UPDATE requests SET status = 'correction_requested', updated_at = now() WHERE id = $1`, [input.requestId]);
      await appendAudit(client, {
        actorId: input.actorId, actorType: 'staff', actionType: 'correction_requested',
        recordType: 'request', recordId: input.requestId,
        oldValue: { status: request.status },
        newValue: { status: 'correction_requested', correctionId, documentIds },
        justification: String(input.remark).trim(), correlationId: input.correlationId,
      });
      return { id: correctionId, requestId: input.requestId, documentIds };
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async reserveBudget(input) {
    return this.database.withTransaction((client) => reserveBudgetInTransaction(client, input), { isolationLevel: 'SERIALIZABLE' });
  }

  async listBudgetPools(input = {}) {
    const result = await this.database.query(`SELECT b.*, (b.allocated_amount-b.reserved_amount-b.spent_amount) AS available_amount, (b.allocated_amount-b.reserved_amount-b.spent_amount-b.depletion_threshold_amount) AS allocatable_amount FROM budgets b WHERE ($1::boolean=true OR b.active=true) ORDER BY b.period_start DESC,b.assistance_type NULLS LAST,b.name`, [input.includeInactive === true]);
    return result.rows;
  }

  async createBudgetPool(input) {
    const values = validateBudgetPool(input);
    return this.database.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`budget:${input.assistanceType || 'global'}`]);
      const overlap = (await client.query(`SELECT id,name FROM budgets WHERE active=true AND assistance_type IS NOT DISTINCT FROM $1 AND daterange(period_start,period_end,'[]') && daterange($2::date,$3::date,'[]') LIMIT 1 FOR UPDATE`, [input.assistanceType || null, input.effectiveFrom, input.effectiveUntil])).rows[0];
      if (overlap) throw Object.assign(new Error(`The effective dates overlap budget pool ${overlap.name}. Close or use a non-overlapping period.`), { code: 'BUDGET_PERIOD_OVERLAP' });
      const poolId = input.id || id('budget');
      const version = Number((await client.query(`SELECT COALESCE(max(version),0)+1 AS next_version FROM budgets WHERE assistance_type IS NOT DISTINCT FROM $1`, [input.assistanceType || null])).rows[0].next_version);
      const budgetVersion = `budget:${input.assistanceType || 'global'}:v${version}`;
      const inserted = (await client.query(`INSERT INTO budgets (id,name,assistance_type,period_start,period_end,allocated_amount,assistance_limit,depletion_threshold_amount,guarantee_letter_validity_days,created_by,justification,active,version,budget_version,published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13,now()) RETURNING *`, [poolId, String(input.name).trim(), input.assistanceType || null, input.effectiveFrom, input.effectiveUntil, values.allocatedAmount, values.assistanceLimit, values.depletionThresholdAmount, values.validityDays, input.actorId, String(input.justification).trim(), version, budgetVersion])).rows[0];
      await appendAudit(client, { actorId: input.actorId, actorType: 'staff', actionType: 'budget_policy_version_published', recordType: 'budget', recordId: poolId, newValue: { name: inserted.name, budgetVersion, assistanceType: inserted.assistance_type, allocatedAmount: Number(inserted.allocated_amount), assistanceLimit: Number(inserted.assistance_limit), depletionThresholdAmount: Number(inserted.depletion_threshold_amount), guaranteeLetterValidityDays: inserted.guarantee_letter_validity_days, effectiveFrom: inserted.period_start, effectiveUntil: inserted.period_end }, justification: String(input.justification).trim() });
      return inserted;
    }, { isolationLevel: 'SERIALIZABLE', retries: 3 });
  }

  async storeGuaranteeLetter(input) {
    if (!input.originalStorageKey || /^https?:\/\//i.test(input.originalStorageKey)) {
      throw new Error('A private original-file storage key is required.');
    }
    if (input.pdfStorageKey && /^https?:\/\//i.test(input.pdfStorageKey)) {
      throw new Error('A private PDF storage key is required.');
    }
    return this.database.withTransaction(async (client) => {
      const request = (await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [input.requestId])).rows[0];
      if (!request || request.status !== 'approved') {
        throw Object.assign(new Error('A guarantee letter can only be attached after request approval.'), { code: 'INVALID_STATE' });
      }
      const current = await client.query(`
        SELECT * FROM guarantee_letters
        WHERE request_id = $1 AND status IN ('pending','confirmed','approved')
        ORDER BY version DESC FOR UPDATE
      `, [input.requestId]);
      for (const previous of current.rows) {
        await client.query(`
          UPDATE guarantee_letters SET status = 'replaced', qr_token_hash = NULL WHERE id = $1
        `, [previous.id]);
        await appendAudit(client, {
          actorId: input.actorId, actorType: 'staff', actionType: 'guarantee_letter_replaced',
          recordType: 'guarantee_letter', recordId: previous.id,
          oldValue: { status: previous.status }, newValue: { status: 'replaced' },
          justification: input.justification || 'A newer guarantee-letter version was uploaded.',
        });
      }
      const maxVersion = (await client.query(
        'SELECT COALESCE(max(version), 0)::integer AS version FROM guarantee_letters WHERE request_id = $1',
        [input.requestId],
      )).rows[0].version;
      const letterId = input.id || id('guarantee-letter');
      const inserted = await client.query(`
        INSERT INTO guarantee_letters (
          id,request_id,version,source_mime_type,original_storage_key,pdf_storage_key,
          conversion_status,status,uploaded_by,metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9) RETURNING *
      `, [letterId, input.requestId, Number(maxVersion) + 1, input.sourceMimeType,
        input.originalStorageKey, input.pdfStorageKey || null, input.conversionStatus || 'pending',
        input.actorId, input.metadata || {}]);
      await appendAudit(client, {
        actorId: input.actorId, actorType: 'staff', actionType: 'guarantee_letter_uploaded',
        recordType: 'guarantee_letter', recordId: letterId,
        newValue: { requestId: input.requestId, version: Number(maxVersion) + 1, conversionStatus: input.conversionStatus || 'pending' },
        justification: input.justification, correlationId: input.correlationId,
      });
      return inserted.rows[0];
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async recordDecision(input) {
    const result = await this.database.withTransaction(async (client) => {
      const current = (await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [input.requestId])).rows[0];
      if (!current) throw Object.assign(new Error('Request not found.'), { code: 'REQUEST_NOT_FOUND' });
      if (!['under_review', 'pending'].includes(current.status)) {
        throw Object.assign(new Error('This request is not in a state that can be decided.'), { code: 'INVALID_STATE' });
      }
      if (!['approved', 'denied', 'manual_review'].includes(input.decision)) throw new Error('Unsupported coverage decision.');
      if (input.decision === 'approved') {
        const hardDisqualifiers = await evaluateHardDisqualifierInTransaction(client, {
          requestId: input.requestId, actorId: input.actorId,
          justification: 'Evaluate hard disqualifiers before calculating or recording coverage.',
          correlationId: input.correlationId,
        });
        if (!hardDisqualifiers.approvalAllowed) return { hardDisqualifierBlocked: true, hardDisqualifiers };
        const coveragePolicy = (await client.query(`SELECT * FROM policy_configurations WHERE policy_key = 'coverage_matrix' AND active = true AND effective_from <= now() AND (effective_until IS NULL OR effective_until > now()) AND (assistance_type IS NULL OR assistance_type = $1) ORDER BY (assistance_type IS NOT NULL) DESC, version DESC LIMIT 1`, [current.assistance_type])).rows[0];
        if (coveragePolicy?.configuration?.status === 'active') {
          const coverage = await calculateCoverageInTransaction(client, { requestId: input.requestId, actorId: input.actorId, justification: 'Calculate coverage after hard-disqualifier clearance and before the coverage decision.', correlationId: input.correlationId });
          if (coverage.outcome === 'ineligible') return { coverageBlocked: true, coverage };
          input.coverageSnapshotId = coverage.snapshotId;
          input.amount = coverage.coveredAmount;
          input.decisionSnapshot = { ...(input.decisionSnapshot || {}), coverage };
        }
      }
      const decisionId = input.id || id('decision');
      await client.query(`
        INSERT INTO coverage_decisions
          (id, request_id, policy_version_id, decision, decision_snapshot, amount, decided_by, justification, coverage_snapshot_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [decisionId, input.requestId, input.policyVersionId, input.decision,
        input.decisionSnapshot, input.amount ?? null, input.actorId, input.justification, input.coverageSnapshotId || null]);
      const nextStatus = input.decision === 'manual_review' ? 'under_review' : input.decision;
      await client.query(`
        UPDATE requests SET status = $2, policy_version_id = $3, decision_snapshot = $4,
          processed_by = $5, processed_at = CASE WHEN $2 IN ('approved','denied') THEN now() ELSE processed_at END,
          updated_at = now() WHERE id = $1
      `, [input.requestId, nextStatus, input.policyVersionId, input.decisionSnapshot, input.actorId]);
      await appendAudit(client, {
        actorId: input.actorId, actorType: 'staff', actionType: 'request_decision_recorded',
        recordType: 'request', recordId: input.requestId,
        oldValue: { status: current.status, policyVersionId: current.policy_version_id },
        newValue: { status: nextStatus, policyVersionId: input.policyVersionId, decisionSnapshot: input.decisionSnapshot },
        justification: input.justification, correlationId: input.correlationId,
      });
      return { decisionId, status: nextStatus, reservation: null };
    }, { isolationLevel: 'SERIALIZABLE' });
    if (result.hardDisqualifierBlocked) {
      const error = Object.assign(new Error(result.hardDisqualifiers.findings[0]?.message || 'A hard-disqualifier finding blocks approval.'), {
        code: 'HARD_DISQUALIFIER_BLOCKED', policyResult: result.hardDisqualifiers,
      });
      throw error;
    }
    if (result.coverageBlocked) throw Object.assign(new Error(result.coverage.adjustments[0]?.message || 'The coverage matrix returned ineligible.'), { code: 'COVERAGE_INELIGIBLE', coverageResult: result.coverage });
    return result;
  }

  async releaseGuaranteeLetter(input) {
    try {
      return await this.database.withTransaction(async (client) => {
      const request = (await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [input.requestId])).rows[0];
      if (!request) throw Object.assign(new Error('Request not found.'), { code: 'REQUEST_NOT_FOUND' });
      const existingLetter = (await client.query('SELECT * FROM guarantee_letters WHERE id=$1 AND request_id=$2 FOR UPDATE', [input.letterId, input.requestId])).rows[0] || null;
      if (request.status === 'ready_for_claiming' && existingLetter?.status === 'approved') {
        const reservation = (await client.query('SELECT * FROM budget_reservations WHERE guarantee_letter_id=$1', [input.letterId])).rows[0] || null;
        return { requestId: input.requestId, letterId: input.letterId, status: 'ready_for_claiming', expiresAt: existingLetter.expires_at, validityDays: existingLetter.validity_days, reservation, replayed: true };
      }
      if (request.status !== 'approved') throw Object.assign(new Error('Only an approved request can be prepared for claiming.'), { code: 'INVALID_STATE' });
      if (!input.claimingDate || !input.claimingTime || !input.claimingLocation) throw new Error('Claiming date, time, and location are required.');
      let letter = existingLetter;
      if (!letter && input.letter) {
        const previous = (await client.query(`SELECT * FROM guarantee_letters WHERE request_id=$1 AND status IN ('pending','confirmed','approved') ORDER BY version DESC FOR UPDATE`, [input.requestId])).rows;
        for (const item of previous) {
          const reservation = (await client.query(`SELECT * FROM budget_reservations WHERE guarantee_letter_id=$1 AND status='reserved' FOR UPDATE`, [item.id])).rows[0];
          if (reservation) await releaseReservationInTransaction(client, reservation, { actorId: input.actorId, actorType: 'staff', status: 'released', reason: 'A replacement Guarantee Letter superseded this allocation.' });
          await client.query(`UPDATE guarantee_letters SET status='replaced',qr_token_hash=NULL WHERE id=$1`, [item.id]);
        }
        letter = (await client.query(`INSERT INTO guarantee_letters (id,request_id,version,source_mime_type,original_storage_key,pdf_storage_key,conversion_status,status,uploaded_by,uploaded_at,reviewed_by,reviewed_at,metadata) VALUES ($1,$2,$3,$4,$5,$6,'ready','confirmed',$7,$8,$7,$9,$10) RETURNING *`, [input.letterId, input.requestId, input.letter.version, input.letter.sourceMimeType, input.letter.originalStorageKey, input.letter.pdfStorageKey, input.actorId, input.letter.uploadedAt || new Date(), input.letter.reviewedAt || new Date(), input.letter.metadata || {}])).rows[0];
      }
      if (!letter || letter.conversion_status !== 'ready' || letter.status !== 'confirmed') {
        throw Object.assign(new Error('A reviewed PDF guarantee letter is required before release.'), { code: 'LETTER_NOT_READY' });
      }
      const coverage = (await client.query(`SELECT result FROM coverage_calculation_snapshots WHERE request_id=$1 ORDER BY calculated_at DESC LIMIT 1`, [request.id])).rows[0];
      const amount = Number(coverage?.result?.coveredAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error('A positive server-calculated covered amount is required before releasing the Guarantee Letter.'), { code: 'COVERAGE_AMOUNT_REQUIRED' });
      const releasedAt = new Date(input.releasedAt || Date.now());
      const budget = await effectiveBudgetPool(client, request.assistance_type, releasedAt, { lock: true });
      if (!budget) throw Object.assign(new Error('No effective city budget pool is configured for this assistance type and release date.'), { code: 'BUDGET_POOL_NOT_CONFIGURED' });
      const expiresAt = guaranteeLetterExpiry(releasedAt, budget.guarantee_letter_validity_days);
      const reservation = await reserveBudgetInTransaction(client, { budgetId: budget.id, requestId: request.id, amount, idempotencyKey: `guarantee-letter:${letter.id}`, guaranteeLetterId: letter.id, expiresAt, effectiveAt: releasedAt, actorId: input.actorId, actorType: 'staff', justification: input.justification, correlationId: input.correlationId });
      await client.query(`
        UPDATE guarantee_letters SET status = 'approved', approved_at = $4, expires_at = $2, qr_token_hash = $3, budget_reservation_id=$5,validity_days=$6,released_by=$7
        WHERE id = $1
      `, [input.letterId, expiresAt, input.qrTokenHash, releasedAt, reservation.reservation.id, budget.guarantee_letter_validity_days, input.actorId]);
      await client.query(`
        UPDATE requests SET status = 'ready_for_claiming', claiming_date = $2, claiming_time = $3,
          claiming_location = $4, updated_at = now() WHERE id = $1
      `, [input.requestId, input.claimingDate, input.claimingTime, input.claimingLocation]);
      await appendAudit(client, {
        actorId: input.actorId, actorType: 'staff', actionType: 'guarantee_letter_released',
        recordType: 'guarantee_letter', recordId: input.letterId,
        oldValue: { status: letter.status }, newValue: { status: 'approved', requestStatus: 'ready_for_claiming', budgetPoolId: budget.id, reservationId: reservation.reservation.id, amount, expiresAt, validityDays: budget.guarantee_letter_validity_days },
        justification: input.justification, correlationId: input.correlationId,
      });
      return { requestId: input.requestId, letterId: input.letterId, status: 'ready_for_claiming', budgetPoolId: budget.id, amount, expiresAt: expiresAt.toISOString(), validityDays: budget.guarantee_letter_validity_days, reservation: reservation.reservation, replayed: false };
      }, { isolationLevel: 'SERIALIZABLE', retries: 3 });
    } catch (error) {
      await this.appendAudit({ actorId: input.actorId || 'system', actorType: input.actorId ? 'staff' : 'system', actionType: 'guarantee_letter_release_failed', recordType: 'guarantee_letter', recordId: input.letterId || input.requestId, newValue: { requestId: input.requestId, reasonCode: error?.code || 'CLAIMING_RELEASE_FAILED' }, justification: error instanceof Error ? error.message : 'Guarantee Letter release failed.', correlationId: input.correlationId }).catch(() => undefined);
      throw error;
    }
  }

  async expireGuaranteeLetter(input) {
    return this.database.withTransaction(async (client) => {
      const letter = (await client.query('SELECT * FROM guarantee_letters WHERE id = $1 FOR UPDATE', [input.letterId])).rows[0];
      if (!letter) throw Object.assign(new Error('Guarantee letter not found.'), { code: 'LETTER_NOT_FOUND' });
      if (['expired', 'revoked', 'replaced'].includes(letter.status)) return { letter, replayed: true };
      if (!letter.expires_at || new Date(input.now || Date.now()) < new Date(letter.expires_at)) throw Object.assign(new Error('The Guarantee Letter has not reached its expiry time.'), { code: 'LETTER_NOT_EXPIRED' });
      const reservation = (await client.query(`SELECT * FROM budget_reservations WHERE guarantee_letter_id=$1 AND status='reserved' FOR UPDATE`, [input.letterId])).rows[0];
      const allocation = reservation ? await releaseReservationInTransaction(client, reservation, { actorId: input.actorId, actorType: input.actorType, status: 'expired', releasedAt: input.now || new Date(), reason: input.justification || 'Guarantee Letter validity ended without a claim.' }) : null;
      await client.query(`UPDATE guarantee_letters SET status = 'expired', qr_token_hash = NULL WHERE id = $1`, [input.letterId]);
      await client.query(`UPDATE requests SET status='approved',updated_at=now() WHERE id=$1 AND status='ready_for_claiming'`, [letter.request_id]);
      await appendAudit(client, {
        actorId: input.actorId || 'system', actorType: input.actorType || 'system', actionType: 'guarantee_letter_expired',
        recordType: 'guarantee_letter', recordId: input.letterId,
        oldValue: { status: letter.status }, newValue: { status: 'expired' }, justification: input.justification,
      });
      return { letterId: input.letterId, status: 'expired', allocation, replayed: false };
    }, { isolationLevel: 'SERIALIZABLE', retries: 3 });
  }

  async expireDueGuaranteeLetters(input = {}) {
    const due = await this.database.query(`SELECT id FROM guarantee_letters WHERE status='approved' AND expires_at IS NOT NULL AND expires_at <= $1 ORDER BY expires_at`, [input.now || new Date()]);
    const results = [];
    for (const item of due.rows) results.push(await this.expireGuaranteeLetter({ letterId: item.id, now: input.now || new Date(), actorId: input.actorId || 'system', actorType: input.actorType || 'system', justification: 'Guarantee Letter validity window expired; unused allocation returned.' }));
    return results;
  }

  async enqueueNotification(input) {
    return this.database.withTransaction(async (client) => {
      const notificationId = input.id || id('notification');
      const result = await client.query(`
        INSERT INTO notifications
          (id, applicant_id, request_id, channel, event_type, delivery_key, payload, next_attempt_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (channel, delivery_key) DO NOTHING RETURNING *
      `, [notificationId, input.applicantId || null, input.requestId || null, input.channel,
        input.eventType, input.deliveryKey, input.payload || {}, input.nextAttemptAt || null]);
      if (!result.rows[0]) {
        const existing = await client.query('SELECT * FROM notifications WHERE channel = $1 AND delivery_key = $2', [input.channel, input.deliveryKey]);
        return { notification: existing.rows[0], replayed: true };
      }
      await appendAudit(client, {
        actorId: input.actorId || 'system', actorType: input.actorType || 'system', actionType: 'notification_queued',
        recordType: 'notification', recordId: notificationId,
        newValue: { channel: input.channel, eventType: input.eventType }, justification: input.justification,
      });
      return { notification: result.rows[0], replayed: false };
    });
  }

  async appendAudit(input) {
    return this.database.withTransaction(async (client) => {
      const auditId = input.id || id('audit');
      await appendAudit(client, { ...input, id: auditId });
      return { id: auditId };
    });
  }
}

export class PostgresPolicyRepository extends PolicyRepository {
  constructor(database) { super(); this.database = database; }

  async getEffectivePolicy({ policyKey, assistanceType = null, at = new Date() }) {
    const result = await this.database.query(`
      SELECT * FROM policy_configurations
      WHERE policy_key = $1 AND assistance_type IS NOT DISTINCT FROM $2 AND active = true
        AND effective_from <= $3 AND (effective_until IS NULL OR effective_until > $3)
      ORDER BY version DESC LIMIT 1
    `, [policyKey, assistanceType, at]);
    return result.rows[0] || null;
  }

  async getPolicyVersion({ id, policyVersion }) {
    const result = id
      ? await this.database.query('SELECT * FROM policy_configurations WHERE id = $1', [id])
      : await this.database.query('SELECT * FROM policy_configurations WHERE policy_version = $1', [policyVersion]);
    return result.rows[0] || null;
  }

  async listPolicyVersions({ policyKey, assistanceType = null }) {
    const result = await this.database.query(`
      SELECT * FROM policy_configurations
      WHERE policy_key = $1 AND assistance_type IS NOT DISTINCT FROM $2
      ORDER BY version DESC
    `, [policyKey, assistanceType]);
    return result.rows;
  }

  async createPolicyVersion(input) {
    if (!String(input.justification || '').trim()) throw new Error('A justification is required for a policy configuration change.');
    if (!input.actorId) throw new Error('An authenticated actor is required for a policy configuration change.');
    if (input.policyKey === 'hard_disqualifiers') validateHardDisqualifierPolicyConfiguration(input.configuration);
    if (input.policyKey === 'coverage_matrix') validateCoveragePolicyConfiguration(input.configuration);
    return this.database.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`policy:${input.policyKey}:${input.assistanceType || ''}`]);
      const previousResult = await client.query(`
        SELECT * FROM policy_configurations
        WHERE policy_key = $1 AND assistance_type IS NOT DISTINCT FROM $2
        ORDER BY version DESC LIMIT 1
      `, [input.policyKey, input.assistanceType || null]);
      const previous = previousResult.rows[0] || null;
      const configuration = input.policyKey === 'policy_rollout'
        ? validatePolicyRolloutConfiguration(input.configuration, previous?.configuration)
        : input.configuration;
      const versionResult = await client.query(`
        SELECT COALESCE(max(version), 0) + 1 AS next_version
        FROM policy_configurations WHERE policy_key = $1 AND assistance_type IS NOT DISTINCT FROM $2
      `, [input.policyKey, input.assistanceType || null]);
      const version = Number(versionResult.rows[0].next_version);
      const policyId = input.id || id('policy');
      const policyVersion = input.policyVersion || `${input.policyKey}:${input.assistanceType || 'global'}:v${version}`;
      const effectiveDate = input.effectiveDate || input.effectiveFrom || new Date();
      await client.query(`
        INSERT INTO policy_configurations
          (id, policy_key, version, policy_version, assistance_type, configuration,
           effective_from, effective_date, effective_until, created_by, actor_id,
           old_value, new_value, justification)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$9,$10,$6,$11)
      `, [policyId, input.policyKey, version, policyVersion, input.assistanceType || null, configuration,
        effectiveDate, input.effectiveUntil || null, input.actorId,
        previous?.configuration || null, String(input.justification).trim()]);
      const publicationActions = {
        coverage_matrix: 'tariff_policy_version_published',
        workflow_thresholds: 'threshold_policy_version_published',
        submission_gates: 'submission_gate_policy_version_published',
        prescription_routing: 'prescription_routing_policy_version_published',
        hard_disqualifiers: 'hard_rejection_policy_version_published',
        policy_rollout: 'policy_rollout_version_published',
      };
      await appendAudit(client, {
        actorId: input.actorId, actorType: 'staff', actionType: publicationActions[input.policyKey] || 'policy_version_published',
        recordType: 'policy_configuration', recordId: policyId,
        oldValue: previous ? { policyVersion: previous.policy_version, configuration: previous.configuration } : null,
        newValue: { policyKey: input.policyKey, version, policyVersion, assistanceType: input.assistanceType || null, configuration, effectiveDate },
        justification: String(input.justification).trim(),
      });
      return { id: policyId, version, policyVersion, effectiveDate, actorId: input.actorId,
        oldValue: previous?.configuration || null, newValue: configuration,
        justification: String(input.justification).trim() };
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async recordPolicyEvaluation(input) {
    return this.database.withTransaction(async (client) => {
      const request = (await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [input.requestId])).rows[0];
      if (!request) throw Object.assign(new Error('Request not found.'), { code: 'REQUEST_NOT_FOUND' });
      const changesRecordedVersion = Boolean(request.policy_version && input.policyVersion && request.policy_version !== input.policyVersion);
      if (changesRecordedVersion && input.authorizedReEvaluation !== true) {
        throw Object.assign(new Error('This request is tied to its recorded policy version. A System Administrator must create an authorized re-evaluation to use a newer version.'), { code: 'POLICY_REEVALUATION_REQUIRED' });
      }
      const evaluationId = input.id || id('policy-evaluation');
      const findings = input.findings || [];
      const requiredReviews = input.requiredReviews || [];
      const decisionSnapshot = {
        ...(input.decisionSnapshot || {}),
        policyVersion: input.policyVersion || null,
        policyVersionId: input.policyVersionId || null,
        policyFindings: findings,
        requiredReviews,
        policyDecisions: input.decisions || {},
        evaluator: { name: input.evaluatorName, version: input.evaluatorVersion },
        evaluatedAt: input.evaluatedAt || new Date().toISOString(),
      };
      await client.query(`
        INSERT INTO policy_evaluations (
          id, request_id, policy_version_id, policy_version, evaluator_name,
          evaluator_version, outcome, findings, required_reviews, decision_snapshot,
          evaluated_by, evaluated_at, correlation_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,now()),$13)
      `, [evaluationId, input.requestId, input.policyVersionId || null, input.policyVersion || null,
        input.evaluatorName, input.evaluatorVersion, input.outcome, JSON.stringify(findings),
        JSON.stringify(requiredReviews), decisionSnapshot, input.actorId || null,
        input.evaluatedAt || null, input.correlationId || null]);
      await client.query(`
        UPDATE requests SET
          originating_office_id = COALESCE($2, originating_office_id),
          policy_version_id = $3,
          policy_version = $4,
          policy_findings = $5,
          required_reviews = $6,
          decision_snapshot = $7,
          updated_at = now()
        WHERE id = $1
      `, [input.requestId, input.originatingOfficeId || null, input.policyVersionId || null,
        input.policyVersion || null, JSON.stringify(findings), JSON.stringify(requiredReviews), decisionSnapshot]);
      await appendAudit(client, {
        actorId: input.actorId || 'system', actorType: input.actorId ? 'staff' : 'system',
        actionType: changesRecordedVersion ? 'policy_re_evaluated' : 'policy_evaluated', recordType: 'request', recordId: input.requestId,
        oldValue: { policyVersion: request.policy_version, policyFindings: request.policy_findings, requiredReviews: request.required_reviews },
        newValue: { policyVersion: input.policyVersion || null, outcome: input.outcome, policyFindings: findings, requiredReviews },
        justification: input.justification || 'Backend policy evaluation recorded.', correlationId: input.correlationId,
        metadata: { evaluatorName: input.evaluatorName, evaluatorVersion: input.evaluatorVersion },
      });
      return { id: evaluationId, requestId: input.requestId, decisionSnapshot };
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async getRequestPolicyHistory({ requestId }) {
    const result = await this.database.query(`
      SELECT * FROM policy_evaluations WHERE request_id = $1 ORDER BY evaluated_at DESC
    `, [requestId]);
    return result.rows;
  }
}

export class PostgresFacilityRoutingRepository extends FacilityRoutingRepository {
  constructor(database) { super(); this.database = database; }

  async getEffectiveDirectory({ at = new Date() } = {}) {
    const result = await this.database.query(`
      SELECT * FROM facility_directory_versions
      WHERE effective_from <= $1 AND (effective_until IS NULL OR effective_until > $1)
      ORDER BY version DESC LIMIT 1
    `, [at]);
    return result.rows[0] || null;
  }

  async createDirectoryVersion(input) {
    if (!input.actorId) throw new Error('An authenticated System Administrator is required.');
    if (!String(input.justification || '').trim()) throw new Error('A directory-change justification is required.');
    if (!String(input.authoritativeSource || '').trim()) throw new Error('An authoritative source is required.');
    validateFacilityDirectory(input.directory);
    return this.database.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['facility-directory']);
      const previous = (await client.query('SELECT * FROM facility_directory_versions ORDER BY version DESC LIMIT 1')).rows[0] || null;
      const version = Number(previous?.version || 0) + 1;
      const directoryId = input.id || id('facility-directory');
      const directoryVersion = input.directoryVersion || `facility-directory:v${version}`;
      const effectiveFrom = input.effectiveFrom || new Date();
      const inserted = await client.query(`
        INSERT INTO facility_directory_versions (
          id, version, directory_version, effective_from, effective_until, directory,
          actor_id, old_value, new_value, authoritative_source, justification
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$6,$9,$10) RETURNING *
      `, [directoryId, version, directoryVersion, effectiveFrom, input.effectiveUntil || null,
        input.directory, input.actorId, previous?.directory || null,
        String(input.authoritativeSource).trim(), String(input.justification).trim()]);
      await appendAudit(client, {
        actorId: input.actorId, actorType: 'staff', actionType: 'facility_directory_version_created',
        recordType: 'facility_directory', recordId: directoryId,
        oldValue: previous ? { directoryVersion: previous.directory_version, directory: previous.directory } : null,
        newValue: { directoryVersion, effectiveFrom, directory: input.directory, authoritativeSource: input.authoritativeSource },
        justification: String(input.justification).trim(), correlationId: input.correlationId,
      });
      return inserted.rows[0];
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async resolveRequestFacility(input) {
    return this.database.withTransaction(async (client) => {
      const request = (await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [input.requestId])).rows[0];
      if (!request) throw Object.assign(new Error('Request not found.'), { code: 'REQUEST_NOT_FOUND' });
      const directoryVersion = (await client.query(`
        SELECT * FROM facility_directory_versions
        WHERE effective_from <= $1 AND (effective_until IS NULL OR effective_until > $1)
        ORDER BY version DESC LIMIT 1
      `, [input.at || new Date()])).rows[0];
      if (!directoryVersion) throw Object.assign(new Error('No effective facility directory is configured.'), { code: 'DIRECTORY_NOT_CONFIGURED' });
      const thresholdPolicy = (await client.query(`
        SELECT configuration FROM policy_configurations
        WHERE policy_key='workflow_thresholds' AND active=true
          AND effective_from <= $1 AND (effective_until IS NULL OR effective_until > $1)
        ORDER BY version DESC LIMIT 1
      `, [input.at || new Date()])).rows[0] || null;
      if (thresholdPolicy?.configuration?.receiptValidityDays != null) {
        directoryVersion.directory = { ...directoryVersion.directory, maxEvidenceAgeDays: Number(thresholdPolicy.configuration.receiptValidityDays) };
      }
      const documents = (await client.query('SELECT * FROM documents WHERE request_id = $1 ORDER BY version DESC', [input.requestId])).rows;
      const receipt = documents.find((document) => /receipt|bill|invoice|statement|quotation|contract/i.test(document.document_type));
      const evidence = {
        facilityName: request.facility_name_snapshot,
        facilityType: request.facility_type_snapshot,
        receiptDate: request.receipt_date,
        referenceNumber: request.receipt_reference,
        receiptDocumentId: receipt?.id || null,
      };
      const resolution = resolveFacilityEvidence({ evidence, directoryVersion, now: input.at || new Date() });
      let facility = null;
      if (resolution.facility) {
        const normalizedName = String(resolution.facility.canonicalName).trim().toLowerCase().replace(/\s+/g, ' ');
        const storageType = ['hospital', 'pharmacy'].includes(resolution.facility.category) ? resolution.facility.category : 'other';
        facility = (await client.query(`
          INSERT INTO facilities (
            id, name, facility_type, normalized_name, directory_entry_key,
            directory_version_id, tier, classification_category, metadata
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (normalized_name, facility_type) DO UPDATE SET
            name = EXCLUDED.name, directory_entry_key = EXCLUDED.directory_entry_key,
            directory_version_id = EXCLUDED.directory_version_id, tier = EXCLUDED.tier,
            classification_category = EXCLUDED.classification_category, updated_at = now()
          RETURNING *
        `, [id('facility'), resolution.facility.canonicalName, storageType, normalizedName,
          resolution.facility.key, directoryVersion.id, resolution.facility.tier,
          resolution.facility.category, { receiptIdentified: true }])).rows[0];
      }
      const prescription = documents.find((document) => /prescription/i.test(document.document_type));
      const pricing = privatePrescriptionPricingState({
        facilityTier: resolution.facility?.tier,
        prescriberCategory: resolution.facility?.category,
        prescriptionDocumentId: prescription?.id,
        choStatus: null,
      });
      const resolutionId = input.id || id('facility-resolution');
      await client.query(`
        INSERT INTO facility_resolution_results (
          id, request_id, directory_version_id, outcome, reason_code, facility_id,
          resolved_tier, resolved_category, evidence_date, evidence_fingerprint,
          findings, resolver_version, resolved_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'facility-routing-1',$12)
      `, [resolutionId, input.requestId, directoryVersion.id, resolution.outcome,
        resolution.reasonCode, facility?.id || null, resolution.facility?.tier || null,
        resolution.facility?.category || null, resolution.evidenceDate || null,
        resolution.evidenceFingerprint, JSON.stringify(resolution.findings || []), input.actorId || 'system']);
      const requiredReviews = Array.isArray(request.required_reviews) ? [...request.required_reviews] : [];
      const policyFindings = Array.isArray(request.policy_findings) ? [...request.policy_findings] : [];
      if (resolution.outcome !== 'resolved') {
        requiredReviews.push({ type: 'facility_resolution_review', reasonCode: resolution.reasonCode, resolutionId });
        policyFindings.push(...(resolution.findings || []));
      }
      if (pricing.status === 'locked' && prescription) {
        requiredReviews.push({ type: 'cho_prescription_validation', documentId: prescription.id, reasonCode: pricing.reasonCode });
        await client.query(`
          INSERT INTO private_prescription_validation_events (
            id, request_id, prescription_document_id, prescribing_facility_id,
            directory_version_id, status
          ) VALUES ($1,$2,$3,$4,$5,'pending')
        `, [id('cho-validation'), input.requestId, prescription.id, facility?.id || null, directoryVersion.id]);
      }
      await client.query(`
        UPDATE requests SET facility_id = $2, facility_resolution_id = $3,
          facility_tier_snapshot = $4, facility_category_snapshot = $5,
          partner_pricing_status = $6, required_reviews = $7, policy_findings = $8,
          updated_at = now() WHERE id = $1
      `, [input.requestId, facility?.id || null, resolutionId,
        resolution.facility?.tier || null, resolution.facility?.category || null,
        pricing.status, JSON.stringify(requiredReviews), JSON.stringify(policyFindings)]);
      await appendAudit(client, {
        actorId: input.actorId || 'system', actorType: input.actorType || (input.actorId ? 'staff' : 'system'),
        actionType: 'facility_evidence_resolved', recordType: 'request', recordId: input.requestId,
        oldValue: { facilityId: request.facility_id, facilityTier: request.facility_tier_snapshot },
        newValue: { resolutionId, outcome: resolution.outcome, reasonCode: resolution.reasonCode,
          facilityId: facility?.id || null, facilityTier: resolution.facility?.tier || null,
          directoryVersion: directoryVersion.directory_version, partnerPricingStatus: pricing.status },
        justification: input.justification || 'Validated stored facility evidence against the effective server directory.',
      });
      return { resolutionId, directoryVersion: directoryVersion.directory_version, resolution, facility, pricing, requiredReviews };
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async recordChoPrescriptionDecision(input) {
    const reason = String(input.reason || '').trim();
    if (!['approved', 'rejected'].includes(input.status)) throw new Error('CHO decision must be approved or rejected.');
    if (!reason) throw new Error('A CHO decision reason is required.');
    return this.database.withTransaction(async (client) => {
      const capability = (await client.query(`
        SELECT 1 FROM staff_capabilities
        WHERE staff_id = $1 AND capability = 'cho_prescription_validate' AND revoked_at IS NULL
      `, [input.actorId])).rows[0];
      if (!capability) throw Object.assign(new Error('Authorized City Health Office validation access is required.'), { code: 'CHO_PERMISSION_REQUIRED' });
      const request = (await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [input.requestId])).rows[0];
      if (!request) throw Object.assign(new Error('Request not found.'), { code: 'REQUEST_NOT_FOUND' });
      if (request.facility_tier_snapshot !== 'private' || !['clinic', 'doctor'].includes(request.facility_category_snapshot)) {
        throw Object.assign(new Error('This request does not contain a resolved private-clinic or private-doctor prescription.'), { code: 'CHO_NOT_REQUIRED' });
      }
      const pending = (await client.query(`
        SELECT * FROM private_prescription_validation_events
        WHERE request_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE
      `, [input.requestId])).rows[0];
      if (!pending) throw Object.assign(new Error('Prescription validation record not found.'), { code: 'PRESCRIPTION_NOT_FOUND' });
      const eventId = input.id || id('cho-validation');
      await client.query(`
        INSERT INTO private_prescription_validation_events (
          id, request_id, prescription_document_id, prescribing_facility_id,
          directory_version_id, status, actor_id, reason
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [eventId, input.requestId, pending.prescription_document_id,
        pending.prescribing_facility_id, pending.directory_version_id,
        input.status, input.actorId, reason]);
      const pricingStatus = input.status === 'approved' ? 'unlocked' : 'locked';
      await client.query('UPDATE requests SET partner_pricing_status = $2, updated_at = now() WHERE id = $1', [input.requestId, pricingStatus]);
      await appendAudit(client, {
        actorId: input.actorId, actorType: 'staff', actionType: `cho_prescription_${input.status}`,
        recordType: 'request', recordId: input.requestId,
        oldValue: { choStatus: pending.status, partnerPricingStatus: request.partner_pricing_status },
        newValue: { choStatus: input.status, partnerPricingStatus: pricingStatus, prescriptionDocumentId: pending.prescription_document_id },
        justification: reason, correlationId: input.correlationId,
      });
      return { eventId, requestId: input.requestId, status: input.status, partnerPricingStatus: pricingStatus };
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async setChoValidatorCapability(input) {
    if (!String(input.justification || '').trim()) throw new Error('A capability-change justification is required.');
    return this.database.withTransaction(async (client) => {
      const staff = (await client.query('SELECT id FROM staff_accounts WHERE id = $1 AND active = true', [input.staffId])).rows[0];
      if (!staff) throw Object.assign(new Error('Active staff account not found.'), { code: 'STAFF_NOT_FOUND' });
      if (input.active) {
        await client.query(`
          INSERT INTO staff_capabilities (staff_id, capability, assigned_by, justification)
          VALUES ($1,'cho_prescription_validate',$2,$3)
          ON CONFLICT (staff_id, capability) WHERE revoked_at IS NULL DO NOTHING
        `, [input.staffId, input.actorId, String(input.justification).trim()]);
      } else {
        await client.query(`
          UPDATE staff_capabilities SET revoked_at = now(), revoked_by = $2
          WHERE staff_id = $1 AND capability = 'cho_prescription_validate' AND revoked_at IS NULL
        `, [input.staffId, input.actorId]);
      }
      await appendAudit(client, {
        actorId: input.actorId, actorType: 'staff',
        actionType: input.active ? 'cho_validator_capability_assigned' : 'cho_validator_capability_revoked',
        recordType: 'staff_account', recordId: input.staffId,
        oldValue: { active: !input.active }, newValue: { active: Boolean(input.active), capability: 'cho_prescription_validate' },
        justification: String(input.justification).trim(),
      });
      return { staffId: input.staffId, capability: 'cho_prescription_validate', active: Boolean(input.active) };
    });
  }

  async getRequestRoutingStatus({ requestId }) {
    const request = (await this.database.query(`
      SELECT id, facility_id, facility_resolution_id, facility_tier_snapshot,
             facility_category_snapshot, partner_pricing_status
      FROM requests WHERE id = $1
    `, [requestId])).rows[0];
    if (!request) return null;
    const resolution = (await this.database.query(`
      SELECT r.*, d.directory_version FROM facility_resolution_results r
      JOIN facility_directory_versions d ON d.id = r.directory_version_id
      WHERE r.request_id = $1 ORDER BY r.resolved_at DESC LIMIT 1
    `, [requestId])).rows[0] || null;
    const choValidation = (await this.database.query(`
      SELECT status, reason, actor_id, created_at FROM private_prescription_validation_events
      WHERE request_id = $1 ORDER BY created_at DESC LIMIT 1
    `, [requestId])).rows[0] || null;
    return { request, resolution, choValidation };
  }
}

export class PostgresHardDisqualifierRepository extends HardDisqualifierRepository {
  constructor(database) { super(); this.database = database; }

  async recordEvidence(input) {
    const evidence = validateHardDisqualifierEvidence(input);
    if (!input.actorId) throw Object.assign(new Error('An authenticated staff member is required.'), { code: 'ACTOR_REQUIRED' });
    return this.database.withTransaction(async (client) => {
      const request = (await client.query('SELECT id FROM requests WHERE id = $1 FOR UPDATE', [input.requestId])).rows[0];
      if (!request) throw Object.assign(new Error('Request not found.'), { code: 'REQUEST_NOT_FOUND' });
      const document = (await client.query('SELECT id FROM documents WHERE id = $1 AND request_id = $2', [evidence.documentId, input.requestId])).rows[0];
      if (!document) throw Object.assign(new Error('The evidence document does not belong to this request.'), { code: 'EVIDENCE_DOCUMENT_MISMATCH' });
      const evidenceId = input.id || id('hard-disqualifier-evidence');
      const inserted = (await client.query(`
        INSERT INTO hard_disqualifier_evidence (
          id, request_id, rule_code, evidence_type, source_authority, source_reference,
          evidence_document_id, findings, authorized, recorded_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9) RETURNING *
      `, [evidenceId, input.requestId, evidence.ruleCode, evidence.evidenceType,
        evidence.sourceAuthority, evidence.sourceReference, evidence.documentId,
        JSON.stringify(evidence.findings), input.actorId])).rows[0];
      await appendAudit(client, {
        actorId: input.actorId, actorType: 'staff', actionType: 'hard_disqualifier_evidence_recorded',
        recordType: 'hard_disqualifier_evidence', recordId: evidenceId,
        newValue: { requestId: input.requestId, ruleCode: evidence.ruleCode, evidenceType: evidence.evidenceType,
          sourceAuthority: evidence.sourceAuthority, sourceReference: evidence.sourceReference,
          evidenceDocumentId: evidence.documentId, findings: evidence.findings },
        justification: String(input.justification || 'Authorized evidence recorded for hard-disqualifier review.').trim(),
        correlationId: input.correlationId,
      });
      return inserted;
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async evaluateRequest(input) {
    return this.database.withTransaction((client) => evaluateHardDisqualifierInTransaction(client, input), { isolationLevel: 'SERIALIZABLE' });
  }

  async recordException(input) {
    const evidenceAuthority = String(input.evidenceAuthority || '').trim();
    const evidenceReference = String(input.evidenceReference || '').trim();
    const evidenceDocumentId = String(input.evidenceDocumentId || '').trim();
    const justification = String(input.justification || '').trim();
    if (!evidenceAuthority || !evidenceReference || !evidenceDocumentId || justification.length < 10) throw Object.assign(new Error('Exception evidence authority, reference, attached document, and a detailed justification are required.'), { code: 'EXCEPTION_EVIDENCE_REQUIRED' });
    return this.database.withTransaction(async (client) => {
      const actor = (await client.query(`
        SELECT s.id, s.role, s.active, EXISTS (
          SELECT 1 FROM staff_capabilities c WHERE c.staff_id = s.id
            AND c.capability = 'hard_disqualifier_exception' AND c.revoked_at IS NULL
        ) AS exception_capability
        FROM staff_accounts s WHERE s.id = $1
      `, [input.actorId])).rows[0];
      if (!actor || actor.active === false || !['System Administrator', 'Super Admin'].includes(actor.role) || actor.exception_capability !== true) {
        throw Object.assign(new Error('A designated System Administrator with the Super Admin exception capability is required.'), { code: 'EXCEPTION_PERMISSION_REQUIRED' });
      }
      const evaluation = (await client.query('SELECT * FROM hard_disqualifier_evaluations WHERE id = $1 AND request_id = $2 FOR SHARE', [input.evaluationId, input.requestId])).rows[0];
      if (!evaluation) throw Object.assign(new Error('Hard-disqualifier evaluation not found.'), { code: 'EVALUATION_NOT_FOUND' });
      if (evaluation.outcome !== 'blocked') throw Object.assign(new Error('An exception can only be attached to a blocked hard-disqualifier evaluation.'), { code: 'EXCEPTION_NOT_ALLOWED' });
      const document = (await client.query('SELECT id FROM documents WHERE id = $1 AND request_id = $2', [evidenceDocumentId, input.requestId])).rows[0];
      if (!document) throw Object.assign(new Error('The exception evidence document does not belong to this request.'), { code: 'EVIDENCE_DOCUMENT_MISMATCH' });
      const exceptionId = input.id || id('hard-disqualifier-exception');
      let inserted;
      try {
        inserted = (await client.query(`
          INSERT INTO hard_disqualifier_exceptions (
            id, request_id, evaluation_id, evidence_fingerprint, evidence_authority,
            evidence_reference, evidence_document_id, justification, actor_id
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
        `, [exceptionId, input.requestId, input.evaluationId, evaluation.evidence_fingerprint,
          evidenceAuthority, evidenceReference, evidenceDocumentId, justification, input.actorId])).rows[0];
      } catch (error) {
        if (error?.code === '23505') throw Object.assign(new Error('This evaluation already has an exception.'), { code: 'EXCEPTION_EXISTS' });
        throw error;
      }
      await appendAudit(client, {
        actorId: input.actorId, actorType: 'staff', actionType: 'hard_disqualifier_exception_recorded',
        recordType: 'hard_disqualifier_exception', recordId: exceptionId,
        oldValue: { evaluationId: evaluation.id, outcome: evaluation.outcome, reasonCodes: evaluation.reason_codes },
        newValue: { requestId: input.requestId, evidenceAuthority, evidenceReference, evidenceDocumentId,
          evidenceFingerprint: evaluation.evidence_fingerprint },
        justification, correlationId: input.correlationId,
      });
      return inserted;
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async setExceptionCapability(input) {
    const justification = String(input.justification || '').trim();
    if (!input.actorId || !input.staffId || !justification) throw new Error('Staff, actor, and justification are required.');
    return this.database.withTransaction(async (client) => {
      const target = (await client.query('SELECT id, role, active FROM staff_accounts WHERE id = $1', [input.staffId])).rows[0];
      if (!target || target.active === false || !['System Administrator', 'Super Admin'].includes(target.role)) throw Object.assign(new Error('The exception capability can only be assigned to an active System Administrator.'), { code: 'INVALID_EXCEPTION_CAPABILITY_TARGET' });
      const existing = (await client.query(`SELECT * FROM staff_capabilities WHERE staff_id = $1 AND capability = 'hard_disqualifier_exception' AND revoked_at IS NULL FOR UPDATE`, [input.staffId])).rows[0];
      if (input.active && !existing) await client.query(`INSERT INTO staff_capabilities (staff_id, capability, assigned_by, justification) VALUES ($1,'hard_disqualifier_exception',$2,$3)`, [input.staffId, input.actorId, justification]);
      if (!input.active && existing) await client.query(`UPDATE staff_capabilities SET revoked_at = now(), revoked_by = $2 WHERE staff_id = $1 AND capability = 'hard_disqualifier_exception' AND revoked_at IS NULL`, [input.staffId, input.actorId]);
      await appendAudit(client, { actorId: input.actorId, actorType: 'staff', actionType: input.active ? 'hard_disqualifier_exception_capability_assigned' : 'hard_disqualifier_exception_capability_revoked', recordType: 'staff_account', recordId: input.staffId, oldValue: { active: Boolean(existing) }, newValue: { capability: 'hard_disqualifier_exception', active: Boolean(input.active) }, justification });
      return { staffId: input.staffId, capability: 'hard_disqualifier_exception', active: Boolean(input.active) };
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async getRequestHistory({ requestId }) {
    const [evidence, evaluations, exceptions] = await Promise.all([
      this.database.query('SELECT * FROM hard_disqualifier_evidence WHERE request_id = $1 ORDER BY recorded_at DESC', [requestId]),
      this.database.query('SELECT * FROM hard_disqualifier_evaluations WHERE request_id = $1 ORDER BY evaluated_at DESC', [requestId]),
      this.database.query('SELECT * FROM hard_disqualifier_exceptions WHERE request_id = $1 ORDER BY created_at DESC', [requestId]),
    ]);
    return { evidence: evidence.rows, evaluations: evaluations.rows, exceptions: exceptions.rows };
  }
}

export class PostgresCoverageMatrixRepository extends CoverageMatrixRepository {
  constructor(database) { super(); this.database = database; }

  async recordVerifiedInput(input) {
    const source = String(input.verificationSource || '').trim();
    const justification = String(input.justification || '').trim();
    if (!['staff', 'integration'].includes(source) || !input.actorId || justification.length < 10) throw Object.assign(new Error('Staff or integration verification and a detailed justification are required.'), { code: 'COVERAGE_VERIFICATION_REQUIRED' });
    if (!input.inputData || typeof input.inputData !== 'object' || Array.isArray(input.inputData)) throw Object.assign(new Error('Structured coverage input data is required.'), { code: 'COVERAGE_INPUT_REQUIRED' });
    return this.database.withTransaction(async (client) => {
      const request = (await client.query('SELECT id FROM requests WHERE id = $1 FOR UPDATE', [input.requestId])).rows[0];
      if (!request) throw Object.assign(new Error('Request not found.'), { code: 'REQUEST_NOT_FOUND' });
      const nextVersion = Number((await client.query('SELECT COALESCE(max(version),0)+1 AS value FROM coverage_input_versions WHERE request_id = $1', [input.requestId])).rows[0].value);
      const inputId = input.id || id('coverage-input');
      const normalizedInput = { ...input.inputData, payerDeductions: (Array.isArray(input.inputData.payerDeductions) ? input.inputData.payerDeductions : []).map((item) => ({ ...item, verified: true, verificationMethod: source })) };
      const recorded = (await client.query(`INSERT INTO coverage_input_versions (id, request_id, version, input_data, verified_by, verification_source, justification) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [inputId, input.requestId, nextVersion, normalizedInput, input.actorId, source, justification])).rows[0];
      await appendAudit(client, { actorId: input.actorId, actorType: 'staff', actionType: 'coverage_inputs_verified', recordType: 'coverage_input_version', recordId: inputId, newValue: { requestId: input.requestId, version: nextVersion, verificationSource: source, payerTypes: normalizedInput.payerDeductions.map((item) => item.payerType) }, justification });
      return recorded;
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  calculateRequest(input) { return this.database.withTransaction((client) => calculateCoverageInTransaction(client, input), { isolationLevel: 'SERIALIZABLE' }); }

  async getRequestHistory({ requestId }) {
    const [inputs, calculations] = await Promise.all([
      this.database.query('SELECT * FROM coverage_input_versions WHERE request_id = $1 ORDER BY version DESC', [requestId]),
      this.database.query('SELECT * FROM coverage_calculation_snapshots WHERE request_id = $1 ORDER BY calculated_at DESC', [requestId]),
    ]);
    return { inputs: inputs.rows, calculations: calculations.rows };
  }
}

export function createPostgresRepositories(database) {
  return Object.freeze({
    aidLink: new PostgresAidLinkRepository(database),
    policies: new PostgresPolicyRepository(database),
    facilities: new PostgresFacilityRoutingRepository(database),
    hardDisqualifiers: new PostgresHardDisqualifierRepository(database),
    coverage: new PostgresCoverageMatrixRepository(database),
    workflow: new PostgresWorkflowEvaluationRepository(database),
    unitOfWork: new PostgresUnitOfWork(database),
  });
}
