import { useMemo } from 'react';
import { useAuthStore } from '../../../stores/authStore';
import type { Actor, Binding, TargetMember } from '../../../lib/authority';

/**
 * CMP-ADM-1: the signed-in person as lib/authority needs them — their own
 * bindings come from their row in the member list (always included).
 * Without that row the ranks are unknown and every action stays shown
 * (the server decides, as before).
 */
export function useActor(
  members: ReadonlyArray<{ userId: string; roles: readonly Binding[] }> | undefined,
): Actor {
  const session = useAuthStore((s) => s.session);
  return useMemo(() => {
    const self = members?.find((m) => m.userId === session?.user.id);
    return {
      userId: session?.user.id ?? '',
      isOrgAdmin: session?.permissions.includes('org.admin') ?? false,
      adminStoreIds: session?.adminStoreIds ?? [],
      inactiveAdminStoreIds: session?.inactiveAdminStoreIds ?? [],
      bindings: self ? self.roles : [{ slug: '', scopeType: 'global', scopeId: null }],
      passesOnAnyKey:
        !!session?.isPlatformAdmin ||
        !!self?.roles.some((r) => r.slug === 'super_admin' && r.scopeType === 'global'),
    };
  }, [members, session]);
}

export function targetOf(m: {
  userId: string;
  roles: readonly Binding[];
  stores: ReadonlyArray<{ id: string }>;
  inactiveStores: ReadonlyArray<{ id: string }>;
  statusOutOfReach: boolean;
  nameShared: boolean;
}): TargetMember {
  return {
    userId: m.userId,
    bindings: m.roles,
    storeIds: [...m.stores, ...m.inactiveStores].map((st) => st.id),
    outOfReach: m.statusOutOfReach,
    nameShared: m.nameShared,
  };
}

export interface InviteDraft {
  tgUserId: string;
  displayName: string;
  roleSlug: string;
  /** At least one store must be picked unless the role is org-tier (rank
   *  ≥ ADMIN_RANK): its holder sees every store through `org.admin`. */
  storeIds: string[];
}
