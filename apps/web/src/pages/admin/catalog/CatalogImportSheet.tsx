/**
 * Admin → Catalog → "Import from another organisation" (2026-10-23).
 *
 * Lists the other organisations where the caller is an org-wide admin
 * (admin.catalogImportSources), shows what an import would create
 * (admin.catalogImportPreview — a dry run on the server) and runs it
 * (admin.catalogImport). What is copied: apps/api/src/services/catalogCopy.ts.
 */
import { useEffect, useState } from 'react';
import { Banner, Button, Field, Select, Sheet, Switch, useToast } from '@compass/ui';
import { trpc } from '../../../lib/trpc';
import { useErrToast } from '../../../lib/errToast';
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
    onError: errToast('common.error'),
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
        {sources.data && sources.data.length === 0 ? (
          <Banner tone="info" title={i18n.t('catalog.import.noSources')} />
        ) : (
          <Field label={i18n.t('catalog.import.source')}>
            <Select
              value={sourceOrgId}
              placeholder={i18n.t('catalog.import.sourcePlaceholder')}
              onChange={(e) => setSourceOrgId(e.target.value)}
            >
              {(sources.data ?? []).map((o) => (
                <option key={o.orgId} value={o.orgId}>
                  {o.orgName}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Switch
          label={i18n.t('catalog.import.includeSuppliers')}
          checked={includeSuppliers}
          onChange={(e) => setIncludeSuppliers(e.target.checked)}
        />
        {preview.isError ? (
          <Banner tone="danger" title={i18n.t('common.error')} />
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
