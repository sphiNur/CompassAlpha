import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chip, ChipBar, chipScrollEdges, nearestChipScroll } from '../components/Chip';

/** Review MWC-05 / MWB-17 (V8): the chip strip's edge fades and its chosen chip. */
describe('chipScrollEdges', () => {
  test('an end fades only with chips beyond it', () => {
    expect(chipScrollEdges({ scrollLeft: 0, clientWidth: 360, scrollWidth: 360 })).toEqual({
      start: false,
      end: false,
    });
    expect(chipScrollEdges({ scrollLeft: 0, clientWidth: 360, scrollWidth: 800 })).toEqual({
      start: false,
      end: true,
    });
    expect(chipScrollEdges({ scrollLeft: 200, clientWidth: 360, scrollWidth: 800 })).toEqual({
      start: true,
      end: true,
    });
    // At the end, give or take a sub-pixel.
    expect(chipScrollEdges({ scrollLeft: 439.5, clientWidth: 360, scrollWidth: 800 })).toEqual({
      start: true,
      end: false,
    });
  });
});

describe('nearestChipScroll', () => {
  const view = { scrollLeft: 100, clientWidth: 300, pad: 24 };
  test('a chip in view does not move the strip', () => {
    expect(nearestChipScroll({ ...view, chipStart: 150, chipEnd: 250 })).toBeNull();
  });
  test('a chip past the end comes in just far enough', () => {
    expect(nearestChipScroll({ ...view, chipStart: 500, chipEnd: 580 })).toBe(580 - 300 + 24);
  });
  test('a chip before the start comes in to the fade', () => {
    expect(nearestChipScroll({ ...view, chipStart: 40, chipEnd: 100 })).toBe(16);
    expect(nearestChipScroll({ ...view, chipStart: 10, chipEnd: 60 })).toBe(0);
  });
  test('a chip wider than the view shows its start', () => {
    expect(nearestChipScroll({ ...view, chipStart: 600, chipEnd: 1000 })).toBe(576);
  });
});

describe('ChipBar', () => {
  test('a scrolling strip carries the fade; a wrapping one does not', () => {
    const chip = createElement(Chip, { selected: true }, 'All');
    const strip = renderToStaticMarkup(
      createElement(ChipBar, { ariaLabel: 'Category', children: chip }),
    );
    expect(strip).toContain('chip-scroll-fade');
    const wrapped = renderToStaticMarkup(
      createElement(ChipBar, { ariaLabel: 'Category', wrap: true, children: chip }),
    );
    expect(wrapped).not.toContain('chip-scroll-fade');
  });
});
