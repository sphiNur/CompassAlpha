# CompassAlpha 上线修复全套方案

> 配套文档：[PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md)
> 目标：把所有 P0 / P1 / 重要 P2 落地为**可执行的工程任务清单**，明确每步的**改动、删除、验证、回滚**。
> 时间线：Phase 0 当天清理 → Phase 1 48~72h 拨杆 → Phase 2 首周收尾 → Phase 3 两周升级 → Phase 4 持续打磨。
> 设计原则：**删大于改，改大于加**。任何"未被使用的承诺"全部删，留下的每行代码必须有现实使命。

---

## TL;DR · 工时与产出

| 阶段 | 工时 | 出口 | 阻断上线? |
|---|---|---|:-:|
| Phase 0 · 清理 | 2 h | 删除 30+ 项死代码 / 死文档 / 死依赖；项目从 "看起来很乱" 变 "可走查" | ❌ |
| Phase 1 · P0 拨杆 | 48~72 h | 5 个 Blocker 全消、3 个高危 P1 关闭；GO/NO-GO Checklist 20 项可绿 | ✅ |
| Phase 2 · P1 收尾 | 1 周 | 剩余 P1 全清；架构文档与现实对齐 | ⚠️ |
| Phase 3 · P2 高优 | 2 周 | Redis 限流、CI lint、Dependabot、ESLint 收紧、bot/worker 测试 | ❌ |
| Phase 4 · 持续 | 滚动 | 巨石拆分、PWA、SSE、OTel 等长期项 | ❌ |

---

# Phase 0 · 清理与删除（2 小时，今天就做）

> 先把噪音清掉，让 Phase 1 的改动一目了然。

## 0.1 文件 / 文件夹删除清单

> **执行前先确认 git status 干净，或者先 commit 一次以便 revert。**

### 0.1.1 项目内可直接删除

| 路径 | 大小 | 删除原因 |
|---|---|---|
| `CompassAlpha/AUTOSESSION_LOG.md` | 32 KB | AI 会话日志，仓库根目录与 README 同级，外部审阅困惑 |
| `CompassAlpha/smoke-failure-shell.png` | 截图 | 调试快照，不应入主线 |

### 0.1.2 父目录 `~/Desktop/gemini/` 可清理（共 ~600MB+）

| 路径 | 删除原因 |
|---|---|
| `compass-alpha-deploy.tar.gz` | deploy.ts 每次重新生成，不需要保留 |
| `compass-alpha-fix1..7.tar.gz` | 历史部署快照，价值低 |
| `compass-alpha-hotfix1.tar.gz` | 同上 |
| `compass-alpha-m1batch.tar.gz` | 同上 |
| `compass-alpha.tar.gz` | 同上 |
| `api.log` / `generate.log` / `install.log` / `web.log` | 旧 nohup 日志，远古遗物 |
| `CompassBeta/` | 用户已确认不再维护，但保留作"考古"——**移到 `~/Archive/`** 即可，不必删 |

> 一次性命令（PowerShell）：
> ```powershell
> Remove-Item "C:\Users\surface\Desktop\gemini\compass-alpha-*.tar.gz","C:\Users\surface\Desktop\gemini\*.log" -Force
> # CompassBeta 视情况
> Move-Item "C:\Users\surface\Desktop\gemini\CompassBeta" "C:\Users\surface\Archive\CompassBeta-2026-05-16"
> ```

### 0.1.3 SSH 私钥处置（**重要**）

`C:\Users\surface\Desktop\gemini\TgBotGemini.pem` → 移到 `%USERPROFILE%\.ssh\compass_alpha.pem`，并设 ACL：

```powershell
$key = "$env:USERPROFILE\.ssh\compass_alpha.pem"
Move-Item "C:\Users\surface\Desktop\gemini\TgBotGemini.pem" $key
icacls $key /inheritance:r
icacls $key /grant:r "${env:USERNAME}:F"
```

然后改 [scripts/deploy.ts:43-44](scripts/deploy.ts:43) 的 KEY 路径与 HOST（见 §1.7）。

## 0.2 代码内删除清单

### 0.2.1 死代码

| 文件:行 | 内容 | 操作 |
|---|---|---|
| [apps/web/src/pages/AdminPage.tsx:6871](apps/web/src/pages/AdminPage.tsx:6871) | `console.log(tsv);` | 删除整行 |
| [apps/web/src/app/AuthGate.tsx:88,117](apps/web/src/app/AuthGate.tsx:88) | `import.meta.env.VITE_DEV_MOCK_INIT_DATA` 直读 | 包一层 `import.meta.env.DEV &&`（见 §1.3） |

### 0.2.2 死依赖

| 包 | 现状 | 操作 |
|---|---|---|
| `@tanstack/react-router` | apps/web/package.json:19 装了，**全代码无 `import` 命中** | `pnpm --filter @compass/web remove @tanstack/react-router` |

> 验证命令：`Grep -r "@tanstack/react-router" apps/ packages/` → 应仅命中 `package.json` 与 `pnpm-lock.yaml`，移除后只剩 lockfile。

### 0.2.3 ARCHITECTURE.md "未实现的承诺"删除/降级清单

[ARCHITECTURE.md](ARCHITECTURE.md) 整体保留，但以下章节必须**改为"M2/M3 路线图"标记**或直接删除（详见 §2.5）：

