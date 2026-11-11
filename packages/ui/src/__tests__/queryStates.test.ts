import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyState } from '../components/EmptyState';
import { LoadingState } from '../components/LoadingState';
import { isWaitingOffline, OfflineState, PendingState } from '../components/OfflineState';

/** Review UI-13: one loading, empty and offline state, said to a screen reader. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, '');

describe('LoadingState', () => {
  test('the block is a status that says "Loading…" to a screen reader only', () => {
    const html = renderToStaticMarkup(createElement(LoadingState));
    expect(html).toMatch(/^<div role="status" class="[^"]*py-12/);
    expect(html).toContain('<svg');
    expect(html).toContain('<span class="sr-only">Loading…</span>');
  });

  test('compact is smaller and keeps the label', () => {
    const html = renderToStaticMarkup(
      createElement(LoadingState, { variant: 'compact', label: 'Loading roles…' }),
    );
    expect(html).toMatch(/^<div role="status" class="[^"]*py-6/);
    expect(textOf(html)).toBe('Loading roles…');
  });

  test('inline shows its words beside the spinner', () => {
    const html = renderToStaticMarkup(
      createElement(LoadingState, { variant: 'inline', label: 'Counting…' }),
    );
    expect(html).toMatch(/^<div role="status" class="[^"]*flex items-center gap-2/);
    expect(html).not.toContain('sr-only');
    expect(textOf(html)).toBe('Counting…');
  });
});

describe('EmptyState', () => {
  test('the full state is a heading', () => {
    const html = renderToStaticMarkup(createElement(EmptyState, { title: 'No runs yet' }));
    expect(html).toContain('<h2');
  });

  test('compact is a sentence, not a heading', () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        compact: true,
        title: 'No matches',
        description: 'Try another word',
      }),
    );
    expect(html).not.toContain('<h2');
    expect(html.match(/<p /g)).toHaveLength(2);
    expect(textOf(html)).toBe('No matchesTry another word');
  });
});

describe('offline with nothing saved', () => {
  test('is a paused query that has no data', () => {
    expect(isWaitingOffline({ data: undefined, fetchStatus: 'paused' })).toBe(true);
    expect(isWaitingOffline({ data: [], fetchStatus: 'paused' })).toBe(false);
    expect(isWaitingOffline({ data: undefined, fetchStatus: 'fetching' })).toBe(false);
    expect(isWaitingOffline({ data: undefined })).toBe(false);
  });

  test('OfflineState says so, and PendingState picks it over the spinner', () => {
    const offline = textOf(renderToStaticMarkup(createElement(OfflineState)));
    expect(offline).toStartWith('Offline');
    const pending = renderToStaticMarkup(
      createElement(PendingState, { query: { data: undefined, fetchStatus: 'paused' } }),
    );
    expect(textOf(pending)).toBe(offline);
    const loading = renderToStaticMarkup(
      createElement(PendingState, { query: { data: undefined, fetchStatus: 'fetching' } }),
    );
    expect(loading).toMatch(/^<div role="status"/);
  });
});
