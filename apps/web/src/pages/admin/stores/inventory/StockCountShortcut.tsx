/**
 * D1 (2026-11-13): "Count stock" on the Admin home, for someone who may
 * count stock in exactly one store (a single-store manager). One tap opens
 * the count mode; it used to take Stores → the store → Inventory, then a
 * sheet per product. With several stores the count is opened from the
 * store's Inventory tab, where the store is chosen.
 */
import { useMemo, useState } from 'react';
import { IconCatalog, SectionRow } from '@compass/ui';
import { useAuthStore } from '../../../../stores/authStore';
import { useI18n } from '../../../../hooks/useI18n';
import { StockCountSheet } from './StockCountSheet';
import { soleCountStore } from '../stockCount';

export function StockCountShortcut() {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const store = useMemo(() => (session ? soleCountStore(session) : null), [session]);
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
