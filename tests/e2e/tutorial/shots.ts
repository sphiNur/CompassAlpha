/**
 * Screenshots for the tutorial cards, and the record of them the
 * manifest is made from.
 *
 * A step is one screen: the control to tap next is ringed, the phone's
 * screen is saved, the ring comes off, and the control's visible label is
 * read from the page (so the tutorial text quotes the app's own words in
 * each language).
 */
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import type { Locale } from '@compass/i18n';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Login } from './api';
import type { Role } from './demo';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const OUT_DIR = resolve(ROOT, process.env.TUTORIAL_OUT ?? 'tutorial-out');

export interface StepRecord {
  id: string;
  /** Relative to OUT_DIR. */
  screenshot: string;
  /** The tapped control's visible label; null for a screen with nothing to tap. */
  label: string | null;
  taps: number;
  note?: string;
}
export interface CardRecord {
  id: string;
  role: Role;
  title: string;
  steps: StepRecord[];
  notes: string[];
}

/** Open the app signed in as `who`, on a phone of its own. */
export async function openAs(
  browser: Browser,
  login: Login,
  opts: { storeId?: string | null } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ permissions: ['camera'] });
  // A context made here does not get the config's action timeout.
  context.setDefaultTimeout(20_000);
  const page = await context.newPage();
  // Same origin, no app code: a place to seed storage before the app boots.
  await page.goto('/boot.css');
  await page.evaluate(
    ([state]) => window.localStorage.setItem('compass.auth', state!),
    [
      JSON.stringify({
        state: {
          accessToken: login.accessToken,
          refreshToken: login.refreshToken,
          session: login.session,
          currentStoreId: opts.storeId ?? null,
        },
        version: 0,
      }),
    ],
  );
  await page.goto('/');
  await page.getByRole('main').waitFor();
  // The first screen's data.
  await page.waitForLoadState('networkidle').catch(() => {});
  return { context, page };
}

const RING_ID = '__tutorial_ring__';

async function drawRing(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('the control to tap has no box on screen');
  await page.evaluate(
    ({ id, box }) => {
      const pad = 6;
      const ring = document.createElement('div');
      ring.id = id;
      Object.assign(ring.style, {
        position: 'fixed',
        left: `${box.x - pad}px`,
        top: `${box.y - pad}px`,
        width: `${box.width + pad * 2}px`,
        height: `${box.height + pad * 2}px`,
        border: '3px solid rgba(255, 59, 48, 0.9)',
        background: 'rgba(255, 59, 48, 0.12)',
        borderRadius: `${Math.min(18, (box.height + pad * 2) / 2)}px`,
        boxShadow: '0 0 0 3px rgba(255, 255, 255, 0.85)',
        pointerEvents: 'none',
        zIndex: '2147483647',
        boxSizing: 'border-box',
      });
      document.body.append(ring);
    },
    { id: RING_ID, box },
  );
}

async function removeRing(page: Page): Promise<void> {
  await page.evaluate((id) => document.getElementById(id)?.remove(), RING_ID);
}

/**
 * The toast stack (packages/ui Toast: a fixed layer holding the two
 * aria-live regions). Hidden on the screens of a step, where yesterday's
 * "saved" only covers the screen; kept on the screen that shows a result.
 */
async function showToasts(page: Page, show: boolean): Promise<void> {
  await page.evaluate((show) => {
    for (const region of document.querySelectorAll('div[aria-live="polite"]')) {
      const layer = region.parentElement;
      if (layer && getComputedStyle(layer).position === 'fixed') {
        layer.style.visibility = show ? '' : 'hidden';
      }
    }
  }, show);
}

/**
 * What a person reads on the control. A field: its label. Anything else:
 * the first line of its text, leaving out what is not seen (screen-reader
 * text, a tab's badge), so a row's hint or a "1" badge is not part of it.
 * An icon-only button keeps its icon (+, ✓); one without text (or only a
 * count badge), its accessible name.
 */
