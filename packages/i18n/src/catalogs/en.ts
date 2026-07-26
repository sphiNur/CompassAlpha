/**
 * English catalog — source of truth.
 *
 * The `CatalogKey` type is `keyof typeof en`, so every key here
 * MUST be mirrored (with translated value) in zh.ts / ru.ts / uz.ts.
 * Missing keys in another locale fall back through ru → en at runtime,
 * which is acceptable for the rare key but unacceptable for the bulk.
 *
 * Status (2026-05-06, M1.5 audit): all 4 locales fully matched at the
 * key level. The earlier 2026-05-05 entry that called out uz/ru being
 * ~55% complete has been resolved — they're at parity now. Confirm +
 * Run UI no longer leak English. New keys land here first; the audit
 * tooling diffs catalogs to keep parity.
 *
 * Section order matters for git-diff readability:
 *   1. nav         — bottom-tab labels
 *   2. common      — generic verbs & UI tokens
 *   3. settings    — language picker
 *   4. auth        — sign-in, onboarding, access denial
 *   5. auth.errors — backend tRPC error codes for auth.* router
 *   6. admin.errors — backend codes for admin.* router
 *   7. upload.errors
 *   8. order.*     — OrderPage UI + ApprovalPage UI + their toasts
 *   9. order.errors — domain command failures
 *  10. run.*       — RunPage UI + sheets + toasts
 *  11. run.errors  — run-domain failures
 *  12. confirm.*   — ConfirmPage UI + toasts
 *  13. app.theme
 */
