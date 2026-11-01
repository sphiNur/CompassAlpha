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
 * note at the rule).
 */
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default [
  // 1) Files to ignore entirely.
  {
    ignores: [
      'dist/**',
      'build/**',
      '.vite/**',
      '.turbo/**',
      'node_modules/**',
      // public/ is vanilla browser JS served at /public/* paths.
      // It uses runtime browser globals (window, document, etc.) and
      // has no module system. The build copies it into dist as-is.
      // Lint with a browser-globals config separately if we ever
      // want to enforce style on these files.
      'public/**',
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

  // 4) Project overrides — turn down rules that bite the existing
  //    codebase without fixing real bugs, turn up the ones that
  //    matched audit findings.
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Browser globals available everywhere in apps/web.
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        crypto: 'readonly',
        IDBDatabase: 'readonly',
        IDBOpenDBRequest: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        MessageEvent: 'readonly',
        WebSocket: 'readonly',
        AbortController: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
        CustomEvent: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLDivElement: 'readonly',
        Element: 'readonly',
        Node: 'readonly',
        FormData: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        Blob: 'readonly',
        Image: 'readonly',
        XMLHttpRequest: 'readonly',
        MediaQueryListEvent: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        TouchEvent: 'readonly',
        PointerEvent: 'readonly',
        process: 'readonly',
      },
    },
    plugins: { 'react-hooks': reactHooks },
    // The baseline files' disable comments for exhaustive-deps are
    // "unused" while the rule is off there.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      // Hooks called conditionally break React's hook ordering at runtime.
      'react-hooks/rules-of-hooks': 'error',
      // DX-PFE-7 (2026-11-01): on for new code. With --max-warnings 0 a
      // warning fails CI like an error. The files that had findings when
      // it was turned on are listed in the baseline block below; each
      // fix there changes when an effect or memo re-runs, so they are
      // migrated one file at a time, not in bulk.
      'react-hooks/exhaustive-deps': 'warn',

      // DX-PFE-12 (2026-11-01): money is qty × price rounded half-up to
      // cents and added in cents (D1). `Number(price) * Number(qty)` in
      // display code drifted a cent from the server's figure.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            // Scaling by a literal (`Number(v) * 1000` to thousandths) is
            // not a money line and is allowed.
            "BinaryExpression[operator='*']:not([left.type='Literal']):not([right.type='Literal']) > CallExpression[callee.name=/^(Number|parseFloat)$/]",
          message:
            'Money: use moneyLine / sumMoneyLines (src/lib/money.ts) or the @compass/contracts/money helpers, not float multiplication (D1). Not money? Disable this line with a reason.',
        },
      ],

      // No raw console.log/debug/info — matches the CI grep guard.
      // console.warn / console.error are still allowed (legitimate
      // warning paths in long-running code).
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // Allow underscore-prefixed unused parameters and variables —
      // the codebase uses them deliberately (e.g. `_opts` in callbacks
      // whose signature is fixed by the caller).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // Plain 'no-unused-vars' fights the TS one on type imports.
      'no-unused-vars': 'off',

      // Empty catches are a real anti-pattern — surface them.
      'no-empty': ['error', { allowEmptyCatch: false }],

      // Allow ts-expect-error with a clear comment so legitimate
      // escape hatches don't need bare @ts-ignore.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],

      // The codebase uses `as any` in a few places (5 in apps/api's
      // trpc middleware, 0 in web). Web SHOULD stay clean; warn so
      // new ones are surfaced but don't break the build on day one.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
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
      'src/pages/SettlementPage.tsx',
      'src/pages/admin/operations/OperationsSections.tsx',
      'src/pages/admin/people/PeopleSections.tsx',
      'src/pages/admin/stores/StoresSections.tsx',
      'src/pages/runs/components/RunPanels.tsx',
      'src/pages/runs/views/RunViews.tsx',
    ],
    rules: {
      'react-hooks/exhaustive-deps': 'off',
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
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
