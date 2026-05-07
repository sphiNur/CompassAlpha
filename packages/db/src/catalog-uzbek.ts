/**
 * Real-world product catalog for an Uzbek-market restaurant chain.
 *
 * Source: hand-curated by the operations owner on 2026-05-05 (~95% of
 * actual purchasing scope). Uzbek + Chinese names are owner-supplied;
 * English + Russian are translator-filled and need a manual pass — any
 * row marked with `// REVIEW` should be eyeballed by a native speaker
 * before going to production.
 *
 * Used by:
 *   - `seed.ts` for fresh dev databases
 *   - `scripts/import-catalog.ts` for one-shot production import
 *
 * Schema contract (matches `inventory.skus`):
 *   names:       jsonb { zh, en, ru, uz }
 *   aliases:     jsonb { zh: string[], ... } — search keywords (added 0006)
 *   description: jsonb { zh, ... }            — purchase notes (added 0006)
 *   unit:        kg | g | L | ml | pcs | pack | pair | bunch | roll
 *   step:        decimal — UX granularity (smallest +/- bump)
 *   sortIndex:   integer — within-category order (preserves owner's list)
 *
 * Codes: stable, uppercase-snake, never reused. Composed as
 *   {CATEGORY_PREFIX}_{SHORT_NAME}, e.g. PRD_PIYOZ, MEAT_QAZI.
 * Stable codes let us re-run the import without dupes and migrate
 * price-history when a SKU is renamed.
 *
 * Items the owner explicitly flagged as needing variant-splitting
 * (e.g. Mayiz "regular vs Osh") are split into separate SKUs so
 * price history doesn't get blended.
 */

export type CategorySlug =
  | 'produce'
  | 'meat'
  | 'dairy'
  | 'dry-goods'
  | 'bakery'
  | 'packaging'
  | 'cleaning';

export interface CatalogCategory {
  slug: CategorySlug;
  names: { zh: string; en: string; ru: string; uz: string };
  /** Lucide-react icon name; falls back to `Package` if unset. */
  icon?: string;
  sortIndex: number;
}

export interface CatalogSku {
  catSlug: CategorySlug;
  code: string;
  names: { zh: string; en: string; ru: string; uz: string };
  /** Optional search keywords by locale — multiple terms per language. */
  aliases?: { zh?: string[]; en?: string[]; ru?: string[]; uz?: string[] };
  /** Optional purchase notes (e.g. "按包,通常 10 支"). */
  description?: { zh?: string; en?: string; ru?: string; uz?: string };
  unit: 'kg' | 'g' | 'L' | 'ml' | 'pcs' | 'pack' | 'pair' | 'bunch' | 'roll';
  step: string;
  sortIndex: number;
}

export const CATEGORIES: CatalogCategory[] = [
  {
    slug: 'produce',
    names: { zh: '蔬菜水果', en: 'Produce', ru: 'Овощи и фрукты', uz: 'Sabzavot va meva' },
    icon: 'Carrot',
    sortIndex: 0,
  },
  {
    slug: 'meat',
    names: { zh: '肉类禽类', en: 'Meat & Poultry', ru: 'Мясо и птица', uz: "Go'sht va parranda" },
    icon: 'Beef',
    sortIndex: 10,
  },
  {
    slug: 'dairy',
    names: { zh: '乳制品奶酪', en: 'Dairy & Cheese', ru: 'Молочные и сыры', uz: 'Sutli va pishloq' },
    icon: 'Milk',
    sortIndex: 20,
  },
  {
    slug: 'dry-goods',
    names: {
      zh: '粮油调味干货',
      en: 'Grains, Oils & Seasoning',
      ru: 'Крупы, масла, специи',
      uz: 'Don, yog‘, ziravor',
    },
    icon: 'Wheat',
    sortIndex: 30,
  },
  {
    slug: 'bakery',
    names: { zh: '面点抹酱', en: 'Bakery & Spreads', ru: 'Хлеб и пасты', uz: 'Non va pastalar' },
    icon: 'Croissant',
    sortIndex: 40,
  },
  {
    slug: 'packaging',
    names: {
      zh: '包装消耗品',
      en: 'Packaging & Disposables',
      ru: 'Упаковка и расходники',
      uz: 'Qadoqlash va sarfli',
    },
    icon: 'Package',
    sortIndex: 50,
  },
  {
    slug: 'cleaning',
    names: { zh: '清洁洗涤', en: 'Cleaning Supplies', ru: 'Уборка и моющие', uz: 'Tozalash vositalari' },
    icon: 'SprayCan',
    sortIndex: 60,
  },
];

// ============================================================================
// SKUs — preserved in the owner's category-by-category order.
// Codes are stable forever; rename only via separate `code_rename` migrations.
// ============================================================================

let sortCursor = 0;
const sk = (s: Omit<CatalogSku, 'sortIndex'>): CatalogSku => {
  sortCursor += 10;
  return { ...s, sortIndex: sortCursor };
};

