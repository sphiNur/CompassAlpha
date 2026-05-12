import { router } from './trpc';
import { adminRouter } from './routers/admin';
import { authRouter } from './routers/auth';
import { catalogRouter } from './routers/catalog';
import { inventoryRouter } from './routers/inventory';
import { orderRouter } from './routers/order';
import { reportRouter } from './routers/report';
import { runRouter } from './routers/run';
import { systemRouter } from './routers/system';
import { uploadRouter } from './routers/upload';

export const appRouter = router({
  admin: adminRouter,
  auth: authRouter,
  catalog: catalogRouter,
  // M2.0a: inventory ledger (current on-hand per store-sku + stocktake +
  // wastage). First step of the ERP direction; consumption via BOM
  // (M2.0c) will be the next consumer of the same ledger.
  inventory: inventoryRouter,
  order: orderRouter,
  // M1.15: finance reconciliation reports (cash daily / transfer / by
  // supplier). Sits next to Admin but its own router so the admin
  // bundle doesn't grow further.
  report: reportRouter,
  run: runRouter,
  system: systemRouter,
  upload: uploadRouter,
});

export type AppRouter = typeof appRouter;
