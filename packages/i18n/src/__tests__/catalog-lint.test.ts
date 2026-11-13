/**
 * Catalog lint: runs every rule in ../lint/rules.ts on the four catalogs
 * (the CI gate), then feeds each rule a small hand-made catalog with the
 * mistake it exists for, so a rule that silently stops matching fails too.
 * Why each rule exists is in the header of rules.ts; the word lists and
 * allow-lists are in ../lint/terms.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { en } from '../catalogs/en';
import { ru } from '../catalogs/ru';
import { uz } from '../catalogs/uz';
import { zh } from '../catalogs/zh';
import { LANGUAGE_NATIVE_NAMES } from '../index';
import { LANGS, type Catalogs, type Lang } from '../lint/langs';
import {
  approveIsNotConfirm,
  chinesePunctuation,
  chineseWordsKeepApart,
  copyBanned,
  countsOutsidePlural,
  devTerms,
  distinctActions,
  englishApostrophes,
  htmlEntities,
  keyParity,
  mojibakeAndIsoDates,
  placeholderMismatches,
  pluralCategories,
  pluralShortcuts,
  quoteStyle,
  RULES,
  russianGenderShortcuts,
  russianMasculinePerson,
  russianYo,
  terminology,
  unsupportedIcu,
  untranslated,
  uzbekApostrophes,
  uzbekPluralAfterCount,
  uzbekResetIsNotRestore,
  voidIsOneWord,
} from '../lint/rules';
import { MUST_DIFFER, PERMISSION_NAMESPACES } from '../lint/terms';

const CATALOGS: Catalogs = { zh, en, ru, uz };

describe('catalog lint', () => {
  for (const [name, rule] of RULES) {
    test(name, () => {
      const found = rule(CATALOGS);
      // Printing the list makes the failure actionable without a debugger.
      expect(found, `\n${found.join('\n')}\n`).toEqual([]);
    });
  }

  test('the language pickers spell Oʻzbekcha with U+02BB', () => {
    // Shown in Settings, the language sheet and the catalog name fields;
    // it used to be "O'zbekcha" in three hand-copied lists.
    expect(LANGUAGE_NATIVE_NAMES.uz).toBe('O\u02bbzbekcha');
    expect(uzbekApostrophes(one({ uz: LANGUAGE_NATIVE_NAMES.uz }))).toEqual([]);
  });

  test('CMP-CAT-3: archiving an expense template does not promise runs skip it', () => {
    // Templates are shortcuts in the expense sheet; nothing is attached to
    // a run automatically, so "future runs will skip it" was not true.
    expect(en['admin.confirm.archiveExpenseTemplate']).not.toMatch(/future runs/i);
    expect(zh['admin.confirm.archiveExpenseTemplate']).not.toContain('自动带入');
    expect(ru['admin.confirm.archiveExpenseTemplate']).not.toContain('пропустят');
    expect(uz['admin.confirm.archiveExpenseTemplate']).not.toContain('qoldirib ketadi');
  });

  test('"remove" (take out of a list) and "delete" are different words', () => {
    // CMP-COPY-1: ru and uz used to write «Удалить» / «Oʻchirish» for both.
    for (const lang of LANGS) {
      expect(CATALOGS[lang]['common.remove'], lang).not.toBe(CATALOGS[lang]['common.delete']);
    }
  });
});

// ── The rules catch what they exist for ─────────────────────────────────

/** A one-key catalog set; languages not given copy the English value. */
function one(values: Partial<Record<Lang, string>>, key = 'k'): Catalogs {
  const english = values.en ?? 'Fine';
  return {
    en: { [key]: english },
    zh: { [key]: values.zh ?? '好' },
    ru: { [key]: values.ru ?? 'Хорошо' },
    uz: { [key]: values.uz ?? 'Yaxshi' },
  };
}

