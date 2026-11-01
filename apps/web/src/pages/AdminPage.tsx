/**
 * AdminPage — operator console.
 *
 * UX model: iOS-settings-style drill-down. The home view is a list of
 * sections (Workspace / People / Catalog / Activity / Maintenance);
 * tapping any row navigates into that section's full management surface.
 * Back button (top-left of the section) returns to home.
 *
 * Why this shape over the previous chip-bar:
 *   - 9 chips on a 414 px wide phone is visual noise; users scan past
 *     them rather than reading.
 *   - Drill-down maps to the iOS mental model (Settings.app).
 *   - Each section gets ALL the screen height, so dense lists (SKUs,
 *     audit log) feel less cramped.
 *
 * Sections:
 *   Workspace  — org name + signed-in identity, workspace info.
 *   People     — members (with invite via Telegram-native share),
 *                roles (read-only).
 *   Catalog    — stores, categories, SKUs, suppliers (each its own list).
 *   Activity   — overview tiles + audit log + debug.
 *   Maintenance— danger zone: purge all test data (dry-run + typed
 *                confirm + commit).
 *
 * Self-protection rules are server-side; the FE just gives the UI.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Banner,
  Button,
  Card,
  DetailRow,
  EmptyState,
  Field,
  IconActivity,
  IconCatalog,
  IconMaintenance,
  IconPeople,
  IconShield,
  IconWorkspace,
  Input,
  ListRow,
  SectionRow,
  Sheet,
  Switch,
  useToast,
  Select,
} from '@compass/ui';
import { trpc } from '../lib/trpc';
import { useErrToast } from '../lib/errToast';
import { useAuthStore } from '../stores/authStore';
import { useNavStore } from '../stores/navStore';
import { isInTelegram, useTelegramBackButton } from '../hooks/useTelegram';
import { useI18n, useRoleLabels } from '../hooks/useI18n';
import { setPageTitleSub } from '../lib/pageTitle';
import { LANGUAGE_NATIVE_NAMES } from '@compass/i18n';
import { LanguageSheet } from '../components/LanguageSheet';
import { SubscriptionSummary } from '../components/SubscriptionSummary';
// Operations sections — extracted to admin/operations (Phase 5 step 1).
import {
  ActivitySection,
  HistorySection,
  AdminAuditSection,
  PriceReportSection,
  FinanceSection,
  MaintenanceSection,
} from './admin/operations/OperationsSections';
// Catalog CRUD sections — extracted to admin/catalog (Phase 5 step 2).
import {
  CategoriesSection,
  SkusSection,
  SuppliersSection,
  ExpenseTemplatesSection,
  DishesSection,
} from './admin/catalog/CatalogSections';
import {
  type AdminSection,
  type CatalogSub,
  type OperationsSub,
  type StoreFocus,
  type StoreSub,
} from './admin/shared';
// Stores sections — extracted to admin/stores (Phase 5 step 3).
import { StoresHomeSection, StoreDetailScreen } from './admin/stores/StoresSections';
// People + permissions — extracted to admin/people (Phase 5 step 4).
import { PermissionsSection } from './admin/people/PeopleSections';
import { PlatformSection } from './admin/platform/PlatformSections';

/**
 * AdminPage top-level layout (rewritten 2026-05-06 — round 3, M1.4
 * "store-first").
 *
 * Why this round:
 *   The previous "People / Catalog" split was org-flat. M1.1 → M1.3
 *   made every write path scope-aware (per-store grant / override /
 *   detach / transfer / clone), but the navigation still landed
 *   admins on a flat People list with a StoreSwitcher bridge. Chain
 *   owners and store-scoped admins both think *"open my store, manage
 *   it"* — store as the unit of nav, not as a filter on a global list.
 *
 * NEW shape:
 *
 *   - Organization        — who we are (org info, plan, settings)
 *   - 🏪 Stores           — list of stores → drill into one →
 *                            Team (members in this store) | Settings
 *                          The list also shows an "🌐 Org-level" pseudo-
 *                          store at the top, holding admin / super_admin
 *                          members who don't belong to any specific store.
 *   - Roles & Permissions — promoted to top-level. Defining the role
 *                            ladder is org-wide; granting roles is per-
 *                            store and lives inside store detail.
 *   - Catalog             — Categories / SKUs / Suppliers
 *                            (Stores moved out — it never fit; Stores
 *                            is org structure, not catalog data.)
 *   - Operations          — live activity / submission history / audit /
 *                            price report / maintenance
 *
 * Removed:
 *   - The flat People top-level section. Members are now reached
 *     through Stores → <store> → Team. Org-level admins via the pseudo-
 *     store at the top of the Stores list.
 *   - "Catalog → Stores" sub-entry.
 */

