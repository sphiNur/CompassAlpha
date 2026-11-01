/**
 * Notification deep links (2026-10-21 audit CA-15 / E-04).
 *
 * The API and worker put "Open Compass" buttons on notifications pointing
 * at FRONTEND_URL + '/approve' | '/order' | '/run' | '/confirm'. The app
 * has no URL router, so before this the path was ignored and the user
 * landed on whatever tab was persisted last time.
 *
 * Only the LAST path segment is read, so a FRONTEND_URL served under a
 * sub-path (`/app/approve`) works the same as the root.
 */
import type { Tab } from '../stores/navStore';

const DEEP_LINK_TABS: readonly Tab[] = [
  'order',
  'approve',
  'run',
  'history',
  'settlement',
  'sales',
  'confirm',
  'admin',
];

function lastSegment(pathname: string): { segment: string; parent: string } {
  const trimmed = pathname.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return { segment: trimmed.slice(i + 1), parent: trimmed.slice(0, i + 1) || '/' };
}

/** The tab a deep-link pathname points at, or null when it isn't one. */
export function tabFromDeepLinkPath(pathname: string): Tab | null {
  const { segment } = lastSegment(pathname);
  const key = segment.toLowerCase() as Tab;
  return DEEP_LINK_TABS.includes(key) ? key : null;
}

/**
 * The pathname to leave in the address bar once the link is consumed —
 * the deep-link segment dropped, so a reload doesn't re-apply it.
 */
export function stripDeepLinkPath(pathname: string): string {
  if (!tabFromDeepLinkPath(pathname)) return pathname;
  return lastSegment(pathname).parent;
}

/**
 * Which tab to switch to: the linked one, but only if the user can see it
 * (a lost permission must not resurrect a hidden tab).
 */
export function resolveDeepLinkTab(pathname: string, visibleKeys: readonly Tab[]): Tab | null {
  const target = tabFromDeepLinkPath(pathname);
  return target && visibleKeys.includes(target) ? target : null;
}

/**
 * The tab a bot link's `startapp=tab_<name>` points at (atlas SHL-6), or
 * null. Invite tokens (`inv_…`) and anything else are not tab links.
 */
export function tabFromStartParam(startParam: string | null | undefined): Tab | null {
  const raw = startParam?.trim().toLowerCase();
  if (!raw?.startsWith('tab_')) return null;
  const key = raw.slice(4) as Tab;
  return DEEP_LINK_TABS.includes(key) ? key : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The store a notification link names (`/approve?store=<id>`, DX-APR-7,
 * 2026-11-01), or null. The app switches to it before opening the tab, so
 * a manager of two stores lands on the store the notification is about.
 */
export function storeFromDeepLinkSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get('store');
  return raw && UUID_RE.test(raw) ? raw.toLowerCase() : null;
}

/** The query string with `store` taken out, so a reload does not re-apply it. */
export function stripStoreParam(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has('store')) return search;
  params.delete('store');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}
