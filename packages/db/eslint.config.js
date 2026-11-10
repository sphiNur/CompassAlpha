/**
 * ESLint config for @compass/db (review OPS-19, 2026-11-10): the rules every
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
  // drizzle.config.ts is outside src/, which tsconfig.json covers.
  parserOptions: { projectService: { allowDefaultProject: ['drizzle.config.ts'] } },
  // The command-line scripts print what they do; the rest of the package
  // is a library and does not.
  consoleFiles: [
    'src/migrate.ts',
    'src/seed.ts',
    'src/import-catalog.ts',
    'src/audit-sku-catalog.ts',
    'src/list-tables.ts',
    'src/purge-fake-data.ts',
  ],
});