export const en = {
  // ── 1. Navigation ──────────────────────────────────────────────
  'nav.order': 'Order',
  'nav.approve': 'Approve',
  'nav.run': 'Run',
  'nav.deliver': 'Deliver',
  'nav.confirm': 'Confirm',
  'nav.admin': 'Admin',
  'nav.reports': 'Reports',
  'nav.debug': 'Debug',

  // ── 2. Common ──────────────────────────────────────────────────
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  // M2.0b: shared bits used by the dishes editor (and reusable
  // anywhere a CRUD section needs them).
  'common.archive': 'Archive',
  'common.archived': 'archived',
  'common.unarchive': 'Unarchive',
  'common.name': 'Name',
  'common.remove': 'Remove',
  'common.save': 'Save',
  'common.submit': 'Submit',
  'common.back': 'Back',
  'common.close': 'Close',
  'common.retry': 'Retry',
  'common.loading': 'Loading…',
  'common.noData': 'No data',
  'common.clear': 'Clear',
  'common.notes': 'Notes',
  'common.optional': 'Optional',
  /** Format `${count} ${i18n.t('common.itemsLabel')}` — bare noun. */
  'common.itemsLabel': 'items',
  /** Pre-composed phrase — `i18n.t('common.itemsCount', { n: 3 })`. */
  'common.itemsCount': '{n} items',
  /** "+N more" pagination footer in flat lists. */
  'common.more': 'more',
  'common.empty': 'Empty',
  // M3.34 (2026-05-19): canonical unit strings. SKU.unit stores one of
  // these; UI looks up via `useUnitLabel(unit)`.
  'unit.kg': 'kg',
  'unit.g': 'g',
  'unit.l': 'L',
  'unit.ml': 'mL',
  'unit.pcs': 'pcs',
  'unit.pack': 'pack',
  'unit.pair': 'pair',
  'unit.bunch': 'bunch',
  'unit.roll': 'roll',
  'common.noResults': 'No results',
  'common.required': 'Required',
  'common.error': 'Something went wrong',
  'common.networkError': 'Network error — check your connection',
  // M1.20 (2026-05-08): generic rate-limit error returned by the
  // server-side mutation rate limiter when a (user, path) exceeds the
  // 120-per-minute budget. The auth-specific equivalent stays under
  // 'auth.errors.rateLimited' — same wording, different namespace.
  'common.errors.rateLimited': 'Too many requests — please wait a moment and try again',
  'common.errors.validation': 'Invalid input — check the highlighted fields',

  // ── 3. Settings ────────────────────────────────────────────────
  'settings.language.title': 'Language',
  // M3.45 (2026-05-22): secondary display language
  'settings.secondaryLanguage.title': 'Vendor display language',
  'settings.secondaryLanguage.hint':
    "When set, product names show both languages and the per-vendor copy uses the vendor's language only — useful when you read Chinese but the bazaar vendors only know Uzbek.",
  'settings.secondaryLanguage.off': 'Off',
  'settings.secondaryLanguage.offHint': 'Single-language display (default)',
  'settings.language.subtitle': 'Pick the language for menus, products, and messages.',
  'settings.language.aria': 'Change language',
  // Settings hub (M1.6).
  'settings.title': 'Settings',
  'settings.profile.title': 'Profile',
  'settings.profile.displayName': 'Display name',
  'settings.profile.lockedHint': "Once set, only an admin can change your name. Ask them if you need to update it.",
  'settings.profile.username': 'Telegram',
  'settings.about.title': 'About',
  'settings.about.workspace': 'Workspace',
  'settings.about.role': 'Role',
  'settings.about.build': 'Build',
  'common.saved': 'Saved',

  // Store-context picker (header pill)
  'storeSwitcher.title': 'Store context',
  'storeSwitcher.subtitle': 'Pick which store you are working in right now.',
  'storeSwitcher.pickStore': 'Pick a store',
  'storeSwitcher.allMyStores': 'All my stores',
  'storeSwitcher.allOrgStores': 'All stores',
  'storeSwitcher.allMyHint': 'See aggregated activity across every store you manage.',
  'storeSwitcher.allOrgHint': 'See aggregated activity across the entire organization.',
  'storeSwitcher.aria': 'Change store context',
  'storeSwitcher.pickPrompt.title': 'Pick a store first',
  'storeSwitcher.pickPrompt.body':
    'This page needs a single store. Open Settings (gear icon) and pick one.',

  // ── 4. Auth (login / onboarding / access) ──────────────────────
  'auth.signIn': 'Sign in',
  'auth.signOut': 'Sign out',
  'auth.shareThisId': 'Share this Telegram ID with your administrator to be granted access:',
  'auth.noAccess.title': 'Access not granted',
  'auth.noAccess.body':
    'Your Telegram account is recognized but has no role in this organization yet. An administrator must grant you access.',
  'auth.onboarding.title': 'Welcome to Compass',
  'auth.onboarding.body':
    'Confirm the name your colleagues will see on order cards, approval queue, and audit log. Only an administrator can change it later.',
  'auth.onboarding.nameLabel': 'Your name',
  'auth.onboarding.namePlaceholder': 'e.g. Alex',
  'auth.onboarding.continue': 'Continue',
  'auth.onboarding.failed': 'Could not save name',
  'auth.noStore.title': 'No store assigned yet',
  'auth.noStore.body':
    'Your account is set up but an administrator still needs to assign you to a store. Contact your manager.',

  // ── 5. Auth errors (server-thrown TRPCError messages) ──────────
  'auth.errors.botTokenMissing': 'Bot token not configured',
  'auth.errors.invalidInitData': 'Telegram session is invalid — please re-open the app',
  'auth.errors.invalidRefresh': 'Session expired — please sign in again',
  'auth.errors.refreshReplayDetected':
    'Suspicious sign-in activity detected — all sessions for this account have been signed out. Please sign in again.',
  'auth.errors.missingPermission':
    'You don\'t have permission to do that. Ask an admin if you think this is a mistake.',
  'auth.errors.nameLocked': 'Your name is locked — only an administrator can change it',
  'auth.errors.noMembership': 'You are not a member of any organization',
  'auth.errors.noOrg': 'Organization not found',
  'auth.errors.required': 'Sign-in required',
  'auth.errors.signInFailed': 'Sign in failed',
  'auth.errors.noInitData':
    'No Telegram initData available — open via Telegram, or set VITE_DEV_MOCK_INIT_DATA.',

  // ── Admin (M1.6, 2026-05-06) ───────────────────────────────────
  // High-traffic admin labels. The deeper admin internals (audit
  // detail, role-permission matrix) intentionally stay in English
  // for now — those are power-user surfaces and the translation
  // cost is high vs payoff. Surface this set of keys covers what
  // every admin sees on first open.
  'admin.section.organization': 'Organization',
  'admin.section.stores': 'Stores',
  'admin.section.permissions': 'Roles & Permissions',
  'admin.section.catalog': 'Catalog',
  'admin.section.operations': 'Operations',
  'admin.section.organizationHint': 'Org info, locale, timezone',
  'admin.section.storesHint': 'Open a store to manage its team and settings',
  'admin.section.permissionsHint': 'Built-in roles, ranks, permission matrix',
  'admin.section.catalogHint': 'Categories, SKUs, suppliers',
  'admin.section.operationsHint': 'Activity, submission history, maintenance',
  'admin.subsection.categories': 'Categories',
  'admin.subsection.skus': 'SKUs',
  'admin.subsection.suppliers': 'Suppliers',
  'admin.subsection.team': 'Team',
  'admin.subsection.settings': 'Settings',
  'admin.subsection.activity': 'Live activity',
  'admin.subsection.history': 'Submission history',
  'admin.subsection.audit': 'Admin audit',
  'admin.subsection.priceReport': 'Price report',
  // M1.15: finance reconciliation reports — cash vs transfer breakdown
  // for a date range, with three view modes (daily / by supplier /
  // by store). Lives under Admin → Operations, gated by users.manage.
  'admin.subsection.finance': 'Finance',
  'admin.subsection.financeHint': 'Cash vs transfer reconciliation · daily, supplier, store',
  'admin.subsection.maintenance': 'Maintenance',
  'admin.subsection.activityHint': 'KPIs + recent audit events',
  'admin.subsection.historyHint': 'Past 30 days of orders + outcomes',
  'admin.subsection.auditHint': 'Catalog edits, role changes, permission overrides',
  'admin.subsection.priceReportHint': 'Daily prices · 7d / 30d averages per SKU',
  'admin.subsection.maintenanceHint': 'Purge test data (super_admin)',
  'admin.subsection.categoriesHint': 'Grouping for SKUs',
  'admin.subsection.skusHint': 'The catalog of items',
  'admin.subsection.suppliersHint': 'Who you buy from',
  'admin.action.newStoreBtn': '+ New store',
  'admin.action.newCategory': '+ New category',
  'admin.action.newSupplier': '+ New supplier',
  'admin.action.edit': 'Edit',
  'admin.action.save': 'Save',
  'admin.action.archive': 'Archive',
  'admin.action.delete': 'Delete',
  'admin.action.cloneRoles': 'Clone roles…',
  'admin.action.transfer': 'Transfer…',
  'admin.action.removeFromStore': 'Remove from store',
  'admin.action.removeFromOrg': 'Remove',
  'admin.action.suspend': 'Suspend',
  'admin.action.reactivate': 'Reactivate',
  'admin.action.grantRole': 'Grant role',
  'admin.action.permissions': 'Permissions',
  'admin.action.manage': 'Manage',
  // M1.11: per-member overflow ⋯ button label. Houses Permissions /
  // Suspend / Reactivate / Remove-store / Remove-org so the inline
  // strip stops wrapping on narrow phones.
  'admin.action.moreActions': 'More actions',
  // M1.9-extra (2026-05-07): P2 of the design audit — finishing the
  // i18n sweep on AdminPage that the M1.6 pass left at "section
  // names". This block adds the People-section action confirms,
  // ManualInviteSheet field labels + hints, and the "Admin only"
  // empty-state. Tier-3 admin-only screens (RoleCreate / Permissions
  // grid / Maintenance) stay English for now — they're gated behind
  // global-admin in the FE post-M1.9 so non-English users don't see
  // them.
  'admin.empty.adminOnly.title': 'Admin only',
  'admin.empty.adminOnly.description':
    'You need the users.manage permission to view this page.',
  'admin.confirm.suspend': 'Suspend {name}?',
  'admin.confirm.removeFromStore':
    'Remove {name} from 🏪 {store}?\n\nThis revokes any role bindings + per-store permission overrides scoped to this store. Their other store assignments stay.',
  'admin.confirm.removeFromOrg':
    'Remove {name} from this org? This cannot be undone.',
  'admin.label.thisStore': 'this store',
  'admin.label.loadingRoles': 'Loading roles…',
  'admin.label.loadingStores': 'Loading stores…',
  'admin.field.tgUserId': 'Telegram user ID *',
  'admin.field.tgUserIdPlaceholder': 'e.g. 6402913074',
  'admin.field.displayName': 'Display name',
  'admin.field.displayNamePlaceholder':
    'optional · the user can confirm/change at first sign-in',
  'admin.field.role': 'Role',
  'admin.field.storesSelected': 'Stores ({n} selected)',
  'admin.field.storesPickAtLeastOne': 'Stores * (pick at least one)',
  'admin.invite.byTgId.title': 'Add by Telegram ID',
  'admin.invite.byTgId.description':
    "Auto-creates a placeholder user; their profile fills in when they /start the bot.",
  'admin.invite.byTgId.submit': 'Add to workspace',
  'admin.invite.tgIdHint': "Ask the user to send /id to the bot if they don't know their ID.",
  'admin.invite.noRoleYet': '— no role yet (grant later) —',
  'admin.invite.staffNeedStoreHint':
    'Staff need an assigned store before they can place orders.',
  'admin.invite.onlyYourStoresHint': 'You can only invite into stores you administer.',
  'admin.invite.adminBypassHint':
    'Admins / super-admins can see all stores by default — no assignment needed.',
  'admin.banner.noStoresToInviteInto.title': 'No stores you can invite into',
  'admin.banner.noStoresToInviteInto.body':
    "You don't administer any store yet. Ask a higher-rank admin to add you to a store first.",
  'admin.label.active': 'active',
  'admin.label.showArchived': 'Show archived',
  // M1.10: cross-language search across catalog + people directories.
  'admin.search.skusPlaceholder': 'Search SKUs (any language or code)…',
  'admin.search.peoplePlaceholder': 'Search by name, Telegram, or role…',
  'admin.search.noMatches.title': 'No matches',
  'admin.search.noMatches.description': 'Try a different word, or clear the filter.',
  'admin.empty.noSkus.title': 'No SKUs',
  'admin.empty.noSkus.description': 'Add the items your stores order regularly.',
  'admin.label.paused': 'paused',
  'admin.label.you': 'you',
  'admin.label.noTelegram': 'no telegram',
  'admin.label.neverSeen': 'never seen',
  'admin.label.signedInAs': 'Signed in as @{name}',
  'admin.label.signedIn': 'Signed in',
  'admin.label.viewOnly': 'view-only',
  'admin.label.readOnly': 'read-only',
  'admin.label.orgLevel': 'Org-level',
  'admin.label.orgLevelHint': "Admins / super-admins not bound to any store",
  'admin.label.noStore': 'no store · org-level',
  'admin.label.noRoles': 'No roles',
  'admin.label.fromRole': 'from role',
  'admin.label.builtIn': 'built-in',
  'admin.label.defaultRole': 'Default role',
  'admin.label.memberCount': '{n, plural, =1 {1 member} other {{n} members}}',
  // Workspace card labels (M1.7, audit HIGH #7).
  'admin.workspace.name': 'Name',
  'admin.workspace.slug': 'Org slug',
  'admin.workspace.yourRole': 'Your role',
  'admin.workspace.telegram': 'Telegram',
  'admin.workspace.futureNote': 'Org settings (timezone, workflow flags) land in M2.',
  'auth.errors.sessionStale': 'Your session is out of date — please reload',
  'auth.errors.storeArchived': 'This store is no longer active',
  'auth.errors.storeForbidden': 'You are not assigned to this store',
  'auth.errors.userMissing': 'User not found',
  'auth.errors.cannotGrantEqualOrHigher':
    'You cannot grant a role at or above your own level',
  'auth.errors.cannotRevokeEqualOrHigher':
    'You cannot revoke a role at or above your own level',
  'auth.errors.rateLimited': 'Too many attempts — please wait a minute and try again',
  'system.errors.logRateLimited': 'Too many client log events — slow down',

  // ── 6. Admin errors ────────────────────────────────────────────
  'admin.errors.bindingNotFound': 'Role binding not found',
  'admin.errors.cannotLeaveZeroStores':
    'A member must remain assigned to at least one store',
  'admin.errors.cannotRemoveLastAdmin': 'Cannot remove the last admin from the organization',
  'admin.errors.cannotRemoveSelf': 'You cannot remove yourself',
  'admin.errors.cannotRevokeSelfAdmin': 'You cannot revoke your own admin role',
  'admin.errors.cannotSuspendSelf': 'You cannot suspend yourself',
  'admin.errors.categoryNotFound': 'Category not found',
  'admin.errors.inviteNeedsStore':
    'A non-admin invite must include at least one store assignment',
  'admin.errors.memberCreateFailed': 'Could not create the member record',
  'admin.errors.memberNotFound': 'Member not found',
  'admin.errors.orgNotFound': 'Organization not found',
  'admin.errors.purgeConfirmMismatch': 'Confirmation text did not match — purge cancelled',
  'admin.errors.purgeRequiresSuperAdmin': 'Only a super-admin can purge data',
  'admin.errors.roleNotFound': 'Role not found',
  'admin.errors.runHasForeignSessions':
    'This run contains sessions from other stores — cannot operate on it',
  'admin.errors.runNotFound': 'Market run not found',
  'admin.errors.scopeStoreIdRequired':
    'A store-scoped role must specify which store it applies to',
  'admin.errors.sessionAttachedToRun':
    'This session is locked into a market run and cannot be edited',
  'admin.errors.sessionNotFound': 'Order session not found',
  'admin.errors.skuNotFound': 'Product not found',
  'admin.errors.storeNotFound': 'Store not found',
  'admin.errors.supplierNotFound': 'Supplier not found',
  'admin.errors.userCreateFailed': 'Could not create the user record',
  'admin.errors.cannotDeleteBuiltinRole':
    'Built-in roles cannot be deleted — they anchor the role ladder',
  'admin.errors.roleHasBindings':
    'This role is still assigned to members — revoke those grants first',
  'admin.errors.permissionNotFound': 'Permission key not in the dictionary',
  'admin.errors.notAdminOfStore':
    "You don't administer this store — only its admin can perform this action",
  'admin.errors.cannotInviteOrgAdminAsStoreAdmin':
    'Only org-level admins can invite or grant org-level admin roles',
  'admin.errors.transferSameStore':
    'Source and destination must be different stores',
  'admin.errors.defaultRoleMustBeStoreTier':
    "Default role must be a store-tier role (rank below admin) — admin/super_admin can't be a per-store default",

  // Admin operator-console toasts (added 2026-05-06).
  // Each verb is a separate key because Russian has gendered endings
  // ("магазин создан" vs "категория создана") that don't compose.
  'admin.action.invite': '+ Invite',
  'admin.action.newRole': '+ New role',
  'admin.action.newSku': '+ New SKU',
  'admin.empty.members.title': 'No members yet',
  'admin.empty.members.description': 'Tap "+ Invite" above to add the first one.',
  'admin.empty.noStoresInThisStore.title': 'No members in this store',
  'admin.empty.noStoresInThisStore.description':
    'Switch the store context in the header to see other stores, or use Invite to add someone.',
  'admin.toast.memberUpdated': 'Member updated',
  'admin.toast.memberRemoved': 'Member removed',
  'admin.toast.memberAdded': 'Member added',
  'admin.toast.userExists': 'User already in this workspace',
  'admin.toast.roleRevoked': 'Role revoked',
  'admin.toast.roleCreated': 'Role created',
  'admin.toast.roleUpdated': 'Role updated',
  'admin.toast.roleDeleted': 'Role deleted',
  'admin.toast.linkCopied': 'Invite link copied',
  'admin.toast.clipboardUnavailable': 'Clipboard unavailable',
  'admin.toast.couldNotCopy': 'Could not copy',
  'admin.toast.storeCreated': 'Store created',
  'admin.toast.storeUpdated': 'Store updated',
  'admin.toast.storeArchived': 'Store archived',
  'admin.toast.categoryCreated': 'Category created',
  'admin.toast.categoryUpdated': 'Category updated',
  'admin.toast.categoryArchived': 'Category archived',
  'admin.toast.skuCreated': 'SKU created',
  'admin.toast.skuUpdated': 'SKU updated',
  'admin.toast.skuArchived': 'SKU archived',
  'admin.toast.supplierCreated': 'Supplier created',
  'admin.toast.supplierUpdated': 'Supplier updated',
  'admin.toast.supplierArchived': 'Supplier archived',
  'admin.toast.sessionDeleted': 'Deleted session — {n} rows removed',
  'admin.toast.runDeleted': 'Deleted run — {n} rows removed',
  'admin.toast.dateReset': 'Reset {date}: {n} rows deleted',
  'admin.toast.dataPurged': 'Purged {n} rows across {tables} tables',

  // ── 7. Upload errors ───────────────────────────────────────────
  'upload.errors.notConfigured': 'File uploads are not configured on this server',
  'upload.errors.unsupportedContentType': 'This file type is not allowed',

  // ── 8. Order page (UI + actions + toasts) ──────────────────────
  'order.title': "Today's order",
  'order.empty.title': 'No items selected yet',
  'order.empty.description': 'Tap + on any product to start your draft.',
  // M1.9-fix (2026-05-07): SKU row meta + chip-bar labels were
  // hardcoded English. These appear on every product row of the main
  // staff page.
  'order.categoriesAriaLabel': 'Product categories',
  'order.categories.all': 'All',
  // M1.10 (2026-05-08): cross-language search.
  'order.search.placeholder': 'Search products (any language)…',
  'order.search.noMatches.title': 'No products match',
  'order.search.noMatches.description': 'Try a different word, or clear the filter.',
  'order.suggested': 'suggested {qty}',
  'order.totalQty': 'total {qty} {unit}',
  'order.selected': 'Selected',
  'order.review': 'Review order ({n})',
  'order.status.draft': 'Draft',
  'order.status.submitted': 'Submitted · awaiting review',
  'order.status.approved': 'Approved',
  'order.status.rejected': 'Rejected — {reason}',
  // Just the title-cased status, no body. Pair with `order.status.rejected`
  // (which contains the reason) when both title and body are needed
  // (e.g. ApprovalPage's reject banner).
  'order.status.rejectedTitle': 'Rejected',
  'order.status.rejectedNoReason': 'No reason given.',
  'order.status.in_run': 'In market run',
  'order.status.archived': 'Archived',
  'order.banner.claimed': 'Under review by {who}',
  'order.banner.claimedAfterHandoff': 'Under review by {who} (took over from {prev})',
  'order.banner.editLocked': 'Editing locked while submitted',
  'order.banner.approved.title': 'Approved · awaiting market run',
  'order.banner.approved.body':
    'Your manager approved this order. The purchaser will pull it into the next market run.',
  'order.banner.inRun.title': 'In progress · purchaser is buying',
  'order.banner.inRun.body':
    "This order is part of an active market run. You'll get a notification when delivery arrives.",
  'order.editedBy': 'edited by {who} · {when}',
  'order.withdraw': 'Withdraw',
  'order.actions.addNote': 'Add note',
  'order.toast.submitted': 'Order submitted ✓',
  'order.toast.submitFailedNetwork':
    'Network hiccup — order NOT submitted. Tap Submit again.',
  'order.toast.submitFailed': 'Could not submit the order',
  'order.toast.adjustFailed': "Couldn't save change — please try again",
  'order.toast.syncing': 'Syncing — try Submit again in a moment',
  'order.action.submitOrder': 'Submit order',
  'order.action.submitting': 'Submitting…',
  'order.review.title': 'Review your order',
  'order.review.itemsCount': '{n, plural, one {1 item} other {{n} items}}',
  'order.review.empty': 'Nothing selected yet.',
  'order.review.reviewSheet.title': 'Review your order',
  'order.review.estimatedTotal': 'Estimated total',
  'order.review.estimateHint':
    '~7-day avg price · {known} priced · {unknown} unknown',

  // ── Session-level "其他物品" / miscellaneous note (M1.8) ──────────
  'order.notes.label': 'Other items',
  'order.notes.placeholder':
    'Anything else you need that\'s not in the catalog above? e.g. fresh bread, a specific brand of olive oil…',
  'order.notes.hint': 'Visible to your manager and the purchaser.',
  'order.notes.saving': 'Saving…',
  'order.notes.saved': 'Saved ✓',
  'order.notes.badge': 'Note',
  'order.notes.hasNote': 'Has additional request',
  'order.toast.noteSaveFailed': 'Could not save the note — try again.',

  // ── M3.16-C: structured "Other items" (extras) editor ───────────
  'order.extras.label': 'Other items',
  // M3.37 (2026-05-19, Wave2 #5): per-row outcome the purchaser sets
  // by tapping an extras row during the purchasing phase. Default
  // 'pending' for any row without an explicit mark.
  'run.extras.status.pending': 'Not yet bought',
  'run.extras.status.bought': 'Bought',
  'run.extras.status.unavailable': 'Not available',
  'run.extras.status.cycleHint': 'Tap to mark · current: {current}',
  'run.extras.recordPrice': 'Price',
  'run.extras.recordExpenseReason': 'Other item from staff order',
  'order.extras.add': '+ Add item',
  'order.extras.namePlaceholder': 'Item name',
  'order.extras.remove': 'Remove',
  'order.toast.extrasSaveFailed': 'Could not save the extra items — try again.',

  // ── ApprovalPage (the manager-side) ─────────────────────────────
  'approval.title': 'Approval queue',
  'approval.empty.title': 'Inbox is empty',
  'approval.empty.body': 'New orders awaiting review will appear here.',
  'approval.empty.tab': 'No {tab} orders',
  'approval.tab.pending': 'Pending',
  'approval.tab.approved': 'Approved',
  'approval.tab.rejected': 'Rejected',
  'approval.viewItems': 'View items',
  'approval.tabsAriaLabel': 'Approval status filter',
  'approval.submittedBy': 'submitted by {name}',
  'approval.contributorsCount': '{n, plural, =1 {1 contributor} other {{n} contributors}}',
  'approval.hideItems': 'Hide items',
  'approval.approve': 'Approve',
  'approval.reject': 'Reject',
  'approval.claim': 'Claim',
  'approval.release': 'Release',
  'approval.takeOver': 'Take over',
  'approval.confirmTakeover': "{who} hasn't acted on this order. Take over the review?",
  'approval.unknownReviewer': 'another reviewer',
  'approval.unapprove': 'Reverse approval',
  'approval.toast.approved': 'Approved ✓',
  'approval.toast.rejected': 'Rejected',
  'approval.toast.claimed': 'Claimed for review',
  'approval.toast.released': 'Released',
  'approval.toast.unapproved': 'Approval reversed',
  'approval.toast.approveFailed': 'Could not approve',
  'approval.toast.rejectFailed': 'Could not reject',
  'approval.items.loading': 'Loading items…',
  'approval.items.failed': 'Failed to load items.',
  'approval.confirm.reject.title': 'Reject this order?',
  'approval.confirm.reject.body':
    'The submitter will see your reason. They can revise and resubmit.',
  'approval.confirm.reject.reasonPlaceholder': 'e.g. duplicate order',
  'approval.confirm.unapprove.title': 'Reverse approval?',
  'approval.confirm.unapprove.body':
    'Returns this order to the queue. Only allowed before it is added to a market run.',
  'approval.filter.allMyStores': 'All my stores',

  // ── 9. Order errors ────────────────────────────────────────────
  'order.errors.alreadyStarted': 'A session for this date already exists',
  'order.errors.invalidDate': 'Invalid date',
  'order.errors.skuArchived': 'This product is no longer available',
  'order.errors.skuMissing': 'Product not found',
  'order.errors.invalidQty': 'Invalid quantity',
  'order.errors.qtyNegative': 'Quantity cannot be negative',
  'order.errors.qtyNotMultipleOfStep': 'Quantity must be a multiple of {step}',
  'order.errors.invalidStep': 'Invalid step value',
  'order.errors.noteTooLong': 'Note is too long (max 500 characters)',
  'order.errors.sessionNoteTooLong': 'Note is too long (max 1000 characters)',
  'order.errors.notOwner': 'You can only edit your own draft',
  'order.errors.notSubmittable': 'This order cannot be submitted right now',
  'order.errors.cannotSubmit': "You don't have permission to submit",
  'order.errors.cannotDraft': "You don't have permission to draft orders",
  'order.errors.cannotArchive': "You don't have permission to archive",
  'order.errors.cannotEditOthersLine': "You can't edit another person's line",
  'order.errors.emptyOrder': 'Add at least one item before submitting',
  'order.errors.cannotClaim': "You don't have permission to claim",
  // M3.37 (2026-05-19, Wave2 #5): MarkExtraStatus guard rails.
  'order.errors.cannotMarkExtra': "Only purchasers can mark extras",
  'order.errors.extraStatusOnlyDuringRun': "Extras can only be marked once the run starts",
  'order.errors.extraIndexOutOfRange': 'Extra row not found',
  'order.errors.notClaimable': 'This order is not awaiting review',
  'order.errors.alreadyClaimed': 'Already claimed by another reviewer',
  'order.errors.notClaimer': 'Only the claimer or another approver can release this claim',
  'order.errors.cannotApprove': "You don't have permission to approve",
  'order.errors.notApprovable': 'This order is not awaiting review',
  'order.errors.claimedByOther': 'Another reviewer is currently working on this',
  'order.errors.notRejectable': 'This order cannot be rejected right now',
  'order.errors.rejectReasonRequired': 'Please provide a reason for rejection',
  'order.errors.notWithdrawable': 'This order cannot be withdrawn',
  'order.errors.cannotWithdraw': "You don't have permission to withdraw",
  'order.errors.cannotWithdrawWhileClaimed': 'Cannot withdraw while a manager is reviewing',
  'order.errors.cannotUnapprove': "You don't have permission to reverse approval",
  'order.errors.notUnapprovable': 'This order is not approved',
  'order.errors.alreadyInRun': 'Already attached to a market run',
  'order.errors.cannotAttach': 'This order cannot be attached to a run',
  'order.errors.cannotEject': 'This session cannot be ejected from the run',
  'order.errors.streamMissing': 'Order session has not started',
  'order.errors.sessionMissing': 'Order session not found',
  'order.errors.archived': 'Order session is archived',
  'order.errors.lockedByStatus': 'Order is locked in current status',
  'order.errors.ownerLocked': 'Cannot edit while {status}',
  'order.errors.notEditor': 'Only the owner or current reviewer can edit',
  'order.errors.targetLineNotFound': 'That line was already removed',
  'order.errors.staleSeq': 'Someone else just edited — please retry',

  // ── 10. Run page (UI + sheets + toasts) ────────────────────────
  'run.title': 'Market run',
  'run.empty.noActive': 'No active run',
  'run.empty.noPlannable': 'No approved sessions to plan',
  'run.empty.noPlannableBody':
    'Once a manager approves at least one session, you can plan a run.',
  'run.header.runIndex': 'Market run #{n}',
  'run.header.newRun': 'New run',
  'run.header.moreActions': 'More actions',
  'run.banner.readyToStart': 'Ready to start purchasing',
  'run.banner.readyToStartBody': 'Use the button at the bottom of the screen to advance.',
  'run.banner.planLockWarning':
    'Will lock {n} approved sessions into this run. They cannot be edited until the run finishes or is cancelled.',
  'run.banner.confirmingFinish':
    'About to finish. After this nothing in this run can be changed — including prices, deliveries, or store confirms.',
  'run.section.items': 'Items',
  'run.section.stores': 'Stores',
  'run.section.readyToPlan': 'Ready to plan',
  'run.label.sessionsCount': '{n, plural, =1 {1 session} other {{n} sessions}}',
  'run.label.pendingFraction': '{done}/{total} pending',
  'run.label.confirmedFraction': '{done}/{total} confirmed',
  'run.label.itemsHint': '{n, plural, =1 {1 item} other {{n} items}} · {subtitle}',
  'run.label.itemsCount': '{n, plural, =1 {1 item} other {{n} items}}',
  'run.label.skuCountAndQty': '{n, plural, =1 {1 SKU} other {{n} SKUs}} · {qty}',
  'run.label.splitsMismatch': 'Splits: {sum} / {target}',
  // M1.9-fix (2026-05-07): delivery store-row stage labels — were
  // hardcoded English on the purchaser's main during-run view.
  'run.deliveryStage.pending': 'Not delivered',
  'run.deliveryStage.delivered': 'Awaiting confirm',
  'run.deliveryStage.confirmed': 'Confirmed',
  'run.deliveryStageBadge.pending': 'pending',
  'run.deliveryStageBadge.delivered': 'delivered',
  'run.deliveryStageBadge.confirmed': 'confirmed',
  'run.purchase.priceInputPlaceholder': 'price',
  'run.view.perStore': 'Per store',
  'run.view.perVendor': 'Per vendor',
  // Plan-time preview views (M1.5).
  'run.previewView.byStore': 'By store',
  'run.previewView.bySupplier': 'By vendor',
  'run.previewSupplier.unassigned': 'Unassigned vendor',
  'run.previewSupplier.unassignedHint':
    'These items have no preferred vendor. Open the SKU and pick one to group them automatically.',
  'run.previewSupplier.copyAll': 'Copy all stalls',
  'run.previewSupplier.copied': 'Copied — paste into the vendor chat',
  // Localized template for the copy-to-vendor message. Placeholders:
  //   {vendorName}, {date}, {body}.  `body` is built FE-side as
  //   "Item · qty\n  - Store: qty\n..." per item.
  'run.previewSupplier.messageTemplate':
    'Hi {vendorName},\n\nFor {date} please prepare the following per store:\n\n{body}\n\nThanks!',
  'run.previewStore.copyList': 'Copy list',
  'run.previewStore.copied': 'Copied',
  'run.previewShare.sendList': 'Send',
  'run.previewShare.sendAll': 'Send all',
  'run.previewShare.opened': 'Contact picker opened',
  'run.previewShare.openedWithCopy': 'Contact picker opened; list also copied',
  'run.preview.groupTotal': 'Total',
  'run.preview.priceUnknown': 'Ask price',
  'run.preview.unknownPrices': '{n, plural, =1 {1 no reference price} other {{n} no reference prices}}',
  'run.preview.expand': 'Expand',
  'run.preview.collapse': 'Collapse',
  'run.view.perCategory': 'Per category',
  'run.view.uncategorized': 'Uncategorized',
  'run.preview.estimateTitle': 'Estimate',
  'run.preview.coverage': 'Priced {known}/{total} · at least {money}',
  'run.preview.noSupplierCount': 'No stall: {n}',
  'run.preview.filterMatch': '{n} of {total} shown',
  'run.purchase.pricingUniform': 'Uniform price / payment',
  'run.purchase.pricingPerStore': 'Per-store price / payment',
  // Manual supplier assignment from preview (M1.6 #1).
  'run.previewSupplier.changeVendor': 'Change vendor',
  'run.previewSupplier.pickVendorTitle': 'Pick a vendor',
  'run.previewSupplier.pickVendorHint':
    'Sets this item\'s preferred vendor. Sticks across runs until you change it again.',
  'run.previewSupplier.clearVendor': '— No preferred vendor —',
  'run.previewSupplier.assigned': 'Vendor assigned',
  'run.previewSupplier.cleared': 'Vendor cleared',
  'run.view.perStoreHint':
    "Read-only — switching views never duplicates buys, it's the same data shown two ways.",
  'run.step.plan': 'Plan',
  'run.step.purchase': 'Purchase',
  'run.step.deliver': 'Deliver',
  'run.step.done': 'Done',
  'run.action.startPurchase': 'Start purchase',
  'run.action.ejectSession': 'Return to review',
  'run.section.sessions': 'Submissions in this run',
  'run.sessions.meta': '{n} submission(s)',
  'run.sessions.stats': '{items} SKU(s) · {qty} units · {extras} other item(s)',
  'run.sessions.statsNoExtras': '{items} SKU(s) · {qty} units',
  'run.sessions.unknownSubmitter': 'Unknown submitter',
  'run.sessions.ejectHint':
    'Only submissions whose items are still untouched can be returned to review.',
  'run.eject.reasonPlaceholder': 'Reason (optional)',
  'run.confirm.ejectSession.title': 'Return {store} / {who} to review?',
  'run.confirm.ejectSession.body':
    'This removes their pending quantities from the current purchase run and returns the submission to approved review. If any included SKU was already bought or marked unavailable, undo that item first.',
  'run.toast.sessionEjected': 'Submission returned to review',
  'run.toast.couldNotEjectSession': 'Could not return the submission',
  'run.errors.cannotEjectSession': 'You do not have permission to return submissions from a run',
  'run.errors.cannotEjectInStatus':
    'Submissions can only be returned while the run is planned or purchasing',
  'run.errors.sessionNotInRun': 'That submission is not in this purchase run',
  'run.errors.cannotEjectLastSession': 'Cancel the run instead of returning the last submission',
  'run.errors.noItemsToEject': 'That submission has no SKU items to remove',
  'run.errors.ejectQtyExceedsPlan': 'The submission quantity is larger than the run plan',
  'run.action.attachSessions': 'Attach to run',
  'run.attach.banner.title':
    '{n, plural, =1 {1 new approved order ready to attach} other {{n} new approved orders ready to attach}}',
  'run.toast.sessionsAttached': 'Sessions attached',
  'run.toast.couldNotAttach': "Couldn't attach sessions",
  'run.errors.cannotAttachInStatus': 'Can only attach sessions while the run is planned or purchasing',
  'run.errors.sessionAlreadyInRun': 'That session is already attached to this run',
  'run.errors.allSessionsAlreadyInRun': 'Every selected session is already in this run',
  'run.errors.noSessionsToAttach': 'No sessions selected to attach',
  'run.action.startDelivery': 'Start delivery',
  'run.action.finish': 'Finish run',
  'run.action.cancelRun': 'Cancel run',
  'run.action.deliver': 'Deliver',
  'run.action.buy': 'Buy',
  'run.action.markNa': 'N/A',
  'run.action.editPurchase': 'Edit purchase',
  'run.action.undoPurchase': 'Undo',
  'run.action.unmarkUnavailable': 'Mark available again',
  'run.action.recallDelivery': 'Recall delivery',
  'run.action.undoStartPurchase': 'Back to plan',
  'run.action.undoStartDelivery': 'Back to purchase',
  'run.action.confirmDeliver': 'Confirm delivery',
  'run.action.planRun': 'Plan run',
  'run.action.savePurchase': 'Save purchase',
  'run.action.recordPurchase': 'Record purchase',
  'run.action.createNewRun': 'Create new run',
  'run.action.markUnavailable': 'Mark unavailable',
  'run.action.markUnavailableDesc': "Tell the team why this couldn't be bought.",
  'run.action.unavailableReasonPlaceholder': 'Reason',
  'run.action.actualQty': 'Actual qty ({unit})',
  'run.action.unitPriceUzs': 'Unit price (UZS)',
  // M3.41 (2026-05-21): purchaser-initiated mid-run additions.
  'run.action.addItem.button': '+ Add',
  'run.action.addItem.title': 'Add item mid-run',
  'run.action.addItem.subtitle': 'Record a buy for a SKU that was not in the original order',
  'run.action.addItem.searchPlaceholder': 'Search SKU…',
  'run.action.addItem.noMatch': 'No matching SKU. Items already in this run are hidden.',
  'run.action.addItem.changeSku': 'Change',
  'run.action.addItem.targetStore': 'For which store?',
  'run.action.addItem.crossStoreHint':
    'This item is already in the run for {stores}. Use independent cost for a different store price, or merge only when it is the same batch and unit price.',
  'run.action.addItem.defaultCrossStoreReason': 'Additional store demand',
  'run.action.addItem.pickStore': '— Pick a store —',
  'run.action.addItem.totalHint': 'Line total',
  'run.action.addItem.reasonLabel': 'Why was this added?',
  'run.action.addItem.reasonPlaceholder':
    'e.g. Chef call-in / Market deal / Vendor freebie',
  'run.action.addItem.save': 'Save addition',
  'run.label.addedByPurchaser': 'Added by purchaser mid-run',
  'run.confirm.finish.addedByPurchaser':
    '➕ {n} item(s) added beyond original order · {total} UZS',
  'run.toast.itemAdded': 'Item added to the run',
  'run.toast.couldNotAddItem': 'Could not add the item',
  'run.errors.alreadyInRun':
    'This SKU is already in the run — use Edit on the existing row',
  'run.errors.storeNotInRun': 'That store is not part of this run',
  'run.errors.addReasonRequired': 'Reason is required for purchaser additions',
  // M3.44 (2026-05-22): off-catalog expenses (porter / taxi / one-off items)
  'run.action.addItem.modeSku': 'SKU item',
  'run.action.addItem.modeExpense': 'Off-catalog',
  'run.action.addExpense.title': 'Add off-catalog item or expense',
  'run.action.addExpense.subtitle':
    'Porter fee · taxi · vendor freebie · one-off purchase that has no SKU',
  'run.action.addExpense.labelInput': 'What is it?',
  'run.action.addExpense.labelPlaceholder': 'e.g. Porter / Napkins / Taxi back',
  'run.action.addExpense.unitHint': 'Unit (optional)',
  'run.action.addExpense.unitHintPlaceholder': 'e.g. trip / pack / —',
  'run.action.addExpense.targetStores': 'Which store(s) pay?',
  'run.action.addExpense.splitHint': '{n} selected · auto-split evenly',
  'run.action.addExpense.resplitEvenly': 'Re-split evenly',
  'run.action.addExpense.receiptOptional': 'Receipt (optional)',
  'run.action.addExpense.receiptRequired':
    'Receipt REQUIRED (amount above {threshold} UZS)',
  'run.action.addExpense.needReceipt': 'Receipt photo required',
  'run.action.addExpense.save': 'Save expense',
  'run.action.removeExpense': 'Remove expense',
  'run.section.expenses': 'Off-catalog & expenses',
  'run.toast.expenseAdded': 'Expense recorded',
  'run.toast.expenseRemoved': 'Expense removed',
  'run.toast.couldNotAddExpense': 'Could not save the expense',
  'run.confirm.finish.expenses':
    '🧾 {n} off-catalog item(s) / expense(s) · {total} UZS',
  'run.confirm.finish.perStoreHeading': 'Per-store settlement:',
  'run.errors.expenseLabelRequired': 'A description is required',
  'run.errors.expenseLabelTooLong': 'Description too long (200 max)',
  'run.errors.expenseReasonRequired': 'Reason is required',
  'run.errors.expenseReceiptRequired':
    'Receipt photo required for amounts above {threshold} UZS',
  // C.2 (M3.38, 2026-05-19): run-level claim banner copy. Mirrors the
  // order-side equivalents at order.banner.claimed / .claimedAfterHandoff.
  'run.banner.claimed': 'This run is being handled by {who}',
  'run.banner.claimedAfterHandoff': '{prev} → {who} is now handling this run',
  'run.action.takeOver': 'Take over',
  'run.errors.claimedByOther': 'This run is claimed by another purchaser',
  'run.errors.notClaimable': 'This run cannot be claimed in its current status',
  // M3.36 (2026-05-19): "thousands mode" lets purchasers type 147.5
  // instead of 147500 — UZS prices live in the 20-150k range so
  // typing the trailing 000s on every line is busywork. Page-level
  // toggle persists in localStorage; default ON for the UZS launch
  // tenant. Math + persisted values stay in raw UZS — only the
  // input/display is divided.
  'run.action.unitPriceUzsThousands': 'Unit price (×1000 UZS)',
  'run.label.thousandsToggle': '×1000',
  'run.label.thousandsToggleAria': 'Type prices in thousands (×1000)',
  'run.action.supplier': 'Supplier',
  'run.action.receiptPhoto': 'Receipt photo (optional)',
  'run.action.allocateAcrossStores': 'Allocate across stores',
  'run.action.aggregateInfo': 'Will aggregate {n} approved sessions.',
  'run.action.actualQtyAriaLabel': 'actual qty',
  'run.action.unitPriceAriaLabel': 'unit price',
  'run.action.savePurchaseAriaLabel': 'save purchase',
  'run.main.awaitingItems': 'Process every item first',
  'run.main.awaitingConfirms': 'Awaiting store confirmations',
  'run.confirm.startPurchase.title': 'Start purchasing?',
  'run.confirm.startPurchase.body':
    'Marks this run as in-progress. You can still come back to plan if you have not recorded anything.',
  'run.confirm.startDelivery.title': 'Start delivery?',
  'run.confirm.startDelivery.body':
    'Marks all items as ready to ship. You can still come back to purchase if no store has been delivered yet.',
  'run.confirm.deliver.title': 'Mark {store} delivered?',
  'run.confirm.deliver.body':
    'You can recall this delivery until the store confirms receipt. After they confirm, this is final.',
  'run.confirm.finish.title': 'Finish this run?',
  'run.confirm.finish.body':
    'After finishing, prices, quantities, and delivery records are locked. This cannot be undone.',
  'run.confirm.finish.summary': '{items} items · {stores} stores · total {total} UZS',
  // M1.14: payment-method labels + the optional cash/transfer breakdown
  // line that appears in the finish-run confirm body when the run
  // mixed both methods.
  'run.label.paymentMethod': 'Payment method',
  'run.label.paymentCash': 'Cash',
  'run.label.paymentTransfer': 'Transfer',
  'run.confirm.finish.paymentBreakdown': '💵 cash {cash} · 🏦 transfer {transfer}',
  'run.confirm.cancel.title': 'Cancel the entire run?',
  'run.confirm.cancel.body':
    'This stops the run and unlocks all sessions back to "approved". Already-recorded purchases stay in the audit log but are not delivered.',
  'run.confirm.recall.title': 'Recall delivery to {store}?',
  'run.confirm.recall.body':
    'Tells the store that this delivery was a mistake. Only allowed before they confirm receipt.',
  'run.confirm.editPurchase.title': 'Edit purchase',
  'run.confirm.editPurchase.body':
    'Update the recorded quantity, price, supplier, photo, or store split. The original record stays in the audit log.',
  'run.confirm.undoPurchase.title': 'Undo this purchase?',
  'run.confirm.undoPurchase.body':
    'Reverts this SKU back to pending so it can be re-recorded. The original purchase record stays in the audit log. Allowed only if no store has received delivery yet.',
  'run.confirm.unmarkUnavailable.title': 'Mark available again?',
  'run.confirm.unmarkUnavailable.body':
    'Puts this item back to pending so you can record a purchase. The original "unavailable" note stays in the audit log.',
  'run.confirm.undoStartPurchase.title': 'Go back to plan?',
  'run.confirm.undoStartPurchase.body':
    'Switches this run back to the planning step. Purchases you have already recorded are kept — they stay marked ✓ when you start purchasing again.',
  'run.confirm.undoStartDelivery.title': 'Go back to purchasing?',
  'run.confirm.undoStartDelivery.body':
    'Reverts this run to the purchasing step. Only works before any store has been delivered to.',
  'run.label.reasonForChange': 'Reason for change',
  'run.label.addReasonOptional': '+ Add note (optional)',
  'run.label.total': 'total',
  'run.label.reasonPlaceholder': 'e.g. price misread on the receipt',
  'run.toast.runPlanned': 'Run planned',
  'run.toast.purchaseStarted': 'Purchasing started',
  'run.toast.deliveryStarted': 'Delivery started',
  'run.toast.couldNotPlan': 'Could not plan run',
  'run.toast.purchaseRecorded': 'Purchase recorded',
  'run.toast.purchaseSavedOffline': 'Saved offline — will sync when back online',
  'run.toast.syncFailed': "A saved change couldn't be synced — please re-check it",
  'run.toast.couldNotSavePurchase': 'Could not save purchase',
  'run.toast.markedUnavailable': 'Marked unavailable',
  'run.toast.purchaseRevised': 'Purchase updated',
  'run.toast.unmarkedUnavailable': 'Marked available again',
  'run.toast.purchaseUndone': 'Purchase undone — back to pending',
  'run.toast.deliveryRecalled': 'Delivery recalled',
  'run.toast.runCancelled': 'Run cancelled',
  // Wave2 #15 (M3.40, 2026-05-20): shown when run.cancel completes but
  // one or more sessions failed to eject cleanly. The repair worker
  // sweep picks them up within ~5 min so the operator doesn't need
  // to act — just informational.
  'run.toast.runCancelledWithOrphans':
    'Run cancelled — {n} session(s) will auto-release shortly',
  'run.toast.startPurchaseUndone': 'Back to plan',
  'run.toast.startDeliveryUndone': 'Back to purchase',
  'run.toast.runFinished': 'Run finished',
  'run.toast.markIncompleteFirst': 'Mark every item as purchased or unavailable first',
  'run.toast.storesNeedConfirm': 'Stores still need to confirm',
  'run.history.title': 'History',
  'run.history.subtitle': 'Past runs — tap to see details',
  'run.history.viewAllHint': 'Open Admin → Operations → Submission history for older runs',
  'run.history.totalLine': 'Total {total} UZS',
  'run.history.allStores': 'All stores',
  // M3.9: filter chip toolbar + cancelled-row label dropped — cancelled
  // runs no longer surface in RunPage history. Keys removed:
  //   run.history.cancelled, run.history.filter.{finished,all,cancelled}.
  // Soft-encouraging placeholder for the cancel-run reason field.
  // Optional input — we deliberately don't hard-require because
  // operators sometimes cancel because they fat-fingered, and forcing
  // a reason produces "asdf" noise that pollutes audit.
  'run.cancel.reasonPlaceholder': 'Why are you cancelling? (optional, helps the team learn)',
  'run.history.totalLabel': 'Total spent',
  'run.history.itemSummary': '{bought} bought · {na} unavailable',
  'run.history.storeSummary': '{stores} stores',
  'run.history.itemsHeading': 'Items',
  'run.history.storesHeading': 'Per-store breakdown',
  'run.history.loadingDetails': 'Loading details…',

  // ── 11. Run errors ─────────────────────────────────────────────
  'run.errors.alreadyPlanned': 'Run already exists for this slot',
  'run.errors.cannotCreate': "You don't have permission to create runs",
  'run.errors.noSessions': 'Pick at least one approved session',
  'run.errors.noItems': 'No items to purchase',
  'run.errors.cannotStartPurchase': 'Cannot start purchase right now',
  'run.errors.cannotPurchase': "You don't have permission to record purchases",
  'run.errors.runFrozen': 'Run is frozen and cannot be modified',
  'run.errors.cannotAmend': 'Only a super-admin can amend a finished run',
  'run.errors.notReopenable': 'Only a finished run can be reopened for correction',
  'run.errors.notRefinalizable': 'This run is not in a correction state',
  'run.errors.reopenReasonRequired': 'A reason is required to reopen the run',
  'run.action.refinalize': 'Save changes',
  'run.toast.amendSaved': 'Changes saved and re-settled',
  'run.confirm.refinalize.title': 'Save changes?',
  'run.confirm.refinalize.body': 'The run will be re-settled from the corrected data. New total: {total}.',
  'run.amend.banner': 'Correction mode (super-admin)',
  'run.amend.bannerHint': 'Editing a finished run. Tap “Save changes” at the bottom to re-settle when done.',
  'run.step.amend': 'Correcting',
  'run.amend.reopened': 'Correction mode on — continue editing on the Run tab',
  'run.amend.entryLabel': 'Amend this run (super-admin)',
  'run.amend.reasonPlaceholder': 'Reason for the correction (required)',
  'run.amend.reopenButton': 'Reopen for correction',
  'run.errors.itemNotInRun': 'Item not in this run',
  'run.errors.invalidQty': 'Invalid quantity',
  'run.errors.qtyMustBePositive': 'Quantity must be positive',
  'run.errors.splitSumMismatch': 'Store split must sum to actual quantity',
  'run.errors.unavailableNoteRequired': 'Please describe why the item is unavailable',
  'run.errors.noteTooLong': 'Note is too long (max 500 characters)',
  'run.errors.notReadyToDeliver': 'Cannot start delivery yet',
  'run.errors.itemsPending': 'Some items are still pending',
  'run.errors.notDelivering': 'Delivery is not in progress',
  'run.errors.cannotDispatch': "You don't have permission to dispatch",
  'run.errors.cannotConfirm': "You don't have permission to confirm",
  'run.errors.confirmNoteRequiredOnIssue': 'Please describe the issue',
  'run.errors.storeNotDelivered': 'Store has not received delivery yet',
  'run.errors.itemConfirmMissing': 'Some items still need a decision',
  'run.errors.cannotFinish': "You don't have permission to finish runs",
  'run.errors.notFinishable': 'Run cannot be finished yet',
  'run.errors.storeNotConfirmed': 'A store has not confirmed yet',
  'run.errors.alreadyFinished': 'Run is already finished',
  'run.errors.cannotCancel': "You don't have permission to cancel runs",
  'run.errors.cancelReasonRequired': 'Please provide a reason',
  'run.errors.streamMissing': 'Run does not exist',
  'run.errors.sessionMissing': 'Order session not found',
  'run.errors.sessionNotApproved': 'Order session is not approved',
  'run.errors.staleSeq': 'Someone else just edited — please retry',
  'run.errors.notPurchased': 'This item has not been purchased yet',
  'run.errors.notRevisable': 'This item has not been purchased yet',
  'run.errors.cannotReviseAfterDelivery': 'Cannot edit — already delivered to a store',
  'run.errors.notUnavailable': 'This item is not marked unavailable',
  'run.errors.alreadyConfirmed': 'Cannot recall — store has already confirmed receipt',
  'run.errors.notPurchasing': 'Run is not in the purchasing phase',
  'run.errors.purchaseAlreadyProgressed': 'Cannot undo — items have already been recorded',
  'run.errors.deliveryAlreadyProgressed':
    'Cannot undo — a store has already received delivery',
  'run.errors.reviseReasonRequired': 'Please describe what changed',
  'run.errors.unmarkReasonRequired': 'Please describe why this is available now',
  'run.errors.recallReasonRequired': 'Please describe why you are recalling this',
  'run.errors.undoReasonRequired': 'Please describe why you are reverting',
  'run.errors.splitsMustSum': 'Splits must sum to actual qty',

  // ── 12. Confirm page (delivery acceptance) ──────────────────────
  'confirm.title': 'Confirm delivery',
  'confirm.empty.noActive': 'No active delivery',
  'confirm.empty.noStore': 'No store selected',
  'confirm.empty.noItems': 'No items for this store',
  'confirm.empty.nothingToConfirm': 'Nothing to confirm',
  'confirm.empty.nothingDesc':
    'A run will show up here once items are delivered to your store.',
  'confirm.runOnDate': 'Run {date}',
  'confirm.decided': 'Decided',
  'confirm.deliveredItems': 'Delivered items',
  'confirm.deliveredItemsHint': 'Tap a status for each item',
  'confirm.confirmStore': 'Confirm store',
  'confirm.confirmStoreFinal': '✓ Confirmed',
  'confirm.confirmStoreFinalBanner': 'Store confirmed ✓',
  'confirm.confirmingHint': 'Confirming…',
  'confirm.toast.markedOk': 'Marked OK',
  'confirm.toast.issueNoted': 'Issue noted',
  'confirm.toast.storeConfirmed': 'Store confirmed',
  'confirm.toast.savedOffline': 'Saved offline — will sync when back online',
  'confirm.issue.markAs': 'Mark as {status}',
  'confirm.issue.describe': 'Please describe the issue so the purchaser can correct it.',
  'confirm.issue.placeholder': "What's wrong?",
  'confirm.issue.photoOptional': 'Photo (optional)',
  'confirm.issue.save': 'Save',
  // M1.9-fix (2026-05-07): the 4 receive-side decision chips. These
  // are the most-tapped UI on the entire page; rendering raw enum
  // values to non-English users was a launch blocker.
  'confirm.status.ok': 'OK',
  'confirm.status.short': 'Short qty',
  'confirm.status.wrong': 'Wrong item',
  'confirm.status.quality': 'Quality issue',

  // ── 13. App theme ──────────────────────────────────────────────
  'app.theme.native': 'Native',
  'app.theme.apple': 'Apple',
  'app.theme.dark': 'Dark',

  // ── 14. Finance reports (M1.15, 2026-05-08) ─────────────────────
  // The "Finance" subsection of Admin → Operations. Date-range
  // scorecard + three view modes over the same dataset (daily, by
  // supplier, by store). Export = clipboard TSV.
  'finance.preset.today': 'Today',
  'finance.preset.yesterday': 'Yesterday',
  'finance.preset.thisMonth': 'This month',
  'finance.preset.lastMonth': 'Last month',
  'finance.preset.custom': 'Custom',
  'finance.range.start': 'Start date',
  'finance.range.end': 'End date',
  'finance.view.daily': 'Daily',
  'finance.view.bySupplier': 'By supplier',
  'finance.view.byStore': 'By store',
  'finance.label.lines': 'lines',
  'finance.label.runs': 'runs',
  'finance.label.total': 'Total',
  'finance.label.noSupplier': 'no supplier',
  'finance.empty.title': 'No purchases in this range',
  'finance.empty.description': 'Pick a different date range, or record a run first.',
  'finance.export.label': 'Copy as TSV',
  'finance.export.copied': 'Report copied — paste into a spreadsheet.',
  'finance.export.noClipboard': 'Clipboard not available — check console for TSV.',
  // Server error key emitted when a non-admin attempts to query the
  // finance reports.
  'admin.errors.financeRequiresManage':
    'Finance reports require the users.manage permission.',

  // ── 15. Org financial settings (M1.17) ────────────────
  // Currency + tax rate + price tax-inclusivity. Lives in Admin →
  // Workspace. Foundation columns; reports / domain consumption land
  // in M2.x.
  'admin.workspace.currency': 'Currency',
  'admin.workspace.taxRate': 'Tax rate',
  'admin.workspace.taxRateHint': 'Standard VAT %. Set 0 to disable tax tracking.',
  'admin.workspace.pricesIncludeTax': 'Prices include tax',
  'admin.workspace.pricesIncludeTaxOn': 'Gross (price as quoted at the stall)',
  'admin.workspace.pricesIncludeTaxOff': 'Net (tax added on top)',
  'admin.workspace.financeRow': 'Financial settings',
  'admin.workspace.financeRowHint': '{currency} · tax {tax}',
  'admin.workspace.financeSheet.title': 'Financial settings',
  'admin.workspace.financeSheet.description':
    'Org-wide defaults — never re-denominates historical money.',
  'admin.workspace.financeSheet.warning':
    'Changing currency does NOT convert past purchases. Set once per org.',
  'admin.errors.taxRateOutOfRange': 'Tax rate must be between 0 and 50.',

  // ── 15a. Shared admin form labels (M1.21-C, 2026-05-08) ───────
  // The Admin section had ~40 form labels hardcoded in English JSX
  // (`<Field label="Slug *">`, etc.). This block centralises them so
  // the non-EN catalogs can translate once and every form picks up
  // the right copy. The trailing `*` for required fields stays as a
  // literal in the JSX — it's punctuation, not language.
  'admin.field.slug': 'Slug',
  'admin.field.name': 'Name',
  'admin.field.description': 'Description',
  'admin.field.code': 'Code',
  'admin.field.address': 'Address',
  'admin.field.timezone': 'Timezone',
  'admin.field.phone': 'Phone',
  'admin.field.notes': 'Notes',
  'admin.field.tgUsername': 'Telegram username',
  'admin.field.scope': 'Scope',
  'admin.field.stores': 'Stores',
  'admin.field.assignedStores': 'Assigned stores',
  'admin.field.displayNameOverride': 'Display name (admin override)',
  'admin.field.dateFrom': 'From',
  'admin.field.dateTo': 'To',
  'admin.field.sortIndex': 'Sort index',
  'admin.field.unit': 'Unit',
  'admin.field.step': 'Step',
  'admin.field.category': 'Category',
  'admin.field.defaultRole': 'Default role for new members',
  'admin.field.sourceStore': 'Source store',
  // Per-locale name field used by SKU and category editors. `{locale}`
  // is the native-name display string (Русский, 中文, etc.).
  'admin.field.nameInLocale': 'Name — {locale}',
  // Activity dashboard tiles.
  'admin.tile.members': 'Members',
  'admin.tile.stores': 'Stores',
  'admin.tile.activeSkus': 'Active SKUs',
  'admin.tile.totalRuns': 'Total runs',
  'admin.tile.pendingApprovals': 'Pending approvals',
  'admin.tile.ordersThisWeek': 'Orders / 7 days',
  'admin.aria.back': 'Back',

  // ── 16. Inventory (M2.0a) ──────────────────────────────
  // First step of the ERP shift. Inventory tab under Admin → Stores →
  // [store]. Drives the levels list + stocktake + wastage editor.
  'inventory.empty.title': 'No inventory data yet',
  'inventory.empty.description':
    'Confirm a delivery in this store to start seeing on-hand levels here.',
  'inventory.action.stocktake': 'Stocktake',
  'inventory.action.wastage': 'Wastage',
  'inventory.sheet.stocktake.title': 'Stocktake',
  'inventory.sheet.stocktake.systemSays': 'System on-hand: {qty}',
  'inventory.sheet.stocktake.targetLabel': 'Actual on-hand now',
  'inventory.sheet.stocktake.targetHint':
    'Count the shelf and type the real total. We compute the difference.',
  'inventory.sheet.stocktake.notePlaceholder': 'optional reason for the difference',
  'inventory.sheet.wastage.title': 'Record wastage',
  'inventory.sheet.wastage.qtyLabel': 'Quantity lost',
  'inventory.sheet.wastage.notePlaceholder': 'spoiled / broken / mislabeled / lost',
  'inventory.sheet.wastage.noteHint': 'Required — wastage rows without context are useless later.',
  'inventory.sheet.note': 'Note',
  'inventory.toast.stocktakeSaved': 'Stocktake saved.',
  'inventory.toast.wastageSaved': 'Wastage recorded.',
  'inventory.errors.cannotAdjust':
    'You need inventory.adjust to stocktake or record wastage.',
  'inventory.errors.invalidQty': 'Quantity must be a non-negative number.',
  'inventory.errors.wastageNeedsNote': 'Wastage requires a reason.',

  // ── 17. Dishes / Recipes (M2.0b) ───────────────────────
  // Menu items + BOM. Admin → Catalog → Dishes.
  'admin.subsection.dishes': 'Dishes',
  'admin.subsection.dishesHint': 'Menu items + recipe (BOM) per dish',
  // ── 17b. Expense Templates (M3.57) ─────────────────────
  // Recurring off-catalog expenses (porter, taxi, parking) that
  // every new run auto-includes so the purchaser doesn't have to
  // re-type the same lines on every market trip.
  'admin.subsection.expenseTemplates': 'Expense templates',
  'admin.subsection.expenseTemplatesHint':
    'Manual shortcuts for daily store expenses',
  'admin.action.newExpenseTemplate': '+ New template',
  'admin.action.unarchive': 'Unarchive',
  'admin.label.archived': 'Archived',
  'admin.expenseTemplates.intro':
    'Templates only prefill the purchase page expense form. Purchasers still choose the business date, store, amount, receipt, and reason for each real daily expense.',
  'admin.expenseTemplates.empty.title': 'No templates yet',
  'admin.expenseTemplates.empty.body':
    'Add common labels like porter fees, taxi, or parking so purchasers can fill daily store expenses faster without auto-creating costs.',
  'admin.expenseTemplates.labelPlaceholder': 'Porter / Taxi / Parking…',
  'admin.expenseTemplates.unitHintPlaceholder': 'trip, pack, lump-sum…',
  'admin.field.label': 'Name',
  'admin.field.unitHint': 'Unit hint',
  'admin.field.defaultQty': 'Default qty',
  'admin.field.defaultUnitPrice': 'Default unit price',
  'admin.field.defaultPaymentMethod': 'Default payment',
  'admin.sheet.newExpenseTemplate': 'New expense template',
  'admin.sheet.editExpenseTemplate': 'Edit template',
  'admin.confirm.archiveExpenseTemplate':
    'Archive template "{label}"? Future runs will skip this template.',
  'admin.toast.expenseTemplateCreated': 'Template added',
  'admin.toast.expenseTemplateUpdated': 'Template updated',
  'admin.toast.expenseTemplateArchived': 'Template archived',
  'admin.errors.expenseTemplateNotFound': 'Template not found',
  'dishes.empty.title': 'No dishes yet',
  'dishes.empty.description': 'Add menu items here. Recipes link each dish to its ingredient SKUs.',
  'dishes.action.new': '+ New dish',
  'dishes.action.showArchived': 'Show archived',
  'dishes.action.hideArchived': 'Hide archived',
  'dishes.action.addIngredient': '+ Ingredient',
  'dishes.label.noIngredients': 'No recipe yet',
  'dishes.label.noIngredientsHint': 'Add ingredients so M2.0c can deduct on sales.',
  'dishes.label.ingredientCount': '{n} ingredients',
  'dishes.sheet.newTitle': 'New dish',
  'dishes.sheet.editTitle': 'Edit dish',
  'dishes.section.ingredients': 'Recipe (BOM)',
  'dishes.field.code': 'Code',
  'dishes.field.codeHint': 'Optional kitchen shorthand (e.g. D-12).',
  'dishes.field.unitPrice': 'Price per serving',
  'dishes.field.qtyPlaceholder': 'qty per serving',
  'dishes.field.pickSku': 'Pick ingredient…',
  'dishes.confirm.archive': 'Archive "{name}"?',
  'dishes.errors.cannotManage': 'You need dishes.manage to edit menu items.',
  'dishes.errors.namesRequired': 'At least one language name is required.',
  'dishes.errors.ingredientQtyMustBePositive': 'Ingredient qty must be > 0.',
  'dishes.errors.ingredientSkuNotFound': 'One or more ingredients reference an unknown SKU.',
  'dishes.errors.notFound': 'Dish not found.',

  // ── 18. Sales (M2.0c) ──────────────────────────────────
  // Sales recording — closes the ERP loop. Admin → Stores →
  // [store] → Sales. Each recorded sale auto-deducts ingredient
  // inventory via the dish's recipe BOM (server-side, same tx).
  'sales.summary.today': "Today",
  'sales.summary.servings': 'servings',
  'sales.summary.revenue': 'Revenue',
  'sales.form.recordTitle': 'Record sale',
  'sales.form.pickDish': 'Pick dish…',
  'sales.form.qtyLabel': 'Servings',
  'sales.form.recordBtn': 'Record',
  'sales.form.noDishesYet': 'No dishes set up. Add one in Catalog → Dishes first.',
  'sales.form.noRecipe': 'no recipe',
  'sales.list.title': "Today's sales",
  'sales.empty.title': 'No sales recorded today',
  'sales.empty.description': 'Tap "Record" above to log the first sale.',
  'sales.toast.recorded': 'Sale recorded — inventory updated.',
  'sales.errors.cannotRecord':
    'You need sales.record at this store to log sales.',
  'sales.errors.dishNotFound': 'Dish not found.',
  'sales.errors.dishArchived':
    'This dish is archived. Unarchive it before recording sales.',
  'sales.errors.storeNotFound': 'Store not found.',
  'sales.errors.dishHasNoRecipe':
    'Set a recipe (BOM) for this dish before recording sales.',
  'run.action.addItem.storeAlreadyHasSkuShort': 'already added',
  'run.action.addItem.costModeTitle': 'Same item price handling',
  'run.action.addItem.costModeMerge': 'Merge row',
  'run.action.addItem.costModeSeparate': 'Store cost',
  'run.action.addItem.storeAlreadyHasSkuHint':
    'This store already has this SKU, so this save will be recorded as a store-level cost instead of overwriting the original price.',
  'run.action.addItem.separatePriceHint':
    'Record this as an independent cost for the selected store, useful when the same SKU is bought at a different time, supplier, or price.',
  'run.action.addItem.mergePriceHint':
    'Merge into the existing purchase row and recalculate this SKU with one shared unit price.',
  'run.action.addExpense.templates': 'Expense template shortcuts',
  'run.action.addExpense.scopeTitle': 'Expense scope',
  'run.action.addExpense.scopeShared': 'Shared expense',
  'run.action.addExpense.scopeStore': 'Store expense',
  'run.action.addExpense.scopeSharedHint': 'Split evenly across every store in this run.',
  'run.action.addExpense.scopeStoreHint': 'Charge the full expense to one selected store.',
  'run.action.addExpense.button': '+ Expense',
  'run.section.sharedExpenses': 'Shared expenses',
  'run.section.storeExpenses': 'Store expenses',
  'run.history.viewAll': 'All history',
  'run.history.storePurchases': 'Store purchases that day',
  'run.history.storeItemsHeading': '{store} purchases that day',
} as const;
