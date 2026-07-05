/**
 * Shared admin helpers (Phase 5 — FRONTEND_AUDIT_2026-07.md admin split).
 */
import { getTg } from '../../hooks/useTelegram';

export function nativeConfirm(message: string, ok: () => void): void {
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
export type AdminSection =
  | 'home'
  | 'organization'
  | 'stores'
  | 'permissions'
  | 'catalog'
  | 'operations';

// M2.0b: new 'dishes' sub-section for menu items + recipe (BOM) editor.
// Lives next to SKUs because both are catalog data, but a separate
// route keeps the SKU list from getting cluttered.
export type CatalogSub =
  | 'categories'
  | 'skus'
  | 'suppliers'
  | 'dishes'
  | 'expenseTemplates';
export type OperationsSub =
  | 'activity'
  | 'history'
  | 'maintenance'
  | 'adminAudit'
  | 'priceReport'
  // M1.15 (2026-05-08): finance reconciliation (cash/transfer breakdown
  // by date range + supplier + store). Lives under Operations because
  // it's a read-only view, not a CRUD surface — same shape as the price
  // report next to it.
  | 'finance';

/**
 * StoreFocus tracks "am I drilled into a specific store, or browsing
 * the list?". `null` → list. `'org-level'` → the pseudo-store for
 * unbound members. `{ storeId, storeName }` → a real store.
 */
export type StoreFocus =
  | null
  | { kind: 'org-level' }
  | { kind: 'store'; storeId: string; storeName: string };

/** Sub-tab inside a focused store. Org-level only ever shows 'team'. */
// M2.0a: add 'inventory' tab — on-hand levels + stocktake + wastage.
// M2.0c: add 'sales' tab — record sales (auto-deducts inventory).
// Both only meaningful on real stores (not org-level pseudo-store).
export type StoreSub = 'team' | 'settings' | 'inventory' | 'sales';
