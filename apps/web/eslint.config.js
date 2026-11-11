/**
 * ESLint flat config for @compass/web (M3.18, launch hardening 2026-05-16).
 *
 * Before this file existed, `pnpm lint` always failed with
 *   "ESLint couldn't find an eslint.config.(js|mjs|cjs) file"
 * because ESLint 9 dropped support for the older .eslintrc.* format
 * and no migration was done. The CI lint step that 2026-05-16's
 * launch-hardening pass added would therefore have been red on day one.
 *
 * CI runs `pnpm lint`. react-hooks/rules-of-hooks is enforced;
 * exhaustive-deps is on except for a baseline of older files (see the
 * note at the rule). The globals and rules for src/ are shared with
 * packages/ui (eslint.shared.mjs at the repository root, OPS-19).
 */
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { BROWSER_GLOBALS, SOURCE_RULES, TEST_RULES } from '../../eslint.shared.mjs';

export default [
  // 1) Files to ignore entirely.
  {
    ignores: [
      'dist/**',
      'build/**',
      '.vite/**',
      '.turbo/**',
      'node_modules/**',
      // ESLint can't parse these as ES modules even with --no-warn-ignored;
      // exclude declaratively so we never try.
      'vite.config.ts.timestamp-*',
    ],
  },

  // 2) Base JS recommended rules.
  js.configs.recommended,

  // 3) TypeScript recommended rules. typescript-eslint's flat preset
  //    auto-detects .ts/.tsx and applies the right parser.
  ...tseslint.configs.recommended,

  // 3b) public/: plain scripts the build copies as they are. boot-guard.js
  //     runs before (and without) the app bundle, sw.js is the service
  //     worker. COREWEB1-01 (2026-11-09): they used to be ignored, so a
  //     mistake in the one script that must work when nothing else does
  //     was caught by no one.
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2017,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        // sw.js
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      // `catch (_)`: these scripts keep the ES5 form for old WebViews.
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },

  // 4) Project overrides — turn down rules that bite the existing
  //    codebase without fixing real bugs, turn up the ones that
  //    matched audit findings.
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: BROWSER_GLOBALS,
    },
    plugins: { 'react-hooks': reactHooks },
    // The baseline files' disable comments for exhaustive-deps are
    // "unused" while the rule is off there.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: SOURCE_RULES,
  },

  // 4b) exhaustive-deps baseline: files that had findings when the rule
  //     was turned on (DX-PFE-7). Remove a file from this list once its
  //     findings are fixed; never add one.
  {
    files: [
      'src/app/PageMenuContext.tsx',
      'src/components/sales/StoreSalesPanel.tsx',
      'src/pages/DebugPage.tsx',
      'src/pages/OrderPage.tsx',
      'src/pages/RunPage.tsx',
      'src/pages/admin/people/PeopleSections.tsx',
      'src/pages/runs/components/RunPanels.tsx',
      'src/pages/runs/views/RunViews.tsx',
    ],
    rules: {
      'react-hooks/exhaustive-deps': 'off',
    },
  },

  // 4c) Review TEST3-06 (2026-11-10): P-5 (2026-10-31) — a value import
  //     from the `@compass/contracts` barrel pulls zod and every schema
  //     into the web bundle (the schema modules run `z.object(...)` at
  //     load, so they cannot be tree-shaken). Types are free; values come
  //     from the zod-free subpaths. A test used to look for this with a
  //     regex that missed `export … from`.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@compass/contracts',
              allowTypeImports: true,
              message:
                'The barrel pulls zod into the bundle: import only types from it, and values from a zod-free subpath (@compass/contracts/limits, /money, /quantity, /schemas/roles).',
            },
          ],
        },
      ],
    },
  },

  // 5) ErrorBoundary tolerates console.error as a true last-resort
  //    fallback when the structured logger itself fails.
  {
    files: ['src/app/ErrorBoundary.tsx'],
    rules: {
      'no-console': 'off',
    },
  },

  // 6) Test files: relax some rules that just create noise without
  //    catching real bugs in tests.
  {
    files: ['**/__tests__/**', '**/*.test.{ts,tsx}'],
    rules: TEST_RULES,
  },
];
