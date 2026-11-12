/**
 * Admin → Catalog → Suppliers (stalls): the list and its editor. Review
 * ADM2-11 (2026-11-11): one file per catalog section.
 */
import { useState } from 'react';
import {
  Button,
  DataState,
  EmptyState,
  Field,
  Input,
  Sheet,
  useToast,
  rowGroupClass,
} from '@compass/ui';
import { CATALOG_TEXT_MAX } from '@compass/contracts/limits';
import { trpc } from '../../../lib/trpc';
import { useErrToast } from '../../../hooks/useErrToast';
import { useI18n } from '../../../hooks/useI18n';
import {
  CatalogRowActions,
  CatalogRowHeader,
  CatalogToolbar,
  ReadOnlyHint,
  useIsOrgAdmin,
} from './CatalogParts';
import { useEditorSheet } from '../../../hooks/useDraftChanged';
import { changedFields, hasChanges } from './editPatch';

/** A supplier's fields as the editor types them ('' for none). */
interface SupplierText {
  name: string;
  contactPhone: string;
  contactTg: string;
  address: string;
  notes: string;
}

interface SupplierDraft extends SupplierText {
  supplierId?: string;
  /** What an edit opened with, as sent (ADM2-24); a save sends the rest. */
  opened?: SupplierFields;
}

type SupplierFields = ReturnType<typeof supplierFields>;

/** The fields as the API takes them: an empty one is null. */
function supplierFields(d: SupplierText) {
  return {
    name: d.name,
    contactPhone: d.contactPhone || null,
    contactTg: d.contactTg || null,
    address: d.address || null,
    notes: d.notes || null,
  };
}

export function SuppliersSection() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const suppliersQuery = trpc.admin.supplierList.useQuery({ includeArchived });
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const canWrite = useIsOrgAdmin();
  const [draft, setDraft] = useState<SupplierDraft | null>(null);

  const create = trpc.admin.supplierCreate.useMutation({
    onSuccess: () => {
      void utils.admin.supplierList.invalidate();
      toast.success(i18n.t('admin.toast.supplierCreated'));
      setDraft(null);
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const update = trpc.admin.supplierUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.supplierList.invalidate();
      toast.success(i18n.t('admin.toast.supplierUpdated'));
      setDraft(null);
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const remove = trpc.admin.supplierDelete.useMutation({
    onSuccess: () => {
      void utils.admin.supplierList.invalidate();
      toast.info(i18n.t('admin.toast.supplierArchived'));
    },
    onError: errToast('common.errors.actionFailed'),
  });

  const editor = useEditorSheet(
    draft,
    setDraft,
    (d) => d.supplierId ?? 'new',
    create.isPending || update.isPending,
  );

  return (
    <div className="px-4 py-3">
      {canWrite ? null : <ReadOnlyHint />}
      <CatalogToolbar
        newLabel={canWrite ? i18n.t('catalog.supplier.newButton') : undefined}
        onNew={() =>
          setDraft({
            name: '',
            contactPhone: '',
            contactTg: '',
            address: '',
            notes: '',
          })
        }
        showArchived={includeArchived}
        onShowArchivedChange={setIncludeArchived}
      />
      <DataState
        query={suppliersQuery}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title={i18n.t('catalog.supplier.emptyTitle')}
            description={i18n.t('catalog.supplier.emptyBody')}
          />
        }
      >
        {(rows) => (
          <ul className={rowGroupClass} role="list">
            {rows.map((sp) => (
              <li key={sp.id}>
                <CatalogRowHeader
                  title={sp.name}
                  // ADM2-11: joined, so a supplier with no phone does not
                  // start with " · ".
                  meta={[sp.contactPhone, sp.contactTg ? `@${sp.contactTg}` : null, sp.address]
                    .filter(Boolean)
                    .join(' · ')}
                  archived={sp.isArchived}
                />
                {canWrite ? (
                  <CatalogRowActions
                    archived={sp.isArchived}
                    onEdit={() => {
                      const text = {
                        name: sp.name,
                        contactPhone: sp.contactPhone ?? '',
                        contactTg: sp.contactTg ?? '',
                        address: sp.address ?? '',
                        notes: sp.notes ?? '',
                      };
                      setDraft({ supplierId: sp.id, ...text, opened: supplierFields(text) });
                    }}
                    confirmArchive={i18n.t('catalog.supplier.confirmArchive', { name: sp.name })}
                    onArchive={() => remove.mutate({ supplierId: sp.id })}
                    onUnarchive={() => update.mutate({ supplierId: sp.id, isArchived: false })}
                    unarchiving={update.isPending && update.variables?.supplierId === sp.id}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </DataState>

      <Sheet
        {...editor}
        title={i18n.t(draft?.supplierId ? 'catalog.supplier.edit' : 'catalog.supplier.new')}
        footer={
          <Button
            block
            loading={create.isPending || update.isPending}
            disabled={!draft?.name.trim()}
            onClick={() => {
              if (!draft) return;
              const fields = supplierFields(draft);
              if (!draft.supplierId) {
                create.mutate(fields);
                return;
              }
              // ADM2-24: only what this edit changed. Nothing changed:
              // nothing to save.
              const changes = draft.opened ? changedFields(fields, draft.opened) : fields;
              if (!hasChanges(changes)) {
                setDraft(null);
                return;
              }
              update.mutate({ supplierId: draft.supplierId, ...changes });
            }}
          >
            {draft?.supplierId ? i18n.t('common.save') : i18n.t('common.create')}
          </Button>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-3 py-3">
            <Field label={i18n.t('admin.field.name')} required>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                maxLength={CATALOG_TEXT_MAX.name}
                autoFocus
              />
            </Field>
            <Field label={i18n.t('admin.field.phone')}>
              <Input
                value={draft.contactPhone}
                onChange={(e) => setDraft({ ...draft, contactPhone: e.target.value })}
                maxLength={CATALOG_TEXT_MAX.phone}
                placeholder="+998 …"
              />
            </Field>
            <Field label={i18n.t('admin.field.tgUsername')}>
              <Input
                value={draft.contactTg}
                onChange={(e) =>
                  setDraft({ ...draft, contactTg: e.target.value.replace(/^@/, '') })
                }
                maxLength={CATALOG_TEXT_MAX.telegram}
                placeholder={i18n.t('catalog.supplier.tgPlaceholder')}
              />
            </Field>
            <Field label={i18n.t('admin.field.address')}>
              <Input
                value={draft.address}
                onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                maxLength={CATALOG_TEXT_MAX.address}
              />
            </Field>
            <Field label={i18n.t('admin.field.notes')}>
              <Input
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                maxLength={CATALOG_TEXT_MAX.notes}
              />
            </Field>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
