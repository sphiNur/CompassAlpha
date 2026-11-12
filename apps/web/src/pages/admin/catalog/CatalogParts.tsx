/**
 * The parts the catalog sections share: the bar over a list, a row's
 * header and its edit/archive buttons, and the four name fields.
 *
 * Review ADM2-11 (2026-11-11): each section had its own copy, and the
 * copies had drifted. The expense templates used other keys for the same
 * buttons and showed no spinner on Unarchive. The supplier line began with
 * " · " for a supplier with no phone. The dish names had no "one language
 * is enough" line.
 */
import { Fragment, useState, type ReactNode } from 'react';
import { Badge, Button, CardHeader, CardMeta, CardTitle, Field, Input, Switch } from '@compass/ui';
import { CATALOG_TEXT_MAX } from '@compass/contracts/limits';
import { LANGUAGE_NATIVE_NAMES, type Locale } from '@compass/i18n';
import { useI18n } from '../../../hooks/useI18n';
import { useAuthStore } from '../../../stores/authStore';
import { nativeConfirm } from '../shared';
import { CATALOG_LOCALES, type CatalogNames } from './catalogNames';
import { readSortIndex } from './sortIndex';

/**
 * 2026-10-21 audit CA-16: every catalog write (categories, SKUs,
 * suppliers, expense templates) is `requireOrgAdmin` on the server, but
 * the controls rendered for anyone who could open Admin (`users.manage`),
 * so a store manager got a FORBIDDEN on save. Without `org.admin` the
 * sections are now a read-only list.
 */
export function useIsOrgAdmin(): boolean {
  return useAuthStore((s) => s.session?.permissions.includes('org.admin') ?? false);
}

/** Shown above the list when the catalog is read-only. */
export function ReadOnlyHint() {
  const i18n = useI18n();
  return (
    <p className="mb-3 text-old-label text-[var(--c-fg-muted)]">{i18n.t('catalog.readOnlyHint')}</p>
  );
}

/**
 * The bar over a catalog list: "+ New …" for someone who may add, any
 * other buttons, and the "show archived" switch on the right. It wraps
 * (WALK-04, ADM2-13): at 320 px in Russian or Uzbek the buttons were cut
 * to «+ Новый …».
 */
