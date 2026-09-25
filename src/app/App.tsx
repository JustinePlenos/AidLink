import { useEffect, useState } from 'react';
import { Toaster } from './components/ui/sonner';
import { LoginPage } from './components/LoginPage';
import { Dashboard } from './components/Dashboard';
import type { AdminUser } from './api';
import { getCurrentAdmin, logoutAdmin } from './api';

type AuthView = 'login' | 'dashboard';

export default function App() {
  const [sessionNotice, setSessionNotice] = useState('');
  const [currentView, setCurrentView] = useState<AuthView>('login');
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return window.localStorage.getItem('aidlink_admin_authenticated') === 'true' && Boolean(window.localStorage.getItem('aidlink_admin_token'));
  });
  const [adminUser, setAdminUser] = useState<AdminUser | null>(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const storedUser = window.localStorage.getItem('aidlink_admin_user');
    if (!storedUser) {
      return null;
    }

    try {
      return JSON.parse(storedUser) as AdminUser;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (isAuthenticated && adminUser) {
      window.localStorage.setItem('aidlink_admin_authenticated', 'true');
      window.localStorage.setItem('aidlink_admin_user', JSON.stringify(adminUser));
      return;
    }

    window.localStorage.removeItem('aidlink_admin_authenticated');
    window.localStorage.removeItem('aidlink_admin_user');
    window.localStorage.removeItem('aidlink_admin_token');
  }, [adminUser, isAuthenticated]);

  const handleLogin = async ({ user, token }: { user: AdminUser; token: string }) => {
    setSessionNotice('');
    window.localStorage.setItem('aidlink_admin_token', token);
    setAdminUser(user);
    setIsAuthenticated(true);
    setCurrentView('dashboard');
  };

  const clearAuthentication = () => {
    setAdminUser(null);
    window.localStorage.removeItem('aidlink_admin_token');
    setIsAuthenticated(false);
    setCurrentView('login');
  };

  const handleLogout = async () => {
    try {
      await logoutAdmin();
    } finally {
      clearAuthentication();
    }
  };

  useEffect(() => {
    const handleSessionExpired = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setSessionNotice(detail?.message || 'Your session has expired. Sign in again to continue.');
      clearAuthentication();
    };
    window.addEventListener('aidlink:session-expired', handleSessionExpired);
    return () => window.removeEventListener('aidlink:session-expired', handleSessionExpired);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    getCurrentAdmin().then(setAdminUser).catch(() => undefined);
  }, [isAuthenticated]);

  if (!isAuthenticated && currentView === 'login') {
    return (
      <>
        {sessionNotice && <div role="alert" aria-live="assertive" className="mx-auto mt-4 max-w-lg rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">{sessionNotice}</div>}
        <LoginPage onLogin={handleLogin} />
        <Toaster richColors position="top-right" />
      </>
    );
  }

  return (
    <>
      <Dashboard adminUser={adminUser} onLogout={handleLogout} />
      <Toaster richColors position="top-right" />
    </>
  );
}