export function AdminPage() {
  const session = useAuthStore((s) => s.session);
  // M3.16-B (2026-05-16): drill-down state migrated from useState to
  // navStore (persisted). Reload now restores the exact admin view —
  // e.g. /admin → Stores → Eden Magic City → Team comes back intact
  // instead of resetting to the admin home menu.
  const section = useNavStore((s) => s.adminSection);
  const setSection = useNavStore((s) => s.setAdminSection);
  const catalogSub = useNavStore((s) => s.catalogSub);
  const setCatalogSub = useNavStore((s) => s.setCatalogSub);
  const opsSub = useNavStore((s) => s.opsSub);
  const setOpsSub = useNavStore((s) => s.setOpsSub);
  // M1.4 (2026-05-06): "Stores" section drives everything member-related.
  // `storeFocus` is null when browsing the store list; non-null when
  // drilled into a specific store (or the org-level pseudo-store).
  // `storeSub` selects between Team / Settings tabs inside a focused
  // store. Org-level only ever has 'team' (no settings).
  const storeFocus = useNavStore((s) => s.storeFocus);
  const setStoreFocus = useNavStore((s) => s.setStoreFocus);
  const storeSub = useNavStore((s) => s.storeSub);
  const setStoreSub = useNavStore((s) => s.setStoreSub);
  const resetAdminDrillDown = useNavStore((s) => s.resetAdminDrillDown);

  const isAdmin = session?.permissions.includes('users.manage') ?? false;
  const isSuperAdmin = session?.roleSlugs.includes('super_admin') ?? false;
  // CAT-8 / HIS-10 (2026-10-30): the build flag hid only the menu row; a
  // restored navigation state opened the page itself.
  const maintenanceOn = isSuperAdmin && import.meta.env.VITE_ENABLE_MAINTENANCE === '1';
  const isPlatformAdmin = session?.isPlatformAdmin ?? false;
  // M1.9 (2026-05-07): per-store admins (e.g. store-scoped manager
  // post-B1) get into Admin via the broadened `users.manage` perm,
  // but most org-wide write surfaces (RoleCreate, TransferStore,
  // CloneRoles, MemberPermissions, embedded DebugPage, audit JSON)
  // aren't appropriate for them — server-side guards exist but we
  // shouldn't let them stumble into a "looks editable" UI that throws
  // FORBIDDEN. The `isGlobalAdmin` checks live in each sub-component
  // (PermissionsSection, ManageMemberSheet, StoreSettingsTab,
  // PeopleSection) so they don't add a re-render dep here.

  // Pull i18n once at the top of AdminPage so the section list, page
  // header and titleForSection helper all read the same strings (M1.6,
  // 2026-05-06: prior to this admin was English-only regardless of
  // user locale).
  const i18n = useI18n();
  // A11Y-5 (2026-10-31): see useDrillDownFocus.
  const drill = useDrillDownFocus(
    [
      section,
      catalogSub ?? '',
      opsSub ?? '',
      storeFocus === null ? '' : storeFocus.kind === 'org-level' ? 'org' : storeFocus.storeId,
    ].join('|'),
  );

  // HIS-19 (2026-10-30): someone who reads finance (reports.view) without
  // managing people gets the finance report alone.
  const readsFinance = session?.permissions.includes('reports.view') ?? false;
  if (!isAdmin && !isPlatformAdmin && readsFinance) {
    // RE-HIS-1 (2026-10-31): with the page title the manager's drill-down
    // shows; there is nowhere to go back to, so no back control.
    return (
      <div className="flex flex-col">
        <div className="px-4 pb-2 pt-3">
          <h1 className="text-old-h1 font-semibold leading-[1.15] text-[var(--c-fg)]">
            {i18n.t('admin.subsection.finance')}
          </h1>
        </div>
        <FinanceSection />
      </div>
    );
  }
  if (!isAdmin && !isPlatformAdmin) {
    return (
      <div className="px-4 py-6">
        <EmptyState
          title={i18n.t('admin.empty.adminOnly.title')}
          description={i18n.t('admin.empty.adminOnly.description')}
        />
      </div>
    );
  }

  if (section !== 'home') {
    return (
      <SectionFrame
        title={titleForSection(section, catalogSub, opsSub, storeFocus, storeSub, i18n)}
        rootRef={drill.rootRef}
        onClickCapture={drill.onClickCapture}
        onBack={() => {
          drill.markReturn();
          // Drill-up: one level at a time. Sub-route → section root → home.
          if (section === 'stores' && storeFocus !== null) {
            setStoreFocus(null);
            setStoreSub('team');
          } else if (section === 'catalog' && catalogSub) {
            setCatalogSub(null);
          } else if (section === 'operations' && opsSub) {
            setOpsSub(null);
          } else {
            // M3.16-B: bundle the home-pop into a single store action
            // so it's one persisted write instead of five.
            resetAdminDrillDown();
          }
        }}
      >
        {section === 'organization' ? <WorkspaceSection /> : null}
        {section === 'stores' && storeFocus === null ? (
          <StoresHomeSection
            onPickStore={(focus) => {
              setStoreFocus(focus);
              setStoreSub('team');
            }}
          />
        ) : null}
        {section === 'stores' && storeFocus !== null ? (
          <StoreDetailScreen focus={storeFocus} sub={storeSub} onSubChange={setStoreSub} />
        ) : null}
        {section === 'permissions' ? <PermissionsSection isSuperAdmin={isSuperAdmin} /> : null}
        {section === 'catalog' && !catalogSub ? (
          <CatalogHome onPick={(s) => setCatalogSub(s)} />
        ) : null}
        {section === 'catalog' && catalogSub === 'categories' ? <CategoriesSection /> : null}
        {section === 'catalog' && catalogSub === 'skus' ? <SkusSection /> : null}
        {section === 'catalog' && catalogSub === 'suppliers' ? <SuppliersSection /> : null}
        {section === 'catalog' && catalogSub === 'dishes' ? <DishesSection /> : null}
        {section === 'catalog' && catalogSub === 'expenseTemplates' ? (
          <ExpenseTemplatesSection />
        ) : null}
        {section === 'operations' && (!opsSub || (opsSub === 'maintenance' && !maintenanceOn)) ? (
          <OperationsHome onPick={(s) => setOpsSub(s)} isSuperAdmin={isSuperAdmin} />
        ) : null}
        {section === 'operations' && opsSub === 'activity' ? <ActivitySection /> : null}
        {section === 'operations' && opsSub === 'history' ? <HistorySection /> : null}
        {section === 'operations' && opsSub === 'adminAudit' ? <AdminAuditSection /> : null}
        {section === 'operations' && opsSub === 'priceReport' ? <PriceReportSection /> : null}
        {section === 'operations' && opsSub === 'finance' ? <FinanceSection /> : null}
        {section === 'operations' && opsSub === 'maintenance' && maintenanceOn ? (
          <MaintenanceSection />
        ) : null}
        {section === 'platform' ? <PlatformSection /> : null}
      </SectionFrame>
    );
  }

  return (
    /* M1.12: home PageHeader (workspace name + "signed in as @user")
        removed. Telegram's chrome shows the bot name and BottomNav
        marks the Admin tab — the org name and username already live
        in SettingsSheet → Profile / About for users who want them. */
    <div ref={drill.rootRef} onClickCapture={drill.onClickCapture} className="flex flex-col">
      {/* A11Y-10: the admin home has no visible title; screen readers get one. */}
      <h1 className="sr-only">{i18n.t('nav.admin')}</h1>
      <ul className="mx-4 mt-3 mb-6 flex flex-col gap-2" role="list">
        {/* 2026-10-21 audit CA-16 / E-12: a platform admin without
            `users.manage` now reaches this tab; the tenant sections would
            all 403 for them, so only Platform is listed. */}
        {isAdmin ? (
          <>
            <SectionRow
              icon={<IconWorkspace size={20} />}
              label={i18n.t('admin.section.organization')}
              hint={i18n.t('admin.section.organizationHint')}
              onClick={() => setSection('organization')}
            />
            <SectionRow
              icon={<IconPeople size={20} />}
              label={i18n.t('admin.section.stores')}
              hint={i18n.t('admin.section.storesHint')}
              onClick={() => setSection('stores')}
            />
            {/* M1.11: Permissions had IconWorkspace, same as Organization above
            — visually ambiguous in the section list. Switched to a new
            shield icon (added to @compass/ui) which reads as "access /
            roles" without overlapping the Organization or Stores rows. */}
            <SectionRow
              icon={<IconShield size={20} />}
              label={i18n.t('admin.section.permissions')}
              hint={i18n.t('admin.section.permissionsHint')}
              onClick={() => setSection('permissions')}
            />
            <SectionRow
              icon={<IconCatalog size={20} />}
              label={i18n.t('admin.section.catalog')}
              hint={i18n.t('admin.section.catalogHint')}
              onClick={() => setSection('catalog')}
            />
            <SectionRow
              icon={<IconActivity size={20} />}
              label={i18n.t('admin.section.operations')}
              hint={i18n.t('admin.section.operationsHint')}
              onClick={() => setSection('operations')}
            />
          </>
        ) : null}
        {isPlatformAdmin ? (
          <SectionRow
            icon={<IconShield size={20} />}
            label={i18n.t('admin.section.platform')}
            hint={i18n.t('admin.section.platformHint')}
            onClick={() => setSection('platform')}
          />
        ) : null}
      </ul>
    </div>
  );
}

