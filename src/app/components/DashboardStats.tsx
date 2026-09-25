import { useMemo } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, FileCheck2, FileText, RefreshCw, RotateCcw, XCircle } from 'lucide-react';
import type { AssistanceRequest } from '../types';
import { applyRequestFilters, queueDefinitions, requestsInQueue, type RequestFilters, type RequestQueueKey } from '../requestQueues';
import { RequestFiltersBar } from './RequestFiltersBar';

const statusStyle: Record<AssistanceRequest['status'], string> = {
  pending: 'border-slate-200 bg-slate-100 text-slate-700',
  under_review: 'border-blue-200 bg-blue-50 text-blue-700',
  correction_requested: 'border-amber-200 bg-amber-50 text-amber-700',
  approved: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  ready_for_claiming: 'border-teal-200 bg-teal-50 text-teal-700',
  denied: 'border-red-200 bg-red-50 text-red-700',
};

const queuePresentation: Record<RequestQueueKey, { icon: typeof FileText; tone: string; count: string }> = {
  pending: { icon: Clock3, tone: 'border-slate-200 hover:border-slate-300', count: 'text-slate-900' },
  under_review: { icon: FileCheck2, tone: 'border-blue-200 hover:border-blue-300', count: 'text-blue-800' },
  correction_requested: { icon: RotateCcw, tone: 'border-amber-200 hover:border-amber-300', count: 'text-amber-800' },
  approved: { icon: CheckCircle2, tone: 'border-emerald-200 hover:border-emerald-300', count: 'text-emerald-800' },
  ready_for_claiming: { icon: CheckCircle2, tone: 'border-teal-200 hover:border-teal-300', count: 'text-teal-800' },
  denied: { icon: XCircle, tone: 'border-red-200 hover:border-red-300', count: 'text-red-800' },
  stale: { icon: AlertTriangle, tone: 'border-orange-200 hover:border-orange-300', count: 'text-orange-800' },
};

interface DashboardStatsProps {
  requests: AssistanceRequest[];
  loading: boolean;
  error: string | null;
  filters: RequestFilters;
  canProcess: boolean;
  onFiltersChange: (filters: RequestFilters) => void;
  onRefresh: () => void;
  onOpenRequests: () => void;
  onOpenQueue: (queue: RequestQueueKey) => void;
}

