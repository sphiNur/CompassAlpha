import { expect, type Locator } from '@playwright/test';

/**
 * How much of a control a finger can actually hit, measured the way the
 * visual audit measures it (docs: 15-第二轮复核/10-视觉.md, "真实热区").
 *
 * The box size says nothing about this. A `hit-44` area can be cut off by
 * a scrolling parent (overflow clips the ::after), hidden under a sticky
 * bar, or overlapped by the next control's own area, and none of that
 * changes the button's box. So: from the centre of the control, step one
 * pixel at a time left, right, up and down, asking the browser which
 * element is under that point (`elementFromPoint`), until the answer is
 * no longer the control or something inside it. At most 30px each way,
 * so the largest reading is 61.
 */
export async function tapArea(control: Locator): Promise<{ w: number; h: number }> {
  await control.scrollIntoViewIfNeeded();
  return control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
      const at = document.elementFromPoint(x, y);
      return !!at && (at === el || el.contains(at));
    };
    if (!hit(cx, cy)) return { w: 0, h: 0 };
    const reach = (dx: number, dy: number) => {
      let d = 0;
      while (d < 30 && hit(cx + dx * (d + 1), cy + dy * (d + 1))) d++;
      return d;
    };
    return { w: reach(-1, 0) + reach(1, 0) + 1, h: reach(0, -1) + reach(0, 1) + 1 };
  });
}

/** Every control named here can be hit across at least 44×44. */
export async function expectTappable(controls: Record<string, Locator>): Promise<void> {
  const small: string[] = [];
  for (const [name, control] of Object.entries(controls)) {
    const { w, h } = await tapArea(control);
    if (w < 44 || h < 44) small.push(`${name}: ${w}x${h}`);
  }
  expect(small, 'controls whose real tap area is under 44×44').toEqual([]);
}
