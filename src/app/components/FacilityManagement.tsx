import { useEffect, useRef, useState } from 'react';
import { BellRing, Building2, FileCheck2, Info, RefreshCw, Settings2, ShieldCheck, WalletCards } from 'lucide-react';
import { createBudgetPool, getActionErrorMessage, getBudgetPools, getEffectiveFacilityDirectory, getRequiredDocuments, getSmsProviderStatus, getSystemConfiguration, setAssistanceTypeActive, updateRequiredDocuments, updateSystemSettings, type AssistanceTypeConfiguration, type BudgetPool, type CreateBudgetPoolPayload, type EffectiveFacilityDirectory, type SmsProviderStatus, type SystemSettings } from '../api';
import { showToast } from '../utils/toast';
import { ActionFeedback, type ActionFeedbackState } from './ActionFeedback';
import { PolicyAdministration } from './PolicyAdministration';
import { assistanceTypes } from '../../../shared/assistanceTypes.js';

const defaults: SystemSettings = {
  organizationName: 'LINGAP CMO',
  notificationPollingSeconds: 30,
  receiptValidityDays: 365,
  defaultClaimingTime: '09:00',
  defaultClaimingLocation: 'LINGAP CMO Assistance Desk',
  smsHelpChannel: 'LINGAP CMO help desk',
};
const emptyBudget = (): CreateBudgetPoolPayload => ({ name: '', assistanceType: assistanceTypes[0], effectiveFrom: '', effectiveUntil: '', allocatedAmount: 0, assistanceLimit: 0, depletionThresholdAmount: 0, guaranteeLetterValidityDays: 7, justification: '', confirmed: false });

