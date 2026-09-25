import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Plus, RefreshCw, ShieldCheck, UserCheck, UserX, X } from 'lucide-react';
import {
  assignStaffRole,
  createStaffAccount,
  getActionErrorMessage,
  getStaffAccounts,
  resetStaffPassword,
  setStaffActive,
  staffRoles,
  type StaffAccount,
  type StaffRole,
} from '../api';
import { showToast } from '../utils/toast';
import { ActionFeedback, type ActionFeedbackState } from './ActionFeedback';

export function StaffManagement({ currentStaffId, currentStaffRole: _currentStaffRole = 'System Administrator' }: { currentStaffId: string; currentStaffRole?: string }) {
  const [accounts, setAccounts] = useState<StaffAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [resetTarget, setResetTarget] = useState<StaffAccount | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    password: '',
    role: 'Case Worker' as StaffRole,
  });
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const inFlightRef = useRef(false);
  const start = (id: string, message: string) => { if (inFlightRef.current) return false; inFlightRef.current = true; setBusyId(id); setFeedback({ kind: 'loading', message }); return true; };
  const finish = () => { inFlightRef.current = false; setBusyId(null); };
  const fail = (error: unknown, fallback: string) => { const message = getActionErrorMessage(error, fallback); setFeedback({ kind: 'error', message }); showToast.error(message); };

  const load = async () => {
    if (!start('load', 'Loading staff accounts...')) return;
    setLoading(true);
    setError(null);
    try {
      setAccounts(await getStaffAccounts());
      setFeedback({ kind: 'success', message: 'Staff accounts loaded.' });
    } catch (err) {
      const message = getActionErrorMessage(err, 'Unable to load staff accounts.');
      setError(message);
      setFeedback({ kind: 'error', message });
    } finally {
      setLoading(false);
      finish();
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!showCreate && !resetTarget) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (showCreate) setShowCreate(false);
      if (resetTarget) setResetTarget(null);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [resetTarget, showCreate]);

  const activeCount = useMemo(() => accounts.filter((account) => account.active).length, [accounts]);
  const assignableRoles = staffRoles;
  const replaceAccount = (updated: StaffAccount) => {
    setAccounts((current) => current.map((account) => account.id === updated.id ? updated : account));
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const errors = {
      ...(!form.fullName.trim() ? { fullName: 'Enter the staff member’s full name.' } : {}),
      ...(!form.email.trim() ? { email: 'Enter the staff member’s work email.' } : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()) ? { email: 'Enter a valid work email address.' } : {}),
      ...(form.password.length < 8 ? { password: 'Temporary password must contain at least 8 characters.' } : {}),
    };
    setFormErrors(errors);
    if (Object.keys(errors).length) { setFeedback({ kind: 'error', message: Object.values(errors).join(' ') }); return; }
    if (!start('create', 'Creating the staff account...')) return;
    try {
      const created = await createStaffAccount({ ...form, fullName: form.fullName.trim(), email: form.email.trim() });
      setAccounts((current) => [...current, created].sort((a, b) => a.fullName.localeCompare(b.fullName)));
      setForm({ fullName: '', email: '', password: '', role: 'Case Worker' });
      setShowCreate(false);
      setFormErrors({});
      setFeedback({ kind: 'success', message: 'Staff account created. Share the temporary password securely.' });
      showToast.success('Staff account created. Share the temporary password securely.');
    } catch (err) {
      fail(err, 'Unable to create the staff account. Your entered values were kept.');
    } finally {
      finish();
    }
  };

  const changeRole = async (account: StaffAccount, role: StaffRole) => {
    if (account.id === currentStaffId) { setFeedback({ kind: 'error', message: 'You cannot change your own role. Ask another System Administrator.' }); return; }
    if (!start(account.id, `Changing ${account.fullName}’s role to ${role}...`)) return;
    try {
      replaceAccount(await assignStaffRole(account.id, role));
      setFeedback({ kind: 'success', message: `${account.fullName}’s role was updated to ${role}.` });
      showToast.success(`${account.fullName}'s role was updated.`);
    } catch (err) {
      fail(err, 'Unable to assign the role. The previous role was kept.');
    } finally {
      finish();
    }
  };

  const toggleActive = async (account: StaffAccount) => {
    const nextActive = !account.active;
    if (account.id === currentStaffId) { setFeedback({ kind: 'error', message: 'You cannot deactivate your own signed-in account.' }); return; }
    if (!nextActive && !window.confirm(`Deactivate ${account.fullName}? Existing sessions will lose access immediately.`)) return;
    if (!start(account.id, `${nextActive ? 'Reactivating' : 'Deactivating'} ${account.fullName}...`)) return;
    try {
      replaceAccount(await setStaffActive(account.id, nextActive));
      setFeedback({ kind: 'success', message: nextActive ? 'Staff account reactivated.' : 'Staff account deactivated.' });
      showToast.success(nextActive ? 'Staff account reactivated.' : 'Staff account deactivated.');
    } catch (err) {
      fail(err, 'Unable to change account access. The previous account status was kept.');
    } finally {
      finish();
    }
  };

  const resetPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!resetTarget) { setFeedback({ kind: 'error', message: 'Select a staff account before resetting a password.' }); return; }
    if (newPassword.length < 8) { setFeedback({ kind: 'error', message: 'New temporary password must contain at least 8 characters.' }); return; }
    if (!start(resetTarget.id, `Resetting ${resetTarget.fullName}’s password...`)) return;
    try {
      const result = await resetStaffPassword(resetTarget.id, newPassword);
      showToast.success(result.message);
      setFeedback({ kind: 'success', message: result.message });
      setResetTarget(null);
      setNewPassword('');
    } catch (err) {
      fail(err, 'Unable to reset the password. The entered temporary password was kept.');
    } finally {
      finish();
    }
  };

  return (
    <div className="space-y-4">
      <section className="surface flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck size={19} className="text-blue-700" />
            <h2 className="text-base font-semibold text-slate-900">Staff account security</h2>
          </div>
          <p className="mt-1 text-xs text-slate-500">{activeCount} active of {accounts.length} staff accounts.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={load} disabled={loading} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button type="button" onClick={() => setShowCreate(true)} className="inline-flex min-h-9 items-center gap-2 rounded-md bg-blue-700 px-3 text-xs font-semibold text-white hover:bg-blue-800">
            <Plus size={15} /> Create staff account
          </button>
        </div>
      </section>
      {!showCreate && !resetTarget && <ActionFeedback feedback={feedback} />}

      {error ? (
        <div role="alert" className="surface p-6 text-sm text-red-700">{error}</div>
      ) : loading ? (
        <div role="status" className="surface p-10 text-center text-sm text-slate-500">Loading staff accounts...</div>
      ) : (
        <div className="surface overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
              <tr><th className="px-4 py-3">Staff member</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Registered</th><th className="px-4 py-3 text-right">Actions</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {accounts.map((account) => {
                const self = account.id === currentStaffId;
                const busy = busyId === account.id;
                return (
                  <tr key={account.id} className={account.active ? '' : 'bg-slate-50 text-slate-500'}>
                    <td className="px-4 py-3"><p className="font-medium text-slate-900">{account.fullName}{self ? ' (you)' : ''}</p><p className="text-xs text-slate-500">{account.email}</p></td>
                    <td className="px-4 py-3">
                      <select
                        aria-label={`Role for ${account.fullName}`}
                        value={account.role}
                        disabled={busy || self}
                        onChange={(event) => void changeRole(account, event.target.value as StaffRole)}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs disabled:opacity-60"
                      >
                        {assignableRoles.map((role) => <option key={role} value={role}>{role}</option>)}
                      </select>
                    </td>
                    <td className="px-4 py-3"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${account.active ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-300 bg-slate-100 text-slate-600'}`}>{account.active ? 'Active' : 'Deactivated'}</span></td>
                    <td className="px-4 py-3 text-xs text-slate-500">{account.registeredDate ? new Date(account.registeredDate).toLocaleDateString('en-PH') : 'Not recorded'}</td>
                    <td className="px-4 py-3"><div className="flex justify-end gap-2">
                      <button type="button" onClick={() => { setResetTarget(account); setNewPassword(''); }} disabled={busy} className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-slate-300 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"><KeyRound size={14} /> Reset password</button>
                      <button type="button" onClick={() => void toggleActive(account)} disabled={busy || self} className={`inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-white disabled:opacity-50 ${account.active ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
                        {account.active ? <UserX size={14} /> : <UserCheck size={14} />}{account.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 p-4" role="dialog" aria-modal="true" aria-labelledby="create-staff-title">
          <form noValidate onSubmit={create} className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between"><h2 id="create-staff-title" className="text-lg font-semibold">Create staff account</h2><button type="button" onClick={() => setShowCreate(false)} aria-label="Close" className="rounded p-1 hover:bg-slate-100"><X size={19} /></button></div>
            <p className="mt-1 text-xs text-slate-500">The staff member can sign in only with the credentials provisioned here.</p>
            <ActionFeedback feedback={feedback} className="mt-4" />
            <div className="mt-5 space-y-4">
              <label className="block text-xs font-medium text-slate-700">Full name<input aria-label="Full name" autoFocus aria-invalid={Boolean(formErrors.fullName)} aria-describedby={formErrors.fullName ? 'staff-name-error' : undefined} value={form.fullName} onChange={(event) => { setForm({ ...form, fullName: event.target.value }); setFormErrors((current) => ({ ...current, fullName: '' })); }} className="control mt-1.5 w-full px-3 py-2.5 text-sm" />{formErrors.fullName && <span id="staff-name-error" className="mt-1 block text-xs text-red-700">{formErrors.fullName}</span>}</label>
              <label className="block text-xs font-medium text-slate-700">Work email<input aria-label="Work email" aria-invalid={Boolean(formErrors.email)} aria-describedby={formErrors.email ? 'staff-email-error' : undefined} type="email" value={form.email} onChange={(event) => { setForm({ ...form, email: event.target.value }); setFormErrors((current) => ({ ...current, email: '' })); }} className="control mt-1.5 w-full px-3 py-2.5 text-sm" />{formErrors.email && <span id="staff-email-error" className="mt-1 block text-xs text-red-700">{formErrors.email}</span>}</label>
              <label className="block text-xs font-medium text-slate-700">Temporary password<input aria-label="Temporary password" aria-invalid={Boolean(formErrors.password)} aria-describedby={formErrors.password ? 'staff-password-error' : undefined} type="password" autoComplete="new-password" value={form.password} onChange={(event) => { setForm({ ...form, password: event.target.value }); setFormErrors((current) => ({ ...current, password: '' })); }} className="control mt-1.5 w-full px-3 py-2.5 text-sm" />{formErrors.password && <span id="staff-password-error" className="mt-1 block text-xs text-red-700">{formErrors.password}</span>}</label>
              <label className="block text-xs font-medium text-slate-700">Role<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as StaffRole })} className="control mt-1.5 w-full px-3 py-2.5 text-sm">{assignableRoles.map((role) => <option key={role}>{role}</option>)}</select></label>
            </div>
            <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={() => setShowCreate(false)} className="rounded-md border border-slate-300 px-4 py-2 text-sm">Cancel</button><button type="submit" disabled={busyId === 'create'} aria-busy={busyId === 'create'} className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{busyId === 'create' ? 'Creating account...' : 'Create account'}</button></div>
          </form>
        </div>
      )}

      {resetTarget && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 p-4" role="dialog" aria-modal="true" aria-labelledby="reset-password-title">
          <form noValidate onSubmit={resetPassword} className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between"><h2 id="reset-password-title" className="text-lg font-semibold">Reset staff password</h2><button type="button" onClick={() => setResetTarget(null)} aria-label="Close" className="rounded p-1 hover:bg-slate-100"><X size={19} /></button></div>
            <p className="mt-2 text-sm text-slate-600">Set a temporary password for <span className="font-medium">{resetTarget.fullName}</span>. Their existing sessions will be invalidated.</p>
            <ActionFeedback feedback={feedback} className="mt-4" />
            <label className="mt-5 block text-xs font-medium text-slate-700">New temporary password<input autoFocus required minLength={8} type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="control mt-1.5 w-full px-3 py-2.5 text-sm" /></label>
            <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={() => setResetTarget(null)} className="rounded-md border border-slate-300 px-4 py-2 text-sm">Cancel</button><button type="submit" disabled={busyId === resetTarget.id} aria-busy={busyId === resetTarget.id} className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{busyId === resetTarget.id ? 'Resetting...' : 'Reset password'}</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
