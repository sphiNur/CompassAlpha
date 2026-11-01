import { describe, expect, it } from 'bun:test';
import { shareRoute } from '../telegramLinks';

describe('shareRoute (DX-BUY-4)', () => {
  it("uses Telegram's picker only inside Telegram", () => {
    expect(shareRoute(true, true)).toBe('telegram');
    expect(shareRoute(true, false)).toBe('telegram');
  });
  it('outside Telegram never opens t.me: the system share sheet, else copy', () => {
    expect(shareRoute(false, true)).toBe('system');
    expect(shareRoute(false, false)).toBe('copy');
  });
});