| 当前声称 | 现实 | 操作 |
|---|---|---|
| "Casbin-style ABAC + 策略引擎" (§7.2) | 仅 RBAC + member_permission_overrides | **删除**，重写为 "RBAC + per-member overrides" |
| "WebSocket + SSE 双通道" (§4.5) | 仅 WS | **删除 SSE 段落** |
| "完整 Offline-First: SW + IDB + 同步对账协议" (§0/§5.2) | 仅 IDB outbox | **降级**为 "IDB outbox（M2 扩展 SW + sync 对账）" |
| "Bot + WebPush + In-App 三通道" (§6.1) | 仅 In-App + Bot（且 Bot 默认关） | **降级**为 "In-App + Bot（M2 加 WebPush）" |
| "LinguiJS ICU MessageFormat" (§2.2) | 自研 mini-i18n | **删除**，改成 "自研轻量 i18n（M2 替换 @formatjs/intl-messageformat）" |
| "双主题 Native / Apple" (§5.3) | ThemeProvider 接口在，token 未分离 | **降级**为 "ThemeProvider 接口（M2 完成 Apple token 集）" |
| "Tailwind v4 + OKLCH `@theme` block" (§2.2) | Tailwind 3.4.14 | **改正**为 "Tailwind v3" |
| "TanStack Router 文件路由" (§5.4) | 未使用 | **删除** |
| "OpenTelemetry 全链路 + Tempo" (§8.1) | 客户端 batch span 到自有端点 | **降级**为 "自研 client log（M2 切 OTel SDK）" |
| "k6 负载测试" (§9) | 不存在 | **删除**，改 "M3 加 k6 baseline" |
| "compass CLI 完整命令集" (§11) | 仅 user/org/project/test | **删除未实现的子命令** |

## 0.3 Phase 0 出口验证

```bash
# 1. 死代码删完
cd C:\Users\surface\Desktop\gemini\CompassAlpha
grep -rn "console.log(tsv)" apps/   # 应空
grep -rn "@tanstack/react-router" apps/ packages/   # 应只在 lockfile

# 2. ARCHITECTURE.md 不再误导
grep -E "Casbin|LinguiJS|Tailwind v4|TanStack Router|双通道.*SSE" ARCHITECTURE.md   # 应空 / 都在 "M2 路线图" 段

# 3. 父目录清爽
ls C:\Users\surface\Desktop\gemini   # 只剩 CompassAlpha
```

---

# Phase 1 · 上线硬阻断修复（48~72 小时）

> 5 个 P0 + 3 个标记 ⓦ 的 P1，每个有完整改法。

## 1.1 [P0-1] 补 SPA 静态托管

**改一处即可**：在 [apps/api/src/app.ts](apps/api/src/app.ts) 的 tRPC mount **之后**、`notFound` **之前**插入静态服务。

### 改动 1.1 A：apps/api/src/app.ts

```ts
// 顶部新增 import
import { serveStatic } from 'hono/bun';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ... 现有 createApp() 内 ...

// 在 app.use('/trpc/*', trpcServer(...)) 之后、app.notFound(...) 之前
const __dirname = dirname(fileURLToPath(import.meta.url));
// 生产构建 dist 在 apps/api/dist/, web 在 apps/web/dist/, 兼容两种相对路径
const webDistCandidates = [
  join(__dirname, '..', '..', 'web', 'dist'),                      // bun-built layout
  join(__dirname, '..', '..', '..', 'apps', 'web', 'dist'),        // monorepo dev layout
];
const webDist = webDistCandidates.find(existsSync);

if (webDist) {
  // 1. 静态资源（assets/, build-id.txt, favicon.ico 等）
  app.use('/*', serveStatic({ root: webDist }));
  // 2. SPA fallback —— 任何未命中的 GET 都返回 index.html
  app.get('*', serveStatic({ path: join(webDist, 'index.html') }));
  logger.info({ webDist }, 'SPA static serving enabled');
} else {
  logger.warn('apps/web/dist not found; SPA serving disabled (dev mode?)');
}

// 然后才是
app.notFound(...);
```

### 改动 1.1 B：infra/caddy/Caddyfile（顺手把 handle_path 改正）

```caddyfile
{$DOMAIN:compass.example.com} {
  encode zstd gzip
  log { output stdout; format json }

  # API + WS — 反代到 api:3000
  @api path /trpc/* /health/* /ws
  handle @api {
    reverse_proxy api:3000 {
      header_up X-Real-IP {remote_host}
      header_up X-Forwarded-Proto {scheme}
    }
  }

  # 其余 = SPA。也走 api:3000（api 内置 serveStatic）。
  # 如果 Caddy 直接挂卷文件服务更省事，那把下面改成 file_server + try_files。
  handle {
    reverse_proxy api:3000
  }

  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "SAMEORIGIN"
    Referrer-Policy "strict-origin-when-cross-origin"
    Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  }
}
```

`{$DOMAIN:compass.example.com}` 用 systemd EnvironmentFile 或 docker-compose env 注入实际域名。

### 验证

```bash
# 本地
pnpm build && pnpm --filter @compass/api start
curl http://localhost:3000/                       # 应返回 <!doctype html>
curl http://localhost:3000/order                  # 同样的 HTML（SPA fallback）
curl http://localhost:3000/assets/index-*.js      # 200 + content-type application/javascript

# 部署后
curl -I https://<域名>/                          # 200 + Content-Security-Policy header
```

### 回滚

```ts
// 单纯删除 app.use('/*', serveStatic(...)) + app.get('*', ...) 即可
```

---

## 1.2 [P0-2] CSP 与 index.html 内联脚本对齐

**策略**：保持 CSP 严格，**把内联脚本和 onclick 全外联**。这样 CSP 不需要 `'unsafe-inline'`，安全等级最高。

### 改动 1.2 A：新建 apps/web/public/boot-guard.js

```javascript
/**
 * Pre-React boot guard. 加载失败时显示错误 UI 而不是黑屏。
 * 因 CSP 不允许 inline script，本文件作为外部资源被 index.html 引用。
 */
(function () {
  var bootShown = false;
  function showBootError(msg, stack) {
    if (bootShown) return;
    bootShown = true;
    var el = document.getElementById('boot-error');
    if (!el) return;
    el.classList.add('show');
    var msgEl = el.querySelector('[data-msg]');
    if (msgEl) msgEl.textContent = msg || 'Failed to start';
    var pre = el.querySelector('pre');
    if (pre && stack) pre.textContent = stack;
    var spin = document.getElementById('boot-spinner');
    if (spin) spin.style.display = 'none';
  }

  window.addEventListener('error', function (e) {
    showBootError(e.message || 'Script error', (e.error && e.error.stack) || '');
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason || {};
    showBootError(r.message || 'Unhandled rejection', r.stack || String(r));
  });

  // 12s failsafe
  setTimeout(function () {
    if (!document.documentElement.classList.contains('ready')) {
      showBootError(
        document.documentElement.getAttribute('data-boot-timeout-msg') ||
        'App did not start within 12 s.',
        ''
      );
    }
  }, 12000);

  // 绑定按钮（替代 onclick=）
  document.addEventListener('DOMContentLoaded', function () {
    var reload = document.getElementById('boot-reload-btn');
    if (reload) reload.addEventListener('click', function () { location.reload(); });
    var reset = document.getElementById('boot-reset-btn');
    if (reset) reset.addEventListener('click', function () {
      try { localStorage.removeItem('compass.auth'); sessionStorage.clear(); } catch (e) {}
      location.reload();
    });
  });
})();
```

