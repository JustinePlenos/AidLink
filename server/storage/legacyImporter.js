import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const migratePasswordHash = (value) => {
  if (!value) return null;
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(value), salt, 64).toString('hex')}`;
};
const safeDate = (value) => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const dateOnly = (value) => safeDate(value)?.slice(0, 10) || null;
const objectValue = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const arrayValue = (value) => Array.isArray(value) ? value : [];

function canonicalRole(value) {
  if (value === 'Super Admin' || value === 'System Administrator') return 'System Administrator';
  return 'Case Worker';
}

function canonicalRequestStatus(value) {
  const status = value === 'completed' ? 'approved' : String(value || 'pending').toLowerCase();
  return ['pending', 'under_review', 'correction_requested', 'approved', 'denied', 'ready_for_claiming', 'claimed', 'cancelled'].includes(status)
    ? status
    : 'pending';
}

function canonicalLetterStatus(value) {
  return ['pending', 'confirmed', 'approved', 'expired', 'revoked', 'replaced'].includes(value) ? value : 'pending';
}

function privateStorageKey(document, requestId) {
  const raw = String(document.url || document.storageKey || document.name || document.id || 'document');
  const cleanName = path.basename(raw.split('?')[0]).replace(/[^a-zA-Z0-9._-]/g, '_') || 'document';
  return `legacy/${requestId || 'applicant'}/${document.id || hash(raw).slice(0, 16)}/${cleanName}`;
}

function actorDetails(entry) {
  const actor = entry.actor;
  if (actor && typeof actor === 'object') {
    return { actorId: String(actor.id || entry.performedById || 'system'), actorType: actor.role === 'Applicant' ? 'applicant' : 'staff' };
  }
  if (entry.performedById) return { actorId: String(entry.performedById), actorType: 'staff' };
  return { actorId: 'system', actorType: 'system' };
}

function uniqueById(records, entity, report) {
  const seen = new Set();
  return records.filter((record, index) => {
    const recordId = String(record?.id || '').trim();
    if (!recordId) {
      report.invalid.push({ entity, sourceIndex: index, reason: 'missing_stable_id' });
      return false;
    }
    if (seen.has(recordId)) {
      report.duplicates.push({ entity, id: recordId, reason: 'duplicate_stable_id' });
      return false;
    }
    seen.add(recordId);
    return true;
  });
}

export function buildLegacyImportPlan(data, { sourceName = 'data.json', sourceSha256 = null } = {}) {
  const report = {
    sourceName,
    sourceSha256,
    planned: {},
    imported: {},
    skipped: {},
    invalid: [],
    duplicates: [],
  };
  let applicants = uniqueById(arrayValue(data.applicants), 'applicant', report).map((item) => ({
    id: String(item.id), email: String(item.email || '').trim(), fullName: String(item.fullName || item.name || '').trim(),
    phone: item.phone || null, dateOfBirth: dateOnly(item.dateOfBirth), address: item.address || null,
    verificationStatus: ['unverified', 'pending', 'approved', 'rejected'].includes(item.verificationStatus) ? item.verificationStatus : 'approved',
    accountStatus: ['basic', 'verified', 'suspended', 'deactivated'].includes(item.accountStatus) ? item.accountStatus : 'verified',
    passwordHash: item.passwordHash || null, sessionVersion: Number(item.sessionVersion) || 1,
    createdAt: safeDate(item.registeredDate), legacyPayload: { role: item.role || 'Applicant', identityVerification: item.identityVerification || null },
  })).filter((item, index) => {
    if (item.email && item.fullName) return true;
    report.invalid.push({ entity: 'applicant', id: item.id, sourceIndex: index, reason: 'missing_email_or_name' });
    return false;
  });
  const applicantAliases = new Map();
  const applicantAliasSources = new Map();
  const applicantByEmail = new Map();
  applicants = applicants.filter((item) => {
    const emailKey = item.email.toLowerCase();
    if (!applicantByEmail.has(emailKey)) {
      applicantByEmail.set(emailKey, item.id);
      return true;
    }
    const applicantId = applicantByEmail.get(emailKey);
    applicantAliases.set(item.id, applicantId);
    applicantAliasSources.set(item.id, 'applicants');
    report.duplicates.push({ entity: 'applicant', id: item.id, canonicalId: applicantId, reason: 'duplicate_email' });
    return false;
  });
  const applicantIds = new Set(applicants.map((item) => item.id));
  for (const item of uniqueById(arrayValue(data.users), 'legacy_user', report)) {
    const email = String(item.email || '').trim();
    const fullName = String(item.fullName || item.name || '').trim();
    if (!email || !fullName) {
      report.invalid.push({ entity: 'legacy_user', id: String(item.id), reason: 'missing_email_or_name' });
      continue;
    }
    const existingId = applicantByEmail.get(email.toLowerCase());
    if (existingId) {
      applicantAliases.set(String(item.id), existingId);
      applicantAliasSources.set(String(item.id), 'users');
      continue;
    }
    const legacyApplicant = {
      id: String(item.id), email, fullName, phone: item.phone || null,
      dateOfBirth: dateOnly(item.dateOfBirth), address: item.address || null,
      verificationStatus: 'approved', accountStatus: 'verified', passwordHash: null, sessionVersion: 1,
      createdAt: safeDate(item.registeredDate), legacyPayload: { migratedFromUsersCollection: true },
    };
    applicants.push(legacyApplicant);
    applicantIds.add(legacyApplicant.id);
    applicantByEmail.set(email.toLowerCase(), legacyApplicant.id);
  }

  let staff = uniqueById(arrayValue(data.authUsers), 'staff', report).map((item) => ({
    id: String(item.id), email: String(item.email || '').trim(), fullName: String(item.fullName || '').trim(),
    role: canonicalRole(item.role), active: item.active !== false,
    passwordHash: item.passwordHash || migratePasswordHash(item.password),
    sessionVersion: Number(item.sessionVersion) || 1, createdAt: safeDate(item.registeredDate),
    legacyPayload: { phone: item.phone || null, address: item.address || null, dateOfBirth: item.dateOfBirth || null },
  })).filter((item, index) => {
    if (item.email && item.fullName) return true;
    report.invalid.push({ entity: 'staff', id: item.id, sourceIndex: index, reason: 'missing_email_or_name' });
    return false;
  });
  const staffAliases = new Map();
  const staffByEmail = new Map();
  staff = staff.filter((item) => {
    const emailKey = item.email.toLowerCase();
    if (!staffByEmail.has(emailKey)) {
      staffByEmail.set(emailKey, item.id);
      return true;
    }
    const staffId = staffByEmail.get(emailKey);
    staffAliases.set(item.id, staffId);
    report.duplicates.push({ entity: 'staff', id: item.id, canonicalId: staffId, reason: 'duplicate_email' });
    return false;
  });
  const staffIds = new Set(staff.map((item) => item.id));
  const staffByName = new Map(staff.map((item) => [item.fullName.trim().toLowerCase(), item.id]));
  const resolveStaffId = (value) => {
    const candidate = value && typeof value === 'object'
      ? String(value.id || value.fullName || '')
      : String(value || '');
    return staffIds.has(candidate) ? candidate : staffAliases.get(candidate) || staffByName.get(candidate.trim().toLowerCase()) || null;
  };

  const policy = {
    id: 'legacy-policy-foundation-v1',
    policyKey: 'legacy_application_configuration',
    version: 1,
    policyVersion: 'legacy_application_configuration:global:v1',
    assistanceType: null,
    configuration: {
      systemSettings: objectValue(data.systemSettings),
      requiredDocuments: objectValue(data.requiredDocuments),
      assistanceTypeSettings: objectValue(data.assistanceTypeSettings),
    },
    effectiveFrom: '1970-01-01T00:00:00.000Z',
    justification: 'Imported legacy JSON application configuration.',
  };

  const facilitiesByKey = new Map();
  const beneficiaries = [];
  const requests = [];
  const documents = [];
  const analyses = [];
  const corrections = [];
  const correctionDocuments = [];
  const letters = [];
  const decisions = [];

  for (const request of uniqueById(arrayValue(data.requests), 'request', report)) {
    const requestId = String(request.id);
    const suppliedApplicantId = String(request.applicantId || '');
    const applicantId = applicantIds.has(suppliedApplicantId)
      ? suppliedApplicantId
      : applicantAliases.get(suppliedApplicantId)
        || applicantByEmail.get(String(request.email || '').trim().toLowerCase())
        || '';
    if (!applicantIds.has(applicantId)) {
      report.invalid.push({ entity: 'request', id: requestId, reason: 'missing_applicant_relationship' });
      continue;
    }
    const facilityEvidence = objectValue(request.facilityEvidence);
    let facilityId = null;
    if (facilityEvidence.facilityName) {
      const normalizedName = String(facilityEvidence.facilityName).trim().toLowerCase().replace(/\s+/g, ' ');
      const facilityType = ['hospital', 'pharmacy', 'other'].includes(facilityEvidence.facilityType) ? facilityEvidence.facilityType : 'other';
      const key = `${normalizedName}|${facilityType}`;
      if (!facilitiesByKey.has(key)) {
        facilitiesByKey.set(key, {
          id: `facility-legacy-${hash(key).slice(0, 20)}`, name: String(facilityEvidence.facilityName).trim(),
          normalizedName, facilityType, metadata: { identifiedFromReceipt: true },
        });
      }
      facilityId = facilitiesByKey.get(key).id;
    }
    const beneficiary = objectValue(request.beneficiary);
    const isRequester = request.beneficiaryType !== 'someone_else' && request.beneficiaryType !== 'other';
    const beneficiaryId = `beneficiary-${requestId}`;
    beneficiaries.push({
      id: beneficiaryId, applicantId,
      fullName: String(beneficiary.fullName || request.applicantName || request.requester?.fullName || 'Legacy beneficiary'),
      dateOfBirth: dateOnly(beneficiary.dateOfBirth || request.dateOfBirth),
      address: beneficiary.address || request.address || null,
      relationship: beneficiary.relationshipToApplicant || request.relationshipToPatient || (isRequester ? 'Self' : null),
      isRequester, legacyPayload: { sex: beneficiary.sex || request.sex || null },
    });
    const status = canonicalRequestStatus(request.status);
    requests.push({
      id: requestId, requestNumber: String(request.requestId || request.id), applicantId, beneficiaryId,
      assistanceType: String(request.assistanceType || 'Unknown legacy assistance'), status,
      incomeSource: request.incomeSource || null, patientCircumstance: request.patientCircumstance || null,
      additionalDetails: request.additionalDetails || request.reason || null, facilityId,
      facilityName: facilityEvidence.facilityName || null, facilityType: facilityEvidence.facilityType || null,
      receiptDate: dateOnly(facilityEvidence.receiptDate), receiptReference: facilityEvidence.referenceNumber || null,
      policyVersionId: policy.id,
      decisionSnapshot: {
        source: 'legacy_json_migration', policyVersionId: policy.id, policyVersion: policy.policyVersion, assistanceType: request.assistanceType || null,
        requiredDocuments: arrayValue(data.requiredDocuments?.[request.assistanceType]),
        statusAtMigration: status,
      },
      submittedAt: safeDate(request.dateSubmitted), updatedAt: safeDate(request.lastUpdatedAt),
      processedAt: safeDate(request.processedAt), processedBy: resolveStaffId(request.processedBy),
      legacyPayload: {
        requester: request.requester || null, remarks: request.remarks || null,
        guaranteeLetterTracking: request.guaranteeLetterTracking || null,
      },
    });

    for (const document of uniqueById(arrayValue(request.documents), 'document', report)) {
      const documentId = String(document.id);
      documents.push({
        id: documentId, requestId, applicantId, documentType: String(document.documentType || document.name || 'supporting_document'),
        displayName: String(document.label || document.name || document.documentType || 'Document'),
        storageKey: privateStorageKey(document, requestId), mimeType: document.mimeType || null,
        byteSize: document.sizeBytes ?? null, sha256: document.analysis?.sha256 || null,
        uploadedBy: applicantId, uploadedAt: safeDate(document.uploadedAt || request.dateSubmitted),
        metadata: { migratedFromLegacyUrl: Boolean(document.url), originalFileName: document.name || null },
      });
      if (document.analysis) {
        const analysis = document.analysis;
        const failures = arrayValue(analysis.issues).filter((item) => item?.blocking !== false);
        const warnings = arrayValue(analysis.warnings);
        const outcome = analysis.accepted === false ? 'rejected'
          : analysis.requiresHumanReview ? 'manual_review'
            : warnings.length ? 'warning' : 'accepted';
        analyses.push({
          id: `analysis-${documentId}`, documentId,
          analyzerName: String(analysis.analyzer || 'legacy-deterministic-analyzer'),
          analyzerVersion: String(analysis.analyzerVersion || 'legacy'),
          outcome, warnings, failures, orientation: analysis.orientation || null,
          metrics: { checks: analysis.checks || null, imageQuality: analysis.imageQuality || null },
          confidence: Number.isFinite(Number(analysis.confidence)) ? Number(analysis.confidence) : null,
          analyzedAt: safeDate(analysis.analyzedAt),
        });
      }
    }

    for (const [index, correction] of arrayValue(request.correctionHistory).entries()) {
      const correctionId = String(correction.id || `correction-${requestId}-${index + 1}`);
      const requestedBy = resolveStaffId(correction.requestedById || correction.requesterId || correction.requestedBy);
      if (!requestedBy) {
        report.invalid.push({ entity: 'correction', id: correctionId, reason: 'missing_staff_relationship' });
        continue;
      }
      corrections.push({
        id: correctionId, requestId, requestedBy, remark: String(correction.remark || correction.remarks || 'Legacy correction request'),
        status: ['open', 'submitted', 'closed', 'cancelled'].includes(correction.status) ? correction.status : 'closed',
        requestedAt: safeDate(correction.requestedAt || correction.timestamp),
        submittedAt: safeDate(correction.submittedAt), closedAt: safeDate(correction.closedAt),
      });
      for (const documentId of arrayValue(correction.documentIds || correction.requestedDocumentIds)) {
        if (documents.some((item) => item.id === String(documentId))) correctionDocuments.push({ correctionId, documentId: String(documentId) });
      }
    }

    const letter = request.protectedLetter || request.guaranteeLetter;
    const letterUploaderId = resolveStaffId(letter?.uploaderId || letter?.uploadedById || letter?.uploaderName);
    if (letter?.id && letterUploaderId) {
      letters.push({
        id: String(letter.id), requestId, version: Number(letter.version) || 1,
        sourceMimeType: String(letter.mimeType || 'application/pdf'),
        originalStorageKey: `legacy/letters/${requestId}/${path.basename(String(letter.originalFileName || letter.name || letter.id))}`,
        pdfStorageKey: letter.pdfFileName ? `legacy/letters/${requestId}/${path.basename(String(letter.pdfFileName))}` : null,
        conversionStatus: ['pending', 'ready', 'failed'].includes(letter.conversionStatus) ? letter.conversionStatus : 'pending',
        status: canonicalLetterStatus(letter.status), uploadedBy: letterUploaderId,
        uploadedAt: safeDate(letter.uploadedAt), reviewedBy: resolveStaffId(letter.reviewedById || letter.reviewedByName),
        reviewedAt: safeDate(letter.reviewedAt), approvedAt: safeDate(letter.approvedAt), expiresAt: safeDate(letter.qrExpiresAt),
        qrTokenHash: letter.qrTokenHash || null, metadata: { originalFileName: letter.originalFileName || letter.name || null },
      });
    }
    if (['approved', 'denied'].includes(status) && requests.at(-1).processedBy) {
      decisions.push({
        id: `decision-legacy-${requestId}`, requestId, policyVersionId: policy.id, decision: status,
        decisionSnapshot: requests.at(-1).decisionSnapshot, decidedBy: requests.at(-1).processedBy,
        justification: String(request.remarks || 'Migrated historical decision.'), decidedAt: requests.at(-1).processedAt,
      });
    }
  }

  for (const applicant of applicants) {
    const source = arrayValue(data.applicants).find((item) => String(item.id) === applicant.id);
    const proof = source?.identityVerification?.document;
    if (!proof?.id) continue;
    documents.push({
      id: String(proof.id), requestId: null, applicantId: applicant.id,
      documentType: String(proof.documentType || 'government_id'), displayName: String(proof.name || 'Government-issued ID'),
      storageKey: privateStorageKey(proof, null), mimeType: proof.mimeType || null, byteSize: proof.sizeBytes ?? null,
      sha256: proof.analysis?.sha256 || null, uploadedBy: applicant.id, uploadedAt: safeDate(proof.uploadedAt),
      metadata: { identityProof: true, migratedFromLegacyUrl: Boolean(proof.url) },
    });
  }

  const notifications = [];
  for (const item of uniqueById(arrayValue(data.notifications), 'notification', report)) {
    if (item.applicantId && !applicantIds.has(String(item.applicantId))) {
      report.invalid.push({ entity: 'notification', id: String(item.id), reason: 'missing_applicant_relationship' });
      continue;
    }
    notifications.push({
      id: String(item.id), applicantId: item.applicantId ? String(item.applicantId) : null,
      requestId: requests.some((request) => request.id === String(item.requestId)) ? String(item.requestId) : null,
      channel: 'in_app', eventType: String(item.event || 'legacy_notification'),
      deliveryKey: `legacy-in-app-${item.id}`, status: 'delivered', attemptCount: 1,
      payload: { title: item.title || null, message: item.message || null, read: Boolean(item.read) },
      createdAt: safeDate(item.createdAt), deliveredAt: safeDate(item.createdAt),
    });
  }
  for (const item of uniqueById(arrayValue(data.smsNotifications), 'sms_notification', report)) {
    if (item.applicantId && !applicantIds.has(String(item.applicantId))) {
      report.invalid.push({ entity: 'sms_notification', id: String(item.id), reason: 'missing_applicant_relationship' });
      continue;
    }
    const status = ['pending', 'sending', 'sent', 'delivered', 'failed', 'cancelled'].includes(item.status) ? item.status : 'failed';
    notifications.push({
      id: `sms-${item.id}`, applicantId: item.applicantId ? String(item.applicantId) : null,
      requestId: requests.some((request) => request.id === String(item.requestId)) ? String(item.requestId) : null,
      channel: 'sms', eventType: String(item.event || 'legacy_sms'),
      deliveryKey: `legacy-sms-${item.id}`, status, attemptCount: Number(item.attemptCount) || 0,
      providerName: item.provider || null, providerMessageId: item.providerMessageId || null,
      payload: { message: item.message || null }, createdAt: safeDate(item.createdAt),
      deliveredAt: safeDate(item.deliveredAt), nextAttemptAt: safeDate(item.nextAttemptAt),
      lastErrorCode: item.lastError ? 'legacy_delivery_error' : null,
    });
  }

  const audits = uniqueById(arrayValue(data.auditLogs), 'audit_log', report).map((item) => {
    const actor = actorDetails(item);
    return {
      id: String(item.id), ...actor, occurredAt: safeDate(item.timestamp || item.performedAt),
      actionType: String(item.action || 'legacy_activity'),
      recordType: String(item.affectedRecord?.type || (item.requestId ? 'request' : 'legacy_record')),
      recordId: String(item.affectedRecord?.id || item.requestId || item.targetStaffId || item.id),
      oldValue: item.previousStatus ? { status: item.previousStatus } : null,
      newValue: item.status ? { status: item.status } : null,
      justification: item.remarks || null,
      metadata: { requestNumber: item.requestNumber || null, details: item.details || null },
    };
  });

  const plan = {
    applicants,
    applicantAliases: [...applicantAliases].map(([legacyId, applicantId]) => ({
      id: legacyId,
      applicantId,
      sourceCollection: applicantAliasSources.get(legacyId) || 'users',
    })),
    staff,
    staffAliases: [...staffAliases].map(([legacyId, staffId]) => ({ id: legacyId, staffId, sourceCollection: 'authUsers' })),
    facilities: [...facilitiesByKey.values()], policies: [policy], beneficiaries, requests,
    documents: uniqueById(documents, 'document', report), analyses, corrections, correctionDocuments,
    decisions, letters, notifications, audits,
  };
  for (const [entity, rows] of Object.entries(plan)) report.planned[entity] = rows.length;
  return { plan, report };
}

async function insert(client, sql, values, report, entity) {
  const result = await client.query(sql, values);
  report.imported[entity] = (report.imported[entity] || 0) + result.rowCount;
  report.skipped[entity] = (report.skipped[entity] || 0) + (result.rowCount ? 0 : 1);
}

export async function importLegacyData(database, data, options = {}) {
  const sourceText = options.sourceText || JSON.stringify(data);
  const sourceSha256 = options.sourceSha256 || hash(sourceText);
  const { plan, report } = buildLegacyImportPlan(data, { sourceName: options.sourceName, sourceSha256 });
  if (options.dryRun) return { ...report, dryRun: true };

  return database.withTransaction(async (client) => {
    const previous = await client.query('SELECT report FROM legacy_import_runs WHERE source_sha256 = $1 AND status = $2', [sourceSha256, 'completed']);
    if (previous.rows[0]) return { ...previous.rows[0].report, replayed: true };
    const runId = options.runId || `legacy-import-${sourceSha256.slice(0, 20)}`;
    await client.query(`
      INSERT INTO legacy_import_runs (id, source_sha256, source_name, status)
      VALUES ($1,$2,$3,'started')
      ON CONFLICT (source_sha256) DO UPDATE SET status = 'started', report = '{}'::jsonb, completed_at = NULL
    `, [runId, sourceSha256, options.sourceName || 'data.json']);

    for (const row of plan.applicants) await insert(client, `
      INSERT INTO applicants (id,email,full_name,phone,date_of_birth,address,verification_status,account_status,password_hash,session_version,legacy_payload,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,now())) ON CONFLICT (id) DO NOTHING
    `, [row.id,row.email,row.fullName,row.phone,row.dateOfBirth,row.address,row.verificationStatus,row.accountStatus,row.passwordHash,row.sessionVersion,row.legacyPayload,row.createdAt], report, 'applicants');
    for (const row of plan.applicantAliases) await insert(client, `
      INSERT INTO applicant_aliases (legacy_id,applicant_id,source_collection)
      VALUES ($1,$2,$3) ON CONFLICT (legacy_id) DO NOTHING
    `, [row.id,row.applicantId,row.sourceCollection], report, 'applicantAliases');
    for (const row of plan.staff) await insert(client, `
      INSERT INTO staff_accounts (id,email,full_name,role,active,password_hash,session_version,legacy_payload,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,now())) ON CONFLICT (id) DO NOTHING
    `, [row.id,row.email,row.fullName,row.role,row.active,row.passwordHash,row.sessionVersion,row.legacyPayload,row.createdAt], report, 'staff');
    for (const row of plan.staffAliases) await insert(client, `
      INSERT INTO staff_account_aliases (legacy_id,staff_id,source_collection)
      VALUES ($1,$2,$3) ON CONFLICT (legacy_id) DO NOTHING
    `, [row.id,row.staffId,row.sourceCollection], report, 'staffAliases');
    for (const row of plan.facilities) await insert(client, `
      INSERT INTO facilities (id,name,facility_type,normalized_name,metadata) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING
    `, [row.id,row.name,row.facilityType,row.normalizedName,row.metadata], report, 'facilities');
    for (const row of plan.policies) await insert(client, `
      INSERT INTO policy_configurations (
        id,policy_key,version,policy_version,assistance_type,configuration,effective_from,effective_date,
        old_value,new_value,justification
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,NULL,$6,$8) ON CONFLICT (id) DO NOTHING
    `, [row.id,row.policyKey,row.version,row.policyVersion,row.assistanceType,row.configuration,row.effectiveFrom,row.justification], report, 'policies');
    for (const row of plan.beneficiaries) await insert(client, `
      INSERT INTO beneficiaries (id,requester_applicant_id,full_name,date_of_birth,address,relationship_to_applicant,is_requester,legacy_payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING
    `, [row.id,row.applicantId,row.fullName,row.dateOfBirth,row.address,row.relationship,row.isRequester,row.legacyPayload], report, 'beneficiaries');
    for (const row of plan.requests) await insert(client, `
      INSERT INTO requests (
        id,request_number,applicant_id,beneficiary_id,assistance_type,status,income_source,patient_circumstance,
        additional_details,facility_id,facility_name_snapshot,facility_type_snapshot,receipt_date,receipt_reference,
        policy_version_id,policy_version,policy_findings,required_reviews,decision_snapshot,legacy_payload,
        submitted_at,updated_at,processed_at,processed_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'[]','[]',$17,$18,COALESCE($19,now()),COALESCE($20,now()),$21,$22)
      ON CONFLICT (id) DO NOTHING
    `, [row.id,row.requestNumber,row.applicantId,row.beneficiaryId,row.assistanceType,row.status,row.incomeSource,row.patientCircumstance,
      row.additionalDetails,row.facilityId,row.facilityName,row.facilityType,row.receiptDate,row.receiptReference,row.policyVersionId,
      row.decisionSnapshot.policyVersion,row.decisionSnapshot,row.legacyPayload,row.submittedAt,row.updatedAt,row.processedAt,row.processedBy], report, 'requests');
    for (const row of plan.documents) await insert(client, `
      INSERT INTO documents (id,request_id,applicant_id,document_type,display_name,storage_key,mime_type,byte_size,sha256,uploaded_by,uploaded_at,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,now()),$12) ON CONFLICT (id) DO NOTHING
    `, [row.id,row.requestId,row.applicantId,row.documentType,row.displayName,row.storageKey,row.mimeType,row.byteSize,row.sha256,row.uploadedBy,row.uploadedAt,row.metadata], report, 'documents');
    for (const row of plan.analyses) await insert(client, `
      INSERT INTO document_analyses (id,document_id,analyzer_name,analyzer_version,outcome,warnings,failures,orientation,metrics,confidence,analyzed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,now())) ON CONFLICT (id) DO NOTHING
    `, [row.id,row.documentId,row.analyzerName,row.analyzerVersion,row.outcome,JSON.stringify(row.warnings),JSON.stringify(row.failures),row.orientation,row.metrics,row.confidence,row.analyzedAt], report, 'analyses');
    for (const row of plan.corrections) await insert(client, `
      INSERT INTO correction_requests (id,request_id,requested_by,remark,status,requested_at,submitted_at,closed_at)
      VALUES ($1,$2,$3,$4,$5,COALESCE($6,now()),$7,$8) ON CONFLICT (id) DO NOTHING
    `, [row.id,row.requestId,row.requestedBy,row.remark,row.status,row.requestedAt,row.submittedAt,row.closedAt], report, 'corrections');
    for (const row of plan.correctionDocuments) await insert(client, `
      INSERT INTO correction_document_requirements (correction_id,document_id) VALUES ($1,$2) ON CONFLICT DO NOTHING
    `, [row.correctionId,row.documentId], report, 'correctionDocuments');
    for (const row of plan.decisions) await insert(client, `
      INSERT INTO coverage_decisions (id,request_id,policy_version_id,decision,decision_snapshot,decided_by,justification,decided_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,now())) ON CONFLICT (id) DO NOTHING
    `, [row.id,row.requestId,row.policyVersionId,row.decision,row.decisionSnapshot,row.decidedBy,row.justification,row.decidedAt], report, 'decisions');
    for (const row of plan.letters) await insert(client, `
      INSERT INTO guarantee_letters (
        id,request_id,version,source_mime_type,original_storage_key,pdf_storage_key,conversion_status,status,
        uploaded_by,uploaded_at,reviewed_by,reviewed_at,approved_at,expires_at,qr_token_hash,metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,now()),$11,$12,$13,$14,$15,$16) ON CONFLICT (id) DO NOTHING
    `, [row.id,row.requestId,row.version,row.sourceMimeType,row.originalStorageKey,row.pdfStorageKey,row.conversionStatus,row.status,
      row.uploadedBy,row.uploadedAt,row.reviewedBy,row.reviewedAt,row.approvedAt,row.expiresAt,row.qrTokenHash,row.metadata], report, 'letters');
    for (const row of plan.notifications) await insert(client, `
      INSERT INTO notifications (
        id,applicant_id,request_id,channel,event_type,delivery_key,status,attempt_count,next_attempt_at,
        provider_name,provider_message_id,payload,last_error_code,created_at,delivered_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14,now()),$15) ON CONFLICT (id) DO NOTHING
    `, [row.id,row.applicantId,row.requestId,row.channel,row.eventType,row.deliveryKey,row.status,row.attemptCount,row.nextAttemptAt,
      row.providerName,row.providerMessageId,row.payload,row.lastErrorCode,row.createdAt,row.deliveredAt], report, 'notifications');
    for (const row of plan.audits) await insert(client, `
      INSERT INTO audit_logs (id,actor_id,actor_type,occurred_at,action_type,affected_record_type,affected_record_id,old_value,new_value,justification,metadata)
      VALUES ($1,$2,$3,COALESCE($4,now()),$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING
    `, [row.id,row.actorId,row.actorType,row.occurredAt,row.actionType,row.recordType,row.recordId,row.oldValue,row.newValue,row.justification,row.metadata], report, 'audits');

    await client.query(`
      INSERT INTO application_snapshots (id, payload, source_sha256)
      VALUES ('primary', $1, $2)
      ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, source_sha256 = EXCLUDED.source_sha256,
        revision = application_snapshots.revision + 1, updated_at = now()
    `, [data, sourceSha256]);
    report.completedAt = new Date().toISOString();
    await client.query(`
      UPDATE legacy_import_runs SET status = 'completed', report = $2, completed_at = now() WHERE source_sha256 = $1
    `, [sourceSha256, report]);
    return { ...report, replayed: false };
  }, { isolationLevel: 'SERIALIZABLE' });
}

export async function migrateLegacyJsonFile(database, sourcePath, options = {}) {
  const sourceText = await fs.readFile(sourcePath, 'utf8');
  const data = JSON.parse(sourceText);
  return importLegacyData(database, data, {
    ...options,
    sourceText,
    sourceSha256: hash(sourceText),
    sourceName: path.basename(sourcePath),
  });
}

export async function verifyLegacyJsonMigration(database, sourcePath) {
  const sourceText = await fs.readFile(sourcePath, 'utf8');
  const sourceSha256 = hash(sourceText);
  const data = JSON.parse(sourceText);
  const { plan } = buildLegacyImportPlan(data, { sourceName: path.basename(sourcePath), sourceSha256 });
  const tables = {
    applicants: ['applicants', 'id'],
    applicantAliases: ['applicant_aliases', 'legacy_id'],
    staff: ['staff_accounts', 'id'],
    staffAliases: ['staff_account_aliases', 'legacy_id'],
    facilities: ['facilities', 'id'],
    policies: ['policy_configurations', 'id'],
    beneficiaries: ['beneficiaries', 'id'],
    requests: ['requests', 'id'],
    documents: ['documents', 'id'],
    analyses: ['document_analyses', 'id'],
    corrections: ['correction_requests', 'id'],
    decisions: ['coverage_decisions', 'id'],
    letters: ['guarantee_letters', 'id'],
    notifications: ['notifications', 'id'],
    audits: ['audit_logs', 'id'],
  };
  const entities = {};
  for (const [entity, [table, idColumn]] of Object.entries(tables)) {
    const expectedIds = plan[entity].map((row) => String(row.id));
    if (!expectedIds.length) {
      entities[entity] = { expected: 0, found: 0, missing: [] };
      continue;
    }
    const found = await database.query(`SELECT ${idColumn} AS id FROM ${table} WHERE ${idColumn} = ANY($1::text[])`, [expectedIds]);
    const foundIds = new Set(found.rows.map((row) => String(row.id)));
    entities[entity] = {
      expected: expectedIds.length,
      found: foundIds.size,
      missing: expectedIds.filter((value) => !foundIds.has(value)),
    };
  }
  const importRun = await database.query(
    `SELECT status FROM legacy_import_runs WHERE source_sha256 = $1`,
    [sourceSha256],
  );
  const snapshot = await database.query(
    `SELECT source_sha256 FROM application_snapshots WHERE id = 'primary'`,
  );
  const mismatches = Object.entries(entities)
    .filter(([, result]) => result.missing.length)
    .map(([entity, result]) => ({ entity, missingCount: result.missing.length, missingIds: result.missing }));
  const verified = importRun.rows[0]?.status === 'completed'
    && snapshot.rows[0]?.source_sha256 === sourceSha256
    && mismatches.length === 0;
  return {
    status: verified ? 'verified' : 'mismatch',
    sourceName: path.basename(sourcePath),
    sourceSha256,
    importStatus: importRun.rows[0]?.status || 'not_found',
    snapshotMatches: snapshot.rows[0]?.source_sha256 === sourceSha256,
    entities,
    mismatches,
    verifiedAt: new Date().toISOString(),
  };
}
