/**
 * S2 (2026-11-13): the stores the Admin home's Invite row can add someone
 * to, and the one it starts with. D6 offered the row only to a manager of
 * exactly one store; an owner went Stores › store › Invite.
 */
export interface InviteStore {
  id: string;
  name: string;
}

/**
 * `stores`: the stores the person may invite into (`adminStoreIds`), in
 * the session's order. `preselect`: the only one, or else the store in
 * the top bar when it is one of them; null when the person has to pick.
 */
export function inviteStoreChoice(
  sessionStores: readonly InviteStore[],
  adminStoreIds: ReadonlySet<string>,
  topBarStoreId: string | null,
): { stores: InviteStore[]; preselect: string | null } {
  const stores = sessionStores
    .filter((st) => adminStoreIds.has(st.id))
    .map((st) => ({ id: st.id, name: st.name }));
  if (stores.length === 1) return { stores, preselect: stores[0]!.id };
  const top = stores.find((st) => st.id === topBarStoreId);
  return { stores, preselect: top?.id ?? null };
}
