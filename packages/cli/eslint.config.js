/**
 * ESLint config for @compass/cli (review OPS-19, 2026-11-10): the rules every
 * package without React shares (packageConfig in eslint.shared.mjs at the
 * repository root). CI runs it through `pnpm lint`.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { packageConfig } from '../../eslint.shared.mjs';

export default packageConfig({
  js,
  tseslint,
  dir: import.meta.dirname,
  // A command-line tool: the console is its output.
  consoleFiles: ['src/**'],
});
