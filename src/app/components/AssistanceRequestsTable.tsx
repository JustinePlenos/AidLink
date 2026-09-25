import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Eye, FileSearch, RefreshCw, Search } from 'lucide-react';
import { RequestDetailsModal } from './RequestDetailsModal';
import { RequestFiltersBar } from './RequestFiltersBar';
import { applyRequestFilters, type RequestFilters } from '../requestQueues';
import type { AssistanceRequest } from '../types';

type Status = AssistanceRequest['status'];
type SortKey = 'requestId' | 'applicantName' | 'assistanceType' | 'dateSubmitted';
const statusStyle: Record<Status, string> = { pending: 'border-slate-200 bg-slate-100 text-slate-700', under_review: 'border-blue-200 bg-blue-50 text-blue-700', correction_requested: 'border-amber-200 bg-amber-50 text-amber-700', approved: 'border-violet-200 bg-violet-50 text-violet-700', ready_for_claiming: 'border-emerald-200 bg-emerald-50 text-emerald-700', denied: 'border-red-200 bg-red-50 text-red-700' };

interface AssistanceRequestsTableProps {
  requests: AssistanceRequest[];
  loading: boolean;
  error: string | null;
  filters: RequestFilters;
  canProcess: boolean;
  onFiltersChange: (filters: RequestFilters) => void;
  onRefresh: () => void;
  onRequestUpdated: (request: AssistanceRequest) => void;
}

