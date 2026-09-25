import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, getProtectedDocumentObjectUrl, ProtectedDocumentAccessError, updateRequestStatus } from './api';

describe('protected API action errors', () => {
  beforeEach(() => {
    window.localStorage.setItem('aidlink_admin_token', 'test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('turns network failures into plain actionable feedback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch internal host')));
    await expect(updateRequestStatus('request-1', 'approved', 'Approved after review.')).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 0,
      message: 'AidLink could not be reached. Check your connection and try again.',
    });
  });

  it('uses a permission message without exposing server implementation details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ message: 'SQL policy requests:process failed in middleware.js:88' }) }));
    await expect(updateRequestStatus('request-1', 'denied', 'Not eligible.')).rejects.toEqual(expect.objectContaining({
      message: 'You do not have permission to perform this action.',
      status: 403,
    }));
  });

  it('announces an expired session and sanitizes server failures', async () => {
    const expired = vi.fn();
    window.addEventListener('aidlink:session-expired', expired);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ message: 'jwt malformed at auth.js:10' }) }));
    await expect(updateRequestStatus('request-1', 'approved', 'Approved.')).rejects.toBeInstanceOf(ApiRequestError);
    expect(expired).toHaveBeenCalledTimes(1);
    window.removeEventListener('aidlink:session-expired', expired);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ message: 'ENOENT C:\\private\\secrets.json' }) }));
    await expect(updateRequestStatus('request-1', 'approved', 'Approved.')).rejects.toMatchObject({
      message: 'AidLink could not complete this action. Try again in a moment.',
      status: 500,
    });
  });

  it('routes legacy uploaded-file URLs through the trusted API origin with authentication', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ message: 'Document not found.' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getProtectedDocumentObjectUrl('http://localhost:5000/uploads/example.jpg'))
      .rejects.toBeInstanceOf(ProtectedDocumentAccessError);

    const [target, init] = fetchMock.mock.calls[0];
    const requestedUrl = new URL(String(target));
    expect(requestedUrl.origin).toBe(window.location.origin);
    expect(requestedUrl.pathname).toBe('/uploads/example.jpg');
    expect(init.headers).toEqual({ Authorization: 'Bearer test-token' });
  });

  it('does not expire the portal session for a rejected untrusted document URL', async () => {
    const expired = vi.fn();
    window.addEventListener('aidlink:session-expired', expired);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Unauthorized' }),
    }));

    await expect(getProtectedDocumentObjectUrl('https://files.example.test/example.jpg'))
      .rejects.toBeInstanceOf(ProtectedDocumentAccessError);
    expect(expired).not.toHaveBeenCalled();
    window.removeEventListener('aidlink:session-expired', expired);
  });
});
