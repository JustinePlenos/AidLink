export interface AssistanceRequest {
  id: string;
  requestId: string;
  beneficiaryType?: 'self' | 'other' | null;
  requester?: {
    applicantId: string | null;
    fullName: string;
    email: string;
    phone: string;
  };
  beneficiary?: {
    fullName: string;
    address: string;
    dateOfBirth: string;
    relationshipToApplicant: string;
    sex: string;
  };
  /** Legacy display field. New records also expose requester and beneficiary separately. */
  applicantName: string;
  email: string;
  phone: string;
  address: string;
  dateOfBirth: string;
  assistanceType: string;
  incomeSource?: string;
  patientCircumstance?: string;
  additionalDetails?: string;
  /** Legacy applications only. New submissions use the structured fields. */
  reason?: string;
  status: 'pending' | 'under_review' | 'correction_requested' | 'approved' | 'ready_for_claiming' | 'denied';
  processedBy?: string;
  processedAt?: string;
  guaranteeLetter?: {
    name: string;
    url: string;
  };
  /** External-process tracking for new approvals. guaranteeLetter is legacy upload metadata only. */
  guaranteeLetterTracking?: GuaranteeLetterTracking;
  protectedLetter?: ProtectedGuaranteeLetter | null;
  documentAnalysisReview?: {
    required: boolean;
    status: 'case_worker_review_required' | 'not_flagged';
    documents: {
      documentId: string;
      documentType: string;
      analyzerVersion: string;
      confidence: number | null;
      reasons: string[];
    }[];
  };
  approvalSms?: {
    id: string;
    status: 'queued' | 'sending' | 'sent' | 'delivered' | 'retry_scheduled' | 'failed' | 'pending_configuration';
    provider: string;
    attemptCount: number;
    maxAttempts: number;
    nextAttemptAt: string | null;
    sentAt: string | null;
    deliveredAt: string | null;
    lastError: string | null;
    updatedAt: string;
  };
  qrCode?: { value: string; imageDataUrl: string };
  assignedFacility?: Facility;
  /** Receipt-derived facility details for current requests. assignedFacility is legacy only. */
  facilityEvidence?: {
    facilityName: string;
    facilityType: 'hospital' | 'pharmacy' | 'other';
    receiptDate: string;
    referenceNumber: string;
    receiptDocumentId: string;
    validation: {
      status: 'accepted_for_review';
      qualityAccepted: boolean;
      requestContextMatched: boolean;
      ageDays: number;
      maxAgeDays: number;
      validatedAt: string;
      authenticityVerified: false;
    };
  };
  dateSubmitted: string;
  lastUpdatedAt?: string;
  latitude?: number;
  longitude?: number;
  correctionRequest?: {
    id: string;
    status: 'requested';
    remark: string;
    requestedAt: string;
    requestedBy: string;
    documents: { documentId: string; documentType: string; name: string; label: string }[];
    replacements: { id: string; replacesDocumentId: string; name: string }[];
  };
  documents: {
    id: string;
    name: string;
    url: string;
    documentType?: string;
    label?: string;
    analysis?: {
      accepted: boolean;
      issues: { code: string; message: string; fix: string }[];
      warnings: string[];
      orientation: string;
      analyzerVersion: string;
      analyzedAt: string;
      authenticityVerified: false;
      eligibilityDetermined?: false;
      decision?: 'accepted' | 'replace_required' | 'human_review_required';
      confidence?: number | null;
      classification?: { documentType?: string; confidence?: number } | null;
      missingPages?: { detected?: boolean; confidence?: number } | null;
      likelyUnreadableText?: { detected?: boolean; confidence?: number } | null;
      explanations?: string[];
      requiresHumanReview?: boolean;
      humanReviewReasons?: string[];
      analyzer?: {
        id: string;
        kind: 'deterministic' | 'ai' | 'hybrid';
        version: string;
        confidenceThreshold: number | null;
        capabilities: string[];
      };
      retention?: {
        inputBufferRetainedByAnalyzer: false;
        derivedImagesRetainedByAnalyzer: false;
        policy: string;
      };
    };
  }[];
}

