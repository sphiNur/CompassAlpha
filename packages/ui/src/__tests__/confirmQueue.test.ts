import { describe, expect, test } from 'bun:test';
import { createConfirmQueue, splitQuestion } from '../confirmQueue';

const req = (title: string) => ({ title, confirmLabel: 'OK' });

describe('the in-app confirm (UX-07)', () => {
  test('resolves true on yes and closes', async () => {
    const q = createConfirmQueue();
    const asked = q.ask(req('Archive?'));
    expect(q.current()?.title).toBe('Archive?');
    q.answer(true);
    expect(await asked).toBe(true);
    expect(q.current()).toBeNull();
  });

  test('resolves false on no or dismiss', async () => {
    const q = createConfirmQueue();
    const asked = q.ask(req('Archive?'));
    q.answer(false);
    expect(await asked).toBe(false);
    expect(q.current()).toBeNull();
  });

  test('one question at a time: a second one answers no, the open one still decides', async () => {
    const q = createConfirmQueue();
    const first = q.ask(req('First?'));
    expect(await q.ask(req('Second?'))).toBe(false);
    expect(q.current()?.title).toBe('First?');
    q.answer(true);
    expect(await first).toBe(true);
    // Once answered, the next question opens.
    const next = q.ask(req('Next?'));
    expect(q.current()?.title).toBe('Next?');
    q.answer(false);
    expect(await next).toBe(false);
  });

  test('an answer with no open question does nothing; a second answer is ignored', async () => {
    const q = createConfirmQueue();
    q.answer(true);
    const asked = q.ask(req('Q?'));
    q.answer(false);
    q.answer(true);
    expect(await asked).toBe(false);
  });

  test('tells subscribers when a question opens and closes', () => {
    const q = createConfirmQueue();
    let calls = 0;
    const off = q.subscribe(() => calls++);
    void q.ask(req('Q?'));
    q.answer(true);
    expect(calls).toBe(2);
    off();
    void q.ask(req('Q?'));
    expect(calls).toBe(2);
  });

  test('a one-string question splits at its first blank line', () => {
    expect(
      splitQuestion(req('Remove Ann from Riverside?\n\nTheir roles here are revoked.')),
    ).toEqual({
      title: 'Remove Ann from Riverside?',
      body: 'Their roles here are revoked.',
      confirmLabel: 'OK',
    });
    expect(splitQuestion(req('Archive "X"?'))).toEqual(req('Archive "X"?'));
    const withBody = { ...req('Title\n\nkept'), body: 'given' };
    expect(splitQuestion(withBody)).toBe(withBody);
  });
});
