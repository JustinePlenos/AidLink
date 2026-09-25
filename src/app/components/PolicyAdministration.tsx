import { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, CalendarClock, GitBranch, Landmark, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { getActionErrorMessage, getEffectiveFacilityDirectory, getPolicyOffices, getPolicyVersions, publishFacilityDirectory, publishOfficeBoundary, publishPolicyVersion, type EffectiveFacilityDirectory, type OfficePolicyConfiguration, type PolicyVersion } from '../api';
import { showToast } from '../utils/toast';
import { ActionFeedback, type ActionFeedbackState } from './ActionFeedback';

type Draft = { configuration: string; effectiveDate: string; effectiveUntil: string; justification: string; confirmed: boolean };
const today = () => new Date().toISOString().slice(0, 10);
const definitions = [
  { key: 'workflow_thresholds', title: 'Thresholds', icon: SlidersHorizontal, help: 'Controls receipt age, stale work-queue timing, and when document results must be reviewed by a person.', initial: { receiptValidityDays: 365, staleApplicationDays: 7, documentReviewConfidenceThreshold: 0.75 } },
  { key: 'coverage_matrix', title: 'Coverage matrix and tariffs', icon: Landmark, help: 'Controls room and medicine reductions, subsidy bands, approved deductions, and assistance caps. Publish only client-approved values.', initial: { status: 'awaiting_client_values' } },
  { key: 'submission_gates', title: 'Cooldown and document-year rules', icon: CalendarClock, help: 'Controls the 30-day same-assistance cooldown and which documents must belong to the active calendar year.', initial: { cooldownDays: 30, calendarYearDocumentTypes: ['Recent facility receipt or billing document'] } },
  { key: 'prescription_routing', title: 'Prescription routing', icon: GitBranch, help: 'Keeps private-clinic and private-doctor prescriptions locked until City Health Office validation is approved.', initial: { privatePrescriptionRequiresCho: true, partnerPricingRequiresChoApproval: true } },
] as const;

const draft = (configuration: Record<string, unknown>): Draft => ({ configuration: JSON.stringify(configuration, null, 2), effectiveDate: today(), effectiveUntil: '', justification: '', confirmed: false });
const readable = (value: unknown) => JSON.stringify(value, null, 2);

export function PolicyAdministration() {
  const [versions, setVersions] = useState<Record<string, PolicyVersion[]>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(definitions.map((item) => [item.key, draft(item.initial)])));
  const [directory, setDirectory] = useState<EffectiveFacilityDirectory | null>(null);
  const [directoryDraft, setDirectoryDraft] = useState({ directory: '', authoritativeSource: '', effectiveFrom: today(), effectiveUntil: '', justification: '', confirmed: false });
  const [offices, setOffices] = useState<OfficePolicyConfiguration[]>([]);
  const [officeId, setOfficeId] = useState('');
  const [officeDraft, setOfficeDraft] = useState({ boundary: '', effectiveFrom: today(), effectiveUntil: '', justification: '', confirmed: false });
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const [busy, setBusy] = useState('');
  const inFlight = useRef(false);
  const selectedOffice = useMemo(() => offices.find((item) => item.id === officeId) || null, [officeId, offices]);

  const begin = (key: string, message: string) => { if (inFlight.current) return false; inFlight.current = true; setBusy(key); setFeedback({ kind: 'loading', message }); return true; };
  const end = () => { inFlight.current = false; setBusy(''); };
  const fail = (error: unknown, fallback: string) => { const message = getActionErrorMessage(error, fallback); setFeedback({ kind: 'error', message }); showToast.error(message); };

  const load = async () => {
    if (!begin('load-policy', 'Loading published policy controls...')) return;
    try {
      const [history, facility, nextOffices] = await Promise.all([
        Promise.all(definitions.map(async (item) => [item.key, await getPolicyVersions(item.key)] as const)),
        getEffectiveFacilityDirectory(), getPolicyOffices(),
      ]);
      const nextVersions = Object.fromEntries(history);
      setVersions(nextVersions);
      setDrafts(Object.fromEntries(definitions.map((item) => [item.key, draft(nextVersions[item.key]?.[0]?.configuration || item.initial)])));
      setDirectory(facility);
      setDirectoryDraft({ directory: readable(facility.directory), authoritativeSource: facility.authoritativeSource || '', effectiveFrom: today(), effectiveUntil: '', justification: '', confirmed: false });
      setOffices(nextOffices);
      const selected = nextOffices.find((item) => item.office_type === 'district_satellite') || nextOffices[0];
      if (selected) { setOfficeId(selected.id); setOfficeDraft({ boundary: readable(selected.residency_boundary || {}), effectiveFrom: today(), effectiveUntil: '', justification: '', confirmed: false }); }
      setFeedback({ kind: 'success', message: 'Published policy controls loaded.' });
    } catch (error) { fail(error, 'Unable to load policy controls.'); } finally { end(); }
  };
  useEffect(() => { void load(); }, []);

  const updateDraft = (key: string, values: Partial<Draft>) => setDrafts((current) => ({ ...current, [key]: { ...current[key], ...values } }));
  const publish = async (key: string, title: string) => {
    const value = drafts[key];
    let configuration: Record<string, unknown>;
    try { configuration = JSON.parse(value.configuration); } catch { setFeedback({ kind: 'error', message: `${title}: configuration must be valid JSON.` }); return; }
    if (!value.effectiveDate) { setFeedback({ kind: 'error', message: `${title}: choose an effective date.` }); return; }
    if (value.justification.trim().length < 10) { setFeedback({ kind: 'error', message: `${title}: enter a justification of at least 10 characters.` }); return; }
    if (!value.confirmed) { setFeedback({ kind: 'error', message: `${title}: confirm the values before publication.` }); return; }
    if (!begin(key, `Publishing ${title}...`)) return;
    try { const saved = await publishPolicyVersion(key, { configuration, effectiveDate: value.effectiveDate, effectiveUntil: value.effectiveUntil || null, justification: value.justification, confirmed: true }); setVersions((current) => ({ ...current, [key]: [saved, ...(current[key] || [])] })); updateDraft(key, { justification: '', confirmed: false }); setFeedback({ kind: 'success', message: `${title} published as ${saved.policyVersion}.` }); showToast.success(`${title} published.`); } catch (error) { fail(error, `Unable to publish ${title}. Your values were kept.`); } finally { end(); }
  };

  const publishDirectory = async () => {
    let parsed: EffectiveFacilityDirectory['directory'];
    try { parsed = JSON.parse(directoryDraft.directory); } catch { setFeedback({ kind: 'error', message: 'Facility directory must be valid JSON.' }); return; }
    if (!directoryDraft.authoritativeSource.trim() || !directoryDraft.effectiveFrom || directoryDraft.justification.trim().length < 10 || !directoryDraft.confirmed) { setFeedback({ kind: 'error', message: 'Facility directory requires an authoritative source, effective date, justification of at least 10 characters, and confirmation.' }); return; }
    if (!begin('directory', 'Publishing the facility directory...')) return;
    try { const saved = await publishFacilityDirectory({ directory: parsed, authoritativeSource: directoryDraft.authoritativeSource, effectiveFrom: directoryDraft.effectiveFrom, effectiveUntil: directoryDraft.effectiveUntil || null, justification: directoryDraft.justification, confirmed: true }); setDirectory(saved); setDirectoryDraft((current) => ({ ...current, justification: '', confirmed: false })); setFeedback({ kind: 'success', message: `Facility directory ${saved.directoryVersion} published.` }); } catch (error) { fail(error, 'Unable to publish the facility directory. Your values were kept.'); } finally { end(); }
  };

  const publishResidency = async () => {
    if (!selectedOffice) { setFeedback({ kind: 'error', message: 'Select a district office.' }); return; }
    let boundary: Record<string, unknown>;
    try { boundary = JSON.parse(officeDraft.boundary); } catch { setFeedback({ kind: 'error', message: 'Residency boundary must be valid JSON.' }); return; }
    if (!Object.keys(boundary).length || !officeDraft.effectiveFrom || officeDraft.justification.trim().length < 10 || !officeDraft.confirmed) { setFeedback({ kind: 'error', message: 'Residency publication requires a boundary, effective date, justification of at least 10 characters, and confirmation.' }); return; }
    if (!begin('residency', 'Publishing the residency boundary...')) return;
    try { const saved = await publishOfficeBoundary(selectedOffice.id, { officeCode: selectedOffice.office_code, name: selectedOffice.name, officeType: selectedOffice.office_type, districtCode: selectedOffice.district_code, active: selectedOffice.active, residencyBoundary: boundary, effectiveFrom: officeDraft.effectiveFrom, effectiveUntil: officeDraft.effectiveUntil || null, justification: officeDraft.justification, confirmed: true }); setOffices((current) => current.map((item) => item.id === saved.id ? saved : item)); setOfficeDraft((current) => ({ ...current, justification: '', confirmed: false })); setFeedback({ kind: 'success', message: `Residency boundary ${saved.publishedBoundaryVersion} published.` }); } catch (error) { fail(error, 'Unable to publish the residency boundary. Your values were kept.'); } finally { end(); }
  };

  return <section className="space-y-4 rounded-lg border border-indigo-200 bg-indigo-50/40 p-5">
    <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 text-indigo-700" size={20} /><div><h2 className="text-lg font-semibold text-indigo-950">Policy workflow administration</h2><p className="mt-1 text-sm leading-6 text-indigo-900">Publish dated business-rule versions. Existing requests keep their recorded version unless a System Administrator creates an authorized re-evaluation.</p></div></div>
    <ActionFeedback feedback={feedback} />
    <div className="grid gap-4 xl:grid-cols-2">{definitions.map((item) => { const Icon = item.icon; const value = drafts[item.key]; const latest = versions[item.key]?.[0]; return <article key={item.key} className="rounded-lg border bg-white p-4"><div className="flex items-center gap-2"><Icon size={17} className="text-indigo-700" /><h3 className="font-semibold">{item.title}</h3></div><p className="mt-1 text-xs leading-5 text-slate-600">{item.help}</p>{latest ? <p className="mt-2 text-xs font-medium text-indigo-700">Latest: {latest.policyVersion} · effective {new Date(latest.effectiveDate).toLocaleDateString('en-PH')}</p> : <p className="mt-2 text-xs text-amber-700">No published version</p>}<label className="mt-3 block text-xs font-medium">Configuration<textarea aria-label={`${item.title} configuration`} value={value.configuration} onChange={(event) => updateDraft(item.key, { configuration: event.target.value })} rows={8} className="mt-1 w-full rounded-md border p-2 font-mono text-xs" /></label><PublicationFields value={value} setValue={(next) => updateDraft(item.key, next)} title={item.title} /><button type="button" disabled={Boolean(busy)} onClick={() => void publish(item.key, item.title)} className="mt-3 rounded-md bg-indigo-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60">{busy === item.key ? 'Publishing...' : `Publish ${item.title}`}</button></article>; })}</div>

    <article className="rounded-lg border bg-white p-4"><div className="flex items-center gap-2"><Building2 size={17} className="text-indigo-700" /><h3 className="font-semibold">Facility directory</h3></div><p className="mt-1 text-xs leading-5 text-slate-600">Maps receipt evidence to public or client-approved private facilities. Private entries require the complete authoritative list and approval reference.</p>{directory ? <p className="mt-2 text-xs font-medium text-indigo-700">Latest: {directory.directoryVersion}</p> : null}<label className="mt-3 block text-xs font-medium">Directory configuration<textarea aria-label="Facility directory configuration" rows={9} value={directoryDraft.directory} onChange={(event) => setDirectoryDraft({ ...directoryDraft, directory: event.target.value })} className="mt-1 w-full rounded-md border p-2 font-mono text-xs" /></label><label className="mt-3 block text-xs font-medium">Authoritative source<input aria-label="Facility directory authoritative source" value={directoryDraft.authoritativeSource} onChange={(event) => setDirectoryDraft({ ...directoryDraft, authoritativeSource: event.target.value })} className="mt-1 w-full rounded-md border p-2 text-sm" /></label><PublicationFields value={{ configuration: '', effectiveDate: directoryDraft.effectiveFrom, effectiveUntil: directoryDraft.effectiveUntil, justification: directoryDraft.justification, confirmed: directoryDraft.confirmed }} setValue={(next) => setDirectoryDraft((current) => ({ ...current, effectiveFrom: next.effectiveDate ?? current.effectiveFrom, effectiveUntil: next.effectiveUntil ?? current.effectiveUntil, justification: next.justification ?? current.justification, confirmed: next.confirmed ?? current.confirmed }))} title="Facility directory" /><button type="button" disabled={Boolean(busy)} onClick={() => void publishDirectory()} className="mt-3 rounded-md bg-indigo-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60">{busy === 'directory' ? 'Publishing...' : 'Publish facility directory'}</button></article>

    <article className="rounded-lg border bg-white p-4"><h3 className="font-semibold">Residency boundaries</h3><p className="mt-1 text-xs leading-5 text-slate-600">Defines the address or mapped area served by each district satellite office. Each publication is retained for historical review.</p><label className="mt-3 block text-xs font-medium">District office<select aria-label="Residency district office" value={officeId} onChange={(event) => { const next = offices.find((item) => item.id === event.target.value); setOfficeId(event.target.value); setOfficeDraft({ boundary: readable(next?.residency_boundary || {}), effectiveFrom: today(), effectiveUntil: '', justification: '', confirmed: false }); }} className="mt-1 w-full rounded-md border p-2 text-sm">{offices.map((office) => <option key={office.id} value={office.id}>{office.name}</option>)}</select></label><label className="mt-3 block text-xs font-medium">Boundary configuration<textarea aria-label="Residency boundary configuration" rows={8} value={officeDraft.boundary} onChange={(event) => setOfficeDraft({ ...officeDraft, boundary: event.target.value })} className="mt-1 w-full rounded-md border p-2 font-mono text-xs" /></label><PublicationFields value={{ configuration: '', effectiveDate: officeDraft.effectiveFrom, effectiveUntil: officeDraft.effectiveUntil, justification: officeDraft.justification, confirmed: officeDraft.confirmed }} setValue={(next) => setOfficeDraft((current) => ({ ...current, effectiveFrom: next.effectiveDate ?? current.effectiveFrom, effectiveUntil: next.effectiveUntil ?? current.effectiveUntil, justification: next.justification ?? current.justification, confirmed: next.confirmed ?? current.confirmed }))} title="Residency boundary" /><button type="button" disabled={Boolean(busy) || !selectedOffice} onClick={() => void publishResidency()} className="mt-3 rounded-md bg-indigo-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60">{busy === 'residency' ? 'Publishing...' : 'Publish residency boundary'}</button></article>
  </section>;
}

function PublicationFields({ value, setValue, title }: { value: Draft; setValue: (value: Partial<Draft>) => void; title: string }) {
  return <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs font-medium">Effective from<input aria-label={`${title} effective from`} type="date" value={value.effectiveDate} onChange={(event) => setValue({ effectiveDate: event.target.value })} className="mt-1 w-full rounded-md border p-2 text-sm" /></label><label className="text-xs font-medium">Effective until (optional)<input aria-label={`${title} effective until`} type="date" value={value.effectiveUntil} onChange={(event) => setValue({ effectiveUntil: event.target.value })} className="mt-1 w-full rounded-md border p-2 text-sm" /></label><label className="text-xs font-medium sm:col-span-2">Publication justification<textarea aria-label={`${title} publication justification`} value={value.justification} onChange={(event) => setValue({ justification: event.target.value })} rows={2} className="mt-1 w-full rounded-md border p-2 text-sm" /></label><label className="flex items-start gap-2 text-xs sm:col-span-2"><input aria-label={`Confirm ${title} publication`} type="checkbox" checked={value.confirmed} onChange={(event) => setValue({ confirmed: event.target.checked })} className="mt-0.5" /><span>I confirm these values and dates are approved for publication as a new immutable policy version.</span></label></div>;
}