export interface WorkflowEvaluation {
  evaluationId: string;
  requestId: string;
  outcome: 'ready_for_decision' | 'human_review_required';
  findings: { code: string; message: string }[];
  requiredEvidence: { type?: string; ruleCode?: string; reasonCode?: string; acceptedTypes?: string[] }[];
  coverage: { outcome: 'eligible' | 'partially_covered' | 'ineligible'; calculationEnabled: boolean; coveredAmount?: number; netRemainingBalance?: number; adjustments?: { code: string; message: string; amount?: number }[] };
  reasonCodes: string[];
  policyVersion: { hardDisqualifiers: string | null; coverageMatrix: string | null };
  humanReviewFlags: { code: string; message: string }[];
  humanReviewRequired: boolean;
  inputFingerprint: string;
}

export interface ProtectedGuaranteeLetter {
  id: string;
  version: number;
  name: string;
  status: 'pending' | 'pending_review' | 'confirmed' | 'approved' | 'expired' | 'revoked' | 'replaced' | 'unavailable' | 'conversion_failed';
  sourceType: 'pdf' | 'doc' | 'docx';
  conversionStatus: 'processing' | 'ready' | 'failed';
  uploaderId: string;
  uploaderName: string;
  uploadedAt: string;
  reviewedAt: string | null;
  approvedAt: string | null;
  qrExpiresAt: string | null;
}

export type GuaranteeLetterStatus = 'pending' | 'scheduled' | 'ready_for_claiming' | 'claimed' | 'cancelled';

export interface GuaranteeLetterTracking {
  claimReference: string;
  scheduledFor: string;
  status: GuaranteeLetterStatus;
  claimingTime?: string;
  claimingLocation?: string;
  updatedAt?: string;
  updatedBy?: string;
  updatedById?: string;
  releasedAt?: string;
  releasedBy?: string;
  releasedById?: string;
}

export interface Facility {
  id: string;
  name: string;
  type: 'hospital' | 'pharmacy';
  address: string;
  active: boolean;
  contactNumber: string;
  latitude: number | null;
  longitude: number | null;
  supportedAssistanceTypes: string[];
  operatingHours: string;
}

export interface AppNotification {
  id: string;
  requestId: string;
  requestNumber: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
  applicantId?: string | null;
}

export interface AuditLog {
  id: string;
  requestId: string;
  previousStatus?: AssistanceRequest['status'];
  status?: AssistanceRequest['status'];
  remarks: string;
  performedBy: string;
  performedAt: string;
  action?: 'status_updated' | 'request_approved' | 'correction_requested' | 'correction_document_uploaded' | 'corrections_submitted' | 'claiming_preparation_released' | 'sms_notification_queued' | 'sms_delivery_status_changed' | 'sms_delivery_retried' | 'sms_delivery_receipt_received' | 'guarantee_letter_tracking_updated' | 'guarantee_letter_uploaded' | 'guarantee_letter_converted' | 'guarantee_letter_conversion_failed' | 'guarantee_letter_reviewed' | 'guarantee_letter_confirmed' | 'guarantee_letter_approved' | 'guarantee_letter_qr_generated' | 'guarantee_letter_qr_scanned' | 'guarantee_letter_accessed' | 'guarantee_letter_replaced' | 'guarantee_letter_revoked';
  selectedDocuments?: AssistanceRequest['documents'];
  previousDocument?: AssistanceRequest['documents'][number];
  replacementDocument?: AssistanceRequest['documents'][number];
  previousDocuments?: AssistanceRequest['documents'];
  replacementDocuments?: AssistanceRequest['documents'];
}

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  dateOfBirth: string;
  registeredDate: string;
  totalApplications: number;
  verificationStatus?: 'unverified' | 'pending' | 'approved' | 'rejected' | 'legacy';
  accountStatus?: 'basic' | 'verified' | 'legacy';
}
