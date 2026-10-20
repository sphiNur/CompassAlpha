import { inSystem, type DB } from '@compass/db';

/**
 * Platform administrators are cross-tenant operators. This lookup must
 * run in a system context because, by definition, it happens before or
 * outside any one tenant's RLS scope.
 */
export function isPlatformAdmin(db: DB, userId: string): Promise<boolean> {
  return inSystem(db, 'auth', async (tx) => {
    const row = await tx.query.platformAdmins.findFirst({
      where: (p, { eq }) => eq(p.userId, userId),
      columns: { userId: true },
    });
    return !!row;
  });
}
