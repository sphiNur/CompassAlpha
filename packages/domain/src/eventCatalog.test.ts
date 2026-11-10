/**
 * Reviews RUNAPI-15 / ORD-08 (2026-11): docs/EVENT_CATALOG.md is the event
 * contract the Fine app reads, and it had fallen half a year behind (17 run
 * types and 2 order types missing). These lists are checked by the compiler
 * against the event unions, and the catalog's tables against the lists.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrderEventType } from './order/events';
import type { RunEvent } from './run/events';

const ORDER: Record<OrderEventType, true> = {
  DraftStarted: true,
  ItemAdjusted: true,
  ItemNoteSet: true,
  SessionNoteSet: true,
  SessionExtrasSet: true,
  ExtraStatusSet: true,
  Submitted: true,
  Claimed: true,
  ClaimReleased: true,
  Approved: true,
  Rejected: true,
  Withdrawn: true,
  Unapproved: true,
  AttachedToRun: true,
  EjectedFromRun: true,
  Archived: true,
};

const RUN: Record<RunEvent['type'], true> = {
  RunPlanned: true,
  PurchaseStarted: true,
  ItemPurchased: true,
  ItemUnavailable: true,
  DeliveryStarted: true,
  StoreDelivered: true,
  StoreItemConfirmed: true,
  StoreConfirmed: true,
  RunFinished: true,
  RunCancelled: true,
  RunReopened: true,
  RunDateChanged: true,
  RunRefinalized: true,
  PurchaseRevised: true,
  UnavailableUndone: true,
  TopUpDismissed: true,
  PurchaseUndone: true,
  StoreDeliveryUndone: true,
  PurchaseStartUndone: true,
  DeliveryStartUndone: true,
  SessionsAttachedToRun: true,
  SessionEjectedFromRun: true,
  PurchaserItemAdded: true,
  RunExpenseAdded: true,
  RunExpenseRemoved: true,
  RunClaimed: true,
  RunClaimReleased: true,
};

const CATALOG = readFileSync(join(import.meta.dir, '../../../docs/EVENT_CATALOG.md'), 'utf8');

/** The types in the table under "### `<stream>` stream", in order. */
function documented(stream: string): string[] {
  const section = CATALOG.split(/^### /m).find((s) => s.startsWith(`\`${stream}\` stream`));
  if (!section) throw new Error(`EVENT_CATALOG.md has no "${stream}" stream section`);
  return [...section.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]!);
}

describe('docs/EVENT_CATALOG.md', () => {
  test('lists every order event type once, and nothing else', () => {
    const types = documented('order');
    expect(types.length).toBe(new Set(types).size);
    expect([...types].sort()).toEqual(Object.keys(ORDER).sort());
  });

  test('lists every run event type once, and nothing else', () => {
    const types = documented('run');
    expect(types.length).toBe(new Set(types).size);
    expect([...types].sort()).toEqual(Object.keys(RUN).sort());
  });
});
