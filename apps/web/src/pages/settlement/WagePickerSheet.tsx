/**
 * Choosing the employee a wage line pays. Review CONF-06: moved out of
 * SettlementPage, with the role filter and search it owns. CONF-11: the
 * kit's picker rows, the employee already on the line checked; they were
 * grey buttons drawn here.
 */
import { useMemo, useState } from 'react';
import {
  Banner,
  Button,
  EmptyState,
  Field,
  PendingState,
  PickerGroup,
  PickerRow,
  SearchInput,
  Select,
  Sheet,
} from '@compass/ui';
import { trpc } from '../../lib/trpc';
import { matchesAnyString, normalizeQuery } from '../../lib/searchMatch';
import { useI18n, useRoleLabels } from '../../hooks/useI18n';

export interface WagePick {
  memberId: string;
  displayName: string;
  /** S4: their daily wage on the close's day; null when none is set. */
  dailyWage: string | null;
}

export function WagePickerSheet({
  storeId,
  date,
  lineId,
  chosenMemberId,
  onPick,
  onClose,
}: {
  storeId: string;
  /** The close's day, for the daily wage in effect then. */
  date: string;
  /** The wage line being filled in; `null` while the sheet is closed. */
  lineId: string | null;
  /** The employee the line already pays. */
  chosenMemberId: string | null;
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
      <WageRoster
        key={lineId ?? ''}
        storeId={storeId}
        date={date}
        open={lineId !== null}
        chosenMemberId={chosenMemberId}
        onPick={onPick}
      />
    </Sheet>
  );
}

function WageRoster({
  storeId,
  date,
  open,
  chosenMemberId,
  onPick,
}: {
  storeId: string;
  date: string;
  open: boolean;
  chosenMemberId: string | null;
  onPick: (employee: WagePick) => void;
}) {
  const i18n = useI18n();
  const roleText = useRoleLabels();
  const [roleFilter, setRoleFilter] = useState('');
  const [search, setSearch] = useState('');
  // The picker loads only on demand. This returns a minimum, store-scoped
  // roster rather than the admin directory, so cashiers never receive data
  // about staff in other stores.
  const rosterQuery = trpc.settlement.wageRoster.useQuery({ storeId, date }, { enabled: open });
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
    // The search every list uses (lib/searchMatch): case, Uzbek apostrophes
    // and word order do not matter.
    const tokens = normalizeQuery(search);
    return (roster ?? [])
      .filter((employee) => {
        if (roleFilter && !employee.roles.some((role) => role.id === roleFilter)) {
          return false;
        }
        return !tokens || matchesAnyString([employee.displayName], tokens);
      })
      .sort((left, right) => left.displayName.localeCompare(right.displayName, i18n.locale));
  }, [roleFilter, roster, search, i18n.locale]);
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
          compact
          title={i18n.t('settlement.wages.rosterEmptyTitle')}
          description={i18n.t('settlement.wages.rosterEmptyBody')}
        />
      ) : null}
      {loaded && rosterSize > 0 && shown.length === 0 ? (
        <EmptyState compact title={i18n.t('settlement.wages.noEmployeeMatch')} />
      ) : null}
      {loaded && shown.length > 0 ? (
        <PickerGroup label={i18n.t('settlement.wages.pickerTitle')}>
          {shown.map((employee) => (
            <PickerRow
              key={employee.memberId}
              label={employee.displayName}
              hint={
                employee.roles.length > 0
                  ? employee.roles
                      .map((role) => roleText.name(role))
                      .join(i18n.t('common.listSeparator'))
                  : i18n.t('settlement.wages.noRole')
              }
              selected={employee.memberId === chosenMemberId}
              onClick={() => onPick(employee)}
            />
          ))}
        </PickerGroup>
      ) : null}
    </div>
  );
}
