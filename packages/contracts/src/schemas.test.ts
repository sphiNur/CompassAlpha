/**
 * Review TEST4-07 (2026-11): the input schemas had tests only for the
 * limits they share with the web. These pin the refusals: a value the
 * server must reject, with a catalog key the screen can show (a bare zod
 * sentence used to reach the form as "出错了").
 */
import { describe, expect, it } from 'bun:test';
import type { ZodTypeAny } from 'zod';
import {
  DateStringSchema,
  DecimalStringSchema,
  IdempotencyKeySchema,
  OrderQtySchema,
  PositiveDecimalStringSchema,
  RequestPresignInputSchema,
  TimeZoneSchema,
} from './schemas/common';
import { CreateMemberInviteInputSchema, InviteMemberByTgIdInputSchema } from './schemas/admin';
import {
  AcceptInviteInputSchema,
  CreateOrganizationInputSchema,
  SetLocaleInputSchema,
  SetSecondaryLocaleInputSchema,
  TelegramLoginInputSchema,
} from './schemas/auth';
import { CategoryCreateInputSchema } from './schemas/catalog';
import { SetSessionExtrasInputSchema } from './schemas/order';
import { PurchaseQtySchema } from './schemas/run';
import {
  SettlementMoneySchema,
  SettlementOperatingExpenseItemSchema,
  SettlementWageItemSchema,
  SignedSettlementMoneySchema,
} from './schemas/settlement';
import { SaleQtySchema, SaleVoidInputSchema } from './schemas/sales';
import { UPLOAD_MAX_BYTES } from './schemas/upload';
import { SALE_VOID_REASON_MAX, saleQtyProblem } from './limits';

function verdict(schema: ZodTypeAny, value: unknown): string {
  const r = schema.safeParse(value);
  return r.success ? 'ok' : (r.error.issues[0]?.message ?? '?');
}

function check(schema: ZodTypeAny, cases: Record<string, string>) {
  for (const [value, want] of Object.entries(cases)) {
    expect({ value, got: verdict(schema, value) }).toEqual({ value, got: want });
  }
}

describe('DateStringSchema', () => {
  it('takes a day that exists, between 1900 and 2999', () => {
    const bad = 'common.errors.invalidDate';
    check(DateStringSchema, {
      '2026-11-10': 'ok',
      '2024-02-29': 'ok',
      '2026-02-29': bad,
      '2026-02-31': bad,
      '2026-13-01': bad,
      '0000-01-01': bad,
      '1899-12-31': bad,
      '3000-01-01': bad,
      '2026-1-5': bad,
      ' 2026-01-05': bad,
      '2026-01-05T00:00:00Z': bad,
    });
  });
});

describe('decimal strings', () => {
  it('DecimalStringSchema: up to three decimals, a dot, an optional minus', () => {
    const bad = 'common.errors.invalidDecimal';
    check(DecimalStringSchema, {
      '0': 'ok',
      '-1.5': 'ok',
      '12.125': 'ok',
      '1.2345': bad,
      '1,5': bad,
      '.5': bad,
      '1.': bad,
      '': bad,
      '1e3': bad,
    });
  });

  it('PositiveDecimalStringSchema refuses zero and below', () => {
    const bad = 'common.errors.positiveDecimal';
    check(PositiveDecimalStringSchema, { '0.001': 'ok', '0': bad, '0.000': bad, '-1': bad });
  });

  it('OrderQtySchema caps the quantity either way', () => {
    check(OrderQtySchema, {
      '999999': 'ok',
      '-999999': 'ok',
      '1000000': 'order.errors.qtyTooLarge',
      '-1000000': 'order.errors.qtyTooLarge',
    });
  });

  it('PurchaseQtySchema: positive, nine digits, three decimals', () => {
    const bad = 'run.errors.qtyFormat';
    check(PurchaseQtySchema, {
      '1': 'ok',
      '999999999.999': 'ok',
      '0': bad,
      '1.2345': bad,
      '1234567890': bad,
      '-1': bad,
    });
  });
});

