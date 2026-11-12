/**
 * Review ORD-33 (2026-11): a reader without prices.view in a store sees no
 * money of it. The server hides money by field name (`withoutPrices`,
 * through `redactMoneyFor`), so an amount under a name the list does not
 * know would go out as it is. This keeps the order, approval and price
 * answers in step with that list:
 *
 *  - type-check fails when one of those answers gains a field that is
 *    neither money (MONEY_FIELDS in services/priceRedaction.ts, redacted)
 *    nor listed below as not money, and when an order procedure starts to
 *    answer with money without being one of those that pass their answer
 *    through `redactMoneyFor`;
 *  - the tests check that every money field is redacted, and that no
 *    field called not money here is named like money without a reason.
 *
 * A new field: if it holds an amount, add its name to MONEY_FIELDS (and
 * send the answer through redactMoneyFor); if not, add it to NOT_MONEY.
 */
import { describe, expect, test } from 'bun:test';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../trpc/router';
import {
  MONEY_FIELDS,
  PRICE_MAP_FIELDS,
  redactMoneyFor,
  withoutPrices,
  type MoneyField,
} from '../services/priceRedaction';

type Out = inferRouterOutputs<AppRouter>;

/** Every field name in `T`, at any depth (through arrays and objects). */
type KeysDeep<T> = T extends readonly (infer U)[]
  ? KeysDeep<U>
  : T extends object
    ? { [K in keyof T & string]: K | KeysDeep<T[K]> }[keyof T & string]
    : never;

type OrderAnswers = Out['order'];

/** The answers watched: every order and approval procedure, and the price reads. */
type WatchedField =
  | KeysDeep<OrderAnswers[keyof OrderAnswers]>
  | KeysDeep<Out['catalog']['skuPriceStats']>
  | KeysDeep<Out['run']['storeProgress']>;

/** Fields of those answers that hold no amount of money. */
const NOT_MONEY = [
  // Ids, names, codes, avatars.
  'id',
  'orgId',
  'storeId',
  'skuId',
  'runId',
  'sessionId',
  'name',
  'storeName',
  'storeCode',
  'initiatedByMemberId',
  'submittedByMemberId',
  'claimedByMemberId',
  'previousClaimerMemberId',
  'decidedByMemberId',
  'updatedByMemberId',
  'contributorMemberId',
  'contributorName',
  'claimedByDisplayName',
  'claimedByAvatarUrl',
  'previousClaimerDisplayName',
  'decidedByDisplayName',
  'attribDisplayName',
  'attribAvatarUrl',
  'recalledStoreIds',
  // Dates and versions.
  'orderDate',
  'claimedAt',
  'submittedAt',
  'decidedAt',
  'updatedAt',
  'deliveredAt',
  'confirmedAt',
  'lastObservedAt',
  'seq',
  'lastSeq',
  // States, texts, quantities and counts.
  'status',
  'applied',
  'note',
  'notes',
  'rejectReason',
  'unit',
  'qty',
  'totalQty',
  'totals',
  'items',
  'extras',
  'splits',
  'extrasJson',
  'totalsJson',
  'count',
  'itemCount',
  'extrasCount',
  'contributorCount',
  'batchNumber',
  'observations30d',
  'estimatedKnown',
  'estimatedUnknown',
  'usualPayment',
] as const satisfies readonly WatchedField[];
type NotMoney = (typeof NOT_MONEY)[number];

/**
 * Not money, though named like it, and why. Any other name in NOT_MONEY
 * that reads like an amount fails the test below.
 */
