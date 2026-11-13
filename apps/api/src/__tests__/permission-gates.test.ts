/**
 * Read endpoints that must not be open to every signed-in member. Each
 * gate runs before any query, so no database is needed: without the
 * permission the call is refused, with it the call reaches `withOrg`.
 */
import { describe, expect, test } from 'bun:test';
import { gateCaller } from './helpers/ctx';

function callerWith(permissions: string[]) {
  return gateCaller({
    userId: '00000000-0000-4000-8000-000000000001',
    memberId: '00000000-0000-4000-8000-000000000002',
    orgId: '00000000-0000-4000-8000-000000000003',
    orgTimezone: 'UTC',
    permissions: new Set(permissions),
    roleSlugs: new Set(),
  });
}

describe('system.recentLogs', () => {
  test('is forbidden without system.logs.view', async () => {
    await expect(callerWith(['order.draft']).system.recentLogs({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test('reaches the handler with it', async () => {
    await expect(callerWith(['system.logs.view']).system.recentLogs({})).rejects.toThrow(
      'reached the handler',
    );
  });
});

const SOME_ID = '00000000-0000-4000-8000-000000000009';
type Caller = ReturnType<typeof callerWith>;

/** Review TEST1-12 (2026-11): the admin reads, each gated on
 *  `users.manage` (`requireAdmin`) before it touches the database. */
const ADMIN_READS: ReadonlyArray<[string, (c: Caller) => Promise<unknown>]> = [
  ['overview', (c) => c.admin.overview()],
  ['memberList', (c) => c.admin.memberList()],
  ['memberInviteList', (c) => c.admin.memberInviteList()],
  [
    'memberInvitePreview',
    (c) => c.admin.memberInvitePreview({ tgUserId: '123456789', storeIds: [SOME_ID] }),
  ],
  ['memberStoreAssignments', (c) => c.admin.memberStoreAssignments({ memberId: SOME_ID })],
  ['memberPermissionsList', (c) => c.admin.memberPermissionsList({ memberId: SOME_ID })],
  ['roleList', (c) => c.admin.roleList()],
  ['roleDetail', (c) => c.admin.roleDetail({ roleSlug: 'staff' })],
  ['permissionList', (c) => c.admin.permissionList()],
  ['storeList', (c) => c.admin.storeList()],
  ['categoryList', (c) => c.admin.categoryList()],
  ['skuList', (c) => c.admin.skuList()],
  ['supplierList', (c) => c.admin.supplierList()],
  ['expenseTemplateList', (c) => c.admin.expenseTemplateList()],
  ['recentEvents', (c) => c.admin.recentEvents()],
];

describe('admin reads need users.manage', () => {
  for (const [name, call] of ADMIN_READS) {
    test(`admin.${name}`, async () => {
      await expect(call(callerWith(['order.draft', 'order.approve']))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(call(callerWith(['users.manage']))).rejects.toThrow('reached the handler');
    });
  }
});

describe('admin.storeArchiveImpact', () => {
  const call = (c: Caller) => c.admin.storeArchiveImpact({ storeId: SOME_ID });

  test('needs org.admin, not just users.manage', async () => {
    await expect(call(callerWith(['users.manage']))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(call(callerWith(['org.admin']))).rejects.toThrow('reached the handler');
  });
});
