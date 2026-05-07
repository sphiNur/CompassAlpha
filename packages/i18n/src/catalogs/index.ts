import { en } from './en';
import { zh } from './zh';
import { ru } from './ru';
import { uz } from './uz';

export type Locale = 'en' | 'zh' | 'ru' | 'uz';

export const catalogs = { en, zh, ru, uz } as const;

/** All keys that exist in `en`. CI grep-checks every other locale matches. */
export type CatalogKey = keyof typeof en;
