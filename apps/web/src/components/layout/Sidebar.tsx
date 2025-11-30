import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Map,
  BarChart3,
  Users,
  Shield,
  AlertTriangle,
  Settings,
  ChevronDown,
  TrendingUp,
  Film,
  UserCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Logo } from '@/components/brand/Logo';

interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavGroup {
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  children: NavItem[];
}

type NavEntry = NavItem | NavGroup;

function isNavGroup(entry: NavEntry): entry is NavGroup {
  return 'children' in entry;
}

const navigation: NavEntry[] = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Map', href: '/map', icon: Map },
  {
    name: 'Stats',
    icon: BarChart3,
    children: [
      { name: 'Activity', href: '/stats/activity', icon: TrendingUp },
      { name: 'Library', href: '/stats/library', icon: Film },
      { name: 'Users', href: '/stats/users', icon: UserCircle },
    ],
  },
  { name: 'Users', href: '/users', icon: Users },
  { name: 'Rules', href: '/rules', icon: Shield },
  { name: 'Violations', href: '/violations', icon: AlertTriangle },
  { name: 'Settings', href: '/settings', icon: Settings },
];

export function Sidebar() {
  const location = useLocation();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    // Auto-expand Stats if we're on a stats page
    const initial = new Set<string>();
    if (location.pathname.startsWith('/stats')) {
      initial.add('Stats');
    }
    return initial;
  });

  const toggleGroup = (name: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const isGroupActive = (group: NavGroup) => {
    return group.children.some((child) => location.pathname.startsWith(child.href));
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-card">
      <div className="flex h-16 shrink-0 items-center border-b px-6">
        <Logo size="md" />
      </div>
      <nav className="flex-1 space-y-1 overflow-auto p-4">
        {navigation.map((entry) => {
          if (isNavGroup(entry)) {
            const isExpanded = expandedGroups.has(entry.name);
            const isActive = isGroupActive(entry);

            return (
              <div key={entry.name}>
                <button
                  onClick={() => toggleGroup(entry.name)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  )}
                >
                  <span className="flex items-center gap-3">
                    <entry.icon className="h-5 w-5" />
                    {entry.name}
                  </span>
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 transition-transform duration-200',
                      isExpanded && 'rotate-180'
                    )}
                  />
                </button>
                <div
                  className={cn(
                    'mt-1 space-y-1 overflow-hidden transition-all duration-200',
                    isExpanded ? 'max-h-40 opacity-100' : 'max-h-0 opacity-0'
                  )}
                >
                  {entry.children.map((child) => (
                    <NavLink
                      key={child.href}
                      to={child.href}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-3 rounded-lg py-2 pl-11 pr-3 text-sm font-medium transition-colors',
                          isActive
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                        )
                      }
                    >
                      <child.icon className="h-4 w-4" />
                      {child.name}
                    </NavLink>
                  ))}
                </div>
              </div>
            );
          }

          return (
            <NavLink
              key={entry.href}
              to={entry.href}
              end={entry.href === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )
              }
            >
              <entry.icon className="h-5 w-5" />
              {entry.name}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
