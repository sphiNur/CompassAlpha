import { describe, expect, test } from 'bun:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FieldError } from '../components/FieldError';
import { Input } from '../components/Input';
import { PickerButton } from '../components/PickerButton';
import { Field, FieldGroup, FieldLabel, requiredMarkText } from '../components/Rows';
import { Select } from '../components/Select';
import { Textarea } from '../components/Textarea';

/** Review CONF-21: one field label and one field error for every form. */
describe('FieldLabel / FieldError', () => {
  test('a label for a control it does not wrap is a <label for>', () => {
    expect(
      renderToStaticMarkup(createElement(FieldLabel, { htmlFor: 'qty', children: 'Received' })),
    ).toMatch(/^<label for="qty" class="[^"]*">Received<\/label>$/);
    expect(renderToStaticMarkup(createElement(FieldLabel, { children: 'Received' }))).toMatch(
      /^<span class="[^"]*">Received<\/span>$/,
    );
  });

  // Review MWA-03: no longer its own role="alert" region; the host's
  // polite region says it (useUiAnnounce).
  test('an error is a plain line in the danger colour, and its text is the message alone', () => {
    const html = renderToStaticMarkup(
      createElement(FieldError, { id: 'qty-error', children: 'Enter a quantity' }),
    );
    expect(html).toMatch(/^<span id="qty-error" class="[^"]*text-\[var\(--c-danger\)\]/);
    expect(html).toContain('<svg aria-hidden="true"');
    // The sign is drawn, so a screen reader or a test reads the message only.
    expect(html.replace(/<[^>]+>/g, '')).toBe('Enter a quantity');
  });

  test('a call site can drop the top margin', () => {
    const html = renderToStaticMarkup(
      createElement(FieldError, { className: 'mt-0', children: 'x' }),
    );
    const spanClass = /^<span class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(spanClass.split(' ')).toContain('mt-0');
    expect(spanClass.split(' ')).not.toContain('mt-1');
  });
});

