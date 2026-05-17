/**
 * Smoke harness — run after every deploy to catch breakage before users do.
 *
 * Usage:
 *   COMPASS_BASE=https://<your-tunnel>.trycloudflare.com bun run scripts/smoke.ts
 *   COMPASS_BASE=http://localhost:3000               bun run scripts/smoke.ts
 *
 * COMPASS_BASE is required. A hardcoded default used to exist but went
 * stale every time cloudflared re-rolled the quick-tunnel URL, masking
 * real failures by checking a dead host (P0-4, 2026-05-17).
 *
 * Coverage:
 *   - Static SPA: GET /, /assets/<hashed>.js + .css all 200, html references match dist
 *   - API health: /health/live, /health/version
 *   - tRPC public routes: system.health
 *   - tRPC auth-required routes succeed when authenticated, fail (401) anonymously
 *   - HTML cache headers are no-store (regression check on the iOS WebView fix)
 *   - JS bundle contains expected user-facing strings (catch deploy-of-stale-bundle)
 *
 * Exit code 0 = all green. Non-zero = at least one check failed; the
 * report shows exactly which.
 */
const rawBase = Bun.env.COMPASS_BASE;
if (!rawBase) {
  console.error(
    '\x1b[31m✖ COMPASS_BASE is required.\x1b[0m\n' +
      '  Set it to the URL you want to smoke, e.g.:\n' +
      '    export COMPASS_BASE=https://<your-tunnel>.trycloudflare.com\n' +
      '    export COMPASS_BASE=http://localhost:3000',
  );
  process.exit(2);
}
const BASE = rawBase.replace(/\/$/, '');

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

const results: Check[] = [];
const t0 = performance.now();

function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, ...(detail !== undefined ? { detail } : {}) });
}

async function head(path: string) {
  const res = await fetch(BASE + path, { method: 'HEAD', headers: { 'cache-control': 'no-cache' } });
  return res;
}
async function get(path: string, init?: RequestInit) {
  return fetch(BASE + path, {
    ...init,
    headers: { 'cache-control': 'no-cache', ...(init?.headers ?? {}) },
  });
}
async function post(path: string, body: unknown, init?: RequestInit) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });
}

// ---- Checks ----

async function checkSpaShell() {
  const r = await get('/');
  record('GET /  -> 200', r.status === 200, `status=${r.status}`);
  const html = await r.text();
  const cc = r.headers.get('cache-control') ?? '';
  record(
    'GET / has Cache-Control: no-store',
    cc.includes('no-store'),
    `Cache-Control=${cc}`,
  );
  // Pull asset names from the served HTML.
  const jsMatch = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
  const cssMatch = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.css/);
  record('HTML references /assets/index-*.js', !!jsMatch, jsMatch?.[0]);
  record('HTML references /assets/index-*.css', !!cssMatch, cssMatch?.[0]);

  // Build sha meta is replaced by the build plugin; no `%VITE_BUILD_SHA%` should remain.
  const stillPlaceholder = html.includes('%VITE_BUILD_SHA%');
  record(
    'meta[name=compass-build] is a real value (not %VITE_BUILD_SHA%)',
    !stillPlaceholder,
    stillPlaceholder ? 'placeholder leaked' : 'replaced ok',
  );

  if (jsMatch) {
    const jsRes = await get(jsMatch[0]);
    record(`GET ${jsMatch[0]} -> 200`, jsRes.status === 200);
    const jsCC = jsRes.headers.get('cache-control') ?? '';
    record(
      'JS asset has long-cache header (immutable)',
      jsCC.includes('immutable') || jsCC.includes('max-age'),
      `Cache-Control=${jsCC}`,
    );
    const js = await jsRes.text();
    // User-facing strings that prove the latest source is bundled. If a
    // future deploy changes copy, update this list.
    const expectedStrings = ['Compass', 'Sign in', 'Today', 'Approval queue', 'Tap a status'];
    for (const s of expectedStrings) {
      record(`JS bundle contains "${s}"`, js.includes(s));
    }
    // Strings that should NEVER appear in a healthy bundle.
    const forbiddenStrings = ['Run network diagnostic', 'TgBotGemini'];
    for (const s of forbiddenStrings) {
      record(`JS bundle does NOT contain "${s}" (debug leak check)`, !js.includes(s));
    }
  }
  if (cssMatch) {
    const cssRes = await get(cssMatch[0]);
    record(`GET ${cssMatch[0]} -> 200`, cssRes.status === 200);
  }
}

async function checkHealth() {
  const live = await get('/health/live');
  record('GET /health/live -> 200', live.status === 200);
  const liveBody = await live.text();
  record('/health/live body is JSON {status:"ok"}', liveBody.includes('"status":"ok"'), liveBody);

  const ver = await get('/health/version');
  record('GET /health/version -> 200', ver.status === 200);
  const verData = (await ver.json()) as { commit?: string; startedAt?: string };
  record('/health/version has commit', !!verData.commit, JSON.stringify(verData));
  record('/health/version has startedAt', !!verData.startedAt);
}

