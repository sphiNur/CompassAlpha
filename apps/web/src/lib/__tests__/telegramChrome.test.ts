import { describe, expect, it } from 'bun:test';
import { onColorChange } from '../telegram';

describe('onColorChange (review COREWEB2-26)', () => {
  it('paints a colour once, and again only when it changes', () => {
    const painted: string[] = [];
    const paint = onColorChange((hex) => painted.push(hex));
    for (const hex of ['#ffffff', '#ffffff', '#ffffff', '#1c1c1e', '#1c1c1e', '#ffffff']) {
      paint(hex);
    }
    expect(painted).toEqual(['#ffffff', '#1c1c1e', '#ffffff']);
  });

  it('skips a colour that could not be read', () => {
    const painted: string[] = [];
    const paint = onColorChange((hex) => painted.push(hex));
    paint(null);
    paint('#000000');
    paint(null);
    expect(painted).toEqual(['#000000']);
  });
});