describe('daily-close money', () => {
  it('SettlementMoneySchema: two decimals, twelve digits, never negative', () => {
    const bad = 'settlement.errors.invalidMoney';
    check(SettlementMoneySchema, {
      '0': 'ok',
      '999999999999.99': 'ok',
      '1.005': bad,
      '1234567890123': bad,
      '-5.00': bad,
      '1,50': bad,
    });
  });

  it('SignedSettlementMoneySchema also takes a credit (negative)', () => {
    check(SignedSettlementMoneySchema, {
      '-5.00': 'ok',
      '-999999999999.99': 'ok',
      '--5': 'settlement.errors.invalidMoney',
    });
  });

  it('an expense line without a reason or a wage line without a name gets a catalog key (CONF-19)', () => {
    expect(verdict(SettlementOperatingExpenseItemSchema, { amount: '10.00', reason: '  ' })).toBe(
      'settlement.errors.invalidDetails',
    );
    const wage = { status: 'paid', amount: '10.00', reason: 'Shift' };
    // S4 (2026-11-13): a wage line's reason is optional; absent reads as ''.
    expect(verdict(SettlementWageItemSchema, { ...wage, reason: '' })).toBe('ok');
    expect(SettlementWageItemSchema.parse({ status: 'paid', amount: '10.00' }).reason).toBe('');
    expect(verdict(SettlementWageItemSchema, { ...wage, reason: 'x'.repeat(501) })).not.toBe('ok');
    expect(verdict(SettlementWageItemSchema, { ...wage, personName: ' ' })).toBe(
      'settlement.errors.employeeRequired',
    );
    expect(verdict(SettlementWageItemSchema, wage)).toBe('ok');
  });
});

describe('sales (CONF-10)', () => {
  it('SaleQtySchema: servings in hundredths, below a million', () => {
    check(SaleQtySchema, {
      '1': 'ok',
      '0.5': 'ok',
      '0.01': 'ok',
      '999999.99': 'ok',
      '0.001': 'sales.errors.qtyPrecision',
      '1.005': 'sales.errors.qtyPrecision',
      '1000000': 'sales.errors.qtyTooLarge',
      '0': 'common.errors.positiveDecimal',
      abc: 'common.errors.positiveDecimal',
    });
  });

  it('saleQtyProblem is the rule the panel asks before it sends', () => {
    expect(saleQtyProblem(' 2 ')).toBeNull();
    expect(saleQtyProblem('1.25')).toBeNull();
    expect(saleQtyProblem('')).toBe('notNumber');
    expect(saleQtyProblem('0')).toBe('notNumber');
    expect(saleQtyProblem('1,5')).toBe('notNumber');
    expect(saleQtyProblem('-1')).toBe('notNumber');
    expect(saleQtyProblem('1.255')).toBe('precision');
    expect(saleQtyProblem('0.004')).toBe('precision');
    expect(saleQtyProblem('1000000')).toBe('tooLarge');
  });

  it('a void needs a reason, at most SALE_VOID_REASON_MAX long', () => {
    const saleId = '00000000-0000-4000-8000-000000000001';
    expect(SaleVoidInputSchema.safeParse({ saleId, reason: '  ' }).success).toBe(false);
    expect(SaleVoidInputSchema.safeParse({ saleId, reason: 'Wrong dish' }).success).toBe(true);
    const longest = 'x'.repeat(SALE_VOID_REASON_MAX);
    expect(SaleVoidInputSchema.safeParse({ saleId, reason: longest }).success).toBe(true);
    expect(SaleVoidInputSchema.safeParse({ saleId, reason: longest + 'x' }).success).toBe(false);
  });
});

describe('TimeZoneSchema', () => {
  it('takes a zone the runtime knows, trimmed', () => {
    expect(TimeZoneSchema.parse(' Asia/Tashkent ')).toBe('Asia/Tashkent');
    check(TimeZoneSchema, {
      UTC: 'ok',
      'Mars/Olympus': 'admin.errors.timeZoneUnknown',
      '': 'admin.errors.timeZoneUnknown',
    });
  });
});

