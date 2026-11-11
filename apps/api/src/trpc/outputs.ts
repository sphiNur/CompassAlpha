import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from './router';

/**
 * What each procedure returns, for code outside the API: the web's types
 * where inference does not reach, and the smokes that fake the API.
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;
