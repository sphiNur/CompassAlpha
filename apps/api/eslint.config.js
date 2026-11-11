/**
 * ESLint config for @compass/api (review OPS-19, 2026-11-10): the rules every
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
  // scripts/ is type-checked with its own tsconfig (review OPS-18).
  parserOptions: { project: ['./tsconfig.json', './tsconfig.scripts.json'] },
  // The maintenance scripts (reproject, repair, copy-catalog) report what
  // they did on the console; the api itself logs through infra/log.
  consoleFiles: ['scripts/**'],
});
