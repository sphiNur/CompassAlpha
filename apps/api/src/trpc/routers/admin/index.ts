/**
 * The admin router: people, roles, stores, the catalog, the audit and
 * maintenance, for the organisation's admins. Each procedure checks its
 * own permission (guards.ts) and works inside the caller's organisation
 * (RLS).
 *
 * Review ADM1-11 (2026-11-12): this was one file of 6,300 lines. Each
 * area has its own file now and the router spreads them, so every path
 * stays `admin.<name>`: the web, IDEMPOTENT_ROUTES and the smokes did
 * not change.
 */
import { router } from '../../trpc';
import { auditProcedures } from './audit';
import { catalogProcedures } from './catalog';
import { expenseTemplateProcedures } from './expenseTemplates';
import { inviteProcedures } from './invites';
import { maintenanceProcedures } from './maintenance';
import { memberStoreProcedures } from './memberStores';
import { memberProcedures } from './members';
import { overrideProcedures } from './overrides';
import { overviewProcedures } from './overview';
import { roleProcedures } from './roles';
import { storeProcedures } from './stores';

export const adminRouter = router({
  ...overviewProcedures,
  ...memberProcedures,
  ...inviteProcedures,
  ...memberStoreProcedures,
  ...roleProcedures,
  ...overrideProcedures,
  ...storeProcedures,
  ...catalogProcedures,
  ...expenseTemplateProcedures,
  ...auditProcedures,
  ...maintenanceProcedures,
});
