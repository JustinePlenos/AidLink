import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistanceRequest } from '../types';
import { RequestDetailsModal } from './RequestDetailsModal';

const apiMocks = vi.hoisted(() => ({
  confirmRequestWorkflowEvaluation: vi.fn(),
  evaluateRequestWorkflow: vi.fn(),
  getRequestAudit: vi.fn(),
  getRequest: vi.fn(),
  releaseClaimingPreparation: vi.fn(),
  updateGuaranteeLetterTracking: vi.fn(),
  updateRequestStatus: vi.fn(),
  uploadGuaranteeLetter: vi.fn(),
}));

vi.mock('../api', () => ({
  confirmGuaranteeLetter: vi.fn(),
  confirmRequestWorkflowEvaluation: apiMocks.confirmRequestWorkflowEvaluation,
  downloadProtectedDocument: vi.fn(),
  evaluateRequestWorkflow: apiMocks.evaluateRequestWorkflow,
  getActionErrorMessage: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
  getIdentityProofObjectUrl: vi.fn(),
  getRequest: apiMocks.getRequest,
  getRequestAudit: apiMocks.getRequestAudit,
  openProtectedDocument: vi.fn(),
  previewGuaranteeLetter: vi.fn(),
  releaseClaimingPreparation: apiMocks.releaseClaimingPreparation,
  retryApprovalSms: vi.fn(),
  revokeGuaranteeLetter: vi.fn(),
  updateGuaranteeLetterTracking: apiMocks.updateGuaranteeLetterTracking,
  updateRequestStatus: apiMocks.updateRequestStatus,
  uploadGuaranteeLetter: apiMocks.uploadGuaranteeLetter,
}));