export function AssistanceRequestsTable({ requests, loading, error, filters, canProcess, onFiltersChange, onRefresh, onRequestUpdated }: AssistanceRequestsTableProps) {
  const [selectedRequest, setSelectedRequest] = useState<AssistanceRequest | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'dateSubmitted', direction: 'desc' });
  const pageSize = 10;

  const filteredRequests = useMemo(() => applyRequestFilters(requests, filters).filter((request) => {
    const query = searchTerm.trim().toLowerCase();
    return !query || [request.applicantName, request.requester?.fullName || '', request.requestId, request.assistanceType, request.requester?.email || request.email].some((value) => value.toLowerCase().includes(query));
  }).sort((a, b) => {
    const first = sort.key === 'dateSubmitted' ? new Date(a[sort.key]).getTime() : a[sort.key].toLowerCase();
    const second = sort.key === 'dateSubmitted' ? new Date(b[sort.key]).getTime() : b[sort.key].toLowerCase();
    return (first < second ? -1 : first > second ? 1 : 0) * (sort.direction === 'asc' ? 1 : -1);
  }), [filters, requests, searchTerm, sort]);
  const pageCount = Math.max(1, Math.ceil(filteredRequests.length / pageSize));
  const visibleRequests = filteredRequests.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => { setPage(1); }, [filters, searchTerm]);
  useEffect(() => { setPage((current) => Math.min(current, pageCount)); }, [pageCount]);

  const changeSort = (key: SortKey) => setSort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
  const SortIcon = ({ column }: { column: SortKey }) => sort.key !== column ? <ArrowUpDown size={12} /> : sort.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />;
  const handleRequestUpdate = (updated: AssistanceRequest) => { onRequestUpdated(updated); setSelectedRequest(updated); };

  return <div className="space-y-4">
    <RequestFiltersBar requests={requests} filters={filters} onChange={onFiltersChange} />

    <section aria-label="Search and refresh requests" className="surface p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1"><label htmlFor="request-search" className="sr-only">Search assistance requests</label><Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} /><input id="request-search" type="search" placeholder="Search ID, requester, beneficiary, email, or assistance type" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} className="control w-full py-2 pl-9 pr-3 text-sm" /></div>
        <button type="button" onClick={onRefresh} disabled={loading} className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Refresh data</button>
      </div>
    </section>

    <section className="surface overflow-hidden" aria-labelledby="requests-table-title">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3"><div><h2 id="requests-table-title" className="text-sm font-semibold text-slate-900">Request queue</h2><p className="mt-0.5 text-[11px] text-slate-500"><span className="font-mono">{filteredRequests.length}</span> matching records - sorted by {sort.key === 'dateSubmitted' ? 'submitted date' : sort.key}</p></div><span className="hidden rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[10px] text-slate-500 sm:block">PAGE SIZE {pageSize}</span></header>
      <div className="overflow-x-auto"><table className="w-full min-w-[950px] text-left"><caption className="sr-only">Assistance request review queue using the dashboard filters</caption><thead className="border-b border-slate-200 bg-slate-50"><tr>
        {([['requestId', 'Request ID'], ['applicantName', 'Beneficiary'], ['assistanceType', 'Assistance type']] as Array<[SortKey, string]>).map(([key, label]) => <th key={key} scope="col" className="px-4 py-2.5"><button type="button" onClick={() => changeSort(key)} className="inline-flex min-h-7 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-800">{label}<SortIcon column={key} /></button></th>)}
        <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Receipt facility</th><th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Status</th><th className="px-4 py-2.5"><button type="button" onClick={() => changeSort('dateSubmitted')} className="inline-flex min-h-7 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-800">Submitted<SortIcon column="dateSubmitted" /></button></th><th className="px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wider text-slate-500">Action</th>
      </tr></thead><tbody className="divide-y divide-slate-100">
        {loading ? [0, 1, 2, 3, 4, 5].map((row) => <tr key={row}>{[0, 1, 2, 3, 4, 5, 6].map((cell) => <td key={cell} className="px-4 py-4"><div className={`skeleton h-3 rounded ${cell === 1 ? 'w-40' : 'w-24'}`} /></td>)}</tr>) : visibleRequests.map((request) => <tr key={request.id} className="group hover:bg-slate-50/80"><td className="whitespace-nowrap px-4 py-3"><code className="text-xs font-semibold text-blue-700">{request.requestId}</code></td><td className="px-4 py-3"><div className="text-xs font-medium text-slate-800">{request.applicantName}</div><div className="mt-0.5 max-w-52 truncate text-[11px] text-slate-500">{request.email}</div></td><td className="whitespace-nowrap px-4 py-3 text-xs text-slate-700">{request.assistanceType}</td><td className="max-w-40 truncate px-4 py-3 text-xs text-slate-600">{request.facilityEvidence?.facilityName || (request.assignedFacility ? request.assignedFacility.name + ' (legacy)' : 'Not provided')}</td><td className="whitespace-nowrap px-4 py-3"><span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize ${statusStyle[request.status]}`}>{request.status.replaceAll('_', ' ')}</span></td><td className="whitespace-nowrap px-4 py-3"><time dateTime={request.dateSubmitted} className="font-mono text-[11px] text-slate-500">{new Date(request.dateSubmitted).toLocaleString('en-PH', { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></td><td className="px-4 py-3 text-right"><button type="button" onClick={() => setSelectedRequest(request)} className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 shadow-sm hover:border-blue-300 hover:text-blue-700"><Eye size={14} />{canProcess ? 'Review' : 'View'}</button></td></tr>)}
      </tbody></table></div>
      {error && <div role="alert" className="border-t border-slate-200 px-6 py-12 text-center"><FileSearch className="mx-auto text-red-400" size={28} /><h3 className="mt-3 text-sm font-medium text-slate-800">Request queue unavailable</h3><p className="mx-auto mt-1 max-w-md text-xs text-slate-500">{error}</p><button type="button" onClick={onRefresh} className="mt-4 rounded-md bg-blue-700 px-3 py-2 text-xs font-medium text-white hover:bg-blue-800">Retry connection</button></div>}
      {!loading && !error && !filteredRequests.length && <div className="border-t border-slate-200 px-6 py-12 text-center"><FileSearch className="mx-auto text-slate-300" size={28} /><h3 className="mt-3 text-sm font-medium text-slate-800">No results found</h3><p className="mt-1 text-xs text-slate-500">No requests match the current dashboard filters and search.</p></div>}
      {!loading && !error && filteredRequests.length > 0 && <footer className="flex items-center justify-between border-t border-slate-200 bg-slate-50/60 px-4 py-2.5 text-[11px] text-slate-500"><span>Showing <b className="font-mono font-medium text-slate-700">{(page - 1) * pageSize + 1}-{Math.min(page * pageSize, filteredRequests.length)}</b> of <b className="font-mono font-medium text-slate-700">{filteredRequests.length}</b></span><div className="flex gap-2"><button type="button" disabled={page === 1} onClick={() => setPage((value) => value - 1)} className="min-h-8 rounded-md border border-slate-300 bg-white px-3 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40">Previous</button><button type="button" disabled={page === pageCount} onClick={() => setPage((value) => value + 1)} className="min-h-8 rounded-md border border-slate-300 bg-white px-3 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40">Next</button></div></footer>}
    </section>
    {selectedRequest && <RequestDetailsModal request={selectedRequest} canProcess={canProcess} onClose={() => setSelectedRequest(null)} onStatusUpdated={handleRequestUpdate} />}
  </div>;
}
