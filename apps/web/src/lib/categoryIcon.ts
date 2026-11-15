/**
 * Which picture a product category gets (UI overhaul, 2026-11-15, owner:
 * category icons instead of product photos). Read from the category's
 * names in every language, so an admin's own "肉类", "Мясо" or "Go'sht"
 * all find the meat icon; anything unknown gets a plain box.
 */
export type CategoryIconKind =
  | 'meat'
  | 'fish'
  | 'vegetables'
  | 'fruit'
  | 'dairy'
  | 'eggs'
  | 'bakery'
  | 'grains'
  | 'drinks'
  | 'spices'
  | 'oil'
  | 'frozen'
  | 'tools'
  | 'cleaning'
  | 'linen'
  | 'packaging'
  | 'other';

/** Lower-case fragments per kind; the first kind with a match wins. */
const KEYWORDS: ReadonlyArray<readonly [CategoryIconKind, readonly string[]]> = [
  ['fish', ['fish', 'seafood', 'рыб', 'морепрод', 'baliq', '鱼', '海鲜', '水产']],
  ['meat', ['meat', 'beef', 'lamb', 'chicken', 'poultry', 'мяс', 'говяд', 'баран', 'курин', 'птиц', 'goʻsht', "go'sht", 'gosht', 'tovuq', '肉', '禽']],
  ['eggs', ['egg', 'яйц', 'tuxum', '蛋']],
  ['dairy', ['dairy', 'milk', 'cheese', 'молоч', 'молок', 'сыр', 'sut', 'pishloq', '乳', '奶']],
  ['vegetables', ['vegetable', 'greens', 'овощ', 'зелен', 'sabzavot', 'koʻkat', '蔬', '菜']],
  ['fruit', ['fruit', 'berr', 'фрукт', 'ягод', 'meva', '水果', '果']],
  ['bakery', ['bread', 'bakery', 'pastry', 'хлеб', 'выпеч', 'non', '面包', '烘焙']],
  ['grains', ['grain', 'rice', 'flour', 'pasta', 'noodle', 'круп', 'рис', 'мук', 'макарон', 'guruch', 'un ', '米', '面', '粮']],
  ['drinks', ['drink', 'beverage', 'juice', 'water', 'tea', 'coffee', 'напит', 'сок', 'вода', 'чай', 'кофе', 'ichimlik', 'choy', '饮', '茶', '水']],
  ['spices', ['spice', 'season', 'sauce', 'salt', 'sugar', 'специ', 'припра', 'соус', 'соль', 'сахар', 'ziravor', 'tuz', 'shakar', '调料', '香料', '酱', '盐', '糖']],
  ['oil', ['oil', 'масл', 'yogʻ', "yog'", '油']],
  ['frozen', ['frozen', 'заморож', 'muzlatil', '冷冻', '冻']],
  ['cleaning', ['clean', 'detergent', 'hygien', 'моющ', 'чист', 'гигиен', 'tozala', '清洁', '洗']],
  ['linen', ['linen', 'towel', 'textile', 'белье', 'бельё', 'полотен', 'текстил', 'choyshab', 'sochiq', '布草', '毛巾']],
  ['packaging', ['packag', 'disposable', 'container', 'упаков', 'одноразов', 'контейнер', 'qadoq', '包装', '一次性', '打包']],
  ['tools', ['tool', 'kitchen', 'utensil', 'equipment', 'инструм', 'кухон', 'посуд', 'инвентар', 'oshxona', 'jihoz', '工具', '厨具', '器具', '餐具']],
];

/** The kind for a category with these names (any languages, any may be blank). */
export function categoryIconKind(names: Readonly<Record<string, string | null | undefined>>): CategoryIconKind {
  const text = Object.values(names)
    .filter((n): n is string => !!n)
    .join(' ')
    .toLowerCase()
    .concat(' ');
  for (const [kind, words] of KEYWORDS) {
    if (words.some((w) => text.includes(w))) return kind;
  }
  return 'other';
}
