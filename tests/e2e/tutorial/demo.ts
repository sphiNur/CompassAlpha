/**
 * The tutorial's demo workspace, in each interface language. Every name
 * here is made up (placeholder names of the kind each language uses for
 * "John Doe"); nothing comes from a customer's data.
 *
 * Product and category names come from the development seed
 * (@compass/db/seed-data), whose four languages are already reviewed;
 * the few it lacks are written here.
 */
import type { Locale } from '@compass/i18n';
import { DEV_CATEGORIES, DEV_SKUS, type SeedNames } from '@compass/db/seed-data';

export const LOCALES: readonly Locale[] = ['zh', 'ru', 'uz', 'en'];

export type Role = 'owner' | 'manager' | 'staff' | 'purchaser' | 'cashier' | 'clocker';

/** Telegram ids no real account uses (the e2e admin is 900000001). */
export const TG_IDS: Record<Role, string> = {
  owner: '910000001',
  manager: '910000002',
  staff: '910000003',
  purchaser: '910000004',
  cashier: '910000005',
  clocker: '910000006',
};

export const PEOPLE: Record<Locale, Record<Role, string>> = {
  en: {
    owner: 'Sam Rivers',
    manager: 'Mia Stone',
    staff: 'Leo Park',
    purchaser: 'Omar Hill',
    cashier: 'Ivy Lane',
    clocker: 'Noah Reed',
  },
  zh: {
    owner: '王五',
    manager: '李四',
    staff: '张三',
    purchaser: '赵六',
    cashier: '孙七',
    clocker: '周八',
  },
  ru: {
    owner: 'Иван Петров',
    manager: 'Мария Иванова',
    staff: 'Пётр Сидоров',
    purchaser: 'Олег Смирнов',
    cashier: 'Анна Кузнецова',
    clocker: 'Дмитрий Орлов',
  },
  uz: {
    owner: 'Aziz Karimov',
    manager: 'Dilnoza Rahimova',
    staff: 'Bekzod Tursunov',
    purchaser: 'Jasur Aliyev',
    cashier: 'Malika Yusupova',
    clocker: 'Sardor Qodirov',
  },
};

/** The person invited during the walk (owner setup and manager cards). */
export const INVITEE: Record<Locale, { owner: string; manager: string }> = {
  en: { owner: 'Ella Brook', manager: 'Max Field' },
  zh: { owner: '吴九', manager: '郑十' },
  ru: { owner: 'Елена Белова', manager: 'Максим Полев' },
  uz: { owner: 'Nodira Saidova', manager: 'Bobur Olimov' },
};
export const INVITEE_TG = { owner: '910000011', manager: '910000012' };

export const ORG_NAME: Record<Locale, string> = {
  en: 'Demo Kitchen',
  zh: '演示餐厅',
  ru: 'Демо-кухня',
  uz: 'Demo oshxona',
};

export const STORES: Record<Locale, { central: string; riverside: string; added: string }> = {
  en: { central: 'Central', riverside: 'Riverside', added: 'Airport' },
  zh: { central: '中心店', riverside: '河畔店', added: '机场店' },
  ru: { central: 'Центральный', riverside: 'Набережный', added: 'Аэропорт' },
  uz: { central: 'Markaziy', riverside: 'Daryo boʻyi', added: 'Aeroport' },
};

export const SUPPLIERS: Record<Locale, [string, string]> = {
  en: ['Green Market', 'Fresh Farm Co.'],
  zh: ['绿色市场', '新鲜农场'],
  ru: ['Зелёный рынок', 'Свежая ферма'],
  uz: ['Yashil bozor', 'Yangi ferma'],
};

export const EXPENSE_TEMPLATES: Record<Locale, [string, string]> = {
  en: ['Taxi to market', 'Gas cylinder'],
  zh: ['打车去市场', '煤气罐'],
  ru: ['Такси на рынок', 'Газовый баллон'],
  uz: ['Bozorga taksi', 'Gaz balloni'],
};

const CATEGORY_SLUGS = ['meat', 'vegetables', 'dairy'] as const;
const SKU_CODES = [
  'BEEF',
  'LAMB',
  'CHICKEN',
  'TOMATO',
  'CUCUMBER',
  'ONION',
  'POTATO',
  'MILK',
  'YOGURT',
  'BUTTER',
] as const;

/** Two more, so there are twelve. */
const EXTRA_SKUS = [
  {
    catSlug: 'vegetables',
    code: 'CARROT',
    names: { en: 'Carrot', zh: '胡萝卜', ru: 'Морковь', uz: 'Sabzi' },
    unit: 'kg',
    step: '0.5',
  },
  {
    catSlug: 'dairy',
    code: 'EGGS',
    names: { en: 'Eggs', zh: '鸡蛋', ru: 'Яйца', uz: 'Tuxum' },
    unit: 'pcs',
    step: '10',
  },
];

export const CATEGORIES = DEV_CATEGORIES.filter((c) =>
  (CATEGORY_SLUGS as readonly string[]).includes(c.slug),
);
export const SKUS: ReadonlyArray<{
  catSlug: string;
  code: string;
  names: SeedNames;
  unit: string;
  step: string;
}> = [...SKU_CODES.map((code) => DEV_SKUS.find((s) => s.code === code)!), ...EXTRA_SKUS];

/** The product the owner adds during the setup card (into Vegetables). */
export const NEW_PRODUCT: SeedNames = { en: 'Cabbage', zh: '卷心菜', ru: 'Капуста', uz: 'Karam' };

/** The name of a product in the walk's language. */
export const skuName = (code: string, lang: Locale): string =>
  SKUS.find((s) => s.code === code)!.names[lang];
