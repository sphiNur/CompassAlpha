import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Avatar, avatarInitials } from '../components/Avatar';

/** Review UI-24. */
describe('avatarInitials', () => {
  test('first letter of the first two words', () => {
    expect(avatarInitials('Smoke Admin')).toBe('SA');
    expect(avatarInitials('ivan petrov sidorov')).toBe('IP');
    expect(avatarInitials('Иван Петров')).toBe('ИП');
    expect(avatarInitials('Oʻtkir Smoke')).toBe('OS');
    expect(avatarInitials('张伟')).toBe('张');
  });

  test('a name that starts with an emoji gives letters, not half a surrogate pair', () => {
    expect(avatarInitials('🌟 Anna')).toBe('A');
    expect(avatarInitials('🌟Anna Smoke')).toBe('AS');
    expect(avatarInitials('🇺🇿 Smoke Store')).toBe('SS');
    expect(avatarInitials('Anna (Smoke Store)')).toBe('AS');
    expect(avatarInitials('🌟 Anna')).not.toContain(String.fromCharCode(0xfffd));
  });

  test('no letter at all, or no name, is a question mark', () => {
    expect(avatarInitials('🌟🌟')).toBe('?');
    expect(avatarInitials('')).toBe('?');
    expect(avatarInitials('   ')).toBe('?');
  });
});

describe('Avatar', () => {
  test('is decorative by default: the name beside it is what is read', () => {
    const photo = renderToStaticMarkup(
      createElement(Avatar, { src: 'https://example.test/a.jpg', name: 'Smoke Admin' }),
    );
    expect(photo).toContain('alt=""');
    const initials = renderToStaticMarkup(createElement(Avatar, { name: 'Smoke Admin' }));
    expect(initials).toContain('aria-hidden="true"');
    expect(initials).not.toContain('aria-label');
    expect(initials).toContain('>SA</span>');
  });

  test('a label makes it an image with that name', () => {
    const photo = renderToStaticMarkup(
      createElement(Avatar, {
        src: 'https://example.test/a.jpg',
        name: 'Smoke Admin',
        label: 'Smoke Admin',
      }),
    );
    expect(photo).toContain('alt="Smoke Admin"');
    const initials = renderToStaticMarkup(
      createElement(Avatar, { name: 'Smoke Admin', label: 'Smoke Admin' }),
    );
    expect(initials).toContain('role="img"');
    expect(initials).toContain('aria-label="Smoke Admin"');
    expect(initials).not.toContain('aria-hidden');
  });
});