/** Review UI-02: Field carries the error, the hint and "required", and ties them to its control. */
describe('Field wiring', () => {
  const render = (
    props: Record<string, unknown>,
    control: ReactElement = createElement(Input, { readOnly: true }),
  ) => renderToStaticMarkup(createElement(Field, { label: 'Name', ...props, children: control }));
  const attr = (html: string, tag: string, name: string) =>
    new RegExp(`<${tag}[^>]* ${name}="([^"]*)"`).exec(html)?.[1];
  const idOf = (html: string, text: string) =>
    new RegExp(`id="([^"]+)"[^>]*>(?:<svg[^>]*>.*?</svg>)?(?:<span>)?${text}`).exec(html)?.[1];

  test('the error and the hint sit outside the <label> and describe the control, hint first', () => {
    const html = render({ error: 'Too long', hint: 'At most 40 letters' });
    const label = /<label[^>]*>.*?<\/label>/.exec(html)?.[0] ?? '';
    expect(label).not.toContain('Too long');
    expect(label).not.toContain('At most 40 letters');
    const errorId = idOf(html, 'Too long');
    const hintId = idOf(html, 'At most 40 letters');
    expect(errorId).toBeDefined();
    expect(hintId).toBeDefined();
    expect(attr(html, 'input', 'aria-describedby')).toBe(`${hintId} ${errorId}`);
    expect(attr(html, 'input', 'aria-invalid')).toBe('true');
    expect(attr(html, 'input', 'class')?.split(' ')).toContain('ring-[var(--c-danger)]');
  });

  test('without an error the control is not marked, and only the hint describes it', () => {
    const html = render({ hint: 'Optional', error: null });
    expect(html).not.toContain('role="alert"');
    expect(attr(html, 'input', 'aria-invalid')).toBeUndefined();
    expect(attr(html, 'input', 'aria-describedby')).toBe(idOf(html, 'Optional'));
  });

  // Review MWA-07 (V5): "(required)" instead of "*", still skipped by a
  // screen reader (the control's `required` says it).
  test('required draws "(required)" a screen reader skips and marks the control', () => {
    const html = render({ required: true });
    expect(html).toContain('Name<span aria-hidden="true" class="font-normal"> (required)</span>');
    // Review MWA-15: the native `required` (it implies aria-required), and
    // aria-invalid "false" until an error shows (WebKit reads an empty
    // required field as invalid otherwise).
    expect(attr(html, 'input', 'required')).toBe('');
    expect(attr(html, 'input', 'aria-required')).toBeUndefined();
    expect(attr(html, 'input', 'aria-invalid')).toBe('false');
    expect(attr(render({}), 'input', 'required')).toBeUndefined();
    expect(attr(render({}), 'input', 'aria-invalid')).toBeUndefined();
  });

  test("a caller's own description adds to the field's", () => {
    const html = render(
      { error: 'Bad' },
      createElement(Input, { readOnly: true, 'aria-describedby': 'own-note' }),
    );
    expect(attr(html, 'input', 'aria-describedby')).toBe(`${idOf(html, 'Bad')} own-note`);
  });

  test('a select and a textarea read the field too', () => {
    const select = render({ error: 'Pick one', required: true }, createElement(Select, {}));
    expect(attr(select, 'select', 'aria-invalid')).toBe('true');
    expect(attr(select, 'select', 'required')).toBe('');
    expect(attr(select, 'select', 'aria-describedby')).toBe(idOf(select, 'Pick one'));
    const area = render({ error: 'Write why' }, createElement(Textarea, {}));
    expect(attr(area, 'textarea', 'aria-invalid')).toBe('true');
    expect(attr(area, 'textarea', 'aria-describedby')).toBe(idOf(area, 'Write why'));
  });

  // Review UI-01: the label wrapped the content, so it named the first
  // control inside, a Save button beside the input sat in it too, and it
  // held a <div>, which a <label> may not.
  test('the label names the control by its id and holds only its text', () => {
    const html = render({ required: true });
    const label = /<label[^>]*>(.*?)<\/label>/.exec(html);
    expect(label?.[1]).toBe('Name<span aria-hidden="true" class="font-normal"> (required)</span>');
    const controlId = attr(html, 'input', 'id');
    expect(controlId).toBeTruthy();
    expect(attr(html, 'label', 'for')).toBe(controlId);
  });

  test('a select and a textarea take the id too; a control keeps an id of its own', () => {
    for (const control of [createElement(Select, {}), createElement(Textarea, {})]) {
      const html = render({}, control);
      const tag = /<(select|textarea)/.exec(html)?.[1] ?? '';
      const id = attr(html, tag, 'id');
      expect({ tag, id: Boolean(id) }).toEqual({ tag, id: true });
      expect(attr(html, 'label', 'for')).toBe(id);
    }
    const own = render({}, createElement(Input, { readOnly: true, id: 'own-id' }));
    expect(attr(own, 'input', 'id')).toBe('own-id');
  });

  test("a picker button is named by the field's label and its choice", () => {
    const html = render(
      { error: 'Choose someone' },
      createElement(PickerButton, { onClick: () => {}, children: 'Ali' }),
    );
    const buttonId = attr(html, 'button', 'id');
    expect(attr(html, 'label', 'for')).toBe(buttonId);
    const labelId = attr(html, 'label', 'id');
    const valueId = /<span id="([^"]+)"[^>]*>Ali<\/span>/.exec(html)?.[1];
    expect(attr(html, 'button', 'aria-labelledby')).toBe(`${labelId} ${valueId}`);
    expect(attr(html, 'button', 'aria-describedby')).toBe(idOf(html, 'Choose someone'));
    expect(attr(html, 'button', 'aria-invalid')).toBe('true');
    expect(attr(html, 'button', 'aria-haspopup')).toBe('dialog');
    // Outside a Field its text is its name.
    const alone = renderToStaticMarkup(
      createElement(PickerButton, { onClick: () => {}, children: 'Ali' }),
    );
    expect(attr(alone, 'button', 'aria-labelledby')).toBeUndefined();
    expect(attr(alone, 'button', 'id')).toBeUndefined();
  });

  test('a group is described by its hint, then its error (MWA-14)', () => {
    const html = renderToStaticMarkup(
      createElement(FieldGroup, {
        label: 'Stores',
        error: 'Pick at least one',
        hint: 'Where they work',
        children: 'x',
      }),
    );
    expect(attr(html, 'div', 'aria-describedby')).toBe(
      `${idOf(html, 'Where they work')} ${idOf(html, 'Pick at least one')}`,
    );
  });
});

describe('Review MWA-07 (V5): the required mark', () => {
  test('a space before a bracket, none before a full-width one', () => {
    expect(requiredMarkText('(required)')).toBe(' (required)');
    expect(requiredMarkText('（必填）')).toBe('（必填）');
    expect(requiredMarkText('  ')).toBe('');
  });
});
