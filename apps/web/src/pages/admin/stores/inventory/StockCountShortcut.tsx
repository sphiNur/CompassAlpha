/**
 * D1 (2026-11-13): "Count stock" on the Admin home, for someone who may
 * count stock in exactly one store (a single-store manager). One tap opens
 * the count mode; it used to take Stores → the store → Inventory, then a
 * sheet per product. UX-12 (2026-11-14): with several stores, the row
 * counts the store in the top bar (`topBarStoreId`, null for "All
 * stores", where it is hidden), as the Invite row starts on it.
 */
import { useMemo, useState } from 'react';
import { IconCatalog, SectionRow } from '@compass/ui';
import { useAuthStore } from '../../../../stores/authStore';
import { useI18n } from '../../../../hooks/useI18n';
import { StockCountSheet } from './StockCountSheet';
import { countShortcutStore } from '../stockCount';

export function StockCountShortcut({ topBarStoreId }: { topBarStoreId: string | null }) {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const store = useMemo(
    () => (session ? countShortcutStore(session, topBarStoreId) : null),
    [session, topBarStoreId],
  );
  const [open, setOpen] = useState(false);
  if (!store) return null;
  return (
    <>
      <SectionRow
        icon={<IconCatalog size={20} />}
        label={i18n.t('inventory.count.title')}
        hint={store.name}
        onClick={() => setOpen(true)}
      />
      <StockCountSheet
        storeId={store.id}
        storeName={store.name}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