export const SKUS: CatalogSku[] = [
  // --- 1. Produce — vegetables ---
  sk({
    catSlug: 'produce', code: 'PRD_PIYOZ',
    names: { zh: '洋葱', en: 'Onion', ru: 'Лук', uz: 'Piyoz' },
    aliases: { zh: ['白洋葱'] },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_QIZIL_PIYOZ',
    names: { zh: '红洋葱', en: 'Red Onion', ru: 'Красный лук', uz: 'Qizil piyoz' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_KOK_PIYOZ',
    names: { zh: '小葱', en: 'Spring Onion', ru: 'Зелёный лук', uz: "Ko'k piyoz" },
    aliases: { zh: ['青葱', '细香葱'] },
    unit: 'bunch', step: '1',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_KARTOSHKA',
    names: { zh: '土豆', en: 'Potato', ru: 'Картофель', uz: 'Kartoshka' },
    aliases: { zh: ['马铃薯'] },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_SARIQ_SABZI',
    names: { zh: '黄萝卜', en: 'Yellow Carrot', ru: 'Жёлтая морковь', uz: 'Sariq sabzi' },
    description: { zh: '抓饭专用,比红萝卜甜' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_QIZIL_SABZI',
    names: { zh: '红萝卜', en: 'Red Carrot', ru: 'Красная морковь', uz: 'Qizil sabzi' },
    aliases: { zh: ['胡萝卜'] },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_TOGRALGAN_SARIQ_SABZI',
    names: {
      zh: '已切黄萝卜丝',
      en: 'Yellow Carrot, Shredded',
      ru: 'Жёлтая морковь, нашинкованная',
      uz: "To'g'ralgan sariq sabzi",
    },
    description: { zh: '抓饭备料,省切菜时间' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_TOGRALGAN_QIZIL_SABZI',
    names: {
      zh: '已切红萝卜丝',
      en: 'Red Carrot, Shredded',
      ru: 'Красная морковь, нашинкованная',
      uz: "To'g'ralgan qizil sabzi",
    },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_POMIDOR',
    names: { zh: '西红柿', en: 'Tomato', ru: 'Помидор', uz: 'Pomidor' },
    aliases: { zh: ['番茄'] },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_CHERRI',
    names: { zh: '圣女果', en: 'Cherry Tomato', ru: 'Черри', uz: 'Cherri' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_BODRING',
    names: { zh: '黄瓜', en: 'Cucumber', ru: 'Огурец', uz: 'Bodring' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_TUZLANGAN_BODRING',
    names: {
      zh: '腌黄瓜',
      en: 'Pickled Cucumber',
      ru: 'Солёный огурец',
      uz: 'Tuzlangan bodring',
    },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_QIZIL_BOLGARSKIY',
    names: {
      zh: '红色灯笼椒',
      en: 'Red Bell Pepper',
      ru: 'Красный болгарский перец',
      uz: 'Qizil bolgarskiy',
    },
    aliases: { zh: ['红甜椒'] },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_KOK_BOLGARSKIY',
    names: {
      zh: '绿色灯笼椒',
      en: 'Green Bell Pepper',
      ru: 'Зелёный болгарский перец',
      uz: "Ko'k bolgarskiy",
    },
    aliases: { zh: ['青椒', '绿甜椒'] },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_SARIQ_BOLGARSKIY',
    names: {
      zh: '黄色灯笼椒',
      en: 'Yellow Bell Pepper',
      ru: 'Жёлтый болгарский перец',
      uz: 'Sariq bolgarskiy',
    },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_DUNGANSKIY',
    names: {
      zh: '东干辣椒',
      en: 'Dungan Chili Pepper',
      ru: 'Дунганский острый перец',
      uz: 'Dunganskiy',
    },
    aliases: { zh: ['尖椒', '东干尖椒'] },
    description: { zh: '辣度比普通甜椒高,做凉菜或炒菜用' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_KARAM',
    names: { zh: '圆白菜', en: 'Cabbage', ru: 'Капуста', uz: 'Karam' },
    aliases: { zh: ['卷心菜', '包菜'] },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_QIZIL_KAROM',
    names: { zh: '紫甘蓝', en: 'Red Cabbage', ru: 'Краснокочанная капуста', uz: 'Qizil karom' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_BASAY',
    names: { zh: '大白菜', en: 'Napa Cabbage', ru: 'Пекинская капуста', uz: 'Basay' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_AYSBERG',
    names: { zh: '冰山生菜', en: 'Iceberg Lettuce', ru: 'Айсберг', uz: 'Aysberg' },
    aliases: { zh: ['球生菜'] },
    unit: 'pcs', step: '1',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_LATUK',
    names: { zh: '生菜', en: 'Lettuce', ru: 'Латук', uz: 'Latuk' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_LOLO_ROSO',
    names: { zh: '紫叶生菜', en: 'Lollo Rosso', ru: 'Лоло Россо', uz: 'Lolo roso' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_RUKOLA',
    names: { zh: '芝麻菜', en: 'Arugula', ru: 'Руккола', uz: 'Rukola' },
    unit: 'bunch', step: '1',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_KASHNICH',
    names: { zh: '香菜', en: 'Cilantro', ru: 'Кинза', uz: 'Kashnich' },
    aliases: { zh: ['芫荽'] },
    unit: 'bunch', step: '1',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_UKROP',
    names: { zh: '莳萝', en: 'Dill', ru: 'Укроп', uz: 'Ukrop' },
    unit: 'bunch', step: '1',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_PETRUSHKA',
    names: { zh: '欧芹', en: 'Parsley', ru: 'Петрушка', uz: 'Petrushka' },
    unit: 'bunch', step: '1',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_RAYXON',
    names: { zh: '罗勒', en: 'Basil', ru: 'Базилик', uz: 'Rayxon' },
    unit: 'bunch', step: '1',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_ROZMARIN',
    names: { zh: '迷迭香', en: 'Rosemary', ru: 'Розмарин', uz: 'Rozmarin' },
    unit: 'bunch', step: '1',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_ISMALOQ',
    names: { zh: '菠菜', en: 'Spinach', ru: 'Шпинат', uz: 'Ismaloq' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_CHESNOK',
    names: { zh: '大蒜', en: 'Garlic', ru: 'Чеснок', uz: 'Chesnok' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_IMBIR',
    names: { zh: '生姜', en: 'Ginger', ru: 'Имбирь', uz: 'Imbir' },
    aliases: { zh: ['姜'] },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_LAVLAGI',
    names: { zh: '甜菜根', en: 'Beetroot', ru: 'Свёкла', uz: 'Lavlagi' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_REDISKA',
    names: { zh: '小红萝卜', en: 'Radish', ru: 'Редис', uz: 'Rediska' },
    aliases: { zh: ['樱桃萝卜'] },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_SELDR',
    names: { zh: '芹菜', en: 'Celery', ru: 'Сельдерей', uz: 'Seldr' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_DAYKON',
    names: { zh: '白萝卜', en: 'Daikon Radish', ru: 'Дайкон', uz: 'Daykon' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_SHOLGOM',
    names: { zh: '芜菁', en: 'Turnip', ru: 'Репа', uz: "Sholg'om" },
    aliases: { zh: ['大头菜'] },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_BAKLAJAN',
    names: { zh: '茄子', en: 'Eggplant', ru: 'Баклажан', uz: 'Baklajan' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_KABACHKI',
    names: { zh: '西葫芦', en: 'Zucchini', ru: 'Кабачок', uz: 'Kabachki' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_GULKAROM',
    names: { zh: '花椰菜', en: 'Cauliflower', ru: 'Цветная капуста', uz: 'Gulkarom' },
    aliases: { zh: ['菜花'] },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_SHAMPINYON',
    names: { zh: '口蘑', en: 'Champignon Mushroom', ru: 'Шампиньоны', uz: 'Shanpinyon' },
    aliases: { zh: ['蘑菇', '白蘑菇'] },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_TOK_BARGI',
    names: { zh: '葡萄叶', en: 'Grape Leaves', ru: 'Виноградные листья', uz: 'Tok bargi' },
    description: { zh: '做 dolma 用' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_BROKOLI',
    names: { zh: '西兰花', en: 'Broccoli', ru: 'Брокколи', uz: 'Brokoli' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_ARALASH_TUZLAMA',
    names: {
      zh: '混合腌菜',
      en: 'Mixed Pickles',
      ru: 'Ассорти солений',
      uz: 'Aralash tuzlama',
    },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_MARKOFCHA',
    names: {
      zh: '韩式腌萝卜丝',
      en: 'Korean-Style Carrot Salad',
      ru: 'Морковь по-корейски',
      uz: 'Markofcha',
    },
    unit: 'kg', step: '0.5',
  }),
  // --- 1b. Produce — fruits ---
  sk({
    catSlug: 'produce', code: 'PRD_OLMA',
    names: { zh: '苹果', en: 'Apple', ru: 'Яблоко', uz: 'Olma' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_NOK',
    names: { zh: '梨', en: 'Pear', ru: 'Груша', uz: 'Nok' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_BANAN',
    names: { zh: '香蕉', en: 'Banana', ru: 'Банан', uz: 'Banan' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_LIMON',
    names: { zh: '柠檬', en: 'Lemon', ru: 'Лимон', uz: 'Limon' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_APELSIN',
    names: { zh: '橙子', en: 'Orange', ru: 'Апельсин', uz: 'Apelsin' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_KIVI',
    names: { zh: '猕猴桃', en: 'Kiwi', ru: 'Киви', uz: 'Kivi' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'produce', code: 'PRD_QULUPNAY',
    names: { zh: '草莓', en: 'Strawberry', ru: 'Клубника', uz: 'Qulupnay' },
    unit: 'kg', step: '0.25',
  }),

  // --- 2. Meat & Poultry ---
  sk({
    catSlug: 'meat', code: 'MEAT_MOL',
    names: { zh: '牛肉', en: 'Beef', ru: 'Говядина', uz: "Mol go'shti" },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_MOL_BOYIN',
    names: {
      zh: '牛颈肉',
      en: 'Beef Neck',
      ru: 'Говяжья шея',
      uz: "Mol bo'yin go'shti",
    },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_QOY_BOYIN',
    names: {
      zh: '羊颈肉',
      en: 'Lamb Neck',
      ru: 'Бараньи шея',
      uz: "Qo'y bo'yin go'shti",
    },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_QOY_LENTA',
    names: {
      zh: '羊排肉(含肉肋条)',
      en: 'Lamb Ribs',
      ru: 'Бараньи рёбра с мясом',
      uz: "Qo'y lenta",
    },
    description: { zh: '含肉肋条' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_MOL_RULET',
    names: { zh: '牛肉卷', en: 'Beef Rolls', ru: 'Говяжий рулет', uz: 'Mol rulet' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_QIMA',
    names: { zh: '肉馅', en: 'Ground Meat', ru: 'Фарш', uz: 'Qima' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_OT',
    names: { zh: '马肉', en: 'Horse Meat', ru: 'Конина', uz: "Ot go'shti" },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_QAZI',
    names: { zh: '马肉香肠', en: 'Qazi (Horse Sausage)', ru: 'Казы', uz: 'Qazi' },
    description: { zh: '传统乌兹别克熏马肉肠' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_BUTUN_TOVUQ',
    names: { zh: '整鸡', en: 'Whole Chicken', ru: 'Целая курица', uz: 'Butun tovuq' },
    unit: 'pcs', step: '1',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_TOVUQ_FILE',
    names: { zh: '鸡胸肉', en: 'Chicken Breast', ru: 'Куриное филе', uz: 'Tovuq file' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_TOVUQ_QANOT',
    names: { zh: '鸡翅', en: 'Chicken Wings', ru: 'Куриные крылья', uz: 'Tovuq qanot' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_TOVUQ_AYOQ',
    names: { zh: '鸡腿肉', en: 'Chicken Legs', ru: 'Куриные ножки', uz: 'Tovuq ayoq' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_INDEYKA',
    names: { zh: '火鸡肉', en: 'Turkey', ru: 'Индейка', uz: 'Indeyka' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_SUYAK',
    names: { zh: '骨头', en: 'Bones (for Stock)', ru: 'Кости на бульон', uz: 'Suyak' },
    description: { zh: '熬高汤用' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_DUMBA',
    names: { zh: '羊尾油', en: 'Lamb Tail Fat', ru: 'Курдюк', uz: 'Dumba' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_QOY_CHARVI',
    names: {
      zh: '羊网油',
      en: 'Lamb Caul Fat',
      ru: 'Бараний сальник',
      uz: 'Qoy charvi',
    },
    description: { zh: '内脏脂肪膜,做 dolma/烤包用' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_KOLBASA',
    names: { zh: '香肠(片装)', en: 'Sausage (Sliced)', ru: 'Колбаса (нарезка)', uz: 'Kolbasa' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_VARYONNIY',
    names: {
      zh: '煮熏香肠',
      en: 'Boiled-Smoked Sausage',
      ru: 'Варёно-копчёная колбаса',
      uz: 'Varyonniy',
    },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_KAPCHONNIY',
    names: {
      zh: '熏制香肠',
      en: 'Smoked Sausage',
      ru: 'Копчёная колбаса',
      uz: 'Kapchonniy',
    },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_SASISKA_PACK',
    names: {
      zh: '小香肠(按包)',
      en: 'Small Sausages (per Pack)',
      ru: 'Сосиски (упаковка)',
      uz: 'Sasiska (pochka)',
    },
    description: { zh: '按整包计算,通常一包 10 支' },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'meat', code: 'MEAT_SASISKA_KG',
    names: {
      zh: '小香肠(称重)',
      en: 'Small Sausages (by Weight)',
      ru: 'Сосиски (на вес)',
      uz: 'Sasiska (vazn)',
    },
    unit: 'kg', step: '0.5',
  }),

  // --- 3. Dairy & Cheese ---
  sk({
    catSlug: 'dairy', code: 'DAIRY_SUT',
    names: { zh: '牛奶', en: 'Milk', ru: 'Молоко', uz: 'Sut' },
    unit: 'L', step: '1',
  }),
  sk({
    catSlug: 'dairy', code: 'DAIRY_QATIQ',
    names: { zh: '酸奶', en: 'Yogurt (Qatiq)', ru: 'Катык', uz: 'Qatiq' },
    unit: 'L', step: '0.5',
  }),
  sk({
    catSlug: 'dairy', code: 'DAIRY_SUZMA',
    names: {
      zh: '过滤酸奶',
      en: 'Strained Yogurt (Suzma)',
      ru: 'Сузьма',
      uz: 'Suzma',
    },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'dairy', code: 'DAIRY_SLIVKA',
    names: { zh: '淡奶油', en: 'Cream', ru: 'Сливки', uz: 'Slivka' },
    unit: 'L', step: '0.5',
  }),
  sk({
    catSlug: 'dairy', code: 'DAIRY_QAYMOQ',
    names: {
      zh: '卡依马克(稀奶油)',
      en: 'Qaymoq (Clotted Cream)',
      ru: 'Каймак',
      uz: 'Qaymoq',
    },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'dairy', code: 'DAIRY_SARIYOG',
    names: { zh: '黄油', en: 'Butter', ru: 'Сливочное масло', uz: "Sariyog'" },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'dairy', code: 'DAIRY_KREM_CHIZ',
    names: { zh: '奶油芝士', en: 'Cream Cheese', ru: 'Крем-чиз', uz: 'Krem chiz' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'dairy', code: 'DAIRY_TVORIG',
    names: { zh: '奶渣', en: 'Tvorog (Curd Cheese)', ru: 'Творог', uz: 'Tvorig' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'dairy', code: 'DAIRY_SIR_PARMEZAN',
    names: { zh: '帕尔马奶酪', en: 'Parmesan', ru: 'Пармезан', uz: 'Sir parmezan' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'dairy', code: 'DAIRY_SIR_CHEDDAR',
    names: { zh: '切达奶酪', en: 'Cheddar', ru: 'Чеддер', uz: 'Sir cheddar' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'dairy', code: 'DAIRY_MOTSARELLA',
    names: { zh: '马苏里拉', en: 'Mozzarella', ru: 'Моцарелла', uz: 'Motsarella' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'dairy', code: 'DAIRY_FETAKSA',
    names: { zh: '菲达奶酪', en: 'Feta', ru: 'Фета', uz: 'Fetaksa' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'dairy', code: 'DAIRY_BRINZA',
    names: { zh: '布林扎奶酪', en: 'Brynza', ru: 'Брынза', uz: 'Brinza' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'dairy', code: 'DAIRY_CHIZBURGER_SIR',
    names: {
      zh: '汉堡芝士片',
      en: 'Burger Cheese Slices',
      ru: 'Сыр для бургера',
      uz: 'Chizburger sir',
    },
    unit: 'pack', step: '1',
  }),

  // --- 4. Dry Goods (grains, oils, seasoning) ---
  sk({
    catSlug: 'dry-goods', code: 'DRY_GURUCH',
    names: { zh: '大米', en: 'Rice', ru: 'Рис', uz: 'Guruch' },
    description: { zh: '常见品种 Ilxom / Alanga 等。生产建议拆分,价格差异大' },
    unit: 'kg', step: '5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_JAYDARI_UN',
    names: {
      zh: '农家面粉',
      en: 'Country Flour',
      ru: 'Деревенская мука',
      uz: 'Jaydari un',
    },
    unit: 'kg', step: '5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_JOXORI_UNI',
    names: { zh: '玉米面', en: 'Cornmeal', ru: 'Кукурузная мука', uz: 'Joxori uni' },
    unit: 'kg', step: '1',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_MAKRON',
    names: { zh: '意面', en: 'Pasta', ru: 'Макароны', uz: 'Makron' },
    unit: 'kg', step: '1',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_FETUCHINI',
    names: { zh: '宽面', en: 'Fettuccine', ru: 'Фетучини', uz: 'Fetuchini' },
    unit: 'kg', step: '1',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_ROLLTON',
    names: { zh: '方便面', en: 'Instant Noodles', ru: 'Доширак / Роллтон', uz: 'Rollton' },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_ZVYOZDOCHKA',
    names: { zh: '八角', en: 'Star Anise', ru: 'Бадьян', uz: 'Zvyozdochka' },
    unit: 'g', step: '50',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_SEDANA',
    names: {
      zh: '黑种草子',
      en: 'Nigella Seeds',
      ru: 'Чернушка (седана)',
      uz: 'Sedana',
    },
    aliases: { zh: ['黑芝麻调料'] },
    description: { zh: '撒在馕饼表面' },
    unit: 'g', step: '50',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_MOSH',
    names: { zh: '绿豆', en: 'Mung Beans', ru: 'Маш', uz: 'Mosh' },
    unit: 'kg', step: '1',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_CHECHEVITSA',
    names: { zh: '小扁豆', en: 'Lentils', ru: 'Чечевица', uz: 'Chechevitsa' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_NOXOT',
    names: { zh: '鹰嘴豆', en: 'Chickpeas', ru: 'Нут', uz: 'Noxot' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_GRECHKA',
    names: { zh: '荞麦', en: 'Buckwheat', ru: 'Гречка', uz: 'Grechka' },
    unit: 'kg', step: '1',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_MANNI_KASHA',
    names: { zh: '麦粉粥', en: 'Semolina', ru: 'Манная крупа', uz: 'Manni kasha' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_AFSALNI_KASHA',
    names: { zh: '燕麦片', en: 'Oatmeal', ru: 'Овсянка', uz: 'Afsalni kasha' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_PANKO',
    names: { zh: '面包糠', en: 'Panko Breadcrumbs', ru: 'Панировочные сухари', uz: 'Panko' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_SHAKAR',
    names: { zh: '白糖', en: 'Sugar', ru: 'Сахар', uz: 'Shakar' },
    unit: 'kg', step: '1',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_OQ_QAND',
    names: { zh: '方糖', en: 'Sugar Cubes', ru: 'Сахар-рафинад', uz: 'Oq qand' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_NOVOT',
    names: { zh: '结晶冰糖', en: 'Rock Sugar (Nabat)', ru: 'Набат', uz: 'Novot' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_ASAL',
    names: { zh: '蜂蜜', en: 'Honey', ru: 'Мёд', uz: 'Asal' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_TUZ',
    names: { zh: '食用盐', en: 'Salt', ru: 'Соль', uz: 'Tuz' },
    unit: 'kg', step: '1',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_DROJA',
    names: { zh: '酵母', en: 'Yeast', ru: 'Дрожжи', uz: 'Droja' },
    unit: 'g', step: '100',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_KRAXMAL',
    names: { zh: '淀粉', en: 'Starch', ru: 'Крахмал', uz: 'Kraxmal' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_KUNJUT',
    names: { zh: '芝麻', en: 'Sesame Seeds', ru: 'Кунжут', uz: 'Kunjut' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_YOG',
    names: { zh: '植物油', en: 'Vegetable Oil', ru: 'Растительное масло', uz: "Yog'" },
    unit: 'L', step: '1',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_ZAYTUN_YOGI',
    names: { zh: '橄榄油', en: 'Olive Oil', ru: 'Оливковое масло', uz: 'Zaytun yogi' },
    unit: 'L', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_ZIGIR_YOGI',
    names: { zh: '亚麻籽油', en: 'Linseed Oil', ru: 'Льняное масло', uz: "Zig'ir yog'i" },
    unit: 'L', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_MARGARIN',
    names: { zh: '人造奶油', en: 'Margarine', ru: 'Маргарин', uz: 'Margarin' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_SOYA_SOUSI',
    names: { zh: '酱油', en: 'Soy Sauce', ru: 'Соевый соус', uz: 'Soya sousi' },
    unit: 'L', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_TOMAT_PASTA',
    names: { zh: '番茄膏', en: 'Tomato Paste', ru: 'Томатная паста', uz: 'Tomat pasta' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_MAYONEZ',
    names: { zh: '蛋黄酱', en: 'Mayonnaise', ru: 'Майонез', uz: 'Mayonez' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_UKSUS_70',
    names: {
      zh: '70% 醋精',
      en: 'Vinegar Essence 70%',
      ru: 'Уксусная эссенция 70%',
      uz: 'Uksus 70%',
    },
    description: { zh: '使用前需稀释' },
    unit: 'L', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_SWEET_CHILI',
    names: {
      zh: '甜辣酱',
      en: 'Sweet Chili Sauce',
      ru: 'Сладкий чили соус',
      uz: 'Sweet chili',
    },
    unit: 'L', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_KISLO_SLADKIY',
    names: {
      zh: '酸甜酱',
      en: 'Sweet & Sour Sauce',
      ru: 'Кисло-сладкий соус',
      uz: 'Kislo sladkiy sous',
    },
    unit: 'L', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_NARSHARAB',
    names: {
      zh: '石榴汁酱',
      en: 'Narsharab (Pomegranate Sauce)',
      ru: 'Наршараб',
      uz: 'Narsharab',
    },
    unit: 'L', step: '0.25',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_ZIRA',
    names: { zh: '孜然', en: 'Cumin', ru: 'Зира', uz: 'Zira' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_MURUCH',
    names: { zh: '胡椒粉', en: 'Black Pepper Ground', ru: 'Молотый перец', uz: 'Muruch' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_KASHNICH_URUGI',
    names: {
      zh: '香菜籽',
      en: 'Coriander Seeds',
      ru: 'Семена кориандра',
      uz: "Kashnich urug'i",
    },
    unit: 'g', step: '100',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_ARPABODIYON',
    names: { zh: '茴香', en: 'Fennel', ru: 'Фенхель', uz: 'Arpabodiyon' },
    unit: 'g', step: '50',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_LAVR_BARGI',
    names: { zh: '月桂叶', en: 'Bay Leaves', ru: 'Лавровый лист', uz: 'Lavr bargi' },
    unit: 'g', step: '50',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_KORITSA',
    names: { zh: '肉桂', en: 'Cinnamon', ru: 'Корица', uz: 'Koritsa' },
    unit: 'g', step: '50',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_SUMOK',
    names: { zh: '漆树粉', en: 'Sumac', ru: 'Сумах', uz: 'Sumok' },
    unit: 'g', step: '100',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_KARKADE',
    names: { zh: '洛神花', en: 'Hibiscus (Karkade)', ru: 'Каркаде', uz: 'Karkade' },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_TURK_KOFESI',
    names: {
      zh: '土耳其咖啡',
      en: 'Turkish Coffee',
      ru: 'Турецкий кофе',
      uz: 'Turk kofesi',
    },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_TUNES_KANSERVA',
    names: {
      zh: '吞拿鱼罐头',
      en: 'Canned Tuna',
      ru: 'Тунец консервированный',
      uz: 'Tunes kanserva',
    },
    unit: 'pcs', step: '1',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_YONGOQ',
    names: { zh: '核桃', en: 'Walnuts', ru: 'Грецкие орехи', uz: "Yong'oq" },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_KEDROVIY_OREX',
    names: {
      zh: '松子仁',
      en: 'Pine Nuts',
      ru: 'Кедровые орехи',
      uz: 'Kedroviy orex',
    },
    unit: 'kg', step: '0.25',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_MAYIZ_REGULAR',
    names: {
      zh: '葡萄干(平常)',
      en: 'Raisins (Regular)',
      ru: 'Изюм (обычный)',
      uz: 'Mayiz',
    },
    description: { zh: '日常吃,装碟用' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'dry-goods', code: 'DRY_OSH_MAGIZI',
    names: {
      zh: '葡萄干(抓饭专用)',
      en: 'Raisins (for Plov)',
      ru: 'Изюм для плова',
      uz: 'Osh magizi',
    },
    description: { zh: '抓饭专用,质地不同于平常吃的' },
    unit: 'kg', step: '0.5',
  }),

  // --- 5. Bakery & Spreads ---
  sk({
    catSlug: 'bakery', code: 'BKRY_TANDIR_NON',
    names: { zh: '馕', en: 'Tandir Non (Uzbek Bread)', ru: 'Тандыр-нан', uz: 'Tandir non' },
    unit: 'pcs', step: '1',
  }),
  sk({
    catSlug: 'bakery', code: 'BKRY_BUXANKA',
    names: { zh: '砖块面包', en: 'Bukhanka (Brick Loaf)', ru: 'Буханка', uz: 'Buxanka' },
    unit: 'pcs', step: '1',
  }),
  sk({
    catSlug: 'bakery', code: 'BKRY_QORA_NON',
    names: { zh: '黑面包', en: 'Rye Bread', ru: 'Чёрный хлеб', uz: 'Qora non' },
    unit: 'pcs', step: '1',
  }),
  sk({
    catSlug: 'bakery', code: 'BKRY_TOSTER_NON',
    names: { zh: '吐司面包', en: 'Toast Bread', ru: 'Тостовый хлеб', uz: 'Toster non' },
    unit: 'pcs', step: '1',
  }),
  sk({
    catSlug: 'bakery', code: 'BKRY_LAGMON_XAMR',
    names: {
      zh: '拉面面团',
      en: 'Lagman Dough',
      ru: 'Тесто для лагмана',
      uz: "Lag'mon xamr",
    },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'bakery', code: 'BKRY_NORIN_XAMR',
    names: {
      zh: '那仁面皮',
      en: 'Norin Dough Sheets',
      ru: 'Тесто для норина',
      uz: 'Norin xamr',
    },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'bakery', code: 'BKRY_MAMPAR_XAMR',
    names: {
      zh: '曼帕尔面片',
      en: 'Mampar Dough Squares',
      ru: 'Тесто для мампара',
      uz: 'Mampar xamr',
    },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'bakery', code: 'BKRY_CHOCOCREAM',
    names: {
      zh: '巧克力酱',
      en: 'Chocolate Spread',
      ru: 'Шоколадная паста',
      uz: 'Chococream',
    },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'bakery', code: 'BKRY_JEM_LIMON',
    names: { zh: '柠檬果酱', en: 'Lemon Jam', ru: 'Лимонный джем', uz: 'Jem limon' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'bakery', code: 'BKRY_JEM_MALINA',
    names: { zh: '树莓果酱', en: 'Raspberry Jam', ru: 'Малиновый джем', uz: 'Jem malina' },
    unit: 'kg', step: '0.5',
  }),
  sk({
    catSlug: 'bakery', code: 'BKRY_VAFLI',
    names: { zh: '华夫饼', en: 'Waffles', ru: 'Вафли', uz: 'Vafli' },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'bakery', code: 'BKRY_QURT',
    names: { zh: '奶疙瘩', en: 'Qurt (Dried Cheese Balls)', ru: 'Курт', uz: 'Qurt' },
    unit: 'kg', step: '0.5',
  }),

  // --- 6. Packaging ---
  sk({
    catSlug: 'packaging', code: 'PKG_SABOY_KVADRAT',
    names: {
      zh: '外卖打包方盒',
      en: 'Takeaway Square Box',
      ru: 'Коробка квадратная (на вынос)',
      uz: 'Saboy idish (kvadrat)',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_SUPNI_SABOY',
    names: {
      zh: '外卖汤盒',
      en: 'Takeaway Soup Container',
      ru: 'Контейнер для супа',
      uz: 'Supni saboy idishi',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_MOROJNIY_POSUDA',
    names: {
      zh: '冰淇淋碗',
      en: 'Ice-Cream Bowl',
      ru: 'Пиала под мороженое',
      uz: 'Morojniy posuda',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_PITSA_KAROBKA',
    names: { zh: '比萨盒', en: 'Pizza Box', ru: 'Коробка для пиццы', uz: 'Pitsa karobka' },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_HAMBURGER_QOGOZ',
    names: {
      zh: '汉堡纸',
      en: 'Hamburger Wrap',
      ru: 'Бумага для бургера',
      uz: "Hamburger qog'oz",
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_LAVASH_QOGOZ',
    names: {
      zh: '拉瓦什卷饼包装纸',
      en: 'Lavash Wrap Paper',
      ru: 'Бумага для лаваша',
      uz: "Lavash qog'oz",
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_KOFE_STAKAN',
    names: {
      zh: '咖啡外带纸杯',
      en: 'Coffee Paper Cup',
      ru: 'Бумажный стакан для кофе',
      uz: 'Kofe stakan',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_TRUBOCHKA',
    names: { zh: '吸管', en: 'Drinking Straw', ru: 'Трубочки', uz: 'Trubochka' },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_SALFETKA',
    names: { zh: '普通餐巾纸', en: 'Napkins', ru: 'Салфетки', uz: 'Salfetka' },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_ZET_SALFETKA',
    names: {
      zh: 'Zet 牌餐巾纸',
      en: 'Zet-Brand Napkins',
      ru: 'Салфетки Zet',
      uz: 'Zet salfetka',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_SABOY_QOSHIQ',
    names: {
      zh: '外卖一次性勺子',
      en: 'Disposable Spoons',
      ru: 'Одноразовые ложки',
      uz: 'Saboy qoshiq',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_SABOY_VILKA',
    names: {
      zh: '外卖一次性叉子',
      en: 'Disposable Forks',
      ru: 'Одноразовые вилки',
      uz: 'Saboy vilka',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_SABOY_PAKET',
    names: {
      zh: '打包手提袋',
      en: 'Takeaway Bag',
      ru: 'Пакет на вынос',
      uz: 'Saboy paket',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_PITSA_PAKET',
    names: {
      zh: '比萨专用手提袋',
      en: 'Pizza Carry Bag',
      ru: 'Пакет для пиццы',
      uz: 'Pitsa saboy paket',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_CHEK_QOGOZ_KATTA',
    names: {
      zh: '收银纸(大)',
      en: 'Receipt Paper (Large)',
      ru: 'Чековая лента (большая)',
      uz: "Chek qog'oz kattasi",
    },
    unit: 'roll', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_CHEK_QOGOZ_KICHIK',
    names: {
      zh: '收银纸(小)',
      en: 'Receipt Paper (Small)',
      ru: 'Чековая лента (малая)',
      uz: "Chek qog'oz kichigi",
    },
    unit: 'roll', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_ZUBACHISTKA',
    names: { zh: '牙签', en: 'Toothpicks', ru: 'Зубочистки', uz: 'Zubachistka' },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_TUALETNAYA',
    names: {
      zh: '卫生纸',
      en: 'Toilet Paper',
      ru: 'Туалетная бумага',
      uz: 'Tualetnaya bumaga',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_MUSIR_KATTA',
    names: {
      zh: '垃圾袋(大)',
      en: 'Trash Bag (Large)',
      ru: 'Мусорный пакет (большой)',
      uz: 'Musir paket kattasi',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_MUSIR_KICHIK',
    names: {
      zh: '垃圾袋(小)',
      en: 'Trash Bag (Small)',
      ru: 'Мусорный пакет (малый)',
      uz: 'Musir paket kichigi',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_RULON_PAKET',
    names: {
      zh: '连卷保鲜袋',
      en: 'Roll Bag (Cling)',
      ru: 'Пакеты в рулоне',
      uz: 'Rulon paket',
    },
    unit: 'roll', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_PERGAMENT',
    names: {
      zh: '烘焙油纸',
      en: 'Parchment Paper',
      ru: 'Пергаментная бумага',
      uz: 'Pergament',
    },
    unit: 'roll', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_FOLGA',
    names: { zh: '锡纸', en: 'Aluminum Foil', ru: 'Фольга', uz: 'Folga' },
    unit: 'roll', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_SALAFAN_PERCHATKA',
    names: {
      zh: '一次性塑料手套',
      en: 'Plastic Gloves (Disposable)',
      ru: 'Одноразовые перчатки',
      uz: 'Salafan perchatka',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_SARIQ_PERCHATKA',
    names: {
      zh: '黄色乳胶手套',
      en: 'Yellow Latex Gloves',
      ru: 'Жёлтые латексные перчатки',
      uz: 'Sariq perchatka',
    },
    unit: 'pair', step: '1',
  }),
  sk({
    catSlug: 'packaging', code: 'PKG_QORA_PERCHATKA',
    names: {
      zh: '黑色丁腈手套',
      en: 'Black Nitrile Gloves',
      ru: 'Чёрные нитриловые перчатки',
      uz: 'Qora perchatka',
    },
    unit: 'pack', step: '1',
  }),

  // --- 7. Cleaning ---
  sk({
    catSlug: 'cleaning', code: 'CLN_DELFIN_LATTA',
    names: {
      zh: 'Delfin 牌抹布',
      en: 'Delfin-Brand Cleaning Cloth',
      ru: 'Тряпка Delfin',
      uz: 'Delfin latta',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'cleaning', code: 'CLN_RANGLI_LATTA',
    names: {
      zh: '彩色通用抹布',
      en: 'Color-Coded Cleaning Cloth',
      ru: 'Цветная универсальная тряпка',
      uz: 'Rangli latta',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'cleaning', code: 'CLN_POL_LATTA',
    names: { zh: '地板抹布', en: 'Floor Cloth', ru: 'Тряпка для пола', uz: 'Pol latta' },
    unit: 'pcs', step: '1',
  }),
  sk({
    catSlug: 'cleaning', code: 'CLN_GUPKA',
    names: { zh: '海绵擦', en: 'Sponge', ru: 'Губка', uz: 'Gupka' },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'cleaning', code: 'CLN_SIM_CHOTKA',
    names: { zh: '钢丝球', en: 'Steel Wool Pad', ru: 'Металлическая мочалка', uz: 'Sim chotka' },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'cleaning', code: 'CLN_SHVABIRA',
    names: { zh: '拖把', en: 'Mop', ru: 'Швабра', uz: 'Shvabira' },
    unit: 'pcs', step: '1',
  }),
  sk({
    catSlug: 'cleaning', code: 'CLN_SUPIRGI_XOKONDOZ',
    names: {
      zh: '扫帚簸箕套装',
      en: 'Broom & Dustpan Set',
      ru: 'Веник с совком',
      uz: 'Supirgi xokondoz',
    },
    unit: 'pack', step: '1',
  }),
  sk({
    catSlug: 'cleaning', code: 'CLN_SHPATIL',
    names: { zh: '刮刀', en: 'Putty Knife / Scraper', ru: 'Шпатель', uz: 'Shpatil' },
    unit: 'pcs', step: '1',
  }),
  sk({
    catSlug: 'cleaning', code: 'CLN_SITA',
    names: { zh: '筛子', en: 'Sieve', ru: 'Сито', uz: 'Sita' },
    unit: 'pcs', step: '1',
  }),
  sk({
    catSlug: 'cleaning', code: 'CLN_DOMESTOS',
    names: {
      zh: '洁厕灵',
      en: 'Toilet Cleaner (Domestos)',
      ru: 'Доместос',
      uz: 'Domestos',
    },
    unit: 'L', step: '0.5',
  }),
  sk({
    catSlug: 'cleaning', code: 'CLN_AZELIT',
    names: {
      zh: '强力去油剂',
      en: 'Heavy-Duty Degreaser (Azelit)',
      ru: 'Азелит',
      uz: 'Azelit',
    },
    unit: 'L', step: '0.5',
  }),
  sk({
    catSlug: 'cleaning', code: 'CLN_POSUDA_GEL',
    names: {
      zh: '洗洁精',
      en: 'Dish Soap',
      ru: 'Гель для посуды',
      uz: 'Posuda gel',
    },
    unit: 'L', step: '0.5',
  }),
  sk({
    catSlug: 'cleaning', code: 'CLN_OTBELIVAYUSHIY',
    names: {
      zh: '漂白剂',
      en: 'Bleach',
      ru: 'Отбеливатель',
      uz: 'Otbelivayushiy sredstva',
    },
    unit: 'L', step: '0.5',
  }),
  sk({
    catSlug: 'cleaning', code: 'CLN_OSVEJITEL',
    names: {
      zh: '空气清新剂',
      en: 'Air Freshener',
      ru: 'Освежитель воздуха',
      uz: 'Osvejitel vozdux',
    },
    unit: 'pcs', step: '1',
  }),
  sk({
    catSlug: 'cleaning', code: 'CLN_PUL_RESINKA',
    names: {
      zh: '扎钞橡皮筋',
      en: 'Rubber Bands (for Cash)',
      ru: 'Резинки для денег',
      uz: 'Pul resinka',
    },
    unit: 'pack', step: '1',
  }),
];

/** Total: 7 categories, 165 SKUs (as of 2026-05-05). */
export const CATALOG_VERSION = '2026-05-05';
