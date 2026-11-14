import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { spokenText, type SpokenNode } from '../announce';
import { DEFAULT_UI_LABELS } from '../labels';
import { nextLeftState, revealsOnKey, shownError } from '../useLeftField';
import { SearchInput } from '../components/SearchInput';
import { Segmented } from '../components/Segmented';
import { SPINNER_CLASS, Spinner } from '../components/Spinner';
import {
  TOAST_SPOKEN_MS,
  ToastProvider,
  toastFocusTarget,
  toastHasClose,
  toastSpokenParts,
  toastsToSpeak,
  toastTtl,
} from '../components/Toast';

/**
 * The Modern Web Guidance audit (2026-11): form errors, announcements,
 * toasts, motion. Each test names its finding id.
 */

const text = (s: string): SpokenNode => ({ nodeType: 3, textContent: s });
const el = (children: SpokenNode[], attrs: Record<string, string> = {}): SpokenNode => ({
  nodeType: 1,
  textContent: null,
  childNodes: children,
  getAttribute: (name) => attrs[name] ?? null,
});

describe('MWA-03: what a field error says', () => {
  test('the text a screen reader reads, without aria-hidden parts', () => {
    const label = el([text('Code'), el([text(' *')], { 'aria-hidden': 'true' })]);
    expect(spokenText(label)).toBe('Code');
    const error = el([el([], { 'aria-hidden': 'true' }), el([text('  Use a-z,\n 0-9 ')])]);
    expect(spokenText(error)).toBe('Use a-z, 0-9');
    expect(spokenText(null)).toBe('');
  });

  test("the field's name comes first, when it has one", () => {
    expect(DEFAULT_UI_LABELS.fieldError('Code', 'Use a-z')).toBe('Code: Use a-z');
    expect(DEFAULT_UI_LABELS.fieldError('', 'Use a-z')).toBe('Use a-z');
  });
});

describe('MWA-04: an error waits until the field is left', () => {
  test('a new key starts over; the same key keeps the state', () => {
    const left = { key: 'a', left: true };
    expect(nextLeftState(left, 'a')).toBe(left);
    expect(nextLeftState(left, 'b')).toEqual({ key: 'b', left: false });
    expect(nextLeftState(left, null)).toEqual({ key: null, left: false });
  });

  test('shown only once left', () => {
    expect(shownError('Bad', false)).toBeNull();
    expect(shownError('Bad', true)).toBe('Bad');
    expect(shownError(null, true)).toBeNull();
  });

  test('Enter counts as leaving, but not while an IME composes', () => {
    expect(revealsOnKey('Enter', false)).toBe(true);
    expect(revealsOnKey('Enter', true)).toBe(false);
    expect(revealsOnKey('a', false)).toBe(false);
  });
});

describe('MWA-18: SearchInput is an identifier field', () => {
  test('no autocorrect, capitals or spell check; Enter says search', () => {
    const html = renderToStaticMarkup(
      createElement(SearchInput, { value: '', onChange: () => {}, onClear: () => {} }),
    );
    expect(html).toContain('enterKeyHint="search"');
    expect(html).toContain('autoCorrect="off"');
    expect(html).toContain('autoCapitalize="off"');
    expect(html).toContain('spellcheck="false"');
  });

  test('a caller may still override them', () => {
    const html = renderToStaticMarkup(
      createElement(SearchInput, {
        value: '',
        onChange: () => {},
        onClear: () => {},
        enterKeyHint: 'done',
      }),
    );
    expect(html).toContain('enterKeyHint="done"');
  });
});

describe('MWB-03 / MWB-07: the toast stack', () => {
  test('is a named region holding both live regions', () => {
    const html = renderToStaticMarkup(
      createElement(ToastProvider, { children: createElement('main') }),
    );
    expect(html).toMatch(
      /<div[^>]*data-toast-stack=""[^>]*role="region"[^>]*aria-label="Notifications"/,
    );
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('aria-live="polite"');
  });

  test('a toast is read as its text, then "Actions available" when it has buttons', () => {
    const plain = toastSpokenParts({ title: 'Saved', message: '3 items' }, 'Actions available');
    expect(plain).toEqual(['Saved', '3 items']);
    const withUndo = toastSpokenParts(
      { message: 'Archived', actions: [{ label: 'Undo' }] },
      'Actions available',
    );
    expect(withUndo).toEqual(['Archived', 'Actions available']);
  });
});

describe('MWB-05 / MWB-07 (V6): an error stays until it is closed, and is read once', () => {
  test('an error stays; success and info keep the default time; a caller wins', () => {
    expect(toastTtl('danger', undefined, 4000)).toBe(0);
    expect(toastTtl('success', undefined, 4000)).toBe(4000);
    expect(toastTtl('info', undefined, 4000)).toBe(4000);
    expect(toastTtl('warn', undefined, 4000)).toBe(4000);
    expect(toastTtl('danger', 6000, 4000)).toBe(6000);
    expect(toastTtl('success', 0, 4000)).toBe(0);
  });

  test('a toast that stays has a ✕, unless a button of its own only closes it', () => {
    expect(toastHasClose({ ttlMs: 0 })).toBe(true);
    expect(toastHasClose({ ttlMs: 0, actions: [{ onClick: () => {} }] })).toBe(true);
    // "Later" / "Got it": already a close.
    expect(toastHasClose({ ttlMs: 0, actions: [{ onClick: () => {} }, {}] })).toBe(false);
    expect(toastHasClose({ ttlMs: 4000 })).toBe(false);
  });

  test('the hidden copy leaves its live region once said', () => {
    const toasts = [{ id: 'a' }, { id: 'b' }];
    expect(toastsToSpeak(toasts, new Set())).toEqual(toasts);
    expect(toastsToSpeak(toasts, new Set(['a']))).toEqual([{ id: 'b' }]);
    expect(TOAST_SPOKEN_MS).toBeGreaterThan(0);
    expect(TOAST_SPOKEN_MS).toBeLessThan(4000);
  });
});

describe('MWB-04: focus after a focused toast goes', () => {
  const node = (name: string, connected = true, hidden = false) => ({
    name,
    isConnected: connected,
    closest: (s: string) => (hidden && s.includes('aria-hidden') ? {} : null),
  });

  test('the next toast first, then where focus was, then the page', () => {
    const next = node('next');
    const before = node('before');
    const main = node('main');
    expect(toastFocusTarget(next, before, main)).toBe(next);
    expect(toastFocusTarget(null, before, main)).toBe(before);
    expect(toastFocusTarget(null, node('gone', false), main)).toBe(main);
    expect(toastFocusTarget(null, node('behind a sheet', true, true), main)).toBe(main);
    expect(toastFocusTarget(null, null, null)).toBeNull();
  });
});

describe('MWB-08: the spinner under reduced motion', () => {
  test('turns slowly instead of at 900 ms', () => {
    expect(SPINNER_CLASS).toContain('motion-reduce:[animation-duration:6s]');
    expect(renderToStaticMarkup(createElement(Spinner))).toContain('motion-reduce:');
  });
});

describe('MWB-16: Segmented points at the view it swaps', () => {
  const render = (controls?: string) =>
    renderToStaticMarkup(
      createElement(Segmented<'a' | 'b'>, {
        value: 'a',
        onChange: () => {},
        ariaLabel: 'View',
        controls,
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      }),
    );

  test('each option names the panel, when the caller gives one', () => {
    expect(render('panel-1').match(/aria-controls="panel-1"/g)?.length).toBe(2);
    expect(render()).not.toContain('aria-controls');
  });
});
