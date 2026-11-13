/**
 * The tap area of every visible control on a screen, measured in the page
 * the way a finger meets it (review WALK-03, 2026-11-13).
 *
 * A control is a button, a link, a form field, an ARIA widget role, or
 * anything whose own cursor is a pointer (a clickable row). Its tap area
 * is where a tap lands on it: `document.elementFromPoint` is walked
 * outwards from the control's centre along both axes, so the kit's
 * `hit-44` ::after counts, and so does a parent that clips it or a
 * neighbour that covers it. A control that takes no pointer events (a
 * disabled Button) gets its box widened by its ::after instead.
 *
 * `measureTapTargets` runs inside the page (page.evaluate): it must not
 * use anything from this module's scope.
 */

export interface TapTarget {
  /** The control's accessible name or text, shortened. */
  label: string;
  tag: string;
  role: string | null;
  testId: string | null;
  /** The first classes, to find the source. */
  classes: string;
  /** Border box. */
  box: { w: number; h: number };
  /** Where a tap lands on it. */
  tap: { w: number; h: number };
  /** How `tap` was found: hit-tested, or estimated from the box and ::after. */
  how: 'hit' | 'estimate';
  /** A link or button that sits inside a line of text. */
  inline: boolean;
  /** Inside a dialog (a sheet). */
  inDialog: boolean;
}

