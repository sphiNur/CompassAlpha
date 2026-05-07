import { router } from './trpc';
import { adminRouter } from './routers/admin';
import { authRouter } from './routers/auth';
import { catalogRouter } from './routers/catalog';
import { orderRouter } from './routers/order';
import { runRouter } from './routers/run';
import { systemRouter } from './routers/system';
import { uploadRouter } from './routers/upload';

export const appRouter = router({
  admin: adminRouter,
  auth: authRouter,
  catalog: catalogRouter,
  order: orderRouter,
  run: runRouter,
  system: systemRouter,
  upload: uploadRouter,
});

export type AppRouter = typeof appRouter;
