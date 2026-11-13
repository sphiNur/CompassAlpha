/**
 * The demo workspace, seeded through the api as its owner (global-setup
 * made the organisation and the owner with the CLI). The other people
 * get their roles with `compass user grant`, the way an operator adds
 * someone by Telegram id, and then sign in once to confirm their name and
 * language.
 */
import type { Browser } from '@playwright/test';
import type { Locale } from '@compass/i18n';
import postgres from 'postgres';
import { ATTENDANCE_FACE_CONSENT_VERSION } from '@compass/contracts/limits';
import { DATABASE_URL } from '../env';
import { pnpmAtRoot } from '../global-setup';
import {
  CATEGORIES,
  EXPENSE_TEMPLATES,
  PEOPLE,
  SKUS,
  STORES,
  SUPPLIERS,
  TG_IDS,
  type Role,
} from './demo';
import { ORG_SLUG } from './global-setup';
import { mutate, signIn, type Login } from './api';

export interface Demo {
  lang: Locale;
  stores: { central: string; riverside: string };
  logins: Record<Role, Login>;
}

/** Today in the organisation's zone (Asia/Tashkent). */
export function orgToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
}

export async function seedDemo(lang: Locale, browser: Browser): Promise<Demo> {
  const owner = await signIn(TG_IDS.owner, PEOPLE[lang].owner, lang);
  const t = owner.accessToken;

  const central = await mutate<{ id: string }>(t, 'admin.storeCreate', {
    name: STORES[lang].central,
    code: 'CENTRAL',
  });
  const riverside = await mutate<{ id: string }>(t, 'admin.storeCreate', {
    name: STORES[lang].riverside,
    code: 'RIVERSIDE',
  });

  const categoryIds = new Map<string, string>();
  for (const [i, c] of CATEGORIES.entries()) {
    const { id } = await mutate<{ id: string }>(t, 'admin.categoryCreate', {
      slug: c.slug,
      names: c.names,
      sortIndex: i * 10,
    });
    categoryIds.set(c.slug, id);
  }
  const skuIds = new Map<string, string>();
  for (const [i, sku] of SKUS.entries()) {
    const { id } = await mutate<{ id: string }>(t, 'admin.skuCreate', {
      categoryId: categoryIds.get(sku.catSlug),
      code: sku.code,
      names: sku.names,
      unit: sku.unit,
      step: sku.step,
      sortIndex: i * 10,
    });
    skuIds.set(sku.code, id);
  }
  for (const name of SUPPLIERS[lang]) await mutate(t, 'admin.supplierCreate', { name });
  const [taxi, gas] = EXPENSE_TEMPLATES[lang];
  await mutate(t, 'admin.expenseTemplateCreate', {
    label: taxi,
    defaultQty: '1',
    defaultUnitPrice: '30000',
    defaultPaymentMethod: 'cash',
    sortIndex: 0,
  });
  await mutate(t, 'admin.expenseTemplateCreate', {
    label: gas,
    defaultQty: '1',
    defaultUnitPrice: '120000',
    defaultPaymentMethod: 'cash',
    sortIndex: 10,
  });

  // One person per role, each at the store(s) they work in.
  const at: Record<Exclude<Role, 'owner'>, { role: string; stores: string[] }> = {
    manager: { role: 'manager', stores: [central.id] },
    staff: { role: 'staff', stores: [central.id] },
    purchaser: { role: 'purchaser', stores: [central.id, riverside.id] },
    cashier: { role: 'cashier', stores: [central.id] },
    clocker: { role: 'staff', stores: [central.id] },
  };
  for (const [who, { role, stores }] of Object.entries(at)) {
    for (const [i, storeId] of stores.entries()) {
      pnpmAtRoot([
        'compass',
        'user',
        'grant',
        TG_IDS[who as Role],
        '--role',
        role,
        '--org',
        ORG_SLUG,
        '--scope',
        'store',
        '--scope-id',
        storeId,
        ...(i === 0 ? ['--new-user'] : []),
      ]);
    }
  }
  const logins = { owner } as Record<Role, Login>;
  for (const who of Object.keys(at) as Role[]) {
    logins[who] = await signIn(TG_IDS[who], PEOPLE[lang][who], lang);
  }

  // The clocker clocks in at Central and has a daily wage (the daily
  // close fills it in); so does the staff member.
  await mutate(t, 'attendance.memberSet', {
    storeId: central.id,
    memberId: logins.clocker.session.member.memberId,
    enabled: true,
  });
  for (const who of ['clocker', 'staff'] as const) {
    await mutate(t, 'attendance.payRateSet', {
      storeId: central.id,
      memberId: logins[who].session.member.memberId,
      dailyWage: who === 'clocker' ? '150000' : '180000',
      effectiveFrom: orgToday(),
    });
  }

  // Enrolling a face starts with the person's consent; the enrollment
  // below skips the camera, so the consent is given here.
  await mutate(logins.clocker.accessToken, 'attendance.faceConsentGive', {
    version: ATTENDANCE_FACE_CONSENT_VERSION,
  });
  await seedLastPrices(owner.session.member.orgId, central.id, skuIds);
  await seedFaceEnrollment(browser, logins.clocker.session, central.id);
  return { lang, stores: { central: central.id, riverside: riverside.id }, logins };
}