### 改动 1.2 B：apps/web/index.html

```html
<!doctype html>
<html lang>  <!-- 注意：lang 由 main.tsx 在 mount 后设置 -->
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <!-- 删除 maximum-scale=1 + user-scalable=no，符合 WCAG 1.4.4 -->
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#1c1c1e" media="(prefers-color-scheme: dark)" />
    <meta name="color-scheme" content="light dark" />
    <meta name="compass-build" content="%VITE_BUILD_SHA%" />
    <title>Compass</title>
    <link rel="stylesheet" href="/boot.css" />  <!-- 把内联 <style> 也外联，进一步收紧 CSP -->
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="/boot-guard.js"></script>  <!-- 替代原内联脚本 -->
  </head>
  <body>
    <div id="root">
      <div id="boot-splash">
        <div id="boot-spinner" aria-hidden="true"></div>
        <div class="boot-title">Compass</div>
        <div class="boot-subtitle" data-boot-starting>Starting up…</div>
        <div id="boot-error" role="alert">
          <strong data-msg>Boot failed</strong>
          <pre></pre>
          <div class="boot-actions">
            <button id="boot-reload-btn" class="boot-btn">Reload</button>
            <button id="boot-reset-btn" class="boot-btn boot-btn-secondary">Reset &amp; reload</button>
          </div>
        </div>
      </div>
    </div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### 改动 1.2 C：新建 apps/web/public/boot.css

把原来 `<style>` 块的内容搬过来即可。

### 改动 1.2 D：CSP 加 telegram.org 白名单

[apps/api/src/app.ts:139-152](apps/api/src/app.ts:139)：

```ts
c.header(
  'Content-Security-Policy',
  [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",   // <-- 加这一项
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' wss: https:",
    "frame-ancestors 'self' https://web.telegram.org https://t.me",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
);
```

> **不**加 `'unsafe-inline'` 到 script-src —— 那是兜底，本方案通过外联脚本规避。
> 已**确认** PhotoCapture 不使用 `getUserMedia`（用 `<input type="file" capture>`），所以 `Permissions-Policy: camera=()` **可以保留**，无需放宽。

### 验证

```bash
pnpm --filter @compass/web build
# 检查产物
grep -rn "onclick=" apps/web/dist/index.html   # 应为空
grep -rn "<script>" apps/web/dist/index.html   # 应只剩 type=module 与外联 src=
# 浏览器打开后 devtools Console 无任何 CSP violation
```

---

## 1.3 [P0-3] 阻断 `VITE_DEV_MOCK_INIT_DATA` 进生产构建

**双保险**：构建期硬校验 + 运行期 DEV 守卫。

### 改动 1.3 A：apps/web/vite.config.ts（构建期硬校验）

```ts
export default defineConfig(({ mode }) => {
  if (mode === 'production' && process.env.VITE_DEV_MOCK_INIT_DATA) {
    throw new Error(
      'BUILD ABORT: VITE_DEV_MOCK_INIT_DATA is set during production build. ' +
      'This would bake a dev-only auth bypass into the bundle. ' +
      'Unset it before running `pnpm build`.'
    );
  }
  return {
    plugins: [react(), buildShaPlugin()],
    // ... 其余不变
  };
});
```

### 改动 1.3 B：apps/web/src/app/AuthGate.tsx（运行期守卫）

```ts
// L88-89 改：
const mock = import.meta.env.DEV ? import.meta.env.VITE_DEV_MOCK_INIT_DATA : null;

// L117 改：
const data = getTg()?.initData
  ?? (import.meta.env.DEV ? import.meta.env.VITE_DEV_MOCK_INIT_DATA : null)
  ?? '';
```

`import.meta.env.DEV` 在生产构建里被 Vite 静态替换为 `false`，整条三元会被 Rollup tree-shake 掉。Production 产物里搜不到 `VITE_DEV_MOCK_INIT_DATA` 字符串。

### 改动 1.3 C：deploy.ts 增加 grep 校验（防服务器 .env 误配）

[scripts/deploy.ts](scripts/deploy.ts) 在 `5. rebuild web` 之前插入：

```ts
step('4.9. verify no dev auth bypass in server .env');
const envCheck = ssh(
  `grep -E '^VITE_DEV_MOCK_INIT_DATA=.+' /home/ubuntu/compass-alpha/.env || echo 'OK'`
);
if (!envCheck.includes('OK')) {
  console.error('\x1b[31m✖ Server .env has VITE_DEV_MOCK_INIT_DATA set — aborting deploy\x1b[0m');
  console.error(envCheck);
  process.exit(1);
}
```

### 验证

```bash
# 1. 设置 mock 触发硬校验
VITE_DEV_MOCK_INIT_DATA=1 pnpm --filter @compass/web build
# 应在 vite 启动时立刻 throw

# 2. 不设置正常构建
pnpm --filter @compass/web build
# 产物里搜不到字符串
grep -r "VITE_DEV_MOCK_INIT_DATA" apps/web/dist/  # 应空

# 3. 服务器 grep 校验
bun run scripts/deploy.ts --dry  # 应顺利通过
```

---

## 1.4 [P0-4] 切真实域名，弃用 Cloudflare quick-tunnel

> **此项需外部协作（购买域名、改 DNS）**，但工程动作清晰。

### 1.4.1 行动清单

| 步 | 动作 | 工时 |
|---|---|---|
| 1 | 注册域名（推荐 `.com` / `.app`），如 `compass-pro.com` | 10 min |
| 2 | Cloudflare 添加站点，DNS A 记录 `compass-pro.com → 129.204.59.183`，**关掉 Proxy（橙云）让 Caddy 直签 LE 证书**。或：保留 Proxy + Cloudflare Full(Strict) SSL，让 Caddy 用 DNS-01 challenge 拿证书 | 20 min |
| 3 | 服务器 `/etc/systemd/system/compass-api.service.d/override.conf` 加 `Environment=DOMAIN=compass-pro.com` | 5 min |
| 4 | 把 [infra/caddy/Caddyfile:11](infra/caddy/Caddyfile:11) 的 `compass.example.com` 改为 `{$DOMAIN}` | 1 min |
| 5 | 把 [scripts/smoke.ts:19](scripts/smoke.ts:19)、[scripts/browser-smoke.ts:25](scripts/browser-smoke.ts:25)、[scripts/browser-smoke-deep.ts:27](scripts/browser-smoke-deep.ts:27) 三处 `franchise-cheese-pound-mills.trycloudflare.com` 改为 `compass-pro.com` | 2 min |
| 6 | BotFather: `/setdomain` 把 WebApp URL 指向 `https://compass-pro.com` | 5 min |
| 7 | 关闭 cloudflared 服务 `sudo systemctl stop cloudflared && sudo systemctl disable cloudflared` | 1 min |
| 8 | Caddy 第一次启动会跑 LE ACME，等 ~30s 看到 `obtained certificate` 日志 | 2 min |
| 9 | 跑完整 smoke：`bun run scripts/smoke.ts && bun run scripts/browser-smoke-deep.ts` | 5 min |

### 1.4.2 域名注入约定

所有脚本读 `COMPASS_BASE` 环境变量，去掉硬编码默认值的事故隐患：

```ts
// scripts/smoke.ts / browser-smoke.ts / browser-smoke-deep.ts 顶部统一改：
const BASE = process.env.COMPASS_BASE;
if (!BASE) {
  console.error('Set COMPASS_BASE=https://<your-domain> before running smoke');
  process.exit(2);
}
```

工程师本地 `.zshrc`：

```bash
export COMPASS_BASE=https://compass-pro.com
export COMPASS_DEPLOY_HOST=ubuntu@compass-pro.com   # 顺手把 IP 换成域名
```

### 验证

```bash
curl -I https://compass-pro.com/                    # 200 + Caddy 签的 LE 证书
curl -I https://compass-pro.com/health/live         # 200
curl https://compass-pro.com/health/ready           # 含 dbMs / projectorLagMs
# Telegram 内打开 mini app，能登录到主屏
```

---

## 1.5 [P0-5] 接通 Telegram Bot 通知通道

> **根因**：CN 服务器到 Telegram API 国际出口被阻断。三选一。

### 方案 A（推荐，最稳）：Cloudflare Worker 中转

把 worker 的 Telegram dispatch 改成发到一个 Cloudflare Worker 端点，由 CF Worker 转发到 `https://api.telegram.org/bot<token>/sendMessage`。

#### 改动 1.5 A.1：新建 CF Worker `tg-relay.js`

```javascript
// 部署到 https://tg-relay.<你的 cf 账户>.workers.dev
export default {
  async fetch(req, env) {
    const auth = req.headers.get('x-compass-key');
    if (auth !== env.COMPASS_KEY) return new Response('forbidden', { status: 403 });
    if (req.method !== 'POST') return new Response('use POST', { status: 405 });
    const { method, params } = await req.json();
    const safeMethod = String(method).replace(/[^a-zA-Z]/g, '');
    const tgRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${safeMethod}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    return new Response(await tgRes.text(), {
      status: tgRes.status,
      headers: { 'content-type': 'application/json' },
    });
  },
};
```

CF Worker dashboard 设 secrets：`COMPASS_KEY`（随机 32 字节）、`BOT_TOKEN`（BotFather token）。

#### 改动 1.5 A.2：worker 改走中转

在 [apps/worker/src/main.ts](apps/worker/src/main.ts)，把直发 grammY 的 `sendMessage` 改成发到 `env.TG_RELAY_URL`：

```ts
const TG_RELAY_URL = process.env.TG_RELAY_URL;
const COMPASS_KEY = process.env.COMPASS_KEY;

async function tgSendMessage(chatId: number, text: string, opts: Record<string, unknown> = {}) {
  const res = await fetch(TG_RELAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-compass-key': COMPASS_KEY },
    body: JSON.stringify({
      method: 'sendMessage',
      params: { chat_id: chatId, text, ...opts },
    }),
  });
  if (!res.ok) throw new Error(`tg relay ${res.status}: ${await res.text()}`);
  return await res.json();
}
```

#### 改动 1.5 A.3：env 添加

```
# .env
TG_RELAY_URL=https://tg-relay.<acct>.workers.dev
COMPASS_KEY=<random 32 bytes hex>
```

[apps/api/src/env.ts](apps/api/src/env.ts) zod schema 加：

```ts
TG_RELAY_URL: z.string().url().optional(),
COMPASS_KEY: z.string().min(32).optional(),
```

#### 改动 1.5 A.4：打开 BOT_DELIVERY_ENABLED 开关

[apps/worker/src/main.ts](apps/worker/src/main.ts) 把默认值翻转：

```ts
const BOT_DELIVERY_ENABLED = process.env.BOT_DELIVERY_ENABLED !== 'false';  // 默认 true
```

### 方案 B：SOCKS5 代理（次选）

在服务器装 `tun2socks` 走墙外 VPS。维护复杂度高，**不推荐**。

### 方案 C：纯文档化"暂缓"（最差）

在 README / UI 把 "我们会通过 Telegram 通知" 文案改成 "请关注应用内通知"。**不推荐** —— 等于自己承认产品功能残缺。

### 验证

```bash
# 1. 手动触发一次 sendMessage
curl -X POST $TG_RELAY_URL \
  -H "x-compass-key: $COMPASS_KEY" \
  -H "content-type: application/json" \
  -d '{"method":"sendMessage","params":{"chat_id":<你的 tg id>,"text":"hello compass"}}'
# 你的 Telegram 收到 "hello compass"

# 2. worker journal 看派发
journalctl -u compass-worker -f
# 触发一次 order.Submitted 应当看到 "bot delivery sent"

# 3. 触发审核流程
# 用员工账号在 mini app 提交订单 → admin 账号秒收 TG 通知
```

---

## 1.6 [P1-1 ⓦ] 删除 `console.log(tsv)`

```diff
- apps/web/src/pages/AdminPage.tsx:6871
- console.log(tsv);
+ // (deleted)
```

CI 加入兜底（防再次滋生）：

[.github/workflows/ci.yml](.github/workflows/ci.yml) 在 unit job 加：

```yaml
- name: No console.log in production code
  run: |
    found=$(grep -rn "console\.\(log\|debug\|info\)" apps/web/src apps/api/src apps/bot/src apps/worker/src \
            --include='*.ts' --include='*.tsx' \
            --exclude-dir='__tests__' || true)
    # 允许 ErrorBoundary.tsx 的 console.error 兜底
    found=$(echo "$found" | grep -v "ErrorBoundary.tsx" | grep -v "console.warn" | grep -v "console.error" || true)
    if [ -n "$found" ]; then
      echo "Found console.log/debug/info in source:"
      echo "$found"
      exit 1
    fi
```

---

## 1.7 [P1-2 ⓦ] 生产 IP 移出源码

### 改动 1.7：scripts/deploy.ts

```diff
- const HOST = 'ubuntu@129.204.59.183';
+ const HOST = process.env.COMPASS_DEPLOY_HOST;
+ if (!HOST) {
+   console.error('Set COMPASS_DEPLOY_HOST=ubuntu@<host-or-ip> (e.g. ubuntu@compass-pro.com)');
+   process.exit(2);
+ }

- const KEY = join(PARENT, 'TgBotGemini.pem');
+ const KEY = process.env.COMPASS_DEPLOY_KEY
+   ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.ssh', 'compass_alpha.pem');
```

工程师 `~/.zshrc` 或 PowerShell profile 加：

```bash
export COMPASS_DEPLOY_HOST=ubuntu@compass-pro.com
export COMPASS_DEPLOY_KEY=$HOME/.ssh/compass_alpha.pem
export COMPASS_BASE=https://compass-pro.com
```

---

## 1.8 [P1-3 ⓦ] `compass-api.service` 入仓

服务器上把当前在跑的单元抓回来：

```bash
ssh ubuntu@compass-pro.com 'sudo cat /etc/systemd/system/compass-api.service' \
  > infra/systemd/compass-api.service
```

预期内容（参考 worker.service 写法对齐）：

```ini
[Unit]
Description=CompassAlpha API (Hono + tRPC on Bun)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/compass-alpha/apps/api
EnvironmentFile=/home/ubuntu/compass-alpha/.env
Environment=PATH=/home/ubuntu/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
ExecStart=/home/ubuntu/.bun/bin/bun run src/main.ts
Restart=on-failure
RestartSec=3
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=compass-api

[Install]
WantedBy=multi-user.target
```

### 改动 1.8：scripts/deploy.ts 同步分发

[scripts/deploy.ts](scripts/deploy.ts) 在 4a 步把 api.service 也覆盖：

```ts
step('4a. install/refresh systemd units (api + worker)');
ssh(
  [
    'sudo cp /home/ubuntu/compass-alpha/infra/systemd/compass-api.service /etc/systemd/system/',
    'sudo cp /home/ubuntu/compass-alpha/infra/systemd/compass-worker.service /etc/systemd/system/',
    'sudo systemctl daemon-reload',
    'sudo systemctl enable compass-api.service compass-worker.service',
  ].join(' && '),
);
```

### 验证

```bash
# 删 server 上的单元，让 deploy 重新分发
ssh ubuntu@... 'sudo systemctl stop compass-api && sudo rm /etc/systemd/system/compass-api.service'
bun run scripts/deploy.ts
# 部署完后 systemctl status compass-api 应 active
```

---

# Phase 2 · 剩余 P1（首周内，5 个工作日）

## 2.1 [P1-4] Caddyfile 占位域名 + 安全头对齐

已在 §1.1 B 处理（`{$DOMAIN}` 注入 + Permissions-Policy 加 payment/usb）。

## 2.2 [P1-5] Dockerfile 构建 bot + worker

```diff
# infra/docker/Dockerfile
# ---- 2. build packages + apps ----
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm --filter @compass/web build
RUN pnpm --filter @compass/api build
+ RUN pnpm --filter @compass/bot build
+ RUN pnpm --filter @compass/worker build

# ---- 3. runtime ----
FROM oven/bun:1.1.38-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
+ COPY --from=build /app/apps/bot/dist ./apps/bot/dist
+ COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/packages ./packages
COPY --from=build /app/node_modules ./node_modules
```

> 验证：`docker compose -f infra/compose/docker-compose.prod.yml up -d` 后 `docker logs compass-bot`、`docker logs compass-worker` 无 `MODULE_NOT_FOUND`。

## 2.3 [P1-6] tRPC RC → stable 升级

```bash
pnpm up @trpc/server@^11 @trpc/client@^11 @trpc/react-query@^11 -r
pnpm type-check
pnpm test
bun run scripts/deploy.ts --dry   # smoke
```

如有 break，看 v11 changelog（主要变化在 `errorFormatter` 和 SSE link，本项目都用 httpLink）。

## 2.4 [P1-7] 启动 splash 多语言 + 动态 `<html lang>`

### 改动 2.4 A：apps/web/public/boot-guard.js 顶部加

```javascript
(function () {
  // 语言探测
  var tg = window.Telegram && window.Telegram.WebApp;
  var langRaw = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user
                 && tg.initDataUnsafe.user.language_code)
                 || navigator.language || 'en';
  var lang = (function (l) {
    l = l.toLowerCase();
    if (l.indexOf('zh') === 0) return 'zh';
    if (l.indexOf('ru') === 0) return 'ru';
    if (l.indexOf('uz') === 0) return 'uz';
    return 'en';
  })(langRaw);
  document.documentElement.lang = lang;

  var TEXT = {
    en: { startingUp: 'Starting up…', bootFailed: 'Boot failed', timeout: 'App did not start within 12 s.', reload: 'Reload', reset: 'Reset & reload' },
    zh: { startingUp: '启动中…',     bootFailed: '启动失败',    timeout: '应用 12 秒内未启动。',           reload: '重新加载', reset: '清除并重启' },
    ru: { startingUp: 'Запуск…',     bootFailed: 'Ошибка запуска', timeout: 'Приложение не запустилось за 12 с.', reload: 'Перезагрузить', reset: 'Сбросить и перезагрузить' },
    uz: { startingUp: 'Ishga tushmoqda…', bootFailed: 'Ishga tushishda xato', timeout: '12 soniya ichida ishga tushmadi.', reload: 'Qayta yuklash', reset: 'Tozalab qayta yuklash' },
  };
  var t = TEXT[lang];

  // 填入文案
  var subEl = document.querySelector('[data-boot-starting]');
  if (subEl) subEl.textContent = t.startingUp;
  document.documentElement.setAttribute('data-boot-timeout-msg', t.timeout);
  var failedEl = document.querySelector('#boot-error [data-msg]');
  if (failedEl) failedEl.textContent = t.bootFailed;
  var reloadBtn = document.getElementById('boot-reload-btn');
  if (reloadBtn) reloadBtn.textContent = t.reload;
  var resetBtn = document.getElementById('boot-reset-btn');
  if (resetBtn) resetBtn.textContent = t.reset;

  // ... 然后才是原来的 error / unhandledrejection / 12s failsafe 监听
})();
```

### 改动 2.4 B：apps/web/src/main.tsx

```ts
// 在 createRoot 之前
document.documentElement.lang = bootGuess;
```

## 2.5 [P1-8] 重写 ARCHITECTURE.md 为"现状 + 路线图"

执行 §0.2.3 的删除/降级清单。结构改为：

```markdown
# CompassAlpha Architecture

## Section 1: Current State (M1, 2026-05-16)
- 真实在跑的：Hono + tRPC + Drizzle + Bun + Postgres + RLS + WS + IDB outbox + custom i18n + Tailwind v3 + tab-based nav

## Section 2: Roadmap
### M2 (planned, 2026-Q3)
- @formatjs/intl-messageformat 替换自研 i18n
- Service Worker + PWA manifest
- WebPush channel
- OpenTelemetry SDK 接入

### M3 (planned, 2026-Q4)
- TanStack Router 接入文件路由
- Apple theme token 集补齐
- Tailwind v4 升级评估
- k6 load tests

### M4 (planned, 2027)
- ABAC policy_rules 表达式求值
- 多副本化 + Redis hub + 蓝绿部署
- WebAuthn for admins
```

---

# Phase 3 · P2 高优升级（Sprint 1，2 周）

> 不阻断上线但显著提升工程质量。按价值/工时比排序。

## 3.1 [P2-8] CI 加 lint step（30 分钟）

```yaml
# .github/workflows/ci.yml, unit job 中
- name: ESLint (zero warnings)
  run: pnpm lint
```

`pnpm lint` 已配 `--max-warnings 0`，确保现存代码先通过：

```bash
pnpm lint 2>&1 | tee lint.log
# 若有红，先修干净再合 CI 这步
```

## 3.2 [P2-9] Dependabot（10 分钟）

新建 `.github/dependabot.yml`：

```yaml
version: 2
updates:
  - package-ecosystem: pnpm
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 5
    groups:
      tanstack:
        patterns: ['@tanstack/*']
      trpc:
        patterns: ['@trpc/*']
      types:
        patterns: ['@types/*']
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: monthly
```

## 3.3 [P2-2] Redis 限流（2 小时）

[apps/api/src/services/rateLimit.ts](apps/api/src/services/rateLimit.ts) 现在是单进程 Map。重写：

```ts
import { Redis } from 'ioredis';
import { env } from '../env';

const redis = env.REDIS_URL ? new Redis(env.REDIS_URL) : null;

export async function checkRate(scope: string, key: string, opts: RateOptions): Promise<boolean> {
  if (!redis) return checkRateMemory(scope, key, opts);  // 保留内存兜底
  const id = `rate:${scope}:${key}`;
  const now = Date.now();
  const windowStart = now - opts.window;
  // 滑动窗口：用 sorted set 按 score=timestamp 存
  const tx = redis.multi();
  tx.zremrangebyscore(id, 0, windowStart);
  tx.zcard(id);
  tx.zadd(id, now, `${now}-${Math.random()}`);
  tx.pexpire(id, opts.window);
  const results = await tx.exec();
  const count = results?.[1]?.[1] as number ?? 0;
  return count < opts.max;
}
```

注意：要把 checkRate 调用点改成 `await`：[trpc.ts:123](apps/api/src/trpc/trpc.ts:123) 和 [auth.ts:47](apps/api/src/trpc/routers/auth.ts:47)。

## 3.4 [P2-3] CORS 收紧（10 分钟）

[apps/api/src/app.ts:174](apps/api/src/app.ts:174)：

```diff
- origin === 'https://t.me' ||
- origin.endsWith('.trycloudflare.com')
+ origin === 'https://t.me' ||
+ (env.NODE_ENV !== 'production' && origin.endsWith('.trycloudflare.com'))
```

生产构建后任何 `*.trycloudflare.com` Origin 一律拒绝。

## 3.5 [P2-7] bot + worker 基础测试（4 小时）

新建 `apps/worker/src/__tests__/outbox.test.ts`：

```ts
// 3 个最小测试：
// 1. outbox 有一条 pending event → drain 后 sent_at 被填写
// 2. delivery throws → retries++ 但 sent_at 仍为 null
// 3. expired idempotency_keys 被 cleanup 删除
```

新建 `apps/bot/src/__tests__/handlers.test.ts`：

```ts
// 1. /start 命令返回欢迎消息
// 2. /id 命令返回 ctx.from.id
// 3. 未知命令不抛
```

## 3.6 [P2-4] ESLint 收紧禁用 `as any`（30 分钟）

`.eslintrc.cjs`（或 `eslint.config.js`）：

```js
rules: {
  '@typescript-eslint/no-explicit-any': 'error',
  // tRPC 中间件确实需要的 5 处：用 // eslint-disable-next-line + 注明原因
}
```

然后逐处替换为：

```ts
// L66 trpc.ts
- const ctx = opts.ctx as any;
+ const ctx = opts.ctx as RequestContext;  // 引入 import type { RequestContext } from './context'
```

## 3.7 [P2-13] SSH 私钥治理（已在 §0.1.3 处理）

补充：服务器侧考虑用 `~/.ssh/authorized_keys` 加 `from="<工程师外网 IP>"` 限制源 IP；或 Cloudflare Access for SSH（彻底关 22 公网）。

## 3.8 [P2-14] Caddyfile `handle_path /*` → `handle /*`

已在 §1.1 B 处理。

## 3.9 [P2-15] PG 角色非 BYPASSRLS 校验（5 分钟）

加入 [scripts/deploy.ts](scripts/deploy.ts) `5.5. tests` 之前：

```ts
step('5.4. verify DB role does not bypass RLS');
const rls = ssh(
  `psql ${process.env.DATABASE_URL ?? '$DATABASE_URL'} -tAc "SELECT rolbypassrls FROM pg_roles WHERE rolname='compass'"`
);
if (rls.trim() !== 'f') {
  console.error('\x1b[31m✖ DB role "compass" has BYPASSRLS — RLS is ineffective\x1b[0m');
  process.exit(1);
}
```

## 3.10 [P2-12] Telegram bot token 走 Docker secret（30 分钟）

[infra/compose/docker-compose.prod.yml](infra/compose/docker-compose.prod.yml)：

```yaml
secrets:
  tg_bot_token:
    file: /etc/compass/secrets/tg_bot_token   # 服务器上 chmod 600

services:
  bot:
    secrets: [tg_bot_token]
    environment:
      TELEGRAM_BOT_TOKEN_FILE: /run/secrets/tg_bot_token
```

[apps/bot/src/main.ts](apps/bot/src/main.ts) 读取改为：

```ts
const token =
  process.env.TELEGRAM_BOT_TOKEN ??
  (process.env.TELEGRAM_BOT_TOKEN_FILE
    ? readFileSync(process.env.TELEGRAM_BOT_TOKEN_FILE, 'utf8').trim()
    : null);
if (!token) { console.error('No bot token'); process.exit(1); }
```

## 3.11 [P2-5] 集中 Window.Telegram 类型（15 分钟）

新建 `apps/web/src/types/telegram.d.ts`：

```ts
import type { TelegramWebApp } from '../hooks/useTelegram';
declare global {
  interface Window { Telegram?: { WebApp?: TelegramWebApp } }
}
export {};
```

`tsconfig.json` 的 `include` 加 `src/types/**/*.d.ts`。然后批量删除 main.tsx / App.tsx / Shell.tsx / theme.tsx 中的 `as { Telegram?: ... }` 类型断言。

## 3.12 [P2-10] Bot webhook（M2 任务）

待 P0-4 域名稳定后：

```ts
// apps/bot/src/main.ts
if (process.env.BOT_WEBHOOK_URL) {
  await bot.api.setWebhook(`${process.env.BOT_WEBHOOK_URL}/bot/webhook`);
  // 用 Hono 在 apps/api 加 /bot/webhook 路由调 bot.handleUpdate
}
```

## 3.13 [P2-16] Sourcemap 上传到 Sentry / GlitchTip（1 小时）

```bash
pnpm add -D vite-plugin-sentry
```

[apps/web/vite.config.ts](apps/web/vite.config.ts)：

```ts
import { sentryVitePlugin } from '@sentry/vite-plugin';
build: {
  sourcemap: 'hidden',  // 生成 .map 但 dist 删除 //# sourceMappingURL
},
plugins: [
  react(),
  buildShaPlugin(),
  sentryVitePlugin({
    org: 'compass',
    project: 'web',
    authToken: process.env.SENTRY_AUTH_TOKEN,
    sourcemaps: { assets: './dist/**' },
  }),
],
```

构建后 sourcemap 上传给 Sentry，然后 deploy 前删 dist 里的 .map：

```bash
# deploy.ts
find apps/web/dist -name '*.map' -delete
```

---

# Phase 4 · P2/P3 持续打磨（Sprint 2+）

| 项 | 来自 | 工时 | 时机 |
|---|---|---|---|
| AdminPage / RunPage / admin.ts 拆分 | P2-1 | 3 天 | M2.1 |
| WS ticket procedure (短 TTL) | P2-17 | 半天 | M2.2 |
| Service Worker + PWA manifest | P3-8 | 1 天 | M2 |
| `@formatjs/intl-messageformat` | P3-5 | 半天 | M2 |
| robots.txt | P3-7 | 5 分钟 | 任意 |
| Dockerfile pnpm via corepack | P3-1 | 15 分钟 | 任意 |
| `*:focus-visible` 全局 ring | P3-2 | 30 分钟 | M2 |
| ErrorBoundary console.error → logger | P3-3 | 5 分钟 | 任意 |
| `<meta viewport>` 去 `user-scalable=no` | P3-4 | 已在 §1.2 B 处理 | ✓ |
| Worker `/metrics` 端点 | P3-6 | 1 天 | M3 |

---

# 依赖图（执行顺序）

```
                    [Phase 0 · 清理]
                          |
              +-----------+-----------+
              |                       |
   [§1.7 IP→env]              [§1.6 删 console.log]
              |                       |
              +-----------+-----------+
                          |
                    [§1.3 mock 守卫] -------+
                          |                  |
                    [§1.2 CSP 外联脚本]      |
                          |                  |
                    [§1.1 SPA serveStatic]   |
                          |                  |
                          v                  v
                   [§1.4 真实域名] <---- [§1.8 api.service]
                          |
                    [§1.5 Bot 中转]
                          |
              +-----------+-----------+
              |                       |
       [§2.2 Dockerfile]      [§2.3 tRPC stable]
              |                       |
              +-----------+-----------+
                          |
                   [§2.4 启动多语言]
                          |
                   [§2.5 ARCHITECTURE.md 重写]
                          |
                   [GO/NO-GO Checklist]
                          |
                          v
                       [上线 ✅]
                          |
                          v
                   [Phase 3 滚动改进]
```

**关键依赖**：
- §1.4 域名替换 **必须** 早于 §1.5 Bot 中转的最终切换（CF Worker 也得有稳定回调）。
- §1.3 mock 守卫 **必须** 早于 §1.4 上真域名（否则真域名一开就被 mock 暴露）。
- §1.1 / §1.2 / §1.3 三项可并行（独立改动）。

---

# 每阶段验收测试

## Phase 0 出口
```bash
ls C:\Users\surface\Desktop\gemini   # 只剩 CompassAlpha + (可选) Archive 目录
grep -rn "@tanstack/react-router" apps/ packages/   # 空
grep -rn "console.log(tsv)" apps/   # 空
test -f $HOME/.ssh/compass_alpha.pem   # 存在
```

## Phase 1 出口（GO/NO-GO Checklist）
> 参考 [PRODUCTION_AUDIT.md 第八部分](PRODUCTION_AUDIT.md) 的 20 项 Checklist。逐项绿才能 GO。

新增 Phase 1 专用快查命令包：

```bash
# 在仓库根目录跑这个一次性脚本
bash <<'EOF'
set -e
echo "[1/8] SPA root accessible..."
curl -fs https://$DOMAIN/ | head -1 | grep -q '<!doctype html>' && echo "  ✓"

echo "[2/8] SPA fallback works..."
curl -fs https://$DOMAIN/order | head -1 | grep -q '<!doctype html>' && echo "  ✓"

echo "[3/8] CSP allows telegram.org..."
curl -fsI https://$DOMAIN/ | grep -i 'content-security-policy' | grep -q 'telegram.org' && echo "  ✓"

echo "[4/8] No VITE_DEV_MOCK_INIT_DATA in bundle..."
curl -fs https://$DOMAIN/ | grep -oE 'index-[^"]+\.js' | head -1 | xargs -I{} curl -fs https://$DOMAIN/assets/{} | grep -c VITE_DEV_MOCK_INIT_DATA | grep -q '^0$' && echo "  ✓"

echo "[5/8] Inline scripts gone..."
curl -fs https://$DOMAIN/ | grep -q 'onclick=' && echo "  ✗ inline onclick still present" || echo "  ✓"

echo "[6/8] No trycloudflare in code..."
grep -rn 'trycloudflare' scripts/ infra/ | grep -v '\.tar\.gz' && echo "  ✗" || echo "  ✓"

echo "[7/8] Hardcoded IP gone..."
grep -rn '129\.204\.59\.183' scripts/ infra/ && echo "  ✗" || echo "  ✓"

echo "[8/8] compass-api.service in repo..."
test -f infra/systemd/compass-api.service && echo "  ✓"
EOF
```

## Phase 2 出口
```bash
docker compose -f infra/compose/docker-compose.prod.yml up -d
sleep 10
docker logs compass-bot 2>&1 | grep -i error   # 空
docker logs compass-worker 2>&1 | grep -i error   # 空
docker logs compass-bot 2>&1 | grep -q '\[bot\] online'   # 命中
docker logs compass-worker 2>&1 | grep -q '\[worker\] online'   # 命中
pnpm type-check && pnpm test
```

## Phase 3 出口
```bash
# CI lint 绿
pnpm lint
# 依赖审计
pnpm audit --prod
# bot/worker 测试通过
bun test apps/worker apps/bot
# Redis 限流生效（手动）
for i in {1..130}; do curl -X POST https://$DOMAIN/trpc/order.adjustItem -H 'authorization: Bearer <token>' -d '{...}'; done
# 第 121+ 个应当 429
```

---

# 回滚预案

| 改动 | 回滚命令 | 预期 RTO |
|---|---|---|
| §1.1 SPA 静态服务 | git revert + restart api | 30s |
| §1.2 CSP / index.html | git revert + rebuild web + caddy reload | 1min |
| §1.3 mock 守卫 | git revert + rebuild web | 1min |
| §1.4 域名切换 | DNS 切回 cloudflared，cloudflared restart | 5min |
| §1.5 Bot 中转 | `systemctl stop compass-worker` + 等 Bot 修好 | 30s（用户失通知，但不影响主流程） |
| §3.3 Redis 限流 | 代码 fallback 到 memory，REDIS_URL 留空即可 | 0（自动 fallback） |
| §2.3 tRPC upgrade | `pnpm up @trpc/*@11.0.0-rc.648 -r` + deploy | 5min |

**整体回滚策略**：每个 Phase 1 改动单独成 commit + tag (`v1.0-pre-domain`、`v1.0-post-domain` 等)，方便逐步回退。

---

# 长期维护机制（防再次腐化）

## 1. CI 三道闸（已存）+ 新增三道
- 已有：i18n parity、migration journal、typography drift
- **新增 §1.6**：`grep console.log` 兜底
- **新增 §3.1**：`pnpm lint` 强制 zero-warning
- **新增 §3.9**：deploy 前 PG 角色 BYPASSRLS 检查

## 2. 文档同步机制
ARCHITECTURE.md 顶部加：
```
> 任何与本文不一致的实现，先修文档再修代码。
> 新功能必须在 §M-Roadmap 下登记。
```

## 3. Dependabot weekly + manual audit quarterly
每季度跑一次 `pnpm audit --prod` + Snyk 扫描。

## 4. 备份恢复演练
每月 1 号一次 staging restore drill：
```bash
# 从最新生产备份恢复到 staging DB
pg_restore --clean --if-exists -d $STAGING_DB_URL latest.dump
# 跑 staging smoke
COMPASS_BASE=https://staging.compass-pro.com bun run scripts/smoke.ts
```

## 5. 三个红线（保留 §6 表彰的设计不被破坏）
1. Refresh token 家族 + 重放检测不可弱化。
2. RLS withOrgContext 不可绕过。
3. CSP / HSTS / Permissions-Policy 不可放宽到 `*` 通配。

---

# 一句话总结

**Phase 0** 清掉幻觉、**Phase 1** 通堵点、**Phase 2** 收尾上线、**Phase 3** 防腐化、**Phase 4** 慢慢漂亮。
**全程坚持「删大于改、改大于加」**——绝大多数问题的根因是"承诺超过了实施"，不是"做得不够多"。

---

**方案签字**

- 制定：Claude（Anthropic 官方 CLI）
- 模型：claude-opus-4-7（1M context）
- 配套审核：[PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md)
- 完成时间：2026-05-16