function titleForSection(
  section: AdminSection,
  catalogSub: CatalogSub | null,
  opsSub: OperationsSub | null,
  storeFocus: StoreFocus,
  _storeSub: StoreSub,
  i18n: ReturnType<typeof useI18n>,
): string {
  if (section === 'stores' && storeFocus !== null) {
    if (storeFocus.kind === 'org-level') return i18n.t('admin.label.orgLevel');
    return storeFocus.storeName;
  }
  if (section === 'catalog' && catalogSub === 'categories')
    return i18n.t('admin.subsection.categories');
  if (section === 'catalog' && catalogSub === 'skus') return i18n.t('admin.subsection.skus');
  if (section === 'catalog' && catalogSub === 'suppliers')
    return i18n.t('admin.subsection.suppliers');
  if (section === 'catalog' && catalogSub === 'dishes') return i18n.t('admin.subsection.dishes');
  if (section === 'catalog' && catalogSub === 'expenseTemplates')
    return i18n.t('admin.subsection.expenseTemplates');
  if (section === 'operations' && opsSub === 'activity') return i18n.t('admin.subsection.activity');
  if (section === 'operations' && opsSub === 'history') return i18n.t('admin.subsection.history');
  if (section === 'operations' && opsSub === 'adminAudit') return i18n.t('admin.subsection.audit');
  if (section === 'operations' && opsSub === 'priceReport')
    return i18n.t('admin.subsection.priceReport');
  if (section === 'operations' && opsSub === 'finance') return i18n.t('admin.subsection.finance');
  if (section === 'operations' && opsSub === 'maintenance')
    return i18n.t('admin.subsection.maintenance');
  switch (section) {
    case 'organization':
      return i18n.t('admin.section.organization');
    case 'stores':
      return i18n.t('admin.section.stores');
    case 'permissions':
      return i18n.t('admin.section.permissions');
    case 'catalog':
      return i18n.t('admin.section.catalog');
    case 'operations':
      return i18n.t('admin.section.operations');
    case 'platform':
      return i18n.t('admin.section.platform');
    default:
      return '';
  }
}