/** What the products cost last time (UZS), as if bought on earlier runs. */
const LAST_PRICES: Record<string, string> = {
  BEEF: '95000',
  LAMB: '110000',
  CHICKEN: '38000',
  TOMATO: '12000',
  CUCUMBER: '9000',
  ONION: '5000',
  POTATO: '6000',
  CARROT: '6000',
  MILK: '14000',
  YOGURT: '18000',
  BUTTER: '90000',
  EGGS: '1500',
};

/**
 * Price history, so the purchaser's rows carry last time's price and the
 * one-tap ✓ works as it does after the first week. Written directly:
 * making it through the app would take a whole earlier run.
 */
async function seedLastPrices(
  orgId: string,
  storeId: string,
  skuIds: Map<string, string>,
): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('app.system_context', 'maintenance', true)`;
      for (const [code, price] of Object.entries(LAST_PRICES)) {
        await tx`insert into inventory.price_history
            (org_id, sku_id, store_id, unit_price, qty, observed_at)
            values (${orgId}, ${skuIds.get(code)!}, ${storeId}, ${price}, 1,
                    now() - interval '2 days')`;
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * A face enrollment waiting for the manager. A real one needs a camera
 * and a real face (the server checks each photo with its face model), so
 * this writes the row and its samples directly, with a drawn placeholder
 * instead of a photo and a made-up feature vector.
 */
async function seedFaceEnrollment(
  browser: Browser,
  clocker: Login['session'],
  storeId: string,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 240, height: 320 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const photo = async (turn: number): Promise<Buffer> => {
    await page.setContent(`<body style="margin:0">
      <svg width="240" height="320" viewBox="0 0 240 320" style="display:block;background:#cfd8dc">
        <g transform="translate(${turn * 18} 0)">
          <circle cx="120" cy="130" r="70" fill="#8d6e63"/>
          <rect x="45" y="215" width="150" height="120" rx="60" fill="#546e7a"/>
          <circle cx="${98 + turn * 6}" cy="120" r="7" fill="#263238"/>
          <circle cx="${142 + turn * 6}" cy="120" r="7" fill="#263238"/>
          <path d="M${100 + turn * 6} 160 q20 14 40 0" stroke="#263238" stroke-width="5" fill="none"/>
        </g>
      </svg></body>`);
    return page.locator('svg').screenshot({ type: 'jpeg', quality: 80 });
  };
  const poses: Array<[string, number]> = [
    ['front', 0],
    ['left', -1],
    ['right', 1],
    ['front2', 0],
  ];
  const images = new Map<string, Buffer>();
  for (const [pose, turn] of poses) images.set(pose, await photo(turn));
  await context.close();

  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('app.system_context', 'maintenance', true)`;
      const [row] = await tx`insert into inventory.attendance_face_enrollments
          (org_id, member_id, store_id) values (${clocker.member.orgId}, ${clocker.member.memberId}, ${storeId})
          returning id`;
      for (const [pose] of poses) {
        const feature = Array.from({ length: 128 }, (_, i) => Math.sin(i + pose.length) / 12);
        await tx`insert into inventory.attendance_face_samples
            (org_id, enrollment_id, pose, feature, bytes, real_score)
            values (${clocker.member.orgId}, ${row!.id}, ${pose}, ${feature}::real[], ${images.get(pose)!}, 0.99)`;
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
