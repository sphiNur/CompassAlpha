/**
 * Code-assembled copy (11-文案 round 2, 2026-10-31): dates, units, the
 * thousands suffix, role and permission names and the invite-error toast are
 * built in code, where the catalog lint cannot see them. These pin each one
 * to the real catalogs.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createI18n, loadCatalog } from '@compass/i18n';
import { makeDateFormatters } from '../dateFormat';
import { unitLabeller } from '../unitLabel';
import { BUILTIN_ROLE_DEFAULTS, roleLabeller } from '../roleLabels';
import { withoutFinalStop } from '../errorText';
import { formatMoneyThousands } from '../format';
import { BUILTIN_ROLES, PERMISSIONS } from '../../../../../packages/db/src/seed-data';

beforeAll(async () => {
  await Promise.all(['zh', 'ru', 'uz'].map((l) => loadCatalog(l as 'zh' | 'ru' | 'uz')));
});

describe('D16: business dates follow the UI language', () => {
  const now = () => new Date(2026, 9, 31, 12);

  test('this year: day and month only, no ISO', () => {
    expect(makeDateFormatters('en', now).calendarDay('2026-10-31')).toBe('Oct 31');
    expect(makeDateFormatters('zh', now).calendarDay('2026-10-31')).toBe('10月31日');
    expect(makeDateFormatters('ru', now).calendarDay('2026-10-31')).toMatch(/^31 окт/);
    expect(makeDateFormatters('uz', now).calendarDay('2026-10-31')).toMatch(/31.*okt/i);
  });

  test('another year keeps the year', () => {
    expect(makeDateFormatters('en', now).calendarDay('2025-12-31')).toBe('Dec 31, 2025');
    expect(makeDateFormatters('zh', now).calendarDay('2025-12-31')).toBe('2025年12月31日');
  });

  test('a stored date is a calendar day, not UTC midnight', () => {
    // new Date('2026-10-31') is the 30th anywhere west of Greenwich.
    expect(makeDateFormatters('en', now).calendarDay('2026-10-01')).toBe('Oct 1');
  });

  test('empty and broken input render nothing', () => {
    const f = makeDateFormatters('en', now);
    expect(f.calendarDay(null)).toBe('');
    expect(f.calendarDay('')).toBe('');
    expect(f.calendarDay('not a date')).toBe('');
  });
});

describe('R2-COPY-3 / R2-COPY-4: units', () => {
  test('a unit after a quantity agrees with it', () => {
    const ru = unitLabeller(createI18n('ru').t);
    expect(ru('pair', '10.000')).toBe('пар');
    expect(ru('pair', 2)).toBe('пары');
    expect(ru('pair', 21)).toBe('пара');
    expect(ru('roll', 5)).toBe('рулонов');
    expect(ru('pair', '1.5')).toBe('пары');
    const en = unitLabeller(createI18n('en').t);
    expect(en('pack', 2)).toBe('packs');
    expect(en('pack', 1)).toBe('pack');
  });

  test('without a quantity: the singular label the pickers show', () => {
    expect(unitLabeller(createI18n('ru').t)('pair')).toBe('пара');
    expect(unitLabeller(createI18n('zh').t)('pair')).toBe('副');
  });

  test('box has a label in every language; unknown units stay as typed', () => {
    expect(unitLabeller(createI18n('zh').t)('box', 3)).toBe('箱');
    expect(unitLabeller(createI18n('en').t)('box', 3)).toBe('boxes');
    expect(unitLabeller(createI18n('ru').t)('box', 3)).toBe('коробки');
    expect(unitLabeller(createI18n('uz').t)('box', 3)).toBe('quti');
    expect(unitLabeller(createI18n('zh').t)('karobka')).toBe('karobka');
  });
});

describe('RE-COPY-2: the thousands suffix comes from the catalog', () => {
  test('per language', () => {
    const k = (l: 'zh' | 'en' | 'ru' | 'uz') =>
      formatMoneyThousands('98000', createI18n(l).t('common.priceThousands', { n: '{n}' }));
    expect(k('en')).toBe('98K');
    expect(k('zh')).toBe('98千');
    expect(k('ru')).toBe('98 тыс.');
    expect(k('uz')).toBe('98 ming');
  });
});

describe('ADM-17 / RE-AUTH-2: built-in roles and permissions', () => {
  test('the defaults here are the seeded ones', () => {
    for (const role of BUILTIN_ROLES) {
      expect(BUILTIN_ROLE_DEFAULTS[role.slug]).toEqual({
        name: role.name,
        description: role.description,
      });
    }
    expect(Object.keys(BUILTIN_ROLE_DEFAULTS).sort()).toEqual(
      BUILTIN_ROLES.map((r) => r.slug).sort(),
    );
  });

  test('a seeded role reads in the UI language; a renamed one keeps its name', () => {
    const zh = roleLabeller(createI18n('zh').t);
    expect(zh.name({ slug: 'super_admin' })).not.toContain('super_admin');
    expect(zh.name({ slug: 'manager', name: 'Store Manager' })).toBe('店长');
    expect(zh.name({ slug: 'manager', name: '厨房主管' })).toBe('厨房主管');
    expect(zh.name({ slug: 'shift-lead', name: 'Shift lead' })).toBe('Shift lead');
    expect(
      zh.description({ slug: 'staff', description: BUILTIN_ROLE_DEFAULTS.staff!.description }),
    ).toBe('填写并提交每日订单；确认收货');
  });

  test('every seeded permission and its group has a catalog name', () => {
    for (const l of ['zh', 'en', 'ru', 'uz'] as const) {
      const r = roleLabeller(createI18n(l).t);
      for (const p of PERMISSIONS) {
        expect(r.permission(p.key, p.description)).not.toBe(p.key);
        const prefix = p.key.split('.')[0]!;
        expect(r.permissionGroup(prefix)).not.toBe(prefix);
      }
    }
    // A key the catalog does not know falls back to the stored text.
    expect(roleLabeller(createI18n('zh').t).permission('x.y', 'Do x')).toBe('Do x');
  });
});

describe('RE-AUTH-1: no doubled full stop', () => {
  test('the reason loses its own closing stop', () => {
    const reason = withoutFinalStop('邀请链接无效或已被删除。');
    expect(
      createI18n('zh').t('auth.invite.failedStillIn', { reason, org: 'Eden' }),
    ).not.toContain('。。');
    expect(withoutFinalStop('Invite not found.')).toBe('Invite not found');
    expect(withoutFinalStop('Is it?')).toBe('Is it?');
  });
});
