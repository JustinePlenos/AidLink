import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Download, FileBarChart, Filter, RefreshCw, Search, ShieldCheck, Timer, Users } from 'lucide-react';
import { exportSystemReport, generateSystemReport, getActionErrorMessage, getSystemAuditLogs, type ReportParameters, type SystemAuditEntry, type SystemReport } from '../api';
import { showToast } from '../utils/toast';
import { ActionFeedback, type ActionFeedbackState } from './ActionFeedback';

function humanize(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function detailsText(details: Record<string, unknown>) {
  const entries = Object.entries(details || {});
  if (!entries.length) return 'No additional details';
  return entries.map(([key, value]) => {
    const displayed = value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? 'Not recorded');
    return `${humanize(key)}: ${displayed}`;
  }).join(' | ');
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function displayParameters(parameters: ReportParameters) {
  const selected = Object.entries(parameters).filter(([, value]) => value);
  return selected.length ? selected.map(([key, value]) => `${humanize(key)}: ${value}`).join(' · ') : 'All applications and activity';
}

const emptyFilters: ReportParameters = { dateFrom: '', dateTo: '', status: '', assistanceType: '', facility: '' };

export function SystemActivity() {
  const [report, setReport] = useState<SystemReport | null>(null);
  const [logs, setLogs] = useState<SystemAuditEntry[]>([]);
  const [filters, setFilters] = useState<ReportParameters>(emptyFilters);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<'' | 'csv' | 'pdf'>('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [eventGroup, setEventGroup] = useState('');
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const inFlightRef = useRef(false);

  const load = async (parameters: ReportParameters = filters) => {
    if (parameters.dateFrom && parameters.dateTo && parameters.dateFrom > parameters.dateTo) { const message = 'From date must be on or before the To date.'; setError(message); setFeedback({ kind: 'error', message }); return; }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    setError('');
    setFeedback({ kind: 'loading', message: 'Generating report...' });
    try {
      const [nextReport, nextLogs] = await Promise.all([generateSystemReport(parameters), getSystemAuditLogs()]);
      setReport(nextReport);
      setLogs(nextLogs);
      setFeedback({ kind: 'success', message: 'Report generated.' });
    } catch (err) {
      const message = getActionErrorMessage(err, 'Unable to load administrator reports.');
      setError(message);
      setFeedback({ kind: 'error', message });
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  };

  useEffect(() => { void load(emptyFilters); }, []);

  const downloadReport = async (format: 'csv' | 'pdf') => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setExporting(format);
    setFeedback({ kind: 'loading', message: `Preparing the ${format.toUpperCase()} report export...` });
    try {
      const exported = await exportSystemReport(format, filters);
      downloadBlob(exported.blob, exported.fileName);
      setLogs(await getSystemAuditLogs());
      showToast.success(`${format.toUpperCase()} report downloaded.`);
      setFeedback({ kind: 'success', message: `${format.toUpperCase()} report downloaded.` });
    } catch (err) {
      const message = getActionErrorMessage(err, 'Unable to export the system report.');
      setFeedback({ kind: 'error', message });
      showToast.error(message);
    } finally {
      inFlightRef.current = false;
      setExporting('');
    }
  };

  const actions = useMemo(() => [...new Set(logs.map((entry) => entry.action))].sort(), [logs]);
  const visibleLogs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return logs.filter((entry) => {
      if (actionFilter && entry.action !== actionFilter) return false;
      if (eventGroup) {
        const groups: Record<string, RegExp> = {
          evaluation: /evaluat/i, override: /override|exception/i, tariff: /tariff|coverage_matrix/i,
          threshold: /threshold/i, budget: /budget|allocation/i, deduction: /deduction|payer/i,
          guarantee_letter: /guarantee_letter.*(expir|releas)|letter_expir/i,
        };
        if (!groups[eventGroup]?.test(entry.action)) return false;
      }
      if (!normalizedQuery) return true;
      return [entry.action, entry.actor.name, entry.actor.email || '', entry.actor.role, entry.affectedRecord.type, entry.affectedRecord.label, detailsText(entry.details)]
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [actionFilter, eventGroup, logs, query]);

  if (loading && !report) return <div role="status" className="surface p-12 text-center text-sm text-slate-500">Generating reports...</div>;
  if (error && !report) return <div role="alert" className="surface p-8 text-sm text-red-700">{error}<button type="button" onClick={() => load()} className="ml-2 underline">Retry</button></div>;

  const metrics = [
    { label: 'Filtered applications', value: report?.totalRequests ?? 0, icon: FileBarChart },
    { label: 'Approval rate', value: `${report?.outcomes.approvalRate ?? 0}%`, icon: ShieldCheck },
    { label: 'Denial rate', value: `${report?.outcomes.denialRate ?? 0}%`, icon: Activity },
    { label: 'Correction rate', value: `${report?.outcomes.correctionRate ?? 0}%`, icon: RefreshCw },
    { label: 'Avg. processing', value: report?.outcomes.averageProcessingTimeHours == null ? 'N/A' : `${report.outcomes.averageProcessingTimeHours}h`, icon: Timer },
    { label: 'Active staff', value: report?.activeUsers.activeStaff ?? 0, icon: Users },
  ];

  return (
    <div className="space-y-4">
      <ActionFeedback feedback={feedback} />
      <section className="surface p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div><h2 className="text-base font-semibold text-slate-900">Reports</h2><p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">Review application outcomes, processing time, facility workload, document issues, users, and staff activity.</p></div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => load()} disabled={loading || Boolean(exporting)} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-slate-300 px-3 text-xs font-medium disabled:opacity-60"><RefreshCw size={15} />{loading ? 'Refreshing...' : 'Refresh'}</button>
            <button type="button" onClick={() => downloadReport('csv')} disabled={loading || Boolean(exporting)} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-blue-700 px-3 text-xs font-semibold text-blue-700 disabled:opacity-60"><Download size={15} />{exporting === 'csv' ? 'Exporting CSV...' : 'CSV'}</button>
            <button type="button" onClick={() => downloadReport('pdf')} disabled={loading || Boolean(exporting)} className="inline-flex min-h-9 items-center gap-2 rounded-md bg-blue-700 px-3 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-60"><Download size={15} />{exporting === 'pdf' ? 'Exporting PDF...' : 'PDF'}</button>
          </div>
        </div>

        <form className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4" onSubmit={(event) => { event.preventDefault(); void load(); }}>
          <div className="mb-3 flex items-center gap-2"><Filter size={16} className="text-blue-700" /><h3 className="text-sm font-semibold text-slate-800">Report parameters</h3></div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <label className="text-xs font-medium text-slate-600">From date<input type="date" value={filters.dateFrom || ''} onChange={(event) => setFilters((current) => ({ ...current, dateFrom: event.target.value }))} className="control mt-1 min-h-9 w-full px-3 text-xs" /></label>
            <label className="text-xs font-medium text-slate-600">To date<input type="date" value={filters.dateTo || ''} onChange={(event) => setFilters((current) => ({ ...current, dateTo: event.target.value }))} className="control mt-1 min-h-9 w-full px-3 text-xs" /></label>
            <label className="text-xs font-medium text-slate-600">Status<select value={filters.status || ''} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))} className="control mt-1 min-h-9 w-full px-3 text-xs"><option value="">All statuses</option>{report?.availableFilters.statuses.map((status) => <option key={status} value={status}>{humanize(status)}</option>)}</select></label>
            <label className="text-xs font-medium text-slate-600">Assistance type<select value={filters.assistanceType || ''} onChange={(event) => setFilters((current) => ({ ...current, assistanceType: event.target.value }))} className="control mt-1 min-h-9 w-full px-3 text-xs"><option value="">All types</option>{report?.availableFilters.assistanceTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
            <label className="text-xs font-medium text-slate-600">Receipt facility<select value={filters.facility || ''} onChange={(event) => setFilters((current) => ({ ...current, facility: event.target.value }))} className="control mt-1 min-h-9 w-full px-3 text-xs"><option value="">All facilities</option>{report?.availableFilters.facilities.map((facility) => <option key={facility} value={facility}>{facility}</option>)}</select></label>
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-2"><button type="button" onClick={() => { setFilters(emptyFilters); void load(emptyFilters); }} className="min-h-9 rounded-md border border-slate-300 px-3 text-xs font-medium">Clear</button><button type="submit" disabled={loading} className="min-h-9 rounded-md bg-slate-900 px-4 text-xs font-semibold text-white disabled:opacity-60">{loading ? 'Generating...' : 'Apply filters'}</button></div>
          {error ? <p role="alert" className="mt-3 text-xs text-red-700">{error}</p> : null}
        </form>

        <div className="mt-4 rounded-md bg-blue-50 px-4 py-3 text-xs text-blue-900"><p><span className="font-semibold">Generated:</span> {report?.generatedAt ? new Date(report.generatedAt).toLocaleString() : 'Not generated'}</p><p className="mt-1"><span className="font-semibold">Parameters:</span> {report ? displayParameters(report.parameters) : 'None'}</p></div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {metrics.map((metric) => { const Icon = metric.icon; return <article key={metric.label} className="rounded-lg border border-slate-200 bg-white p-4"><Icon size={18} className="text-blue-700" /><p className="mt-3 text-xl font-semibold text-slate-900">{metric.value}</p><p className="text-xs text-slate-500">{metric.label}</p></article>; })}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <ReportList title="Applications by date" empty="No applications in this period." rows={(report?.applicationsByDate || []).map((row) => [row.date, row.count])} />
        <ReportList title="Applications by assistance type" empty="No assistance types in this result." rows={(report?.applicationsByAssistanceType || []).map((row) => [row.assistanceType, row.count])} />
        <ReportList title="Applications by status" empty="No statuses in this result." rows={(report?.applicationsByStatus || []).map((row) => [humanize(row.status), row.count])} />
      </section>

      <section className="surface overflow-hidden">
        <header className="border-b border-slate-200 p-4"><h2 className="text-sm font-semibold text-slate-900">Facility workload</h2><p className="mt-1 text-xs text-slate-500">Facilities are identified from applicant receipt or billing evidence. Legacy assignments are shown only for historical records.</p></header>
        <div className="overflow-auto"><table className="w-full min-w-[850px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Facility</th><th className="px-4 py-3">Total</th><th className="px-4 py-3">Pending</th><th className="px-4 py-3">Under review</th><th className="px-4 py-3">Correction</th><th className="px-4 py-3">Approved</th><th className="px-4 py-3">Denied</th></tr></thead><tbody className="divide-y divide-slate-100">{report?.facilityWorkload.length ? report.facilityWorkload.map((row) => <tr key={row.facility}><td className="px-4 py-3 font-medium text-slate-800">{row.facility}</td><td className="px-4 py-3">{row.total}</td><td className="px-4 py-3">{row.pending}</td><td className="px-4 py-3">{row.underReview}</td><td className="px-4 py-3">{row.correctionRequested}</td><td className="px-4 py-3">{row.approved}</td><td className="px-4 py-3">{row.denied}</td></tr>) : <tr><td colSpan={7} className="p-8 text-center text-sm text-slate-500">No facility workload matches these parameters.</td></tr>}</tbody></table></div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <ReportList title="Document failure reasons" empty="No stored quality failures match these parameters." rows={(report?.documentFailureReasons || []).map((row) => [`${row.label} (${row.code})`, row.count])} />
        <ReportList title="Active users" empty="No user totals are available." rows={report ? [['Applicants in result', report.activeUsers.activeApplicants], ['Registered applicants', report.activeUsers.totalApplicants], ['Verified applicants', report.activeUsers.verifiedApplicants], ['Active staff', report.activeUsers.activeStaff]] : []} />
        <ReportList title="Staff activity" empty="No staff activity in this period." rows={(report?.staffActivity || []).map((row) => [`${row.name} · ${row.role}`, row.eventCount])} />
        <ReportList title="Audit activity" empty="No audit activity in this period." rows={(report?.auditActivity.byAction || []).map((row) => [humanize(row.action), row.count])} />
      </section>

      <section className="surface overflow-hidden">
        <header className="border-b border-slate-200 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-2"><Activity size={18} className="text-blue-700" /><div><h2 className="text-sm font-semibold text-slate-900">Administrator activity ledger</h2><p className="text-xs text-slate-500">{visibleLogs.length} of {logs.length} records, newest first</p></div></div>
            <div className="flex flex-col gap-2 sm:flex-row"><div className="relative"><label htmlFor="activity-search" className="sr-only">Search activity</label><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input id="activity-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search actor, record, or details" className="control min-h-9 w-full pl-9 pr-3 text-xs sm:w-64" /></div><label htmlFor="activity-group" className="sr-only">Filter policy event group</label><select id="activity-group" value={eventGroup} onChange={(event) => setEventGroup(event.target.value)} className="control min-h-9 px-3 text-xs"><option value="">All policy events</option><option value="evaluation">Evaluations</option><option value="override">Overrides</option><option value="tariff">Tariffs and coverage</option><option value="threshold">Thresholds</option><option value="budget">Budgets</option><option value="deduction">Deductions</option><option value="guarantee_letter">Guarantee Letter expiry</option></select><label htmlFor="activity-action" className="sr-only">Filter by action</label><select id="activity-action" value={actionFilter} onChange={(event) => setActionFilter(event.target.value)} className="control min-h-9 px-3 text-xs"><option value="">All actions</option>{actions.map((action) => <option key={action} value={action}>{humanize(action)}</option>)}</select></div>
          </div>
        </header>
        {visibleLogs.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">No activity matches the current filters.</p> : <div className="max-h-[640px] overflow-auto"><table className="w-full min-w-[1450px] text-left text-sm"><caption className="sr-only">Administrator-only system activity ledger</caption><thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Timestamp</th><th className="px-4 py-3">Actor / ID</th><th className="px-4 py-3">Action type</th><th className="px-4 py-3">Record / ID</th><th className="px-4 py-3">Old value</th><th className="px-4 py-3">New value</th><th className="px-4 py-3">Justification</th></tr></thead><tbody className="divide-y divide-slate-100">{visibleLogs.map((entry) => { const oldValue = entry.oldValue == null ? 'Not recorded' : typeof entry.oldValue === 'object' ? JSON.stringify(entry.oldValue) : String(entry.oldValue); const newValue = entry.newValue == null ? 'Not recorded' : typeof entry.newValue === 'object' ? JSON.stringify(entry.newValue) : String(entry.newValue); return <tr key={entry.id} className="align-top hover:bg-slate-50"><td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">{entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'Not recorded'}</td><td className="px-4 py-3"><p className="font-medium text-slate-800">{entry.actor.name}</p><p className="text-[11px] text-slate-500">{entry.actor.id || entry.actorId || 'system'} · {entry.actor.email || entry.actor.role}</p></td><td className="px-4 py-3 font-medium text-slate-800">{humanize(entry.action)}</td><td className="px-4 py-3"><p className="font-medium text-slate-700">{entry.affectedRecord.label}</p><p className="text-[11px] text-slate-500">{entry.affectedRecord.type.replaceAll('_', ' ')} · {entry.affectedRecord.id}</p></td><td className="max-w-xs px-4 py-3 text-xs text-slate-600"><span title={oldValue} className="line-clamp-4">{oldValue}</span></td><td className="max-w-xs px-4 py-3 text-xs text-slate-600"><span title={newValue} className="line-clamp-4">{newValue}</span></td><td className="max-w-xs px-4 py-3 text-xs text-slate-600">{entry.justification || 'Not recorded'}</td></tr>; })}</tbody></table></div>}
      </section>
    </div>
  );
}

function ReportList({ title, rows, empty }: { title: string; rows: [string, number][]; empty: string }) {
  return <article className="surface overflow-hidden"><header className="border-b border-slate-200 px-4 py-3"><h2 className="text-sm font-semibold text-slate-900">{title}</h2></header>{rows.length ? <ul className="divide-y divide-slate-100">{rows.map(([label, count]) => <li key={label} className="flex items-center justify-between gap-3 px-4 py-3 text-sm"><span className="text-slate-700">{label}</span><span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-800">{count}</span></li>)}</ul> : <p className="p-6 text-center text-xs text-slate-500">{empty}</p>}</article>;
}
