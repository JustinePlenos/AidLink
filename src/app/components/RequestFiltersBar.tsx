import { useMemo } from 'react';
import { Filter, RotateCcw } from 'lucide-react';
import type { AssistanceRequest } from '../types';
import { applyRequestFilters, emptyRequestFilters, staleAfterDays, type RequestFilters, type RequestStatus } from '../requestQueues';

const statusOptions: Array<{ value: RequestStatus; label: string }> = [
  { value: 'pending', label: 'New or pending' },
  { value: 'under_review', label: 'Under review' },
  { value: 'correction_requested', label: 'Correction requested' },
  { value: 'approved', label: 'Approved - claiming preparation' },
  { value: 'ready_for_claiming', label: 'Ready for claiming' },
  { value: 'denied', label: 'Denied' },
];

interface RequestFiltersBarProps {
  requests: AssistanceRequest[];
  filters: RequestFilters;
  onChange: (filters: RequestFilters) => void;
  compact?: boolean;
}

export function RequestFiltersBar({ requests, filters, onChange, compact = false }: RequestFiltersBarProps) {
  const assistanceTypes = useMemo(() => [...new Set(requests.map((request) => request.assistanceType))].sort(), [requests]);
  const facilities = useMemo(() => [...new Set(requests.map((request) => request.facilityEvidence?.facilityName || request.assignedFacility?.name).filter((name): name is string => Boolean(name)))].sort((a, b) => a.localeCompare(b)), [requests]);
  const matchingCount = useMemo(() => applyRequestFilters(requests, filters).length, [filters, requests]);
  const hasFilters = Object.values(filters).some(Boolean);
  const update = <K extends keyof RequestFilters>(key: K, value: RequestFilters[K]) => onChange({ ...filters, [key]: value });

  return (
    <section aria-label="Application filters" className={compact ? 'rounded-lg border border-slate-200 bg-white p-4' : 'surface p-4'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2"><Filter size={15} className="text-slate-500" /><h2 className="text-xs font-semibold uppercase tracking-wide text-slate-700">Queue filters</h2></div>
        <span className="font-mono text-[11px] text-slate-500">{matchingCount} of {requests.length} applications</span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div>
          <label htmlFor={`${compact ? 'dashboard-' : ''}date-from`} className="block text-[11px] font-medium text-slate-600">Submitted from</label>
          <input id={`${compact ? 'dashboard-' : ''}date-from`} type="date" value={filters.dateFrom} max={filters.dateTo || undefined} onChange={(event) => update('dateFrom', event.target.value)} className="control mt-1 w-full px-3 py-2 text-xs" />
        </div>
        <div>
          <label htmlFor={`${compact ? 'dashboard-' : ''}date-to`} className="block text-[11px] font-medium text-slate-600">Submitted to</label>
          <input id={`${compact ? 'dashboard-' : ''}date-to`} type="date" value={filters.dateTo} min={filters.dateFrom || undefined} onChange={(event) => update('dateTo', event.target.value)} className="control mt-1 w-full px-3 py-2 text-xs" />
        </div>
        <div>
          <label htmlFor={`${compact ? 'dashboard-' : ''}assistance-type`} className="block text-[11px] font-medium text-slate-600">Assistance type</label>
          <select id={`${compact ? 'dashboard-' : ''}assistance-type`} value={filters.assistanceType} onChange={(event) => update('assistanceType', event.target.value)} className="control mt-1 w-full px-3 py-2 text-xs">
            <option value="">All assistance types</option>
            {assistanceTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${compact ? 'dashboard-' : ''}facility`} className="block text-[11px] font-medium text-slate-600">Receipt facility</label>
          <select id={`${compact ? 'dashboard-' : ''}facility`} value={filters.facilityId} onChange={(event) => update('facilityId', event.target.value)} className="control mt-1 w-full px-3 py-2 text-xs">
            <option value="">All receipt facilities</option>
            <option value="unassigned">No facility evidence</option>
            {facilities.map((facility) => <option key={facility} value={facility}>{facility}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${compact ? 'dashboard-' : ''}status`} className="block text-[11px] font-medium text-slate-600">Status</label>
          <select id={`${compact ? 'dashboard-' : ''}status`} value={filters.status} onChange={(event) => onChange({ ...filters, status: event.target.value as RequestStatus | '', staleOnly: false })} className="control mt-1 w-full px-3 py-2 text-xs">
            <option value="">All statuses</option>
            {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
        <label className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={filters.staleOnly} onChange={(event) => onChange({ ...filters, staleOnly: event.target.checked, status: event.target.checked ? '' : filters.status })} className="size-4 rounded border-slate-300 text-blue-700" />Overdue or stale only <span className="text-[10px] text-slate-400">({staleAfterDays}+ days inactive)</span></label>
        {hasFilters && <button type="button" onClick={() => onChange({ ...emptyRequestFilters })} className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-100"><RotateCcw size={13} />Reset filters</button>}
      </div>
    </section>
  );
}