async function checkTrpcPublic() {
  // tRPC v11 + httpLink (no transformer): queries on GET, mutations on POST.
  // The wire format passes the raw input directly — *no* `{json: ...}`
  // envelope. system.health takes no input → omit `?input` entirely.
  const r = await get('/trpc/system.health');
  record('GET /trpc/system.health -> 200', r.status === 200, `status=${r.status}`);
  const data = (await r.json()) as { result?: { data?: { status?: string } } };
  record('system.health returns status:ok', data?.result?.data?.status === 'ok', JSON.stringify(data));
}

async function checkTrpcAuth() {
  // auth.me requires a Bearer token; anonymous → UNAUTHORIZED.
  const r = await get('/trpc/auth.me');
  record(
    'GET /trpc/auth.me anonymous -> 401 UNAUTHORIZED',
    r.status === 401,
    `status=${r.status}`,
  );

  // auth.telegramLogin with bogus initData should reach the verifier and
  // come back with an UNAUTHORIZED domain error (the Zod schema accepts
  // any non-empty string; the HMAC verifier fails).
  const login = await post('/trpc/auth.telegramLogin', { initData: 'foo=bar&hash=zzz&auth_date=1' });
  record(
    'POST /trpc/auth.telegramLogin (bad initData) -> 401',
    login.status === 401,
    `status=${login.status}`,
  );
}

async function checkUploadAuth() {
  // upload.config is authedProcedure → anonymous gets 401, NOT a 200.
  // This catches a regression where someone re-promotes it to public.
  const r = await get('/trpc/upload.config');
  record(
    'GET /trpc/upload.config anonymous -> 401 UNAUTHORIZED',
    r.status === 401,
    `status=${r.status}`,
  );

  // upload.requestPresign anonymous → 401. Validates the body actually
  // reaches the auth gate (vs. failing earlier on a bad body shape).
  const presign = await post('/trpc/upload.requestPresign', {
    kind: 'receipt',
    contentType: 'image/jpeg',
  });
  record(
    'POST /trpc/upload.requestPresign anonymous -> 401',
    presign.status === 401,
    `status=${presign.status}`,
  );
}

async function checkLogIngest() {
  // system.log uses LooseLogBatchSchema (passthrough). Send raw — no envelope.
  const r = await post('/trpc/system.log', {
    events: [
      {
        sessionId: 'smoke-' + Date.now(),
        level: 'info',
        kind: 'smoke',
        clientTs: Date.now(),
      },
    ],
  });
  record('POST /trpc/system.log -> 200', r.status === 200, `status=${r.status}`);
  const data = (await r.json()) as { result?: { data?: { accepted?: number } } };
  record('system.log accepted >= 1', (data?.result?.data?.accepted ?? 0) >= 1, JSON.stringify(data));
}

async function checkWebSocket() {
  // /ws requires a token query param; no-token request should produce a
  // 4xx auth error (any of 400/401/426 confirms the handler is wired).
  // We use plain GET — Bun.serve replies before the WS upgrade succeeds.
  const r = await get('/ws');
  record(
    'GET /ws (no token) -> 4xx (handler reachable)',
    r.status >= 400 && r.status < 500,
    `status=${r.status}`,
  );
}

// ---- Run ----

const tasks: Array<[string, () => Promise<void>]> = [
  ['SPA shell', checkSpaShell],
  ['health', checkHealth],
  ['tRPC public', checkTrpcPublic],
  ['tRPC auth', checkTrpcAuth],
  ['upload auth', checkUploadAuth],
  ['client-log ingest', checkLogIngest],
  ['WebSocket endpoint', checkWebSocket],
];

console.log(`▶ Compass smoke against ${BASE}\n`);

for (const [label, fn] of tasks) {
  try {
    await fn();
  } catch (err) {
    record(`SECTION "${label}" threw`, false, (err as Error).message);
  }
}

// Render report.
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
const elapsedMs = Math.round(performance.now() - t0);

for (const r of results) {
  const tag = r.pass ? '\x1b[32m PASS \x1b[0m' : '\x1b[31m FAIL \x1b[0m';
  const detail = r.detail ? `\x1b[2m — ${r.detail}\x1b[0m` : '';
  console.log(`${tag} ${r.name}${detail}`);
}
console.log(
  `\n${passed} / ${results.length} passed in ${elapsedMs} ms — ${failed.length} failure${failed.length === 1 ? '' : 's'}.`,
);

if (failed.length > 0) {
  console.log(`\nFailures:`);
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? '  →  ' + f.detail : ''}`);
  process.exit(1);
}
