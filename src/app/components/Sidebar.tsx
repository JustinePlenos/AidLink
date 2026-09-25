import { Activity, FileText, LayoutDashboard, LifeBuoy, Settings2, ShieldCheck, Users } from 'lucide-react';
import logoAidLink from '../../imports/logo_AidLink.png';

interface SidebarProps {
  currentView: NavigationView | 'profile';
  onViewChange: (view: NavigationView) => void;
  canManageStaff: boolean;
}

export type NavigationView = 'dashboard' | 'requests' | 'users' | 'facilities' | 'staff' | 'activity';

const menuItems = [
  { id: 'dashboard' as const, label: 'Overview', icon: LayoutDashboard },
  { id: 'requests' as const, label: 'Assistance requests', icon: FileText },
  { id: 'users' as const, label: 'Requestors', icon: Users },
  { id: 'facilities' as const, label: 'System configuration', icon: Settings2, systemAdministratorOnly: true },
  { id: 'staff' as const, label: 'Staff accounts', icon: ShieldCheck, systemAdministratorOnly: true },
  { id: 'activity' as const, label: 'Reports & activity', icon: Activity, systemAdministratorOnly: true },
];

export function Sidebar({ currentView, onViewChange, canManageStaff }: SidebarProps) {
  const visibleItems = menuItems.filter((item) => !item.systemAdministratorOnly || canManageStaff);
  return (
    <aside className="hidden w-[244px] shrink-0 border-r border-slate-800 bg-slate-950 text-slate-200 md:flex md:flex-col">
      <div className="flex h-16 items-center gap-3 border-b border-slate-800 px-5">
        <img src={logoAidLink} alt="AidLink" className="h-8 w-8 rounded-md bg-white object-contain p-0.5" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight text-white">AidLink Operations</p>
          <p className="text-[11px] text-slate-400">LINGAP CMO</p>
        </div>
      </div>

      <nav aria-label="Primary navigation" className="flex-1 px-3 py-4">
        <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Workspace</p>
        <div className="space-y-1">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            const active = currentView === item.id;
            return (
              <button key={item.id} type="button" onClick={() => onViewChange(item.id)} aria-current={active ? 'page' : undefined}
                className={`flex min-h-10 w-full items-center gap-3 rounded-md border-l-2 px-3 text-left text-sm transition-colors ${active ? 'border-blue-500 bg-slate-800 text-white' : 'border-transparent text-slate-400 hover:bg-slate-900 hover:text-slate-100'}`}>
                <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <div className="border-t border-slate-800 p-3">
        <button type="button" className="flex min-h-9 w-full items-center gap-3 rounded-md px-3 text-xs text-slate-400 hover:bg-slate-900 hover:text-white" title="Open support resources">
          <LifeBuoy size={16} /> Support &amp; documentation
        </button>
      </div>
    </aside>
  );
}

export function MobileNavigation({ currentView, onViewChange, canManageStaff }: SidebarProps) {
  const visibleItems = menuItems.filter((item) => !item.systemAdministratorOnly || canManageStaff);
  return (
    <nav aria-label="Mobile primary navigation" className="border-t border-slate-200 bg-white md:hidden">
      <div className="grid" style={{ gridTemplateColumns: `repeat(${visibleItems.length}, minmax(0, 1fr))` }}>
        {visibleItems.map((item) => {
          const Icon = item.icon;
          const active = currentView === item.id;
          return (
            <button key={item.id} type="button" onClick={() => onViewChange(item.id)} aria-current={active ? 'page' : undefined}
              className={`flex min-h-16 flex-col items-center justify-center gap-1 px-1 text-[11px] ${active ? 'bg-blue-50 font-semibold text-blue-700' : 'text-slate-500 hover:bg-slate-50'}`}>
              <Icon aria-hidden="true" size={19} /><span>{item.id === 'requests' ? 'Requests' : item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
