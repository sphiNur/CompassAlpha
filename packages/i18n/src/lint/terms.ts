/**
 * The word lists and allow-lists of the catalog lint, under the section
 * numbers of rules.ts. Each entry is a decision: a banned word names the
 * word to use instead, and an allow-list entry says why the flagged text
 * is right as written. Add one only when it is.
 */
import { en } from '../catalogs/en';
import type { Lang } from './langs';

// ── 3. Developer vocabulary ─────────────────────────────────────────────

/**
 * The namespaces of permission keys (`delivery.confirm`): the catalog's
 * own permission groups, `permission.group.<prefix>`, which a web test
 * keeps in step with the seeded permissions. A new namespace is covered
 * without a list here; the old list missed attendance, delivery, dishes,
 * prices, org and system (review TEST4-09). `catalog` is kept from it.
 */
export const PERMISSION_NAMESPACES: readonly string[] = [
  ...Object.keys(en)
    .filter((key) => key.startsWith('permission.group.'))
    .map((key) => key.slice('permission.group.'.length)),
  'catalog',
];

export const DEV_TERMS: Array<{ pattern: RegExp; what: string }> = [
  // The role's display name (Super admin / Суперадмин / Superadmin) is fine;
  // the id and its hyphenated spellings are not.
  { pattern: /super_admin|super-admin|супер-админ|super-administrator/i, what: 'role id' },
  { pattern: /\boutbox\b/i, what: 'table name' },
  { pattern: /db:seed|pnpm |bun run/, what: 'developer command' },
  { pattern: /\bM\d+(?:\.\d+)*[a-z]?\b/, what: 'milestone name' },
  {
    pattern: new RegExp(`\\b(?:${PERMISSION_NAMESPACES.join('|')})s?\\.[a-z_]+\\b`),
    what: 'permission key',
  },
  // The buttons say Allow / Deny (Разрешить / Запретить …); lower-case
  // allow/deny is the stored override value.
  { pattern: /\b(?:allow|deny)\b/, what: 'override value' },
  { pattern: /\bMSA\b|\bslug\b|initData|VITE_/i, what: 'internal identifier' },
  { pattern: /\branks?\b|ранг/i, what: 'role rank (say level / уровень / 等级 / daraja)' },
  // R2-COPY-1 (2026-10-31): the words 11-文案 C8 still found after the
  // first pass. A recipe is a recipe, a date field is a date field.
  { pattern: /\bBOM\b|\bTSV\b|\bKPIs?\b/, what: 'technical abbreviation' },
  { pattern: /YYYY|ГГГГ/, what: 'date format mask' },
  { pattern: /onboarding|онбординг/i, what: 'internal flow name (say first sign-in)' },
  {
    pattern: /\bbindings?\b|绑定|store-scoped/i,
    what: 'role binding (say role assignment / per-store)',
  },
  // DX-COPY-26 (2026-11-01): the words 19-前端全面诊断/11 still found. A
  // kitchen worker has no server, a ru order is not a «сессия», and a
  // change kept on the phone is "waiting to send", not "to sync".
  { pattern: /привязк/i, what: 'role binding (say назначение)' },
  { pattern: /(?<!\p{L})[Сс]есси/u, what: 'session (say заказ / вход)' },
  { pattern: /\bservers?\b|сервер|服务器|服务端/i, what: 'server (say what happened to the user)' },
  { pattern: /\bsync(?:s|ed|ing)?\b|синхрон|sinxron|同步/i, what: 'sync (say send / 发送)' },
  // Review I18N1-06 (2026-11-10): the transaction words a member transfer
  // explained itself with, and zh's words for session, parameter and
  // cascade. ru «откатить» stays: undoing a purchase is a real action.
  { pattern: /会话/, what: 'session (say 登录)' },
  {
    pattern:
      /事务|原子|回滚|\btransactions?\b|\batomic|\brolls? back\b|\brolled back\b|транзакци|атомарн|tranzaksiya|atomar/i,
    what: 'transaction (say "in one step" / "nothing is changed")',
  },
  { pattern: /入参/, what: 'parameter (say 输入内容)' },
  { pattern: /级联|cascade|каскад|kaskad/i, what: 'cascade (say "deleted with it")' },
];

/** `lang key` prefixes whose screens only developers see. */
export const DEV_TERMS_ALLOW_PREFIX: Array<[string, string]> = [
  ['dev.', 'the local-development sign-in screen, never shown in production'],
];

// ── 4. Plurals ──────────────────────────────────────────────────────────

