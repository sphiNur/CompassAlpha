import { describe, expect, test } from 'bun:test';
import { verifyInitData } from '../../services/telegramAuth';
import { freshTgId, signInitData } from './telegram';

describe('Telegram identities for tests', () => {
  test('100 fresh ids in a row all differ, and each is one an invite accepts', () => {
    const ids = Array.from({ length: 100 }, () => freshTgId());
    expect(new Set(ids).size).toBe(100);
    for (const id of ids) expect(String(id)).toMatch(/^\d{4,15}$/);
  });

  test('signed initData passes the server check and carries the user', () => {
    const before = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = '222222:helper-test';
    try {
      const id = freshTgId();
      const initData = signInitData(id, { firstName: 'Ann', languageCode: 'uz' });
      const result = verifyInitData(initData, '222222:helper-test');
      expect(result.ok).toBe(true);
      expect(result.user).toMatchObject({
        id: Number(id),
        first_name: 'Ann',
        username: `u${id}`,
        language_code: 'uz',
      });
    } finally {
      if (before === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = before;
    }
  });
});
