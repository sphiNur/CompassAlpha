/**
 * ESLint flat config for @compass/ui (review OPS-19, 2026-11-10).
 *
 * The components and hooks here run on every page, and nothing linted
 * them. Same globals and rules as apps/web's src/ (eslint.shared.mjs at
 * the repository root). CI runs it through `pnpm lint`.
 */
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { BROWSER_GLOBALS, SOURCE_RULES, TEST_RULES } from '../../eslint.shared.mjs';

export default [
  { ignores: ['dist/**', '.turbo/**', 'node_modules/**'] },

  js.configs.recommended,

  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: BROWSER_GLOBALS,
    },
    plugins: { 'react-hooks': reactHooks },
    rules: SOURCE_RULES,
  },

  {
    files: ['**/__tests__/**', '**/*.test.{ts,tsx}'],
    rules: TEST_RULES,
  },
];