export function DashboardStats({ requests, loading, error, filters, canProcess, onFiltersChange, onRefresh, onOpenRequests, onOpenQueue }: DashboardStatsProps) {
  const filteredRequests = useMemo(() => applyRequestFilters(requests, filters), [filters, requests]);
  const newestRequests = useMemo(() => [...filteredRequests].sort((a, b) => new Date(b.dateSubmitted).getTime() - new Date(a.dateSubmitted).getTime()).slice(0, 6), [filteredRequests]);
  const types = useMemo(() => Object.entries(filteredRequests.reduce<Record<string, number>>((result, request) => {
    result[request.assistanceType] = (result[request.assistanceType] || 0) + 1;
    return result;
  }, {})).sort((a, b) => b[1] - a[1]), [filteredRequests]);

  if (loading) return (
    <div aria-label="Loading application queues" role="status" className="space-y-5">
      <div className="skeleton h-40 rounded-lg" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((item) => <div key={item} className="surface p-5"><div className="skeleton h-3 w-32 rounded" /><div className="skeleton mt-4 h-8 w-16 rounded" /><div className="skeleton mt-3 h-3 w-40 rounded" /></div>)}</div>
    </div>
  );

  if (error) return <div role="alert" className="surface flex flex-col items-center px-6 py-16 text-center"><span className="grid size-11 place-items-center rounded-lg bg-red-50 text-red-600"><AlertTriangle size={22} /></span><h2 className="mt-4 text-base text-slate-900">Application queues are unavailable</h2><p className="mt-1 max-w-md text-sm text-slate-500">{error}</p><button type="button" onClick={onRefresh} className="mt-5 inline-flex min-h-9 items-center gap-2 rounded-md bg-blue-700 px-4 text-sm font-medium text-white hover:bg-blue-800"><RefreshCw size={15} />Try again</button></div>;

  return (
    <div className="space-y-5">
      <RequestFiltersBar requests={requests} filters={filters} onChange={onFiltersChange} compact />

      <section aria-labelledby="work-queues-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2"><div><h2 id="work-queues-heading" className="text-sm font-semibold text-slate-900">Application work queues</h2><p className="mt-0.5 text-xs text-slate-500">Counts use the filters above. Stale applications can also appear in their current status queue.</p></div><button type="button" onClick={onOpenRequests} className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-blue-700 hover:bg-blue-50">Open all matching <ArrowRight size={14} /></button></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {queueDefinitions.map((queue) => {
            const presentation = queuePresentation[queue.key];
            const Icon = presentation.icon;
            const count = requestsInQueue(filteredRequests, queue.key).length;
            return <button key={queue.key} type="button" onClick={() => onOpenQueue(queue.key)} className={`surface flex min-h-28 items-start gap-4 border p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md ${presentation.tone}`}><span className="grid size-10 shrink-0 place-items-center rounded-lg bg-slate-50 text-slate-600"><Icon size={20} /></span><span className="min-w-0 flex-1"><span className="block text-xs font-semibold text-slate-700">{queue.label}</span><span className={`mt-1 block font-mono text-2xl font-semibold ${presentation.count}`}>{count.toLocaleString()}</span><span className="mt-1 block text-[11px] text-slate-500">{queue.description} - {canProcess ? 'Open work queue' : 'View queue'}</span></span><ArrowRight size={15} className="mt-1 shrink-0 text-slate-400" /></button>;
          })}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,1fr)]">
        <section aria-labelledby="newest-heading" className="surface overflow-hidden">
          <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5"><div><h2 id="newest-heading" className="text-sm font-semibold text-slate-900">Newest applications</h2><p className="mt-0.5 text-xs text-slate-500">Most recent submissions matching the active filters</p></div><button type="button" onClick={onOpenRequests} className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-blue-700 hover:bg-blue-50">View table <ArrowRight size={14} /></button></header>
          {newestRequests.length ? <div className="divide-y divide-slate-100">{newestRequests.map((request) => <button type="button" onClick={onOpenRequests} key={request.id} className="grid min-h-[61px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-5 text-left hover:bg-slate-50 sm:grid-cols-[115px_minmax(0,1fr)_140px_auto]"><code className="hidden truncate text-[11px] font-medium text-slate-500 sm:block">{request.requestId}</code><span className="min-w-0"><span className="block truncate text-sm font-medium text-slate-800">{request.applicantName}</span><span className="block truncate text-[11px] text-slate-500">{request.assistanceType}</span></span><time className="hidden text-[11px] text-slate-500 sm:block">{new Date(request.dateSubmitted).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}</time><span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize ${statusStyle[request.status]}`}>{request.status.replaceAll('_', ' ')}</span></button>)}</div> : <div className="px-6 py-14 text-center"><FileText className="mx-auto text-slate-300" size={28} /><h3 className="mt-3 text-sm font-medium text-slate-700">No matching applications</h3><p className="mt-1 text-xs text-slate-500">Adjust the filters to see more records.</p></div>}
        </section>

        <section aria-labelledby="analytics-heading" className="surface p-5">
          <div><h2 id="analytics-heading" className="text-sm font-semibold text-slate-900">Applications by assistance type</h2><p className="mt-0.5 text-xs text-slate-500">Based on the {filteredRequests.length} matching applications</p></div>
          {types.length ? <ul className="mt-6 space-y-4">{types.map(([type, count]) => { const percentage = filteredRequests.length ? Math.round((count / filteredRequests.length) * 100) : 0; return <li key={type}><div className="mb-1.5 flex items-center justify-between gap-3"><span className="truncate text-xs font-medium text-slate-700">{type}</span><span className="font-mono text-[11px] text-slate-500">{count} - {percentage}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-blue-600" style={{ width: `${percentage}%` }} /></div></li>; })}</ul> : <div className="py-12 text-center text-xs text-slate-500">No analytics are available for the active filters.</div>}
        </section>
      </div>
    </div>
  );
}