/**
 * Placeholders that carry text, money or a date — never a count.
 *
 * R2-COPY-1 (2026-10-31): this used to be the opposite, a fixed list of
 * count names, and every count it did not know slipped through: "{qty}
 * units" rendered "1 units", «{eff} действует» never agreed. Now every
 * placeholder is treated as a count unless it is named here, so a new
 * count is checked from the day it is added. Add a name only for a value
 * that is not a number of things.
 */
export const TEXT_VARS = new Set([
  // people and places
  'actor',
  'member',
  'name',
  'who',
  'prev',
  'store',
  'org',
  'role',
  'permission',
  'item',
  'sku',
  'label',
  'tab',
  'status',
  'object',
  'verb',
  'reason',
  'value',
  'slug',
  'locale',
  'language',
  'supplier',
  // money and amounts
  'amount',
  'money',
  'total',
  'currency',
  'price',
  'last',
  'next',
  // dates and times
  'date',
  'time',
  'when',
  'timezone',
  // bounds and positions, not counts: "{min} or more", "21–40 of 87"
  'min',
  'max',
  'from',
  'to',
]);

/**
 * Words that may follow a bare count without agreeing with it: unit
 * abbreviations, prepositions and (en) participles / adjectives, which do not
 * inflect. Anything else after `{n}` is a noun or a verb that has to agree,
 * so it belongs in a plural block.
 */
export const INVARIANT_AFTER_COUNT: Record<'en' | 'ru', RegExp> = {
  en: /^(?:of|min|m|h|d|n\/a|new|selected|skipped|left|more|already|still|bought|priced|unpriced|unknown|unavailable|from|so|effective|confirmed|or|is|and|to|in|for|by|K)$/,
  ru: /^(?:из|с|без|нет|старше|мин|м|ч|дн|дн\.|поз\.|ед\.|шт\.|куп\.|ост\.|тыс\.)$/,
};

/** `lang key` → why a count followed by a word is right as written. */
export const PLURAL_ALLOW: Record<string, string> = {
  'en order.batches.rejectedTitle': '{n} is the batch number, not a count',
  'ru order.batches.rejectedTitle': '{n} is the batch number, not a count',
};

/**
 * The CLDR categories each language's plural blocks must name. Exact `=N`
 * cases are extra. ru: 1/21 → one, 2–4 → few, 0/5–20 → many, 1.5 → other.
 */
export const REQUIRED_CATEGORIES: Record<Lang, string[]> = {
  en: ['one', 'other'],
  ru: ['one', 'few', 'many', 'other'],
  uz: ['other'],
  zh: ['other'],
};

// ── 7. Values left in English ───────────────────────────────────────────

/** `lang key` → why the value may equal the English one. */
export const SAME_AS_EN_ALLOW: Record<string, string> = {
  'zh settings.profile.username': 'brand name',
  'zh admin.workspace.telegram': 'brand name',
  'ru settings.profile.username': 'brand name',
  'ru admin.workspace.telegram': 'brand name',
  'uz settings.profile.username': 'brand name',
  'uz admin.workspace.telegram': 'brand name',
  'ru confirm.status.ok': '«OK» is the usual Russian status word',
  'uz unit.kg': 'unit symbol',
  'uz unit.ml': 'unit symbol',
  'uz nav.short.admin':
    '«Admin» is the usual Uzbek word too (adminlar); «Boshqaruv» does not fit the nav',
  'uz nav.admin': 'the same word as uz nav.short.admin, which the bottom bar shows',
};

// ── 8. Terminology (D15) ────────────────────────────────────────────────

/**
 * The owner's terminology decision D15 (2026-10-31), one word per concept:
 *
 *   concept           zh        en                   ru               uz
 *   order review      审核      review / approve     проверка /       tekshiruv /
 *                                                   одобрить         maʼqullash
 *   receiving         验收      receiving            приёмка          qabul
 *   confirm button    确认收货  Confirm receipt      Подтвердить      Qabulni
 *                                                   приёмку          tasdiqlash
 *   catalog item      商品      product              товар            mahsulot
 *   purchaser         采购员    purchaser            закупщик         xaridor
 *   daily close       日结      daily close          закрытие дня     kun yakuni
 *
 * Each entry is a word that names one of these concepts the other way.
 * Something outside the catalog is therefore not a 商品: it is 其他物品 /
 * 目录外物品 (full review 2026-11, I18N1-03).
 */
