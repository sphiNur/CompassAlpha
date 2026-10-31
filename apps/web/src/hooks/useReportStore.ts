/**
 * The store a report page shows (CMP-HIS-1): the top bar's store until the
 * reader picks another one on the page; picking a different store in the
 * top bar starts following it again. See lib/reportStore.ts.
 */
import { useEffect, useState } from 'react';
import { useStoreContext } from '../components/StoreSwitcher';
import { defaultReportStore } from '../lib/reportStore';

export function useReportStore(readableStores: ReadonlyArray<{ id: string }> | undefined): {
  /** '' = all stores. */
  storeId: string;
  setStoreId: (storeId: string) => void;
  /**
   * False until the readable stores are known while the top bar names a
   * store: querying before that would ask for every store first.
   */
  ready: boolean;
} {
  const context = useStoreContext();
  const contextKey = context.kind === 'specific' ? context.storeId : context.kind;
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    setPicked(null);
  }, [contextKey]);
  const storeId = picked ?? defaultReportStore(context, readableStores);
  return {
    storeId,
    setStoreId: setPicked,
    ready: picked !== null || context.kind !== 'specific' || readableStores !== undefined,
  };
}
