/**
 * Review OPS-08 (2026-11): can this machine start the browser the browser
 * smokes use? deploy.ts asks before it ships anything. A missing Chromium
 * used to show only at the smoke, with the release already live.
 *
 *   node --experimental-strip-types scripts/check-browser.ts
 *
 * PLAYWRIGHT_CHANNEL=chrome checks the installed Google Chrome instead,
 * as the smokes would use it.
 */
import { launchSmoke } from './lib/smokeHarness.ts';

try {
  const { browser } = await launchSmoke({});
  await browser.close();
  console.log('  ✓ the smoke browser starts');
} catch (err) {
  console.error(
    `✖ the smoke browser does not start: ${String((err as Error).message).split('\n')[0]}`,
  );
  process.exit(1);
}