export function CatalogToolbar({
  newLabel,
  onNew,
  showArchived,
  onShowArchivedChange,
  children,
}: {
  /** The New button's words, without the "+"; none for a read-only list. */
  newLabel?: string;
  onNew?: () => void;
  /** Leave out for a list without archived items to show. */
  showArchived?: boolean;
  onShowArchivedChange?: (show: boolean) => void;
  /** More buttons, after New. */
  children?: ReactNode;
}) {
  const i18n = useI18n();
  const hasSwitch = showArchived !== undefined && onShowArchivedChange !== undefined;
  if (!newLabel && !children && !hasSwitch) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {newLabel && onNew ? (
        <Button size="sm" onClick={onNew}>
          + {newLabel}
        </Button>
      ) : null}
      {children}
      {hasSwitch ? (
        <div className="ml-auto">
          <Switch
            label={i18n.t('admin.label.showArchived')}
            checked={showArchived}
            onChange={(e) => onShowArchivedChange(e.target.checked)}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A list row's header: the name, the item's other names, a line of facts
 * and an "Archived" badge.
 */
export function CatalogRowHeader({
  title,
  titleLang,
  names,
  meta,
  archived,
}: {
  /** The name in the reader's language only; `names` lists the others. */
  title: string;
  /** The title's language when it is not the interface's (A11Y-3). */
  titleLang?: string;
  /**
   * The item's names in every language. Those that differ from the title
   * show under it, so an admin sees at a glance what is translated.
   */
  names?: Partial<Record<string, string>>;
  /** The facts line; nothing (or '') draws no line (UI-3, review ADM2-25). */
  meta: ReactNode;
  archived: boolean;
}) {
  const i18n = useI18n();
  const otherLangs = names
    ? CATALOG_LOCALES.filter((locale) => names[locale] && names[locale] !== title)
    : [];
  return (
    <CardHeader>
      <div className="min-w-0">
        <CardTitle as="h2">
          <span lang={titleLang}>{title}</span>
        </CardTitle>
        {names && otherLangs.length > 0 ? (
          <div className="mt-0.5 truncate text-old-label text-[var(--c-fg-muted)]">
            <OtherLangNames names={names} langs={otherLangs} />
          </div>
        ) : null}
        {meta ? <CardMeta>{meta}</CardMeta> : null}
      </div>
      {archived ? <Badge tone="muted">{i18n.t('common.archived')}</Badge> : null}
    </CardHeader>
  );
}

/**
 * A11Y-3 (2026-10-31): the "Mol goʻshti · Говядина · Beef" line under a
 * catalog name. Each name carries its own `lang`, so a screen reader
 * reads the Russian one in Russian instead of in the interface's voice.
 */
function OtherLangNames({
  names,
  langs,
}: {
  names: Partial<Record<string, string>>;
  langs: readonly Locale[];
}) {
  return (
    <>
      {langs.map((locale, index) => (
        <Fragment key={locale}>
          {index > 0 ? ' · ' : null}
          <span lang={locale}>{names[locale]}</span>
        </Fragment>
      ))}
    </>
  );
}

/** A row's Edit button, and Archive (asks first) or Unarchive. */
export function CatalogRowActions({
  archived,
  onEdit,
  confirmArchive,
  onArchive,
  onUnarchive,
  unarchiving,
}: {
  archived: boolean;
  onEdit: () => void;
  /** The question asked before archiving, naming the item. */
  confirmArchive: string;
  onArchive: () => void;
  onUnarchive: () => void;
  /** This row's Unarchive is on its way. */
  unarchiving: boolean;
}) {
  const i18n = useI18n();
  return (
    <div className="flex gap-2 border-t border-[var(--c-divider)] px-4 py-2">
      <Button size="sm" variant="pearl" onClick={onEdit}>
        {i18n.t('common.edit')}
      </Button>
      {archived ? (
        // 2026-10-21 audit CA-40 / E-16: the update procedures always
        // accepted isArchived, but there was no way back in the UI.
        <Button size="sm" variant="pearl" loading={unarchiving} onClick={onUnarchive}>
          {i18n.t('common.unarchive')}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="danger-ghost"
          onClick={() => nativeConfirm(confirmArchive, onArchive)}
        >
          {i18n.t('common.archive')}
        </Button>
      )}
    </div>
  );
}

/**
 * The name fields of a category, product or dish: one per language,
 * Uzbek first. CAT-10: one name in any language is enough (the server's
 * rule); the fields used to be starred as if all four were required.
 */
export function CatalogNameFields({
  names,
  onChange,
  examples,
  autoFocus = false,
}: {
  names: CatalogNames;
  onChange: (names: CatalogNames) => void;
  /** An example name in each language, shown in that language's field. */
  examples?: CatalogNames;
  /** Focus the first field when the editor opens. */
  autoFocus?: boolean;
}) {
  const i18n = useI18n();
  return (
    <>
      <p className="text-old-label text-[var(--c-fg-muted)]">
        {i18n.t('catalog.names.atLeastOne')}
      </p>
      {CATALOG_LOCALES.map((locale, index) => (
        <Field
          key={locale}
          label={i18n.t('admin.field.nameInLocale', { locale: LANGUAGE_NATIVE_NAMES[locale] })}
        >
          <Input
            lang={locale}
            value={names[locale]}
            onChange={(e) => onChange({ ...names, [locale]: e.target.value })}
            maxLength={CATALOG_TEXT_MAX.name}
            placeholder={examples?.[locale]}
            autoFocus={autoFocus && index === 0}
          />
        </Field>
      ))}
    </>
  );
}

/**
 * The sort position field of the category, product and expense template
 * editors (review NEW-07): the text as typed, a minus sign included. Once
 * the field is left, a line under it says when the text is not a whole
 * number in range; the editor's Save waits for one (readSortIndex).
 */
export function SortIndexField({ text, onText }: { text: string; onText: (text: string) => void }) {
  const i18n = useI18n();
  const [left, setLeft] = useState(false);
  const bad = left && readSortIndex(text) === null;
  return (
    <Field
      label={i18n.t('admin.field.sortIndex')}
      error={bad ? i18n.t('admin.errors.sortIndexInteger') : null}
    >
      <Input
        type="number"
        // The full keyboard: the iPhone's number pads have no minus sign
        // (as the reset date in Maintenance, DX-CAT-4).
        inputMode="text"
        value={text}
        onChange={(e) => onText(e.target.value)}
        onBlur={() => setLeft(true)}
      />
    </Field>
  );
}
