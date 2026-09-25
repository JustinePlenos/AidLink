import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { X, CheckCircle, XCircle, Download, ZoomIn, User, Phone, MapPin, Calendar, Info, FileWarning, FileText, Upload, Eye, ShieldCheck, Mail } from 'lucide-react';
import type { AssistanceRequest, GuaranteeLetterStatus, WorkflowEvaluation } from '../types';
import { confirmGuaranteeLetter, confirmRequestWorkflowEvaluation, downloadProtectedDocument, evaluateRequestWorkflow, getActionErrorMessage, getIdentityProofObjectUrl, getRequest, getRequestAudit, openProtectedDocument, previewGuaranteeLetter, releaseClaimingPreparation, retryApprovalSms, revokeGuaranteeLetter, updateGuaranteeLetterTracking, updateRequestStatus, uploadGuaranteeLetter } from '../api';
import type { AuditLog } from '../types';
import { ImageWithFallback } from './ImageWithFallback';
import { ProtectedDocumentImage } from './ProtectedDocumentImage';
import { showToast } from '../utils/toast';
import { ActionFeedback, type ActionFeedbackState } from './ActionFeedback';

interface RequestDetailsModalProps {
  request: AssistanceRequest;
  canProcess: boolean;
  onClose: () => void;
  onStatusUpdated?: (updatedRequest: AssistanceRequest) => void;
}

const guaranteeLetterStatusOptions: Array<{ value: GuaranteeLetterStatus; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'scheduled', label: 'Scheduled' },
];