/** Home tab inside Operations — the operations tool menu (text-only rows: one repeated icon carried no information — UIUX-B1). */
function OperationsHome({
  onPick,
  isSuperAdmin,
}: {
  onPick: (s: OperationsSub) => void;
  isSuperAdmin: boolean;
}) {
  const i18n = useI18n();
  return (
    <ul className="mx-4 mt-2 mb-6 flex flex-col gap-2" role="list">
      <SectionRow
        label={i18n.t('admin.subsection.activity')}
        hint={i18n.t('admin.subsection.activityHint')}
        onClick={() => onPick('activity')}
      />
      <SectionRow
        label={i18n.t('admin.subsection.history')}
        hint={i18n.t('admin.subsection.historyHint')}
        onClick={() => onPick('history')}
      />
      <SectionRow
        label={i18n.t('admin.subsection.audit')}
        hint={i18n.t('admin.subsection.auditHint')}
        onClick={() => onPick('adminAudit')}
      />
      <SectionRow
        label={i18n.t('admin.subsection.priceReport')}
        hint={i18n.t('admin.subsection.priceReportHint')}
        onClick={() => onPick('priceReport')}
      />
      {/* M1.15: finance reconciliation. Bank wire vs cash spending by
          date range / supplier / store. Lives next to Price Report
          because both are read-only analytical views. */}
      <SectionRow
        label={i18n.t('admin.subsection.finance')}
        hint={i18n.t('admin.subsection.financeHint')}
        onClick={() => onPick('finance')}
      />
      {/* M1.9 (2026-05-07): Maintenance is a footgun on a live system —
          "Reset today" / "Purge ALL test data" will delete real user
          data the moment a real user has data. Gate behind both
          super_admin AND an env-flag opt-in so the chain owner doesn't
          stumble in on day 1. To re-enable for a maintenance window:
          set VITE_ENABLE_MAINTENANCE=1, rebuild web, and ship. The
          server-side purge endpoints still gate by super_admin perm —
          this is layered defence, not the only fence. */}
      {isSuperAdmin && import.meta.env.VITE_ENABLE_MAINTENANCE === '1' ? (
        <SectionRow
          icon={<IconMaintenance size={20} />}
          label={i18n.t('admin.subsection.maintenance')}
          hint={i18n.t('admin.subsection.maintenanceHint')}
          tone="warn"
          onClick={() => onPick('maintenance')}
        />
      ) : null}
    </ul>
  );
}