describe('catalog lint rules catch the original findings', () => {
  test('a one-word plural case is text, not a placeholder', () => {
    const cats = one({
      en: '{n, plural, one {pair} other {pairs}}',
      zh: '{n, plural, other {副}}',
      ru: '{n, plural, one {пара} few {пары} many {пар} other {пары}}',
      uz: '{n, plural, other {juft}}',
    });
    expect(placeholderMismatches(cats)).toEqual([]);
  });

  test('a placeholder renamed in one language', () => {
    const cats = one({ en: '{n} items', zh: '{n} 项', ru: '{count} поз.', uz: '{n} ta' });
    expect(placeholderMismatches(cats)).toEqual(['ru k: {count} vs en {n}']);
  });

  test('TEST4-11: a key missing in one language, or only in one', () => {
    const cats = one({});
    cats.ru = {};
    cats.uz = { ...cats.uz, extra: 'Ortiqcha' };
    expect(keyParity(cats)).toEqual(['ru k: missing', 'uz extra: not in en']);
    expect(keyParity(one({}))).toEqual([]);
  });

  test('TEST4-11: select and selectordinal blocks, which nothing formats', () => {
    expect(unsupportedIcu(one({ en: '{who, select, staff {Staff} other {Someone}}' }))).toEqual([
      'en k: "select" is not supported, only plural',
    ]);
    expect(unsupportedIcu(one({ ru: '{n, selectordinal, other {#-й}}' }))).toHaveLength(1);
    expect(unsupportedIcu(one({ en: '{n, plural, one {# line} other {# lines}}' }))).toEqual([]);
  });

  test('Uzbek ASCII and curly apostrophes, and ʻ / ʼ swapped', () => {
    expect(uzbekApostrophes(one({ uz: "qo'shish" }))).toHaveLength(1);
    expect(uzbekApostrophes(one({ uz: 'qo‘shish' }))).toHaveLength(1);
    expect(uzbekApostrophes(one({ uz: 'maʻlumot' }))).toHaveLength(1);
    expect(uzbekApostrophes(one({ uz: 'qoʻshish · maʼlumot · bogʻlash' }))).toEqual([]);
  });

  test('role ids, commands, milestones, permission keys and rank', () => {
    for (const bad of [
      'Only super_admin',
      'Run db:seed',
      'so M2.0c can deduct',
      'You need users.manage',
      'outbox rows',
      'Higher rank',
      'allow (force on)',
      'Recipe (BOM)',
      'Copy as TSV',
      'Enter a date (YYYY-MM-DD)',
      'after onboarding',
      'Mirror role bindings',
      // TEST4-09: namespaces the hand-written list did not have.
      'Needs delivery.confirm',
      'Only with attendance.manage',
      'Ask for prices.view',
      'Give dishes.manage',
      'org.admin only',
    ]) {
      expect(devTerms(one({ en: bad }))).not.toEqual([]);
    }
    expect(devTerms(one({ en: 'Super admin only · level {rank}' }))).toEqual([]);
  });

  test('TEST4-09: the permission namespaces come from the catalog', () => {
    for (const ns of ['order', 'run', 'attendance', 'delivery', 'dishes', 'prices', 'org']) {
      expect(PERMISSION_NAMESPACES).toContain(ns);
    }
  });

  test('«2 ЗАЯВОК» and "1 lines": a count glued to a noun', () => {
    expect(countsOutsidePlural(one({ ru: '{n} заявок' }))).toHaveLength(1);
    expect(countsOutsidePlural(one({ en: '{n} lines were signed for' }))).toHaveLength(1);
    expect(countsOutsidePlural(one({ en: '{n} selected · {n} min' }))).toEqual([]);
    expect(countsOutsidePlural(one({ en: '{n, plural, one {# order} other {# orders}}' }))).toEqual(
      [],
    );
  });

  test('"(s)" and "(ов)" shortcuts', () => {
    expect(pluralShortcuts(one({ en: '{n} item(s)' }))).toHaveLength(1);
    expect(pluralShortcuts(one({ ru: '{n} заказ(ов)' }))).toHaveLength(1);
    // «(а)» is not a plural; russianGenderShortcuts handles it.
    expect(pluralShortcuts(one({ ru: 'импортировал(а)' }))).toEqual([]);
  });

  test('a ru block without many, and a category case with a literal digit', () => {
    const ruBlock = '{n, plural, one {# роль} few {# роли} other {# ролей}}';
    expect(pluralCategories(one({ ru: ruBlock }))).toEqual(['ru k: missing many']);
    expect(pluralCategories(one({ en: '{n, plural, one {1 role} other {# roles}}' }))).toEqual([
      'en k: case "one" hardcodes a digit',
    ]);
  });

  test('R2-COPY-2: a ru `one` case that drops the count', () => {
    const bad =
      '{n, plural, one {Новый заказ} few {# новых заказа} many {# новых заказов} other {# новых заказа}}';
    expect(pluralCategories(one({ ru: bad }))).toEqual([
      'ru k: case "one" does not print the count (#) — it also covers 21',
    ]);
    // `=1` may drop it; a pure word-form block has no # anywhere.
    const exact =
      '{n, plural, =1 {Новый заказ} one {# новый заказ} few {# новых заказа} many {# новых заказов} other {# новых заказа}}';
    expect(pluralCategories(one({ ru: exact }))).toEqual([]);
    const form = '{n, plural, one {пара} few {пары} many {пар} other {пары}}';
    expect(pluralCategories(one({ ru: form }))).toEqual([]);
  });

  test('R2-COPY-1: a count the old whitelist did not know', () => {
    // {qty} and {eff} were not on the list, so "1 units" passed.
    expect(countsOutsidePlural(one({ en: '{qty} units' }))).toHaveLength(1);
    expect(countsOutsidePlural(one({ ru: '{eff} действует' }))).toHaveLength(1);
    expect(countsOutsidePlural(one({ en: '{name} submitted · {date} closed' }))).toEqual([]);
  });

  test('D15 terminology and quote styles', () => {
    expect(terminology(one({ zh: '撤销审批' }))).toHaveLength(1);
    expect(terminology(one({ en: 'New SKU' }))).toHaveLength(1);
    expect(terminology(one({ ru: 'Нет прав на согласование' }))).toHaveLength(1);
    expect(terminology(one({ uz: 'SKU qidirish' }))).toHaveLength(1);
    expect(terminology(one({ zh: '撤销审核', en: 'New product' }))).toEqual([]);
    expect(quoteStyle(one({ en: 'Joined “{org}”' }))).toHaveLength(1);
    expect(quoteStyle(one({ uz: '“{org}”ga qoʻshiling' }))).toHaveLength(1);
    expect(quoteStyle(one({ en: 'Joined "{org}"', uz: '«{org}»ga qoʻshiling' }))).toEqual([]);
  });

  test('D23 workspace and the internal words the copy review removed', () => {
    expect(copyBanned(one({ zh: '这个组织还没有门店' }))).toHaveLength(1);
    expect(copyBanned(one({ zh: '收件箱为空' }))).toHaveLength(1);
    expect(copyBanned(one({ zh: '点击产品旁的 + 号' }))).toHaveLength(1);
    expect(copyBanned(one({ zh: '采购单已冻结' }))).toHaveLength(1);
    expect(copyBanned(one({ zh: '只有认领人可以释放' }))).toHaveLength(2);
    expect(copyBanned(one({ en: 'No stores in this org' }))).toHaveLength(1);
    expect(copyBanned(one({ en: 'Run already exists for this slot' }))).toHaveLength(1);
    expect(copyBanned(one({ en: 'Claimed for review' }))).toHaveLength(1);
    expect(copyBanned(one({ ru: 'В этой организации нет магазинов' }))).toHaveLength(1);
    expect(copyBanned(one({ uz: 'Bu tashkilotda doʻkon yoʻq' }))).toHaveLength(1);
    // A placeholder named {org} is code, not copy.
    expect(copyBanned(one({ en: 'Joined "{org}"', zh: '已加入「{org}」' }))).toEqual([]);
    expect(copyBanned(one({ zh: '工作区', en: 'Workspace', ru: 'Рабочее пространство' }))).toEqual(
      [],
    );
  });

  test('Uzbek plural suffix after a count', () => {
    expect(uzbekPluralAfterCount(one({ uz: '{n} ta mahsulotlar' }))).toHaveLength(1);
    expect(uzbekPluralAfterCount(one({ uz: '{n} ta mahsulot' }))).toEqual([]);
  });

  test('half-width punctuation, quotes and single dashes in Chinese', () => {
    expect(chinesePunctuation(one({ zh: '归档「{name}」?' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '支付方式: 现金' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '清除测试数据(仅管理员)' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '点击上方"记录"' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '保存失败 — 请重试' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '保存失败——请重试（{n} 项）：好？' }))).toEqual([]);
  });

  test('TEST4-10: a full stop, an ellipsis and a single quote in Chinese', () => {
    expect(chinesePunctuation(one({ zh: '保存成功.' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '已发给 {name}.' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '加载中...' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: "点击'保存'" }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '保存成功。加载中…点击「保存」' }))).toEqual([]);
    expect(chinesePunctuation(one({ zh: '考勤-{store}-{month}.xlsx，约 1.5 公斤' }))).toEqual([]);
  });

  test('еще, curly English apostrophes and untranslated values', () => {
    expect(russianYo(one({ ru: 'и еще {n}' }))).toHaveLength(1);
    expect(englishApostrophes(one({ en: 'A built-in role’s level' }))).toHaveLength(1);
    expect(untranslated(one({ en: 'Import…', uz: 'Import…' }))).toHaveLength(1);
    expect(untranslated(one({ en: 'Shift Lead', zh: 'Shift Lead' }))).toHaveLength(1);
  });

  test('DX-COPY-26: server, sync, session and binding words', () => {
    expect(devTerms(one({ en: 'No answer from the server' }))).toHaveLength(1);
    expect(devTerms(one({ zh: '联网后自动同步' }))).toHaveLength(1);
    expect(devTerms(one({ ru: 'Сессия для этой даты уже существует' }))).toHaveLength(1);
    expect(devTerms(one({ ru: 'Продублировать привязки ролей' }))).toHaveLength(1);
    expect(devTerms(one({ uz: 'sinxronlanishni kutmoqda' }))).toHaveLength(1);
    expect(devTerms(one({ en: 'Saved offline — waiting to send' }))).toEqual([]);
    expect(devTerms(one({ en: 'Only for people on the server allowlist' }, 'dev.x'))).toEqual([]);
  });

  test('I18N1-06: transaction, session, parameter and cascade words', () => {
    expect(devTerms(one({ en: 'Atomic in one transaction:' }))).not.toEqual([]);
    expect(devTerms(one({ en: 'the whole transfer rolls back' }))).toHaveLength(1);
    expect(devTerms(one({ ru: 'Атомарно, в одной транзакции:' }))).toHaveLength(1);
    expect(devTerms(one({ uz: 'Bitta tranzaksiyada atomar bajariladi:' }))).toHaveLength(1);
    expect(devTerms(one({ zh: '会话已过期——请刷新' }))).toHaveLength(1);
    expect(devTerms(one({ zh: '入参' }))).toHaveLength(1);
    expect(devTerms(one({ en: 'see what gets cascade-deleted' }))).toHaveLength(1);
    expect(devTerms(one({ ru: 'посмотрите, что удалится каскадом' }))).toHaveLength(1);
    // Undoing a purchase is a real action in ru.
    expect(devTerms(one({ ru: 'Нельзя откатить — магазин уже принял' }))).toEqual([]);
    expect(devTerms(one({ en: 'All in one step:', zh: '登录已过期——请重新登录' }))).toEqual([]);
  });

  test('DX-COPY-18 / DX-COPY-15: mojibake and ISO dates', () => {
    expect(mojibakeAndIsoDates(one({ en: 'this storeâ€™s personnel' }))).toHaveLength(1);
    expect(mojibakeAndIsoDates(one({ ru: 'Пишите так: 2026-10-31.' }))).toHaveLength(1);
    expect(mojibakeAndIsoDates(one({ en: "this store's employees · {date}" }))).toEqual([]);
  });

  test('DX-COPY-10: ru gender shortcuts', () => {
    expect(russianGenderShortcuts(one({ ru: '{actor} импортировал(а) товары' }))).toHaveLength(1);
    expect(russianGenderShortcuts(one({ ru: '{actor}: участник {member} удалён' }))).toEqual([]);
  });

  test('I18N2-04: ru masculine past tense for a person', () => {
    for (const ru of ['Не пришёл', 'Отметился сам', 'Согласен', 'Посмотрел', 'Нажал по ошибке']) {
      expect(russianMasculinePerson(one({ ru }))).toHaveLength(1);
    }
    for (const ru of ['Неявка', 'Кто пришёл, график смен', 'Остаток ушёл в минус', 'Понятно']) {
      expect(russianMasculinePerson(one({ ru }))).toEqual([]);
    }
  });

  test('DX-COPY-1: uz reset written as restore', () => {
    expect(uzbekResetIsNotRestore(one({ en: 'Reset today', uz: 'Bugunni tiklash' }))).toHaveLength(1);
    expect(uzbekResetIsNotRestore(one({ en: 'Unarchive', uz: 'Tiklash' }))).toEqual([]);
    expect(
      uzbekResetIsNotRestore(one({ en: 'Reset today', uz: 'Bugungi maʼlumotlarni tozalash' })),
    ).toEqual([]);
  });

  test('I18N2-02 / I18N2-03: the manager role name, approve is not confirm', () => {
    expect(terminology(one({ ru: 'Попросите руководителя' }))).toHaveLength(1);
    expect(terminology(one({ ru: 'Менеджер вернул заказ' }))).toHaveLength(1);
    expect(terminology(one({ uz: 'Rahbar izohi' }))).toHaveLength(1);
    expect(terminology(one({ uz: 'doʻkon menejeri' }))).toHaveLength(1);
    expect(terminology(one({ ru: 'Попросите управляющего', uz: 'Boshqaruvchi izohi' }))).toEqual(
      [],
    );
    const approval = (uz: string) => one({ en: 'Approve once seen', uz }, 'approval.x');
    expect(approveIsNotConfirm(approval('Koʻrib chiqqach tasdiqlang.'))).toHaveLength(1);
    expect(approveIsNotConfirm(approval('Koʻrib chiqqach maʼqullang.'))).toEqual([]);
    expect(approveIsNotConfirm(one({ en: 'Confirm', uz: 'Tasdiqlash' }))).toEqual([]);
    expect(approveIsNotConfirm(one({ en: 'Approvals', ru: 'Ожидают подтверждения' }))).toHaveLength(
      1,
    );
    expect(approveIsNotConfirm(one({ en: 'Confirm receipt', ru: 'Подтвердить приёмку' }))).toEqual(
      [],
    );
  });

  test('DX-COPY-2: a void button that reads like Cancel', () => {
    // Every key the rule watches, each with a value of its own, then the
    // uz void button given the word for cancel.
    const watched = [...new Set(MUST_DIFFER.flatMap(([a, b]) => [a, b]))];
    const own = (lang: Lang) => Object.fromEntries(watched.map((key) => [key, `${lang} ${key}`]));
    const cats: Catalogs = { en: own('en'), zh: own('zh'), ru: own('ru'), uz: own('uz') };
    expect(distinctActions(cats)).toEqual([]);
    cats.uz['sales.void.confirmBtn'] = 'Bekor qilish';
    cats.uz['common.cancel'] = 'Bekor qilish';
    expect(distinctActions(cats)).toEqual([
      'uz sales.void.confirmBtn = common.cancel = "Bekor qilish" (void-sale sheet)',
    ]);
    // TEST4-11: a watched key that is gone (renamed) is reported, not skipped.
    delete cats.ru['people.revokeInvite'];
    expect(distinctActions(cats)).toEqual([
      'ru people.revokeInvite: missing (MUST_DIFFER, invite row)',
      'uz sales.void.confirmBtn = common.cancel = "Bekor qilish" (void-sale sheet)',
    ]);
  });

  test('I18N2-01: void is one word, not the word for cancel or delete', () => {
    const voidSale = (ru: string, uz: string, zh: string) => one({ en: 'Void sale', ru, uz, zh });
    expect(voidIsOneWord(voidSale('Аннулировать', 'Sotuvni yaroqsiz qilish', '确认作废'))).toEqual(
      [],
    );
    expect(voidIsOneWord(voidSale('Отмена', 'Bekor qilish', '作废'))).toEqual([
      'ru k: "Отмена" — say «аннулир…»',
      'uz k: "Bekor qilish" — say «yaroqsiz…»',
    ]);
    expect(voidIsOneWord(voidSale('Аннулировать', 'Oʻchirish', '删除'))).toHaveLength(2);
    expect(
      voidIsOneWord(one({ en: 'Cancel', ru: 'Отмена', uz: 'Bekor qilish', zh: '取消' })),
    ).toEqual([]);
  });

  test('CMP-COPY-1: HTML entities are shown as written', () => {
    expect(htmlEntities(one({ uz: 'Yo&apos;qotish' }))).toEqual(['uz k: Yo&apos;qotish']);
    expect(htmlEntities(one({ en: 'Salt &amp; pepper' }))).toHaveLength(1);
    expect(htmlEntities(one({ ru: 'Д&#39;Артаньян' }))).toHaveLength(1);
    expect(htmlEntities(one({ en: 'Salt & pepper; to taste' }))).toEqual([]);
  });

  test('I18N1-03 / 04 / 05 / 07: other items, contributors, cancel and receipts', () => {
    expect(terminology(one({ zh: '+ 添加其他商品' }))).toHaveLength(1);
    expect(terminology(one({ zh: '目录外商品和开销' }))).toHaveLength(1);
    expect(terminology(one({ zh: '为别的商品盘点' }))).toEqual([]);
    expect(copyBanned(one({ zh: '发票（可选）' }))).toHaveLength(1);
    expect(copyBanned(one({ zh: '例如：小票上的单价看错了' }))).toHaveLength(1);
    expect(copyBanned(one({ zh: '收据照片' }))).toEqual([]);
    expect(copyBanned(one({ en: 'Run canceled' }))).toHaveLength(1);
    expect(copyBanned(one({ en: 'Why are you canceling?' }))).toHaveLength(1);
    expect(copyBanned(one({ en: 'Run cancelled · Cancel' }))).toEqual([]);
    expect(chineseWordsKeepApart(one({ en: 'Run cancelled', zh: '采购单已作废' }))).toHaveLength(1);
    expect(chineseWordsKeepApart(one({ en: 'Void sale', zh: '取消销售' }))).toHaveLength(1);
    expect(chineseWordsKeepApart(one({ en: '3 contributors', zh: '3 位提交人' }))).toHaveLength(1);
    expect(chineseWordsKeepApart(one({ en: 'Run cancelled', zh: '采购单已取消' }))).toEqual([]);
    expect(chineseWordsKeepApart(one({ en: 'Rejected', zh: '提交人会看到原因' }))).toEqual([]);
  });

  test('every rule in RULES has a test in this block', () => {
    // A rule without one can stop matching unnoticed: voidIsOneWord had
    // none until review TEST4-13.
    const source = readFileSync(import.meta.path, 'utf8');
    const block = source.slice(source.indexOf("describe('catalog lint rules catch"));
    const untested = RULES.map(([, rule]) => rule.name).filter(
      (name) => !block.includes(`${name}(`),
    );
    expect(untested).toEqual([]);
  });
});