export const BANNED_TERMS: Record<Lang, Array<{ pattern: RegExp; use: string }>> = {
  zh: [
    { pattern: /审批/, use: '审核' },
    { pattern: /签收/, use: '验收 / 确认收货' },
    { pattern: /SKU/, use: '商品' },
    { pattern: /买手/, use: '采购员' },
    { pattern: /结算/, use: '日结 (or 计算 for run totals)' },
    { pattern: /其他商品|目录外商品/, use: '其他物品 / 目录外物品' },
  ],
  en: [
    { pattern: /\bSKUs?\b/, use: 'product' },
    { pattern: /\bbuyers?\b/i, use: 'purchaser' },
    { pattern: /\bapprovers?\b/i, use: 'reviewer' },
    { pattern: /\bsettlements?\b|re-settle/i, use: 'daily close' },
    { pattern: /\bsigned for\b/i, use: 'received' },
  ],
  ru: [
    { pattern: /SKU/, use: 'товар' },
    { pattern: /[Сс]огласов/, use: 'проверка / одобрить' },
    { pattern: /[Пп]окупател/, use: 'закупщик' },
    { pattern: /[Рр]асч[её]т/, use: 'закрытие дня / разбивка' },
    // Full review 2026-11 (I18N2-02): the manager has the role's name.
    { pattern: /[Рр]уководител|[Мм]енеджер/, use: 'управляющий (the role «Управляющий»)' },
  ],
  uz: [
    { pattern: /SKU/, use: 'mahsulot' },
    { pattern: /xaridchi/i, use: 'xaridor' },
    { pattern: /taʼminotchi/i, use: 'yetkazib beruvchi' },
    { pattern: /rahbar|menejer/i, use: 'boshqaruvchi (the role «Doʻkon boshqaruvchisi»)' },
  ],
};

// ── 10. Words the copy review took out (D23, 18-设计技能评审/03) ──────────

/**
 * 2026-10-31: decision D23 names the tenant 工作区 / workspace / рабочее
 * пространство / ish maydoni in every user-visible string, never 组织 /
 * organization. The copy review also replaced a metaphor the screen never
 * uses (收件箱 / inbox), the one 产品 left after D15, and words that only
 * make sense to whoever wrote the code: a run is not "frozen", an order
 * step is not a "step length", a permission is not "in the dictionary",
 * a run is not per "slot", and a review is not "claimed" and "released".
 * Placeholders ({org}) are code and are not checked.
 *
 * Full review 2026-11: a receipt is 收据 in zh, never 发票 (a tax invoice a
 * market stall cannot give), 票据, 小票 or 凭证 (I18N1-07); en spells
 * cancelled / cancelling one way (I18N1-05).
 */
export const COPY_BANNED: Record<Lang, Array<{ pattern: RegExp; use: string }>> = {
  zh: [
    { pattern: /组织/, use: '工作区 (D23)' },
    { pattern: /收件箱/, use: '待审核 / 等你审核的订单' },
    { pattern: /产品/, use: '商品 (D15)' },
    { pattern: /冻结/, use: '已经结束或取消，不能再改' },
    { pattern: /步长/, use: '每次加减' },
    { pattern: /字典/, use: 'say what is missing' },
    { pattern: /时段/, use: 'say what happened' },
    { pattern: /认领/, use: '我来审核 / 接手' },
    { pattern: /释放/, use: '放回' },
    { pattern: /后台自动/, use: '稍后会…' },
    { pattern: /发票|票据|小票|凭证/, use: '收据' },
  ],
  en: [
    { pattern: /\borgs?\b|organi[sz]ation/i, use: 'workspace (D23)' },
    { pattern: /\bcancel(?:ed|ing)\b/i, use: 'cancelled / cancelling' },
    { pattern: /\binbox\b/i, use: 'orders waiting for review' },
    { pattern: /\bfrozen\b/i, use: 'finished or cancelled' },
    { pattern: /\bslot\b/i, use: 'say what happened' },
    { pattern: /\bdictionary\b/i, use: 'say what is missing' },
    { pattern: /\bclaim(?:s|ed|er|ing)?\b/i, use: 'review / take over / put back' },
  ],
  ru: [
    { pattern: /организац/i, use: 'рабочее пространство (D23)' },
    { pattern: /входящ/i, use: 'заказы на проверку' },
    { pattern: /заморож/i, use: 'завершена или отменена' },
    { pattern: /справочник/i, use: 'say what is missing' },
    { pattern: /(?<!\p{L})слот/iu, use: 'say what happened' },
  ],
  uz: [
    { pattern: /tashkilot/i, use: 'ish maydoni (D23)' },
    { pattern: /kiruvchi/i, use: 'tekshiruvni kutayotgan buyurtmalar' },
    { pattern: /muzlat/i, use: 'yakunlangan yoki bekor qilingan' },
    { pattern: /lugʻat/i, use: 'say what is missing' },
  ],
};

