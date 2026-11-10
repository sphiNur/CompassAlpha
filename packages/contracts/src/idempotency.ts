/**
 * The procedures that take an idempotency key (`X-Idempotency-Key`).
 *
 * The API declares each with `idempotentMutation` (apps/api/src/trpc),
 * which caches the response for 24 h keyed on (key, route, user) and
 * answers a repeat from the cache. The middleware does nothing without
 * a key, and the web client sends one only for the routes listed here,
 * so a route missing from this list was not deduplicated at all.
 *
 * Review TEST3-06 (2026-11-10): the list is kept once, here. The web
 * client builds IDEMPOTENT_MUTATIONS from it (apps/web/src/lib/trpc.ts),
 * and apps/api/src/trpc/__tests__/idempotentRoutes.test.ts fails when
 * the routers declare `idempotentMutation` on any other set. A web test
 * used to read the API's router files as text to compare the two.
 *
 * Zod-free, so the web may import it as a value.
 */
export const IDEMPOTENT_ROUTES = [
  'run.create',
  'run.purchaseItem',
  'run.revisePurchase',
  'run.finish',
  'sales.record',
  'settlement.save',
  'order.submit',
  // 2026-07-26: all three are already declared `idempotentMutation`
  // server-side, but the middleware short-circuits on "no key = no
  // dedupe" — with the client never sending the header, the cache was
  // dead code for them.
  //
  // Membership here alone only buys the authFetch 401-refresh retry
  // (that path re-issues the SAME init, so the key survives). Surviving
  // a LOST RESPONSE additionally needs a stable key threaded through
  // op.context, which addPurchaserItem / addExpense now do (RunPage's
  // addItemIdemCtx / addExpenseIdemCtx + the outbox replay). Without
  // that, the web client's `genKey()` mints a fresh key per attempt and
  // the replay never matches.
  //
  // attachSessions has no offline-replay path, so the 401 retry is the
  // whole of its benefit — which is still worth having, since a double
  // attach would pull other stores' orders into a run twice.
  'run.addPurchaserItem',
  // 2026-10-21 audit CA-54: declared idempotentMutation server-side;
  // StoreInventoryTab threads a stable key per wastage entry.
  'inventory.recordWastage',
  // DX-INV-2 (2026-11-01): stocktake too; one stable key per count.
  'inventory.stocktake',
  'run.addExpense',
  'run.attachSessions',
  // BUY-9 (2026-10-30): declared idempotentMutation and given a stable
  // key by RunPage since #91, but never listed here, so the header was
  // never sent and a replay after a lost response raised a false
  // "please review" warning.
  'run.markUnavailable',
  'run.deliverToStore',
  // 2026-11-05 attendance: all declared idempotentMutation server-side.
  'attendance.punch',
  'attendance.shiftSave',
  'attendance.shiftDelete',
  'attendance.copyWeek',
  'attendance.manualPunch',
  'attendance.voidPunch',
  // 2026-11-07: "not them" on the phone that clocked a colleague.
  'attendance.punchUndo',
  'attendance.memberSet',
  'attendance.resetDevice',
  'attendance.policySave',
  'attendance.overtimeDecide',
  'attendance.payRateSet',
  'attendance.faceEnroll',
  'attendance.faceEnrollDecide',
  'attendance.faceEnrollReset',
  'attendance.faceConsentGive',
  'attendance.faceConsentWithdraw',
  'attendance.reviewPunch',
] as const;

export type IdempotentRoute = (typeof IDEMPOTENT_ROUTES)[number];