async function visibleLabel(target: Locator): Promise<string> {
  return target.evaluate((el) => {
    const clean = (t: string | null | undefined) =>
      (t ?? '')
        .replace(/\s+/g, ' ')
        .replace(/\s*\*$/, '')
        .trim();
    const h = el as HTMLElement & {
      labels?: NodeListOf<HTMLLabelElement>;
      placeholder?: string;
    };
    const byName = () => {
      const aria = clean(h.getAttribute('aria-label'));
      if (aria) return aria;
      const ids = h.getAttribute('aria-labelledby');
      if (ids) {
        const t = clean(
          ids
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.innerText)
            .join(' '),
        );
        if (t) return t;
      }
      return clean(h.labels?.[0]?.innerText) || clean(h.placeholder) || clean(h.title);
    };
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(h.tagName)) {
      return clean(h.labels?.[0]?.innerText) || byName();
    }
    let text = h.innerText ?? '';
    for (const hidden of h.querySelectorAll<HTMLElement>('[aria-hidden="true"], .sr-only')) {
      const t = hidden.innerText?.trim();
      // Keep an icon that is the button's only text (+, ✓), not a count
      // badge: the page main button is an icon circle with a badge, its
      // words its accessible name (2026-11-14), read by byName below.
      if (t && (text.trim() !== t || /^\d+\+?$/.test(t))) text = text.replace(t, '');
    }
    const first = text
      .split('\n')
      .map(clean)
      .find((line) => line);
    return first || byName();
  });
}

export class Card {
  readonly record: CardRecord;
  private n = 0;

  constructor(
    private readonly lang: Locale,
    readonly page: Page,
    id: string,
    role: Role,
    title: string,
    sink: CardRecord[],
  ) {
    this.record = { id, role, title, steps: [], notes: [] };
    sink.push(this.record);
  }

  /**
   * One screen of the card. With a target, it is ringed and its label
   * recorded; `taps` is how many taps the step's action takes (1 unless
   * said otherwise; a typed field counts its one tap).
   */
  async shot(
    stepId: string,
    target: Locator | null,
    opts: { taps?: number; label?: string; note?: string; toasts?: boolean } = {},
  ): Promise<void> {
    const file = join(
      OUT_DIR,
      this.lang,
      this.record.id,
      `${String(++this.n).padStart(2, '0')}-${stepId}.png`,
    );
    mkdirSync(dirname(file), { recursive: true });
    // Let transitions and toasts settle.
    await this.page.waitForTimeout(350);
    let label: string | null = null;
    if (target) {
      await target.waitFor({ state: 'visible', timeout: 20_000 });
      label = opts.label ?? (await visibleLabel(target));
      await drawRing(this.page, target);
    }
    const toasts = opts.toasts ?? !target;
    if (!toasts) await showToasts(this.page, false);
    try {
      writeFileSync(file, await this.page.screenshot({ animations: 'disabled', caret: 'hide' }));
    } finally {
      if (target) await removeRing(this.page);
      if (!toasts) await showToasts(this.page, true);
    }
    this.record.steps.push({
      id: stepId,
      screenshot: relative(OUT_DIR, file),
      label,
      taps: target ? (opts.taps ?? 1) : 0,
      ...(opts.note ? { note: opts.note } : {}),
    });
  }

  /** Shoot the step with `target` ringed, then tap it. */
  async tap(
    stepId: string,
    target: Locator,
    opts: { taps?: number; label?: string; note?: string; toasts?: boolean } = {},
  ): Promise<void> {
    await this.shot(stepId, target, opts);
    await target.click();
  }

  /** Something the tutorial writer should know (a step that could not be shot). */
  note(text: string): void {
    this.record.notes.push(text);
  }
}

/** Start this language's screenshots from an empty folder. */
export function clearLang(lang: Locale): void {
  rmSync(join(OUT_DIR, lang), { recursive: true, force: true });
}

/** Write this language's part of the manifest; run.ts merges the parts. */
export function writePart(lang: Locale, cards: CardRecord[]): void {
  const file = join(OUT_DIR, '.parts', `${lang}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ lang, cards }, null, 2));
}

/** While writing a walk: the screen and its accessibility tree, to /tmp. */
export async function dump(page: Page, name: string): Promise<void> {
  const dir = process.env.TUTORIAL_DUMP_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(dir, `${name}.png`) });
  writeFileSync(join(dir, `${name}.yml`), await page.locator('body').ariaSnapshot());
}
