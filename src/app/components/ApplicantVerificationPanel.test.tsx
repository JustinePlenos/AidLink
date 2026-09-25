import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicantVerificationPanel } from './ApplicantVerificationPanel';

vi.mock('../utils/toast', () => ({
  showToast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const identityDocumentUrl = 'http://localhost:5000/api/applicant-verifications/applicant-1/document';
const identityDocumentPath = '/api/applicant-verifications/applicant-1/document';
const applicant = {
  id: 'applicant-1',
  fullName: 'Verified Applicant',
  email: 'applicant@example.com',
  phone: '09170000000',
  registeredDate: '2026-09-16T00:00:00.000Z',
  accountStatus: 'basic',
  verificationStatus: 'pending',
  identityVerification: {
    status: 'pending',
    document: {
      id: 'identity-1',
      name: 'government-id.pdf',
      url: identityDocumentUrl,
      mimeType: 'application/pdf',
      sizeBytes: 100,
      uploadedAt: '2026-09-16T00:00:00.000Z',
      analysis: { accepted: true, analyzerVersion: 'deterministic-v1', warnings: [] },
    },
    decision: null,
    auditNotes: [],
  },
};

type DocumentReply = { status: number; body?: { code?: string; message?: string }; networkError?: boolean };

function response(status: number, body: unknown, blob?: Blob) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => blob ?? new Blob(['identity'], { type: 'application/pdf' }),
  } as Response;
}

function mockRequests(documentReply: DocumentReply = { status: 200 }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith('/api/applicant-verifications')) return response(200, [applicant]);
    if (new URL(url).pathname === identityDocumentPath) {
      if (documentReply.networkError) throw new TypeError('Network unavailable');
      return response(documentReply.status, documentReply.body ?? {});
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe('ApplicantVerificationPanel protected identity proof', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('aidlink_admin_token', 'admin-session-token');
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:identity-proof');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens, previews, and closes identity proof without losing the administrator session', async () => {
    const fetchMock = mockRequests();
    const sessionExpired = vi.fn();
    window.addEventListener('aidlink:session-expired', sessionExpired);
    const user = userEvent.setup();

    render(<ApplicantVerificationPanel canApprove />);
    await user.click(await screen.findByRole('button', { name: 'Open identity proof' }));

    const dialog = await screen.findByRole('dialog', { name: 'Identity proof' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTitle('government-id.pdf')).toHaveAttribute('src', 'blob:identity-proof');
    expect(window.localStorage.getItem('aidlink_admin_token')).toBe('admin-session-token');
    expect(sessionExpired).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({ href: `${window.location.origin}${identityDocumentPath}` }), expect.objectContaining({
      headers: { Authorization: 'Bearer admin-session-token' },
      cache: 'no-store',
    }));

    await user.click(screen.getByRole('button', { name: 'Close identity proof' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:identity-proof');
    expect(window.localStorage.getItem('aidlink_admin_token')).toBe('admin-session-token');
    window.removeEventListener('aidlink:session-expired', sessionExpired);
  });

  it('reports an expired document session in place without silently logging out', async () => {
    mockRequests({ status: 401, body: { code: 'SESSION_EXPIRED', message: 'Your administrator session has expired. Sign in again, then reopen the identity proof.' } });
    const sessionExpired = vi.fn();
    window.addEventListener('aidlink:session-expired', sessionExpired);
    const user = userEvent.setup();

    render(<ApplicantVerificationPanel canApprove />);
    await user.click(await screen.findByRole('button', { name: 'Open identity proof' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Session expired');
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in again');
    expect(window.localStorage.getItem('aidlink_admin_token')).toBe('admin-session-token');
    expect(sessionExpired).not.toHaveBeenCalled();
    window.removeEventListener('aidlink:session-expired', sessionExpired);
  });

  it.each([
    [403, 'Unauthorized', 'System Administrator'],
    [404, 'File missing', 'upload it again'],
    [503, 'Service unavailable', 'temporarily unavailable'],
  ])('shows an actionable error for status %s', async (status, label, guidance) => {
    const messages: Record<number, string> = {
      403: 'You are not authorized to open this identity proof. A System Administrator account is required.',
      404: 'The identity-proof file is missing. Ask the applicant to upload it again.',
      503: 'The identity proof is temporarily unavailable. Try again or contact a System Administrator.',
    };
    mockRequests({ status, body: { message: messages[status] } });
    const user = userEvent.setup();

    render(<ApplicantVerificationPanel canApprove />);
    await user.click(await screen.findByRole('button', { name: 'Open identity proof' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(label);
    expect(alert).toHaveTextContent(guidance);
    expect(screen.getByRole('button', { name: 'Try opening again' })).toBeInTheDocument();
  });

  it('shows a clear unavailable error when the protected file service cannot be reached', async () => {
    mockRequests({ status: 0, networkError: true });
    const user = userEvent.setup();
    render(<ApplicantVerificationPanel canApprove />);
    await user.click(await screen.findByRole('button', { name: 'Open identity proof' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Service unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent('Check your connection');
  });

  it('does not offer protected file access to a Case Worker', async () => {
    const fetchMock = mockRequests();
    render(<ApplicantVerificationPanel canApprove={false} />);
    await screen.findByText('government-id.pdf');
    expect(screen.queryByRole('button', { name: 'Open identity proof' })).not.toBeInTheDocument();
    expect(screen.getByText('Only a System Administrator can open this file.')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