export function FacilityManagement() {
  const [requiredType, setRequiredType] = useState(assistanceTypes[0]);
  const [requiredDocuments, setRequiredDocuments] = useState('');
  const [types, setTypes] = useState<AssistanceTypeConfiguration[]>([]);
  const [settings, setSettings] = useState<SystemSettings>(defaults);
  const [smsProvider, setSmsProvider] = useState<SmsProviderStatus>({ name: 'unconfigured', configured: false });
  const [facilityDirectory, setFacilityDirectory] = useState<EffectiveFacilityDirectory | null>(null);
  const [budgetPools, setBudgetPools] = useState<BudgetPool[]>([]);
  const [newBudget, setNewBudget] = useState<CreateBudgetPoolPayload>(emptyBudget);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState('');
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const inFlightRef = useRef(false);
  const start = (action: string, message: string) => { if (inFlightRef.current) return false; inFlightRef.current = true; setBusyAction(action); setFeedback({ kind: 'loading', message }); return true; };
  const finish = () => { inFlightRef.current = false; setBusyAction(''); };
  const fail = (error: unknown, fallback: string) => { const message = getActionErrorMessage(error, fallback); setFeedback({ kind: 'error', message }); showToast.error(message); };

  const load = async () => {
    if (!start('load', 'Loading system configuration...')) return;
    setLoading(true);
    try {
      const [data, provider, directory, pools] = await Promise.all([getSystemConfiguration(), getSmsProviderStatus(), getEffectiveFacilityDirectory(), getBudgetPools()]);
      setTypes(data.assistanceTypes);
      setSettings(data.systemSettings);
      setSmsProvider(provider);
      setFacilityDirectory(directory);
      setBudgetPools(pools);
      const selected = data.assistanceTypes.find((item) => item.name === requiredType) || data.assistanceTypes[0];
      if (selected) { setRequiredType(selected.name); setRequiredDocuments(selected.requiredDocuments.join('\n')); }
      setFeedback({ kind: 'success', message: 'System configuration loaded.' });
    } catch (error) {
      fail(error, 'Unable to load system configuration.');
    } finally { setLoading(false); finish(); }
  };
  useEffect(() => { void load(); }, []);

  const selectType = async (type: string) => {
    setRequiredType(type);
    if (!start('select-type', `Loading the ${type} document checklist...`)) return;
    try { const data = await getRequiredDocuments(); setRequiredDocuments((data[type] || []).join('\n')); setFeedback({ kind: 'success', message: `${type} checklist loaded.` }); }
    catch (error) { fail(error, 'Unable to load document requirements.'); }
    finally { finish(); }
  };
  const saveRequired = async () => {
    const documents = requiredDocuments.split('\n').map((item) => item.trim()).filter(Boolean);
    if (!requiredType) { setFeedback({ kind: 'error', message: 'Select an assistance type before saving its document checklist.' }); return; }
    if (!documents.length) { setFeedback({ kind: 'error', message: `Add at least one required document for ${requiredType}.` }); return; }
    if (!documents.some((item) => /receipt|billing/i.test(item))) { setFeedback({ kind: 'error', message: `Add a recent receipt or billing document requirement for ${requiredType}.` }); return; }
    if (!start('save-checklist', `Saving the ${requiredType} document checklist...`)) return;
    try {
      const saved = await updateRequiredDocuments(requiredType, documents);
      setTypes((current) => current.map((item) => item.name === saved.type ? { ...item, requiredDocuments: saved.documents } : item));
      setRequiredDocuments(saved.documents.join('\n'));
      setFeedback({ kind: 'success', message: 'Document checklist updated and active for new requests.' });
      showToast.success('Document checklist updated and active for new requests.');
    } catch (error) { fail(error, 'Unable to update requirements. Your checklist text was kept.'); }
    finally { finish(); }
  };
  const toggleType = async (item: AssistanceTypeConfiguration) => {
    if (!start(`toggle-${item.name}`, `${item.active ? 'Disabling' : 'Enabling'} ${item.name} for new requests...`)) return;
    try {
      const updated = await setAssistanceTypeActive(item.name, !item.active);
      setTypes((current) => current.map((entry) => entry.name === updated.name ? updated : entry));
      setFeedback({ kind: 'success', message: `${item.name} is now ${updated.active ? 'available' : 'unavailable'} for new requests.` });
      showToast.success(`${item.name} is now ${updated.active ? 'available' : 'unavailable'} for new requests.`);
    } catch (error) { fail(error, 'Unable to update assistance-type availability. The previous setting was kept.'); }
    finally { finish(); }
  };
  const saveSettings = async () => {
    const missing = [!settings.organizationName.trim() && 'organization name', !settings.defaultClaimingTime && 'default claiming time', !settings.defaultClaimingLocation.trim() && 'default claiming location', !settings.smsHelpChannel.trim() && 'SMS help channel'].filter(Boolean);
    if (missing.length) { setFeedback({ kind: 'error', message: `Missing required system settings: ${missing.join(', ')}.` }); return; }
    if (!Number.isFinite(settings.notificationPollingSeconds) || settings.notificationPollingSeconds < 10 || settings.notificationPollingSeconds > 3600) { setFeedback({ kind: 'error', message: 'Notification refresh interval must be between 10 and 3600 seconds.' }); return; }
    if (!Number.isFinite(settings.receiptValidityDays) || settings.receiptValidityDays < 1 || settings.receiptValidityDays > 730) { setFeedback({ kind: 'error', message: 'Receipt validity period must be between 1 and 730 days.' }); return; }
    if (!start('save-settings', 'Saving workflow settings...')) return;
    try { setSettings(await updateSystemSettings(settings)); setFeedback({ kind: 'success', message: 'Workflow settings updated.' }); showToast.success('Workflow settings updated.'); }
    catch (error) { fail(error, 'Unable to update system settings. Your entered values were kept.'); }
    finally { finish(); }
  };
  const saveBudget = async () => {
    const missing = [!newBudget.name.trim() && 'pool name', !newBudget.assistanceType && 'assistance type', !newBudget.effectiveFrom && 'effective start date', !newBudget.effectiveUntil && 'effective end date', newBudget.justification.trim().length < 10 && 'justification', !newBudget.confirmed && 'publication confirmation'].filter(Boolean);
    if (missing.length) { setFeedback({ kind: 'error', message: `Complete the budget configuration: ${missing.join(', ')}.` }); return; }
    if (newBudget.allocatedAmount <= 0 || newBudget.assistanceLimit <= 0 || newBudget.assistanceLimit > newBudget.allocatedAmount) { setFeedback({ kind: 'error', message: 'Enter a positive allocation and a per-request limit no greater than the allocation.' }); return; }
    if (newBudget.depletionThresholdAmount < 0 || newBudget.depletionThresholdAmount >= newBudget.allocatedAmount) { setFeedback({ kind: 'error', message: 'The depletion threshold must be zero or greater and lower than the allocation.' }); return; }
    if (!Number.isInteger(newBudget.guaranteeLetterValidityDays) || newBudget.guaranteeLetterValidityDays < 3 || newBudget.guaranteeLetterValidityDays > 14) { setFeedback({ kind: 'error', message: 'Guarantee Letter validity must be from 3 through 14 days.' }); return; }
    if (newBudget.effectiveUntil < newBudget.effectiveFrom) { setFeedback({ kind: 'error', message: 'The budget end date cannot be before its start date.' }); return; }
    if (!start('save-budget', 'Creating the controlled budget pool...')) return;
    try { const saved = await createBudgetPool(newBudget); setBudgetPools((current) => [saved, ...current]); setNewBudget(emptyBudget()); setFeedback({ kind: 'success', message: 'Budget pool created and ready for its effective period.' }); showToast.success('Budget pool created.'); }
    catch (error) { fail(error, 'Unable to create the budget pool. Your entered values were kept.'); }
    finally { finish(); }
  };

  return <div className="space-y-6">
    <ActionFeedback feedback={feedback} />
    <section className="rounded-lg border border-blue-200 bg-blue-50 p-5">
      <div className="flex items-start gap-3"><Info className="mt-0.5 shrink-0 text-blue-700" size={20} /><div>
        <h2 className="font-semibold text-blue-950">What this page controls</h2>
        <p className="mt-1 text-sm leading-6 text-blue-900">These settings control request requirements, receipt dates, notifications, and claiming defaults for new requests.</p>
        <p className="mt-2 text-sm leading-6 text-blue-900">Facilities are identified from receipt evidence and matched to the effective approved directory. Private partners remain unavailable until the complete client-approved list and dates are recorded.</p>
      </div></div>
    </section>

    <PolicyAdministration />

    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-2"><Building2 size={19} className="text-blue-700" /><h2 className="text-lg font-semibold">Facility classification</h2></div>
      <p className="mt-1 text-sm leading-6 text-gray-600">Receipt names are matched here by the server. Applicants cannot choose or change a facility tier.</p>
      {facilityDirectory ? <div className="mt-4 space-y-3">
        <div className="flex flex-wrap gap-2 text-xs"><span className="rounded-full bg-blue-50 px-2.5 py-1 font-medium text-blue-700">{facilityDirectory.directoryVersion}</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">Effective {new Date(facilityDirectory.effectiveFrom).toLocaleDateString('en-PH')}</span></div>
        <div className="grid gap-3 md:grid-cols-2">{facilityDirectory.directory.entries.filter((entry) => entry.tier === 'public').map((entry) => <article key={entry.key} className="rounded-md border border-emerald-200 bg-emerald-50 p-3"><p className="text-sm font-semibold text-emerald-900">{entry.canonicalName}</p><p className="mt-1 text-xs capitalize text-emerald-800">Public · {entry.category.replaceAll('_', ' ')}</p></article>)}{facilityDirectory.directory.rules.filter((rule) => rule.tier === 'public').map((rule) => <article key={rule.key} className="rounded-md border border-emerald-200 bg-emerald-50 p-3"><p className="text-sm font-semibold text-emerald-900">District health units</p><p className="mt-1 text-xs text-emerald-800">Public · matched from validated facility evidence</p></article>)}</div>
        {facilityDirectory.directory.entries.filter((entry) => entry.tier === 'private').length === 0 ? <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p className="font-semibold">Private partner directory pending</p><p className="mt-1 text-xs leading-5">The 42 private partners are not active because the authoritative client list and effective dates have not been supplied. Private pricing remains locked.</p></div> : <p className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">{facilityDirectory.directory.entries.filter((entry) => entry.tier === 'private').length} client-approved private partners are effective.</p>}
      </div> : <p className="mt-4 text-sm text-slate-500">Facility directory information is unavailable.</p>}
    </section>

    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-2"><Settings2 size={19} className="text-blue-700" /><h2 className="text-lg font-semibold">System Settings</h2></div>
      <p className="mt-1 text-sm text-gray-600">Defaults used during intake, review, and claiming.</p>
      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <label className="space-y-1.5 text-sm font-medium">Organization name<input aria-label="Organization name" value={settings.organizationName} onChange={(event) => setSettings({ ...settings, organizationName: event.target.value })} className="w-full rounded-lg border p-2 font-normal" /><span className="block text-xs font-normal leading-5 text-gray-500">Identifies the responsible office on screens and reports. It does not change eligibility.</span></label>
        <label className="space-y-1.5 text-sm font-medium">Notification refresh interval (seconds)<input aria-label="Notification refresh interval (seconds)" type="number" min={10} max={3600} value={settings.notificationPollingSeconds} onChange={(event) => setSettings({ ...settings, notificationPollingSeconds: Number(event.target.value) })} className="w-full rounded-lg border p-2 font-normal" /><span className="block text-xs font-normal leading-5 text-gray-500"><BellRing className="mr-1 inline" size={13} />How often staff see new work-queue notifications.</span></label>
        <label className="space-y-1.5 text-sm font-medium">Receipt validity period (days)<input aria-label="Receipt validity period (days)" type="number" min={1} max={730} value={settings.receiptValidityDays} onChange={(event) => setSettings({ ...settings, receiptValidityDays: Number(event.target.value) })} className="w-full rounded-lg border p-2 font-normal" /><span className="block text-xs font-normal leading-5 text-gray-500"><ShieldCheck className="mr-1 inline" size={13} />Receipts older than this limit cannot be used for new requests or approval. A readable receipt is not proof of authenticity.</span></label>
        <label className="space-y-1.5 text-sm font-medium">Default claiming time<input aria-label="Default claiming time" type="time" value={settings.defaultClaimingTime} onChange={(event) => setSettings({ ...settings, defaultClaimingTime: event.target.value })} className="w-full rounded-lg border p-2 font-normal" /><span className="block text-xs font-normal leading-5 text-gray-500">Used by the approval SMS when a request-specific time is not supplied.</span></label>
        <label className="space-y-1.5 text-sm font-medium">Default claiming location<input aria-label="Default claiming location" value={settings.defaultClaimingLocation} maxLength={200} onChange={(event) => setSettings({ ...settings, defaultClaimingLocation: event.target.value })} className="w-full rounded-lg border p-2 font-normal" /><span className="block text-xs font-normal leading-5 text-gray-500">Fallback location included in approved-request messages.</span></label>
        <label className="space-y-1.5 text-sm font-medium">SMS help channel<input aria-label="SMS help channel" value={settings.smsHelpChannel} maxLength={160} onChange={(event) => setSettings({ ...settings, smsHelpChannel: event.target.value })} className="w-full rounded-lg border p-2 font-normal" /><span className="block text-xs font-normal leading-5 text-gray-500">Contact number or official help channel applicants should use.</span></label>
      </div>
      <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">
        <p>Approval messages use the claiming defaults above.</p>
        <p className="mt-1 font-medium">SMS service: {smsProvider.name} · {smsProvider.configured ? 'Available' : 'Unavailable — messages will remain queued'}</p>
      </div>
      <button type="button" onClick={saveSettings} disabled={Boolean(busyAction)} aria-busy={busyAction === 'save-settings'} className="mt-5 rounded-lg bg-blue-700 px-4 py-2 text-sm text-white disabled:opacity-60">{busyAction === 'save-settings' ? 'Saving workflow settings...' : 'Save workflow settings'}</button>
    </section>

    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-2"><WalletCards size={19} className="text-blue-700" /><h2 className="text-lg font-semibold">City budget allocation</h2></div>
      <p className="mt-1 text-sm leading-6 text-gray-600">Each effective pool controls how much can be released for one request, the protected reserve kept when funds run low, and how long its Guarantee Letter remains valid.</p>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">{budgetPools.map((pool) => <article key={pool.id} className="rounded-lg border p-4 text-sm"><div className="flex justify-between gap-3"><div><h3 className="font-semibold">{pool.name}</h3><p className="text-xs text-slate-500">{pool.assistanceType || 'All assistance types'} Â· {pool.effectiveFrom} to {pool.effectiveUntil}</p></div><span className={`h-fit rounded-full px-2 py-1 text-xs ${pool.allocatableAmount <= 0 ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>{pool.allocatableAmount <= 0 ? 'Depleted' : 'Available'}</span></div><dl className="mt-3 grid grid-cols-2 gap-2 text-xs"><div><dt className="text-slate-500">Allocatable</dt><dd className="font-medium">â‚±{pool.allocatableAmount.toLocaleString()}</dd></div><div><dt className="text-slate-500">Per request</dt><dd className="font-medium">â‚±{pool.assistanceLimit?.toLocaleString() || 'Not configured'}</dd></div><div><dt className="text-slate-500">Protected threshold</dt><dd className="font-medium">â‚±{pool.depletionThresholdAmount.toLocaleString()}</dd></div><div><dt className="text-slate-500">Letter validity</dt><dd className="font-medium">{pool.guaranteeLetterValidityDays ? `${pool.guaranteeLetterValidityDays} days` : 'Not configured'}</dd></div></dl></article>)}</div>
      {!budgetPools.length && <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">No effective budget pools are configured. Guarantee Letters cannot be released until a matching pool is created.</p>}
      <div className="mt-5 rounded-lg border border-blue-200 bg-blue-50 p-4"><h3 className="text-sm font-semibold text-blue-950">Create budget pool</h3><div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs font-medium">Pool name<input aria-label="Budget pool name" value={newBudget.name} onChange={(e) => setNewBudget({ ...newBudget, name: e.target.value })} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm font-normal" /></label>
        <label className="text-xs font-medium">Assistance type<select aria-label="Budget assistance type" value={newBudget.assistanceType} onChange={(e) => setNewBudget({ ...newBudget, assistanceType: e.target.value })} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm font-normal">{assistanceTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
        <label className="text-xs font-medium">Effective from<input aria-label="Budget effective from" type="date" value={newBudget.effectiveFrom} onChange={(e) => setNewBudget({ ...newBudget, effectiveFrom: e.target.value })} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm font-normal" /></label>
        <label className="text-xs font-medium">Effective until<input aria-label="Budget effective until" type="date" value={newBudget.effectiveUntil} onChange={(e) => setNewBudget({ ...newBudget, effectiveUntil: e.target.value })} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm font-normal" /></label>
        <label className="text-xs font-medium">Allocation (PHP)<input aria-label="Budget allocation" type="number" min="0.01" step="0.01" value={newBudget.allocatedAmount || ''} onChange={(e) => setNewBudget({ ...newBudget, allocatedAmount: Number(e.target.value) })} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm font-normal" /></label>
        <label className="text-xs font-medium">Per-request limit (PHP)<input aria-label="Per-request assistance limit" type="number" min="0.01" step="0.01" value={newBudget.assistanceLimit || ''} onChange={(e) => setNewBudget({ ...newBudget, assistanceLimit: Number(e.target.value) })} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm font-normal" /></label>
        <label className="text-xs font-medium">Protected depletion threshold (PHP)<input aria-label="Budget depletion threshold" type="number" min="0" step="0.01" value={newBudget.depletionThresholdAmount} onChange={(e) => setNewBudget({ ...newBudget, depletionThresholdAmount: Number(e.target.value) })} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm font-normal" /></label>
        <label className="text-xs font-medium">Letter validity (3â€“14 days)<input aria-label="Guarantee Letter validity days" type="number" min="3" max="14" value={newBudget.guaranteeLetterValidityDays} onChange={(e) => setNewBudget({ ...newBudget, guaranteeLetterValidityDays: Number(e.target.value) })} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm font-normal" /></label>
      </div><label className="mt-3 block text-xs font-medium">Configuration justification<textarea aria-label="Budget configuration justification" value={newBudget.justification} onChange={(e) => setNewBudget({ ...newBudget, justification: e.target.value })} rows={2} className="mt-1 w-full rounded-lg border bg-white p-2 text-sm font-normal" /></label><label className="mt-3 flex items-start gap-2 text-xs"><input aria-label="Confirm budget publication" type="checkbox" checked={newBudget.confirmed} onChange={(e) => setNewBudget({ ...newBudget, confirmed: e.target.checked })} className="mt-0.5" /><span>I confirm this allocation, validity window, and effective period are approved for publication.</span></label><button type="button" onClick={saveBudget} disabled={Boolean(busyAction)} className="mt-3 rounded-lg bg-blue-700 px-4 py-2 text-sm text-white disabled:opacity-60">{busyAction === 'save-budget' ? 'Publishing budget pool...' : 'Publish budget pool'}</button></div>
    </section>

    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <h2 className="text-lg font-semibold">Assistance-type availability</h2>
      <p className="mt-1 text-sm leading-6 text-gray-600">Available types appear during intake. Turning a type off prevents new requests while preserving historical records.</p>
      <div className="mt-4 grid gap-2 md:grid-cols-2">{types.map((item) => <div key={item.name} className="flex items-center justify-between rounded-lg border p-3"><span className="text-sm font-medium">{item.name}</span><button type="button" disabled={Boolean(busyAction)} onClick={() => toggleType(item)} className={`rounded-full px-3 py-1 text-xs disabled:opacity-60 ${item.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>{busyAction === `toggle-${item.name}` ? 'Saving...' : item.active ? 'Available' : 'Unavailable'}</button></div>)}</div>
    </section>

    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-2"><FileCheck2 size={19} className="text-blue-700" /><h2 className="text-lg font-semibold">Required Documents by Assistance Type</h2></div>
      <p className="mt-1 text-sm leading-6 text-gray-600">Each type has its own upload checklist. Applicants must complete it before submission, and Case Workers use it during review and approval. Include recent receipt or billing evidence to identify the facility.</p>
      <div className="mt-5 grid gap-3 lg:grid-cols-2">{types.map((item) => <article key={item.name} className="rounded-lg border p-4">
        <div className="flex items-center justify-between"><h3 className="font-semibold">{item.name}</h3><span className={`rounded-full px-2 py-1 text-[11px] ${item.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{item.active ? 'Used for new intake' : 'Historical only'}</span></div>
        <ul className="mt-3 space-y-1 text-sm text-slate-700">{item.requiredDocuments.map((document) => <li key={document}>- {document}</li>)}</ul>
        <button type="button" onClick={() => { setRequiredType(item.name); setRequiredDocuments(item.requiredDocuments.join('\n')); }} className="mt-3 text-xs font-medium text-blue-700">Edit this checklist</button>
      </article>)}</div>
      <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4">
        <h3 className="text-sm font-semibold text-amber-950">Edit checklist</h3>
        <p className="mt-1 text-xs leading-5 text-amber-900">Use one clear document name per line. Uploaded filenames do not replace requirement labels. Changes apply to future submissions; historical applications retain their documents.</p>
        <div className="mt-3 flex flex-col gap-3 md:flex-row"><select aria-label="Assistance type to edit" disabled={Boolean(busyAction)} value={requiredType} onChange={(event) => void selectType(event.target.value)} className="rounded-lg border p-2 disabled:opacity-60">{assistanceTypes.map((type) => <option key={type}>{type}</option>)}</select><textarea aria-label="Required documents, one per line" value={requiredDocuments} onChange={(event) => setRequiredDocuments(event.target.value)} rows={5} className="flex-1 rounded-lg border p-2" /><button type="button" disabled={Boolean(busyAction)} onClick={saveRequired} className="self-start rounded-lg bg-blue-700 px-4 py-2 text-sm text-white disabled:opacity-60">{busyAction === 'save-checklist' ? 'Saving checklist...' : 'Save checklist'}</button></div>
      </div>
    </section>
    <button type="button" onClick={() => void load()} disabled={loading || Boolean(busyAction)} className="inline-flex items-center gap-2 text-sm text-gray-600 disabled:opacity-60"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />{busyAction === 'load' ? 'Refreshing configuration...' : 'Refresh configuration'}</button>
  </div>;
}
