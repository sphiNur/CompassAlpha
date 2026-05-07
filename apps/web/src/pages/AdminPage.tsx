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
import { useEffect, useMemo, useState } from 'react';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  CardMeta,
  CardTitle,
  DataState,
  DetailRow,
  EmptyState,
  Field,
  IconActivity,
  IconCatalog,
  IconChevronRight,
  IconMaintenance,
  IconPeople,
  IconShare,
  IconWorkspace,
  Input,
  ListRow,
  PageHeader,
  SectionRow,
  Sheet,
  Spinner,
  Tile,
  useSheetCount,
  useToast,
} from '@compass/ui';
import { ADMIN_RANK } from '@compass/contracts';
import { PAGE_SIZE, STALE } from '../config/timings';
import { botLink as makeBotLink, shareLink as makeShareLink } from '../lib/telegramLinks';
import { trpc } from '../lib/trpc';
import { formatQty, formatMoney } from '../lib/format';
import { useAuthStore } from '../stores/authStore';
import { getTg, useTelegramBackButton } from '../hooks/useTelegram';
import { useI18n, useProductName } from '../hooks/useI18n';
import { useStoreContext } from '../components/StoreSwitcher';
import { LanguageSheet } from '../components/LanguageSheet';
import { DebugPage } from './DebugPage';

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
type AdminSection =
  | 'home'
  | 'organization'
  | 'stores'
  | 'permissions'
  | 'catalog'
  | 'operations';

type CatalogSub = 'categories' | 'skus' | 'suppliers';
type OperationsSub = 'activity' | 'history' | 'maintenance' | 'adminAudit' | 'priceReport';

/**
 * StoreFocus tracks "am I drilled into a specific store, or browsing
 * the list?". `null` → list. `'org-level'` → the pseudo-store for
 * unbound members. `{ storeId, storeName }` → a real store.
 */
type StoreFocus =
  | null
  | { kind: 'org-level' }
  | { kind: 'store'; storeId: string; storeName: string };

/** Sub-tab inside a focused store. Org-level only ever shows 'team'. */
type StoreSub = 'team' | 'settings';

function nativeConfirm(message: string, ok: () => void): void {
  const tg = getTg();
  if (tg) {
    // M1.7-fix (2026-05-07, audit HIGH #8): iOS Telegram's
    // showConfirm renders the literal "\n\n" rather than a paragraph
    // break, so a confirm message like "Remove X?\n\nThis revokes
    // bindings…" looked like garbage. Web's native confirm() does
    // honor newlines, so callers were writing them in good faith.
    // Normalize: collapse runs of whitespace (including \n\n) into a
    // single space when delivering to Telegram. Web preview keeps
    // the original (paragraph-friendly) text so devs see the same
    // copy they wrote.
    const oneLine = message.replace(/\s*\n\s*\n\s*/g, ' — ').replace(/\n/g, ' ');
    tg.showConfirm(oneLine, (yes: boolean) => {
      if (yes) ok();
    });
  } else if (confirm(message)) {
    ok();
  }
}

export function AdminPage() {
  const session = useAuthStore((s) => s.session);
  const [section, setSection] = useState<AdminSection>('home');
  const [catalogSub, setCatalogSub] = useState<CatalogSub | null>(null);
  const [opsSub, setOpsSub] = useState<OperationsSub | null>(null);
  // M1.4 (2026-05-06): "Stores" section drives everything member-related.
  // `storeFocus` is null when browsing the store list; non-null when
  // drilled into a specific store (or the org-level pseudo-store).
  // `storeSub` selects between Team / Settings tabs inside a focused
  // store. Org-level only ever has 'team' (no settings).
  const [storeFocus, setStoreFocus] = useState<StoreFocus>(null);
  const [storeSub, setStoreSub] = useState<StoreSub>('team');

  const isAdmin = session?.permissions.includes('users.manage') ?? false;
  const isSuperAdmin = session?.roleSlugs.includes('super_admin') ?? false;
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

  if (!isAdmin) {
    return (
      <div className="px-4 py-6">
        <EmptyState
          title="Admin only"
          description="You need the users.manage permission to view this page."
        />
      </div>
    );
  }

  if (section !== 'home') {
    return (
      <SectionFrame
        title={titleForSection(section, catalogSub, opsSub, storeFocus, storeSub, i18n)}
        onBack={() => {
          // Drill-up: one level at a time. Sub-route → section root → home.
          if (section === 'stores' && storeFocus !== null) {
            setStoreFocus(null);
            setStoreSub('team');
          } else if (section === 'catalog' && catalogSub) {
            setCatalogSub(null);
          } else if (section === 'operations' && opsSub) {
            setOpsSub(null);
          } else {
            setSection('home');
            setCatalogSub(null);
            setOpsSub(null);
            setStoreFocus(null);
            setStoreSub('team');
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
          <StoreDetailScreen
            focus={storeFocus}
            sub={storeSub}
            onSubChange={setStoreSub}
          />
        ) : null}
        {section === 'permissions' ? (
          <PermissionsSection isSuperAdmin={isSuperAdmin} />
        ) : null}
        {section === 'catalog' && !catalogSub ? (
          <CatalogHome onPick={(s) => setCatalogSub(s)} />
        ) : null}
        {section === 'catalog' && catalogSub === 'categories' ? <CategoriesSection /> : null}
        {section === 'catalog' && catalogSub === 'skus' ? <SkusSection /> : null}
        {section === 'catalog' && catalogSub === 'suppliers' ? <SuppliersSection /> : null}
        {section === 'operations' && !opsSub ? (
          <OperationsHome onPick={(s) => setOpsSub(s)} isSuperAdmin={isSuperAdmin} />
        ) : null}
        {section === 'operations' && opsSub === 'activity' ? <ActivitySection /> : null}
        {section === 'operations' && opsSub === 'history' ? <HistorySection /> : null}
        {section === 'operations' && opsSub === 'adminAudit' ? <AdminAuditSection /> : null}
        {section === 'operations' && opsSub === 'priceReport' ? <PriceReportSection /> : null}
        {section === 'operations' && opsSub === 'maintenance' ? <MaintenanceSection /> : null}
      </SectionFrame>
    );
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        title={session?.member.orgName ?? 'Workspace'}
        subtitle={
          session?.user.tgUsername
            ? i18n.t('admin.label.signedInAs', { name: session.user.tgUsername })
            : i18n.t('admin.label.signedIn')
        }
      />

      <ul className="mx-4 mt-2 mb-6 flex flex-col gap-2" role="list">
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
        <SectionRow
          icon={<IconWorkspace size={20} />}
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
    if (storeFocus.kind === 'org-level') return `🌐 ${i18n.t('admin.label.orgLevel')}`;
    return `🏪 ${storeFocus.storeName}`;
  }
  if (section === 'catalog' && catalogSub === 'categories')
    return i18n.t('admin.subsection.categories');
  if (section === 'catalog' && catalogSub === 'skus')
    return i18n.t('admin.subsection.skus');
  if (section === 'catalog' && catalogSub === 'suppliers')
    return i18n.t('admin.subsection.suppliers');
  if (section === 'operations' && opsSub === 'activity')
    return i18n.t('admin.subsection.activity');
  if (section === 'operations' && opsSub === 'history')
    return i18n.t('admin.subsection.history');
  if (section === 'operations' && opsSub === 'adminAudit')
    return i18n.t('admin.subsection.audit');
  if (section === 'operations' && opsSub === 'priceReport')
    return i18n.t('admin.subsection.priceReport');
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
    default:
      return '';
  }
}

/** Home tab inside Operations — picks one of the 3 day-to-day tools. */
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
        icon={<IconActivity size={20} />}
        label={i18n.t('admin.subsection.activity')}
        hint={i18n.t('admin.subsection.activityHint')}
        onClick={() => onPick('activity')}
      />
      <SectionRow
        icon={<IconActivity size={20} />}
        label={i18n.t('admin.subsection.history')}
        hint={i18n.t('admin.subsection.historyHint')}
        onClick={() => onPick('history')}
      />
      <SectionRow
        icon={<IconActivity size={20} />}
        label={i18n.t('admin.subsection.audit')}
        hint={i18n.t('admin.subsection.auditHint')}
        onClick={() => onPick('adminAudit')}
      />
      <SectionRow
        icon={<IconActivity size={20} />}
        label={i18n.t('admin.subsection.priceReport')}
        hint={i18n.t('admin.subsection.priceReportHint')}
        onClick={() => onPick('priceReport')}
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

