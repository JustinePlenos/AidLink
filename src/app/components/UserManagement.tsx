import { useEffect, useRef, useState } from 'react';
import { Search, Mail, Phone, MapPin, Calendar, Eye, RefreshCw, X } from 'lucide-react';
import { getUserRequests, getUsers } from '../api';
import type { AssistanceRequest, User } from '../types';
import { ApplicantVerificationPanel } from './ApplicantVerificationPanel';

export function UserManagement({ canApprove = false }: { canApprove?: boolean }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [userRequests, setUserRequests] = useState<AssistanceRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const requestsInFlightRef = useRef(false);

  const loadUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await getUsers());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load users.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);
  useEffect(() => {
    if (!selectedUser) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedUser(null); };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [selectedUser]);

  const openRequests = async (user: User) => {
    if (requestsInFlightRef.current) return;
    requestsInFlightRef.current = true;
    setSelectedUser(user);
    setRequestsLoading(true);
    setRequestsError(null);
    try {
      setUserRequests(await getUserRequests(user.id));
    } catch (err) {
      setRequestsError(err instanceof Error ? err.message : 'Unable to load requests.');
    } finally {
      requestsInFlightRef.current = false;
      setRequestsLoading(false);
    }
  };

  const filteredUsers = users.filter((user) =>
    user.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    user.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
    user.phone.includes(searchTerm)
  );

  return (
    <div className="space-y-4">
      <ApplicantVerificationPanel canApprove={canApprove} />
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
          <label htmlFor="user-search" className="sr-only">Search users by name, email, or phone number</label>
          <Search aria-hidden="true" className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={20} />
          <input
            id="user-search"
            type="search"
            placeholder="Search by name, email, or phone number..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          </div>
          <button
            type="button"
            onClick={loadUsers}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            <RefreshCw size={17} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3" role="status" aria-label="Loading requestors">{[0,1,2,3,4,5].map((item) => <div key={item} className="surface p-5"><div className="flex gap-3"><div className="skeleton size-11 rounded-full" /><div className="flex-1"><div className="skeleton h-3 w-2/3 rounded" /><div className="skeleton mt-2 h-3 w-1/2 rounded" /></div></div><div className="mt-5 space-y-3"><div className="skeleton h-3 w-full rounded" /><div className="skeleton h-3 w-4/5 rounded" /><div className="skeleton h-3 w-full rounded" /></div><div className="skeleton mt-5 h-9 w-full rounded" /></div>)}</div>
      ) : error ? (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-red-700" role="alert">{error} Please try again or sign in again.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredUsers.map((user) => (
            <div key={user.id} className="bg-white rounded-lg border border-gray-200 p-5 hover:shadow-md transition-shadow">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                  <span className="text-lg text-blue-700">{user.name.charAt(0)}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-base text-gray-900 truncate">{user.name}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">Registered {user.registeredDate}</p>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <Mail size={14} className="text-gray-400 flex-shrink-0" />
                  <span className="truncate">{user.email}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <Phone size={14} className="text-gray-400 flex-shrink-0" />
                  <span>{user.phone}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <MapPin size={14} className="text-gray-400 flex-shrink-0" />
                  <span className="truncate">{user.address}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <Calendar size={14} className="text-gray-400 flex-shrink-0" />
                  <span>{user.dateOfBirth}</span>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-gray-100">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">Applications:</span>
                  <span className="text-gray-900">{user.totalApplications}</span>
                </div>
                <button
                  type="button"
                  onClick={() => openRequests(user)}
                  disabled={requestsLoading}
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700"
                >
                  <Eye size={16} />
                  {requestsLoading && selectedUser?.id === user.id ? 'Loading requests...' : 'View all requests'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {filteredUsers.length === 0 && !loading && !error && (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <p className="font-medium text-gray-700">No requestors found</p>
          <p className="mt-1 text-sm text-gray-500">No profiles match the current search query.</p>
          <button type="button" onClick={() => setSearchTerm('')} className="mt-4 rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">Clear search</button>
        </div>
      )}

      {selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="user-requests-title">
          <div className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-xl bg-white shadow-xl">
            <div className="flex items-start justify-between border-b border-gray-200 p-5">
              <div>
                <h2 id="user-requests-title" className="text-xl text-gray-900">Requests by {selectedUser.name}</h2>
                <p className="mt-1 text-sm text-gray-500">{selectedUser.email} • {userRequests.length} request{userRequests.length === 1 ? '' : 's'}</p>
              </div>
              <button type="button" onClick={() => setSelectedUser(null)} aria-label="Close" className="rounded-lg p-2 hover:bg-gray-100"><X size={20} /></button>
            </div>
            <div className="max-h-[70vh] overflow-auto p-5">
              {requestsLoading ? (
                <p className="text-sm text-gray-600">Loading requests...</p>
              ) : requestsError ? (
                <p role="alert" className="text-sm text-red-700">{requestsError}</p>
              ) : userRequests.length === 0 ? (
                <p className="text-sm text-gray-500">This requestor has not submitted any requests.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                      <tr><th className="px-4 py-3">Request ID</th><th className="px-4 py-3">Patient</th><th className="px-4 py-3">Assistance</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Submitted</th></tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {userRequests.map((request) => (
                        <tr key={request.id}>
                          <td className="whitespace-nowrap px-4 py-3">{request.requestId}</td>
                          <td className="px-4 py-3">{request.applicantName}</td>
                          <td className="px-4 py-3">{request.assistanceType}</td>
                          <td className="px-4 py-3 capitalize">{request.status.replace('_', ' ')}</td>
                          <td className="whitespace-nowrap px-4 py-3">{request.dateSubmitted}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