const NAMED_LIKE_MONEY: Partial<Record<NotMoney, string>> = {
  totals: "each product's total quantity",
  totalQty: 'a quantity',
  totalsJson: 'quantities by product',
  estimatedKnown: 'how many lines could be priced',
  estimatedUnknown: 'how many lines could not',
  usualPayment: "how a product was last paid ('cash' / 'transfer'), not how much",
};
const MONEY_LIKE =
  /price|total|amount|cost|cash|transfer|pay|paid|sum|budget|revenue|spend|fee|estimat/i;

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Compiles only when every field of the watched answers is classified; the
// error names a field that is not.
const unclassified: { [K in Exclude<WatchedField, MoneyField | NotMoney>]: K } = {};
// …and when NOT_MONEY names no field those answers no longer have.
const stale: { [K in Exclude<NotMoney, WatchedField>]: K } = {};

/**
 * The order procedures whose answer carries money. Each passes its answer
 * through redactMoneyFor (order.ts); one that starts to carry money fails
 * type-check until it does and is added here.
 */
type RedactedOrderAnswers = 'todayBatches' | 'pendingList';
type OrderAnswersWithMoney = {
  [P in keyof OrderAnswers]: [Extract<KeysDeep<OrderAnswers[P]>, MoneyField>] extends [never]
    ? never
    : P;
}[keyof OrderAnswers];
const redactedAnswers: Equal<OrderAnswersWithMoney, RedactedOrderAnswers> = true;

describe('money fields (ORD-33)', () => {
  test('the type-level checks above are part of this file', () => {
    expect([unclassified, stale, redactedAnswers]).toEqual([{}, {}, true]);
  });

  test('every money field is nulled and every price map emptied, at any depth', () => {
    const answer = Object.fromEntries(MONEY_FIELDS.map((f) => [f, '12.50']));
    const maps = Object.fromEntries(PRICE_MAP_FIELDS.map((f) => [f, { sku: '12.50' }]));
    const redacted = withoutPrices({ rows: [{ ...answer, ...maps, qty: '2' }], n: 3 });
    expect(redacted).toEqual({
      rows: [
        {
          ...Object.fromEntries(MONEY_FIELDS.map((f) => [f, null])),
          ...Object.fromEntries(PRICE_MAP_FIELDS.map((f) => [f, {}])),
          qty: '2',
        },
      ],
      n: 3,
    });
    // The redacted copy breaks its input's types on purpose (amounts to
    // null), so it is compared as unknown.
    const amount: unknown = withoutPrices({ estimatedTotal: 125 });
    expect(amount).toEqual({ estimatedTotal: null });
  });

  test('redactMoneyFor: money only with prices.view in every store of the answer', () => {
    const card = { storeId: 'a', itemCount: 2, estimatedTotal: '100.00', estimatedCash: '40.00' };
    const redact = (stores: string[] | null, of: string[]): unknown =>
      redactMoneyFor(stores, of, card);
    expect(redact(null, ['a'])).toBe(card);
    expect(redact(['a', 'b'], ['a'])).toBe(card);
    const hidden = { ...card, estimatedTotal: null, estimatedCash: null };
    expect(redact(['b'], ['a'])).toEqual(hidden);
    expect(redact([], ['a'])).toEqual(hidden);
    // An answer over two stores needs both.
    expect(redact(['a'], ['a', 'b'])).toEqual(hidden);
  });

  test('the lists do not contradict each other', () => {
    const money = new Set<string>([...MONEY_FIELDS, ...PRICE_MAP_FIELDS]);
    expect(NOT_MONEY.filter((f) => money.has(f))).toEqual([]);
    expect(new Set(NOT_MONEY).size).toBe(NOT_MONEY.length);
    expect(new Set(MONEY_FIELDS).size).toBe(MONEY_FIELDS.length);
  });

  test('a field called not money is not named like money, unless it says why', () => {
    const named = NOT_MONEY.filter((f) => MONEY_LIKE.test(f));
    expect(named.filter((f) => !NAMED_LIKE_MONEY[f])).toEqual([]);
    // Every reason is for a field that needs one.
    expect(Object.keys(NAMED_LIKE_MONEY).filter((f) => !MONEY_LIKE.test(f))).toEqual([]);
  });
});
