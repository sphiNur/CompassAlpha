/**
 * The run router: the market run from planning to delivery and close,
 * event-sourced like orders (load events, decide, append, project).
 * Creating a run gathers the day's approved order sessions into its
 * planned items and attaches each session (`AttachedToRun`), so the
 * orders move to `in_run`.
 *
 * Review RUNAPI-13 (2026-11-12): this was one file of 3,673 lines. Each
 * phase has its own file now and the router spreads them, so every path
 * stays `run.<name>`: the web, the Fine app, IDEMPOTENT_ROUTES and the
 * smokes did not change. command.ts holds the shared command pipeline and
 * scope.ts the store-scope checks.
 */
import { router } from '../../trpc';
import { closeProcedures } from './close';
import { deliveryProcedures } from './delivery';
import { historyProcedures } from './history';
import { planProcedures } from './plan';
import { previewProcedures } from './preview';
import { purchaseProcedures } from './purchase';
import { readProcedures } from './read';

export const runRouter = router({
  ...previewProcedures,
  ...planProcedures,
  ...readProcedures,
  ...historyProcedures,
  ...purchaseProcedures,
  ...deliveryProcedures,
  ...closeProcedures,
});