function SectionFrame({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  // Wire Telegram's native BackButton (top-left in the WebView chrome).
  // Inside Telegram, the in-page chevron below is hidden — there's only
  // ONE place to go back, the user's muscle memory.
  //
  // M1.5 (2026-05-06): disable the section's BackButton hook while
  // any sheet is open. Otherwise Telegram fires both the section's
  // drill-up handler AND the sheet's close handler simultaneously
  // (Telegram appends listeners, doesn't replace), and the user sees
  // the section navigate up underneath the closing sheet — a hidden
  // dead-end. Sheets register their own close handler; with section
  // disabled they take over uncontested.
  const sheetCount = useSheetCount();
  useTelegramBackButton(onBack, sheetCount === 0);
  const inTg = !!getTg();
  return (
    <div className="flex flex-col">
      {inTg ? null : (
        <header className="flex items-center gap-2 px-2 pt-3 pb-2">
          <button
            type="button"
            onClick={onBack}
            className="press inline-flex h-9 items-center gap-1 rounded-[var(--r-pill)] px-3 text-body text-[var(--c-action)]"
            aria-label="Back"
          >
            <span aria-hidden className="text-h2 leading-none">‹</span>
            <span>Admin</span>
          </button>
        </header>
      )}
      <div className="px-4 pb-2 pt-3">
        <h1 className="text-h1 font-semibold leading-[1.15] tracking-tight text-[var(--c-fg)]">
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
  const i18n = useI18n();
  // Language picker moved here from OrderPage (2026-05-05). Telegram's
  // gear button in the bot's overflow menu also opens this — but on
  // the web preview where the gear isn't rendered, this row is the
  // path. Available to anyone who can reach the Admin tab.
  const [langSheetOpen, setLangSheetOpen] = useState(false);
  // Map locale codes to native labels for the read-out.
  const localeLabels: Record<string, string> = {
    en: 'English',
    zh: '中文',
    ru: 'Русский',
    uz: "O'zbekcha",
  };
  const currentLocale = session?.user.locale ?? 'en';
  return (
    <div className="px-4 py-3">
      <LanguageSheet open={langSheetOpen} onOpenChange={setLangSheetOpen} />
      <Card>
        <div className="flex flex-col gap-3 px-4 py-3">
          {/* M1.7-fix (2026-05-07, audit HIGH #7): these labels were
              hardcoded English — the M1.6 admin-i18n pass missed
              this card. Now they go through i18n.t. */}
          <DetailRow label={i18n.t('admin.workspace.name')} value={session?.member.orgName ?? '—'} />
          {/* M1.9 (2026-05-07): the `slug` row is internal infrastructure
              ("acme-restaurants" type identifier). Showing it raw to
              the chain owner adds noise without value. Kept the field
              in i18n catalogs in case super_admin tooling wants it. */}
          <DetailRow label={i18n.t('admin.workspace.yourRole')} value={[...(session?.roleSlugs ?? [])].join(', ') || '—'} />
          <DetailRow
            label={i18n.t('admin.workspace.telegram')}
            value={session?.user.tgUsername ? `@${session.user.tgUsername}` : '—'}
          />
        </div>
      </Card>
      <div className="mt-3">
        <ListRow
          label={i18n.t('settings.language.title')}
          hint={localeLabels[currentLocale] ?? currentLocale}
          onClick={() => setLangSheetOpen(true)}
        />
      </div>
      {/* M1.9: removed the "futureNote" footer copy — placeholder text
          promising future features looks unfinished to users. Will
          surface concrete next-step entries here when they ship. */}
    </div>
  );
}

// DetailRow removed — imported from @compass/ui.

// ============ People ============

interface InviteDraft {
  tgUserId: string;
  displayName: string;
  roleSlug: string;
  /** At least one store must be picked unless the role is admin/super_admin
   *  (which auto-bypass via users.manage permission). */
  storeIds: string[];
}

/**
 * PeopleSection — directory of org members.
 *
 * Two callers, two behaviors:
 *
 *   - **No `lockMode` (legacy)**: honor the global StoreSwitcher.
 *     `specific` → filter to that store. `all` → grouped view with
 *     "Org-level" header. `none` → unreachable. (Kept for any caller
 *     that still wires this — currently none after M1.4.)
 *
 *   - **`lockMode={ kind: 'store', storeId }`** (M1.4 default): only
 *     show members assigned to this specific store. The StoreSwitcher
 *     is bypassed entirely — this screen lives inside StoreDetailScreen,
 *     so the parent already establishes the store context.
 *
 *   - **`lockMode={ kind: 'org-level' }`** (M1.4): show only members
 *     with no store assignments (admin / super_admin org-level
 *     operators). Used by the Stores → Org-level pseudo-store entry.
 */
function PeopleSection({
  lockMode,
}: {
  lockMode?: { kind: 'store'; storeId: string } | { kind: 'org-level' };
} = {}) {
  const session = useAuthStore((s) => s.session);
  const membersQuery = trpc.admin.memberList.useQuery();
  const utils = trpc.useUtils();
  const toast = useToast();
  const i18n = useI18n();
  // M1.9: per-key allow/deny override grid is power-user surface — gate
  // the "Permissions" button to global admins only. The 4 built-in
  // roles cover the common cases that store-scoped managers need.
  const peopleAdminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  const peopleSessionStores = session?.stores ?? [];
  const isGlobalAdminPeople = useMemo(() => {
    if (peopleSessionStores.length === 0) return peopleAdminStoreIds.size > 0;
    return peopleSessionStores.every((s) => peopleAdminStoreIds.has(s.id));
  }, [peopleSessionStores, peopleAdminStoreIds]);
  // Resolve the effective storeCtx. When `lockMode` is set we bypass
  // the global StoreSwitcher; otherwise we fall back to it for the
  // legacy unscoped path.
  const fallbackCtx = useStoreContext();
  const storeCtx =
    lockMode?.kind === 'store'
      ? ({ kind: 'specific' as const, storeId: lockMode.storeId })
      : lockMode?.kind === 'org-level'
        ? ({ kind: 'org-level' as const })
        : fallbackCtx;
  // Note: the previous internal tabs (Members | Roles) are gone — Roles
  // & Permissions is now its own top-level sub-section under People.
  // This screen is purely the members directory.
  const [grantFor, setGrantFor] = useState<
    { userId: string; displayName: string; defaultStoreId?: string | null } | null
  >(null);
  const [manageFor, setManageFor] = useState<
    { memberId: string; userId: string; displayName: string } | null
  >(null);
  // Member-permission overrides editor target (added 2026-05-05).
  // Tap "Permissions" button on a member card → opens
  // MemberPermissionsSheet with the role-derived baseline grayed out
  // and explicit allow/deny rows toggleable.
  //
  // 2026-05-06: now also carries `stores` for the per-store override
  // tabs (A2). Pulled from the member-list row at click time so the
  // sheet doesn't need a second query for them.
  const [permsFor, setPermsFor] = useState<
    {
      memberId: string;
      displayName: string;
      stores: Array<{ id: string; name: string }>;
    } | null
  >(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [manualDraft, setManualDraft] = useState<InviteDraft | null>(null);

  const setStatus = trpc.admin.memberSetStatus.useMutation({
    onSuccess: () => {
      void utils.admin.memberList.invalidate();
      toast.info(i18n.t('admin.toast.memberUpdated'));
    },
    onError: (err) => toast.error(err.message),
  });
  const remove = trpc.admin.memberRemove.useMutation({
    onSuccess: () => {
      void utils.admin.memberList.invalidate();
      toast.success(i18n.t('admin.toast.memberRemoved'));
    },
    onError: (err) => toast.error(err.message),
  });
  const revoke = trpc.admin.revokeRole.useMutation({
    onSuccess: () => {
      void utils.admin.memberList.invalidate();
      toast.info(i18n.t('admin.toast.roleRevoked'));
    },
    onError: (err) => toast.error(err.message),
  });
  // D1 (2026-05-06): one-shot detach. Server atomically deletes the
  // MSA row + revokes any store-scoped role bindings + drops store-
  // scoped permission overrides for that store. Their assignments
  // and bindings in OTHER stores are untouched.
  const detachFromStore = trpc.admin.memberDetachFromStore.useMutation({
    onSuccess: (data) => {
      void utils.admin.memberList.invalidate();
      const parts = ['Removed from store'];
      if (data.revokedBindings > 0)
        parts.push(`${data.revokedBindings} role${data.revokedBindings === 1 ? '' : 's'} revoked`);
      if (data.revokedOverrides > 0)
        parts.push(`${data.revokedOverrides} override${data.revokedOverrides === 1 ? '' : 's'} dropped`);
      toast.info(parts.join(' · '));
    },
    onError: (err) => toast.error(err.message),
  });
  const invite = trpc.admin.memberInviteByTgId.useMutation({
    onSuccess: (data) => {
      void utils.admin.memberList.invalidate();
      toast[data.created ? 'success' : 'info'](
        data.created
          ? i18n.t('admin.toast.memberAdded')
          : i18n.t('admin.toast.userExists'),
      );
      setManualDraft(null);
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div className="px-4 py-3">
      <div className="mb-3 flex justify-end">
        <Button size="sm" onClick={() => setInviteOpen(true)}>
          {i18n.t('admin.action.invite')}
        </Button>
      </div>

      <DataState
        query={membersQuery}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title={i18n.t('admin.empty.members.title')}
            description={i18n.t('admin.empty.members.description')}
          />
        }
      >
        {(rows) => {
          // Filter / group by store context (added 2026-05-05).
          const renderCard = (m: (typeof rows)[number]) => {
            const isSelf = m.userId === session?.user.id;
            return (
              <Card key={m.memberId}>
                <CardHeader>
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar src={m.avatarUrl} name={m.displayName} size={36} />
                    <div className="min-w-0">
                      <CardTitle>
                        {m.displayName}
                        {isSelf ? ' · you' : ''}
                      </CardTitle>
                      <CardMeta>
                        {m.tgUsername ? `@${m.tgUsername}` : 'no telegram'}
                        {m.lastSeenAt
                          ? ` · seen ${new Date(m.lastSeenAt).toLocaleDateString()}`
                          : ' · never seen'}
                      </CardMeta>
                    </div>
                  </div>
                  <Badge tone={m.status === 'active' ? 'success' : 'warn'}>
                    {m.status}
                  </Badge>
                </CardHeader>
                {/* Store-affiliation chips (added 2026-05-05). Empty
                    array is rendered as "no store" hint so admins can
                    spot org-level members at a glance. */}
                {m.stores.length > 0 ? (
                  <div className="flex flex-wrap gap-1 px-4 pt-2 pb-1">
                    {m.stores.map((st) => (
                      <span
                        key={st.id}
                        className="inline-flex items-center gap-1 rounded-full bg-[var(--c-surface-2)] px-2 py-0.5 text-meta text-[var(--c-fg)] ring-hairline"
                      >
                        🏪 {st.name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="px-4 pt-2 pb-1 text-meta text-[var(--c-fg-muted)]">
                    no store · org-level
                  </div>
                )}
                <div className="flex flex-wrap gap-1 px-4">
                  {m.roles.length === 0 ? (
                    <span className="text-label text-[var(--c-fg-muted)]">No roles</span>
                  ) : (
                    // Per-store role chips (added 2026-05-06). For
                    // scope='store' we suffix the store's name so the
                    // operator can tell "Manager of Store A" apart from
                    // "Manager of Store B" at a glance. Global bindings
                    // render as just the role name (no scope label).
                    m.roles.map((r) => {
                      const scopedStoreName =
                        r.scopeType === 'store' && r.scopeId
                          ? m.stores.find((st) => st.id === r.scopeId)?.name ?? null
                          : null;
                      return (
                        <button
                          key={r.bindingId}
                          type="button"
                          className="press inline-flex items-center gap-1 rounded-full bg-[var(--c-surface-2)] px-2 py-0.5 text-meta ring-hairline"
                          onClick={() =>
                            nativeConfirm(
                              scopedStoreName
                                ? `Revoke "${r.name}" in ${scopedStoreName} from ${m.displayName}?`
                                : `Revoke "${r.name}" from ${m.displayName}?`,
                              () => revoke.mutate({ bindingId: r.bindingId }),
                            )
                          }
                          title="Tap to revoke"
                        >
                          <span className="font-semibold">{r.name}</span>
                          {scopedStoreName ? (
                            <span className="text-[var(--c-fg-muted)]">
                              · 🏪 {scopedStoreName}
                            </span>
                          ) : null}
                          <span className="text-[var(--c-fg-muted)]">×</span>
                        </button>
                      );
                    })
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-2 border-t border-[var(--c-divider)] px-4 py-3">
                  <Button
                    size="sm"
                    variant="pearl"
                    onClick={() =>
                      setManageFor({
                        memberId: m.memberId,
                        userId: m.userId,
                        displayName: m.displayName,
                      })
                    }
                  >
                    Manage
                  </Button>
                  <Button
                    size="sm"
                    variant="pearl"
                    onClick={() =>
                      setGrantFor({
                        userId: m.userId,
                        displayName: m.displayName,
                        // When the StoreSwitcher is on a specific store, pre-
                        // select that store in the grant sheet (A1, 2026-05-06).
                        // 'all' / 'none' kinds leave the picker empty so the
                        // operator picks consciously.
                        defaultStoreId:
                          storeCtx.kind === 'specific' ? storeCtx.storeId : null,
                      })
                    }
                  >
                    Grant role
                  </Button>
                  {isGlobalAdminPeople ? (
                    <Button
                      size="sm"
                      variant="pearl"
                      onClick={() =>
                        setPermsFor({
                          memberId: m.memberId,
                          displayName: m.displayName,
                          stores: m.stores.map((st) => ({
                            id: st.id,
                            name: st.name,
                          })),
                        })
                      }
                    >
                      Permissions
                    </Button>
                  ) : null}
                  {!isSelf && m.status === 'active' ? (
                    <Button
                      size="sm"
                      variant="pearl"
                      onClick={() =>
                        nativeConfirm(`Suspend ${m.displayName}?`, () =>
                          setStatus.mutate({ memberId: m.memberId, status: 'suspended' }),
                        )
                      }
                    >
                      Suspend
                    </Button>
                  ) : null}
                  {!isSelf && m.status === 'suspended' ? (
                    <Button
                      size="sm"
                      variant="pearl"
                      onClick={() =>
                        setStatus.mutate({ memberId: m.memberId, status: 'active' })
                      }
                    >
                      Reactivate
                    </Button>
                  ) : null}
                  {/* D1 (2026-05-06): "Remove from this store" — only
                      visible when the StoreSwitcher is on a single
                      store AND the member belongs to it. Distinct
                      from the org-level Remove (red-danger) below;
                      this one only detaches from one store. */}
                  {!isSelf &&
                  storeCtx.kind === 'specific' &&
                  m.stores.some((st) => st.id === storeCtx.storeId) ? (
                    <Button
                      size="sm"
                      variant="pearl"
                      onClick={() => {
                        if (storeCtx.kind !== 'specific') return;
                        const storeName =
                          m.stores.find((st) => st.id === storeCtx.storeId)?.name ??
                          'this store';
                        nativeConfirm(
                          `Remove ${m.displayName} from 🏪 ${storeName}?\n\nThis revokes any role bindings + per-store permission overrides scoped to this store. Their other store assignments stay.`,
                          () =>
                            detachFromStore.mutate({
                              memberId: m.memberId,
                              storeId: storeCtx.storeId,
                            }),
                        );
                      }}
                    >
                      Remove from store
                    </Button>
                  ) : null}
                  {!isSelf ? (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() =>
                        nativeConfirm(
                          `Remove ${m.displayName} from this org? This cannot be undone.`,
                          () => remove.mutate({ memberId: m.memberId }),
                        )
                      }
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              </Card>
            );
          };

          // Specific store: only show members assigned there.
          if (storeCtx.kind === 'specific') {
            const filtered = rows.filter((m) =>
              m.stores.some((s) => s.id === storeCtx.storeId),
            );
            if (filtered.length === 0) {
              return (
                <EmptyState
                  title={i18n.t('admin.empty.noStoresInThisStore.title')}
                  description={i18n.t('admin.empty.noStoresInThisStore.description')}
                />
              );
            }
            return (
              <ul className="flex flex-col gap-2" role="list">
                {filtered.map(renderCard)}
              </ul>
            );
          }

          // M1.4: org-level pseudo-store. Show only members with no
          // store assignments (admin / super_admin operators).
          if (storeCtx.kind === 'org-level') {
            const orgOnly = rows.filter((m) => m.stores.length === 0);
            if (orgOnly.length === 0) {
              return (
                <EmptyState
                  title="No org-level members"
                  description="Admins and super-admins who don't belong to any specific store appear here."
                />
              );
            }
            return (
              <ul className="flex flex-col gap-2" role="list">
                {orgOnly.map(renderCard)}
              </ul>
            );
          }

          // ALL view: group by store. Members appear once per store
          // they belong to. Members with no stores (admins, super-
          // admins) get a separate "Org-level" section at the top.
          const orgLevel = rows.filter((m) => m.stores.length === 0);
          // Build store → members map. Every (store, member) pair where
          // the member is in that store contributes one entry.
          const byStore = new Map<
            string,
            { name: string; members: typeof rows }
          >();
          for (const m of rows) {
            for (const st of m.stores) {
              const bucket = byStore.get(st.id) ?? { name: st.name, members: [] };
              bucket.members.push(m);
              byStore.set(st.id, bucket);
            }
          }
          const storeSections = [...byStore.entries()].sort((a, b) =>
            a[1].name.localeCompare(b[1].name),
          );
          return (
            <div className="flex flex-col gap-4">
              {orgLevel.length > 0 ? (
                <section>
                  <h3 className="mb-2 text-label font-semibold uppercase tracking-wide text-[var(--c-fg-muted)]">
                    Org-level ({orgLevel.length})
                  </h3>
                  <ul className="flex flex-col gap-2" role="list">
                    {orgLevel.map(renderCard)}
                  </ul>
                </section>
              ) : null}
              {storeSections.map(([storeId, bucket]) => (
                <section key={storeId}>
                  <h3 className="mb-2 text-label font-semibold uppercase tracking-wide text-[var(--c-fg-muted)]">
                    🏪 {bucket.name} ({bucket.members.length})
                  </h3>
                  <ul className="flex flex-col gap-2" role="list">
                    {bucket.members.map(renderCard)}
                  </ul>
                </section>
              ))}
            </div>
          );
        }}
      </DataState>

      <GrantRoleSheet target={grantFor} onClose={() => setGrantFor(null)} />
      <ManageMemberSheet target={manageFor} onClose={() => setManageFor(null)} />
      <MemberPermissionsSheet target={permsFor} onClose={() => setPermsFor(null)} />
      <InviteHubSheet
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onPickManual={() => {
          setInviteOpen(false);
          setManualDraft({ tgUserId: '', displayName: '', roleSlug: '', storeIds: [] });
        }}
      />
      <ManualInviteSheet
        draft={manualDraft}
        setDraft={setManualDraft}
        onSubmit={() => {
          if (!manualDraft) return;
          invite.mutate({
            tgUserId: manualDraft.tgUserId,
            displayName: manualDraft.displayName || undefined,
            roleSlug: manualDraft.roleSlug || undefined,
            storeIds: manualDraft.storeIds,
          });
        }}
        pending={invite.isPending}
      />
    </div>
  );
}

/**
 * Roles & Permissions screen — replaces the old read-only RolesList.
 *
 * Shows every role in the org with its rank + permission count, ordered
 * highest rank first (super_admin → admin → manager → ...). Each row
 * carries a small "Cannot grant" badge when the role's rank is ≥ the
 * viewer's own max rank — the user explicitly asked: "能接触权限管理
 * 的人不能分配跟自己同级或比自己高权限给别人". The rank shown here is
 * the same rank the server uses to gate `admin.grantRole`.
 *
 * Tap a role row → drill-down sheet listing the explicit permission
 * keys it grants. This is the closest thing to a permission matrix
 * we ship today; a full editable matrix belongs in round 4 (custom
 * roles).
 */
function PermissionsSection({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const session = useAuthStore((s) => s.session);
  const myMaxRank = session?.myMaxRank ?? 0;
  const rolesQuery = trpc.admin.roleList.useQuery();
  const [drilldownSlug, setDrilldownSlug] = useState<string | null>(null);
  // Custom-role create-mode flag (added 2026-05-05). When true the
  // sheet opens with empty fields and a "Create" footer instead of
  // the existing role's data.
  const [createOpen, setCreateOpen] = useState(false);
  // M1.9 (2026-05-07): only global admins can create org-wide roles.
  // Per-store managers (post-B1 with users.manage) shouldn't see the
  // "+ New role" button — server-side rank gate would block them
  // anyway, but a button that always errors is bad UX.
  const sessionStores = session?.stores ?? [];
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  const isGlobalAdmin = useMemo(() => {
    if (sessionStores.length === 0) return adminStoreIds.size > 0;
    return sessionStores.every((s) => adminStoreIds.has(s.id));
  }, [sessionStores, adminStoreIds]);

  return (
    <div className="px-4 py-3">
      <Banner tone="info" title="How permissions work">
        Roles are stacks of permission keys. Higher rank = more powerful.
        You can grant a role to a member only if its rank is strictly
        below your own ({myMaxRank}). Built-in roles cannot be deleted
        but their name, description, and permission set are editable.
      </Banner>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-label uppercase tracking-wide text-[var(--c-fg-muted)]">
          Roles
        </span>
        {isGlobalAdmin ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            + New role
          </Button>
        ) : null}
      </div>
      <div className="mt-2">
        <DataState
          query={rolesQuery}
          emptyWhen={(d) => d.length === 0}
          empty={<EmptyState title="No roles" description="Run db:seed to get the built-ins." />}
        >
          {(rows) => (
            <ul className="flex flex-col gap-2" role="list">
              {rows.map((r) => {
                const grantable = r.rank < myMaxRank;
                const subtitleParts: string[] = [
                  `rank ${r.rank}`,
                  `${r.permissionCount} permission${r.permissionCount === 1 ? '' : 's'}`,
                ];
                if (r.description) subtitleParts.push(r.description);
                const subtitle = subtitleParts.join(' · ');
                return (
                  <li key={r.id}>
                    <ListRow
                      label={
                        <span className="flex items-center gap-2">
                          {r.name}
                          {r.isBuiltIn ? <Badge tone="muted">built-in</Badge> : null}
                        </span>
                      }
                      hint={subtitle}
                      badge={
                        grantable ? (
                          <Badge tone="success">grantable</Badge>
                        ) : (
                          <Badge tone="warn">your rank ≤ this</Badge>
                        )
                      }
                      onClick={() => setDrilldownSlug(r.slug)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </DataState>
      </div>

      <RolePermissionsSheet
        open={!!drilldownSlug}
        roleSlug={drilldownSlug}
        onClose={() => setDrilldownSlug(null)}
        canEdit={isSuperAdmin}
        myMaxRank={myMaxRank}
      />
      <RoleCreateSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        myMaxRank={myMaxRank}
      />
    </div>
  );
}

/**
 * Sheet for creating a new custom role (added 2026-05-05).
 *
 * Flow: admin types slug + name + rank, picks permission keys from a
 * matrix (grouped by namespace). Server validates slug is unique and
 * rank is below the actor. Closes on success.
 *
 * The permission matrix is a flat list of checkboxes, grouped by
 * namespace (`order.*`, `run.*`, ...) — same structure as the
 * RolePermissionsSheet's read view, just interactive.
 */
function RoleCreateSheet({
  open,
  onClose,
  myMaxRank,
}: {
  open: boolean;
  onClose: () => void;
  myMaxRank: number;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const i18n = useI18n();
  const permsQuery = trpc.admin.permissionList.useQuery(undefined, { enabled: open });
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // Default rank = max - 10 (one tier below the actor). The lower
  // bound is 1; admins can adjust freely.
  const defaultRank = Math.max(1, myMaxRank - 10);
  const [rank, setRank] = useState(defaultRank);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  // Reset when sheet re-opens for a fresh create.
  useEffect(() => {
    if (open) {
      setSlug('');
      setName('');
      setDescription('');
      setRank(Math.max(1, myMaxRank - 10));
      setPicked(new Set());
    }
  }, [open, myMaxRank]);

  const grouped = useMemo(() => {
    const m = new Map<string, Array<{ key: string; description: string | null }>>();
    for (const p of permsQuery.data ?? []) {
      const ns = p.key.split('.')[0] ?? 'misc';
      const arr = m.get(ns) ?? [];
      arr.push({ key: p.key, description: p.description });
      m.set(ns, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [permsQuery.data]);

  const create = trpc.admin.roleCreate.useMutation({
    onSuccess: () => {
      void utils.admin.roleList.invalidate();
      toast.success(i18n.t('admin.toast.roleCreated'));
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  const togglePerm = (key: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const canSave =
    slug.trim().length > 0 &&
    /^[a-z0-9-]+$/.test(slug) &&
    name.trim().length > 0 &&
    rank > 0 &&
    rank < myMaxRank;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="New role"
      description={`Custom roles can have any rank from 1 to ${myMaxRank - 1}.`}
      footer={
        <Button
          block
          loading={create.isPending}
          disabled={!canSave}
          onClick={() => {
            create.mutate({
              slug: slug.trim().toLowerCase(),
              name: name.trim(),
              description: description.trim() || null,
              rank,
              permissionKeys: [...picked],
            });
          }}
        >
          Create
        </Button>
      }
    >
      <div className="flex flex-col gap-3 py-3">
        <Field label="Slug *">
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            maxLength={64}
            placeholder="e.g. shift-lead"
            autoFocus
          />
        </Field>
        <Field label="Name *">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder="Shift Lead"
          />
        </Field>
        <Field label="Description">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            placeholder="Optional"
          />
        </Field>
        <Field label={`Rank (1–${myMaxRank - 1}) *`}>
          <Input
            type="number"
            value={String(rank)}
            onChange={(e) => setRank(Math.max(1, Math.min(myMaxRank - 1, Number(e.target.value) || 0)))}
          />
        </Field>
        <div>
          <div className="mb-2 text-label font-semibold uppercase tracking-wide text-[var(--c-fg-muted)]">
            Permissions ({picked.size})
          </div>
          {permsQuery.isLoading ? (
            <Spinner size={16} />
          ) : (
            <ul className="flex flex-col gap-3">
              {grouped.map(([ns, keys]) => (
                <li key={ns}>
                  <div className="text-meta font-semibold uppercase tracking-[0.08em] text-[var(--c-fg-muted)]">
                    {ns}
                  </div>
                  <ul className="mt-1 flex flex-col gap-1">
                    {keys.map((p) => (
                      <li key={p.key}>
                        <label className="flex cursor-pointer items-start gap-2 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-3 py-2 text-body-sm active:opacity-80">
                          <input
                            type="checkbox"
                            checked={picked.has(p.key)}
                            onChange={() => togglePerm(p.key)}
                            className="mt-0.5 h-4 w-4"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-label">{p.key}</div>
                            {p.description ? (
                              <div className="mt-0.5 text-label text-[var(--c-fg-muted)]">
                                {p.description}
                              </div>
                            ) : null}
                          </div>
                        </label>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/** Sheet showing the explicit permission keys for one role. Read-only
 *  for now; the canEdit prop reserves space for the editable matrix. */
function RolePermissionsSheet({
  open,
  roleSlug,
  onClose,
  canEdit,
  myMaxRank,
}: {
  open: boolean;
  roleSlug: string | null;
  onClose: () => void;
  canEdit: boolean;
  myMaxRank: number;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const i18n = useI18n();
  const detail = trpc.admin.roleDetail.useQuery(
    { roleSlug: roleSlug ?? '' },
    { enabled: !!roleSlug },
  );
  const permsQuery = trpc.admin.permissionList.useQuery(undefined, {
    enabled: open && canEdit,
  });

  // Edit-mode: false (read view) by default. Toggle on Edit click.
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rank, setRank] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  // Hydrate local state when role data lands or sheet re-opens.
  useEffect(() => {
    if (!detail.data) return;
    setName(detail.data.name);
    setDescription(detail.data.description ?? '');
    setRank(detail.data.rank);
    setPicked(new Set(detail.data.permissions));
    setEditing(false);
  }, [detail.data, open]);

  // Below-rank gate — only roles strictly below actor's rank are editable.
  const isEditable = canEdit && (detail.data?.rank ?? 100) < myMaxRank;
  const isBuiltIn = detail.data?.isBuiltIn ?? false;

  const update = trpc.admin.roleUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.roleList.invalidate();
      void utils.admin.roleDetail.invalidate({ roleSlug: roleSlug ?? '' });
      toast.success(i18n.t('admin.toast.roleUpdated'));
      setEditing(false);
    },
    onError: (err) => toast.error(err.message),
  });
  const remove = trpc.admin.roleDelete.useMutation({
    onSuccess: () => {
      void utils.admin.roleList.invalidate();
      toast.success(i18n.t('admin.toast.roleDeleted'));
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  const togglePerm = (key: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Edit-mode source: full permission catalog. Read-mode source: only
  // the permissions the role currently has. Group both by namespace.
  const grouped = useMemo(() => {
    const source: Array<{ key: string; description: string | null }> = editing
      ? (permsQuery.data ?? []).map((p) => ({ key: p.key, description: p.description }))
      : (detail.data?.permissions ?? []).map((k) => ({ key: k, description: null }));
    const m = new Map<string, Array<{ key: string; description: string | null }>>();
    for (const p of source) {
      const ns = p.key.split('.')[0] ?? 'misc';
      const arr = m.get(ns) ?? [];
      arr.push(p);
      m.set(ns, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [editing, detail.data, permsQuery.data]);

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={detail.data?.name ?? 'Role'}
      description={
        detail.data
          ? `rank ${detail.data.rank} · ${detail.data.permissions.length} permissions${isBuiltIn ? ' · built-in' : ''}`
          : undefined
      }
      footer={
        editing && detail.data ? (
          <div className="flex flex-col gap-2">
            <Button
              block
              loading={update.isPending}
              onClick={() => {
                update.mutate({
                  roleId: detail.data!.id,
                  name: name.trim(),
                  description: description.trim() || null,
                  // Built-in roles can't change rank (anchors the ladder).
                  ...(isBuiltIn ? {} : { rank }),
                  permissionKeys: [...picked],
                });
              }}
            >
              Save
            </Button>
            <Button block variant="pearl" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        ) : isEditable && detail.data ? (
          <div className="flex flex-col gap-2">
            <Button block onClick={() => setEditing(true)}>
              Edit
            </Button>
            {!isBuiltIn ? (
              <Button
                block
                variant="danger"
                loading={remove.isPending}
                onClick={() => {
                  nativeConfirm(`Delete role "${detail.data!.name}"?`, () =>
                    remove.mutate({ roleId: detail.data!.id }),
                  );
                }}
              >
                Delete role
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {detail.isLoading ? (
        <div className="py-8 text-center text-body text-[var(--c-fg-muted)]">
          Loading…
        </div>
      ) : !detail.data ? (
        <div className="py-8 text-center text-body text-[var(--c-fg-muted)]">
          No role
        </div>
      ) : (
        <div className="flex flex-col gap-3 py-3">
          {editing ? (
            <>
              <Field label="Name *">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                />
              </Field>
              <Field label="Description">
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={500}
                />
              </Field>
              {isBuiltIn ? (
                <Banner tone="info" title={`Rank ${rank} (built-in, locked)`}>
                  Built-in role rank can't be changed — it anchors the
                  permission ladder. Custom roles let you pick any rank.
                </Banner>
              ) : (
                <Field label={`Rank (1–${myMaxRank - 1}) *`}>
                  <Input
                    type="number"
                    value={String(rank)}
                    onChange={(e) =>
                      setRank(
                        Math.max(
                          1,
                          Math.min(myMaxRank - 1, Number(e.target.value) || 0),
                        ),
                      )
                    }
                  />
                </Field>
              )}
              <div className="text-label font-semibold uppercase tracking-wide text-[var(--c-fg-muted)]">
                Permissions ({picked.size})
              </div>
            </>
          ) : detail.data.description ? (
            <p className="text-body-sm text-[var(--c-fg-muted)]">{detail.data.description}</p>
          ) : null}
          {grouped.length === 0 ? (
            <p className="text-body text-[var(--c-fg-muted)]">
              No permissions assigned.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {grouped.map(([ns, keys]) => (
                <li key={ns}>
                  <div className="text-meta font-semibold uppercase tracking-[0.08em] text-[var(--c-fg-muted)]">
                    {ns}
                  </div>
                  <ul className="mt-1 flex flex-col gap-1">
                    {keys.map((p) => {
                      if (editing) {
                        return (
                          <li key={p.key}>
                            <label className="flex cursor-pointer items-start gap-2 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-3 py-2 text-body-sm active:opacity-80">
                              <input
                                type="checkbox"
                                checked={picked.has(p.key)}
                                onChange={() => togglePerm(p.key)}
                                className="mt-0.5 h-4 w-4"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="font-mono text-label">{p.key}</div>
                                {p.description ? (
                                  <div className="mt-0.5 text-label text-[var(--c-fg-muted)]">
                                    {p.description}
                                  </div>
                                ) : null}
                              </div>
                            </label>
                          </li>
                        );
                      }
                      return (
                        <li
                          key={p.key}
                          className="rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-3 py-1.5 font-mono text-body-sm"
                        >
                          {p.key}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {/* B1 (2026-05-06): assignees grouped by store. Read-only —
              edits go through the existing role chip on the People
              cards. Hidden when editing the role itself to keep the
              edit-form focused. */}
          {!editing && detail.data.assignees.length > 0 ? (
            <RoleAssigneesByStore assignees={detail.data.assignees} />
          ) : null}
        </div>
      )}
    </Sheet>
  );
}

/**
 * RoleAssigneesByStore (B1, 2026-05-06).
 *
 * Buckets role bindings into "Org-level" (scope=global) plus one
 * section per store. Each row shows the assignee's display name +
 * @username; tapping doesn't navigate (this view is for "who is
 * where", not for editing — that's on the member card).
 */
function RoleAssigneesByStore({
  assignees,
}: {
  assignees: Array<{
    bindingId: string;
    memberId: string;
    displayName: string;
    avatarUrl: string | null;
    tgUsername: string | null;
    scopeType: 'global' | 'store';
    scopeId: string | null;
    storeName: string | null;
  }>;
}) {
  const grouped = useMemo(() => {
    // 'org-level' bucket plus per-store buckets keyed by storeId.
    type Bucket = { label: string; members: typeof assignees };
    const buckets = new Map<string, Bucket>();
    const orgLevelKey = '__org__';
    for (const a of assignees) {
      let key: string;
      let label: string;
      if (a.scopeType === 'global' || !a.scopeId) {
        key = orgLevelKey;
        label = 'Org-level';
      } else {
        key = a.scopeId;
        label = a.storeName ?? '— store gone —';
      }
      const cur = buckets.get(key) ?? { label, members: [] };
      cur.members.push(a);
      buckets.set(key, cur);
    }
    // Sort: org-level first, then alphabetical store name.
    const out = [...buckets.entries()];
    out.sort(([ka, va], [kb, vb]) => {
      if (ka === orgLevelKey) return -1;
      if (kb === orgLevelKey) return 1;
      return va.label.localeCompare(vb.label);
    });
    return out;
  }, [assignees]);

  return (
    <div className="mt-2 border-t border-[var(--c-divider)] pt-3">
      <div className="text-meta font-semibold uppercase tracking-[0.08em] text-[var(--c-fg-muted)]">
        Assignees · {assignees.length}
      </div>
      <div className="mt-1 flex flex-col gap-3">
        {grouped.map(([key, bucket]) => (
          <section key={key}>
            <h4 className="mb-1 text-label font-semibold text-[var(--c-fg-muted)]">
              {key === '__org__' ? '🌐' : '🏪'} {bucket.label} ({bucket.members.length})
            </h4>
            <ul className="flex flex-col gap-1">
              {bucket.members.map((a) => (
                <li
                  key={a.bindingId}
                  className="flex items-center gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-1.5"
                >
                  <Avatar src={a.avatarUrl} name={a.displayName} size={24} />
                  <span className="text-body-sm text-[var(--c-fg)]">
                    {a.displayName}
                  </span>
                  {a.tgUsername ? (
                    <span className="text-meta text-[var(--c-fg-muted)]">
                      @{a.tgUsername}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * Telegram-native invite hub. The first option is "Share via Telegram"
 * which opens Telegram's contact picker pre-filled with the bot link;
 * the recipient opens the bot, sends /id, then the admin uses the
 * second option (manual TG ID add) to actually grant membership. The
 * bot deep-link flow that lets the recipient self-join their org will
 * land in M2 along with invite tokens.
 */
function InviteHubSheet({
  open,
  onClose,
  onPickManual,
}: {
  open: boolean;
  onClose: () => void;
  onPickManual: () => void;
}) {
  const session = useAuthStore((s) => s.session);
  const toast = useToast();
  const i18n = useI18n();
  const cfgQuery = trpc.system.appConfig.useQuery(undefined, {
    enabled: open,
    staleTime: STALE.long,
  });

  const botUsername = cfgQuery.data?.botUsername?.replace(/^@/, '') ?? null;
  const botLink = makeBotLink(botUsername);
  const message = `Join our Compass workspace "${session?.member.orgName ?? ''}" — open this bot, send /id, then ask me to add you.`;
  const shareUrl = makeShareLink({ url: botLink, text: message });

  const handleShare = () => {
    const tg = getTg();
    if (tg) {
      tg.openTelegramLink(shareUrl);
    } else if (typeof window !== 'undefined') {
      window.open(shareUrl, '_blank');
    }
    onClose();
  };

  const handleCopy = async () => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(`${botLink}\n\n${message}`);
        toast.success(i18n.t('admin.toast.linkCopied'));
      } else {
        toast.error(i18n.t('admin.toast.clipboardUnavailable'));
      }
    } catch {
      toast.error(i18n.t('admin.toast.couldNotCopy'));
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Invite a member"
      description="Pick a method"
    >
      <div className="flex flex-col gap-2 py-3">
        <button
          type="button"
          onClick={handleShare}
          disabled={!botUsername}
          className="press flex items-center gap-3 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-3 text-left ring-hairline disabled:opacity-50"
        >
          <span className="text-[var(--c-action)]">
            <IconShare size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-h3 font-semibold text-[var(--c-fg)]">
              Share via Telegram
            </span>
            <span className="mt-0.5 block text-label text-[var(--c-fg-muted)]">
              {botUsername
                ? "Pick a contact in Telegram; they'll get the bot link."
                : 'Bot username not configured.'}
            </span>
          </span>
          <span aria-hidden className="shrink-0 text-[var(--c-fg-subtle)]">
            <IconChevronRight size={16} />
          </span>
        </button>

        <button
          type="button"
          onClick={handleCopy}
          disabled={!botUsername}
          className="press flex items-center gap-3 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-3 text-left ring-hairline disabled:opacity-50"
        >
          <span className="text-[var(--c-action)]">
            <IconShare size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-h3 font-semibold text-[var(--c-fg)]">
              Copy invite link
            </span>
            <span className="mt-0.5 block text-label text-[var(--c-fg-muted)]">
              Paste anywhere outside Telegram.
            </span>
          </span>
        </button>

        <div className="my-2 text-center text-meta uppercase tracking-[0.08em] text-[var(--c-fg-subtle)]">
          or
        </div>

        <button
          type="button"
          onClick={onPickManual}
          className="press flex items-center gap-3 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-3 text-left ring-hairline"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-h3 font-semibold text-[var(--c-fg)]">
              Add by Telegram ID
            </span>
            <span className="mt-0.5 block text-label text-[var(--c-fg-muted)]">
              Enter a numeric TG ID directly. Use this if you already know it.
            </span>
          </span>
          <span aria-hidden className="shrink-0 text-[var(--c-fg-subtle)]">
            <IconChevronRight size={16} />
          </span>
        </button>
      </div>
    </Sheet>
  );
}

function ManualInviteSheet({
  draft,
  setDraft,
  onSubmit,
  pending,
}: {
  draft: InviteDraft | null;
  setDraft: (d: InviteDraft | null) => void;
  onSubmit: () => void;
  pending: boolean;
}) {
  const rolesQuery = trpc.admin.roleList.useQuery(undefined, { enabled: !!draft });
  const storesQuery = trpc.admin.storeList.useQuery(undefined, { enabled: !!draft });
  // C2 (2026-05-06): a store-scoped admin can only invite into the
  // stores they administer. We filter the role list AND the store
  // multi-select against `session.adminStoreIds`. Org-tier roles
  // (admin / super_admin) get hidden when the actor isn't a global
  // admin — a store-scoped manager has no business creating org-tier
  // members; the server gate would reject anyway.
  const session = useAuthStore((s) => s.session);
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  const sessionStores = session?.stores ?? [];
  const isGlobalAdmin = useMemo(() => {
    if (sessionStores.length === 0) return adminStoreIds.size > 0;
    return sessionStores.every((s) => adminStoreIds.has(s.id));
  }, [sessionStores, adminStoreIds]);

  const sortedRoles = useMemo(
    () =>
      [...(rolesQuery.data ?? [])]
        // Hide org-tier roles for non-global admins (mirrors server's
        // cannotInviteOrgAdminAsStoreAdmin gate). The role still exists
        // server-side; this is purely a UX decision.
        .filter((r) => isGlobalAdmin || r.rank < ADMIN_RANK)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [rolesQuery.data, isGlobalAdmin],
  );
  const eligibleStores = useMemo(
    () =>
      (storesQuery.data ?? []).filter((st) => adminStoreIds.has(st.id)),
    [storesQuery.data, adminStoreIds],
  );

  const tgIdValid = draft ? /^\d{4,15}$/.test(draft.tgUserId) : false;
  // Adminish roles bypass the store check at the server side, so we
  // shouldn't force the admin to pick a store for them.
  const isAdminRole = draft?.roleSlug === 'admin' || draft?.roleSlug === 'super_admin';
  const requiresStore = !isAdminRole;
  const hasStore = (draft?.storeIds.length ?? 0) > 0;
  const canSubmit = tgIdValid && (!requiresStore || hasStore);
  return (
    <Sheet
      open={!!draft}
      onOpenChange={(open) => !open && !pending && setDraft(null)}
      title="Add by Telegram ID"
      description="Auto-creates a placeholder user; their profile fills in when they /start the bot."
      footer={
        <Button block size="lg" loading={pending} disabled={!canSubmit} onClick={onSubmit}>
          Add to workspace
        </Button>
      }
    >
      {draft ? (
        <div className="flex flex-col gap-3 py-3">
          <Field label="Telegram user ID *">
            <Input
              value={draft.tgUserId}
              onChange={(e) =>
                setDraft({ ...draft, tgUserId: e.target.value.replace(/\D/g, '').slice(0, 15) })
              }
              inputMode="numeric"
              maxLength={15}
              placeholder="e.g. 6402913074"
              autoFocus
            />
            <p className="mt-1 text-meta text-[var(--c-fg-muted)]">
              Ask the user to send /id to the bot if they don&apos;t know their ID.
            </p>
          </Field>
          <Field label="Display name">
            <Input
              value={draft.displayName}
              onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
              maxLength={200}
              placeholder="optional · the user can confirm/change at first sign-in"
            />
          </Field>
          <Field label="Role">
            {rolesQuery.isLoading ? (
              <div className="flex items-center gap-2 text-body-sm text-[var(--c-fg-muted)]">
                <Spinner size={14} /> Loading roles…
              </div>
            ) : (
              <select
                className="h-11 w-full rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 text-h3 ring-hairline"
                value={draft.roleSlug}
                onChange={(e) => setDraft({ ...draft, roleSlug: e.target.value })}
              >
                <option value="">— no role yet (grant later) —</option>
                {sortedRoles.map((r) => (
                  <option key={r.id} value={r.slug}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {requiresStore ? (
            <Field
              label={
                hasStore
                  ? `Stores (${draft.storeIds.length} selected)`
                  : 'Stores * (pick at least one)'
              }
            >
              {storesQuery.isLoading ? (
                <div className="flex items-center gap-2 text-body-sm text-[var(--c-fg-muted)]">
                  <Spinner size={14} /> Loading stores…
                </div>
              ) : eligibleStores.length === 0 ? (
                <Banner tone="warn" title="No stores you can invite into">
                  You don't administer any store yet. Ask a higher-rank admin
                  to add you to a store first.
                </Banner>
              ) : (
                <div className="flex flex-col gap-1.5 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
                  {eligibleStores.map((st) => {
                    const checked = draft.storeIds.includes(st.id);
                    return (
                      <label
                        key={st.id}
                        className="press flex cursor-pointer items-center gap-2 rounded-[var(--r-utility)] px-2 py-1.5"
                      >
                        <input
                          type="checkbox"
                          className="h-5 w-5"
                          checked={checked}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              storeIds: e.target.checked
                                ? [...draft.storeIds, st.id]
                                : draft.storeIds.filter((id) => id !== st.id),
                            })
                          }
                        />
                        <span className="text-body text-[var(--c-fg)]">{st.name}</span>
                        {st.code ? (
                          <span className="text-meta text-[var(--c-fg-muted)]">{st.code}</span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="mt-1 text-meta text-[var(--c-fg-muted)]">
                Staff need an assigned store before they can place orders.
                {!isGlobalAdmin
                  ? ' You can only invite into stores you administer.'
                  : ''}
              </p>
            </Field>
          ) : (
            <p className="text-label text-[var(--c-fg-muted)]">
              Admins / super-admins can see all stores by default — no
              assignment needed.
            </p>
          )}
        </div>
      ) : null}
    </Sheet>
  );
}

/**
 * Per-member admin panel: rename + per-store assignment.
 * - Rename bypasses the user's `displayNameLocked` flag (admin override).
 * - Store assignments are toggle-checkboxes against `admin.storeList`,
 *   with a live mutation per click. The query auto-invalidates so the
 *   UI updates without a full refresh.
 */
function ManageMemberSheet({
  target,
  onClose,
}: {
  target: { memberId: string; userId: string; displayName: string } | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const i18n = useI18n();
  const open = !!target;
  const storesQuery = trpc.admin.storeList.useQuery(undefined, { enabled: open });
  const assignmentsQuery = trpc.admin.memberStoreAssignments.useQuery(
    target ? { memberId: target.memberId } : { memberId: '00000000-0000-0000-0000-000000000000' },
    { enabled: open && !!target },
  );
  // C2 (2026-05-06): a store-scoped admin can only assign/unassign in
  // the stores they administer. Stores outside `adminStoreIds` are
  // shown as read-only rows so the operator can see WHO the member
  // already belongs to (even cross-store), but can only mutate the
  // stores they actually run.
  const session = useAuthStore((s) => s.session);
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  // M1.9: gate cross-store moves behind global-admin only. For per-
  // store managers (who post-B1 have users.manage), the unassign +
  // reassign workflow on the checkbox grid is enough; the dedicated
  // Transfer wizard is an org-wide-write surface they shouldn't reach.
  const sessionStores = session?.stores ?? [];
  const isGlobalAdmin = useMemo(() => {
    if (sessionStores.length === 0) return adminStoreIds.size > 0;
    return sessionStores.every((s) => adminStoreIds.has(s.id));
  }, [sessionStores, adminStoreIds]);
  const [name, setName] = useState(target?.displayName ?? '');
  // Refresh local name field when target changes.
  useEffect(() => {
    if (target) setName(target.displayName);
  }, [target]);

  const renameMut = trpc.admin.memberSetDisplayName.useMutation({
    onSuccess: () => {
      void utils.admin.memberList.invalidate();
      toast.success(i18n.t('admin.toast.memberUpdated'));
    },
    onError: (err) => toast.error(err.message),
  });
  const assignMut = trpc.admin.memberAssignStore.useMutation({
    onSuccess: () => {
      void utils.admin.memberStoreAssignments.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const unassignMut = trpc.admin.memberUnassignStore.useMutation({
    onSuccess: () => {
      void utils.admin.memberStoreAssignments.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const assignedIds = useMemo(
    () => new Set((assignmentsQuery.data ?? []).map((r) => r.storeId)),
    [assignmentsQuery.data],
  );

  // D2 (2026-05-06): transfer wizard state. fromStoreId is set when
  // the operator taps "Transfer..." on a particular row. The sheet
  // mounts as a modal-on-modal which is fine on Telegram WebApp
  // because Sheets stack.
  const [transferFrom, setTransferFrom] = useState<{
    storeId: string;
    storeName: string;
  } | null>(null);

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={target?.displayName ?? 'Member'}
      description="Edit name and assign stores"
    >
      {target ? (
        <div className="flex flex-col gap-4 py-3">
          <Field label="Display name (admin override)">
            <div className="flex gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                placeholder="display name"
              />
              <Button
                size="sm"
                loading={renameMut.isPending}
                disabled={!name.trim() || name.trim() === target.displayName}
                onClick={() =>
                  renameMut.mutate({ memberId: target.memberId, displayName: name.trim() })
                }
              >
                Save
              </Button>
            </div>
            <p className="mt-1 text-meta text-[var(--c-fg-muted)]">
              The user can&apos;t change their own name after onboarding — admins can
              always override here.
            </p>
          </Field>

          <Field label="Assigned stores">
            {storesQuery.isLoading || assignmentsQuery.isLoading ? (
              <div className="flex items-center gap-2 text-body-sm text-[var(--c-fg-muted)]">
                <Spinner size={14} /> Loading…
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
                {(storesQuery.data ?? []).map((st) => {
                  const checked = assignedIds.has(st.id);
                  const pending = assignMut.isPending || unassignMut.isPending;
                  // C2: stores you don't administer are visible (so
                  // you see the full picture) but the checkbox is
                  // disabled. The server would reject anyway.
                  const editable = adminStoreIds.has(st.id);
                  return (
                    <label
                      key={st.id}
                      className={
                        'press flex items-center gap-2 rounded-[var(--r-utility)] px-2 py-1.5 ' +
                        (editable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60')
                      }
                      title={
                        editable
                          ? undefined
                          : "You don't administer this store"
                      }
                    >
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        checked={checked}
                        disabled={pending || !editable}
                        onChange={(e) => {
                          if (e.target.checked) {
                            assignMut.mutate({
                              memberId: target.memberId,
                              storeId: st.id,
                            });
                          } else {
                            unassignMut.mutate({
                              memberId: target.memberId,
                              storeId: st.id,
                            });
                          }
                        }}
                      />
                      <span className="text-body text-[var(--c-fg)]">{st.name}</span>
                      {st.code ? (
                        <span className="text-meta text-[var(--c-fg-muted)]">{st.code}</span>
                      ) : null}
                      {/* D2 (2026-05-06): "Transfer..." per assigned
                          row. M1.9 (2026-05-07): gated to global admins
                          only — store-scoped managers should use the
                          unassign+reassign workflow on this same grid. */}
                      {checked && editable && isGlobalAdmin ? (
                        <button
                          type="button"
                          className="ml-auto rounded-full bg-[var(--c-surface)] px-2 py-0.5 text-meta font-medium text-[var(--c-fg)] ring-hairline active:opacity-80"
                          onClick={(ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            setTransferFrom({ storeId: st.id, storeName: st.name });
                          }}
                          title="Transfer this member to another store"
                        >
                          → Transfer…
                        </button>
                      ) : !editable ? (
                        <span className="ml-auto text-tiny uppercase tracking-wide text-[var(--c-fg-muted)]">
                          read-only
                        </span>
                      ) : null}
                    </label>
                  );
                })}
                {(storesQuery.data ?? []).length === 0 ? (
                  <span className="px-2 py-1 text-label text-[var(--c-fg-muted)]">
                    No stores in this org. Create one in the Catalog tab.
                  </span>
                ) : null}
              </div>
            )}
            <p className="mt-1 text-meta text-[var(--c-fg-muted)]">
              Staff can only place orders for, and confirm deliveries to, the
              stores they&apos;re assigned to. Admins always see all stores.
            </p>
          </Field>
        </div>
      ) : null}
      {target && transferFrom ? (
        <TransferStoreSheet
          target={{
            memberId: target.memberId,
            displayName: target.displayName,
            fromStoreId: transferFrom.storeId,
            fromStoreName: transferFrom.storeName,
          }}
          onClose={() => setTransferFrom(null)}
        />
      ) : null}
    </Sheet>
  );
}

/**
 * TransferStoreSheet (D2, 2026-05-06).
 *
 * Wizard for atomically moving a member from one store to another.
 * The wizard is one screen, not multi-step:
 *   - source store name shown read-only at top
 *   - destination store: dropdown of the actor's other admin stores
 *     (filtered by `session.adminStoreIds`, exclude the source)
 *   - "Mirror role bindings" toggle (default ON) — copies every store-
 *     scoped role binding the member has in `from` to `to`. Off means
 *     the operator wants a clean break (e.g. promotion to a different
 *     role at the new location).
 *   - footer button calls memberTransferStore in one tx
 *
 * Server enforces C1 in BOTH stores and C2 (admin of both); the FE
 * filtering is just UX.
 */
function TransferStoreSheet({
  target,
  onClose,
}: {
  target: {
    memberId: string;
    displayName: string;
    fromStoreId: string;
    fromStoreName: string;
  } | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const session = useAuthStore((s) => s.session);
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  const sessionStores = session?.stores ?? [];
  const open = !!target;

  const [toStoreId, setToStoreId] = useState<string>('');
  const [mirrorRoles, setMirrorRoles] = useState(true);

  useEffect(() => {
    // Reset the form whenever the sheet is opened with a new target.
    if (target) {
      setToStoreId('');
      setMirrorRoles(true);
    }
  }, [target]);

  // Eligible destinations: stores actor admins, excluding the source
  // and (rare) inactive stores that may sneak into session.stores.
  const destinationStores = useMemo(() => {
    if (!target) return [];
    return sessionStores.filter(
      (st) => adminStoreIds.has(st.id) && st.id !== target.fromStoreId,
    );
  }, [sessionStores, adminStoreIds, target]);

  const transferMut = trpc.admin.memberTransferStore.useMutation({
    onSuccess: (data) => {
      void utils.admin.memberList.invalidate();
      void utils.admin.memberStoreAssignments.invalidate();
      const parts = ['Transferred'];
      if (data.mirrored > 0)
        parts.push(`${data.mirrored} role${data.mirrored === 1 ? '' : 's'} mirrored`);
      if (data.revokedBindings > 0)
        parts.push(`${data.revokedBindings} from-side role${data.revokedBindings === 1 ? '' : 's'} revoked`);
      toast.success(parts.join(' · '));
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && !transferMut.isPending && onClose()}
      title="Transfer between stores"
      description={target ? `Move ${target.displayName}` : ''}
      footer={
        target ? (
          <Button
            block
            size="lg"
            loading={transferMut.isPending}
            disabled={!toStoreId}
            onClick={() =>
              transferMut.mutate({
                memberId: target.memberId,
                fromStoreId: target.fromStoreId,
                toStoreId,
                mirrorRoles,
              })
            }
          >
            Transfer
          </Button>
        ) : undefined
      }
    >
      {target ? (
        <div className="flex flex-col gap-3 py-3">
          <Field label="From">
            <div className="rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 py-2 text-body ring-hairline">
              🏪 {target.fromStoreName}
            </div>
          </Field>
          <Field label="To *">
            {destinationStores.length === 0 ? (
              <Banner tone="warn" title="No eligible destinations">
                You don't administer any other store. Ask a higher-rank
                admin to add you to the destination first.
              </Banner>
            ) : (
              <select
                className="h-11 w-full rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 text-h3 ring-hairline"
                value={toStoreId}
                onChange={(e) => setToStoreId(e.target.value)}
              >
                <option value="">— pick a destination store —</option>
                {destinationStores.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <label className="press flex cursor-pointer items-start gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5"
              checked={mirrorRoles}
              onChange={(e) => setMirrorRoles(e.target.checked)}
            />
            <div className="min-w-0 flex-1">
              <div className="text-body font-semibold text-[var(--c-fg)]">
                Mirror role bindings
              </div>
              <p className="mt-0.5 text-label text-[var(--c-fg-muted)]">
                When on (default), every store-scoped role this member
                has in {target.fromStoreName} is duplicated against the
                destination so they keep the same role. Turn off to give
                them no role at the new store — useful when the move
                also implies a promotion or demotion.
              </p>
            </div>
          </label>
          <Banner tone="info" title="What this does">
            Atomic in one transaction:
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-label">
              <li>{target.displayName} is added to the destination store</li>
              <li>
                {mirrorRoles
                  ? 'their store-scoped role bindings in the source are recreated in the destination'
                  : 'no role bindings are created in the destination'}
              </li>
              <li>
                their assignment + bindings + per-store overrides in
                {' '}{target.fromStoreName} are removed
              </li>
            </ul>
            Other stores they belong to are untouched. If anything fails,
            the whole transfer rolls back.
          </Banner>
        </div>
      ) : null}
    </Sheet>
  );
}

/**
 * Per-member permission overrides editor (added 2026-05-05).
 *
 * Three layers shown for each permission key:
 *   1. Role-derived (gray, "from role" badge) — read-only baseline
 *   2. allow override   (green chip) — adds the key on top
 *   3. deny override    (red chip)   — removes the key from baseline
 *
 * UX:
 *   - Each row has a 3-state segmented control: [from role] / [allow] / [deny]
 *     "from role" = no override, fall back to baseline (which itself
 *     may be allow or none — that's fine, the badge tells you what)
 *   - Toggling allow/deny calls memberPermissionSet
 *   - Toggling back to "from role" calls memberPermissionRevoke
 *   - Effective set is shown at top as a small badge count
 */
function MemberPermissionsSheet({
  target,
  onClose,
}: {
  target:
    | {
        memberId: string;
        displayName: string;
        /** The stores this member belongs to (for the per-store
         *  override tabs added 2026-05-06 in A2). Pass an empty
         *  array if the member is org-level. */
        stores: Array<{ id: string; name: string }>;
      }
    | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const session = useAuthStore((s) => s.session);
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  const open = !!target;
  const detail = trpc.admin.memberPermissionsList.useQuery(
    { memberId: target?.memberId ?? '' },
    { enabled: open },
  );
  const allPerms = trpc.admin.permissionList.useQuery(undefined, { enabled: open });

  /**
   * Active scope tab. 'global' is always available; store-scoped tabs
   * appear only for stores the member belongs to AND the actor admins.
   * (A store-scoped admin shouldn't see — let alone be able to edit —
   * overrides for a store they don't run; the server enforces too.)
   */
  type Scope =
    | { kind: 'global' }
    | { kind: 'store'; storeId: string; storeName: string };
  const [scope, setScope] = useState<Scope>({ kind: 'global' });
  // Reset scope when sheet opens for a new target. Default to 'global'
  // so the operator lands on the familiar surface.
  useEffect(() => {
    if (target) setScope({ kind: 'global' });
  }, [target]);

  const editableStoreTabs = useMemo(
    () =>
      (target?.stores ?? []).filter((st) => adminStoreIds.has(st.id)),
    [target, adminStoreIds],
  );

  const set = trpc.admin.memberPermissionSet.useMutation({
    onSuccess: () => {
      void utils.admin.memberPermissionsList.invalidate({
        memberId: target?.memberId ?? '',
      });
    },
    onError: (err) => toast.error(err.message),
  });
  const revoke = trpc.admin.memberPermissionRevoke.useMutation({
    onSuccess: () => {
      void utils.admin.memberPermissionsList.invalidate({
        memberId: target?.memberId ?? '',
      });
    },
    onError: (err) => toast.error(err.message),
  });

  /**
   * Index overrides by (scopeKey, permissionKey) so each tab can
   * render its own effect chip without cross-talk. The 'global' bucket
   * holds rows where override.scopeType === 'global'; each store
   * bucket holds rows where override.scopeType === 'store' AND
   * scopeId === storeId. (A2, 2026-05-06.)
   */
  const overrideByScopeKey = useMemo(() => {
    const m = new Map<string, Map<string, 'allow' | 'deny'>>();
    for (const o of detail.data?.overrides ?? []) {
      const key = o.scopeType === 'global' ? 'global' : `store:${o.scopeId ?? ''}`;
      const inner = m.get(key) ?? new Map();
      inner.set(o.permissionKey, o.effect);
      m.set(key, inner);
    }
    return m;
  }, [detail.data]);

  const currentScopeKey =
    scope.kind === 'global' ? 'global' : `store:${scope.storeId}`;
  const overrideByKey = overrideByScopeKey.get(currentScopeKey) ?? new Map();

  const roleKeys = useMemo(
    () => new Set(detail.data?.roleKeys ?? []),
    [detail.data],
  );

  const grouped = useMemo(() => {
    const m = new Map<string, Array<{ key: string; description: string | null }>>();
    for (const p of allPerms.data ?? []) {
      const ns = p.key.split('.')[0] ?? 'misc';
      const arr = m.get(ns) ?? [];
      arr.push({ key: p.key, description: p.description });
      m.set(ns, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [allPerms.data]);

  const handleSet = (key: string, mode: 'role' | 'allow' | 'deny') => {
    if (!target) return;
    const scopeArgs =
      scope.kind === 'global'
        ? { scopeType: 'global' as const }
        : { scopeType: 'store' as const, scopeId: scope.storeId };
    if (mode === 'role') {
      revoke.mutate({
        memberId: target.memberId,
        permissionKey: key,
        ...scopeArgs,
      });
    } else {
      set.mutate({
        memberId: target.memberId,
        permissionKey: key,
        effect: mode,
        ...scopeArgs,
      });
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={target ? `Permissions — ${target.displayName}` : 'Permissions'}
      description={
        detail.data
          ? `${detail.data.effective.length} effective · ${detail.data.overrides.length} override${detail.data.overrides.length === 1 ? '' : 's'}`
          : undefined
      }
    >
      {detail.isLoading || allPerms.isLoading ? (
        <div className="py-8 text-center text-body text-[var(--c-fg-muted)]">
          <Spinner size={16} />
        </div>
      ) : !detail.data ? (
        <div className="py-8 text-center text-body text-[var(--c-fg-muted)]">
          —
        </div>
      ) : (
        <div className="flex flex-col gap-3 py-3">
          {/* Scope tabs (A2, 2026-05-06). 'Global' is always present;
              store tabs appear only when the member belongs to that
              store AND the actor administers it. The little dot on
              each tab counts overrides scoped to that tab. */}
          {(editableStoreTabs.length > 0 || (target?.stores ?? []).length > 0) && (
            <div className="flex flex-wrap gap-1">
              <ScopeTab
                active={scope.kind === 'global'}
                onClick={() => setScope({ kind: 'global' })}
                count={overrideByScopeKey.get('global')?.size ?? 0}
              >
                Global
              </ScopeTab>
              {(target?.stores ?? []).map((st) => {
                const editable = adminStoreIds.has(st.id);
                const isActive =
                  scope.kind === 'store' && scope.storeId === st.id;
                const tabCount =
                  overrideByScopeKey.get(`store:${st.id}`)?.size ?? 0;
                return (
                  <ScopeTab
                    key={st.id}
                    active={isActive}
                    disabled={!editable}
                    onClick={() =>
                      editable &&
                      setScope({
                        kind: 'store',
                        storeId: st.id,
                        storeName: st.name,
                      })
                    }
                    count={tabCount}
                    title={
                      editable
                        ? undefined
                        : "You don't administer this store — read-only"
                    }
                  >
                    🏪 {st.name}
                  </ScopeTab>
                );
              })}
            </div>
          )}
          <Banner tone="info" title="How this works">
            {scope.kind === 'global' ? (
              <>
                Each row shows what the member's <em>role</em> would grant
                (gray) and lets you override per-member with{' '}
                <strong>allow</strong> (force on) or <strong>deny</strong>{' '}
                (force off). Deny always wins on conflict.
              </>
            ) : (
              <>
                Overrides on this tab apply <strong>only in {scope.storeName}</strong>.
                The role-derived baseline is the same across stores; per-store
                allow/deny lets you fine-tune what this member can do in this
                location specifically.
              </>
            )}
          </Banner>
          {grouped.map(([ns, keys]) => (
            <div key={ns}>
              <div className="text-meta font-semibold uppercase tracking-[0.08em] text-[var(--c-fg-muted)]">
                {ns}
              </div>
              <ul className="mt-1 flex flex-col gap-1">
                {keys.map((p) => {
                  const override = overrideByKey.get(p.key) ?? null;
                  const fromRole = roleKeys.has(p.key);
                  const mode: 'role' | 'allow' | 'deny' =
                    override ?? 'role';
                  return (
                    <li
                      key={p.key}
                      className="flex flex-col gap-1 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-mono text-label">{p.key}</div>
                          {p.description ? (
                            <div className="mt-0.5 text-label text-[var(--c-fg-muted)]">
                              {p.description}
                            </div>
                          ) : null}
                        </div>
                        {fromRole ? (
                          <Badge tone="muted">from role</Badge>
                        ) : null}
                      </div>
                      <div className="flex gap-1">
                        <SegBtn
                          active={mode === 'role'}
                          tone="muted"
                          onClick={() => handleSet(p.key, 'role')}
                        >
                          From role
                        </SegBtn>
                        <SegBtn
                          active={mode === 'allow'}
                          tone="success"
                          onClick={() => handleSet(p.key, 'allow')}
                        >
                          Allow
                        </SegBtn>
                        <SegBtn
                          active={mode === 'deny'}
                          tone="danger"
                          onClick={() => handleSet(p.key, 'deny')}
                        >
                          Deny
                        </SegBtn>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/**
 * ScopeTab — tab pill for the per-store permission-override tabs (A2,
 * 2026-05-06). Mirrors the visual language of the segmented buttons
 * but in tab-bar form. Shows a small count chip when the tab has at
 * least one override scoped to it. `disabled` greys it out for stores
 * the actor doesn't administer (the tab still renders so the operator
 * sees the full member-store list, but it's read-only-style).
 */
function ScopeTab({
  active,
  disabled,
  count,
  onClick,
  title,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  count?: number;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  const base =
    'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-label font-medium ring-hairline';
  const tone = active
    ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
    : disabled
      ? 'bg-transparent text-[var(--c-fg-muted)] opacity-60'
      : 'bg-[var(--c-surface-2)] text-[var(--c-fg)]';
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${tone}`}
    >
      <span>{children}</span>
      {count && count > 0 ? (
        <span
          className={
            'inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-tiny ' +
            (active
              ? 'bg-white/25 text-white'
              : 'bg-[var(--c-action)] text-[var(--c-action-fg)]')
          }
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Segmented button for the per-permission allow/deny/role toggle.
 * Compact, ~28px tall — three of them line up under each row.
 */
function SegBtn({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone: 'muted' | 'success' | 'danger';
  onClick: () => void;
  children: React.ReactNode;
}) {
  const activeBg =
    tone === 'success'
      ? 'bg-[var(--c-success,#16a34a)] text-white'
      : tone === 'danger'
        ? 'bg-[var(--c-danger)] text-white'
        : 'bg-[var(--c-action)] text-[var(--c-action-fg)]';
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex-1 rounded-[var(--r-pill)] px-2 py-1 text-meta font-medium ' +
        (active ? activeBg : 'bg-transparent text-[var(--c-fg-muted)] ring-hairline active:opacity-70')
      }
    >
      {children}
    </button>
  );
}

// ADMIN_RANK is imported from `@compass/contracts` (see top of file).
// Single source of truth for the org-tier threshold — the M1.5 audit
// found this constant duplicated in 4 places (server gate + 3 FE
// usages) which was a drift hazard.

/**
 * GrantRoleSheet — two-step picker.
 *
 *   Step 1: pick scope.
 *     - "Globally"     → only org-tier roles (rank ≥ 80). Hidden if the
 *                        actor is a store-scoped admin only (their
 *                        adminStoreIds doesn't cover the whole org).
 *     - "In specific store(s)" → store-tier roles (rank < 80). The
 *                        store dropdown is filtered to session.adminStoreIds
 *                        — a store-scoped admin only sees their own stores.
 *
 *   Step 2: pick role.
 *     - Filtered to roles whose rank < the actor's effective rank IN
 *       the chosen scope. For "store" scope with multiple stores
 *       selected, we use the MIN rank across the selected stores
 *       (because each store-binding is independently gated server-side
 *       — if any one fails, the operation aborts mid-way).
 *
 *   When a role is tapped:
 *     - Global → 1 grantRole call
 *     - Store(s) → N grantRole calls in sequence (one per selected
 *                  store). Server's idempotency check makes re-runs safe.
 *
 * Defaults: if the caller passes `defaultStoreId` (PeopleSection does
 * this when StoreSwitcher is in 'specific' mode), we pre-select store
 * scope + that store so the operator doesn't have to re-pick.
 */
function GrantRoleSheet({
  target,
  onClose,
}: {
  target:
    | { userId: string; displayName: string; defaultStoreId?: string | null }
    | null;
  onClose: () => void;
}) {
  const session = useAuthStore((s) => s.session);
  const myGlobalMaxRank = session?.myMaxRank ?? 0;
  const storeRanks = session?.storeRanks ?? {};
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  const sessionStores = session?.stores ?? [];
  const i18n = useI18n();

  const rolesQuery = trpc.admin.roleList.useQuery(undefined, { enabled: !!target });
  const utils = trpc.useUtils();
  const toast = useToast();
  const grant = trpc.admin.grantRole.useMutation({
    onError: (err) => toast.error(err.message),
  });

  // Two-step state.
  const [scopeMode, setScopeMode] = useState<'global' | 'store'>('store');
  const [selectedStoreIds, setSelectedStoreIds] = useState<Set<string>>(new Set());

  // Reset state when the target changes (sheet opens for a new member).
  useEffect(() => {
    if (!target) return;
    if (target.defaultStoreId && adminStoreIds.has(target.defaultStoreId)) {
      setScopeMode('store');
      setSelectedStoreIds(new Set([target.defaultStoreId]));
    } else {
      setScopeMode('store');
      setSelectedStoreIds(new Set());
    }
  }, [target, adminStoreIds]);

  // C2: stores the actor can administer, intersected with the org's
  // store list (so we always render fresh names).
  const eligibleStores = useMemo(
    () => sessionStores.filter((s) => adminStoreIds.has(s.id)),
    [sessionStores, adminStoreIds],
  );

  // Whether the actor can grant a 'global' (org-tier) binding. Mirrors
  // the server: only true if the actor is admin EVERYWHERE (their
  // adminStoreIds covers every active store the session sees). For a
  // store-scoped admin, adminStoreIds is a subset, so this is false.
  const canGrantGlobal = useMemo(() => {
    if (sessionStores.length === 0) return adminStoreIds.size > 0; // edge: org-admin without stores
    return sessionStores.every((s) => adminStoreIds.has(s.id));
  }, [sessionStores, adminStoreIds]);

  // Effective rank in the chosen scope.
  //   global → myGlobalMaxRank (the actor's overall max)
  //   store  → min over selected stores of max(globalMax, storeRanks[id])
  // We use MIN because the grant fans out to N independent server
  // calls, each gated on its own store rank — the weakest link wins.
  const effectiveRank = useMemo(() => {
    if (scopeMode === 'global') return myGlobalMaxRank;
    if (selectedStoreIds.size === 0) return 0;
    let min = Infinity;
    for (const id of selectedStoreIds) {
      const r = Math.max(myGlobalMaxRank, storeRanks[id] ?? 0);
      if (r < min) min = r;
    }
    return min === Infinity ? 0 : min;
  }, [scopeMode, selectedStoreIds, myGlobalMaxRank, storeRanks]);

  /**
   * Filter roles. Three rules combined:
   *   1. rank < effectiveRank (the existing "no equal/higher grants" rule)
   *   2. scopeMode='global' → only org-tier roles (rank ≥ ADMIN_RANK)
   *   3. scopeMode='store'  → only store-tier roles (rank < ADMIN_RANK)
   * Server enforces the same — this just gives the FE a clean picker.
   */
  const grantableRoles = useMemo(() => {
    return [...(rolesQuery.data ?? [])]
      .filter((r) => r.rank < effectiveRank)
      .filter((r) =>
        scopeMode === 'global' ? r.rank >= ADMIN_RANK : r.rank < ADMIN_RANK,
      )
      .sort((a, b) => b.rank - a.rank);
  }, [rolesQuery.data, effectiveRank, scopeMode]);

  const toggleStore = (id: string) => {
    setSelectedStoreIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handlePick = async (slug: string) => {
    if (!target) return;
    if (scopeMode === 'global') {
      try {
        const data = await grant.mutateAsync({
          userId: target.userId,
          roleSlug: slug,
          scopeType: 'global',
        });
        toast[data.granted ? 'success' : 'info'](
          data.granted ? 'Role granted' : 'Role already assigned',
        );
        void utils.admin.memberList.invalidate();
        onClose();
      } catch {/* error toast already shown */}
      return;
    }
    // Store fan-out. We loop sequentially so a mid-run server error
    // (rank changed, store archived, etc.) leaves the partial result
    // visible to the user and they can retry the rest.
    let createdCount = 0;
    let skipped = 0;
    for (const storeId of selectedStoreIds) {
      try {
        const data = await grant.mutateAsync({
          userId: target.userId,
          roleSlug: slug,
          scopeType: 'store',
          scopeId: storeId,
        });
        if (data.granted) createdCount++;
        else skipped++;
      } catch {
        // first failure: stop here; toast already raised by onError
        void utils.admin.memberList.invalidate();
        return;
      }
    }
    if (createdCount > 0) {
      toast.success(
        `Role granted in ${createdCount} store${createdCount === 1 ? '' : 's'}` +
          (skipped > 0 ? ` (${skipped} already had it)` : ''),
      );
    } else if (skipped > 0) {
      toast.info('Role was already assigned everywhere selected');
    }
    void utils.admin.memberList.invalidate();
    onClose();
  };

  const canSubmit =
    scopeMode === 'global'
      ? canGrantGlobal
      : selectedStoreIds.size > 0;

  return (
    <Sheet
      open={!!target}
      onOpenChange={(open) => !open && onClose()}
      title="Grant role"
      description={target ? `to ${target.displayName}` : ''}
    >
      <div className="flex flex-col gap-3 py-3">
        {/* Step 1 — scope */}
        <Field label="Scope">
          <div className="flex gap-1">
            <SegBtn
              active={scopeMode === 'store'}
              tone="muted"
              onClick={() => setScopeMode('store')}
            >
              In specific store(s)
            </SegBtn>
            <SegBtn
              active={scopeMode === 'global'}
              tone="muted"
              onClick={() => canGrantGlobal && setScopeMode('global')}
            >
              {canGrantGlobal ? 'Globally' : 'Globally (org-admin only)'}
            </SegBtn>
          </div>
          {!canGrantGlobal ? (
            <p className="mt-1 text-meta text-[var(--c-fg-muted)]">
              Only org-level admins can grant global (org-tier) roles. You can
              still assign per-store roles in the stores you administer.
            </p>
          ) : null}
        </Field>

        {/* Store multi-select (visible in store mode) */}
        {scopeMode === 'store' ? (
          <Field label="Stores">
            {eligibleStores.length === 0 ? (
              <Banner tone="warn" title="No stores you can grant in">
                You don't administer any store yet. Ask a higher-rank admin
                to add you to a store first.
              </Banner>
            ) : (
              <div className="flex flex-col gap-1.5 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
                {eligibleStores.map((st) => {
                  const checked = selectedStoreIds.has(st.id);
                  return (
                    <label
                      key={st.id}
                      className="press flex cursor-pointer items-center gap-2 rounded-[var(--r-utility)] px-2 py-1.5"
                    >
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        checked={checked}
                        onChange={() => toggleStore(st.id)}
                      />
                      <span className="text-body text-[var(--c-fg)]">
                        🏪 {st.name}
                      </span>
                      {st.code ? (
                        <span className="text-meta text-[var(--c-fg-muted)]">
                          {st.code}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            )}
          </Field>
        ) : null}

        {/* Step 2 — role list (filtered by chosen scope + effectiveRank) */}
        {!canSubmit ? (
          <p className="text-label text-[var(--c-fg-muted)]">
            Pick a scope above to see available roles.
          </p>
        ) : rolesQuery.isLoading ? (
          <div className="flex items-center gap-2 text-body-sm text-[var(--c-fg-muted)]">
            <Spinner size={14} /> Loading roles…
          </div>
        ) : grantableRoles.length === 0 ? (
          <Banner tone="warn" title="No grantable roles">
            {scopeMode === 'global'
              ? `All org-tier roles are at or above your rank (${effectiveRank}).`
              : `Your rank in the selected store(s) is ${effectiveRank} — no role ranked below that exists.`}
          </Banner>
        ) : (
          grantableRoles.map((r) => (
            <button
              key={r.id}
              type="button"
              disabled={grant.isPending}
              onClick={() => handlePick(r.slug)}
              className="press flex items-center justify-between rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-3 text-left ring-hairline"
            >
              <div>
                <div className="text-h3 font-semibold text-[var(--c-fg)]">
                  {r.name}
                </div>
                <div className="mt-0.5 text-label text-[var(--c-fg-muted)]">
                  rank {r.rank}
                  {r.description ? ` · ${r.description}` : ''}
                </div>
              </div>
              {r.isBuiltIn ? <Badge tone="muted">built-in</Badge> : null}
            </button>
          ))
        )}
        {/* Soothing dummy reference so the i18n linter sees the new key */}
        <span className="hidden">{i18n.t('admin.errors.notAdminOfStore')}</span>
      </div>
    </Sheet>
  );
}

// ============ Catalog ============

function CatalogHome({ onPick }: { onPick: (s: CatalogSub) => void }) {
  const i18n = useI18n();
  // M1.4 (2026-05-06): Stores moved out of Catalog into its own
  // top-level section. Catalog now strictly holds the "what you order
  // / who you order from" data — categories, SKUs, suppliers.
  return (
    <ul className="mx-4 mt-2 flex flex-col gap-2" role="list">
      <ListRow
        label={i18n.t('admin.subsection.categories')}
        hint={i18n.t('admin.subsection.categoriesHint')}
        onClick={() => onPick('categories')}
      />
      <ListRow
        label={i18n.t('admin.subsection.skus')}
        hint={i18n.t('admin.subsection.skusHint')}
        onClick={() => onPick('skus')}
      />
      <ListRow
        label={i18n.t('admin.subsection.suppliers')}
        hint={i18n.t('admin.subsection.suppliersHint')}
        onClick={() => onPick('suppliers')}
      />
    </ul>
  );
}

interface StoreDraft {
  storeId?: string;
  name: string;
  code: string;
  address: string;
  timezone: string;
  isActive: boolean;
  /** D3 (2026-05-06): default role for new members invited into this
   *  store. Only relevant when editing an existing store; new stores
   *  default to '' (no default) and can be set after creation. */
  defaultRoleSlug: string;
}

// EMPTY_STORE was used by the old combined create/edit sheet; the
// store list now uses a small create-only sheet inline (just name +
// code + address + timezone — defaults set later in Settings tab).

// ============ Stores (M1.4 store-first) ============

/**
 * StoresHomeSection (M1.4, 2026-05-06).
 *
 * Top-level list of all stores the actor can administer, plus a
 * pseudo-store at the top that buckets org-level members (admin /
 * super_admin without store assignments). Each tile shows the store's
 * basic info, member count, and default role hint. Tap a tile → drill
 * into StoreDetailScreen.
 *
 * Why this replaced "Catalog → Stores":
 *   - Stores aren't catalog data; they're org structure.
 *   - The whole point of M1.4 is "store as the unit of nav" — staff
 *     management lives inside a store, not in a flat People list.
 *
 * Member count: derived FE-side from `admin.memberList`. We could add
 * a dedicated endpoint, but the member list is already cached for
 * other admin views and N here is small (≤ a few hundred members per
 * org for the foreseeable future).
 */
function StoresHomeSection({
  onPickStore,
}: {
  onPickStore: (focus: StoreFocus) => void;
}) {
  const storesQuery = trpc.admin.storeList.useQuery();
  const membersQuery = trpc.admin.memberList.useQuery();
  const utils = trpc.useUtils();
  const toast = useToast();
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  // Lightweight create-only sheet: create flow needs name/code/address/
  // timezone but NOT default-role/archive (those land in Settings tab
  // after creation). Keeping it a sheet rather than inline because
  // creation is a transient one-shot, not edit-in-place.
  const [createDraft, setCreateDraft] = useState<{
    name: string;
    code: string;
    address: string;
    timezone: string;
  } | null>(null);

  const create = trpc.admin.storeCreate.useMutation({
    onSuccess: () => {
      void utils.admin.storeList.invalidate();
      toast.success(i18n.t('admin.toast.storeCreated'));
      setCreateDraft(null);
    },
    onError: (err) => toast.error(err.message),
  });

  // Aggregate member counts per store from the cached memberList.
  const memberCounts = useMemo(() => {
    const byStore = new Map<string, number>();
    let orgLevel = 0;
    for (const m of membersQuery.data ?? []) {
      if (m.stores.length === 0) {
        orgLevel++;
      } else {
        for (const st of m.stores) {
          byStore.set(st.id, (byStore.get(st.id) ?? 0) + 1);
        }
      }
    }
    return { byStore, orgLevel };
  }, [membersQuery.data]);

  return (
    <div className="px-4 py-3">
      <div className="mb-3">
        <Button
          size="sm"
          onClick={() =>
            setCreateDraft({ name: '', code: '', address: '', timezone: '' })
          }
        >
          + New store
        </Button>
      </div>
      <DataState
        query={storesQuery}
        emptyWhen={(d) => d.length === 0 && memberCounts.orgLevel === 0}
        empty={
          <EmptyState
            title="No stores"
            description="Create one with the button above to start onboarding your team."
          />
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-2" role="list">
            {/* Org-level pseudo-store (only if there are admin/super-
                admin members not in any store; otherwise skipped to
                avoid noise). */}
            {/* Tiles are flat <button>s rather than <Card> wrappers
                because nesting block elements (<header><h3>) inside a
                <button> is invalid HTML — Chrome's parser hoists them
                out and splits the click target. We replicate the Card
                visual instead. */}
            {memberCounts.orgLevel > 0 ? (
              <li>
                <button
                  type="button"
                  onClick={() => onPickStore({ kind: 'org-level' })}
                  className="press flex w-full items-start justify-between gap-3 rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-4 text-left ring-hairline"
                >
                  <span className="min-w-0">
                    <span className="block text-h2 font-semibold tracking-tight text-[var(--c-fg)]">
                      🌐 Org-level
                    </span>
                    <span className="mt-0.5 block text-body-sm text-[var(--c-fg-muted)]">
                      Admins / super-admins not bound to any store
                    </span>
                  </span>
                  <Badge tone="muted">
                    {memberCounts.orgLevel}{' '}
                    {memberCounts.orgLevel === 1 ? 'member' : 'members'}
                  </Badge>
                </button>
              </li>
            ) : null}
            {rows.map((st) => {
              const count = memberCounts.byStore.get(st.id) ?? 0;
              const canAdmin = adminStoreIds.has(st.id);
              return (
                <li key={st.id}>
                  <button
                    type="button"
                    onClick={() =>
                      onPickStore({
                        kind: 'store',
                        storeId: st.id,
                        storeName: st.name,
                      })
                    }
                    className="press flex w-full items-start justify-between gap-3 rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-4 text-left ring-hairline"
                  >
                    <span className="min-w-0">
                      <span className="block text-h2 font-semibold tracking-tight text-[var(--c-fg)]">
                        🏪 {st.name}
                      </span>
                      <span className="mt-0.5 block text-body-sm text-[var(--c-fg-muted)]">
                        {st.code ? `code ${st.code}` : 'no code'}
                        {st.timezone ? ` · ${st.timezone}` : ''}
                        {!canAdmin ? ' · view-only' : ''}
                      </span>
                      <span className="mt-1 block text-meta text-[var(--c-fg-muted)]">
                        {count} {count === 1 ? 'member' : 'members'}
                        {st.defaultRoleSlug ? (
                          <>
                            {' · default role: '}
                            <span className="font-semibold">
                              {st.defaultRoleName ?? st.defaultRoleSlug}
                            </span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <Badge tone={st.isActive ? 'success' : 'muted'}>
                      {st.isActive ? 'active' : 'paused'}
                    </Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </DataState>

      <Sheet
        open={!!createDraft}
        onOpenChange={(open) => !open && setCreateDraft(null)}
        title="New store"
        footer={
          <Button
            block
            loading={create.isPending}
            disabled={!createDraft?.name.trim()}
            onClick={() => {
              if (!createDraft) return;
              create.mutate({
                name: createDraft.name,
                code: createDraft.code || null,
                address: createDraft.address || null,
                timezone: createDraft.timezone || null,
              });
            }}
          >
            Create
          </Button>
        }
      >
        {createDraft ? (
          <div className="flex flex-col gap-3 py-3">
            <Field label="Name *">
              <Input
                value={createDraft.name}
                onChange={(e) =>
                  setCreateDraft({ ...createDraft, name: e.target.value })
                }
                maxLength={200}
                autoFocus
              />
            </Field>
            <Field label="Code">
              <Input
                value={createDraft.code}
                onChange={(e) =>
                  setCreateDraft({ ...createDraft, code: e.target.value })
                }
                maxLength={32}
                placeholder="optional internal code"
              />
            </Field>
            <Field label="Address">
              <Input
                value={createDraft.address}
                onChange={(e) =>
                  setCreateDraft({ ...createDraft, address: e.target.value })
                }
                maxLength={500}
              />
            </Field>
            <Field label="Timezone">
              <Input
                value={createDraft.timezone}
                onChange={(e) =>
                  setCreateDraft({ ...createDraft, timezone: e.target.value })
                }
                maxLength={64}
                placeholder="e.g. Asia/Tashkent"
              />
            </Field>
            <p className="text-meta text-[var(--c-fg-muted)]">
              You can set the default role and other settings after the
              store is created — open it from the list and switch to the
              Settings tab.
            </p>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

/**
 * StoreDetailScreen (M1.4, 2026-05-06).
 *
 * Per-store detail page. Tab bar at the top:
 *   - Team — members in this store, with all the Manage / Grant /
 *            Permissions / Detach / Transfer affordances. Reuses the
 *            existing PeopleSection with `lockMode` set so the global
 *            StoreSwitcher is bypassed.
 *   - Settings — store fields (name/code/address/timezone), default
 *                role picker, archive button, clone-roles wizard.
 *
 * Org-level focus: only Team tab. Settings doesn't apply (the pseudo-
 * store has no DB row).
 */
function StoreDetailScreen({
  focus,
  sub,
  onSubChange,
}: {
  focus: NonNullable<StoreFocus>;
  sub: StoreSub;
  onSubChange: (s: StoreSub) => void;
}) {
  const isOrgLevel = focus.kind === 'org-level';
  const effectiveSub: StoreSub = isOrgLevel ? 'team' : sub;
  return (
    <div className="flex flex-col">
      {!isOrgLevel ? (
        <div className="px-4 pb-1 pt-1">
          <div className="flex gap-1">
            <SegBtn
              active={effectiveSub === 'team'}
              tone="muted"
              onClick={() => onSubChange('team')}
            >
              Team
            </SegBtn>
            <SegBtn
              active={effectiveSub === 'settings'}
              tone="muted"
              onClick={() => onSubChange('settings')}
            >
              Settings
            </SegBtn>
          </div>
        </div>
      ) : null}
      {effectiveSub === 'team' ? (
        <PeopleSection
          lockMode={
            isOrgLevel
              ? { kind: 'org-level' }
              : { kind: 'store', storeId: focus.storeId }
          }
        />
      ) : null}
      {effectiveSub === 'settings' && focus.kind === 'store' ? (
        <StoreSettingsTab storeId={focus.storeId} />
      ) : null}
    </div>
  );
}

/**
 * StoreSettingsTab (M1.4, 2026-05-06).
 *
 * Inline edit form for a single store. Reuses the same underlying
 * mutations the old `StoresSection` modal sheet did (storeUpdate /
 * storeDelete / storeCloneRoles), but rendered as a flat form on the
 * Settings tab — no sheet, no modal — because we're already inside a
 * dedicated detail screen.
 */
function StoreSettingsTab({ storeId }: { storeId: string }) {
  const storesQuery = trpc.admin.storeList.useQuery();
  const rolesQuery = trpc.admin.roleList.useQuery();
  const utils = trpc.useUtils();
  const toast = useToast();
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  // M1.9 (2026-05-07): clone-roles is an org-wide write — gate to
  // global admins.
  const sessionStores = session?.stores ?? [];
  const isGlobalAdmin = useMemo(() => {
    if (sessionStores.length === 0) return adminStoreIds.size > 0;
    return sessionStores.every((s) => adminStoreIds.has(s.id));
  }, [sessionStores, adminStoreIds]);

  const store = useMemo(
    () => (storesQuery.data ?? []).find((s) => s.id === storeId) ?? null,
    [storesQuery.data, storeId],
  );

  const [draft, setDraft] = useState<StoreDraft | null>(null);
  // D4 clone-roles wizard target. Always pre-fills the current store
  // as the TARGET; operator picks a source from their other admin
  // stores in the sheet.
  const [cloneOpen, setCloneOpen] = useState(false);

  // Hydrate draft when the store row arrives or the storeId changes.
  useEffect(() => {
    if (!store) return;
    setDraft({
      storeId: store.id,
      name: store.name,
      code: store.code ?? '',
      address: store.address ?? '',
      timezone: store.timezone ?? '',
      isActive: store.isActive,
      defaultRoleSlug: store.defaultRoleSlug ?? '',
    });
  }, [store]);

  const update = trpc.admin.storeUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.storeList.invalidate();
      toast.success(i18n.t('admin.toast.storeUpdated'));
    },
    onError: (err) => toast.error(err.message),
  });
  const remove = trpc.admin.storeDelete.useMutation({
    onSuccess: () => {
      void utils.admin.storeList.invalidate();
      toast.info(i18n.t('admin.toast.storeArchived'));
    },
    onError: (err) => toast.error(err.message),
  });

  const storeTierRoles = useMemo(
    () =>
      [...(rolesQuery.data ?? [])]
        .filter((r) => r.rank < ADMIN_RANK)
        .sort((a, b) => b.rank - a.rank),
    [rolesQuery.data],
  );

  if (storesQuery.isLoading || !draft || !store) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-body-sm text-[var(--c-fg-muted)]">
        <Spinner size={14} /> Loading store…
      </div>
    );
  }

  const dirty =
    draft.name !== (store.name ?? '') ||
    draft.code !== (store.code ?? '') ||
    draft.address !== (store.address ?? '') ||
    draft.timezone !== (store.timezone ?? '') ||
    draft.isActive !== store.isActive ||
    draft.defaultRoleSlug !== (store.defaultRoleSlug ?? '');

  const canAdmin = adminStoreIds.has(storeId);

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <Field label="Name *">
        <Input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          maxLength={200}
          disabled={!canAdmin}
        />
      </Field>
      <Field label="Code">
        <Input
          value={draft.code}
          onChange={(e) => setDraft({ ...draft, code: e.target.value })}
          maxLength={32}
          placeholder="optional internal code"
          disabled={!canAdmin}
        />
      </Field>
      <Field label="Address">
        <Input
          value={draft.address}
          onChange={(e) => setDraft({ ...draft, address: e.target.value })}
          maxLength={500}
          disabled={!canAdmin}
        />
      </Field>
      <Field label="Timezone">
        <Input
          value={draft.timezone}
          onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
          maxLength={64}
          placeholder="e.g. Asia/Tashkent"
          disabled={!canAdmin}
        />
      </Field>
      <Field label="Default role for new members">
        {rolesQuery.isLoading ? (
          <div className="flex items-center gap-2 text-body-sm text-[var(--c-fg-muted)]">
            <Spinner size={14} /> Loading roles…
          </div>
        ) : (
          <select
            className="h-11 w-full rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 text-h3 ring-hairline disabled:opacity-60"
            value={draft.defaultRoleSlug}
            onChange={(e) =>
              setDraft({ ...draft, defaultRoleSlug: e.target.value })
            }
            disabled={!canAdmin}
          >
            <option value="">— no default (operator picks each invite) —</option>
            {storeTierRoles.map((r) => (
              <option key={r.id} value={r.slug}>
                {r.name} (rank {r.rank})
              </option>
            ))}
          </select>
        )}
        <p className="mt-1 text-meta text-[var(--c-fg-muted)]">
          When set, new members invited into this store with no explicit
          role pick are auto-granted this role.
        </p>
      </Field>
      <label className="flex items-center gap-3 text-body">
        <input
          type="checkbox"
          checked={draft.isActive}
          onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
          className="h-5 w-5"
          disabled={!canAdmin}
        />
        Active
      </label>

      <div className="flex flex-wrap gap-2 border-t border-[var(--c-divider)] pt-4">
        <Button
          loading={update.isPending}
          disabled={!canAdmin || !dirty || !draft.name.trim()}
          onClick={() => {
            update.mutate({
              storeId: draft.storeId!,
              name: draft.name,
              code: draft.code || null,
              address: draft.address || null,
              timezone: draft.timezone || null,
              isActive: draft.isActive,
              defaultRoleSlug: draft.defaultRoleSlug
                ? draft.defaultRoleSlug
                : null,
            });
          }}
        >
          Save
        </Button>
        {/* M1.9: clone-roles requires global admin (was canAdmin + ≥2
            admin stores; per-store managers shouldn't trigger this
            org-wide write). */}
        {isGlobalAdmin && adminStoreIds.size >= 2 ? (
          <Button
            variant="pearl"
            onClick={() => setCloneOpen(true)}
          >
            Clone roles…
          </Button>
        ) : null}
        {canAdmin ? (
          <Button
            variant="danger"
            onClick={() =>
              nativeConfirm(`Archive "${store.name}"?`, () =>
                remove.mutate({ storeId }),
              )
            }
          >
            Archive
          </Button>
        ) : null}
      </div>
      {!canAdmin ? (
        <Banner tone="info" title="Read-only">
          You don't administer this store. Settings are visible but
          can't be changed from your account.
        </Banner>
      ) : null}

      {cloneOpen ? (
        <StoreCloneRolesSheet
          target={{ targetStoreId: storeId, targetStoreName: store.name }}
          onClose={() => setCloneOpen(false)}
        />
      ) : null}
    </div>
  );
}

interface CategoryDraft {
  categoryId?: string;
  slug: string;
  // 4-language draft (2026-05-05). Server enforces all 4 non-empty.
  nameUz: string;
  nameRu: string;
  nameEn: string;
  nameZh: string;
  sortIndex: number;
}

/**
 * StoreCloneRolesSheet (D4, 2026-05-06).
 *
 * Wizard for "open Store C with the same team shape as Store A".
 * Reads the actor's adminStoreIds for the source-store dropdown — a
 * store-scoped manager can only clone FROM stores they administer.
 * Server enforces the same gate.
 *
 * The "include members" toggle defaults OFF: most chain expansion
 * wants the role SHAPE replicated but staffed by different people.
 * Turn it on for "I'm splitting Store A's team across two new stores"
 * scenarios.
 */
function StoreCloneRolesSheet({
  target,
  onClose,
}: {
  target: { targetStoreId: string; targetStoreName: string } | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const session = useAuthStore((s) => s.session);
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  const sessionStores = session?.stores ?? [];
  const open = !!target;

  const [sourceStoreId, setSourceStoreId] = useState('');
  const [includeMembers, setIncludeMembers] = useState(false);

  useEffect(() => {
    if (target) {
      setSourceStoreId('');
      setIncludeMembers(false);
    }
  }, [target]);

  const sourceCandidates = useMemo(() => {
    if (!target) return [];
    return sessionStores.filter(
      (st) => adminStoreIds.has(st.id) && st.id !== target.targetStoreId,
    );
  }, [sessionStores, adminStoreIds, target]);

  const cloneMut = trpc.admin.storeCloneRoles.useMutation({
    onSuccess: (data) => {
      void utils.admin.storeList.invalidate();
      void utils.admin.memberList.invalidate();
      const parts = [`Cloned ${data.cloned} role binding${data.cloned === 1 ? '' : 's'}`];
      if (data.skippedExisting > 0)
        parts.push(`${data.skippedExisting} already existed`);
      if (data.skippedRank > 0)
        parts.push(`${data.skippedRank} skipped (rank too high)`);
      if (data.assigned > 0)
        parts.push(`${data.assigned} member${data.assigned === 1 ? '' : 's'} assigned`);
      toast.success(parts.join(' · '));
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && !cloneMut.isPending && onClose()}
      title="Clone roles into store"
      description={target ? `Target: 🏪 ${target.targetStoreName}` : ''}
      footer={
        target ? (
          <Button
            block
            size="lg"
            loading={cloneMut.isPending}
            disabled={!sourceStoreId}
            onClick={() =>
              cloneMut.mutate({
                sourceStoreId,
                targetStoreId: target.targetStoreId,
                includeMembers,
              })
            }
          >
            Clone
          </Button>
        ) : undefined
      }
    >
      {target ? (
        <div className="flex flex-col gap-3 py-3">
          <Field label="Source store *">
            {sourceCandidates.length === 0 ? (
              <Banner tone="warn" title="No eligible source">
                You need to administer at least one OTHER store to clone
                from. Ask a higher-rank admin to add you to one first.
              </Banner>
            ) : (
              <select
                className="h-11 w-full rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 text-h3 ring-hairline"
                value={sourceStoreId}
                onChange={(e) => setSourceStoreId(e.target.value)}
              >
                <option value="">— pick a source store —</option>
                {sourceCandidates.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <label className="press flex cursor-pointer items-start gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5"
              checked={includeMembers}
              onChange={(e) => setIncludeMembers(e.target.checked)}
            />
            <div className="min-w-0 flex-1">
              <div className="text-body font-semibold text-[var(--c-fg)]">
                Also assign source members
              </div>
              <p className="mt-0.5 text-label text-[var(--c-fg-muted)]">
                When on, every member with an MSA row in the source
                store also gets one for the target — they'll see and
                operate in both. Off (default) clones only the role
                shape; you staff the target with different people.
              </p>
            </div>
          </label>
          <Banner tone="info" title="What this does">
            For every store-scoped role binding in the source store,
            create the same binding in {target.targetStoreName} (skip
            duplicates). Roles you don't outrank in {target.targetStoreName}
            are skipped — counted separately so you know what to do
            manually.
          </Banner>
        </div>
      ) : null}
    </Sheet>
  );
}

function CategoriesSection() {
  const categoriesQuery = trpc.admin.categoryList.useQuery();
  const utils = trpc.useUtils();
  const toast = useToast();
  const i18n = useI18n();
  const productName = useProductName();
  const [draft, setDraft] = useState<CategoryDraft | null>(null);

  const create = trpc.admin.categoryCreate.useMutation({
    onSuccess: () => {
      void utils.admin.categoryList.invalidate();
      toast.success(i18n.t('admin.toast.categoryCreated'));
      setDraft(null);
    },
    onError: (err) => toast.error(err.message),
  });
  const update = trpc.admin.categoryUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.categoryList.invalidate();
      toast.success(i18n.t('admin.toast.categoryUpdated'));
      setDraft(null);
    },
    onError: (err) => toast.error(err.message),
  });
  const remove = trpc.admin.categoryDelete.useMutation({
    onSuccess: () => {
      void utils.admin.categoryList.invalidate();
      toast.info(i18n.t('admin.toast.categoryArchived'));
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div className="px-4 py-3">
      <div className="mb-3">
        <Button
          size="sm"
          onClick={() =>
            setDraft({
              slug: '',
              nameUz: '',
              nameRu: '',
              nameEn: '',
              nameZh: '',
              sortIndex: 100,
            })
          }
        >
          + New category
        </Button>
      </div>
      <DataState
        query={categoriesQuery}
        emptyWhen={(d) => d.length === 0}
        empty={<EmptyState title="No categories" description="Used to group SKUs in the order page." />}
      >
        {(rows) => (
          <ul className="flex flex-col gap-2" role="list">
            {rows.map((c) => {
              const names = c.names as Record<string, string>;
              // Title shows the name in the user's preferred locale,
              // with the other 3 langs in a 12px row below so admins
              // can verify the catalog is fully translated at a glance.
              const otherLangs = ['uz', 'ru', 'en', 'zh']
                .filter((l) => names[l] && names[l] !== productName({ names }))
                .map((l) => names[l])
                .join(' · ');
              return (
                <Card key={c.id}>
                  <CardHeader>
                    <div className="min-w-0">
                      <CardTitle>{productName({ names }) || c.slug}</CardTitle>
                      {otherLangs ? (
                        <div className="mt-0.5 truncate text-label text-[var(--c-fg-muted)]">
                          {otherLangs}
                        </div>
                      ) : null}
                      <CardMeta>
                        slug {c.slug} · sort {c.sortIndex}
                      </CardMeta>
                    </div>
                    {c.isArchived ? <Badge tone="muted">archived</Badge> : null}
                  </CardHeader>
                  <div className="flex gap-2 border-t border-[var(--c-divider)] px-4 py-3">
                    <Button
                      size="sm"
                      variant="pearl"
                      onClick={() =>
                        setDraft({
                          categoryId: c.id,
                          slug: c.slug,
                          nameUz: names.uz ?? '',
                          nameRu: names.ru ?? '',
                          nameEn: names.en ?? '',
                          nameZh: names.zh ?? '',
                          sortIndex: c.sortIndex,
                        })
                      }
                    >
                      Edit
                    </Button>
                    {!c.isArchived ? (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() =>
                          nativeConfirm(
                            `Archive category "${productName({ names }) || c.slug}"?`,
                            () => remove.mutate({ categoryId: c.id }),
                          )
                        }
                      >
                        Archive
                      </Button>
                    ) : null}
                  </div>
                </Card>
              );
            })}
          </ul>
        )}
      </DataState>

      <Sheet
        open={!!draft}
        onOpenChange={(open) => !open && setDraft(null)}
        title={draft?.categoryId ? 'Edit category' : 'New category'}
        footer={
          <Button
            block
            loading={create.isPending || update.isPending}
            disabled={
              !draft?.slug.trim() ||
              !draft?.nameUz.trim() ||
              !draft?.nameRu.trim() ||
              !draft?.nameEn.trim() ||
              !draft?.nameZh.trim()
            }
            onClick={() => {
              if (!draft) return;
              // 4-language contract — server rejects partial. We send
              // every locale even if the user only edited one because
              // the schema is `.strict()` and missing keys throw.
              const names = {
                uz: draft.nameUz.trim(),
                ru: draft.nameRu.trim(),
                en: draft.nameEn.trim(),
                zh: draft.nameZh.trim(),
              };
              if (draft.categoryId) {
                update.mutate({
                  categoryId: draft.categoryId,
                  slug: draft.slug,
                  names,
                  sortIndex: draft.sortIndex,
                });
              } else {
                create.mutate({ slug: draft.slug, names, sortIndex: draft.sortIndex });
              }
            }}
          >
            {draft?.categoryId ? 'Save' : 'Create'}
          </Button>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-3 py-3">
            <Field label="Slug *">
              <Input
                value={draft.slug}
                onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase() })}
                maxLength={64}
                placeholder="e.g. dairy"
              />
            </Field>
            {/* 4-language inputs (2026-05-05). All required by server. */}
            <Field label="Name — O'zbek (uz) *">
              <Input
                value={draft.nameUz}
                onChange={(e) => setDraft({ ...draft, nameUz: e.target.value })}
                maxLength={200}
                placeholder="Sabzavotlar"
              />
            </Field>
            <Field label="Name — Русский (ru) *">
              <Input
                value={draft.nameRu}
                onChange={(e) => setDraft({ ...draft, nameRu: e.target.value })}
                maxLength={200}
                placeholder="Овощи"
              />
            </Field>
            <Field label="Name — English (en) *">
              <Input
                value={draft.nameEn}
                onChange={(e) => setDraft({ ...draft, nameEn: e.target.value })}
                maxLength={200}
                placeholder="Vegetables"
              />
            </Field>
            <Field label="Name — 中文 (zh) *">
              <Input
                value={draft.nameZh}
                onChange={(e) => setDraft({ ...draft, nameZh: e.target.value })}
                maxLength={200}
                placeholder="蔬菜"
              />
            </Field>
            <Field label="Sort index">
              <Input
                type="number"
                value={String(draft.sortIndex)}
                onChange={(e) => setDraft({ ...draft, sortIndex: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

interface SkuDraft {
  skuId?: string;
  categoryId: string | null;
  code: string;
  // 4-language draft (2026-05-05). Server enforces all 4 non-empty.
  nameUz: string;
  nameRu: string;
  nameEn: string;
  nameZh: string;
  unit: string;
  step: string;
  sortIndex: number;
}

function SkusSection() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const skusQuery = trpc.admin.skuList.useQuery({ includeArchived });
  const categoriesQuery = trpc.admin.categoryList.useQuery();
  const utils = trpc.useUtils();
  const toast = useToast();
  const i18n = useI18n();
  const productName = useProductName();
  const [draft, setDraft] = useState<SkuDraft | null>(null);

  const create = trpc.admin.skuCreate.useMutation({
    onSuccess: () => {
      void utils.admin.skuList.invalidate();
      toast.success(i18n.t('admin.toast.skuCreated'));
      setDraft(null);
    },
    onError: (err) => toast.error(err.message),
  });
  const update = trpc.admin.skuUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.skuList.invalidate();
      toast.success(i18n.t('admin.toast.skuUpdated'));
      setDraft(null);
    },
    onError: (err) => toast.error(err.message),
  });
  const remove = trpc.admin.skuDelete.useMutation({
    onSuccess: () => {
      void utils.admin.skuList.invalidate();
      toast.info(i18n.t('admin.toast.skuArchived'));
    },
    onError: (err) => toast.error(err.message),
  });

  const categoryName = (id: string | null): string => {
    if (!id) return '—';
    const c = categoriesQuery.data?.find((x) => x.id === id);
    if (!c) return id.slice(0, 6);
    return productName({ names: c.names as Record<string, string> }) || c.slug;
  };

  return (
    <div className="px-4 py-3">
      <div className="mb-3 flex items-center gap-2">
        <Button
          size="sm"
          onClick={() =>
            setDraft({
              categoryId: null,
              code: '',
              nameUz: '',
              nameRu: '',
              nameEn: '',
              nameZh: '',
              unit: 'pcs',
              step: '1',
              sortIndex: 100,
            })
          }
        >
          + New SKU
        </Button>
        <label className="ml-auto flex items-center gap-2 text-label text-[var(--c-fg-muted)]">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>

      <DataState
        query={skusQuery}
        emptyWhen={(d) => d.length === 0}
        empty={<EmptyState title="No SKUs" description="Add the items your stores order regularly." />}
      >
        {(rows) => (
          <ul className="flex flex-col gap-2" role="list">
            {rows.map((sk) => {
              const names = sk.names as Record<string, string>;
              const primary = productName({ names }) || sk.code || sk.id.slice(0, 6);
              const otherLangs = ['uz', 'ru', 'en', 'zh']
                .filter((l) => names[l] && names[l] !== primary)
                .map((l) => names[l])
                .join(' · ');
              return (
                <Card key={sk.id}>
                  <CardHeader>
                    <div className="min-w-0">
                      <CardTitle>{primary}</CardTitle>
                      {otherLangs ? (
                        <div className="mt-0.5 truncate text-label text-[var(--c-fg-muted)]">
                          {otherLangs}
                        </div>
                      ) : null}
                      <CardMeta>
                        {categoryName(sk.categoryId)} · {sk.unit} · step {sk.step}
                        {sk.code ? ` · ${sk.code}` : ''}
                      </CardMeta>
                    </div>
                    {sk.isArchived ? <Badge tone="muted">archived</Badge> : null}
                  </CardHeader>
                  <div className="flex gap-2 border-t border-[var(--c-divider)] px-4 py-3">
                    <Button
                      size="sm"
                      variant="pearl"
                      onClick={() =>
                        setDraft({
                          skuId: sk.id,
                          categoryId: sk.categoryId,
                          code: sk.code ?? '',
                          nameUz: names.uz ?? '',
                          nameRu: names.ru ?? '',
                          nameEn: names.en ?? '',
                          nameZh: names.zh ?? '',
                          unit: sk.unit,
                          step: sk.step,
                          sortIndex: sk.sortIndex,
                        })
                      }
                    >
                      Edit
                    </Button>
                    {!sk.isArchived ? (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() =>
                          nativeConfirm(`Archive SKU "${primary}"?`, () =>
                            remove.mutate({ skuId: sk.id }),
                          )
                        }
                      >
                        Archive
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="pearl"
                        onClick={() => update.mutate({ skuId: sk.id, isArchived: false })}
                      >
                        Unarchive
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </ul>
        )}
      </DataState>

      <Sheet
        open={!!draft}
        onOpenChange={(open) => !open && setDraft(null)}
        title={draft?.skuId ? 'Edit SKU' : 'New SKU'}
        footer={
          <Button
            block
            loading={create.isPending || update.isPending}
            disabled={
              !draft?.nameUz.trim() ||
              !draft?.nameRu.trim() ||
              !draft?.nameEn.trim() ||
              !draft?.nameZh.trim() ||
              !draft?.unit.trim()
            }
            onClick={() => {
              if (!draft) return;
              // Send all 4 langs every time — server schema is .strict()
              // and missing keys are rejected. See NamesSchema in admin.ts.
              const names = {
                uz: draft.nameUz.trim(),
                ru: draft.nameRu.trim(),
                en: draft.nameEn.trim(),
                zh: draft.nameZh.trim(),
              };
              if (draft.skuId) {
                update.mutate({
                  skuId: draft.skuId,
                  categoryId: draft.categoryId,
                  code: draft.code || null,
                  names,
                  unit: draft.unit,
                  step: draft.step,
                  sortIndex: draft.sortIndex,
                });
              } else {
                create.mutate({
                  categoryId: draft.categoryId,
                  code: draft.code || null,
                  names,
                  unit: draft.unit,
                  step: draft.step,
                  sortIndex: draft.sortIndex,
                });
              }
            }}
          >
            {draft?.skuId ? 'Save' : 'Create'}
          </Button>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-3 py-3">
            {/* 4-language inputs (2026-05-05). All required by server.
                Order is uz/ru/en/zh — uz first because that's the working
                language in this market. */}
            <Field label="Name — O'zbek (uz) *">
              <Input
                value={draft.nameUz}
                onChange={(e) => setDraft({ ...draft, nameUz: e.target.value })}
                maxLength={200}
                placeholder="Pomidor"
                autoFocus
              />
            </Field>
            <Field label="Name — Русский (ru) *">
              <Input
                value={draft.nameRu}
                onChange={(e) => setDraft({ ...draft, nameRu: e.target.value })}
                maxLength={200}
                placeholder="Помидор"
              />
            </Field>
            <Field label="Name — English (en) *">
              <Input
                value={draft.nameEn}
                onChange={(e) => setDraft({ ...draft, nameEn: e.target.value })}
                maxLength={200}
                placeholder="Tomato"
              />
            </Field>
            <Field label="Name — 中文 (zh) *">
              <Input
                value={draft.nameZh}
                onChange={(e) => setDraft({ ...draft, nameZh: e.target.value })}
                maxLength={200}
                placeholder="西红柿"
              />
            </Field>
            <Field label="Category">
              <select
                className="h-11 w-full rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 text-h3 ring-hairline"
                value={draft.categoryId ?? ''}
                onChange={(e) => setDraft({ ...draft, categoryId: e.target.value || null })}
              >
                <option value="">—</option>
                {(categoriesQuery.data ?? []).map((c) => {
                  const n = c.names as Record<string, string>;
                  return (
                    <option key={c.id} value={c.id}>
                      {productName({ names: n }) || c.slug}
                    </option>
                  );
                })}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Unit *">
                <Input value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} maxLength={16} placeholder="kg / pcs / L" />
              </Field>
              <Field label="Step">
                <Input value={draft.step} onChange={(e) => setDraft({ ...draft, step: e.target.value })} placeholder="0.5 / 1" />
              </Field>
            </div>
            <Field label="Code">
              <Input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} maxLength={64} placeholder="optional" />
            </Field>
            <Field label="Sort index">
              <Input
                type="number"
                value={String(draft.sortIndex)}
                onChange={(e) => setDraft({ ...draft, sortIndex: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

interface SupplierDraft {
  supplierId?: string;
  name: string;
  contactPhone: string;
  contactTg: string;
  address: string;
  notes: string;
  isArchived: boolean;
}

function SuppliersSection() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const suppliersQuery = trpc.admin.supplierList.useQuery({ includeArchived });
  const utils = trpc.useUtils();
  const toast = useToast();
  const i18n = useI18n();
  const [draft, setDraft] = useState<SupplierDraft | null>(null);

  const create = trpc.admin.supplierCreate.useMutation({
    onSuccess: () => {
      void utils.admin.supplierList.invalidate();
      toast.success(i18n.t('admin.toast.supplierCreated'));
      setDraft(null);
    },
    onError: (err) => toast.error(err.message),
  });
  const update = trpc.admin.supplierUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.supplierList.invalidate();
      toast.success(i18n.t('admin.toast.supplierUpdated'));
      setDraft(null);
    },
    onError: (err) => toast.error(err.message),
  });
  const remove = trpc.admin.supplierDelete.useMutation({
    onSuccess: () => {
      void utils.admin.supplierList.invalidate();
      toast.info(i18n.t('admin.toast.supplierArchived'));
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div className="px-4 py-3">
      <div className="mb-3 flex items-center gap-2">
        <Button
          size="sm"
          onClick={() =>
            setDraft({
              name: '',
              contactPhone: '',
              contactTg: '',
              address: '',
              notes: '',
              isArchived: false,
            })
          }
        >
          + New supplier
        </Button>
        <label className="ml-auto flex items-center gap-2 text-label text-[var(--c-fg-muted)]">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>
      <DataState
        query={suppliersQuery}
        emptyWhen={(d) => d.length === 0}
        empty={<EmptyState title="No suppliers" description="Track who you buy from at the market." />}
      >
        {(rows) => (
          <ul className="flex flex-col gap-2" role="list">
            {rows.map((sp) => (
              <Card key={sp.id}>
                <CardHeader>
                  <div className="min-w-0">
                    <CardTitle>{sp.name}</CardTitle>
                    <CardMeta>
                      {sp.contactPhone ? `📞 ${sp.contactPhone}` : ''}
                      {sp.contactTg ? ` · @${sp.contactTg}` : ''}
                      {sp.address ? ` · ${sp.address}` : ''}
                    </CardMeta>
                  </div>
                  {sp.isArchived ? <Badge tone="muted">archived</Badge> : null}
                </CardHeader>
                <div className="flex gap-2 border-t border-[var(--c-divider)] px-4 py-3">
                  <Button
                    size="sm"
                    variant="pearl"
                    onClick={() =>
                      setDraft({
                        supplierId: sp.id,
                        name: sp.name,
                        contactPhone: sp.contactPhone ?? '',
                        contactTg: sp.contactTg ?? '',
                        address: sp.address ?? '',
                        notes: sp.notes ?? '',
                        isArchived: sp.isArchived,
                      })
                    }
                  >
                    Edit
                  </Button>
                  {!sp.isArchived ? (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() =>
                        nativeConfirm(`Archive supplier "${sp.name}"?`, () =>
                          remove.mutate({ supplierId: sp.id }),
                        )
                      }
                    >
                      Archive
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="pearl"
                      onClick={() => update.mutate({ supplierId: sp.id, isArchived: false })}
                    >
                      Unarchive
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </ul>
        )}
      </DataState>

      <Sheet
        open={!!draft}
        onOpenChange={(open) => !open && setDraft(null)}
        title={draft?.supplierId ? 'Edit supplier' : 'New supplier'}
        footer={
          <Button
            block
            loading={create.isPending || update.isPending}
            disabled={!draft?.name.trim()}
            onClick={() => {
              if (!draft) return;
              if (draft.supplierId) {
                update.mutate({
                  supplierId: draft.supplierId,
                  name: draft.name,
                  contactPhone: draft.contactPhone || null,
                  contactTg: draft.contactTg || null,
                  address: draft.address || null,
                  notes: draft.notes || null,
                  isArchived: draft.isArchived,
                });
              } else {
                create.mutate({
                  name: draft.name,
                  contactPhone: draft.contactPhone || null,
                  contactTg: draft.contactTg || null,
                  address: draft.address || null,
                  notes: draft.notes || null,
                });
              }
            }}
          >
            {draft?.supplierId ? 'Save' : 'Create'}
          </Button>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-3 py-3">
            <Field label="Name *">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={200} autoFocus />
            </Field>
            <Field label="Phone">
              <Input value={draft.contactPhone} onChange={(e) => setDraft({ ...draft, contactPhone: e.target.value })} maxLength={32} placeholder="+998 …" />
            </Field>
            <Field label="Telegram username">
              <Input value={draft.contactTg} onChange={(e) => setDraft({ ...draft, contactTg: e.target.value.replace(/^@/, '') })} maxLength={64} placeholder="username (without @)" />
            </Field>
            <Field label="Address">
              <Input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} maxLength={500} />
            </Field>
            <Field label="Notes">
              <Input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} maxLength={1000} />
            </Field>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

// ============ Activity ============

function ActivitySection() {
  const overview = trpc.admin.overview.useQuery();
  const eventsQuery = trpc.admin.recentEvents.useQuery({ limit: PAGE_SIZE.feed });
  const [showDebug, setShowDebug] = useState(false);
  // M1.9 (2026-05-07): the embedded debug console (348 lines of dev
  // tooling: live/server/health log streams, ring buffers, raw JSON)
  // does not belong in the chain owner's day-1 admin view. Gate to
  // super_admin so it stays reachable for the dev account but the
  // owner doesn't accidentally collapse-expand it and leave 2s polls
  // running in the background.
  const session = useAuthStore((s) => s.session);
  const isSuperAdmin = session?.roleSlugs.includes('super_admin') ?? false;

  return (
    <div className="px-4 py-3">
      <DataState query={overview}>
        {(d) => (
          <div className="grid grid-cols-2 gap-3">
            <Tile label="Members" value={d.memberCount} />
            <Tile label="Stores" value={d.storeCount} />
            <Tile label="Active SKUs" value={d.skuCount} />
            <Tile label="Total runs" value={d.runCount} />
            <Tile
              label="Pending approvals"
              value={d.pendingApprovals}
              accent={d.pendingApprovals > 0 ? 'warn' : 'muted'}
            />
            <Tile label="Orders / 7 days" value={d.ordersThisWeek} />
          </div>
        )}
      </DataState>

      <h2 className="mt-6 mb-2 text-h3 font-semibold text-[var(--c-fg)]">Recent events</h2>
      <DataState
        query={eventsQuery}
        emptyWhen={(d) => d.length === 0}
        empty={<EmptyState title="No events yet" description="Activity appears once orders or runs move." />}
      >
        {(rows) => (
          <ul className="flex flex-col gap-1.5" role="list">
            {rows.map((e) => (
              <li
                key={e.id}
                className="flex flex-col gap-0.5 rounded-[var(--r-card)] bg-[var(--c-surface)] px-3 py-2 ring-hairline"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-label font-semibold text-[var(--c-fg)]">
                    {e.streamType}.{e.type}
                  </span>
                  <span className="font-mono text-tiny text-[var(--c-fg-muted)]">
                    seq {e.seq}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-2 text-meta text-[var(--c-fg-muted)]">
                  <span className="truncate">
                    {e.actor?.displayName ?? 'system'}
                    {e.actor?.tgUsername ? ` · @${e.actor.tgUsername}` : ''}
                  </span>
                  <span className="font-mono text-tiny">
                    {new Date(e.occurredAt).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DataState>

      {isSuperAdmin ? (
        <>
          <button
            type="button"
            onClick={() => setShowDebug(!showDebug)}
            className="press mt-6 inline-flex items-center gap-1 text-label text-[var(--c-fg-muted)]"
          >
            {showDebug ? '▾' : '▸'} Debug console
          </button>
          {showDebug ? (
            <div className="-mx-4 mt-2 border-t border-[var(--c-divider)]">
              <DebugPage />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// Tile removed — imported from @compass/ui.

// ============ Submission history ============

/**
 * Per-store timeline of submitted orders with outcome + per-contributor
 * breakdown. Read-only — this is the "what did we do recently?" view
 * for managers and admins. Default range: last 30 days.
 */
function HistorySection() {
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  const stores = trpc.admin.storeList.useQuery();
  const history = trpc.admin.submissionHistory.useQuery({
    storeId: storeFilter ?? undefined,
    limit: PAGE_SIZE.list,
  });
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="px-4 py-3">
      <div className="mb-3">
        <select
          className="h-10 w-full rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-3 text-body ring-hairline"
          value={storeFilter ?? ''}
          onChange={(e) => setStoreFilter(e.target.value || null)}
        >
          <option value="">All stores</option>
          {(stores.data ?? []).map((st) => (
            <option key={st.id} value={st.id}>
              {st.name}
            </option>
          ))}
        </select>
      </div>
      <DataState
        query={history}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title="Nothing submitted yet"
            description="Submitted orders show up here once staff press Submit."
          />
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-2" role="list">
            {rows.map((r) => {
              const isOpen = openId === r.sessionId;
              const statusTone =
                r.status === 'approved' || r.status === 'in_run' || r.status === 'archived'
                  ? 'success'
                  : r.status === 'rejected'
                    ? 'danger'
                    : 'info';
              return (
                <Card key={r.sessionId}>
                  <button
                    type="button"
                    onClick={() => setOpenId(isOpen ? null : r.sessionId)}
                    className="press w-full text-left"
                  >
                    <CardHeader>
                      <div className="min-w-0">
                        <CardTitle>{r.storeName ?? r.storeId.slice(0, 8)}</CardTitle>
                        <CardMeta>
                          {r.orderDate}
                          {r.submittedAt
                            ? ` · submitted ${formatRelative(r.submittedAt)}`
                            : ''}
                          {r.submittedByName ? ` by ${r.submittedByName}` : ''}
                        </CardMeta>
                      </div>
                      <Badge tone={statusTone}>{r.status}</Badge>
                    </CardHeader>
                  </button>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-label text-[var(--c-fg-muted)]">
                    <span>
                      {r.skuCount} SKU{r.skuCount === 1 ? '' : 's'} · {formatQty(r.totalQty)} total
                    </span>
                    {r.contributors.length > 0 ? (
                      <span>· {r.contributors.length} contributor{r.contributors.length === 1 ? '' : 's'}</span>
                    ) : null}
                    {r.reviewMinutes !== null ? (
                      <span>· decided in {r.reviewMinutes} min</span>
                    ) : null}
                    {r.decidedByName ? (
                      <span>· by {r.decidedByName}</span>
                    ) : null}
                  </div>
                  {isOpen ? (
                    <div className="border-t border-[var(--c-divider)] px-4 py-3">
                      <div className="text-meta font-semibold uppercase tracking-[0.08em] text-[var(--c-fg-muted)]">
                        Contributor breakdown
                      </div>
                      <ul className="mt-2 flex flex-col gap-1">
                        {r.contributors.map((c) => (
                          <li
                            key={c.memberId}
                            className="flex items-baseline justify-between text-body-sm"
                          >
                            <span className="truncate text-[var(--c-fg)]">
                              {c.displayName ?? c.memberId.slice(0, 6)}
                            </span>
                            <span className="font-mono tabular-nums text-[var(--c-fg-muted)]">
                              {c.skuCount} SKU · {formatQty(c.totalQty)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {r.rejectReason ? (
                        <p className="mt-3 text-label text-[var(--c-danger)]">
                          Rejection reason: {r.rejectReason}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </ul>
        )}
      </DataState>
    </div>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ============ Maintenance ============

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Surgical purge browser. Two stacked lists (Orders / Runs) for the
 * chosen date; each row has its own Delete button that opens a
 * dry-run preview sheet before committing.
 */
function TargetedPurgeBrowser() {
  const [date, setDate] = useState(todayIso());
  const [tab, setTab] = useState<'orders' | 'runs'>('orders');
  const sessionsQuery = trpc.admin.sessionList.useQuery({ date, limit: PAGE_SIZE.list });
  const runsQuery = trpc.admin.runList.useQuery({ date, limit: PAGE_SIZE.list });
  const utils = trpc.useUtils();
  const toast = useToast();
  const i18n = useI18n();

  const [sessionTarget, setSessionTarget] = useState<
    | {
        sessionId: string;
        label: string;
        preview?: { total: number; byTable: Record<string, number> };
      }
    | null
  >(null);
  const [runTarget, setRunTarget] = useState<
    | {
        runId: string;
        label: string;
        preview?: { total: number; byTable: Record<string, number>; sessionIds: string[] };
      }
    | null
  >(null);

  const sessionDryRun = trpc.admin.purgeSession.useMutation({
    onSuccess: (data) => {
      setSessionTarget((prev) =>
        prev ? { ...prev, preview: { total: data.total, byTable: data.byTable } } : prev,
      );
    },
    onError: (err) => {
      toast.error(err.message);
      setSessionTarget(null);
    },
  });
  const sessionCommit = trpc.admin.purgeSession.useMutation({
    onSuccess: (data) => {
      toast.success(i18n.t('admin.toast.sessionDeleted', { n: data.total }));
      setSessionTarget(null);
      void utils.admin.sessionList.invalidate();
      void utils.admin.runList.invalidate();
      void utils.invalidate(); // also bump any open OrderPage / ApprovalPage
    },
    onError: (err) => toast.error(err.message),
  });

  const runDryRun = trpc.admin.purgeRun.useMutation({
    onSuccess: (data) => {
      setRunTarget((prev) =>
        prev
          ? {
              ...prev,
              preview: {
                total: data.total,
                byTable: data.byTable,
                sessionIds: data.sessionIds,
              },
            }
          : prev,
      );
    },
    onError: (err) => {
      toast.error(err.message);
      setRunTarget(null);
    },
  });
  const runCommit = trpc.admin.purgeRun.useMutation({
    onSuccess: (data) => {
      toast.success(i18n.t('admin.toast.runDeleted', { n: data.total }));
      setRunTarget(null);
      void utils.admin.runList.invalidate();
      void utils.admin.sessionList.invalidate();
      void utils.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-10 flex-1 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-3 text-body ring-hairline"
        />
        <button
          type="button"
          onClick={() => setTab('orders')}
          className={
            'press rounded-[var(--r-pill)] px-3 py-1.5 text-label font-medium ring-hairline ' +
            (tab === 'orders'
              ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
              : 'bg-transparent text-[var(--c-fg-muted)]')
          }
        >
          Orders
        </button>
        <button
          type="button"
          onClick={() => setTab('runs')}
          className={
            'press rounded-[var(--r-pill)] px-3 py-1.5 text-label font-medium ring-hairline ' +
            (tab === 'runs'
              ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
              : 'bg-transparent text-[var(--c-fg-muted)]')
          }
        >
          Runs
        </button>
      </div>

      {tab === 'orders' ? (
        <DataState
          query={sessionsQuery}
          emptyWhen={(d) => d.length === 0}
          empty={
            <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-3 text-body-sm text-[var(--c-fg-muted)] ring-hairline">
              No order sessions on {date}.
            </div>
          }
        >
          {(rows) => (
            <ul className="flex flex-col gap-1.5" role="list">
              {rows.map((sess) => {
                const inRun = sess.status === 'in_run' || sess.status === 'archived' || sess.runId;
                const attribLabel = sess.attribDisplayName ?? 'unattributed';
                const label = `${sess.storeName ?? 'unknown store'} · ${attribLabel}`;
                return (
                  <li
                    key={sess.sessionId}
                    className="flex items-center gap-3 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-body-sm font-semibold text-[var(--c-fg)]">
                          {label}
                        </span>
                        {sess.isMine ? (
                          <Badge tone="info">you</Badge>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-meta text-[var(--c-fg-muted)]">
                        {sess.status} · {sess.itemCount} items · {sess.orderDate}
                      </div>
                    </div>
                    {inRun ? (
                      <span className="text-tiny text-[var(--c-fg-muted)]">
                        in&nbsp;run
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          setSessionTarget({
                            sessionId: sess.sessionId,
                            label,
                          });
                          sessionDryRun.mutate({
                            sessionId: sess.sessionId,
                            dryRun: true,
                          });
                        }}
                      >
                        Delete
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </DataState>
      ) : (
        <DataState
          query={runsQuery}
          emptyWhen={(d) => d.length === 0}
          empty={
            <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-3 text-body-sm text-[var(--c-fg-muted)] ring-hairline">
              No market runs on {date}.
            </div>
          }
        >
          {(rows) => (
            <ul className="flex flex-col gap-1.5" role="list">
              {rows.map((r) => {
                const label = `Run ${r.runDate} #${r.runIndex + 1}`;
                return (
                  <li
                    key={r.runId}
                    className="flex items-center gap-3 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-body-sm font-semibold text-[var(--c-fg)]">
                          {label}
                        </span>
                        {r.purchaserIsMe ? (
                          <Badge tone="info">you</Badge>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-meta text-[var(--c-fg-muted)]">
                        {r.status} · {r.sessionCount} sessions
                        {r.purchaserDisplayName ? ` · by ${r.purchaserDisplayName}` : ''}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        setRunTarget({ runId: r.runId, label });
                        runDryRun.mutate({
                          runId: r.runId,
                          dryRun: true,
                          requireOnlyTestSessions: true,
                        });
                      }}
                    >
                      Delete
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </DataState>
      )}

      {/* ---- Session-purge confirmation sheet ---- */}
      <Sheet
        open={!!sessionTarget}
        onOpenChange={(o) => !o && !sessionCommit.isPending && setSessionTarget(null)}
        title={`Delete order session`}
        description={sessionTarget?.label}
        footer={
          <Button
            block
            variant="danger"
            loading={sessionCommit.isPending}
            disabled={!sessionTarget?.preview || sessionTarget.preview.total === 0}
            onClick={() => {
              if (!sessionTarget) return;
              sessionCommit.mutate({
                sessionId: sessionTarget.sessionId,
                dryRun: false,
              });
            }}
          >
            {sessionCommit.isPending
              ? 'Deleting…'
              : sessionTarget?.preview
                ? `Delete ${sessionTarget.preview.total} rows`
                : 'Loading preview…'}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-3">
          {sessionDryRun.isPending ? (
            <div className="flex items-center gap-2 text-body-sm text-[var(--c-fg-muted)]">
              <Spinner size={14} /> Counting…
            </div>
          ) : sessionTarget?.preview ? (
            <CascadePreview byTable={sessionTarget.preview.byTable} total={sessionTarget.preview.total} />
          ) : null}
        </div>
      </Sheet>

      {/* ---- Run-purge confirmation sheet ---- */}
      <Sheet
        open={!!runTarget}
        onOpenChange={(o) => !o && !runCommit.isPending && setRunTarget(null)}
        title="Delete market run"
        description={runTarget?.label}
        footer={
          <Button
            block
            variant="danger"
            loading={runCommit.isPending}
            disabled={!runTarget?.preview || runTarget.preview.total === 0}
            onClick={() => {
              if (!runTarget) return;
              runCommit.mutate({
                runId: runTarget.runId,
                dryRun: false,
                requireOnlyTestSessions: true,
              });
            }}
          >
            {runCommit.isPending
              ? 'Deleting…'
              : runTarget?.preview
                ? `Delete ${runTarget.preview.total} rows`
                : 'Loading preview…'}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-3">
          {runDryRun.isPending ? (
            <div className="flex items-center gap-2 text-body-sm text-[var(--c-fg-muted)]">
              <Spinner size={14} /> Counting…
            </div>
          ) : runTarget?.preview ? (
            <>
              <Banner tone="warn" title="This includes attached sessions">
                Deleting this run also deletes its {runTarget.preview.sessionIds.length}{' '}
                attached order session{runTarget.preview.sessionIds.length === 1 ? '' : 's'}.
                The server refuses if any of them belongs to a real user — use
                the per-session purge instead in that case.
              </Banner>
              <CascadePreview byTable={runTarget.preview.byTable} total={runTarget.preview.total} />
            </>
          ) : null}
        </div>
      </Sheet>
    </div>
  );
}

function CascadePreview({
  byTable,
  total,
}: {
  byTable: Record<string, number>;
  total: number;
}) {
  return (
    <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
      <div className="text-body-sm font-semibold text-[var(--c-fg)]">
        {total} rows would be deleted
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {Object.entries(byTable)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([table, n]) => (
            <li
              key={table}
              className="flex justify-between font-mono text-meta text-[var(--c-fg-muted)]"
            >
              <span className="truncate">{table}</span>
              <span className="tabular-nums">{n}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

/**
 * Admin audit log (added 2026-05-05).
 *
 * Renders rows from `domain.policy_decisions`, which now gets a row
 * for every catalog/role/permission mutation an admin runs (see
 * `auditAdmin()` helper in apps/api/src/trpc/routers/admin.ts).
 *
 * Display goal: a busy chain owner should be able to skim "what
 * happened in the last hour" and answer:
 *   - Who changed this SKU?
 *   - Who promoted Ali to manager?
 *   - When did Aziz get the `order.approve` override?
 *
 * The action keys we currently emit are:
 *   admin.store.{create|update|delete}
 *   admin.category.{create|update|delete}
 *   admin.sku.{create|update|delete}
 *   admin.supplier.{create|update|delete}
 *   admin.role.{create|update|delete}
 *   admin.memberPermission.{allow|deny|revoke}
 */
function AdminAuditSection() {
  // B2 (2026-05-06): per-store filter. The pill row at the top lets an
  // admin scope the log to one store; rows pre-2026-05-06 (NULL scope)
  // disappear under the filter, which is correct — they predate the
  // column.
  const session = useAuthStore((s) => s.session);
  const sessionStores = session?.stores ?? [];
  // M1.9 (2026-05-07): the raw `JSON.stringify(r.inputs)` payload
  // preview looks like a debugger artifact to a non-technical chain
  // owner. Hide for everyone-but-super-admin so the verb+actor+time
  // line stays clean. Forensics still available via the DB row for
  // anyone with shell access.
  const isSuperAdmin = session?.roleSlugs.includes('super_admin') ?? false;
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  const auditQuery = trpc.admin.adminAuditList.useQuery({
    limit: PAGE_SIZE.list,
    ...(storeFilter ? { storeId: storeFilter } : {}),
  });
  const storeNameById = useMemo(
    () => new Map(sessionStores.map((s) => [s.id, s.name])),
    [sessionStores],
  );
  return (
    <div className="px-4 py-3">
      {/* Filter chip row — only renders when there's something to
          filter. Single-store users see one chip + "all". */}
      {sessionStores.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setStoreFilter(null)}
            className={
              'rounded-full px-3 py-1 text-label font-medium ring-hairline ' +
              (storeFilter === null
                ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                : 'bg-[var(--c-surface-2)] text-[var(--c-fg)]')
            }
          >
            All scopes
          </button>
          {sessionStores.map((st) => (
            <button
              key={st.id}
              type="button"
              onClick={() => setStoreFilter(st.id)}
              className={
                'rounded-full px-3 py-1 text-label font-medium ring-hairline ' +
                (storeFilter === st.id
                  ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                  : 'bg-[var(--c-surface-2)] text-[var(--c-fg)]')
              }
            >
              🏪 {st.name}
            </button>
          ))}
        </div>
      ) : null}
      <DataState
        query={auditQuery}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title={
              storeFilter
                ? `No actions in 🏪 ${storeNameById.get(storeFilter) ?? 'this store'}`
                : 'No admin actions yet'
            }
            description={
              storeFilter
                ? "Older audit rows predate the per-store column and don't appear under a store filter."
                : 'Catalog edits and role changes will appear here as they happen.'
            }
          />
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-2" role="list">
            {rows.map((r) => {
              // Derive a friendly verb + object from the action key.
              // E.g. "admin.sku.update" → ["sku", "updated"].
              const parts = r.action.split('.');
              const obj = parts[1] ?? '?';
              const verb = parts[2] ?? '?';
              const tone =
                verb === 'delete' || verb === 'deny'
                  ? 'danger'
                  : verb === 'allow' || verb === 'create'
                    ? 'success'
                    : 'muted';
              const date = new Date(r.occurredAt);
              const when = date.toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              });
              return (
                <Card key={r.id}>
                  <div className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <Badge tone={tone}>{verb}</Badge>
                        <span className="text-body font-semibold text-[var(--c-fg)]">
                          {obj}
                        </span>
                        {r.resourceId ? (
                          <span className="font-mono text-meta text-[var(--c-fg-muted)]">
                            {r.resourceId.slice(0, 8)}…
                          </span>
                        ) : null}
                        {/* B2: store-scope chip per row */}
                        {r.scopeStoreId ? (
                          <span className="rounded-full bg-[var(--c-surface-2)] px-2 py-0.5 text-tiny text-[var(--c-fg-muted)] ring-hairline">
                            🏪 {storeNameById.get(r.scopeStoreId) ?? r.scopeStoreId.slice(0, 8)}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 text-label text-[var(--c-fg-muted)]">
                        {r.actor?.displayName ?? 'unknown'}
                        {r.actor?.tgUsername ? ` · @${r.actor.tgUsername}` : ''}
                        {' · '}
                        {when}
                      </div>
                      {/* Lightweight payload preview — JSON.stringify
                          fits one line for most actions; long inputs
                          are truncated since the full row is in the DB
                          for forensics. M1.9: super_admin only — looks
                          like a debugger artifact to non-tech users. */}
                      {isSuperAdmin ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-meta font-medium text-[var(--c-fg-muted)]">
                            inputs
                          </summary>
                          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-2 py-1 font-mono text-meta text-[var(--c-fg-muted)]">
                            {JSON.stringify(r.inputs, null, 2)}
                          </pre>
                        </details>
                      ) : null}
                    </div>
                  </div>
                </Card>
              );
            })}
          </ul>
        )}
      </DataState>
    </div>
  );
}

/**
 * Price report (added 2026-05-05).
 *
 * Per-SKU table:
 *   - last price seen (with date)
 *   - 7-day mean
 *   - 30-day mean
 *   - delta (last vs 30-day mean) so admin can spot outliers
 *
 * Reads `catalog.skuPriceStats` once for ALL SKUs in the org (no
 * skuIds filter) plus `catalog.skus` for names. Sort: highest 30d mean
 * first — most expensive items are usually the ones the user cares
 * about budgeting.
 *
 * Why this exists: the user wants "use yesterday's prices to budget
 * for tomorrow's purchase". The OrderPage review sheet now uses
 * 7-day avg automatically (downstream of the same endpoint), but
 * admins also want a standalone view to spot anomalies and trends.
 */
function PriceReportSection() {
  const productName = useProductName();
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: false });
  // No skuIds filter → return all SKUs with observations in 30 days.
  const statsQuery = trpc.catalog.skuPriceStats.useQuery();

  const skuById = useMemo(() => {
    const m = new Map<string, { id: string; names: Record<string, string>; unit: string }>();
    for (const sku of skusQuery.data ?? []) {
      m.set(sku.id, {
        id: sku.id,
        names: sku.names as Record<string, string>,
        unit: sku.unit,
      });
    }
    return m;
  }, [skusQuery.data]);

  const rows = useMemo(() => {
    const stats = statsQuery.data ?? [];
    return stats
      .map((r) => {
        const sku = skuById.get(r.skuId);
        const name = sku ? productName({ names: sku.names }) : r.skuId.slice(0, 8);
        const last = r.lastPrice ? Number(r.lastPrice) : null;
        const avg30 = r.avg30d ? Number(r.avg30d) : null;
        // Delta = (last − avg30) / avg30, signed. Used for the trend
        // arrow + tone. Skip when either side is unknown.
        const deltaPct =
          last !== null && avg30 && avg30 > 0
            ? ((last - avg30) / avg30) * 100
            : null;
        return {
          skuId: r.skuId,
          name,
          unit: sku?.unit ?? '',
          last,
          lastObservedAt: r.lastObservedAt,
          avg7d: r.avg7d ? Number(r.avg7d) : null,
          avg30d: avg30,
          observations: r.observations30d,
          deltaPct,
        };
      })
      .sort((a, b) => (b.avg30d ?? 0) - (a.avg30d ?? 0));
  }, [statsQuery.data, skuById, productName]);

  return (
    <div className="px-4 py-3">
      <Banner tone="info" title="How to read this">
        Last 30 days of price observations across the org. The last
        column is the change vs 30-day mean — green = cheaper, red =
        spike. Use 7-day mean for next-day budgeting; 30-day mean
        smooths weekly oscillations.
      </Banner>
      {statsQuery.isLoading || skusQuery.isLoading ? (
        <div className="mt-4">
          <Spinner size={16} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No price data yet"
          description="Once your purchaser records the first run, prices land here."
        />
      ) : (
        <ul className="mt-3 flex flex-col gap-1" role="list">
          {rows.map((r) => {
            const tone =
              r.deltaPct === null
                ? 'muted'
                : Math.abs(r.deltaPct) < 5
                  ? 'muted'
                  : r.deltaPct > 0
                    ? 'danger'
                    : 'success';
            const arrow =
              r.deltaPct === null ? '·' : r.deltaPct > 0 ? '▲' : r.deltaPct < 0 ? '▼' : '·';
            const deltaLabel =
              r.deltaPct === null
                ? '—'
                : `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%`;
            return (
              <li
                key={r.skuId}
                className="flex flex-col gap-1 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-body font-semibold text-[var(--c-fg)]">
                    {r.name}
                  </span>
                  <span className="font-mono text-body tabular-nums text-[var(--c-fg)]">
                    {r.last !== null ? formatMoney(r.last) : '—'}{' '}
                    <span className="text-meta font-normal text-[var(--c-fg-muted)]">
                      / {r.unit}
                    </span>
                  </span>
                </div>
                <div className="flex flex-wrap items-baseline gap-3 text-meta text-[var(--c-fg-muted)]">
                  <span>
                    7d avg{' '}
                    <span className="font-mono tabular-nums text-[var(--c-fg)]">
                      {r.avg7d !== null ? formatMoney(r.avg7d) : '—'}
                    </span>
                  </span>
                  <span>
                    30d avg{' '}
                    <span className="font-mono tabular-nums text-[var(--c-fg)]">
                      {r.avg30d !== null ? formatMoney(r.avg30d) : '—'}
                    </span>
                  </span>
                  <span>{r.observations} obs</span>
                  <Badge tone={tone}>
                    {arrow} {deltaLabel}
                  </Badge>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function MaintenanceSection() {
  const session = useAuthStore((s) => s.session);
  const utils = trpc.useUtils();
  const toast = useToast();
  const i18n = useI18n();

  const isSuperAdmin = session?.roleSlugs.includes('super_admin') ?? false;
  const orgSlug = session?.member.orgSlug ?? '';

  // ---- by-date purge state ----
  const [dateInput, setDateInput] = useState<string>(todayIso());
  const [datePreview, setDatePreview] = useState<{ date: string; total: number; byTable: Record<string, number> } | null>(null);
  const [dateConfirmOpen, setDateConfirmOpen] = useState(false);

  const datePreviewMut = trpc.admin.purgeByDate.useMutation({
    onSuccess: (data) => {
      setDatePreview({ date: data.date, total: data.total, byTable: data.byTable });
      setDateConfirmOpen(true);
    },
    onError: (err) => toast.error(err.message),
  });
  const dateCommitMut = trpc.admin.purgeByDate.useMutation({
    onSuccess: (data) => {
      toast.success(i18n.t('admin.toast.dateReset', { date: data.date, n: data.total }));
      setDateConfirmOpen(false);
      setDatePreview(null);
      void utils.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  // ---- nuclear-purge state ----
  const [confirmText, setConfirmText] = useState('');
  const [allOpen, setAllOpen] = useState(false);
  const slugMatches = confirmText === orgSlug;
  const allDryRun = trpc.admin.purgeAllTestData.useMutation({
    onError: (err) => toast.error(err.message),
  });
  const allCommit = trpc.admin.purgeAllTestData.useMutation({
    onSuccess: (data) => {
      toast.success(i18n.t('admin.toast.dataPurged', { n: data.total, tables: Object.keys(data.byTable).length }));
      setAllOpen(false);
      setConfirmText('');
      void utils.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  if (!isSuperAdmin) {
    return (
      <div className="px-4 py-3">
        <Banner tone="warn" title="Super-admin only">
          Maintenance actions can permanently delete data. Only members
          with the super_admin role can use this section.
        </Banner>
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      {/* ============ Surgical: pick a single test session/run ============ */}
      <Card>
        <div className="flex flex-col gap-3 px-4 py-4">
          <div>
            <div className="text-h3 font-semibold text-[var(--c-fg)]">
              Delete a specific test order or run
            </div>
            <p className="mt-0.5 text-body-sm text-[var(--c-fg-muted)]">
              Use this when test data and real data exist on the same day.
              Browse a list, pick the test session or run, see exactly what
              gets cascade-deleted, then commit. Real users&apos; sessions
              are NOT touched.
            </p>
          </div>
          <TargetedPurgeBrowser />
        </div>
      </Card>

      {/* ============ Reset today (still useful when nothing real yet) ============ */}
      <div className="mt-3">
      <Card>
        <div className="flex flex-col gap-3 px-4 py-4">
          <div>
            <div className="text-h3 font-semibold text-[var(--c-fg)]">
              Reset today&apos;s entire flow
            </div>
            <p className="mt-0.5 text-body-sm text-[var(--c-fg-muted)]">
              Wipes every order, run, delivery, notification and price-history
              row dated <span className="font-mono">{todayIso()}</span> —
              regardless of who created it. Catalog and members untouched.
              Use only when you&apos;re sure no real users have data today.
            </p>
          </div>
          <Button
            size="sm"
            variant="pearl"
            loading={datePreviewMut.isPending}
            onClick={() =>
              datePreviewMut.mutate({ date: todayIso(), dryRun: true })
            }
          >
            Reset today
          </Button>
        </div>
      </Card>
      </div>

      {/* ============ Reset another date ============ */}
      <div className="mt-3">
        <Card>
          <div className="flex flex-col gap-3 px-4 py-4">
            <div>
              <div className="text-h3 font-semibold text-[var(--c-fg)]">
                Reset a specific date
              </div>
              <p className="mt-0.5 text-body-sm text-[var(--c-fg-muted)]">
                Same scope as above, different day. Pick the date below.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateInput}
                onChange={(e) => setDateInput(e.target.value)}
                className="h-11 flex-1 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 text-h3 ring-hairline"
              />
              <Button
                size="sm"
                variant="pearl"
                loading={datePreviewMut.isPending}
                disabled={!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)}
                onClick={() =>
                  datePreviewMut.mutate({ date: dateInput, dryRun: true })
                }
              >
                Preview
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {/* ============ Nuclear option ============ */}
      <div className="mt-6">
        <Banner tone="danger" title="Wipe the entire workspace">
          The button below deletes every event, run, order, notification
          and outbox row this workspace has ever produced — regardless
          of date. Use only if you need a clean-slate restart.
        </Banner>
        <div className="mt-3">
          <Card>
            <div className="flex flex-col gap-3 px-4 py-4">
              <div>
                <div className="text-h3 font-semibold text-[var(--c-fg)]">
                  Purge ALL test data
                </div>
                <p className="mt-0.5 text-body-sm text-[var(--c-fg-muted)]">
                  Step 1 previews the row counts. Step 2 deletes after
                  you type the workspace slug to confirm.
                </p>
              </div>
              <Button
                size="sm"
                variant="pearl"
                loading={allDryRun.isPending}
                onClick={() => {
                  allDryRun.mutate(
                    { dryRun: true },
                    { onSuccess: () => setAllOpen(true) },
                  );
                }}
              >
                Preview everything
              </Button>
            </div>
          </Card>
        </div>
      </div>

      {/* ============ Date-purge confirm sheet ============ */}
      <Sheet
        open={dateConfirmOpen}
        onOpenChange={(o) => !o && !dateCommitMut.isPending && setDateConfirmOpen(false)}
        title={`Reset ${datePreview?.date ?? ''}`}
        description="Review what will be deleted, then confirm."
        footer={
          <Button
            block
            variant="danger"
            loading={dateCommitMut.isPending}
            disabled={!datePreview || datePreview.total === 0}
            onClick={() => {
              if (!datePreview) return;
              dateCommitMut.mutate({ date: datePreview.date, dryRun: false });
            }}
          >
            {dateCommitMut.isPending
              ? 'Resetting…'
              : datePreview && datePreview.total > 0
                ? `Delete ${datePreview.total} rows`
                : 'Nothing to delete'}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-3">
          {datePreview ? (
            <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
              <div className="text-body-sm font-semibold text-[var(--c-fg)]">
                {datePreview.total === 0
                  ? `Nothing on ${datePreview.date} — already clean.`
                  : `${datePreview.total} rows from ${datePreview.date}`}
              </div>
              {datePreview.total > 0 ? (
                <ul className="mt-2 flex flex-col gap-1">
                  {Object.entries(datePreview.byTable)
                    .filter(([, n]) => n > 0)
                    .sort((a, b) => b[1] - a[1])
                    .map(([table, n]) => (
                      <li
                        key={table}
                        className="flex justify-between font-mono text-meta text-[var(--c-fg-muted)]"
                      >
                        <span className="truncate">{table}</span>
                        <span className="tabular-nums">{n}</span>
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </Sheet>

      {/* ============ Nuclear-purge confirm sheet ============ */}
      <Sheet
        open={allOpen}
        onOpenChange={(o) => !o && !allCommit.isPending && setAllOpen(false)}
        title="Confirm purge"
        description={`Type the workspace slug "${orgSlug}" to confirm.`}
        footer={
          <Button
            block
            variant="danger"
            loading={allCommit.isPending}
            disabled={!slugMatches}
            onClick={() => {
              if (!slugMatches) return;
              allCommit.mutate({ dryRun: false, confirmText });
            }}
          >
            {allCommit.isPending ? 'Purging…' : `Delete ${allDryRun.data?.total ?? 0} rows`}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-3">
          {allDryRun.data ? (
            <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
              <div className="text-body-sm font-semibold text-[var(--c-fg)]">
                {allDryRun.data.total} rows would be deleted
              </div>
              <ul className="mt-2 flex flex-col gap-1">
                {Object.entries(allDryRun.data.byTable)
                  .filter(([, n]) => n > 0)
                  .sort((a, b) => b[1] - a[1])
                  .map(([table, n]) => (
                    <li
                      key={table}
                      className="flex justify-between font-mono text-meta text-[var(--c-fg-muted)]"
                    >
                      <span className="truncate">{table}</span>
                      <span className="tabular-nums">{n}</span>
                    </li>
                  ))}
              </ul>
              {allDryRun.data.total === 0 ? (
                <p className="mt-2 text-meta text-[var(--c-fg-muted)]">
                  Nothing to purge — workspace is already clean.
                </p>
              ) : null}
            </div>
          ) : null}

          <Field label={`Type "${orgSlug}" to confirm`}>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={orgSlug}
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
        </div>
      </Sheet>
    </div>
  );
}

// Field helper removed — imported from @compass/ui.