// PeopleHome was removed in M1.4. People management is now reached
// through Stores → <store> → Team. Roles & Permissions is its own
// top-level section in the home menu.

// ============ Frame & primitive rows ============

/**
 * A11Y-5 (2026-10-31): entering an admin sub-page (or going back) swapped
 * the whole screen and left focus on <body>; a screen reader said nothing
 * and the next Tab started from the top of the page again.
 *
 * Now, when a tap inside the admin page leads to a deeper page, focus
 * moves to that page's <h1>; when Back leads up, it returns to the row
 * that was used to go in (matched by its text, remembered per level).
 * Changes that come from neither (a restored navigation on load) leave
 * focus alone.
 */
function useDrillDownFocus(levelKey: string) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pending = useRef<'enter' | 'return' | null>(null);
  const lastClick = useRef<{ level: string; text: string } | null>(null);
  const entryRow = useRef(new Map<string, string>());
  const previousLevel = useRef(levelKey);

  useLayoutEffect(() => {
    const from = previousLevel.current;
    if (from === levelKey) return;
    previousLevel.current = levelKey;
    const direction = pending.current;
    pending.current = null;
    const root = rootRef.current;
    if (!root || !direction) return;
    if (direction === 'enter') {
      if (lastClick.current?.level === from) entryRow.current.set(from, lastClick.current.text);
      root.querySelector<HTMLElement>('h1')?.focus({ preventScroll: false });
      return;
    }
    const text = entryRow.current.get(levelKey);
    const row = text
      ? [...root.querySelectorAll<HTMLButtonElement>('button')].find(
          (b) => b.textContent === text,
        )
      : undefined;
    (row ?? root.querySelector<HTMLElement>('h1'))?.focus();
  }, [levelKey]);

  return {
    rootRef,
    onClickCapture: (event: React.MouseEvent) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button) return;
      lastClick.current = { level: levelKey, text: button.textContent ?? '' };
      pending.current = 'enter';
    },
    markReturn: () => {
      pending.current = 'return';
    },
  };
}

