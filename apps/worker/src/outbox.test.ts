import { describe, expect, test } from 'bun:test';
import {
  BACKOFF_SECONDS,
  botMessage,
  DEFAULT_BUTTON_TEXT,
  MAX_RETRIES,
  nextAttempt,
  outboxPayloadProblem,
  resolveDeepLink,
} from './outbox';

const OK = {
  orgId: 'o1',
  recipientUserId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  template: 'order.submitted',
  title: 'New order',
  body: 'Store A · 12 items',
  deepLink: '/approve?store=s1',
};

describe('outboxPayloadProblem (COREAPI-03)', () => {
  test('a payload as dispatch writes it can be sent', () => {
    expect(outboxPayloadProblem(OK)).toBeNull();
    expect(outboxPayloadProblem({ ...OK, body: '', deepLink: '' })).toBeNull();
    const { body: _body, deepLink: _link, ...bare } = OK;
    expect(outboxPayloadProblem(bare)).toBeNull();
  });

  test('says why a payload can never be sent', () => {
    expect(outboxPayloadProblem(null)).toBe('payload is not an object');
    expect(outboxPayloadProblem('text')).toBe('payload is not an object');
    expect(outboxPayloadProblem([OK])).toBe('payload is not an object');
    expect(outboxPayloadProblem({ ...OK, recipientUserId: 'u1' })).toBe(
      'recipientUserId is not a uuid',
    );
    expect(outboxPayloadProblem({ ...OK, recipientUserId: undefined })).toBe(
      'recipientUserId is not a uuid',
    );
    expect(outboxPayloadProblem({ ...OK, title: undefined })).toBe('title is missing');
    expect(outboxPayloadProblem({ ...OK, title: '  ' })).toBe('title is missing');
    expect(outboxPayloadProblem({ ...OK, body: 3 })).toBe('body is not text');
    expect(outboxPayloadProblem({ ...OK, deepLink: { path: '/' } })).toBe('deepLink is not text');
  });
});

describe('botMessage', () => {
  test('escapes the title and body for MarkdownV2', () => {
    const { text, opts } = botMessage({ ...OK, title: 'Order #12', body: 'Total: 1.5' }, undefined);
    expect(text).toBe('*Order \\#12*\nTotal: 1\\.5');
    expect(opts.parse_mode).toBe('MarkdownV2');
  });

  test('a title alone, and no button without a link', () => {
    const { text, opts } = botMessage({ ...OK, body: '', deepLink: '' }, 'https://app.example');
    expect(text).toBe('*New order*');
    expect(opts.reply_markup).toBeUndefined();
  });

  test('the button opens the link on the app', () => {
    const { opts } = botMessage(OK, 'https://app.example/');
    expect(opts.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: 'Open Compass', web_app: { url: 'https://app.example/approve?store=s1' } }],
      ],
    });
  });

  test("COREAPI-19: the button carries the label the API wrote, in the recipient's language", () => {
    const label = (payload: unknown) =>
      (
        botMessage(payload as typeof OK, 'https://app.example').opts.reply_markup as {
          inline_keyboard: { text: string }[][];
        }
      ).inline_keyboard[0]![0]!.text;
    expect(label({ ...OK, buttonText: '打开 Compass' })).toBe('打开 Compass');
    expect(label({ ...OK, buttonText: 'Compassʼni ochish' })).toBe('Compassʼni ochish');
    // A row queued before the label existed, or one that is blank or not text.
    expect(label(OK)).toBe(DEFAULT_BUTTON_TEXT);
    expect(label({ ...OK, buttonText: '  ' })).toBe(DEFAULT_BUTTON_TEXT);
    expect(label({ ...OK, buttonText: 42 })).toBe(DEFAULT_BUTTON_TEXT);
  });
});

describe('resolveDeepLink', () => {
  test('joins a path to the app address', () => {
    expect(resolveDeepLink('/run', 'https://app.example/')).toBe('https://app.example/run');
    expect(resolveDeepLink('run', 'https://app.example')).toBe('https://app.example/run');
  });

  test('keeps a full address, and a path when there is no app address', () => {
    expect(resolveDeepLink('https://t.me/x', 'https://app.example')).toBe('https://t.me/x');
    expect(resolveDeepLink('/run', undefined)).toBe('/run');
  });
});

describe('nextAttempt', () => {
  test('backs off, then gives up after MAX_RETRIES tries', () => {
    expect(nextAttempt(0)).toEqual({
      giveUp: false,
      retries: 1,
      delaySeconds: BACKOFF_SECONDS[1]!,
    });
    expect(nextAttempt(MAX_RETRIES - 2)).toEqual({
      giveUp: false,
      retries: MAX_RETRIES - 1,
      delaySeconds: BACKOFF_SECONDS[MAX_RETRIES - 1]!,
    });
    expect(nextAttempt(MAX_RETRIES - 1)).toEqual({ giveUp: true });
  });
});
