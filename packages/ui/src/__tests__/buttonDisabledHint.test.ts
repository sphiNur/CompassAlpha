import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, buttonHint, hintChanged, saysBusy, SPINNER_FIT } from '../components/Button';
import { createRevealScope, firstMissingControl } from '../revealScope';
import type { MissingCandidate } from '../revealScope';

/**
 * UX-05: a disabled Save says what is missing, in a muted line the button
 * points at with aria-describedby.
 */
describe('Button disabledHint', () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(Button, props, 'Save'));

  test('a disabled button is described by its hint', () => {
    const html = render({ block: true, disabled: true, disabledHint: 'Enter a name.' });
    const id = /id="([^"]+)"[^>]*data-testid="button-disabled-hint"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain('>Enter a name.</span>');
    // Review MWA-06: a plain line, not a live region of its own.
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('aria-live');
    expect(html).toMatch(new RegExp(`<button[^>]*aria-describedby="${id}"`));
    // A footer's block button has the line above it.
    expect(html.indexOf('button-disabled-hint')).toBeLessThan(html.indexOf('<button'));
  });

  test('an inline button has it below, so a row of buttons stays level', () => {
    const html = render({ disabled: true, disabledHint: 'Nothing has changed yet.' });
    const id = /id="([^"]+)"[^>]*data-testid="button-disabled-hint"/.exec(html)?.[1];
    expect(html).toMatch(new RegExp(`<button[^>]*aria-describedby="${id}"`));
    expect(html.indexOf('button-disabled-hint')).toBeGreaterThan(html.indexOf('<button'));
  });

  test('keeps a describedby the caller set', () => {
    const html = render({ disabled: true, disabledHint: 'x', 'aria-describedby': 'other' });
    const id = /id="([^"]+)"[^>]*data-testid="button-disabled-hint"/.exec(html)?.[1];
    expect(html).toContain(`aria-describedby="other ${id}"`);
  });

  test('no hint while enabled, loading or empty — but the wrapper stays', () => {
    for (const props of [
      { disabled: false, disabledHint: 'x' },
      { disabled: true, loading: true, disabledHint: 'x' },
      { disabled: true, disabledHint: '  ' },
      { disabled: true, disabledHint: undefined },
    ]) {
      const html = render(props);
      expect(html).not.toContain('button-disabled-hint');
      expect(html).not.toContain('aria-describedby');
      expect(html.startsWith('<span')).toBe(true);
    }
  });

  // Review MWA-05 (modern-web-guidance: accessibility): reachable while it waits.
  test('a button with a hint is aria-disabled, not disabled, and looks the same', () => {
    const html = render({ block: true, disabled: true, disabledHint: 'Enter a name.' });
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('data-blocked="true"');
    expect(html).toContain('data-[blocked]:opacity-50');
  });

  test('disabled with no hint (or loading) stays natively disabled / loading', () => {
    expect(render({ disabled: true, disabledHint: '' })).toMatch(/<button[^>]* disabled=""/);
    expect(render({ disabled: true, disabledHint: '' })).not.toContain('data-blocked');
    expect(render({ disabled: true, loading: true, disabledHint: 'x' })).not.toContain(
      'data-blocked',
    );
    expect(render({ disabled: false, disabledHint: 'x' })).not.toContain('aria-disabled');
  });

  test('without the prop the button is not wrapped', () => {
    expect(render({ disabled: true }).startsWith('<button')).toBe(true);
  });

  test('buttonHint', () => {
    expect(buttonHint(true, false, ' Pick a store. ')).toBe('Pick a store.');
    expect(buttonHint(false, false, 'x')).toBeUndefined();
    expect(buttonHint(true, true, 'x')).toBeUndefined();
    expect(buttonHint(true, undefined, '')).toBeUndefined();
  });
});

/** Review MWA-06: a change of reason is said; its first showing is not. */
describe('hintChanged', () => {
  test('only one reason giving way to another', () => {
    expect(hintChanged('Photo uploading…', 'Describe the problem')).toBe(true);
    expect(hintChanged(undefined, 'Enter a name.')).toBe(false);
    expect(hintChanged('Enter a name.', undefined)).toBe(false);
    expect(hintChanged('Enter a name.', 'Enter a name.')).toBe(false);
  });
});

/** Review MWB-10: a loading button keeps focus and says it is busy. */
describe('Button loading', () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(Button, props, 'Save'));

  test('is aria-disabled, not disabled, and looks as a disabled one did', () => {
    const html = render({ loading: true, disabled: true });
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
    expect(html).toContain('data-loading="true"');
    expect(html).toContain('data-[loading]:opacity-50');
    // The spinner is still the only visual (aria-hidden).
    expect(html).toContain('<svg');
  });

  test('a disabled button that is not loading stays natively disabled', () => {
    const html = render({ loading: false, disabled: true });
    expect(html).toMatch(/<button[^>]* disabled=""/);
    expect(html).not.toContain('aria-disabled');
  });

  test('says busy only after its own press, or with focus', () => {
    expect(saysBusy(true, 0, 5000)).toBe(true);
    expect(saysBusy(false, 4500, 5000)).toBe(true);
    expect(saysBusy(false, 3000, 5000)).toBe(false);
    expect(saysBusy(false, 0, 5000)).toBe(false);
  });
});

/** Review MWA-05: a tap on a waiting Save reveals its scope's fields. */
describe('reveal scope', () => {
  test('reveals every field added, none removed', () => {
    const scope = createRevealScope();
    const seen: string[] = [];
    scope.add(() => seen.push('a'));
    const removeB = scope.add(() => seen.push('b'));
    removeB();
    scope.revealAll();
    expect(seen).toEqual(['a']);
  });

  const node = (attrs: Record<string, string>, extra: Partial<MissingCandidate> = {}) => ({
    getAttribute: (name: string) => attrs[name] ?? null,
    ...extra,
  });
  const root = (byQuery: { invalid: MissingCandidate[]; required: MissingCandidate[] }) => ({
    querySelectorAll: (sel: string) =>
      sel === '[aria-invalid="true"]' ? byQuery.invalid : byQuery.required,
  });

  test('the first field showing an error wins', () => {
    const bad = node({ 'aria-invalid': 'true' });
    const empty = node({ 'aria-required': 'true' }, { value: '' });
    expect(firstMissingControl(root({ invalid: [bad], required: [empty] }))).toBe(bad);
  });

  test('else the first empty required field, skipping filled and disabled ones', () => {
    const filled = node({}, { value: 'Ann' });
    const off = node({}, { value: '', disabled: true });
    const empty = node({}, { value: '  ' });
    expect(firstMissingControl(root({ invalid: [], required: [filled, off, empty] }))).toBe(empty);
  });

  test('nothing to move to: null (the hint alone says why)', () => {
    expect(firstMissingControl(root({ invalid: [], required: [node({}, { value: 'x' })] }))).toBe(
      null,
    );
  });
});

describe('Review MWB-10 (V5): a busy button keeps its width', () => {
  test("the start-padding spinner's margins take back its size and the 8 px gap", () => {
    const pad = { sm: 12, md: 20, lg: 28 } as const;
    for (const key of ['sm', 'md', 'lg'] as const) {
      const fit = SPINNER_FIT[key];
      const px = (name: 'ml' | 'mr') =>
        Number(new RegExp(`-${name}-\\[(\\d+)px\\]`).exec(fit.className)?.[1] ?? 0);
      expect(fit.size + 8 - px('ml') - px('mr')).toBe(0);
      // It starts inside the button, before the label.
      expect(pad[key] - px('ml')).toBeGreaterThan(0);
    }
  });
});
