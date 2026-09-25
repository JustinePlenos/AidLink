import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BadgeCheck, ExternalLink, RefreshCw, ShieldCheck, X, XCircle } from 'lucide-react';
import { decideApplicantVerification, flagApplicantVerification, getActionErrorMessage, getApplicantVerifications, getIdentityProofObjectUrl, ProtectedDocumentAccessError, type ApplicantVerification, type ProtectedDocumentFailure } from '../api';
import { showToast } from '../utils/toast';
import { ActionFeedback, type ActionFeedbackState } from './ActionFeedback';

type Preview = { url: string; name: string; mimeType: string };
type ProofFailure = { applicantId: string; failure: ProtectedDocumentFailure; message: string };

const failureLabel: Record<ProtectedDocumentFailure, string> = { expired: 'Session expired', unauthorized: 'Unauthorized', missing: 'File missing', unavailable: 'Service unavailable' };

export function ApplicantVerificationPanel({ canApprove }: { canApprove: boolean }) {
  const [items, setItems] = useState<ApplicantVerification[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const [proofFailure, setProofFailure] = useState<ProofFailure | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const [busyAction, setBusyAction] = useState('');
  const inFlightRef = useRef(false);
  const actionable = useMemo(() => items.filter((item) => item.verificationStatus !== 'approved'), [items]);
  const load = async () => { if (inFlightRef.current) return; inFlightRef.current = true; setLoading(true); setBusyAction('load'); setFeedback({ kind: 'loading', message: 'Loading identity-verification submissions...' }); try { setItems(await getApplicantVerifications()); setFeedback({ kind: 'success', message: 'Identity-verification submissions loaded.' }); } catch (error) { const message = getActionErrorMessage(error, 'Unable to load identity verification.'); setFeedback({ kind: 'error', message }); showToast.error(message); } finally { inFlightRef.current = false; setBusyAction(''); setLoading(false); } };
  const closePreview = () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreview(null);
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
  }, []);
  useEffect(() => {
    if (!preview) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') closePreview(); };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [preview]);
  const update = (item: ApplicantVerification) => setItems((current) => current.map((entry) => entry.id === item.id ? item : entry));
  const noteFor = (id: string) => { const note = notes[id]?.trim(); if (!note) { const message = 'Enter a review note explaining this identity-verification action.'; setFeedback({ kind: 'error', message }); showToast.warning(message); } return note || null; };
  const start = (action: string, message: string) => { if (inFlightRef.current) return false; inFlightRef.current = true; setBusyAction(action); setFeedback({ kind: 'loading', message }); return true; };
  const finish = () => { inFlightRef.current = false; setBusyAction(''); };
  const flag = async (id: string) => { const note = noteFor(id); if (!note || !start(`flag-${id}`, 'Saving identity flag...')) return; try { update(await flagApplicantVerification(id, note)); setFeedback({ kind: 'success', message: 'Identity submission flagged.' }); showToast.success('Identity submission flagged.'); } catch (error) { const message = getActionErrorMessage(error, 'Unable to flag the identity submission. Your review note was kept.'); setFeedback({ kind: 'error', message }); showToast.error(message); } finally { finish(); } };
  const decide = async (id: string, decision: 'approved' | 'rejected') => { const note = noteFor(id); if (!note || !start(`${decision}-${id}`, `${decision === 'approved' ? 'Approving' : 'Rejecting'} identity verification...`)) return; try { update(await decideApplicantVerification(id, decision, note)); setFeedback({ kind: 'success', message: `Identity verification ${decision}.` }); showToast.success(`Identity verification ${decision}.`); } catch (error) { const message = getActionErrorMessage(error, `Unable to ${decision === 'approved' ? 'approve' : 'reject'} identity verification. Your review note was kept.`); setFeedback({ kind: 'error', message }); showToast.error(message); } finally { finish(); } };
  const openProof = async (item: ApplicantVerification) => {
    const document = item.identityVerification?.document;
    if (!document) { setFeedback({ kind: 'error', message: 'Identity proof is missing. Ask the applicant to upload a government-issued ID.' }); return; }
    if (!canApprove) { setFeedback({ kind: 'error', message: 'You do not have permission to open identity proofs. A System Administrator account is required.' }); return; }
    if (!start(`open-${item.id}`, `Opening ${document.name || 'identity proof'}...`)) return;
    setOpeningId(item.id); setProofFailure(null);
    try {
      const url = await getIdentityProofObjectUrl(document.url);
      closePreview();
      previewUrlRef.current = url;
      setPreview({ url, name: document.name || 'Identity proof', mimeType: document.mimeType || 'application/octet-stream' });
      setFeedback({ kind: 'success', message: 'Identity proof opened.' });
    } catch (error) {
      const failure = error instanceof ProtectedDocumentAccessError ? error.failure : 'unavailable';
      const message = error instanceof Error ? error.message : 'The identity proof is unavailable. Try again or contact a System Administrator.';
      setProofFailure({ applicantId: item.id, failure, message });
      setFeedback({ kind: 'error', message: `${failureLabel[failure]}: ${message}` });
      showToast.error(`${failureLabel[failure]}: ${message}`);
    } finally { setOpeningId(null); finish(); }
  };

  return <>
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-lg font-semibold"><ShieldCheck size={19} className="text-blue-700" />Applicant identity verification</h2><p className="mt-1 max-w-3xl text-sm text-slate-600">Review submitted IDs. System Administrators can open and approve them; Case Workers can flag submissions.</p></div><button type="button" onClick={() => void load()} disabled={loading || Boolean(busyAction)} className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs disabled:opacity-60"><RefreshCw size={14} className={busyAction === 'load' ? 'animate-spin' : ''} />{busyAction === 'load' ? 'Refreshing...' : 'Refresh'}</button></div>
      <ActionFeedback feedback={proofFailure ? null : feedback} className="mt-4" />
      {loading ? <p className="mt-4 text-sm text-slate-500">Loading submissions...</p> : actionable.length === 0 ? <p className="mt-4 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">No identity submissions require action.</p> : <div className="mt-4 space-y-3">{actionable.map((item) => <article key={item.id} className="rounded-lg border p-4">
        <div className="flex justify-between gap-2"><div><p className="font-medium">{item.fullName}</p><p className="text-xs text-slate-500">{item.email}</p></div><span className="rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-800">{item.verificationStatus}</span></div>
        {item.identityVerification?.document ? <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm"><p>{item.identityVerification.document.name}</p><p className="text-xs text-slate-500">Uploaded {new Date(item.identityVerification.document.uploadedAt).toLocaleString()}</p>{canApprove ? <button type="button" disabled={openingId === item.id} onClick={() => void openProof(item)} className="mt-2 inline-flex items-center gap-1 text-xs text-blue-700 disabled:opacity-60"><ExternalLink size={13} />{openingId === item.id ? 'Opening…' : 'Open identity proof'}</button> : <p className="mt-2 text-xs font-medium text-slate-600">Only a System Administrator can open this file.</p>}</div> : <p className="mt-3 text-sm text-slate-500">No ID uploaded yet.</p>}
        {proofFailure?.applicantId === item.id && <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900"><p className="font-semibold">{failureLabel[proofFailure.failure]}</p><p className="mt-1">{proofFailure.message}</p><button type="button" onClick={() => void openProof(item)} className="mt-2 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium">{proofFailure.failure === 'expired' ? 'Try again after signing in' : 'Try opening again'}</button></div>}
        <label className="mt-3 block text-xs font-medium">Review note<textarea value={notes[item.id] || ''} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} rows={2} className="mt-1 w-full rounded-md border p-2 text-sm font-normal" /></label>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={Boolean(busyAction)} onClick={() => void flag(item.id)} className="inline-flex items-center gap-1 rounded-md border border-amber-300 px-3 py-2 text-xs text-amber-800 disabled:opacity-60"><AlertTriangle size={14} />{busyAction === `flag-${item.id}` ? 'Saving flag...' : 'Flag or escalate'}</button>{canApprove && item.identityVerification?.document && <><button type="button" disabled={Boolean(busyAction)} onClick={() => void decide(item.id, 'approved')} className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-3 py-2 text-xs text-white disabled:opacity-60"><BadgeCheck size={14} />{busyAction === `approved-${item.id}` ? 'Approving...' : 'Approve identity'}</button><button type="button" disabled={Boolean(busyAction)} onClick={() => void decide(item.id, 'rejected')} className="inline-flex items-center gap-1 rounded-md bg-red-700 px-3 py-2 text-xs text-white disabled:opacity-60"><XCircle size={14} />{busyAction === `rejected-${item.id}` ? 'Rejecting...' : 'Reject identity'}</button></>}</div>
      </article>)}</div>}
    </section>
    {preview && <div role="dialog" aria-modal="true" aria-labelledby="identity-proof-title" className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/75 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target) closePreview(); }}><div className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"><header className="flex items-center justify-between border-b px-4 py-3"><div><h3 id="identity-proof-title" className="font-semibold text-slate-900">Identity proof</h3><p className="text-xs text-slate-500">{preview.name}</p></div><button type="button" onClick={closePreview} aria-label="Close identity proof" className="rounded-md p-2 hover:bg-slate-100"><X size={20} /></button></header><div className="min-h-0 flex-1 bg-slate-100 p-3">{preview.mimeType.startsWith('image/') ? <img src={preview.url} alt={preview.name} className="mx-auto h-full max-w-full object-contain" /> : <iframe src={preview.url} title={preview.name} className="h-full w-full rounded bg-white" />}</div></div></div>}
  </>;
}
