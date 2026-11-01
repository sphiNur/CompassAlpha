import { describe, expect, test } from 'bun:test';
import { checkBudget, startupScripts } from '../check-entry-budget';

const HTML = `<!doctype html><html><head>
<script src="https://telegram.org/js/telegram-web-app.js" defer></script>
<script src="/boot-guard.js"></script>
<script type="module" crossorigin src="/assets/index-abc.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-def.js">
<link rel="stylesheet" href="/assets/index.css">
</head></html>`;

describe('check-entry-budget (DX-PFE-2)', () => {
  test('counts the module entry and its modulepreloads, nothing else', () => {
    expect(startupScripts(HTML)).toEqual(['/assets/index-abc.js', '/assets/vendor-def.js']);
  });

  test('passes within the budget and fails over it', () => {
    const small = Buffer.from('x'.repeat(100));
    // Incompressible bytes (a simple LCG), so gzip cannot shrink them.
    let seed = 1;
    const random = Buffer.from(
      Array.from({ length: 4000 }, () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) >> 23),
    );
    expect(checkBudget(HTML, () => small, 10_000).ok).toBe(true);
    const over = checkBudget(HTML, () => random, 1_000);
    expect(over.ok).toBe(false);
    expect(over.files).toHaveLength(2);
    expect(over.gzipTotal).toBeGreaterThan(1_000);
  });

  test('refuses a page without a module script', () => {
    expect(() => checkBudget('<html></html>', () => Buffer.alloc(0))).toThrow();
  });
});
