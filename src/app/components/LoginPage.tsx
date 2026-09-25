import { useState } from 'react';
import { AlertCircle, ArrowRight, Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react';
import logoAidLink from '../../imports/logo_AidLink.png';
import type { AdminUser } from '../api';
import { loginAdmin } from '../api';

interface LoginPageProps { onLogin: (session: { user: AdminUser; token: string }) => void; }

export function LoginPage({ onLogin }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault(); setError(null);
    if (!email.trim() || !password) { setError('Enter your authorized email address and password.'); return; }
    setLoading(true);
    try { onLogin(await loginAdmin({ email: email.trim(), password })); }
    catch (err) { setError(err instanceof Error ? err.message : 'Sign-in is unavailable. Please try again.'); }
    finally { setLoading(false); }
  };

  return (
    <main className="grid min-h-screen bg-slate-50 lg:grid-cols-[minmax(360px,0.9fr)_minmax(520px,1.1fr)]">
      <section className="relative hidden overflow-hidden border-r border-slate-800 bg-slate-950 p-12 text-white lg:flex lg:flex-col lg:justify-between" aria-label="AidLink platform information">
        <div>
          <div className="flex items-center gap-3"><img src={logoAidLink} alt="AidLink" className="h-10 w-10 rounded-lg bg-white object-contain p-1" /><div><p className="text-sm font-semibold">AidLink Operations</p><p className="text-xs text-slate-400">LINGAP CMO Personnel Portal</p></div></div>
          <div className="mt-24 max-w-lg"><div className="mb-5 inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-[11px] font-medium text-slate-300"><ShieldCheck size={14} className="text-emerald-400" />Authorized personnel only</div><h1 className="text-4xl font-semibold leading-tight tracking-tight">Review and process<br />assistance requests.</h1><p className="mt-5 max-w-md text-sm leading-6 text-slate-400">Manage applications, documents, corrections, and claiming preparation.</p></div>
        </div>
        <p className="max-w-md text-xs leading-5 text-slate-400">Use only the staff account assigned to you.</p>
      </section>

      <section className="flex min-h-screen items-center justify-center px-5 py-10 sm:px-10">
        <div className="w-full max-w-[410px]">
          <div className="mb-8 flex items-center gap-3 lg:hidden"><img src={logoAidLink} alt="AidLink" className="h-9 w-9 rounded-md bg-white object-contain p-0.5 shadow-sm" /><div><p className="text-sm font-semibold text-slate-900">AidLink Operations</p><p className="text-[11px] text-slate-500">LINGAP CMO</p></div></div>
          <div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-blue-700">Secure access</p><h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Sign in to your workspace</h2><p className="mt-2 text-sm text-slate-500">Use the credentials assigned by your CMO administrator.</p></div>
          <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
            <div><label htmlFor="login-email" className="mb-1.5 block text-xs font-medium text-slate-700">Work email</label><input id="login-email" name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="control w-full px-3 py-2.5 text-sm" placeholder="name@lingap.gov" aria-invalid={Boolean(error)} /></div>
            <div><div className="mb-1.5 flex items-center justify-between"><label htmlFor="login-password" className="text-xs font-medium text-slate-700">Password</label><span className="text-[11px] text-slate-500">Contact your System Administrator for access</span></div><div className="relative"><LockKeyhole className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={15} /><input id="login-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="control w-full py-2.5 pl-9 pr-10 text-sm" placeholder="Enter your password" aria-invalid={Boolean(error)} aria-describedby={error ? 'login-error' : undefined} /><button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></div>
            {error && <div id="login-error" role="alert" aria-live="assertive" className="flex gap-2.5 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700"><AlertCircle className="mt-0.5 shrink-0" size={15} /><span>{error}</span></div>}
            <button type="submit" disabled={loading} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-blue-700 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-800 disabled:opacity-60">{loading ? <><span className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />Signing in…</> : <>Sign in <ArrowRight size={16} /></>}</button>
          </form>
          <p className="mt-10 text-center text-[10px] leading-5 text-slate-400">Protected government information system. Access is monitored and recorded for security and compliance.</p>
        </div>
      </section>
    </main>
  );
}