function SectionFrame({
  title,
  onBack,
  rootRef,
  onClickCapture,
  children,
}: {
  title: string;
  onBack: () => void;
  rootRef?: React.Ref<HTMLDivElement>;
  onClickCapture?: (event: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  // Wire Telegram's native BackButton (top-left in the WebView chrome).
  // Inside Telegram, the in-page chevron below is hidden — there's only
  // ONE place to go back, the user's muscle memory.
  //
  // 2026-10-21 audit CA-34: the M1.5 "disable while any sheet is open"
  // gate is gone. Sheets and this hook share one owner stack, so an open
  // sheet sits on top and owns back-taps; closing it hands the button
  // back here without a hide()/show() flicker.
  const i18n = useI18n();
  useTelegramBackButton(onBack);
  // 2026-07-30: was `!!getTg()`, which is true in ANY browser because the
  // Telegram SDK is a static script tag — so this chevron never rendered
  // and admin drill-down had no way back outside Telegram. Worse, the
  // section is persisted to localStorage, so a reload came straight back
  // to the same page. `isInTelegram()` checks for real initData.
  const inTg = isInTelegram();
  // A11Y-10: the section's name leads the document title while it is open.
  useEffect(() => setPageTitleSub(title), [title]);
  return (
    <div ref={rootRef} onClickCapture={onClickCapture} className="flex flex-col">
      {inTg ? null : (
        <header className="flex items-center gap-2 px-2 pt-3 pb-2">
          <button
            type="button"
            onClick={onBack}
            className="press hit-44 inline-flex h-9 items-center gap-1 rounded-[var(--r-pill)] px-3 text-old-body text-[var(--c-action)]"
            aria-label={i18n.t('admin.aria.back')}
          >
            <span aria-hidden className="text-old-h2 leading-none">
              ‹
            </span>
            {/* was the literal "Admin" */}
            <span>{i18n.t('nav.admin')}</span>
          </button>
        </header>
      )}
      <div className="px-4 pb-2 pt-3">
        {/* tabIndex -1: useDrillDownFocus moves focus here on entering. */}
        <h1
          tabIndex={-1}
          className="text-old-h1 font-semibold leading-[1.15] text-[var(--c-fg)] outline-none"
        >
          {title}
        </h1>
      </div>
      {children}
    </div>
  );
}

// SectionRow + ListRow removed 2026-05-03 (round 2). Imported from
// @compass/ui — see packages/ui/src/components/Rows.tsx. Any future
// styling tweaks should land there so all pages benefit.

// ============ Workspace ============

function WorkspaceSection() {
  const session = useAuthStore((s) => s.session);
  const patchSession = useAuthStore((s) => s.patchSession);
  const i18n = useI18n();
  const roleText = useRoleLabels();
  const toast = useToast();
  const errToast = useErrToast();
  // Language picker moved here from OrderPage (2026-05-05). Telegram's
  // gear button in the bot's overflow menu also opens this — but on
  // the web preview where the gear isn't rendered, this row is the
  // path. Available to anyone who can reach the Admin tab.
  const [langSheetOpen, setLangSheetOpen] = useState(false);
  // M1.17: financial settings sheet (currency + tax + tax-inclusive).
  const [financeSheetOpen, setFinanceSheetOpen] = useState(false);
  // Map locale codes to native labels for the read-out.
  const localeLabels: Record<string, string> = LANGUAGE_NATIVE_NAMES;
  const currentLocale = session?.user.locale ?? 'en';
  const currency = session?.member.currency ?? 'UZS';
  const taxRatePct = session?.member.taxRatePct ?? '0';
  const pricesIncludeTax = session?.member.pricesIncludeTax ?? true;
  // 2026-10-21 audit CA-16: orgFinanceUpdate is requireOrgAdmin on the
  // server; `users.manage` (store managers) only got a FORBIDDEN on save.
  const isAdmin = session?.permissions.includes('org.admin') ?? false;

  // Local form draft inside the sheet so we can cancel without
  // affecting the source of truth on the auth store.
  const [draftCurrency, setDraftCurrency] = useState<string>(currency);
  const [draftTax, setDraftTax] = useState<string>(taxRatePct);
  const [draftInclTax, setDraftInclTax] = useState<boolean>(pricesIncludeTax);
  useEffect(() => {
    if (!financeSheetOpen) return;
    setDraftCurrency(currency);
    setDraftTax(taxRatePct);
    setDraftInclTax(pricesIncludeTax);
  }, [financeSheetOpen, currency, taxRatePct, pricesIncludeTax]);

  const orgFinanceUpdate = trpc.admin.orgFinanceUpdate.useMutation({
    onSuccess: () => {
      if (session) {
        patchSession({
          ...session,
          member: {
            ...session.member,
            currency: draftCurrency,
            taxRatePct: draftTax,
            pricesIncludeTax: draftInclTax,
          },
        });
      }
      toast.success(i18n.t('common.saved'));
      setFinanceSheetOpen(false);
    },
    onError: errToast('common.errors.actionFailed'),
  });

  return (
    <div className="px-4 py-3">
      <LanguageSheet open={langSheetOpen} onOpenChange={setLangSheetOpen} />
      <div className="mb-3">
        <SubscriptionSummary />
      </div>
      <Card>
        <div className="flex flex-col gap-3 px-4 py-3">
          {/* M1.7-fix (2026-05-07, audit HIGH #7): these labels were
              hardcoded English — the M1.6 admin-i18n pass missed
              this card. Now they go through i18n.t. */}
          <DetailRow
            label={i18n.t('admin.workspace.name')}
            value={session?.member.orgName ?? '—'}
          />
          {/* M1.9 (2026-05-07): the `slug` row is internal infrastructure
              ("acme-restaurants" type identifier). Showing it raw to
              the chain owner adds noise without value. Kept the field
              in i18n catalogs in case super_admin tooling wants it. */}
          <DetailRow
            label={i18n.t('admin.workspace.yourRole')}
            // RE-AUTH-2: role names, not slugs ("super_admin").
            value={
              [...new Set(session?.roleSlugs ?? [])]
                .map((slug) => roleText.name({ slug }))
                .join(', ') || '—'
            }
          />
          <DetailRow
            label={i18n.t('admin.workspace.telegram')}
            value={session?.user.tgUsername ? `@${session.user.tgUsername}` : '—'}
          />
          {/* M1.17: read-out of the new financial trio so anyone with
              Admin access can see the active settings at a glance. The
              edit affordance is the ListRow below (admin-only). */}
          {/* AUTH-25 (2026-10-30): the section hint promised a time zone. */}
          <DetailRow
            label={i18n.t('admin.workspace.timezone')}
            value={session?.member.timezone ?? '—'}
          />
          <DetailRow label={i18n.t('admin.workspace.currency')} value={currency} />
          <DetailRow
            label={i18n.t('admin.workspace.taxRate')}
            value={Number(taxRatePct) > 0 ? `${taxRatePct}%` : '—'}
          />
        </div>
      </Card>
      <div className="mt-3 flex flex-col gap-2">
        {/* AUTH-25: this is the viewer's own language, not the org's. */}
        <ListRow
          label={i18n.t('admin.workspace.myLanguage')}
          hint={localeLabels[currentLocale] ?? currentLocale}
          onClick={() => setLangSheetOpen(true)}
        />
        {/* M1.17: financial settings editor (admin-only). */}
        {isAdmin ? (
          <ListRow
            label={i18n.t('admin.workspace.financeRow')}
            hint={i18n.t('admin.workspace.financeRowHint', {
              currency,
              tax: Number(taxRatePct) > 0 ? `${taxRatePct}%` : '0%',
            })}
            onClick={() => setFinanceSheetOpen(true)}
          />
        ) : null}
      </div>

      {/* Financial settings editor sheet. M1.17. */}
      <Sheet
        open={financeSheetOpen}
        onOpenChange={(open) => !open && setFinanceSheetOpen(false)}
        title={i18n.t('admin.workspace.financeSheet.title')}
        description={i18n.t('admin.workspace.financeSheet.description')}
        footer={
          // M3.49: sheets always render their own footer button — the
          // in-page PageMainButton is behind any open sheet.
          <Button
            block
            loading={orgFinanceUpdate.isPending}
            onClick={() =>
              orgFinanceUpdate.mutate({
                currency: draftCurrency,
                taxRatePct: draftTax,
                pricesIncludeTax: draftInclTax,
              })
            }
          >
            {i18n.t('common.save')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-3">
          <Field label={i18n.t('admin.workspace.currency')}>
            <Select
              value={draftCurrency}
              onChange={(e) => setDraftCurrency(e.target.value)}
            >
              {/* Limited to four ISO codes for launch — UZS (default),
                  RUB / KZT (neighbouring markets), USD (cross-border
                  contracts). Free-form input is rejected server-side
                  via /^[A-Z]{3}$/, so adding codes is one-liner. */}
              {/* ADM-17: currency names in the UI language. */}
              {(['UZS', 'RUB', 'KZT', 'USD'] as const).map((code) => (
                <option key={code} value={code}>
                  {code} — {i18n.t(`admin.currency.${code}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={i18n.t('admin.workspace.taxRate')}
            hint={i18n.t('admin.workspace.taxRateHint')}
          >
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              max="50"
              value={draftTax}
              onChange={(e) => setDraftTax(e.target.value)}
              placeholder="0"
            />
          </Field>
          <Field label={i18n.t('admin.workspace.pricesIncludeTax')}>
            <Switch
              checked={draftInclTax}
              onChange={(e) => setDraftInclTax(e.target.checked)}
              label={
                draftInclTax
                  ? i18n.t('admin.workspace.pricesIncludeTaxOn')
                  : i18n.t('admin.workspace.pricesIncludeTaxOff')
              }
            />
          </Field>
          <Banner tone="info" title={i18n.t('admin.workspace.financeSheet.warning')} />
        </div>
      </Sheet>
    </div>
  );
}

// DetailRow removed — imported from @compass/ui.

// ============ Catalog ============

function CatalogHome({ onPick }: { onPick: (s: CatalogSub) => void }) {
  const i18n = useI18n();
  // M1.4 (2026-05-06): Stores moved out of Catalog into its own
  // top-level section. Catalog now strictly holds the "what you order
  // / who you order from" data — categories, SKUs, suppliers.
  return (
    <ul className="mx-4 mt-2 flex flex-col gap-2" role="list">
      <li>
        <ListRow
          label={i18n.t('admin.subsection.categories')}
          hint={i18n.t('admin.subsection.categoriesHint')}
          onClick={() => onPick('categories')}
        />
      </li>
      <li>
        <ListRow
          label={i18n.t('admin.subsection.skus')}
          hint={i18n.t('admin.subsection.skusHint')}
          onClick={() => onPick('skus')}
        />
      </li>
      <li>
        <ListRow
          label={i18n.t('admin.subsection.suppliers')}
          hint={i18n.t('admin.subsection.suppliersHint')}
          onClick={() => onPick('suppliers')}
        />
      </li>
      {/* M2.0b: menu items + recipe BOM. ERP step — lives next to
          SKUs because both are catalog data, but kept separate so the
          SKU list doesn't get cluttered with menu-only entries. */}
      <li>
        <ListRow
          label={i18n.t('admin.subsection.dishes')}
          hint={i18n.t('admin.subsection.dishesHint')}
          onClick={() => onPick('dishes')}
        />
      </li>
      {/* M3.57 (2026-05-23): recurring expense templates. Admin sets
          them once; the purchase page's expense sheet offers them as
          shortcuts, so porter/taxi/parking need not be re-typed. Nothing
          is attached to a run automatically (CMP-CAT-3). */}
      <li>
        <ListRow
          label={i18n.t('admin.subsection.expenseTemplates')}
          hint={i18n.t('admin.subsection.expenseTemplatesHint')}
          onClick={() => onPick('expenseTemplates')}
        />
      </li>
    </ul>
  );
}
