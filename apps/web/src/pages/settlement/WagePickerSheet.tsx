/**
 * Choosing the employee a wage line pays. Review CONF-06: moved out of
 * SettlementPage, with the role filter and search it owns.
 */
import { useMemo, useState } from 'react';
import {
  Banner,
  Button,
  EmptyState,
  Field,
  PendingState,
  SearchInput,
  Select,
  Sheet,
} from '@compass/ui';
import { trpc } from '../../lib/trpc';
import { useI18n, useRoleLabels } from '../../hooks/useI18n';

export interface WagePick {
  memberId: string;
  displayName: string;
}

export function WagePickerSheet({
  storeId,
  lineId,
  onPick,
  onClose,
}: {
  storeId: string;
  /** The wage line being filled in; `null` while the sheet is closed. */
  lineId: string | null;
  onPick: (employee: WagePick) => void;
  onClose: () => void;
}) {
  const i18n = useI18n();
  return (
    <Sheet
      open={lineId !== null}
      onOpenChange={(open) => {
        if (open) return;
        onClose();
      }}
      title={i18n.t('settlement.wages.pickerTitle')}
      description={i18n.t('settlement.wages.pickerDescription')}
    >
      {/* Keyed by the line: each opening starts with no filter or search. */}
      <WageRoster key={lineId ?? ''} storeId={storeId} open={lineId !== null} onPick={onPick} />
    </Sheet>
  );
}

function WageRoster({
  storeId,
  open,
  onPick,
}: {
  storeId: string;
  open: boolean;
  onPick: (employee: WagePick) => void;
}) {
  const i18n = useI18n();
  const roleText = useRoleLabels();
  const [roleFilter, setRoleFilter] = useState('');
  const [search, setSearch] = useState('');
  // The picker loads only on demand. This returns a minimum, store-scoped
  // roster rather than the admin directory, so cashiers never receive data
  // about staff in other stores.
  const rosterQuery = trpc.settlement.wageRoster.useQuery({ storeId }, { enabled: open });
  const roster = rosterQuery.data;
  const roleOptions = useMemo(() => {
    const roles = (roster ?? []).flatMap((employee) => employee.roles);
    const byId = new Map(roles.map((role) => [role.id, role] as const));
    // CONF-18: in the order the names are shown (built-in roles are
    // translated), in the UI language's collation.
    return [...byId.values()].sort((left, right) =>
      roleText.name(left).localeCompare(roleText.name(right), i18n.locale),
    );
  }, [roster, roleText, i18n.locale]);
  const shown = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (roster ?? []).filter((employee) => {
      if (roleFilter && !employee.roles.some((role) => role.id === roleFilter)) {
        return false;
      }
      return !query || employee.displayName.toLocaleLowerCase().includes(query);
    });
  }, [roleFilter, roster, search]);
  const loaded = !rosterQuery.isPending && !rosterQuery.isError;
  const rosterSize = roster?.length ?? 0;

  return (
    <div className="flex flex-col gap-3 py-2">
      <Field label={i18n.t('settlement.wages.roleFilter')}>
        <Select value={roleFilter} onChange={(event) => setRoleFilter(event.currentTarget.value)}>
          <option value="">{i18n.t('settlement.wages.allRoles')}</option>
          {roleOptions.map((role) => (
            <option key={role.id} value={role.id}>
              {roleText.name(role)}
            </option>
          ))}
        </Select>
      </Field>
      <SearchInput
        value={search}
        placeholder={i18n.t('settlement.wages.searchEmployees')}
        aria-label={i18n.t('settlement.wages.searchEmployees')}
        clearAriaLabel={i18n.t('common.clear')}
        onChange={(event) => setSearch(event.currentTarget.value)}
        onClear={() => setSearch('')}
      />

      {rosterQuery.isPending ? <PendingState query={rosterQuery} /> : null}
      {rosterQuery.isError ? (
        <Banner
          tone="danger"
          title={i18n.t('settlement.wages.rosterError')}
          action={
            <Button size="sm" variant="pearl" onClick={() => void rosterQuery.refetch()}>
              {i18n.t('settlement.action.refresh')}
            </Button>
          }
        />
      ) : null}
      {loaded && rosterSize === 0 ? (
        <EmptyState
          title={i18n.t('settlement.wages.rosterEmptyTitle')}
          description={i18n.t('settlement.wages.rosterEmptyBody')}
        />
      ) : null}
      {loaded && rosterSize > 0 && shown.length === 0 ? (
        <p className="rounded-[var(--r-utility)] bg-[var(--c-surface-2)] px-3 py-2 text-old-body-sm text-[var(--c-fg-muted)]">
          {i18n.t('settlement.wages.noEmployeeMatch')}
        </p>
      ) : null}
      {loaded && shown.length > 0 ? (
        <ul className="flex flex-col gap-2" role="list">
          {shown.map((employee) => (
            <li key={employee.memberId}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-[var(--r-utility)] bg-[var(--c-surface-2)] px-3 py-3 text-left ring-hairline transition-colors hover:bg-[var(--c-surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-ring)]"
                onClick={() => onPick(employee)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-old-body font-semibold text-[var(--c-fg)]">
                    {employee.displayName}
                  </span>
                  <span className="mt-0.5 block truncate text-old-label text-[var(--c-fg-muted)]">
                    {employee.roles.length > 0
                      ? employee.roles
                          .map((role) => roleText.name(role))
                          .join(i18n.t('common.listSeparator'))
                      : i18n.t('settlement.wages.noRole')}
                  </span>
                </span>
                <span className="shrink-0 text-old-label font-semibold text-[var(--c-action)]">
                  {i18n.t('settlement.wages.chooseEmployee')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
