import { describe, expect, test } from 'bun:test';
import { landingTab, type Tab } from '../navStore';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const everything: Tab[] = ['menu', 'order', 'approve', 'run', 'confirm', 'settlement'];

describe('where the app opens', () => {
  test('someone with one job goes straight to it', () => {
    expect(landingTab('menu', 0, ['run'], ['menu', 'run'], NOW)).toBe('run');
    // Even if they were last looking at something else a moment ago.
    expect(landingTab('menu', NOW - MINUTE, ['order'], ['menu', 'order'], NOW)).toBe('order');
  });

  test('a first visit with several jobs starts on Today', () => {
    expect(landingTab('menu', 0, ['order', 'approve'], everything, NOW)).toBe('menu');
  });

  test('coming back within half an hour resumes where they were', () => {
    expect(landingTab('run', NOW - 10 * MINUTE, ['approve', 'run'], everything, NOW)).toBe('run');
  });

  test('coming back later starts on Today again', () => {
    expect(landingTab('run', NOW - 31 * MINUTE, ['approve', 'run'], everything, NOW)).toBe('menu');
  });

  test('a remembered screen they can no longer open is not resumed', () => {
    expect(
      landingTab('admin', NOW - MINUTE, ['order', 'approve'], ['menu', 'order', 'approve'], NOW),
    ).toBe('menu');
  });
});
