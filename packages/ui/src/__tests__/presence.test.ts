/**
 * Owner 2026-11-16: rows the person adds slide in, removed ones fold away;
 * rows there at first draw do not animate.
 */
import { describe, expect, test } from 'bun:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PresenceItem, usePresence } from '../components/Presence';

type Row = { id: string };

function List({ rows }: { rows: Row[] }): ReactElement {
  const entries = usePresence(rows, (r) => r.id);
  return createElement(
    'div',
    null,
    entries.map((e) =>
      createElement(PresenceItem, { key: e.key, phase: e.phase, children: e.item.id }),
    ),
  );
}

describe('usePresence', () => {
  test('rows there at the first draw stay still', () => {
    const html = renderToStaticMarkup(createElement(List, { rows: [{ id: 'a' }, { id: 'b' }] }));
    expect(html).toContain('data-presence="stay"');
    expect(html).not.toContain('app-reveal');
    expect(html).not.toContain('data-closing');
  });

  test('the leaving row keeps its place, inert-looking and hidden', () => {
    const html = renderToStaticMarkup(
      createElement(PresenceItem, { phase: 'leave', children: 'x' }),
    );
    expect(html).toContain('data-closing=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('class="app-reveal"');
  });

  test('an entering row animates in', () => {
    const html = renderToStaticMarkup(
      createElement(PresenceItem, { phase: 'enter', children: 'x' }),
    );
    expect(html).toContain('class="app-reveal"');
    expect(html).not.toContain('data-closing');
  });
});
