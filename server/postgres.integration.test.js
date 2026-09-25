import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createDatabase } from './storage/database.js';
import { runMigrations } from './storage/migrationRunner.js';
import { createPostgresRepositories } from './storage/postgresRepositories.js';

const connectionString = process.env.AIDLINK_TEST_DATABASE_URL;

test('PostgreSQL transactions, concurrency, idempotency, audit immutability, and health', {
  skip: !connectionString && 'Set AIDLINK_TEST_DATABASE_URL to run PostgreSQL integration tests.',
  timeout: 60_000,
}, async (t) => {
  const schema = `aidlink_test_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const database = createDatabase({
    database: { connectionString, options: `-c search_path=${schema}` },
    ssl: false,
    maxConnections: 6,
    connectionTimeoutMs: 5000,
    idleTimeoutMs: 5000,
  });
  t.after(async () => {
    await database.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  await runMigrations(database);
  assert.equal((await database.health()).status, 'ok');
  await database.query(`
    INSERT INTO applicants (id,email,full_name) VALUES ('applicant-test','applicant@test.invalid','Applicant Test');
    INSERT INTO staff_accounts (id,email,full_name,role) VALUES
      ('staff-test','staff@test.invalid','Staff Test','Case Worker'),
      ('admin-test','admin@test.invalid','Admin Test','System Administrator'),
      ('admin-grant','admin-grant@test.invalid','Admin Grant','System Administrator');
    INSERT INTO offices (id,office_code,name,office_type,residency_boundary)
      VALUES ('office-test','DISTRICT-01','District 01','district_satellite','{"barangays":["Barangay Uno"]}');
    INSERT INTO policy_configurations (
      id,policy_key,version,policy_version,configuration,effective_from,effective_date,
      created_by,actor_id,new_value,justification
    ) VALUES ('policy-test','coverage',1,'coverage:global:v1','{}',now(),now(),'staff-test','staff-test','{}','Integration policy');
    INSERT INTO budgets (id,name,period_start,period_end,allocated_amount,policy_version_id)
      VALUES ('budget-test','Test budget',current_date,current_date + 30,100,'policy-test');
  `);
  const repositories = createPostgresRepositories(database);
  const nextPolicy = await repositories.policies.createPolicyVersion({
    policyKey: 'coverage', configuration: { maximum: 5000 },
    actorId: 'admin-test', justification: 'Raise the test coverage limit.',
  });
  assert.equal(nextPolicy.version, 2);
  assert.equal(nextPolicy.policyVersion, 'coverage:global:v2');
  assert.deepEqual(nextPolicy.oldValue, {});
  const requestInput = {
    id: 'request-test',
    requestNumber: 'TEST-0001',
    applicantId: 'applicant-test',
    beneficiary: { id: 'beneficiary-test', fullName: 'Applicant Test', isRequester: true },
    assistanceType: 'Medical Assistance',
    policyVersionId: 'policy-test',
    decisionSnapshot: { policyVersion: 1 },
    policyVersion: 'coverage:global:v1',
    originatingOfficeId: 'office-test',
    idempotencyKey: 'submission-test',
  };
  const first = await repositories.aidLink.submitRequest(requestInput);
  const replay = await repositories.aidLink.submitRequest(requestInput);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(Number((await database.query(`SELECT count(*) FROM requests WHERE id = 'request-test'`)).rows[0].count), 1);

  await repositories.policies.recordPolicyEvaluation({
    requestId: 'request-test', originatingOfficeId: 'office-test',
    authorizedReEvaluation: true,
    policyVersionId: nextPolicy.id, policyVersion: nextPolicy.policyVersion,
    evaluatorName: 'integration-evaluator', evaluatorVersion: '1', outcome: 'advisory',
    findings: [{ code: 'POLICY_FOUNDATION_ONLY', blocking: false }], requiredReviews: [],
    decisions: { eligibility: 'not_evaluated', coverage: 'not_evaluated', expiry: 'not_evaluated', budget: 'not_evaluated' },
    actorId: 'staff-test', justification: 'Integration policy evaluation.',
  });
  const policyState = (await database.query(`SELECT * FROM requests WHERE id = 'request-test'`)).rows[0];
  assert.equal(policyState.originating_office_id, 'office-test');
  assert.equal(policyState.policy_version, nextPolicy.policyVersion);
  assert.equal(policyState.decision_snapshot.evaluator.name, 'integration-evaluator');
  assert.equal(Number((await database.query(`SELECT count(*) FROM audit_logs WHERE actor_type = 'staff' AND action_type IN ('policy_version_published','policy_re_evaluated')`)).rows[0].count), 2);

  const concurrent = await Promise.allSettled([
    repositories.aidLink.reserveBudget({ budgetId: 'budget-test', requestId: 'request-test', amount: 60, idempotencyKey: 'reserve-a', actorId: 'staff-test' }),
    repositories.aidLink.reserveBudget({ budgetId: 'budget-test', requestId: 'request-test', amount: 60, idempotencyKey: 'reserve-b', actorId: 'staff-test' }),
  ]);
  assert.equal(concurrent.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(Number((await database.query(`SELECT reserved_amount FROM budgets WHERE id = 'budget-test'`)).rows[0].reserved_amount), 60);

  await database.query(`UPDATE requests SET status = 'under_review' WHERE id = 'request-test'`);
  await assert.rejects(repositories.aidLink.recordDecision({
    requestId: 'request-test', policyVersionId: 'missing-policy-version', decision: 'approved',
    decisionSnapshot: { policyVersion: 1 }, actorId: 'staff-test', justification: 'Integration rollback check',
  }));
  assert.equal((await database.query(`SELECT status FROM requests WHERE id = 'request-test'`)).rows[0].status, 'under_review');
  assert.equal(Number((await database.query(`SELECT count(*) FROM coverage_decisions WHERE request_id = 'request-test'`)).rows[0].count), 0);

  const audit = await database.query(`SELECT id FROM audit_logs LIMIT 1`);
  await assert.rejects(database.query('UPDATE audit_logs SET justification = $2 WHERE id = $1', [audit.rows[0].id, 'changed']));

  const receiptType = 'Recent facility receipt or billing document';
  const gatedInput = (key, suffix = key) => ({
    applicantId: 'applicant-test', authenticatedApplicantId: 'applicant-test',
    idempotencyKey: key, beneficiaryType: 'other',
    beneficiary: { fullName: 'Cooldown Patient', dateOfBirth: '1992-04-10', address: 'Barangay Uno, District 01', relationshipToApplicant: 'Sibling' },
    assistanceType: 'Burial Assistance', incomeSource: 'Employment', patientCircumstance: 'Disease',
    originatingOfficeId: 'office-test', requiredDocuments: [receiptType],
    latitude: 7.1, longitude: 125.6,
    facilityEvidence: { facilityName: 'District Hospital', facilityType: 'hospital', receiptDate: '2026-09-01', referenceNumber: 'R-GATE', receiptDocumentId: `gate-doc-${suffix}` },
    documents: [{ id: `gate-doc-${suffix}`, name: receiptType, documentType: receiptType, storageKey: `gate/${suffix}.pdf`, mimeType: 'application/pdf', analysis: { analyzerName: 'test', analyzerVersion: '1', accepted: true, outcome: 'accepted', documentType: receiptType } }],
    now: new Date('2026-09-24T00:00:00.000Z'), submittedAt: new Date('2026-09-24T00:00:00.000Z'),
  });
  const concurrentGates = await Promise.all([
    repositories.aidLink.submitRequestWithPolicyGates(gatedInput('gate-concurrent-a', 'a')),
    repositories.aidLink.submitRequestWithPolicyGates(gatedInput('gate-concurrent-b', 'b')),
  ]);
  assert.equal(concurrentGates.filter((item) => item.created).length, 1);
  const duplicateGate = concurrentGates.find((item) => !item.created);
  assert.equal(duplicateGate.gateResult.outcome, 'blocked');
  assert.ok(duplicateGate.gateResult.existingRequestReference);
  const createdGate = concurrentGates.find((item) => item.created);
  assert.equal(createdGate.request.status, 'pending');
  await database.query(`UPDATE requests SET status = 'denied' WHERE id = $1`, [createdGate.request.id]);
  const cooldownGate = await repositories.aidLink.submitRequestWithPolicyGates(gatedInput('gate-cooldown', 'cooldown'));
  assert.equal(cooldownGate.created, false);
  assert.equal(cooldownGate.gateResult.reasonCodes.includes('PATIENT_COOLDOWN_ACTIVE'), true);
  assert.ok(cooldownGate.gateResult.cooldownEndDate);
  const afterCooldownInput = gatedInput('gate-after-cooldown', 'after');
  afterCooldownInput.now = new Date('2026-10-25T00:00:00.000Z');
  afterCooldownInput.submittedAt = afterCooldownInput.now;
  afterCooldownInput.facilityEvidence.receiptDate = '2026-10-24';
  const afterCooldown = await repositories.aidLink.submitRequestWithPolicyGates(afterCooldownInput);
  assert.equal(afterCooldown.created, true);
  assert.equal(afterCooldown.gateResult.outcome, 'passed');

  const outsideInput = gatedInput('gate-outside', 'outside');
  outsideInput.beneficiary = { ...outsideInput.beneficiary, fullName: 'Outside Patient', address: 'Barangay Dos' };
  outsideInput.facilityEvidence.referenceNumber = 'R-OUTSIDE';
  const outside = await repositories.aidLink.submitRequestWithPolicyGates(outsideInput);
  assert.equal(outside.created, false);
  assert.equal(outside.gateResult.reasonCodes.includes('RESIDENCY_OUTSIDE_BOUNDARY'), true);
  await assert.rejects(repositories.aidLink.overrideSubmissionPolicyGate({
    evaluationId: outside.evaluationId, actorId: 'staff-test', reason: '',
  }), /override reason is required/i);
  await repositories.aidLink.overrideSubmissionPolicyGate({
    evaluationId: outside.evaluationId, actorId: 'staff-test', reason: 'Barangay certificate verified by the assigned Case Worker.',
  });
  const overrideRetry = await repositories.aidLink.submitRequestWithPolicyGates({ ...outsideInput, idempotencyKey: 'gate-outside-retry' });
  assert.equal(overrideRetry.created, true);
  assert.equal(overrideRetry.gateResult.reasonCodes.includes('RESIDENCY_OVERRIDE_APPLIED'), true);
  assert.equal(Number((await database.query(`SELECT count(*) FROM audit_logs WHERE action_type = 'submission_policy_gates_evaluated'`)).rows[0].count), 6);
  assert.equal(Number((await database.query(`SELECT count(*) FROM audit_logs WHERE action_type = 'submission_residency_overridden'`)).rows[0].count), 1);

  const unknownResolution = await repositories.facilities.resolveRequestFacility({
    requestId: createdGate.request.id, actorId: 'staff-test', actorType: 'staff',
  });
  assert.equal(unknownResolution.resolution.outcome, 'human_review_required');
  assert.equal(unknownResolution.resolution.reasonCodes.includes('PRIVATE_PARTNER_LIST_PENDING'), true);

  const publicInput = gatedInput('facility-public', 'public');
  publicInput.beneficiary = { ...publicInput.beneficiary, fullName: 'Public Facility Patient' };
  publicInput.assistanceType = 'Financial Assistance';
  publicInput.facilityEvidence.facilityName = 'SPMC';
  publicInput.facilityEvidence.referenceNumber = 'R-SPMC';
  const publicRequest = await repositories.aidLink.submitRequestWithPolicyGates(publicInput);
  assert.equal(publicRequest.created, true);
  const publicResolution = await repositories.facilities.resolveRequestFacility({ requestId: publicRequest.request.id, actorId: 'staff-test', actorType: 'staff' });
  assert.equal(publicResolution.facility.tier, 'public');
  assert.equal(publicResolution.facility.classification_category, 'hospital');
  assert.equal(publicResolution.pricing.status, 'not_applicable');

  await assert.rejects(repositories.facilities.createDirectoryVersion({
    directory: { entries: [{ key: 'only-one', canonicalName: 'Only One Clinic', tier: 'private', category: 'clinic', effectiveFrom: '2026-01-01' }], clientApprovalReference: 'CLIENT-42' },
    actorId: 'admin-test', authoritativeSource: 'Client list', justification: 'Incomplete test list.',
  }), /complete authoritative list of 42 partners/);
  const privateEntries = Array.from({ length: 42 }, (_, index) => ({
    key: `private-${index + 1}`, canonicalName: `Private Partner ${index + 1}`,
    aliases: [], tier: 'private', category: index === 0 ? 'clinic' : 'pharmacy', effectiveFrom: '2026-01-01',
  }));
  const currentDirectory = await repositories.facilities.getEffectiveDirectory({ at: new Date('2026-09-24T00:00:00Z') });
  const directoryV2 = await repositories.facilities.createDirectoryVersion({
    directory: { ...currentDirectory.directory, status: 'active', clientApprovalReference: 'CLIENT-APPROVAL-42', entries: [...currentDirectory.directory.entries, ...privateEntries] },
    actorId: 'admin-test', authoritativeSource: 'Client-approved authoritative 42-partner list',
    justification: 'Integration private partner directory.', effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  });
  assert.equal(directoryV2.version, 2);
  await assert.rejects(database.query('UPDATE facility_directory_versions SET justification = $2 WHERE id = $1', [directoryV2.id, 'changed']));

  const privateInput = gatedInput('facility-private', 'private');
  privateInput.beneficiary = { ...privateInput.beneficiary, fullName: 'Private Prescription Patient' };
  privateInput.assistanceType = 'Medical Assistance';
  privateInput.facilityEvidence.facilityName = 'Private Partner 1';
  privateInput.facilityEvidence.referenceNumber = 'R-PRIVATE';
  privateInput.documents.push({
    id: 'private-prescription', name: 'Prescription', documentType: 'Prescription',
    storageKey: 'gate/private-prescription.pdf', mimeType: 'application/pdf',
    analysis: { analyzerName: 'test', analyzerVersion: '1', accepted: true, outcome: 'accepted', documentType: 'Prescription' },
  });
  const privateRequest = await repositories.aidLink.submitRequestWithPolicyGates(privateInput);
  assert.equal(privateRequest.created, true);
  const privateResolution = await repositories.facilities.resolveRequestFacility({ requestId: privateRequest.request.id, actorId: 'staff-test', actorType: 'staff', at: new Date('2026-09-24T00:00:00Z') });
  assert.equal(privateResolution.facility.tier, 'private');
  assert.equal(privateResolution.pricing.status, 'locked');
  await assert.rejects(repositories.facilities.recordChoPrescriptionDecision({
    requestId: privateRequest.request.id, actorId: 'admin-test', status: 'approved', reason: 'No capability.',
  }), /City Health Office validation access is required/);
  await repositories.facilities.setChoValidatorCapability({
    staffId: 'staff-test', actorId: 'admin-test', active: true, justification: 'Assigned CHO validator for integration testing.',
  });
  const approvedPricing = await repositories.facilities.recordChoPrescriptionDecision({
    requestId: privateRequest.request.id, actorId: 'staff-test', status: 'approved', reason: 'Prescription details validated by CHO.',
  });
  assert.equal(approvedPricing.partnerPricingStatus, 'unlocked');
  const rejectedPricing = await repositories.facilities.recordChoPrescriptionDecision({
    requestId: privateRequest.request.id, actorId: 'staff-test', status: 'rejected', reason: 'Subsequent CHO review found invalid prescription details.',
  });
  assert.equal(rejectedPricing.partnerPricingStatus, 'locked');
  const routingStatus = await repositories.facilities.getRequestRoutingStatus({ requestId: privateRequest.request.id });
  assert.equal(routingStatus.choValidation.status, 'rejected');
  assert.equal(routingStatus.request.partner_pricing_status, 'locked');

  const hardRequest = await repositories.aidLink.submitRequest({
    id: 'hard-request', requestNumber: 'TEST-HARD-0001', applicantId: 'applicant-test',
    beneficiary: { id: 'hard-beneficiary', fullName: 'Hard Rule Patient', isRequester: false },
    assistanceType: 'Medical Assistance', patientCircumstance: 'Accident',
    policyVersionId: nextPolicy.id, policyVersion: nextPolicy.policyVersion,
    decisionSnapshot: {}, originatingOfficeId: 'office-test', idempotencyKey: 'hard-rule-request',
    documents: [{ id: 'hard-traffic-report', documentType: 'Traffic accident report', displayName: 'Traffic accident report', storageKey: 'hard/traffic-report.pdf', mimeType: 'application/pdf' }],
  });
  assert.equal(hardRequest.replayed, false);
  await repositories.hardDisqualifiers.recordEvidence({
    requestId: hardRequest.request.id, actorId: 'staff-test',
    ruleCode: 'motorcycle_helmet', evidenceType: 'traffic_accident_report',
    sourceAuthority: 'Davao City Traffic Enforcement Unit', sourceReference: 'TRAFFIC-2026-001',
    documentId: 'hard-traffic-report', findings: { incidentType: 'motorcycle_accident', helmetStatus: 'not_worn' },
    justification: 'Record the helmet finding from the authorized traffic report.',
  });
  const hardEvaluation = await repositories.hardDisqualifiers.evaluateRequest({ requestId: hardRequest.request.id, actorId: 'staff-test' });
  assert.equal(hardEvaluation.outcome, 'blocked');
  assert.equal(hardEvaluation.reasonCodes.includes('MOTORCYCLE_NO_HELMET'), true);
  await assert.rejects(repositories.aidLink.recordDecision({
    requestId: hardRequest.request.id, decision: 'approved', policyVersionId: nextPolicy.id,
    decisionSnapshot: {}, actorId: 'staff-test', justification: 'Attempt approval before exception.',
    budgetReservation: { budgetId: 'budget-test', amount: 10, idempotencyKey: 'hard-budget-before-exception' },
  }), (error) => error.code === 'HARD_DISQUALIFIER_BLOCKED' && error.policyResult.reasonCodes.includes('MOTORCYCLE_NO_HELMET'));
  assert.equal(Number((await database.query(`SELECT count(*) FROM coverage_decisions WHERE request_id = 'hard-request'`)).rows[0].count), 0);
  assert.equal(Number((await database.query(`SELECT count(*) FROM budget_reservations WHERE request_id = 'hard-request'`)).rows[0].count), 0);
  await assert.rejects(repositories.hardDisqualifiers.recordException({
    requestId: hardRequest.request.id, evaluationId: hardEvaluation.evaluationId, actorId: 'staff-test',
    evidenceAuthority: 'Authorized appeals panel', evidenceReference: 'EXC-001', evidenceDocumentId: 'hard-traffic-report',
    justification: 'Case Worker must not be able to create this exception.',
  }), /designated System Administrator/i);
  await assert.rejects(repositories.hardDisqualifiers.recordException({
    requestId: hardRequest.request.id, evaluationId: hardEvaluation.evaluationId, actorId: 'admin-test',
    evidenceAuthority: 'Authorized appeals panel', evidenceReference: 'EXC-001', evidenceDocumentId: 'hard-traffic-report',
    justification: 'Administrator without separate authority must be rejected.',
  }), /exception capability/i);
  await repositories.hardDisqualifiers.setExceptionCapability({
    staffId: 'admin-test', actorId: 'admin-grant', active: true,
    justification: 'Designate this administrator for independently reviewed hard-rule exceptions.',
  });
  const hardException = await repositories.hardDisqualifiers.recordException({
    requestId: hardRequest.request.id, evaluationId: hardEvaluation.evaluationId, actorId: 'admin-test',
    evidenceAuthority: 'Authorized appeals panel', evidenceReference: 'EXC-001', evidenceDocumentId: 'hard-traffic-report',
    justification: 'Authorized panel approved a documented exceptional treatment after independent review.',
  });
  await assert.rejects(database.query('UPDATE hard_disqualifier_exceptions SET justification = $2 WHERE id = $1', [hardException.id, 'changed']));
  const exceptionEvaluation = await repositories.hardDisqualifiers.evaluateRequest({ requestId: hardRequest.request.id, actorId: 'admin-test' });
  assert.equal(exceptionEvaluation.outcome, 'exception_applied');
  assert.equal(exceptionEvaluation.approvalAllowed, true);
  const hardApproval = await repositories.aidLink.recordDecision({
    requestId: hardRequest.request.id, decision: 'approved', policyVersionId: nextPolicy.id,
    decisionSnapshot: {}, actorId: 'staff-test', justification: 'Approve after the authorized immutable exception.',
    budgetReservation: { budgetId: 'budget-test', amount: 10, idempotencyKey: 'hard-budget-after-exception' },
  });
  assert.equal(hardApproval.status, 'approved');
  assert.equal(Number((await database.query(`SELECT count(*) FROM audit_logs WHERE action_type = 'hard_disqualifier_exception_recorded' AND affected_record_id = $1`, [hardException.id])).rows[0].count), 1);

  const activeCoveragePolicy = await repositories.policies.createPolicyVersion({
    policyKey: 'coverage_matrix', actorId: 'admin-test', effectiveDate: new Date('2026-01-01T00:00:00Z'),
    justification: 'Activate isolated test-only coverage values.',
    configuration: {
      status: 'active', publicHospitalRoomReductions: { semi_private: 0.25, private: 0.5 },
      outsidePharmacyMedicineReductionRate: 0.4,
      partialIndigentSubsidyBands: [{ code: 'test-band', rate: 0.5 }],
      coverageCaps: { default: 30, byAssistanceType: {} },
      payerDeductions: { enabled: true, required: true, clientApprovalReference: 'TEST-CLIENT-PAYER', approvedPayerTypes: ['Test payer'], verificationMethods: ['staff', 'integration'] },
    },
  });
  const coverageRequest = await repositories.aidLink.submitRequest({
    id: 'coverage-request', requestNumber: 'TEST-COVERAGE-0001', applicantId: 'applicant-test',
    beneficiary: { id: 'coverage-beneficiary', fullName: 'Coverage Patient', isRequester: false },
    assistanceType: 'Hospital Assistance', patientCircumstance: 'Disease',
    policyVersionId: nextPolicy.id, policyVersion: nextPolicy.policyVersion,
    decisionSnapshot: {}, originatingOfficeId: 'office-test', idempotencyKey: 'coverage-request',
  });
  await database.query(`UPDATE requests SET facility_tier_snapshot = 'public' WHERE id = $1`, [coverageRequest.request.id]);
  const coverageInput = await repositories.coverage.recordVerifiedInput({
    requestId: coverageRequest.request.id, actorId: 'staff-test', verificationSource: 'staff',
    justification: 'Staff verified bill, payer, room, medicine, and subsidy evidence.',
    inputData: {
      grossAmount: 40, payerDeductions: [{ payerType: 'Test payer', amount: 10, reference: 'TEST-PAYER-1' }],
      roomClass: 'private', roomCharges: 10,
      medicineItems: [{ amount: 5, formulary: false, branded: true, pharmacyAccredited: false }],
      subsidyBand: 'test-band', subsidyBandVerified: true,
    },
  });
  assert.equal(coverageInput.version, 1);
  const beforeHardClearance = await repositories.coverage.calculateRequest({ requestId: coverageRequest.request.id, actorId: 'staff-test' });
  assert.equal(beforeHardClearance.outcome, 'ineligible');
  assert.equal(beforeHardClearance.reasonCodes.includes('HARD_DISQUALIFIER_NOT_CLEARED'), true);
  const coverageDecision = await repositories.aidLink.recordDecision({
    requestId: coverageRequest.request.id, decision: 'approved', policyVersionId: nextPolicy.id,
    decisionSnapshot: {}, actorId: 'staff-test', justification: 'Approve after ordered hard-rule and coverage evaluation.',
    budgetReservation: { budgetId: 'budget-test', amount: 999, idempotencyKey: 'coverage-budget' },
  });
  assert.equal(coverageDecision.status, 'approved');
  const storedCoverageDecision = (await database.query(`SELECT * FROM coverage_decisions WHERE request_id = $1 ORDER BY decided_at DESC LIMIT 1`, [coverageRequest.request.id])).rows[0];
  assert.equal(Number(storedCoverageDecision.amount), 11.5);
  assert.ok(storedCoverageDecision.coverage_snapshot_id);
  const storedCoverage = (await database.query('SELECT * FROM coverage_calculation_snapshots WHERE id = $1', [storedCoverageDecision.coverage_snapshot_id])).rows[0];
  assert.equal(storedCoverage.policy_version, activeCoveragePolicy.policyVersion);
  assert.equal(storedCoverage.result.patientBalance, 30);
  assert.equal(storedCoverage.result.eligibleBase, 23);
  assert.equal(storedCoverage.result.coveredAmount, 11.5);
  assert.equal(storedCoverage.result.netRemainingBalance, 18.5);
  await assert.rejects(database.query('UPDATE coverage_calculation_snapshots SET calculator_version = $2 WHERE id = $1', [storedCoverage.id, 'changed']));
  assert.equal(Number((await database.query(`SELECT count(*) FROM budget_reservations WHERE request_id = $1`, [coverageRequest.request.id])).rows[0].count), 0, 'approval does not reserve funds before Guarantee Letter release');

  const workflowRequest = await repositories.aidLink.submitRequest({
    id: 'workflow-request', requestNumber: 'TEST-WORKFLOW-0001', applicantId: 'applicant-test',
    beneficiary: { id: 'workflow-beneficiary', fullName: 'Workflow Patient', isRequester: false },
    assistanceType: 'Hospital Assistance', patientCircumstance: 'Disease', policyVersionId: nextPolicy.id,
    policyVersion: nextPolicy.policyVersion, decisionSnapshot: {}, originatingOfficeId: 'office-test', idempotencyKey: 'workflow-request',
  });
  await database.query(`UPDATE requests SET facility_tier_snapshot='public' WHERE id=$1`, [workflowRequest.request.id]);
  await repositories.coverage.recordVerifiedInput({ requestId: workflowRequest.request.id, actorId: 'staff-test', verificationSource: 'staff', justification: 'Verified workflow coverage inputs for the integration sequence.', inputData: { grossAmount: 20, payerDeductions: [{ payerType: 'Test payer', amount: 5, reference: 'WORKFLOW-PAYER-1' }], roomClass: 'standard', roomCharges: 0, medicineItems: [], subsidyBand: 'test-band', subsidyBandVerified: true } });
  await assert.rejects(repositories.workflow.evaluateRequest({ requestId: workflowRequest.request.id, actorId: 'staff-test', remarks: 'short' }), /at least 10/i);
  const workflowEvaluation = await repositories.workflow.evaluateRequest({ requestId: workflowRequest.request.id, actorId: 'staff-test', remarks: 'Evidence and coverage reviewed for a separate decision.' });
  assert.equal(workflowEvaluation.outcome, 'ready_for_decision');
  assert.equal(workflowEvaluation.coverage.outcome, 'partially_covered');
  assert.equal((await database.query(`SELECT status FROM requests WHERE id=$1`, [workflowRequest.request.id])).rows[0].status, 'pending');
  await assert.rejects(repositories.workflow.confirmEvaluation({ requestId: workflowRequest.request.id, evaluationId: workflowEvaluation.evaluationId, actorId: 'staff-test', evidenceReviewed: true, coverageConfirmed: true, remarks: 'Cannot confirm while pending.' }), /under review/i);
  await database.query(`UPDATE requests SET status='under_review' WHERE id=$1`, [workflowRequest.request.id]);
  await assert.rejects(repositories.workflow.confirmEvaluation({ requestId: workflowRequest.request.id, evaluationId: workflowEvaluation.evaluationId, actorId: 'staff-test', evidenceReviewed: false, coverageConfirmed: true, remarks: 'Missing evidence confirmation.' }), /confirm evidence review/i);
  const workflowConfirmation = await repositories.workflow.confirmEvaluation({ requestId: workflowRequest.request.id, evaluationId: workflowEvaluation.evaluationId, actorId: 'staff-test', evidenceReviewed: true, coverageConfirmed: true, remarks: 'Evidence and calculated coverage confirmed for decision.' });
  const approvalValidation = await repositories.workflow.validateForApproval({ requestId: workflowRequest.request.id, actorId: 'staff-test' });
  assert.equal(approvalValidation.approvalAllowed, true);
  await database.query(`UPDATE budgets SET reserved_amount=reserved_amount+1,updated_at=now() WHERE id='budget-test'`);
  const changedValidation = await repositories.workflow.validateForApproval({ requestId: workflowRequest.request.id, actorId: 'staff-test' });
  assert.equal(changedValidation.approvalAllowed, false);
  assert.equal(changedValidation.code, 'WORKFLOW_EVALUATION_CHANGED');
  assert.equal((await database.query(`SELECT status FROM requests WHERE id=$1`, [workflowRequest.request.id])).rows[0].status, 'under_review');
  await assert.rejects(database.query('UPDATE workflow_evaluation_confirmations SET remarks=$2 WHERE id=$1', [workflowConfirmation.id, 'changed']));

  const controlledPool = await repositories.aidLink.createBudgetPool({
    id: 'hospital-budget-2026', name: 'Hospital Assistance 2026', assistanceType: 'Hospital Assistance',
    effectiveFrom: '2026-01-01', effectiveUntil: '2026-12-31', allocatedAmount: 26,
    assistanceLimit: 15, depletionThresholdAmount: 14.5, guaranteeLetterValidityDays: 3,
    actorId: 'admin-test', justification: 'Integration-controlled Hospital Assistance pool.',
  });
  assert.equal(controlledPool.guarantee_letter_validity_days, 3);
  await assert.rejects(repositories.aidLink.createBudgetPool({
    name: 'Overlapping Hospital Pool', assistanceType: 'Hospital Assistance', effectiveFrom: '2026-06-01', effectiveUntil: '2026-12-31', allocatedAmount: 100,
    assistanceLimit: 20, depletionThresholdAmount: 0, guaranteeLetterValidityDays: 7, actorId: 'admin-test', justification: 'Must be rejected because dates overlap.',
  }), (error) => error.code === 'BUDGET_PERIOD_OVERLAP');

  const secondCoverageRequest = await repositories.aidLink.submitRequest({
    id: 'coverage-request-2', requestNumber: 'TEST-COVERAGE-0002', applicantId: 'applicant-test',
    beneficiary: { id: 'coverage-beneficiary-2', fullName: 'Coverage Patient Two', isRequester: false },
    assistanceType: 'Hospital Assistance', patientCircumstance: 'Disease', policyVersionId: nextPolicy.id,
    policyVersion: nextPolicy.policyVersion, decisionSnapshot: {}, originatingOfficeId: 'office-test', idempotencyKey: 'coverage-request-2',
  });
  await database.query(`UPDATE requests SET facility_tier_snapshot='public' WHERE id=$1`, [secondCoverageRequest.request.id]);
  await repositories.coverage.recordVerifiedInput({ requestId: secondCoverageRequest.request.id, actorId: 'staff-test', verificationSource: 'staff', justification: 'Staff verified the second request coverage inputs.', inputData: { grossAmount: 40, payerDeductions: [{ payerType: 'Test payer', amount: 10, reference: 'TEST-PAYER-2' }], roomClass: 'private', roomCharges: 10, medicineItems: [{ amount: 5, formulary: false, branded: true, pharmacyAccredited: false }], subsidyBand: 'test-band', subsidyBandVerified: true } });
  await repositories.aidLink.recordDecision({ requestId: secondCoverageRequest.request.id, decision: 'approved', policyVersionId: nextPolicy.id, decisionSnapshot: {}, actorId: 'staff-test', justification: 'Approve the second request before controlled release.' });

  const releaseAt = new Date('2026-09-25T00:00:00.000Z');
  const releaseInput = (requestId, letterId) => ({ requestId, letterId, letter: { version: 1, sourceMimeType: 'application/pdf', originalStorageKey: `letters/${letterId}-original.pdf`, pdfStorageKey: `letters/${letterId}-view.pdf`, uploadedAt: releaseAt, reviewedAt: releaseAt }, claimingDate: '2026-09-26', claimingTime: '09:00', claimingLocation: 'LINGAP desk', qrTokenHash: `hash-${letterId}`, releasedAt: releaseAt, actorId: 'staff-test', justification: 'Release after the approved amount and current city budget were rechecked.' });
  const concurrentReleases = await Promise.allSettled([
    repositories.aidLink.releaseGuaranteeLetter(releaseInput(coverageRequest.request.id, 'controlled-letter-1')),
    repositories.aidLink.releaseGuaranteeLetter(releaseInput(secondCoverageRequest.request.id, 'controlled-letter-2')),
  ]);
  assert.equal(concurrentReleases.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(concurrentReleases.filter((item) => item.status === 'rejected' && item.reason.code === 'BUDGET_DEPLETED').length, 1);
  assert.equal(Number((await database.query(`SELECT reserved_amount FROM budgets WHERE id='hospital-budget-2026'`)).rows[0].reserved_amount), 11.5);
  assert.equal(Number((await database.query(`SELECT count(*) FROM budget_reservations WHERE budget_id='hospital-budget-2026' AND status='reserved'`)).rows[0].count), 1);
  const depletedSubmissionInput = gatedInput('gate-budget-depleted', 'budget-depleted');
  depletedSubmissionInput.assistanceType = 'Hospital Assistance';
  depletedSubmissionInput.beneficiary = { ...depletedSubmissionInput.beneficiary, fullName: 'Budget Depletion Patient', dateOfBirth: '1993-05-11' };
  depletedSubmissionInput.facilityEvidence.referenceNumber = 'R-BUDGET-DEPLETED';
  depletedSubmissionInput.facilityEvidence.receiptDate = '2026-09-25';
  depletedSubmissionInput.now = releaseAt;
  depletedSubmissionInput.submittedAt = releaseAt;
  const depletedSubmission = await repositories.aidLink.submitRequestWithPolicyGates(depletedSubmissionInput);
  assert.equal(depletedSubmission.created, false);
  assert.equal(depletedSubmission.gateResult.outcome, 'blocked');
  assert.equal(depletedSubmission.gateResult.reasonCodes.includes('BUDGET_DEPLETED'), true);
  assert.match(depletedSubmission.gateResult.findings.find((item) => item.code === 'BUDGET_DEPLETED').message, /city budget|new budget period/i);

  const succeededIndex = concurrentReleases.findIndex((item) => item.status === 'fulfilled');
  const failedIndex = succeededIndex === 0 ? 1 : 0;
  const succeededRequestId = succeededIndex === 0 ? coverageRequest.request.id : secondCoverageRequest.request.id;
  const succeededLetterId = succeededIndex === 0 ? 'controlled-letter-1' : 'controlled-letter-2';
  const failedRequestId = failedIndex === 0 ? coverageRequest.request.id : secondCoverageRequest.request.id;
  const failedLetterId = failedIndex === 0 ? 'controlled-letter-1' : 'controlled-letter-2';
  await assert.rejects(repositories.aidLink.expireGuaranteeLetter({ letterId: succeededLetterId, now: new Date('2026-09-27T23:59:59.999Z') }), (error) => error.code === 'LETTER_NOT_EXPIRED');
  const expired = await repositories.aidLink.expireGuaranteeLetter({ letterId: succeededLetterId, now: new Date('2026-09-28T00:00:00.000Z'), actorId: 'system', actorType: 'system', justification: 'Three-day validity boundary reached.' });
  assert.equal(expired.status, 'expired');
  assert.equal(Number((await database.query(`SELECT reserved_amount FROM budgets WHERE id='hospital-budget-2026'`)).rows[0].reserved_amount), 0);
  assert.equal((await database.query('SELECT status FROM requests WHERE id=$1', [succeededRequestId])).rows[0].status, 'approved');

  const retried = await repositories.aidLink.releaseGuaranteeLetter({ ...releaseInput(failedRequestId, failedLetterId), releasedAt: new Date('2026-09-28T00:00:00.000Z') });
  assert.equal(retried.status, 'ready_for_claiming');
  assert.equal(retried.replayed, false);
  const releaseReplay = await repositories.aidLink.releaseGuaranteeLetter({ ...releaseInput(failedRequestId, failedLetterId), releasedAt: new Date('2026-09-28T00:00:00.000Z') });
  assert.equal(releaseReplay.replayed, true);
  assert.equal(Number((await database.query(`SELECT count(*) FROM budget_reservations WHERE guarantee_letter_id=$1`, [failedLetterId])).rows[0].count), 1);
  const budgetAuditActions = new Set((await database.query(`SELECT action_type FROM audit_logs WHERE affected_record_id IN ($1,$2) OR (new_value->>'budgetId')='hospital-budget-2026'`, [succeededLetterId, failedLetterId])).rows.map((row) => row.action_type));
  for (const action of ['budget_reserved', 'guarantee_letter_released', 'guarantee_letter_release_failed', 'guarantee_letter_expired', 'budget_allocation_released']) assert.equal(budgetAuditActions.has(action), true, action);
});
