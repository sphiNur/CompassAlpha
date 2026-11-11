/**
 * The bottom nav's tabs: each one's permission, labels and icon, and which
 * of them a member sees.
 *
 * Review COREWEB1-10 (2026-11-12): out of Shell.tsx. COREWEB1-31: the
 * labels are catalog keys, so reading them needs no casts.
 */
import type { ComponentType, SVGProps } from 'react';
import type { CatalogKey } from '@compass/i18n';
import {
  IconActivity,
  IconAdmin,
  IconApprove,
  IconAttendance,
  IconCatalog,
  IconConfirm,
  IconHistory,
  IconOrder,
  IconRun,
  IconSettlement,
} from '@compass/ui';
import { readsFinanceOnly } from '../../lib/authAccess';
import type { AuthSession } from '../../stores/authStore';
import { isTabVisible, TAB_KEYS, type Tab } from '../../stores/navStore';

type IconComponent = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

export interface TabDef {
  key: Tab;
  permission: string | null;
  /** The tab also shows with this key (HIS-19: Admin for finance readers). */
  orPermission?: string;
  /** Hide the tab when the user ALSO holds this permission (2026-10-21). */
  hiddenWith?: string;
  labelKey: CatalogKey;
  /**
   * D17 (2026-10-31): the bottom nav's own short label. ru / uz words such
   * as «Согласование» or «Kun yakuni» do not fit seven tabs at 360 px, so
   * the nav reads `nav.short.*`; page titles and the screen-reader name
   * keep the full `labelKey`. zh / en short labels equal the full ones.
   */
  shortKey: CatalogKey;
  Icon: IconComponent;
  /**
   * The page works on the selected store (SHL-2), so whether the tab shows
   * follows what the member may do in that store, not in any store.
   */
  storeBound: boolean;
}

/**
 * Each tab's permission, labels and icon, and whether its page works on
 * the selected store. Review COREWEB1-11 (2026-11-11): keyed by `Tab`, so a
 * tab added to TAB_KEYS (stores/navStore.ts) needs its entry here; the nav
 * shows them in TAB_KEYS order.
 */
const TAB_DEFS: { [K in Tab]: Omit<TabDef, 'key'> } = {
  order: {
    permission: 'order.draft',
    storeBound: true,
    labelKey: 'nav.order',
    shortKey: 'nav.short.order',
    Icon: IconOrder,
  },
  approve: {
    permission: 'order.approve',
    storeBound: true,
    labelKey: 'nav.approve',
    shortKey: 'nav.short.approve',
    Icon: IconApprove,
  },
  run: {
    permission: 'run.purchase',
    storeBound: false,
    labelKey: 'nav.run',
    shortKey: 'nav.short.run',
    Icon: IconRun,
  },
  // 2026-07-30: purchase history used to be reachable only from the
  // bottom of the Run tab, which meant only `run.purchase` holders
  // could see it — a store manager had no route to their own store's
  // spend. `prices.view` is the money-visibility permission (purchaser
  // + manager + admin + super_admin) and is the right gate for a
  // price-and-spend record. See HistoryPage.tsx for why this needed no
  // server-side change.
  history: {
    permission: 'prices.view',
    storeBound: false,
    labelKey: 'nav.history',
    shortKey: 'nav.short.history',
    Icon: IconHistory,
  },
  settlement: {
    permission: 'settlement.record',
    storeBound: true,
    labelKey: 'nav.settlement',
    shortKey: 'nav.short.settlement',
    Icon: IconSettlement,
  },
  // 2026-10-21: staff hold sales.record but not settlement.record, so
  // the Settlement page's sales block was unreachable for them. Users
  // with settlement.record keep that block and don't get this tab.
  sales: {
    permission: 'sales.record',
    hiddenWith: 'settlement.record',
    storeBound: true,
    labelKey: 'nav.sales',
    shortKey: 'nav.short.sales',
    Icon: IconCatalog,
  },
  confirm: {
    permission: 'delivery.confirm',
    storeBound: true,
    labelKey: 'nav.confirm',
    shortKey: 'nav.short.confirm',
    Icon: IconConfirm,
  },
  // 2026-11-05: clock in / out. `attendance.clock` is switched on per
  // member; managers review attendance under Admin, not here.
  attendance: {
    permission: 'attendance.clock',
    storeBound: true,
    labelKey: 'nav.attendance',
    shortKey: 'nav.short.attendance',
    Icon: IconAttendance,
  },
  // Debug is a sub-tab of Admin, not a tab of its own: fewer items in the
  // bar, and the operator views together (`system.logs.view` gates it).
  admin: {
    permission: 'users.manage',
    orPermission: 'reports.view',
    storeBound: false,
    labelKey: 'nav.admin',
    shortKey: 'nav.short.admin',
    Icon: IconAdmin,
  },
};

const TABS: TabDef[] = TAB_KEYS.map((key) => ({ key, ...TAB_DEFS[key] }));

/**
 * The tabs a member sees. Tabs that work on one store follow what the
 * member may do in that store (`storePerms`, SHL-2); the others, and all
 * of them in the all-stores context, follow the union (`permissions`).
 */
export function visibleTabsFor(
  permissions: readonly string[],
  storePerms: readonly string[] | undefined,
  isPlatformAdmin: boolean,
): TabDef[] {
  return TABS.filter(
    (t) =>
      isTabVisible(t, storePerms && t.storeBound ? storePerms : permissions) ||
      (t.key === 'admin' && isPlatformAdmin),
  );
}

/**
 * The bar for this session in the selected store (`storePerms`, SHL-2).
 *
 * 2026-10-21 audit CA-16 / E-12: AdminPage already admits a platform admin
 * without `users.manage` (for the Platform section), but the tab itself was
 * gated on `users.manage`, so they could never get there.
 *
 * RE-HIS-1 (2026-10-31): for someone who only reads finance, the Admin tab
 * opens the finance report alone — call it that, not 「管理」 with a gear
 * (AdminPage.tsx makes the same call with readsFinanceOnly).
 */
export function shellTabs(
  session: AuthSession | null,
  storePerms: readonly string[] | undefined,
): TabDef[] {
  const financeOnly = readsFinanceOnly(session);
  return visibleTabsFor(session?.permissions ?? [], storePerms, !!session?.isPlatformAdmin).map(
    (t): TabDef =>
      t.key === 'admin' && financeOnly
        ? { ...t, labelKey: 'admin.subsection.finance', Icon: IconActivity }
        : t,
  );
}

/**
 * 2026-11-05 (owner): a bar with a single tab (a cashier has only 日结)
 * switches nowhere and takes 64 px of the screen. With one page or none,
 * there is no bottom nav.
 */
export function showsNav(tabs: readonly TabDef[]): boolean {
  return tabs.length > 1;
}

/**
 * A11Y-10: pages that render their own visible <h1>. Review COREWEB1-23
 * (2026-11-11): not Sales, which no longer shows a title (UI-12).
 */
export const TABS_WITH_OWN_H1: ReadonlySet<Tab> = new Set<Tab>(['history', 'admin']);
