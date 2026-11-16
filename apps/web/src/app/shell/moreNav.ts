/**
 * What the More page shows (owner 2026-11-17): the shell works it out
 * with the bar (navLayout.ts) and hands it down, so the page and the bar
 * never disagree about which tabs are where.
 */
import { createContext, useContext } from 'react';
import type { Tab } from '../../stores/navStore';
import type { TabDef } from './tabs';

export interface MoreNav {
  /** The tabs the bar has no room for, most used first. */
  tabs: readonly TabDef[];
  /** Admin, drawn below them; null when the member may not open it. */
  admin: TabDef | null;
  onSelect: (tab: Tab) => void;
  /** A browser: Settings is a row here (Telegram opens it from its ⋯ menu). */
  onOpenSettings?: () => void;
}

export const MoreNavContext = createContext<MoreNav>({
  tabs: [],
  admin: null,
  onSelect: () => {},
});

export const useMoreNav = (): MoreNav => useContext(MoreNavContext);