export function measureTapTargets(scope: 'page' | 'dialog'): TapTarget[] {
  const MIN = 44;
  const SELECTOR = [
    'button',
    'a[href]',
    'input:not([type=hidden])',
    'select',
    'textarea',
    'summary',
    '[role=button]',
    '[role=tab]',
    '[role=radio]',
    '[role=checkbox]',
    '[role=switch]',
    '[role=menuitem]',
    '[role=option]',
    '[role=link]',
  ].join(',');

  const dialogs = [
    ...document.querySelectorAll<HTMLElement>('[role=dialog],[role=alertdialog]'),
  ].filter((d) => d.getClientRects().length > 0);
  const roots: Element[] = scope === 'dialog' ? dialogs : [document.body];

  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (el.closest('[aria-hidden="true"],[inert]')) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    for (let a: Element | null = el; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (Number(s.opacity) === 0) return false;
      if (s.display === 'none') return false;
    }
    return true;
  };

  const isControl = (el: Element): boolean => {
    if (el.matches(SELECTOR)) return true;
    const cs = getComputedStyle(el);
    if (cs.cursor !== 'pointer') return false;
    // cursor is inherited: only the element that sets it.
    const parent = el.parentElement;
    return !parent || getComputedStyle(parent).cursor !== 'pointer';
  };

  /** The label a tap on this field goes through, when the field itself is hidden in it. */
  const wrappingLabel = (el: Element): HTMLLabelElement | null => {
    const label = el.closest('label');
    return label && (label as HTMLLabelElement).control === el ? (label as HTMLLabelElement) : null;
  };

  const nameOf = (el: Element): string => {
    const h = el as HTMLElement & { placeholder?: string; value?: string };
    const text =
      el.getAttribute('aria-label') ||
      (el.getAttribute('aria-labelledby')
        ? el
            .getAttribute('aria-labelledby')!
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.innerText ?? '')
            .join(' ')
        : '') ||
      h.innerText ||
      el.getAttribute('title') ||
      h.placeholder ||
      (el.tagName === 'INPUT' ? `[${(el as HTMLInputElement).type}]` : '') ||
      el.getAttribute('name') ||
      '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 70);
  };

  const pseudoSize = (el: Element): { w: number; h: number } | null => {
    const s = getComputedStyle(el, '::after');
    if (!s.content || s.content === 'none' || s.content === 'normal') return null;
    if (s.position !== 'absolute' && s.position !== 'fixed') return null;
    const w = parseFloat(s.width);
    const h = parseFloat(s.height);
    return Number.isFinite(w) && Number.isFinite(h) ? { w, h } : null;
  };

  const isInline = (el: Element): boolean => {
    if (getComputedStyle(el).display !== 'inline') return false;
    const parent = el.parentElement;
    if (!parent) return false;
    const own = (el as HTMLElement).innerText.trim().length;
    return parent.innerText.trim().length > own + 3;
  };

  // The span a tap still lands on `el` (or what's inside it), from its
  // centre outwards along one axis.
  const span = (el: Element, cx: number, cy: number, axis: 'x' | 'y', reach: number): number => {
    const owns = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
      const hit = document.elementFromPoint(x, y);
      if (!hit) return false;
      if (el.contains(hit)) return true;
      // A field tapped through its label.
      const label = hit.closest('label') as HTMLLabelElement | null;
      return !!label && label.control === el;
    };
    if (!owns(cx, cy)) return 0;
    let lo = 0;
    let hi = 0;
    for (let d = 1; d <= reach; d++) {
      if (axis === 'x' ? owns(cx - d, cy) : owns(cx, cy - d)) lo = d;
      else break;
    }
    for (let d = 1; d <= reach; d++) {
      if (axis === 'x' ? owns(cx + d, cy) : owns(cx, cy + d)) hi = d;
      else break;
    }
    return lo + hi + 1;
  };

  const out: TapTarget[] = [];
  const seen = new Set<Element>();
  for (const root of roots) {
    for (const el of root.querySelectorAll('*')) {
      if (seen.has(el)) continue;
      if (scope === 'page' && dialogs.some((d) => d.contains(el))) continue;
      // A visually hidden checkbox / radio / switch is tapped through its
      // label; with no label, nothing on screen taps it.
      if (el.matches('input[type=checkbox],input[type=radio]') && !visible(el)) {
        const input = el as HTMLInputElement;
        const label = input.labels?.[0];
        const shown = input.parentElement;
        if (input.closest('[aria-hidden="true"],[inert]') || !shown || !visible(shown)) continue;
        if (label && visible(label)) continue; // the label is measured as a control
        seen.add(el);
        const r = shown.getBoundingClientRect();
        out.push({
          label: nameOf(el) || nameOf(shown),
          tag: 'input',
          role: el.getAttribute('role') ?? input.type,
          testId: el.getAttribute('data-testid'),
          classes: `(no label) ${(shown.getAttribute('class') ?? '').slice(0, 140)}`,
          box: { w: Math.round(r.width), h: Math.round(r.height) },
          tap: { w: 0, h: 0 },
          how: 'hit',
          inline: false,
          inDialog: dialogs.some((d) => d.contains(el)),
        });
        continue;
      }
      if (!isControl(el) || !visible(el)) continue;
      seen.add(el);
      // A field inside the label that taps it: the label is measured.
      if (wrappingLabel(el) && el.matches('input,[role=switch],[role=checkbox],button')) {
        const label = wrappingLabel(el)!;
        if (isControl(label)) continue;
      }
      // An element inside a control that is the same tap (a span in a button).
      const outer = el.parentElement?.closest(SELECTOR);
      if (outer && !el.matches(SELECTOR)) continue;
      const box = el.getBoundingClientRect();
      const boxSize = { w: Math.round(box.width), h: Math.round(box.height) };
      let tap = { ...boxSize };
      let how: TapTarget['how'] = 'estimate';
      if (box.width < MIN - 0.5 || box.height < MIN - 0.5) {
        const pe = getComputedStyle(el).pointerEvents;
        if (pe !== 'none') {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          const r = el.getBoundingClientRect();
          const cx = Math.floor(r.left + r.width / 2);
          const cy = Math.floor(r.top + r.height / 2);
          const w = span(el, cx, cy, 'x', 60);
          const h = span(el, cx, cy, 'y', 60);
          if (w > 0 && h > 0) {
            tap = { w, h };
            how = 'hit';
          }
        }
        if (how === 'estimate') {
          const p = pseudoSize(el);
          if (p)
            tap = {
              w: Math.max(boxSize.w, Math.round(p.w)),
              h: Math.max(boxSize.h, Math.round(p.h)),
            };
        }
      }
      out.push({
        label: nameOf(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        testId: el.getAttribute('data-testid'),
        classes: (el.getAttribute('class') ?? '').slice(0, 160),
        box: boxSize,
        tap,
        how,
        inline: isInline(el),
        inDialog: dialogs.some((d) => d.contains(el)),
      });
    }
  }
  return out;
}