vi.mock('../utils/toast', () => ({
  showToast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('./ProtectedDocumentImage', () => ({
  ProtectedDocumentImage: ({ alt }: { alt: string }) => <div role="img" aria-label={alt}>Protected document</div>,
}));

const documents = [
  { id: 'document-1', name: 'valid-id.pdf', url: '/uploads/valid-id.pdf', documentType: 'Valid ID', label: 'Valid ID' },
  { id: 'document-2', name: 'indigency.pdf', url: '/uploads/indigency.pdf', documentType: 'Barangay Certificate of Indigency', label: 'Barangay Certificate of Indigency' },
];

function request(status: AssistanceRequest['status'] = 'pending'): AssistanceRequest {
  return {
    id: 'request-1',
    requestId: 'LINGAP-2026-00001',
    applicantName: 'Applicant One',
    email: 'applicant@example.com',
    phone: '09170000000',
    address: 'Davao City',
    dateOfBirth: '1990-01-01',
    assistanceType: 'Hospital Assistance',
    status,
    dateSubmitted: '2026-09-16T00:00:00.000Z',
    documents,
  };
}

function savedCorrection(source: AssistanceRequest, ids: string[], remark: string): AssistanceRequest {
  return {
    ...source,
    status: 'correction_requested',
    lastUpdatedAt: '2026-09-16T09:30:00.000Z',
    correctionRequest: {
      id: 'correction-1',
      status: 'requested',
      remark,
      requestedAt: '2026-09-16T09:30:00.000Z',
      requestedBy: 'Case Worker One',
      documents: documents.filter((document) => ids.includes(document.id)).map((document) => ({
        documentId: document.id,
        documentType: document.documentType,
        name: document.name,
        label: document.label,
      })),
      replacements: [],
    },
  };
}

describe('RequestDetailsModal correction workflow', () => {
  beforeEach(() => {
    apiMocks.confirmRequestWorkflowEvaluation.mockReset();
    apiMocks.evaluateRequestWorkflow.mockReset();
    apiMocks.getRequestAudit.mockResolvedValue([]);
    apiMocks.getRequest.mockReset();
    apiMocks.releaseClaimingPreparation.mockReset();
    apiMocks.updateGuaranteeLetterTracking.mockReset();
    apiMocks.updateRequestStatus.mockReset();
    apiMocks.uploadGuaranteeLetter.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('displays the authenticated requester separately from another beneficiary', () => {
    render(<RequestDetailsModal request={{
      ...request(),
      beneficiaryType: 'other',
      requester: {
        applicantId: 'applicant-alice',
        fullName: 'Alice Requester',
        email: 'alice@example.com',
        phone: '09171111111',
      },
      beneficiary: {
        fullName: 'Carlo Beneficiary',
        address: 'Beneficiary Home',
        dateOfBirth: '2012-03-04',
        relationshipToApplicant: 'Child',
        sex: 'Male',
      },
    }} canProcess onClose={vi.fn()} />);

    expect(screen.getByText('Authenticated requester')).toBeInTheDocument();
    expect(screen.getByText('Alice Requester')).toBeInTheDocument();
    expect(screen.getByText('Beneficiary / patient')).toBeInTheDocument();
    expect(screen.getByText('For someone else')).toBeInTheDocument();
    expect(screen.getByText('Carlo Beneficiary')).toBeInTheDocument();
    expect(screen.getByText('Child')).toBeInTheDocument();
  });

  it('shows validation feedback for a missing document selection and correction remark', async () => {
    const user = userEvent.setup();
    render(<RequestDetailsModal request={request()} canProcess onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Request Corrections (0)' }));

    expect(screen.getByText('Select at least one document that the applicant must replace.')).toHaveAttribute('role', 'alert');
    expect(screen.getByText('Enter a correction remark that clearly explains what the applicant must fix.')).toHaveAttribute('role', 'alert');
    expect(apiMocks.updateRequestStatus).not.toHaveBeenCalled();
  });

  it('saves one selected document and shows the persisted correction details', async () => {
    const source = request();
    const remark = 'Replace the Valid ID with a complete and readable copy.';
    apiMocks.updateRequestStatus.mockResolvedValue(savedCorrection(source, ['document-1'], remark));
    const user = userEvent.setup();
    render(<RequestDetailsModal request={source} canProcess onClose={vi.fn()} />);

    await user.click(screen.getAllByRole('checkbox', { name: 'Request replacement' })[0]);
    await user.type(screen.getByLabelText('Correction or decision remarks (required)'), remark);
    await user.click(screen.getByRole('button', { name: 'Request Corrections (1)' }));

    await waitFor(() => expect(apiMocks.updateRequestStatus).toHaveBeenCalledWith('request-1', 'correction_requested', remark, {
      correctionDocumentIds: ['document-1'],
    }));
    expect(await screen.findByText('Waiting for applicant corrections')).toBeInTheDocument();
    expect(screen.getByText(remark)).toBeInTheDocument();
    expect(screen.getByText(/Requested by Case Worker One on/)).toBeInTheDocument();
    expect(screen.getAllByText('Valid ID')).toHaveLength(2);
  });

  it('supports multiple document selections from an under-review request', async () => {
    const source = request('under_review');
    const remark = 'Replace both documents with complete, readable, and current copies.';
    apiMocks.updateRequestStatus.mockResolvedValue(savedCorrection(source, ['document-1', 'document-2'], remark));
    const user = userEvent.setup();
    render(<RequestDetailsModal request={source} canProcess onClose={vi.fn()} />);

    for (const checkbox of screen.getAllByRole('checkbox', { name: 'Request replacement' })) await user.click(checkbox);
    await user.type(screen.getByLabelText('Correction or decision remarks (required)'), remark);
    await user.click(screen.getByRole('button', { name: 'Request Corrections (2)' }));

    await waitFor(() => expect(apiMocks.updateRequestStatus).toHaveBeenCalledWith('request-1', 'correction_requested', remark, {
      correctionDocumentIds: ['document-1', 'document-2'],
    }));
    expect(await screen.findByText('Waiting for applicant corrections')).toBeInTheDocument();
    expect(screen.getAllByText('Barangay Certificate of Indigency')).toHaveLength(2);
  });

  it('keeps the original status when saving the correction request fails', async () => {
    apiMocks.updateRequestStatus.mockRejectedValue(new Error('Unable to save correction request.'));
    const user = userEvent.setup();
    render(<RequestDetailsModal request={request()} canProcess onClose={vi.fn()} />);

    await user.click(screen.getAllByRole('checkbox', { name: 'Request replacement' })[0]);
    await user.type(screen.getByLabelText('Correction or decision remarks (required)'), 'Replace this document with a readable copy.');
    await user.click(screen.getByRole('button', { name: 'Request Corrections (1)' }));

    await waitFor(() => expect(apiMocks.updateRequestStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Waiting for applicant corrections')).not.toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('moves pending to under review without requiring or showing Step 2 fields', async () => {
    const source = request('pending');
    apiMocks.updateRequestStatus.mockResolvedValue({ ...source, status: 'under_review' });
    const user = userEvent.setup();
    render(<RequestDetailsModal request={source} canProcess onClose={vi.fn()} />);

    expect(screen.getByText('Step 1: Review decision')).toBeInTheDocument();
    expect(screen.queryByText('Step 2: Prepare claiming')).not.toBeInTheDocument();
    expect(screen.queryByText('Step 2 claiming details')).not.toBeInTheDocument();
    expect(screen.queryByText('Step 2 protected guarantee letter')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve Request' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Correction or decision remarks (required)'), 'Initial investigation started.');
    await user.click(screen.getByRole('button', { name: 'Mark Under Review' }));

    await waitFor(() => expect(apiMocks.updateRequestStatus).toHaveBeenCalledWith('request-1', 'under_review', 'Initial investigation started.', { correctionDocumentIds: [] }));
    expect(screen.getByText('under review')).toBeInTheDocument();
    expect(screen.queryByText('Step 2: Prepare claiming')).not.toBeInTheDocument();
  });

  it('shows Step 2 only after an under-review request is approved without claiming fields', async () => {
    const source = request('under_review');
    apiMocks.updateRequestStatus.mockResolvedValue({ ...source, status: 'approved', processedBy: 'Case Worker One', processedAt: '2026-09-16T10:00:00.000Z' });
    const user = userEvent.setup();
    render(<RequestDetailsModal request={source} canProcess onClose={vi.fn()} />);

    expect(screen.queryByText('Step 2: Prepare claiming')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Correction or decision remarks (required)'), 'Review completed and eligibility approved.');
    await user.click(screen.getByRole('button', { name: 'Approve Request' }));

    await waitFor(() => expect(apiMocks.updateRequestStatus).toHaveBeenCalledWith('request-1', 'approved', 'Review completed and eligibility approved.', { correctionDocumentIds: [] }));
    expect(await screen.findByText('Step 2: Prepare claiming')).toBeInTheDocument();
    expect(screen.getByText('Step 2 claiming details')).toBeInTheDocument();
    expect(screen.getByText('Step 2 guarantee letter')).toBeInTheDocument();
  });

  it('moves an under-review request to denied without exposing Step 2', async () => {
    const source = request('under_review');
    apiMocks.updateRequestStatus.mockResolvedValue({ ...source, status: 'denied' });
    const user = userEvent.setup();
    render(<RequestDetailsModal request={source} canProcess onClose={vi.fn()} />);
    await user.type(screen.getByLabelText('Correction or decision remarks (required)'), 'Request denied after completed eligibility review.');
    await user.click(screen.getByRole('button', { name: 'Deny Request' }));
    await waitFor(() => expect(apiMocks.updateRequestStatus).toHaveBeenCalledWith('request-1', 'denied', 'Request denied after completed eligibility review.', { correctionDocumentIds: [] }));
    expect(screen.getAllByText('denied')).not.toHaveLength(0);
    expect(screen.queryByText('Step 2: Prepare claiming')).not.toBeInTheDocument();
  });

  it('blocks incomplete claiming release and creates the QR only after Step 2 is complete', async () => {
    const source: AssistanceRequest = {
      ...request('approved'),
      protectedLetter: {
        id: 'letter-1', version: 1, status: 'confirmed', sourceType: 'pdf', conversionStatus: 'ready', uploaderId: 'worker-1', uploaderName: 'Case Worker One', uploadedAt: '2026-09-16T10:00:00.000Z', reviewedAt: '2026-09-16T10:05:00.000Z', approvedAt: null, qrExpiresAt: null, name: 'letter.pdf',
      },
    };
    const user = userEvent.setup();
    render(<RequestDetailsModal request={source} canProcess onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Release protected letter and mark ready for claiming' }));
    expect(apiMocks.releaseClaimingPreparation).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('claim reference, claiming date, claiming time, claiming location');

    await user.type(screen.getByLabelText('Claim reference'), 'CLAIM-001');
    await user.type(screen.getByLabelText('Claim schedule'), '2026-09-20');
    await user.type(screen.getByLabelText('Claiming time'), '09:30');
    await user.type(screen.getByLabelText('Claiming location'), 'AidLink desk');
    const saved = { ...source, guaranteeLetterTracking: { claimReference: 'CLAIM-001', scheduledFor: '2026-09-20', claimingTime: '09:30', claimingLocation: 'AidLink desk', status: 'scheduled' as const } };
    apiMocks.updateGuaranteeLetterTracking.mockResolvedValue(saved);
    apiMocks.releaseClaimingPreparation.mockResolvedValue({ ...saved, status: 'ready_for_claiming', protectedLetter: { ...source.protectedLetter!, status: 'approved' }, guaranteeLetterTracking: { ...saved.guaranteeLetterTracking!, status: 'ready_for_claiming' }, qrCode: { value: 'protected-token', imageDataUrl: 'data:image/png;base64,qr' } });
    await user.click(screen.getByRole('button', { name: 'Release protected letter and mark ready for claiming' }));

    await waitFor(() => expect(apiMocks.releaseClaimingPreparation).toHaveBeenCalledWith('request-1'));
    expect((await screen.findAllByText('ready for claiming')).length).toBeGreaterThan(0);
    expect(screen.getByAltText('QR code for LINGAP-2026-00001')).toBeInTheDocument();
  });

  it('announces the exact missing decision field for approval and denial', async () => {
    const user = userEvent.setup();
    render(<RequestDetailsModal request={request('under_review')} canProcess onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Approve Request' }));
    const approvalError = screen.getByRole('alert');
    expect(approvalError).toHaveTextContent('Enter decision remarks before approving this request.');
    expect(approvalError).toHaveAttribute('aria-live', 'assertive');
    expect(apiMocks.updateRequestStatus).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Deny Request' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter decision remarks before denying this request.');
  });

  it('evaluates and confirms evidence without approving the request', async () => {
    const user = userEvent.setup();
    apiMocks.evaluateRequestWorkflow.mockResolvedValue({
      evaluationId: 'evaluation-1',
      outcome: 'ready_for_decision',
      findings: [{ code: 'COVERAGE_ELIGIBLE', message: 'Coverage calculation is eligible.' }],
      requiredEvidence: [],
      coverage: { outcome: 'eligible', coveredAmount: 4500, netRemainingBalance: 500, adjustments: [] },
      reasonCodes: ['COVERAGE_ELIGIBLE'],
      policyVersion: { hardDisqualifiers: 'hard-v1', coverageMatrix: 'coverage-v1' },
      humanReviewFlags: [],
      humanReviewRequired: false,
      inputFingerprint: 'fingerprint-1',
    });
    apiMocks.confirmRequestWorkflowEvaluation.mockResolvedValue({ confirmationId: 'confirmation-1' });
    render(<RequestDetailsModal request={request('under_review')} canProcess onClose={vi.fn()} />);

    const remarks = screen.getByLabelText('Correction or decision remarks (required)');
    await user.type(remarks, 'Evidence and coverage reviewed against the current policy.');
    await user.click(screen.getByRole('button', { name: 'Evaluate policy and coverage' }));

    await waitFor(() => expect(apiMocks.evaluateRequestWorkflow).toHaveBeenCalledWith('request-1', 'Evidence and coverage reviewed against the current policy.'));
    expect(await screen.findByText('Coverage calculation is eligible.')).toBeInTheDocument();
    expect(screen.getByText(/hard-v1/)).toBeInTheDocument();
    expect(apiMocks.updateRequestStatus).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText('I reviewed the supporting evidence.'));
    await user.click(screen.getByLabelText('I confirm the displayed coverage calculation.'));
    await user.click(screen.getByRole('button', { name: 'Confirm evidence and coverage' }));

    await waitFor(() => expect(apiMocks.confirmRequestWorkflowEvaluation).toHaveBeenCalledWith('request-1', 'evaluation-1', {
      evidenceReviewed: true,
      coverageConfirmed: true,
      remarks: 'Evidence and coverage reviewed against the current policy.',
    }));
    expect(screen.getByText(/Approval or denial must still be completed/)).toBeInTheDocument();
    expect(apiMocks.updateRequestStatus).not.toHaveBeenCalled();
  });

  it('requires remarks before policy evaluation', async () => {
    const user = userEvent.setup();
    render(<RequestDetailsModal request={request('under_review')} canProcess onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Evaluate policy and coverage' }));

    expect(screen.getByRole('alert')).toHaveTextContent('at least 10 characters');
    expect(apiMocks.evaluateRequestWorkflow).not.toHaveBeenCalled();
  });

  it('keeps entered remarks and shows a visible network or permission failure', async () => {
    const user = userEvent.setup();
    apiMocks.updateRequestStatus.mockRejectedValueOnce(new Error('The server could not be reached. Check your connection and try again.'));
    render(<RequestDetailsModal request={request('under_review')} canProcess onClose={vi.fn()} />);
    const remarks = screen.getByLabelText('Correction or decision remarks (required)');
    await user.type(remarks, 'Review completed with supporting evidence.');
    await user.click(screen.getByRole('button', { name: 'Approve Request' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('server could not be reached');
    expect(remarks).toHaveValue('Review completed with supporting evidence.');

    apiMocks.updateRequestStatus.mockRejectedValueOnce(new Error('You do not have permission to perform this action.'));
    await user.click(screen.getByRole('button', { name: 'Approve Request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('do not have permission');
    expect(remarks).toHaveValue('Review completed with supporting evidence.');
  });

  it('prevents duplicate decision submissions while approval is processing', async () => {
    let resolveApproval!: (value: AssistanceRequest) => void;
    const source = request('under_review');
    apiMocks.updateRequestStatus.mockImplementation(() => new Promise((resolve) => { resolveApproval = resolve; }));
    const user = userEvent.setup();
    render(<RequestDetailsModal request={source} canProcess onClose={vi.fn()} />);
    await user.type(screen.getByLabelText('Correction or decision remarks (required)'), 'Review completed and approved after investigation.');
    const button = screen.getByRole('button', { name: 'Approve Request' });
    button.click();
    button.click();

    expect(apiMocks.updateRequestStatus).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('status')).toHaveTextContent('Saving the approved decision');
    expect(screen.getByRole('button', { name: 'Approving...' })).toBeDisabled();

    resolveApproval({ ...source, status: 'approved' });
    expect(await screen.findByText(/updated to approved/i)).toBeInTheDocument();
  });

  it('rejects an unsupported guarantee-letter upload with an actionable accessible error', async () => {
    const user = userEvent.setup();
    render(<RequestDetailsModal request={request('approved')} canProcess onClose={vi.fn()} />);
    const file = new File(['not a letter'], 'letter.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Upload letter'), { target: { files: [file] } });

    expect(screen.getByRole('alert')).toHaveTextContent('Select a PDF, DOC, or DOCX file');
    expect(apiMocks.uploadGuaranteeLetter).not.toHaveBeenCalled();
  });
});
