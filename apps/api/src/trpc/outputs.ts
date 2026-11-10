import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from './router';

/** What each procedure returns, for code outside the API that fakes it. */
export type RouterOutputs = inferRouterOutputs<AppRouter>;
