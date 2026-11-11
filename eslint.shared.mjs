/**
 * What the ESLint configs of apps/web and packages/ui share (review OPS-19,
 * 2026-11-10). packages/ui, whose hooks every page uses (useDecimalField,
 * the sheets' focus handling), had no lint at all, so a hook called
 * conditionally or an effect missing a dependency reached every page
 * unseen.
 *
 * Plain data, no imports: each package brings its own ESLint and plugins,
 * which pnpm does not hoist to the root.
 */

/** Browser globals the app and the component library use. */
export const BROWSER_GLOBALS = {
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
};

/**
 * Rules for React source (src/): turn down rules that bite the existing
 * code without fixing real bugs, turn up the ones that matched audit
 * findings. Needs the react-hooks plugin registered as 'react-hooks'.
 */
export const SOURCE_RULES = {
  // Hooks called conditionally break React's hook ordering at runtime.
  'react-hooks/rules-of-hooks': 'error',
  // DX-PFE-7 (2026-11-01): on for new code. With --max-warnings 0 a
  // warning fails CI like an error. apps/web lists the files that had
  // findings when it was turned on in a baseline block of its config;
  // each fix there changes when an effect or memo re-runs, so they are
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
        'Money: use moneyLine / sumMoneyLines (apps/web/src/lib/money.ts) or the @compass/contracts/money helpers, not float multiplication (D1). Not money? Disable this line with a reason.',
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

  // `as any` turns type checking off for what follows. Warn, which
  // --max-warnings 0 makes fail, so a new one needs a disable comment
  // with its reason.
  '@typescript-eslint/no-explicit-any': 'warn',
};

/** Tests: relax rules that just create noise without catching real bugs. */
export const TEST_RULES = {
  'no-console': 'off',
  '@typescript-eslint/no-explicit-any': 'off',
};
