import { useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ArrowUpCircle } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { Logo } from '@/components/brand/Logo';
import { ServerSelector } from './ServerSelector';
import { navigation, isNavGroup, type NavItem, type NavGroup } from './nav-data';
import { UpdateDialog } from './UpdateDialog';
import { cn } from '@/lib/utils';
import { useVersion } from '@/hooks/queries';

function NavMenuItem({ item }: { item: NavItem }) {
  const { setOpenMobile } = useSidebar();
  const { t } = useTranslation('nav');

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild>
        <NavLink
          to={item.href}
          end={item.href === '/'}
          onClick={() => setOpenMobile(false)}
          className={({ isActive }) =>
            cn(isActive && 'bg-sidebar-accent text-sidebar-accent-foreground')
          }
        >
          <item.icon className="size-4" />
          <span>{t(item.nameKey)}</span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function NavMenuGroup({ group }: { group: NavGroup }) {
  const location = useLocation();
  const { setOpenMobile } = useSidebar();
  const { t } = useTranslation('nav');
  const isActive = group.children.some((child) => location.pathname.startsWith(child.href));

  return (
    <Collapsible defaultOpen={isActive} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton className={cn(isActive && 'font-medium')}>
            <group.icon className="size-4" />
            <span>{t(group.nameKey)}</span>
            <ChevronRight className="ml-auto size-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {group.children.map((child) => (
              <SidebarMenuSubItem key={child.href}>
                <SidebarMenuSubButton asChild>
                  <NavLink
                    to={child.href}
                    onClick={() => setOpenMobile(false)}
                    className={({ isActive }) =>
                      cn(isActive && 'bg-sidebar-accent text-sidebar-accent-foreground')
                    }
                  >
                    <child.icon className="size-4" />
                    <span>{t(child.nameKey)}</span>
                  </NavLink>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function VersionDisplay() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { t } = useTranslation(['common', 'settings']);
  const { data: version, isLoading } = useVersion();

  if (isLoading || !version) {
    return <div className="text-muted-foreground text-xs">{t('common:states.loading')}</div>;
  }

  const displayVersion = version.current.tag ?? `v${version.current.version}`;

  const getUpdateLabel = () => {
    if (!version.latest) return t('settings:update.title');
    if (version.current.isPrerelease && !version.latest.isPrerelease) {
      return t('settings:update.stableRelease');
    }
    if (version.current.isPrerelease && version.latest.isPrerelease) {
      return t('settings:update.betaUpdate');
    }
    return t('settings:update.title');
  };

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">
            {displayVersion}
            {version.current.isPrerelease && (
              <span className="text-muted-foreground/60 ml-1">({t('common:beta')})</span>
            )}
          </span>
          {version.updateAvailable && version.latest && (
            <Badge
              variant="secondary"
              className="h-5 cursor-pointer gap-1 bg-green-500/10 text-green-600 hover:bg-green-500/20 dark:text-green-400"
              onClick={() => setDialogOpen(true)}
            >
              <ArrowUpCircle className="h-3 w-3" />
              <span className="text-[10px]">{getUpdateLabel()}</span>
            </Badge>
          )}
        </div>
        {version.updateAvailable && version.latest && (
          <button
            onClick={() => setDialogOpen(true)}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-left text-[10px] transition-colors"
          >
            <span>{t('settings:update.versionAvailable', { version: version.latest.tag })}</span>
          </button>
        )}
      </div>

      {version.updateAvailable && version.latest && (
        <UpdateDialog open={dialogOpen} onOpenChange={setDialogOpen} version={version} />
      )}
    </>
  );
}

export function AppSidebar() {
  return (
    <Sidebar>
      <SidebarHeader className="border-b p-0">
        <div className="flex h-14 items-center px-4">
          <Logo size="md" />
        </div>
        <ServerSelector />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map((entry) => {
                if (isNavGroup(entry)) {
                  return <NavMenuGroup key={entry.nameKey} group={entry} />;
                }
                return <NavMenuItem key={entry.href} item={entry} />;
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t">
        <VersionDisplay />
      </SidebarFooter>
    </Sidebar>
  );
}