// ── 12. ru gender shortcuts ─────────────────────────────────────────────

/**
 * Full review 2026-11 (I18N2-04): the masculine form written out is no
 * better than the «(а)» shortcut. A woman was marked «Не пришёл» on her
 * own attendance row and had to tap «Согласен». Copy about a person says
 * what happened, not who did it in the masculine: «Неявка», «Своя
 * отметка», «Даю согласие», «Понятно». Generic subjects stay («Кто
 * пришёл», «кто-то изменил», «Закупщик добавил»), so only the forms that
 * stand for a person are listed.
 */
export const RU_MASCULINE_PERSON =
  /(?<!\p{L})(?:не пришёл|ушёл на|отметился|согласен|согласился|пропустил|посмотрел|ошибся|нажал|никогда не входил|самому|самого себя)(?!\p{L})/iu;

/** `ru key` → why it may keep a masculine form for now. */
export const RU_MASCULINE_ALLOW: Record<string, string> = {
  'ru attendance.sheet.selfAt': 'I18N2-04 follow-up: changes after #253 merges',
  'ru attendance.consent.agree': 'I18N2-04 follow-up: changes after #260 merges',
  'ru attendance.flag.missedShift': 'I18N2-04 follow-up: changes after #260 merges',
  'ru attendance.export.flag.missedShift': 'I18N2-04 follow-up: changes after #260 merges',
};

// ── 13. Words that must not mean two things ─────────────────────────────

/**
 * I18N2-01 (review, 2026-11-09): "void" is one word in each language, used
 * by attendance and sales alike, and not the word for cancel or delete. A
 * void keeps the record with its reason; the attendance hint says it is
 * "never deleted". uz had «Bekor qilish» (cancel) in attendance and
 * «Oʻchirish» (delete) in sales; ru had «Отмена» in the stock history.
 */
export const VOID_WORD: Partial<Record<Lang, string>> = {
  ru: 'аннулир',
  uz: 'yaroqsiz',
  zh: '作废',
};

/**
 * DX-COPY-2 / DX-COPY-3 (2026-11-01): one translation for two different
 * actions. uz wrote «Bekor qilish» for cancel, void, undo and revoke, so the
 * void-sale sheet had two identical buttons; en / ru / uz named the
 * purchaser's "separate price" exactly like a "store expense". Each pair
 * below sits on the same screen and must read differently in every
 * language.
 */
export const MUST_DIFFER: Array<[string, string, string]> = [
  ['sales.void.confirmBtn', 'common.cancel', 'void-sale sheet'],
  ['sales.action.void', 'common.cancel', 'sales row'],
  // I18N2-01 (review, 2026-11-09): attendance came back with the same word
  // as cancel, and sales had moved to the word for delete.
  ['attendance.void.action', 'common.cancel', 'attendance review row'],
  ['attendance.void.confirm', 'common.cancel', 'void-clock-in sheet'],
  ['sales.action.void', 'common.delete', 'sales row'],
  ['run.action.undoPurchase', 'common.cancel', 'undo-purchase sheet'],
  ['approval.undo', 'common.cancel', 'approval undo toast'],
  ['approval.unapprove', 'common.cancel', 'reverse-approval sheet'],
  ['people.revokeInvite', 'common.cancel', 'invite row'],
  ['run.action.addItem.costModeSeparate', 'run.action.addExpense.scopeStore', 'add-item sheet'],
];

/**
 * Full review 2026-11 (I18N1-04, I18N1-05): zh used one word for two
 * things. A cancelled run was 作废 in its notification but 取消 on its
 * button, while 作废 is what voiding a sale or a clock-in says; the people
 * who added items to an order were 提交人, the word for the one person who
 * submitted it. A key whose English names the first may not use the word
 * for the second.
 */
export const ZH_KEEPS_APART: Array<{ english: RegExp; zh: RegExp; why: string }> = [
  { english: /\bcancel/i, zh: /作废/, why: '作废 is void; a cancel is 取消' },
  { english: /\bvoid/i, zh: /取消/, why: '取消 is cancel; a void is 作废' },
  { english: /\bcontributor/i, zh: /提交人/, why: '提交人 is the submitter; say 参与人' },
];
