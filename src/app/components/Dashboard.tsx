import { useEffect, useMemo, useRef, useState } from 'react';
import { AssistanceRequestsTable } from './AssistanceRequestsTable';
import { MobileNavigation, Sidebar, type NavigationView } from './Sidebar';
import { DashboardStats } from './DashboardStats';
import { UserManagement } from './UserManagement';
import { AdminProfile, type AdminProfileData } from './AdminProfile';
import { getRequests, type AdminUser } from '../api';
import type { AssistanceRequest } from '../types';
import { emptyRequestFilters, filtersForQueue, type RequestFilters, type RequestQueueKey } from '../requestQueues';
import { Settings2, ChevronDown, FileText, LayoutDashboard, LogOut, Search, User as UserIcon, Users, X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar';
import { NotificationBell } from './NotificationBell';
import { FacilityManagement } from './FacilityManagement';
import { StaffManagement } from './StaffManagement';
import { SystemActivity } from './SystemActivity';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

interface DashboardProps { adminUser: AdminUser | null; onLogout: () => void; }
type View = NavigationView | 'profile';

const viewMeta: Record<View, { title: string; description: string }> = {
  dashboard: { title: 'Operations overview', description: 'Review incoming applications and work queues.' },
  requests: { title: 'Assistance requests', description: 'Verify eligibility documents and record processing decisions.' },
  users: { title: 'Requestors', description: 'Review applicant profiles and request history.' },
  facilities: { title: 'System configuration', description: 'Manage assistance rules, enforced document checklists, receipt validity, and system behavior.' },
  staff: { title: 'Staff accounts', description: 'Provision staff access, assign roles, and manage account security.' },
  activity: { title: 'Reports & activity', description: 'Create reports and review staff activity.' },
  profile: { title: 'Account settings', description: 'Manage your administrator identity and contact details.' },
};

const commands: Array<{ view: NavigationView; label: string; detail: string; icon: typeof Search }> = [
  { view: 'dashboard', label: 'Open overview', detail: 'Operations metrics and activity', icon: LayoutDashboard },
  { view: 'requests', label: 'Open assistance requests', detail: 'Review the application queue', icon: FileText },
  { view: 'users', label: 'Open requestors', detail: 'Search constituent profiles', icon: Users },
  { view: 'facilities', label: 'Open system configuration', detail: 'Workflow rules and document checklists', icon: Settings2 },
  { view: 'staff', label: 'Open staff accounts', detail: 'Roles and account security', icon: Users },
  { view: 'activity', label: 'Open reports and activity', detail: 'Reports and staff activity', icon: Search },
];

export function Dashboard({ adminUser, onLogout }: DashboardProps) {
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [requests, setRequests] = useState<AssistanceRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [requestFilters, setRequestFilters] = useState<RequestFilters>({ ...emptyRequestFilters });
  const [requestRefreshKey, setRequestRefreshKey] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const commandInput = useRef<HTMLInputElement>(null);
  const profileStorageKey = `aidlink_admin_profile_v1_${adminUser?.id || 'default'}`;
  const defaultProfile: AdminProfileData = useMemo(() => ({ fullName: adminUser?.fullName || 'Staff User', email: adminUser?.email || 'staff@lingap.gov', phone: adminUser?.phone || '', role: adminUser?.role || 'Case Worker', avatarDataUrl: '' }), [adminUser]);
  const [adminProfile, setAdminProfile] = useState<AdminProfileData>(defaultProfile);
  const canManageSystem = adminUser?.role === 'System Administrator' || adminUser?.role === 'Super Admin';

  useEffect(() => {
    try { const raw = localStorage.getItem(profileStorageKey); if (raw) setAdminProfile({ ...defaultProfile, ...JSON.parse(raw), role: defaultProfile.role }); } catch { /* local storage may be unavailable */ }
  }, [defaultProfile, profileStorageKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen((value) => !value); }
      if (event.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => { if (paletteOpen) window.setTimeout(() => commandInput.current?.focus(), 0); }, [paletteOpen]);

  useEffect(() => {
    let mounted = true;
    setRequestsLoading(true);
    setRequestsError(null);
    getRequests()
      .then((data) => { if (mounted) setRequests(data); })
      .catch((error) => { if (mounted) setRequestsError(error instanceof Error ? error.message : 'Unable to load assistance requests.'); })
      .finally(() => { if (mounted) setRequestsLoading(false); });
    return () => { mounted = false; };
  }, [requestRefreshKey]);

  const saveAdminProfile = (next: AdminProfileData) => {
    const securedProfile = { ...next, role: adminUser?.role || defaultProfile.role };
    setAdminProfile(securedProfile);
    try { localStorage.setItem(profileStorageKey, JSON.stringify(securedProfile)); } catch { /* local storage may be unavailable */ }
  };
  const initials = useMemo(() => (adminProfile.fullName || 'Admin').trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join(''), [adminProfile.fullName]);
  const filteredCommands = commands.filter((item) => (!['staff', 'facilities', 'activity'].includes(item.view) || canManageSystem) && `${item.label} ${item.detail}`.toLowerCase().includes(commandQuery.toLowerCase()));
  const goTo = (view: NavigationView) => { setCurrentView(view); setPaletteOpen(false); setCommandQuery(''); };
  const openQueue = (queue: RequestQueueKey) => { setRequestFilters((current) => filtersForQueue(current, queue)); setCurrentView('requests'); };
  const updateRequest = (updated: AssistanceRequest) => setRequests((current) => current.map((request) => request.id === updated.id ? updated : request));

  return (
    <div className="flex h-screen min-h-[600px] overflow-hidden bg-[#f7f8fa]">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <Sidebar currentView={currentView} onViewChange={setCurrentView} canManageStaff={canManageSystem} />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="z-20 border-b border-slate-200 bg-white">
          <div className="flex h-16 items-center justify-between gap-4 px-4 sm:px-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-lg font-semibold text-slate-900">{viewMeta[currentView].title}</h1>
              </div>
              <p className="hidden truncate text-xs text-slate-500 sm:block">{viewMeta[currentView].description}</p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button type="button" onClick={() => setPaletteOpen(true)} className="hidden min-h-9 w-56 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-left text-sm text-slate-500 shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50 sm:flex" aria-label="Open command palette">
                <Search size={15} /><span className="flex-1">Search or jump to…</span><kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">Ctrl K</kbd>
              </button>
              <NotificationBell />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="Open admin account menu" className="flex min-h-10 items-center gap-2 rounded-md border border-transparent px-2 hover:border-slate-200 hover:bg-slate-50">
                    <Avatar className="size-8">{adminProfile.avatarDataUrl ? <AvatarImage src={adminProfile.avatarDataUrl} alt="Profile" /> : null}<AvatarFallback className="bg-blue-100 text-xs font-semibold text-blue-700">{initials || 'A'}</AvatarFallback></Avatar>
                    <div className="hidden max-w-36 text-left leading-tight lg:block"><p className="truncate text-xs font-semibold text-slate-800">{adminProfile.fullName}</p><p className="truncate text-[11px] text-slate-500">{adminProfile.role}</p></div>
                    <ChevronDown size={14} className="text-slate-400" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuLabel><p className="text-sm font-medium">{adminProfile.fullName}</p><p className="text-xs font-normal text-muted-foreground">{adminProfile.email}</p></DropdownMenuLabel>
                  <DropdownMenuSeparator /><DropdownMenuItem onSelect={() => setCurrentView('profile')}><UserIcon size={16} />Account settings</DropdownMenuItem>
                  <DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={onLogout}><LogOut size={16} />Sign out</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="flex-1 overflow-auto p-4 sm:p-5 lg:p-6">
          {currentView === 'dashboard' && <DashboardStats requests={requests} loading={requestsLoading} error={requestsError} filters={requestFilters} canProcess={adminUser?.role === 'Case Worker'} onFiltersChange={setRequestFilters} onRefresh={() => setRequestRefreshKey((key) => key + 1)} onOpenRequests={() => setCurrentView('requests')} onOpenQueue={openQueue} />}
          {currentView === 'requests' && <AssistanceRequestsTable requests={requests} loading={requestsLoading} error={requestsError} filters={requestFilters} canProcess={adminUser?.role === 'Case Worker'} onFiltersChange={setRequestFilters} onRefresh={() => setRequestRefreshKey((key) => key + 1)} onRequestUpdated={updateRequest} />}
          {currentView === 'users' && <UserManagement canApprove={canManageSystem} />}
          {currentView === 'facilities' && canManageSystem && <FacilityManagement />}
          {currentView === 'staff' && canManageSystem && adminUser && <StaffManagement currentStaffId={adminUser.id} currentStaffRole={adminUser.role} />}
          {currentView === 'activity' && canManageSystem && <SystemActivity />}
          {currentView === 'profile' && <AdminProfile profile={adminProfile} onSave={saveAdminProfile} onBack={() => setCurrentView('dashboard')} />}
        </main>
        <MobileNavigation currentView={currentView} onViewChange={setCurrentView} canManageStaff={canManageSystem} />
      </div>

      {paletteOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/45 px-4 pt-[12vh]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPaletteOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-label="Command palette" className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-300 bg-white shadow-2xl">
            <div className="flex items-center gap-3 border-b border-slate-200 px-4"><Search size={18} className="text-slate-400" /><input ref={commandInput} value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} placeholder="Search pages and actions…" className="h-14 flex-1 border-0 bg-transparent text-sm outline-none" /><button type="button" onClick={() => setPaletteOpen(false)} aria-label="Close command palette" className="rounded p-1.5 text-slate-400 hover:bg-slate-100"><X size={17} /></button></div>
            <div className="p-2"><p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Navigate</p>
              {filteredCommands.length ? filteredCommands.map((item) => { const Icon = item.icon; return <button key={item.view} type="button" onClick={() => goTo(item.view)} className="flex min-h-14 w-full items-center gap-3 rounded-md px-3 text-left hover:bg-blue-50 focus:bg-blue-50"><span className="grid size-8 place-items-center rounded-md border border-slate-200 bg-white text-slate-500"><Icon size={16} /></span><span><span className="block text-sm font-medium text-slate-800">{item.label}</span><span className="block text-xs text-slate-500">{item.detail}</span></span></button>; }) : <div className="px-4 py-10 text-center"><p className="text-sm font-medium text-slate-700">No matching commands</p><p className="mt-1 text-xs text-slate-500">Try searching for requests, users, or configuration.</p></div>}
            </div>
            <footer className="flex items-center gap-4 border-t border-slate-100 bg-slate-50 px-4 py-2 text-[10px] text-slate-500"><span><kbd className="font-mono">↵</kbd> select</span><span><kbd className="font-mono">esc</kbd> close</span></footer>
          </section>
        </div>
      )}
    </div>
  );
}
