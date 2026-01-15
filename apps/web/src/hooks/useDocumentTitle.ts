import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { navigation, isNavGroup } from '@/components/layout/nav-data';

const APP_NAME = 'Tracearr';

/**
 * Build a flat map of href -> name from navigation data
 */
function buildRouteMap(): Map<string, string> {
  const map = new Map<string, string>();

  for (const entry of navigation) {
    if (isNavGroup(entry)) {
      for (const child of entry.children) {
        map.set(child.href, child.name);
      }
    } else {
      map.set(entry.href, entry.name);
    }
  }

  return map;
}

const routeMap = buildRouteMap();

/**
 * Get the page title for a given route path
 */
function getTitleForRoute(pathname: string): string {
  // Check for exact match in navigation
  const navTitle = routeMap.get(pathname);
  if (navTitle) {
    return `${navTitle} | ${APP_NAME}`;
  }

  // Handle dynamic routes and routes not in nav
  if (pathname.startsWith('/users/')) {
    return `User Details | ${APP_NAME}`;
  }

  if (pathname.startsWith('/settings')) {
    return `Settings | ${APP_NAME}`;
  }

  // Fallback: derive title from pathname
  const segments = pathname.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  if (lastSegment) {
    const title = lastSegment
      .split('-')
      .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    return `${title} | ${APP_NAME}`;
  }

  return APP_NAME;
}

/**
 * Hook to automatically update the document title based on the current route.
 * Titles are derived from nav-data.ts for consistency.
 */
export function useDocumentTitle() {
  const location = useLocation();

  useEffect(() => {
    const title = getTitleForRoute(location.pathname);
    document.title = title;
  }, [location.pathname]);
}
