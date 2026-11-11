import { describe, expect, test } from 'bun:test';
import { confirmCancelPolicy, confirmReasonPolicy } from '../components/ConfirmSheet';

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
    });
  });

  test('a required reason is shown at once and takes the focus', () => {
    expect(confirmReasonPolicy({ requireReason: true, expanded: false })).toEqual({
      showField: true,
      showToggle: false,
      autoFocus: true,
    });
  });

  test('an optional one waits behind its link, and opens without the keyboard', () => {
    expect(confirmReasonPolicy({ reasonOptional: true, expanded: false })).toEqual({
      showField: false,
      showToggle: true,
      autoFocus: false,
    });
    expect(confirmReasonPolicy({ reasonOptional: true, expanded: true })).toEqual({
      showField: true,
      showToggle: false,
      autoFocus: false,
    });
  });

  test('required wins over optional', () => {
    expect(
      confirmReasonPolicy({ requireReason: true, reasonOptional: true, expanded: false }),
    ).toEqual({
      showField: true,
      showToggle: false,
      autoFocus: true,
    });
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