// Review ADM1-26 (2026-11-12): these refusals were English, which the app
// cannot show; a person got the screen's general failure sentence instead
// of the reason.
describe('identifiers and links', () => {
  it('a Telegram id is 4–15 digits, refused with the invite form’s key', () => {
    const tgUserId = (value: string) => verdict(InviteMemberByTgIdInputSchema, { tgUserId: value });
    expect(tgUserId('123456789')).toBe('ok');
    for (const bad of ['+998 90 123', '@someone', '123', '1234567890123456']) {
      expect({ bad, got: tgUserId(bad) }).toEqual({ bad, got: 'admin.errors.tgIdInvalid' });
    }
  });

  it('a category identifier is lowercase Latin letters, digits and hyphens', () => {
    const slug = (value: string) =>
      verdict(CategoryCreateInputSchema, { slug: value, names: { en: 'Greens' } });
    expect(slug('greens-2')).toBe('ok');
    for (const bad of ['Greens', 'leafy greens', 'зелень']) {
      expect({ bad, got: slug(bad) }).toEqual({ bad, got: 'admin.errors.categorySlugInvalid' });
    }
  });

  it('a cut or mistyped invite link reads as an invite that does not exist', () => {
    const token = (value: string) =>
      verdict(AcceptInviteInputSchema, { initData: 'x', token: value });
    expect(token('a'.repeat(20))).toBe('ok');
    for (const bad of [
      'a'.repeat(19),
      'a'.repeat(129),
      `${'a'.repeat(20)} `,
      `${'a'.repeat(20)}%`,
    ]) {
      expect({ bad, got: token(bad) }).toEqual({ bad, got: 'auth.errors.inviteNotFound' });
    }
  });

  it('a check only a faulty client can fail gives the generic key', () => {
    const generic = 'common.errors.validation';
    expect(verdict(SetSessionExtrasInputSchema, { extras: [] })).toBe(generic);
    check(IdempotencyKeySchema, { 'web:1234': 'ok', 'web:123': generic, 'web 1234': generic });
    expect(verdict(CreateOrganizationInputSchema, { name: 'Acme', slug: '-acme' })).toBe(generic);
  });

  // Review COREAPI-21: Telegram's sign-in data is refused by its length
  // before it is parsed and hashed.
  it('sign-in data longer than Telegram sends is refused unread', () => {
    const generic = 'common.errors.validation';
    const initData = (n: number) => 'x'.repeat(n);
    expect(verdict(TelegramLoginInputSchema, { initData: initData(8192) })).toBe('ok');
    expect(verdict(TelegramLoginInputSchema, { initData: initData(8193) })).toBe(generic);
    const token = 'a'.repeat(20);
    expect(verdict(AcceptInviteInputSchema, { initData: initData(8193), token })).toBe(generic);
  });
});

// Review ADM1-12 (2026-11-12): one plan decides an invite link and an
// invite by Telegram ID, and the second took any number of stores.
describe('invitations', () => {
  it('a link and an invite by Telegram ID take the same stores: at most 50', () => {
    const stores = (n: number) =>
      Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const kinds = [
      ['link', CreateMemberInviteInputSchema, {}],
      ['Telegram ID', InviteMemberByTgIdInputSchema, { tgUserId: '123456789' }],
    ] as const;
    for (const [kind, schema, rest] of kinds) {
      const takes = (n: number) => schema.safeParse({ ...rest, storeIds: stores(n) }).success;
      expect({ kind, 50: takes(50), 51: takes(51) }).toEqual({ kind, 50: true, 51: false });
    }
  });
});

// Review COREAPI-32 (2026-11-12): these inputs were written in their
// routers, and the photo size limit twice there.
describe('inputs from the routers', () => {
  it('a photo may be as large as upload.config says, and no larger', () => {
    const photo = (contentLength: number) =>
      RequestPresignInputSchema.safeParse({
        kind: 'receipt',
        contentType: 'image/jpeg',
        contentLength,
      }).success;
    expect({ at: photo(UPLOAD_MAX_BYTES), over: photo(UPLOAD_MAX_BYTES + 1) }).toEqual({
      at: true,
      over: false,
    });
  });

  it('a language is one of the four', () => {
    expect(SetLocaleInputSchema.safeParse({ locale: 'uz' }).success).toBe(true);
    expect(SetLocaleInputSchema.safeParse({ locale: 'de' }).success).toBe(false);
    expect(SetSecondaryLocaleInputSchema.safeParse({ secondaryLocale: null }).success).toBe(true);
  });
});
