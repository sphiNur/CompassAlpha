/**
 * What the ESLint configs of the workspace packages share (review OPS-19,
 * 2026-11-10). Only apps/web was linted. packages/ui, whose hooks every
 * page uses (useDecimalField, the sheets' focus handling), had no lint, so
 * a hook called conditionally or an effect missing a dependency reached
 * every page unseen; the server side had none either (packageConfig).
 *
 * No imports: each package brings its own ESLint and plugins, which pnpm
 * does not hoist to the root, and passes them to packageConfig.
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
  // DX-PFE-7 (2026-11-01). With --max-warnings 0 a warning fails CI like
  // an error. The files that had findings when it was turned on were
  // fixed one at a time; the last left apps/web's baseline in review
  // ADM1-29 (2026-11-12).
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
    {
      // DX-COPY-8 (2026-11-01): a failed write says what to do next. The
      // bare "Something went wrong" is the title of a load banner with a
      // Retry button, not a toast. In apps/web the fallback of
      // useErrToast and useTranslateError cannot be it (WriteFallbackKey);
      // this catches a toast written by hand (review TEST3-06: a test
      // looked for both with a regular expression).
      selector:
        "CallExpression[callee.property.name='error'][arguments.0.type='CallExpression'][arguments.0.arguments.0.value='common.error']",
      message:
        "A failed write says what to do next: use the action's own failure sentence or common.errors.actionFailed, not common.error (DX-COPY-8).",
    },
  ],

  // No raw console.log/debug/info. M3.18 (launch hardening): a
  // leftover console.log(tsv) leaked exported rows to the browser
  // console. A CI grep did this until ESLint linted apps/api too
  // (OPS-19). console.warn / console.error are still allowed
  // (legitimate warning paths in long-running code).
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

/**
 * Rules that read the types, so they need typescript-eslint's parser with
 * a tsconfig. A promise nobody awaits or catches fails without a trace, or
 * ends the process as an unhandled rejection far from the line that
 * dropped it.
 */
export const PROMISE_RULES = {
  '@typescript-eslint/no-floating-promises': 'error',
  // An async function where the caller expects a plain one (an event
  // listener, a forEach callback): its rejection goes nowhere.
  '@typescript-eslint/no-misused-promises': 'error',
};

/**
 * The whole ESLint config of a TypeScript package without React: apps/api,
 * apps/worker, apps/bot and the shared packages. They had no lint, and the
 * eslint-disable comments in apps/api answered a linter that never ran.
 * SOURCE_RULES without its React and apps/web rules, and PROMISE_RULES.
 *
 *   js, tseslint   the package's own @eslint/js and typescript-eslint
 *   dir            the package's directory (import.meta.dirname)
 *   parserOptions  where the types come from, when each file's nearest
 *                  tsconfig.json does not cover it
 *   consoleFiles   files whose output is the console: a worker or a bot
 *                  logging to the journal, a command-line tool
 */
export function packageConfig({
  js,
  tseslint,
  dir,
  parserOptions = { projectService: true },
  consoleFiles = [],
}) {
  const {
    'react-hooks/rules-of-hooks': _hooks,
    'react-hooks/exhaustive-deps': _deps,
    'no-restricted-syntax': _webOnly,
    ...rules
  } = SOURCE_RULES;
  return [
    { ignores: ['dist/**', '.turbo/**', 'node_modules/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ['**/*.ts'],
      languageOptions: { parserOptions: { ...parserOptions, tsconfigRootDir: dir } },
      rules: { ...rules, ...PROMISE_RULES },
    },
    ...(consoleFiles.length > 0 ? [{ files: consoleFiles, rules: { 'no-console': 'off' } }] : []),
    { files: ['**/__tests__/**', '**/*.test.ts'], rules: TEST_RULES },
  ];
}
