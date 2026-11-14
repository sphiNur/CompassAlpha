import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { confirmCancelPolicy, confirmReasonPolicy } from '../components/ConfirmSheet';
import { Input } from '../components/Input';
import { Field } from '../components/Rows';

/**
 * RUNWEB2-05: the run page's confirm sheet (cancel a run with an optional
 * note) is the kit's ConfirmSheet now; its reason field follows this.
 */
describe('confirmReasonPolicy', () => {
  test('no reason: no field, no link', () => {
    expect(confirmReasonPolicy({ expanded: false })).toEqual({
      showField: false,
      showToggle: false,
      autoFocus: false,
      required: false,
    });
  });

  test('a required reason is shown at once and takes the focus', () => {
    expect(confirmReasonPolicy({ requireReason: true, expanded: false })).toEqual({
      showField: true,
      showToggle: false,
      autoFocus: true,
      required: true,
    });
  });

  test('an optional one waits behind its link, and opens without the keyboard', () => {
    expect(confirmReasonPolicy({ reasonOptional: true, expanded: false })).toEqual({
      showField: false,
      showToggle: true,
      autoFocus: false,
      required: false,
    });
    expect(confirmReasonPolicy({ reasonOptional: true, expanded: true })).toEqual({
      showField: true,
      showToggle: false,
      autoFocus: false,
      required: false,
    });
  });

  test('required wins over optional', () => {
    expect(
      confirmReasonPolicy({ requireReason: true, reasonOptional: true, expanded: false }),
    ).toEqual({
      showField: true,
      showToggle: false,
      autoFocus: true,
      required: true,
    });
  });

  test('Review MWA-07: a required reason is marked required, with no "*" in its label', () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        label: 'Reason',
        children: createElement(Input, { required: true, value: '', onChange: () => {} }),
      }),
    );
    expect(html).toMatch(/<input[^>]*required=""/);
    expect(html).toContain('aria-invalid="false"');
    expect(html).not.toContain('*');
  });

  test('an opened optional note brings Cancel, as the sheet asks it to', () => {
    // ConfirmSheet passes `showCancelInSheet ?? (showField || undefined)`:
    // the keyboard covers the backdrop, so the way out must be a button.
    const field = confirmReasonPolicy({ reasonOptional: true, expanded: true });
    expect(
      confirmCancelPolicy({ showCancelInSheet: field.showField || undefined }).showCancel,
    ).toBe(true);
    const closed = confirmReasonPolicy({ reasonOptional: true, expanded: false });
    expect(
      confirmCancelPolicy({ showCancelInSheet: closed.showField || undefined }).showCancel,
    ).toBe(false);
  });
});
