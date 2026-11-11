/**
 * Admin → Catalog → "Import from another organisation" (2026-10-23).
 *
 * Lists the other organisations where the caller is an org-wide admin
 * (admin.catalogImportSources), shows what an import would create
 * (admin.catalogImportPreview — a dry run on the server) and runs it
 * (admin.catalogImport). What is copied: apps/api/src/services/catalogCopy.ts.
 *
 * Review ADM2-39 (2026-11-11): the sources load like any list (DataState:
 * spinner, error with retry, "none"); they used to be an empty picker
 * while loading or after a failure. A failed preview says why, from the
 * server's error, with a retry, instead of a bare "action failed".
 */
import { useEffect, useState } from 'react';
import {
  Banner,
  Button,
  DataState,
  Field,
  QueryErrorBanner,
  Select,
  Sheet,
  Spinner,
  Switch,
  useToast,
} from '@compass/ui';
import { trpc } from '../../../lib/trpc';
import { useErrToast } from '../../../hooks/useErrToast';
import { useI18n } from '../../../hooks/useI18n';

export function CatalogImportSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const [sourceOrgId, setSourceOrgId] = useState('');
  const [includeSuppliers, setIncludeSuppliers] = useState(true);

  const sources = trpc.admin.catalogImportSources.useQuery(undefined, { enabled: open });
  useEffect(() => {
    // One candidate → pick it; the admin shouldn't have to.
    if (!sourceOrgId && sources.data?.length === 1) setSourceOrgId(sources.data[0]!.orgId);
  }, [sources.data, sourceOrgId]);

  const preview = trpc.admin.catalogImportPreview.useQuery(
    { sourceOrgId, includeSuppliers },
    { enabled: open && !!sourceOrgId },
  );
  const run = trpc.admin.catalogImport.useMutation({
    onSuccess: (r) => {
      void utils.admin.skuList.invalidate();
      void utils.admin.categoryList.invalidate();
      void utils.admin.supplierList.invalidate();
      void utils.admin.catalogImportPreview.invalidate();
      toast.success(
        i18n.t('catalog.import.done', {
          skus: r.skus.created,
          categories: r.categories.created,
          suppliers: r.suppliers.created,
        }),
      );
      onOpenChange(false);
    },
    onError: errToast('common.errors.actionFailed'),
  });

  const p = preview.data;
  const nothingNew = !!p && p.categories.created + p.skus.created + p.suppliers.created === 0;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={i18n.t('catalog.import.title')}
      footer={
        <Button
          block
          loading={run.isPending}
          disabled={!sourceOrgId || !p || nothingNew || preview.isFetching}
          onClick={() => run.mutate({ sourceOrgId, includeSuppliers })}
        >
          {i18n.t('catalog.import.submit')}
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-old-label text-[var(--c-fg-muted)]">
          {i18n.t('catalog.import.explain')}
        </p>
        <DataState
          query={sources}
          emptyWhen={(list) => list.length === 0}
          empty={<Banner tone="info" title={i18n.t('catalog.import.noSources')} />}
        >
          {(list) => (
            <Field label={i18n.t('catalog.import.source')}>
              <Select
                value={sourceOrgId}
                placeholder={i18n.t('catalog.import.sourcePlaceholder')}
                onChange={(e) => setSourceOrgId(e.target.value)}
              >
                {list.map((o) => (
                  <option key={o.orgId} value={o.orgId}>
                    {o.orgName}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </DataState>
        <Switch
          label={i18n.t('catalog.import.includeSuppliers')}
          checked={includeSuppliers}
          onChange={(e) => setIncludeSuppliers(e.target.checked)}
        />
        {preview.isError ? (
          <QueryErrorBanner query={preview} />
        ) : preview.isLoading ? (
          <div className="flex justify-center py-3 text-[var(--c-fg-muted)]">
            <Spinner />
          </div>
        ) : p ? (
          nothingNew ? (
            <Banner tone="success" title={i18n.t('catalog.import.nothingNew')} />
          ) : (
            <ul className="space-y-1 text-old-body">
              <li>
                {i18n.t('catalog.import.previewCategories', {
                  n: p.categories.created,
                  m: p.categories.existing,
                })}
              </li>
              <li>
                {i18n.t('catalog.import.previewProducts', {
                  n: p.skus.created,
                  m: p.skus.existing,
                })}
              </li>
              {includeSuppliers ? (
                <li>
                  {i18n.t('catalog.import.previewSuppliers', {
                    n: p.suppliers.created,
                    m: p.suppliers.existing,
                  })}
                </li>
              ) : null}
            </ul>
          )
        ) : null}
      </div>
    </Sheet>
  );
}