export function RequestDetailsModal({ request, canProcess, onClose, onStatusUpdated }: RequestDetailsModalProps) {
  const isLegacyMedicineRequest = request.assistanceType === 'Medicine Assistance';
  const requester = request.requester ?? { applicantId: null, fullName: request.applicantName, email: request.email, phone: request.phone };
  const beneficiary = request.beneficiary ?? { fullName: request.applicantName, address: request.address, dateOfBirth: request.dateOfBirth, relationshipToApplicant: '', sex: '' };
  const assistanceFor = request.beneficiaryType === 'self' ? 'For myself' : request.beneficiaryType === 'other' ? 'For someone else' : 'Not recorded (legacy request)';
  const [requestStatus, setRequestStatus] = useState(request.status);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [remarks, setRemarks] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [claimReference, setClaimReference] = useState(request.guaranteeLetterTracking?.claimReference ?? '');
  const [scheduledFor, setScheduledFor] = useState(request.guaranteeLetterTracking?.scheduledFor ?? '');
  const [claimingTime, setClaimingTime] = useState(request.guaranteeLetterTracking?.claimingTime ?? '');
  const [claimingLocation, setClaimingLocation] = useState(request.guaranteeLetterTracking?.claimingLocation ?? '');
  const [guaranteeLetterStatus, setGuaranteeLetterStatus] = useState<GuaranteeLetterStatus>(request.guaranteeLetterTracking?.status ?? 'scheduled');
  const [approvalSms, setApprovalSms] = useState(request.approvalSms);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [selectedCorrectionDocumentIds, setSelectedCorrectionDocumentIds] = useState<string[]>([]);
  const [correctionRequest, setCorrectionRequest] = useState(request.correctionRequest);
  const [correctionErrors, setCorrectionErrors] = useState<{ documents?: string; remark?: string }>({});
  const [protectedLetter, setProtectedLetter] = useState(request.protectedLetter);
  const [letterReviewed, setLetterReviewed] = useState(request.protectedLetter?.status === 'confirmed' || request.protectedLetter?.status === 'approved');
  const [requestQr, setRequestQr] = useState(request.qrCode);
  const [actionFeedback, setActionFeedback] = useState<ActionFeedbackState | null>(null);
  const [activeAction, setActiveAction] = useState('');
  const [workflowEvaluation, setWorkflowEvaluation] = useState<WorkflowEvaluation | null>(null);
  const [evidenceReviewed, setEvidenceReviewed] = useState(false);
  const [coverageConfirmed, setCoverageConfirmed] = useState(false);
  const [evaluationConfirmed, setEvaluationConfirmed] = useState(false);
  const inFlightRef = useRef(false);

  const beginAction = (action: string, message: string) => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setSubmitting(true);
    setActiveAction(action);
    setActionFeedback({ kind: 'loading', message });
    return true;
  };
  const finishAction = () => {
    inFlightRef.current = false;
    setSubmitting(false);
    setActiveAction('');
  };
  const announce = (kind: 'success' | 'error' | 'info', message: string) => {
    setActionFeedback({ kind, message });
    if (kind === 'success') showToast.success(message);
    if (kind === 'error') showToast.error(message);
  };

  useEffect(() => {
    getRequestAudit(request.id).then(setAuditLogs).catch((error) => {
      setAuditLogs([]);
      announce('error', getActionErrorMessage(error, 'Request history could not be loaded. Try refreshing the request.'));
    });
  }, [request.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (selectedImage) {
          URL.revokeObjectURL(selectedImage);
          setSelectedImage(null);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, selectedImage]);

  const previewDocument = async (url: string) => {
    if (!beginAction('document-preview', 'Opening the protected document securely...')) return;
    try {
      const objectUrl = await getIdentityProofObjectUrl(url);
      setSelectedImage((current) => {
        if (current) URL.revokeObjectURL(current);
        return objectUrl;
      });
      announce('success', 'Protected document opened.');
    } catch (error) {
      announce('error', getActionErrorMessage(error, 'Unable to open the protected document.'));
    } finally { finishAction(); }
  };

  const closeDocumentPreview = () => {
    setSelectedImage((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  };

  const downloadDocument = async (url: string, name: string) => {
    if (!beginAction('document-download', `Preparing ${name} for secure download...`)) return;
    try { await downloadProtectedDocument(url, name); announce('success', `${name} downloaded securely.`); }
    catch (error) { announce('error', getActionErrorMessage(error, 'Unable to download the protected document.')); }
    finally { finishAction(); }
  };

  const openDocument = async (url: string) => {
    if (!beginAction('document-open', 'Opening the protected document securely...')) return;
    try { await openProtectedDocument(url); announce('success', 'Protected document opened in a new tab.'); }
    catch (error) { announce('error', getActionErrorMessage(error, 'Unable to open the protected document.')); }
    finally { finishAction(); }
  };

  const trackingPayload = () => ({ claimReference: claimReference.trim(), scheduledFor, claimingTime, claimingLocation: claimingLocation.trim(), status: guaranteeLetterStatus });

  const trackingIsComplete = () => {
    const missing = [
      !claimReference.trim() && 'claim reference',
      !scheduledFor && 'claiming date',
      !claimingTime && 'claiming time',
      !claimingLocation.trim() && 'claiming location',
    ].filter(Boolean);
    if (missing.length) {
      announce('error', `Missing required claiming ${missing.length === 1 ? 'field' : 'fields'}: ${missing.join(', ')}.`);
      return false;
    }
    return true;
  };

  const updateStatus = async (status: 'under_review' | 'correction_requested' | 'approved' | 'denied') => {
    const trimmedRemarks = remarks.trim();
    if (status === 'correction_requested') {
      const errors = {
        ...(selectedCorrectionDocumentIds.length === 0 ? { documents: 'Select at least one document that the applicant must replace.' } : {}),
        ...(!trimmedRemarks ? { remark: 'Enter a correction remark that clearly explains what the applicant must fix.' }
          : trimmedRemarks.length < 10 ? { remark: 'Add more detail to the correction remark so the applicant knows what to fix.' } : {}),
      };
      setCorrectionErrors(errors);
      if (errors.documents || errors.remark) {
        announce('error', [errors.documents, errors.remark].filter(Boolean).join(' '));
        return;
      }
    } else if (!trimmedRemarks) {
      announce('error', `Enter decision remarks before ${status === 'under_review' ? 'marking this request under review' : `${status === 'approved' ? 'approving' : 'denying'} this request`}.`);
      return;
    }
    if (!beginAction(`status-${status}`, status === 'correction_requested' ? 'Saving the correction request...' : `Saving the ${status.replaceAll('_', ' ')} decision...`)) return;
    try {
      const updatedRequest = await updateRequestStatus(request.id, status, trimmedRemarks, {
        correctionDocumentIds: selectedCorrectionDocumentIds,
      });
      setRequestStatus(updatedRequest.status);
      setCorrectionRequest(updatedRequest.correctionRequest);
      setApprovalSms(updatedRequest.approvalSms);
      setProtectedLetter(updatedRequest.protectedLetter);
      setRequestQr(updatedRequest.qrCode);
      onStatusUpdated?.(updatedRequest);
      setAuditLogs(await getRequestAudit(request.id));
      if (status === 'correction_requested') {
        setSelectedCorrectionDocumentIds([]);
        setRemarks('');
        setCorrectionErrors({});
        announce('success', `Correction request for ${request.requestId} was saved.`);
      } else {
        announce('success', `Request ${request.requestId} was updated to ${updatedRequest.status.replaceAll('_', ' ')}.`);
      }
    } catch (err) {
      announce('error', getActionErrorMessage(err, 'Unable to update the request. Your entered remarks were kept.'));
    } finally {
      finishAction();
    }
  };

  const handleApprove = async () => {
    await updateStatus('approved');
  };

  const handlePolicyEvaluation = async () => {
    const evaluationRemarks = remarks.trim();
    if (evaluationRemarks.length < 10) { announce('error', 'Enter evaluation remarks of at least 10 characters before running the policy evaluation.'); return; }
    if (!beginAction('policy-evaluation', 'Evaluating policy, evidence, coverage, and current budget state...')) return;
    try {
      const result = await evaluateRequestWorkflow(request.id, evaluationRemarks);
      setWorkflowEvaluation(result); setEvidenceReviewed(false); setCoverageConfirmed(false); setEvaluationConfirmed(false);
      announce(result.humanReviewRequired ? 'info' : 'success', result.humanReviewRequired ? 'Evaluation completed. Resolve the listed human-review findings before approval.' : 'Evaluation completed and is ready for evidence and coverage confirmation.');
    } catch (error) { announce('error', getActionErrorMessage(error, 'Unable to evaluate this request.')); }
    finally { finishAction(); }
  };

  const handleEvaluationConfirmation = async () => {
    const confirmationRemarks = remarks.trim();
    if (!workflowEvaluation) { announce('error', 'Run the policy evaluation before confirming evidence and coverage.'); return; }
    if (!evidenceReviewed || !coverageConfirmed) { announce('error', 'Confirm both evidence review and coverage before continuing.'); return; }
    if (confirmationRemarks.length < 10) { announce('error', 'Enter confirmation remarks of at least 10 characters.'); return; }
    if (!beginAction('policy-confirmation', 'Confirming reviewed evidence and coverage...')) return;
    try {
      await confirmRequestWorkflowEvaluation(request.id, workflowEvaluation.evaluationId, { evidenceReviewed, coverageConfirmed, remarks: confirmationRemarks });
      setEvaluationConfirmed(true); announce('success', 'Evidence and coverage were confirmed. Approval remains a separate action.');
    } catch (error) { announce('error', getActionErrorMessage(error, 'Unable to confirm the evaluation.')); }
    finally { finishAction(); }
  };

  const handleLetterUpload = async (file: File | undefined) => {
    if (!file) return;
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!extension || !['pdf', 'doc', 'docx'].includes(extension)) {
      announce('error', 'Unsupported guarantee-letter format. Select a PDF, DOC, or DOCX file.');
      return;
    }
    if (file.size === 0) {
      announce('error', 'The selected guarantee-letter file is empty. Select a valid PDF, DOC, or DOCX file.');
      return;
    }
    if (!beginAction('letter-upload', `Uploading and preparing ${file.name}...`)) return;
    try {
      const letter = await uploadGuaranteeLetter(request.id, file);
      const updated = await getRequest(request.id);
      setProtectedLetter(letter); setLetterReviewed(false); setRequestQr(undefined); setRequestStatus(updated.status); onStatusUpdated?.(updated);
      setAuditLogs(await getRequestAudit(request.id));
      announce('success', letter.sourceType === 'pdf' ? 'PDF uploaded and watermarked for review.' : 'Word file converted to a watermarked PDF. Review it before final release.');
    } catch (error) { announce('error', getActionErrorMessage(error, 'Unable to prepare the guarantee letter. The selected file was not accepted.')); }
    finally { finishAction(); }
  };

  const handleLetterPreview = async () => {
    if (!beginAction('letter-preview', 'Opening the converted guarantee-letter PDF...')) return;
    try {
      const url = await previewGuaranteeLetter(request.id);
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) { URL.revokeObjectURL(url); throw new Error('Allow pop-ups to preview the converted PDF.'); }
      setLetterReviewed(true);
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setAuditLogs(await getRequestAudit(request.id));
      announce('success', 'Guarantee-letter preview opened. You may now confirm this version.');
    } catch (error) { announce('error', getActionErrorMessage(error, 'Unable to preview the guarantee letter.')); }
    finally { finishAction(); }
  };

  const handleLetterConfirm = async () => {
    if (!protectedLetter) { announce('error', 'Upload a guarantee letter before confirming it.'); return; }
    if (!beginAction('letter-confirm', 'Confirming the current guarantee-letter version...')) return;
    try {
      const updated = await confirmGuaranteeLetter(request.id, protectedLetter.version);
      setProtectedLetter(updated.protectedLetter); setRequestQr(updated.qrCode); setRequestStatus(updated.status); onStatusUpdated?.(updated); setAuditLogs(await getRequestAudit(request.id));
      announce('success', 'Current letter version confirmed for final release.');
    } catch (error) { announce('error', getActionErrorMessage(error, 'Unable to confirm the guarantee letter.')); }
    finally { finishAction(); }
  };

  const handleLetterRevoke = async () => {
    const enteredReason = window.prompt('Why must this approved letter and QR be revoked?');
    if (enteredReason === null) return;
    const reason = enteredReason.trim();
    if (!reason) { announce('error', 'Enter a revocation reason before revoking the letter and QR.'); return; }
    if (!beginAction('letter-revoke', 'Revoking the protected letter and QR...')) return;
    try {
      const updated = await revokeGuaranteeLetter(request.id, reason);
      setProtectedLetter(updated.protectedLetter); setRequestQr(undefined); setRequestStatus(updated.status); onStatusUpdated?.(updated); setAuditLogs(await getRequestAudit(request.id));
      announce('success', 'The approved letter and its QR have been revoked.');
    } catch (error) { announce('error', getActionErrorMessage(error, 'Unable to revoke the guarantee letter.')); }
    finally { finishAction(); }
  };

  const handleDeny = async () => {
    await updateStatus('denied');
  };

  const handleRetrySms = async () => {
    if (!approvalSms) { announce('error', 'No approval SMS record is available to retry.'); return; }
    if (!beginAction('sms-retry', 'Retrying approval SMS delivery...')) return;
    try {
      const result = await retryApprovalSms(approvalSms.id);
      setApprovalSms(result);
      setAuditLogs(await getRequestAudit(request.id));
      announce('success', `SMS status: ${result.status.replaceAll('_', ' ')}.`);
    } catch (error) {
      announce('error', getActionErrorMessage(error, 'Unable to retry SMS delivery.'));
    } finally {
      finishAction();
    }
  };

  const handleSaveGuaranteeLetterTracking = async () => {
    if (!beginAction('claiming-save', 'Saving Step 2 claiming preparation...')) return;
    try {
      const updatedRequest = await updateGuaranteeLetterTracking(request.id, trackingPayload());
      setClaimReference(updatedRequest.guaranteeLetterTracking?.claimReference ?? '');
      setScheduledFor(updatedRequest.guaranteeLetterTracking?.scheduledFor ?? '');
      setClaimingTime(updatedRequest.guaranteeLetterTracking?.claimingTime ?? '');
      setClaimingLocation(updatedRequest.guaranteeLetterTracking?.claimingLocation ?? '');
      setGuaranteeLetterStatus(updatedRequest.guaranteeLetterTracking?.status ?? 'pending');
      onStatusUpdated?.(updatedRequest);
      setAuditLogs(await getRequestAudit(request.id));
      announce('success', 'Claiming preparation progress was saved.');
    } catch (err) {
      announce('error', getActionErrorMessage(err, 'Unable to save claiming preparation. Your entered values were kept.'));
    } finally {
      finishAction();
    }
  };

  const handleReleaseClaiming = async () => {
    if (!trackingIsComplete()) return;
    if (protectedLetter?.status !== 'confirmed') {
      announce('error', !protectedLetter ? 'Upload a guarantee letter before final release.' : protectedLetter.conversionStatus !== 'ready' ? 'Wait for the guarantee letter to finish converting before final release.' : 'Preview and confirm the current guarantee letter before final release.');
      return;
    }
    if (!beginAction('claiming-release', 'Completing claiming preparation and generating protected access...')) return;
    try {
      const saved = await updateGuaranteeLetterTracking(request.id, trackingPayload());
      onStatusUpdated?.(saved);
      const released = await releaseClaimingPreparation(request.id);
      setRequestStatus(released.status);
      setProtectedLetter(released.protectedLetter);
      setRequestQr(released.qrCode);
      setApprovalSms(released.approvalSms);
      setGuaranteeLetterStatus(released.guaranteeLetterTracking?.status ?? 'ready_for_claiming');
      onStatusUpdated?.(released);
      setAuditLogs(await getRequestAudit(request.id));
      announce('success', `${request.requestId} is ready for claiming and its protected QR is available.`);
    } catch (error) {
      announce('error', getActionErrorMessage(error, 'Unable to release claiming access. Your Step 2 values were kept.'));
    } finally {
      finishAction();
    }
  };

  const toggleCorrectionDocument = (documentId: string) => {
    setCorrectionErrors((current) => ({ ...current, documents: undefined }));
    setSelectedCorrectionDocumentIds((current) => current.includes(documentId)
      ? current.filter((id) => id !== documentId)
      : [...current, documentId]);
  };

  const auditDescription = (log: AuditLog) => {
    if (log.action === 'correction_requested') {
      const labels = log.selectedDocuments?.map((document) => document.label || document.documentType || document.name).join(', ');
      return log.performedBy + ' requested replacement of ' + (labels || 'selected documents') + '.';
    }
    if (log.action === 'correction_document_uploaded') {
      const label = log.replacementDocument?.label || log.replacementDocument?.documentType || log.replacementDocument?.name || 'a requested document';
      return log.performedBy + ' uploaded a replacement for ' + label + '.';
    }
    if (log.action === 'corrections_submitted') {
      const count = log.replacementDocuments?.length ?? 0;
      return log.performedBy + ' submitted ' + count + ' replacement' + (count === 1 ? '' : 's') + '; the request returned to Under Review.';
    }
    if (log.action === 'guarantee_letter_tracking_updated') return log.remarks;
    if (log.action === 'claiming_preparation_released') return `${log.performedBy} completed claiming preparation and released protected guarantee-letter access.`;
    if (log.action?.startsWith('guarantee_letter_')) return `${log.performedBy} recorded ${log.action.replaceAll('_', ' ')}.`;
    if (log.action?.startsWith('sms_')) return `${log.performedBy} recorded ${log.action.replaceAll('_', ' ')}.`;
    if (log.action === 'request_approved') return log.performedBy + ' approved the review decision; claiming preparation is the next step.';
    return log.previousStatus && log.status
      ? log.performedBy + ' changed the status from ' + log.previousStatus.replaceAll('_', ' ') + ' to ' + log.status.replaceAll('_', ' ') + '.'
      : `${log.performedBy} recorded ${log.action?.replaceAll('_', ' ') || 'request activity'}.`;
  };

  return (
    <>
      <motion.div
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="request-details-title"
          aria-describedby="request-details-description"
          className="bg-white rounded-lg max-w-5xl w-full max-h-[90vh] overflow-y-auto"
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 300 }}
        >
          <motion.div
            className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between"
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
          >
            <div>
              <h2 id="request-details-title" className="text-xl text-gray-900">Request Details</h2>
              <p id="request-details-description" className="text-sm text-gray-600 mt-1">Request ID: {request.requestId}</p>
            </div>
            <motion.button
              onClick={onClose}
              aria-label="Close request details"
              autoFocus
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
            >
              <X size={20} className="text-gray-600" />
            </motion.button>
          </motion.div>

          <motion.div
            className="p-6 space-y-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            {isLegacyMedicineRequest && (
              <div role="status" className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900">
                <Info size={20} className="mt-0.5 shrink-0" />
                <p className="text-sm">
                  This is a historical Medicine Assistance request. Medicine Assistance is no longer available for new applications, but this record can still be reviewed and processed.
                </p>
              </div>
            )}
            <ActionFeedback feedback={actionFeedback} />
            <section aria-label="Request workflow progress" className="grid gap-3 sm:grid-cols-2">
              <div className={`rounded-lg border p-4 ${['approved', 'ready_for_claiming'].includes(requestStatus) ? 'border-emerald-200 bg-emerald-50' : requestStatus === 'denied' ? 'border-red-200 bg-red-50' : 'border-blue-200 bg-blue-50'}`}>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Step 1: Review decision</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{requestStatus === 'pending' ? 'Review the request and move it under review.' : requestStatus === 'under_review' ? 'Complete review, request corrections, approve, or deny.' : requestStatus === 'correction_requested' ? 'Waiting for the applicant to submit requested corrections.' : requestStatus === 'denied' ? 'Review completed - request denied.' : 'Review completed - request approved.'}</p>
              </div>
              {['approved', 'ready_for_claiming'].includes(requestStatus) && <div className={`rounded-lg border p-4 ${requestStatus === 'ready_for_claiming' ? 'border-teal-200 bg-teal-50' : 'border-violet-200 bg-violet-50'}`}>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Step 2: Prepare claiming</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{requestStatus === 'ready_for_claiming' ? 'Claiming details and protected-letter access have been released.' : 'Save claiming details, attach and confirm the letter, then release access.'}</p>
              </div>}
            </section>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <h3 className="text-sm text-gray-600 uppercase tracking-wide">Authenticated requester</h3>

                <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <User className="text-gray-400 mt-0.5" size={18} />
                    <div>
                      <p className="text-xs text-gray-600">Full Name</p>
                      <p className="text-sm text-gray-900">{requester.fullName}</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <Phone className="text-gray-400 mt-0.5" size={18} />
                    <div>
                      <p className="text-xs text-gray-600">Contact Number</p>
                      <p className="text-sm text-gray-900">{requester.phone || 'Not recorded'}</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <Mail className="text-gray-400 mt-0.5" size={18} />
                    <div>
                      <p className="text-xs text-gray-600">Email</p>
                      <p className="text-sm text-gray-900">{requester.email || 'Not recorded'}</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <Calendar className="text-gray-400 mt-0.5" size={18} />
                    <div>
                      <p className="text-xs text-gray-600">Applicant account ID</p>
                      <p className="text-sm text-gray-900">{requester.applicantId || 'Legacy record'}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-sm text-gray-600 uppercase tracking-wide">Beneficiary / patient</h3>
                <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                  <div><p className="text-xs text-gray-600">Assistance for</p><p className="text-sm text-gray-900">{assistanceFor}</p></div>
                  <div className="flex items-start gap-3"><User className="text-gray-400 mt-0.5" size={18} /><div><p className="text-xs text-gray-600">Beneficiary name</p><p className="text-sm text-gray-900">{beneficiary.fullName}</p></div></div>
                  <div className="flex items-start gap-3"><MapPin className="text-gray-400 mt-0.5" size={18} /><div><p className="text-xs text-gray-600">Beneficiary address</p><p className="text-sm text-gray-900">{beneficiary.address}</p></div></div>
                  <div className="flex items-start gap-3"><Calendar className="text-gray-400 mt-0.5" size={18} /><div><p className="text-xs text-gray-600">Beneficiary birthdate</p><p className="text-sm text-gray-900">{beneficiary.dateOfBirth}</p></div></div>
                  <div><p className="text-xs text-gray-600">Requester’s relationship to beneficiary</p><p className="text-sm text-gray-900">{beneficiary.relationshipToApplicant || 'Not recorded'}</p></div>
                  <div><p className="text-xs text-gray-600">Beneficiary sex</p><p className="text-sm text-gray-900">{beneficiary.sex || 'Not recorded'}</p></div>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-sm text-gray-600 uppercase tracking-wide">Assistance Details</h3>

                <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                  <div>
                    <p className="text-xs text-gray-600">Assistance Type</p>
                    <p className="text-sm text-gray-900 mt-1">{request.assistanceType}</p>
                  </div>

                  <div>
                    <p className="text-xs text-gray-600">Date Submitted</p>
                    <p className="text-sm text-gray-900 mt-1">{request.dateSubmitted}</p>
                  </div>

                  <div>
                    <p className="text-xs text-gray-600">Current Status</p>
                    <span
                      className={`inline-flex px-3 py-1 text-xs rounded-full mt-1 ${
                        requestStatus === 'pending'
                          ? 'bg-slate-100 text-slate-700'
                          : requestStatus === 'under_review'
                          ? 'bg-blue-100 text-blue-700'
                          : requestStatus === 'correction_requested'
                          ? 'bg-amber-100 text-amber-800'
                          : requestStatus === 'approved'
                          ? 'bg-violet-100 text-violet-700'
                          : requestStatus === 'ready_for_claiming'
                          ? 'bg-teal-100 text-teal-700'
                          : 'bg-red-100 text-red-700'
                      }`}
                    >
                      <span className="capitalize">{requestStatus.replaceAll('_', ' ')}</span>
                    </span>
                  </div>
                </div>
              </div>

              {request.processedBy && (
                <div className="border-t border-gray-200 pt-3">
                  <p className="text-xs text-gray-600">Processed by CMO Personnel</p>
                  <p className="text-sm text-gray-900 mt-1">{request.processedBy}</p>
                  {request.processedAt && <p className="text-xs text-gray-500 mt-1">{new Date(request.processedAt).toLocaleString()}</p>}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <h3 className="text-sm text-gray-600 uppercase tracking-wide">Household and Patient Circumstances</h3>
              <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                <div>
                  <p className="text-xs text-gray-600">Source of income</p>
                  <p className="text-sm text-gray-900 mt-1">{request.incomeSource || 'Not recorded'}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-600">What happened to the patient</p>
                  <p className="text-sm text-gray-900 mt-1">{request.patientCircumstance || 'Not recorded'}</p>
                </div>
                {request.additionalDetails && (
                  <div>
                    <p className="text-xs text-gray-600">Additional details</p>
                    <p className="text-sm text-gray-900 mt-1">{request.additionalDetails}</p>
                  </div>
                )}
                {request.reason && !request.incomeSource && !request.patientCircumstance && (
                  <div>
                    <p className="text-xs text-gray-600">Legacy reason for assistance</p>
                    <p className="text-sm text-gray-900 mt-1">{request.reason}</p>
                  </div>
                )}
              </div>
            </div>

            {requestStatus === 'correction_requested' && correctionRequest && (
              <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <div className="flex items-start gap-3">
                  <FileWarning size={20} className="mt-0.5 shrink-0 text-amber-700" />
                  <div>
                    <p className="text-sm font-medium text-amber-950">Waiting for applicant corrections</p>
                    <p className="mt-1 text-sm text-amber-900">{correctionRequest.remark}</p>
                    <p className="mt-2 text-xs text-amber-800">
                      Requested by {correctionRequest.requestedBy} on {new Date(correctionRequest.requestedAt).toLocaleString()}
                    </p>
                  </div>
                </div>
                <ul className="mt-3 space-y-2 border-t border-amber-200 pt-3">
                  {correctionRequest.documents.map((document) => {
                    const replacement = correctionRequest.replacements.find((item) => item.replacesDocumentId === document.documentId);
                    return (
                      <li key={document.documentId} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-amber-950">{document.label || document.name}</span>
                        <span className={replacement ? 'font-medium text-emerald-700' : 'text-amber-700'}>
                          {replacement ? 'Replacement uploaded' : 'Awaiting replacement'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {auditLogs.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm text-gray-600 uppercase tracking-wide">Decision Audit Trail</h3>
                <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                  {auditLogs.map((log) => (
                    <div key={log.id} className="p-3 text-sm">
                      <p className="text-gray-900">{auditDescription(log)}</p>
                      <p className="mt-1 text-xs text-gray-500">{new Date(log.performedAt).toLocaleString()} · {log.remarks}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-3">
                <h3 className="text-sm text-gray-600 uppercase tracking-wide">Supporting Documents Attached</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {request.documents.map((doc) => (
                  <div key={doc.id} className="relative group">
                    <div className="aspect-square bg-gray-100 rounded-lg overflow-hidden border border-gray-200">
                      <ProtectedDocumentImage
                        src={doc.url}
                        alt={doc.name}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-40 transition-all rounded-lg flex items-center justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => void previewDocument(doc.url)}
                        className="opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100 transition-opacity p-2 bg-white rounded-lg hover:bg-gray-100"
                        aria-label={`View ${doc.name} full size`}
                      >
                        <ZoomIn size={18} className="text-gray-700" />
                      </button>
                      <button
                        type="button"
                          onClick={() => void downloadDocument(doc.url, doc.name)}
                          disabled={submitting}
                        className="flex min-h-11 min-w-11 items-center justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100 transition-opacity p-2 bg-white rounded-lg hover:bg-gray-100"
                        aria-label={`Download ${doc.name}`}
                      >
                        <Download size={18} className="text-gray-700" />
                      </button>
                    </div>
                    <p className="mt-1 inline-flex rounded-full bg-blue-100 px-2 py-1 text-xs font-medium text-blue-800">{doc.label || doc.documentType || doc.name}</p>
                    {doc.analysis?.requiresHumanReview && (
                      <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] leading-4 text-amber-900">
                        <p className="font-semibold">Case Worker review required</p>
                        {doc.analysis.confidence != null && <p>Analyzer confidence: {Math.round(doc.analysis.confidence * 100)}%</p>}
                        {(doc.analysis.humanReviewReasons || doc.analysis.explanations || []).map((reason) => <p key={reason}>{reason}</p>)}
                        <p>Automated analysis does not decide authenticity or eligibility.</p>
                      </div>
                    )}
                    {canProcess && ['pending', 'under_review'].includes(requestStatus) && (
                      <label className="mt-2 flex min-h-9 cursor-pointer items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 text-xs font-medium text-amber-900">
                        <input
                          type="checkbox"
                          checked={selectedCorrectionDocumentIds.includes(doc.id)}
                          onChange={() => toggleCorrectionDocument(doc.id)}
                          aria-describedby="correction-document-help correction-document-error"
                          className="size-4 accent-amber-600"
                        />
                        Request replacement
                      </label>
                    )}
                    {doc.analysis ? (
                      <div className="mt-2 space-y-1 text-[11px] text-gray-600">
                        <p className="font-medium text-green-700">Quality analysis accepted</p>
                        <p>Orientation: {doc.analysis.orientation.replace('_', ' ')}</p>
                        <p>Analyzed: {new Date(doc.analysis.analyzedAt).toLocaleString()}</p>
                        <p>Analyzer: {doc.analysis.analyzerVersion}</p>
                        {doc.analysis.warnings.map((warning) => <p key={warning} className="text-amber-700">Guidance: {warning}</p>)}
                      </div>
                    ) : (
                      <p className="mt-2 text-[11px] text-gray-500">Legacy document — no automated quality record.</p>
                    )}
                  </div>
                ))}
              </div>
              <p id="correction-document-help" className="text-xs text-gray-500">Quality analysis checks technical readability only. It does not verify document authenticity.</p>
              {correctionErrors.documents && <p id="correction-document-error" role="alert" className="text-sm font-medium text-red-700">{correctionErrors.documents}</p>}
            </div>

            {canProcess && ['pending', 'under_review'].includes(requestStatus) && (
              <section aria-label="Policy evaluation" className="space-y-3 rounded-lg border border-indigo-200 bg-indigo-50 p-4">
                <div><p className="text-sm font-semibold text-indigo-950">Policy evaluation</p><p className="mt-1 text-xs text-indigo-800">Evaluate findings and coverage first. Evaluation never approves the request.</p></div>
                <button type="button" onClick={handlePolicyEvaluation} disabled={submitting} aria-busy={activeAction === 'policy-evaluation'} className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">{activeAction === 'policy-evaluation' ? 'Evaluating...' : workflowEvaluation ? 'Re-evaluate current request' : 'Evaluate policy and coverage'}</button>
                {workflowEvaluation && <div className="space-y-3 rounded-md border border-indigo-200 bg-white p-3 text-sm">
                  <div className="flex flex-wrap gap-2"><span className={`rounded-full px-2 py-1 text-xs font-medium ${workflowEvaluation.humanReviewRequired ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>{workflowEvaluation.outcome.replaceAll('_', ' ')}</span><span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-700">Coverage: {workflowEvaluation.coverage.outcome.replaceAll('_', ' ')}</span></div>
                  {workflowEvaluation.findings.length > 0 && <div><p className="font-medium text-slate-900">Findings</p><ul className="mt-1 list-disc space-y-1 pl-5 text-slate-700">{workflowEvaluation.findings.map((finding, index) => <li key={`${finding.code}-${index}`}>{finding.message} <span className="text-xs text-slate-500">({finding.code})</span></li>)}</ul></div>}
                  {workflowEvaluation.requiredEvidence.length > 0 && <div><p className="font-medium text-slate-900">Required evidence</p><ul className="mt-1 list-disc space-y-1 pl-5 text-slate-700">{workflowEvaluation.requiredEvidence.map((item, index) => <li key={`${item.reasonCode || item.ruleCode || item.type}-${index}`}>{item.type || item.ruleCode || 'Supporting evidence'}{item.reasonCode ? ` — ${item.reasonCode}` : ''}</li>)}</ul></div>}
                  <div className="grid gap-2 sm:grid-cols-2"><p><span className="font-medium">Covered amount:</span> {workflowEvaluation.coverage.coveredAmount == null ? 'Pending configuration' : `₱${workflowEvaluation.coverage.coveredAmount.toLocaleString()}`}</p><p><span className="font-medium">Remaining balance:</span> {workflowEvaluation.coverage.netRemainingBalance == null ? 'Pending configuration' : `₱${workflowEvaluation.coverage.netRemainingBalance.toLocaleString()}`}</p></div>
                  <p className="text-xs text-slate-600">Policy versions: {workflowEvaluation.policyVersion.hardDisqualifiers || 'none'} · {workflowEvaluation.policyVersion.coverageMatrix || 'none'}</p>
                  {requestStatus === 'under_review' ? <>
                    <div className="space-y-2 border-t pt-3"><label className="flex items-center gap-2"><input type="checkbox" checked={evidenceReviewed} onChange={(event) => setEvidenceReviewed(event.target.checked)} />I reviewed the supporting evidence.</label><label className="flex items-center gap-2"><input type="checkbox" checked={coverageConfirmed} onChange={(event) => setCoverageConfirmed(event.target.checked)} />I confirm the displayed coverage calculation.</label></div>
                    <button type="button" onClick={handleEvaluationConfirmation} disabled={submitting || evaluationConfirmed || workflowEvaluation.humanReviewRequired} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">{activeAction === 'policy-confirmation' ? 'Confirming...' : evaluationConfirmed ? 'Evaluation confirmed' : 'Confirm evidence and coverage'}</button>
                    {evaluationConfirmed && <p role="status" className="text-xs font-medium text-emerald-700">Confirmed. Approval or denial must still be completed with the decision buttons below.</p>}
                  </> : <p className="border-t pt-3 text-xs font-medium text-indigo-800">Move this request to Under Review before confirming evidence and coverage.</p>}
                </div>}
              </section>
            )}

            {canProcess && ['pending', 'under_review'].includes(requestStatus) && (
              <div className="space-y-3">
                <label htmlFor="admin-remarks" className="block text-sm text-gray-700 uppercase tracking-wide">Correction or decision remarks (required)</label>
                <textarea
                  id="admin-remarks"
                  value={remarks}
                  onChange={(e) => { setRemarks(e.target.value); setCorrectionErrors((current) => ({ ...current, remark: undefined })); }}
                  placeholder="For corrections, clearly explain what the applicant must fix..."
                  aria-invalid={Boolean(correctionErrors.remark)}
                  aria-describedby="correction-remark-help correction-remark-error"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  rows={4}
                />
                <p id="correction-remark-help" className="text-xs text-gray-500">Correction requests must tell the applicant exactly what is wrong and how to correct it.</p>
                {correctionErrors.remark && <p id="correction-remark-error" role="alert" className="text-sm font-medium text-red-700">{correctionErrors.remark}</p>}
              </div>
            )}

            {request.guaranteeLetter && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-950">Historical guarantee-letter upload</p>
                <p className="mt-1 text-xs text-amber-800">This metadata is retained for an application approved before staff uploads were discontinued.</p>
                <button type="button" disabled={submitting} className="mt-1 inline-flex items-center gap-2 text-sm text-green-700 underline disabled:opacity-60" onClick={() => void openDocument(request.guaranteeLetter!.url)}>
                  <Download size={16} /> {request.guaranteeLetter.name}
                </button>
              </div>
            )}

            {requestStatus === 'ready_for_claiming' && (
              <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                <p className="text-sm font-medium text-green-950">Released claiming details</p>
                <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-5">
                  <div><dt className="text-green-700">Claim reference</dt><dd className="font-medium text-green-950">{claimReference}</dd></div>
                  <div><dt className="text-green-700">Claiming date</dt><dd className="font-medium text-green-950">{scheduledFor}</dd></div>
                  <div><dt className="text-green-700">Claiming time</dt><dd className="font-medium text-green-950">{claimingTime}</dd></div>
                  <div><dt className="text-green-700">Location</dt><dd className="font-medium text-green-950">{claimingLocation}</dd></div>
                  <div><dt className="text-green-700">Status</dt><dd className="font-medium capitalize text-green-950">ready for claiming</dd></div>
                </dl>
              </div>
            )}

            {canProcess && requestStatus === 'approved' && (
              <div className="space-y-3 rounded-lg border border-green-200 bg-green-50 p-4">
                <div>
                  <p className="text-sm font-medium text-green-950">Step 2 claiming details</p>
                  <p className="text-xs text-green-800">Save progress at any time. All fields are required only when releasing the protected letter to the requestor.</p>
                </div>
                <label htmlFor="approved-claim-reference" className="block text-sm font-medium text-green-950">Claim reference</label>
                <input id="approved-claim-reference" value={claimReference} onChange={(event) => setClaimReference(event.target.value)} maxLength={120} className="w-full rounded-lg border border-green-200 bg-white px-3 py-2 text-sm" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="approved-guarantee-schedule" className="block text-sm font-medium text-green-950">Claim schedule</label>
                    <input id="approved-guarantee-schedule" type="date" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} className="mt-1 w-full rounded-lg border border-green-200 bg-white px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label htmlFor="approved-guarantee-status" className="block text-sm font-medium text-green-950">Status</label>
                    <select id="approved-guarantee-status" value={guaranteeLetterStatus} onChange={(event) => setGuaranteeLetterStatus(event.target.value as GuaranteeLetterStatus)} className="mt-1 w-full rounded-lg border border-green-200 bg-white px-3 py-2 text-sm">
                      {guaranteeLetterStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="approved-claiming-time" className="block text-sm font-medium text-green-950">Claiming time</label>
                    <input id="approved-claiming-time" type="time" value={claimingTime} onChange={(event) => setClaimingTime(event.target.value)} className="mt-1 w-full rounded-lg border border-green-200 bg-white px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label htmlFor="approved-claiming-location" className="block text-sm font-medium text-green-950">Claiming location</label>
                    <input id="approved-claiming-location" value={claimingLocation} onChange={(event) => setClaimingLocation(event.target.value)} maxLength={200} className="mt-1 w-full rounded-lg border border-green-200 bg-white px-3 py-2 text-sm" />
                  </div>
                </div>
                <button type="button" onClick={handleSaveGuaranteeLetterTracking} disabled={submitting} aria-busy={activeAction === 'claiming-save'} className="rounded-lg bg-green-700 px-4 py-2 text-sm text-white hover:bg-green-800 disabled:opacity-70">{activeAction === 'claiming-save' ? 'Saving Step 2...' : 'Save Step 2 progress'}</button>
              </div>
            )}

            {approvalSms && (
              <div className="rounded-lg border border-violet-200 bg-violet-50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-violet-950">Approval SMS delivery</p>
                    <p className="mt-1 text-xs text-violet-800">Status: <span className="font-semibold capitalize">{approvalSms.status.replaceAll('_', ' ')}</span> · Attempts: {approvalSms.attemptCount}/{approvalSms.maxAttempts}</p>
                    {approvalSms.nextAttemptAt && <p className="text-xs text-violet-800">Next retry: {new Date(approvalSms.nextAttemptAt).toLocaleString()}</p>}
                    {approvalSms.lastError && <p className="mt-1 text-xs text-red-700">{approvalSms.lastError}</p>}
                  </div>
                  {canProcess && approvalSms.status !== 'delivered' && <button type="button" onClick={handleRetrySms} disabled={submitting} className="rounded-md border border-violet-300 bg-white px-3 py-2 text-xs font-medium text-violet-800 disabled:opacity-60">Retry SMS</button>}
                </div>
              </div>
            )}

            {request.facilityEvidence && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
                <p className="text-sm font-medium text-blue-950">Facility identified from receipt evidence</p>
                <p className="mt-1 text-sm text-blue-900">{request.facilityEvidence.facilityName} ({request.facilityEvidence.facilityType})</p>
                <p className="text-xs text-blue-800">Receipt {request.facilityEvidence.referenceNumber}, dated {request.facilityEvidence.receiptDate}; {request.facilityEvidence.validation.ageDays} days old. Quality analysis does not verify authenticity.</p>
              </div>
            )}

            {requestQr && (
              <div className="rounded-lg border border-green-200 bg-white p-4 text-center">
                <p className="mb-3 text-sm font-medium text-green-900">Approved Request QR</p>
                <img src={requestQr.imageDataUrl} alt={`QR code for ${request.requestId}`} className="mx-auto h-56 w-56" />
              </div>
            )}

            {canProcess && ['approved', 'ready_for_claiming'].includes(requestStatus) && (
              <div className="space-y-3 rounded-lg border border-violet-200 bg-violet-50 p-4">
                <div className="flex items-start gap-3"><FileText className="mt-0.5 text-violet-700" size={20} /><div><p className="text-sm font-medium text-violet-950">Step 2 guarantee letter</p><p className="text-xs text-violet-800">Upload a PDF, DOC, or DOCX, then preview the PDF before confirming it.</p></div></div>
                <div className="rounded-md border border-violet-200 bg-white p-3 text-xs text-violet-950"><p><strong>Status:</strong> {protectedLetter?.status?.replaceAll('_', ' ') || 'unavailable'}</p>{protectedLetter && <><p><strong>Version:</strong> {protectedLetter.version} · <strong>Conversion:</strong> {protectedLetter.conversionStatus}</p><p><strong>Uploaded:</strong> {new Date(protectedLetter.uploadedAt).toLocaleString()} by {protectedLetter.uploaderName}</p></>}</div>
                <label aria-disabled={submitting} className={`inline-flex min-h-10 items-center gap-2 rounded-md bg-violet-700 px-4 text-sm font-medium text-white ${submitting ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}><Upload size={16} />{activeAction === 'letter-upload' ? 'Uploading letter...' : protectedLetter ? 'Replace letter' : 'Upload letter'}<input type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="sr-only" disabled={submitting} onChange={(event) => { void handleLetterUpload(event.target.files?.[0]); event.currentTarget.value = ''; }} /></label>
                {protectedLetter?.conversionStatus === 'ready' && <div className="flex flex-wrap gap-2"><button type="button" onClick={handleLetterPreview} disabled={submitting} className="inline-flex min-h-10 items-center gap-2 rounded-md border border-violet-300 bg-white px-4 text-sm font-medium text-violet-800 disabled:opacity-50"><Eye size={16} />{activeAction === 'letter-preview' ? 'Opening preview...' : 'Preview watermarked PDF'}</button>{protectedLetter.status === 'pending_review' && <button type="button" onClick={handleLetterConfirm} disabled={submitting} aria-describedby={!letterReviewed ? 'letter-confirm-help' : undefined} className="inline-flex min-h-10 items-center gap-2 rounded-md bg-emerald-700 px-4 text-sm font-medium text-white disabled:opacity-50"><ShieldCheck size={16} />{activeAction === 'letter-confirm' ? 'Confirming...' : 'Confirm current version'}</button>}</div>}
                {protectedLetter?.status === 'pending_review' && !letterReviewed && <p id="letter-confirm-help" className="text-xs font-medium text-violet-900">Preview the current PDF before confirming this version.</p>}
                {protectedLetter?.status === 'approved' && <button type="button" onClick={handleLetterRevoke} disabled={submitting} className="inline-flex min-h-10 items-center justify-center rounded-md border border-red-300 bg-white px-4 text-sm font-medium text-red-700 disabled:opacity-50">Revoke letter and QR</button>}
                <p className="text-xs text-violet-800">The viewer has no download or print buttons, but copying cannot be completely prevented. The AidLink QR and letter are not an official client QR or template.</p>
              </div>
            )}

            {canProcess && requestStatus === 'approved' && (
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4">
                <p className="text-sm font-medium text-teal-950">Final Step 2 release</p>
                <p className="mt-1 text-xs text-teal-800">Complete the claiming details and confirm the letter before release. The applicant receives the QR and approval SMS after release.</p>
                <button type="button" onClick={handleReleaseClaiming} disabled={submitting} aria-busy={activeAction === 'claiming-release'} className="mt-3 rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60">{activeAction === 'claiming-release' ? 'Releasing protected access...' : 'Release protected letter and mark ready for claiming'}</button>
              </div>
            )}

            <div className="flex flex-wrap gap-3 pt-4 border-t border-gray-200">
              {canProcess && requestStatus === 'pending' ? (
                <>
                  <button
                    onClick={() => void updateStatus('correction_requested')}
                    disabled={submitting}
                    className="flex min-w-52 flex-1 items-center justify-center gap-2 rounded-lg bg-amber-600 px-6 py-3 text-base text-white transition-colors hover:bg-amber-700 disabled:opacity-70"
                  >
                    <FileWarning size={20} />
                    Request Corrections ({selectedCorrectionDocumentIds.length})
                  </button>
                  <button
                    onClick={() => updateStatus('under_review')}
                    disabled={submitting || requestStatus === 'under_review'}
                    className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-base disabled:opacity-70"
                  >
                    {activeAction === 'status-under_review' ? 'Saving...' : 'Mark Under Review'}
                  </button>
                </>
              ) : canProcess && requestStatus === 'under_review' ? (
                <><button onClick={() => void updateStatus('correction_requested')} disabled={submitting} className="flex min-w-52 flex-1 items-center justify-center gap-2 rounded-lg bg-amber-600 px-6 py-3 text-base text-white hover:bg-amber-700 disabled:opacity-70"><FileWarning size={20} />{activeAction === 'status-correction_requested' ? 'Saving corrections...' : `Request Corrections (${selectedCorrectionDocumentIds.length})`}</button><button onClick={handleApprove} disabled={submitting} className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-violet-700 px-6 py-3 text-base text-white hover:bg-violet-800 disabled:opacity-70"><CheckCircle size={20} />{activeAction === 'status-approved' ? 'Approving...' : 'Approve Request'}</button><button onClick={handleDeny} disabled={submitting} className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-red-600 px-6 py-3 text-base text-white hover:bg-red-700 disabled:opacity-70"><XCircle size={20} />{activeAction === 'status-denied' ? 'Denying...' : 'Deny Request'}</button></>
              ) : requestStatus === 'correction_requested' ? (
                <div className="flex-1 py-3 text-center">
                  <p className="text-sm text-amber-800">The applicant can replace only the requested documents. This request returns to Under Review after all corrections are submitted.</p>
                </div>
              ) : requestStatus === 'pending' || requestStatus === 'under_review' ? (
                <div className="flex-1 text-center py-3">
                  <p className="text-sm text-gray-600">This account has read-only access to request decisions.</p>
                </div>
              ) : (
                <div className="flex-1 text-center py-3">
                  <p className="text-sm text-gray-600">
                    This request has been{' '}
                    <span className={requestStatus === 'ready_for_claiming' ? 'text-teal-700' : requestStatus === 'approved' ? 'text-violet-700' : 'text-red-600'}>
                      {requestStatus}
                    </span>
                  </p>
                </div>
              )}
              </div>
            </motion.div>
          </motion.div>
        </motion.div>

      {selectedImage && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Document preview"
          className="fixed inset-0 bg-black bg-opacity-90 z-[60] flex items-center justify-center p-4"
          onClick={closeDocumentPreview}
        >
          <div className="relative max-w-4xl max-h-full">
            <button
              type="button"
              onClick={closeDocumentPreview}
              aria-label="Close document preview"
              className="absolute -top-12 right-0 p-2 text-white hover:bg-white hover:bg-opacity-20 rounded-lg transition-colors"
            >
              <X size={24} />
            </button>
            <ImageWithFallback
              src={selectedImage}
              alt="Document preview"
              className="max-w-full max-h-[85vh] object-contain rounded-lg"
            />
          </div>
        </div>
      )}
    </>
  );
}
