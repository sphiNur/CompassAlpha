# CompassAlpha 上线前审核报告

> 审核范围：`CompassAlpha/` 全量（前端、后端、`bot`、`worker`、共享 `packages/*`、`infra/`、CI、部署脚本、文档）
> 审核口径：安全 / 代码质量 / UI·UX / 性能·可扩展性 四维度对标大厂正式发布标准
> 审核日期：2026-05-16
> 审核范围之外：`CompassBeta/`（前代，按用户要求跳过）

---

## TL;DR

> 这是一份**架构精良、安全意识强、工程化规范完整**的代码库，但**当前状态距"正式上线"仍有数处必须修补的硬阻断**。

**整体评级：B+（工程化基础已具备大厂水准；少数运行期阻断尚未消除）**

- ✅ **基本功** —— TS strict + RLS + 事件溯源 + 幂等性 + 限流 + HMAC 时间安全比较 + 刷新令牌轮转 + 重放检测 + CSP + HSTS + 多语言 + a11y 基线 + CI 多重 drift guard，远超中小厂常见水平。
- 🚨 **真正的硬阻断** —— SPA 静态托管缺失（用户访问 `/` 会拿到 JSON 404）、CSP 与 `index.html` 内联脚本互斥、`VITE_DEV_MOCK_INIT_DATA` 在生产构建被读取（认证可被旁路）、生产部署运行在 Cloudflare quick-tunnel（一次性临时域名）、Bot 通知默认关闭（功能性缺失）。
- ⚠️ **大厂"像素级"差距** —— Caddyfile 占位域名未替换、`compass-api.service` 未入仓、ARCHITECTURE.md 与实现严重漂移（声称的 ABAC/Casbin/LinguiJS/Tailwind v4 等均未实现）、`AdminPage.tsx` 7477 行 / `admin.ts` 4539 行的单文件巨石、依赖 `@trpc/*` 仍是 RC 版。
- 🔵 **明确的优点** —— 见文末「值得保留与表彰的设计」一节。

**最短路径上线建议**：先修完 §P0 全部 5 条 + §P1 中标 ⓦ 的 3 条 = 共 8 项硬阻断，48~72 小时可达"可上线"。然后再开 §P2 / §P3 滚动改进。

---

## 严重程度图例

| 级别 | 含义 | 行动 |
|---|---|---|
| 🚨 **P0 / Blocker** | 上线即可能造成功能损坏、认证旁路、数据泄露 | 上线前必修 |
| ⚠️ **P1 / High** | 不立即造成事故但会显著放大故障半径，或大厂代码评审必驳回 | 上线前 / 首周内修 |
| 🟡 **P2 / Medium** | 偏向可维护性 / 一致性 / 体验细节 | M2 / M3 滚动 |
| 🔵 **P3 / Low** | 锦上添花、随手可清 | 任意时机 |

---

# 第一部分 · P0 硬阻断（上线前必修）

## 🚨 P0-1  生产环境无 SPA 静态托管，所有路径返回 JSON 404

**证据**：
- [apps/api/src/app.ts:271](apps/api/src/app.ts:271)：`app.notFound((c) => c.json({ code: 'NOT_FOUND', ... }, 404));`
- [apps/api/src/app.ts:269](apps/api/src/app.ts:269) 注释自陈：「Static SPA fallback (only in prod, where we serve dist/web from same process)」—— 但**实现缺失**，Hono 上没有任何 `serveStatic`、`hono/bun` 的静态中间件注册。
- 搜索 `serveStatic|hono/serve-static|hono/bun|app\.get\('\*'` 在 `apps/api/src` 下 **0 命中**。
- [infra/caddy/Caddyfile:19-34](infra/caddy/Caddyfile:19) 把所有路径反代到 `api:3000`，未设置 `root` / `file_server` —— Caddy 自身也不提供静态服务。

**用户视角影响**：直接访问 `https://compass.example.com/`、`https://...com/order`、`https://.../admin` 时浏览器收到 `{"code":"NOT_FOUND","i18nKey":"common.notFound"}` JSON。**整个应用不可访问**。

**说明**：smoke 脚本（[scripts/smoke.ts](scripts/smoke.ts)）声称会校验 SPA 入口 200 + 哈希引用，应当能 fail-fast。但如果 smoke 通过过历史 deploy（暗示某处确实在服务静态文件），则可能是服务器上有手工配置的 nginx / Caddy 的 file_server，**未入仓**——这本身就是 P0 级别的配置漂移。

**修复方案**：
1. **首选**：在 [apps/api/src/app.ts](apps/api/src/app.ts) 中加 `serveStatic` 中间件，挂在 tRPC mount 之后、`notFound` 之前：
   ```ts
   import { serveStatic } from 'hono/bun';
   app.use('/*', serveStatic({ root: './apps/web/dist' }));
   app.use('/*', serveStatic({ path: './apps/web/dist/index.html' })); // SPA fallback
   ```
2. **次选**：在 [infra/caddy/Caddyfile](infra/caddy/Caddyfile) 中加 `root * /srv/web` + `file_server` + `try_files {path} /index.html`，并把 `apps/web/dist` 通过 volume 挂载到 caddy 容器。
3. **同步修复**：把 Caddyfile 的 `handle_path /*` 改成语义正确的 `handle /*`（`handle_path` 会剥离匹配前缀，`/*` 整个被剥意味着上游收到空路径——Caddy 实际上不会让这种 case 发生，但写法本身错误且会让审阅者打问号）。

---

## 🚨 P0-2  生产 CSP 与 `index.html` 的内联脚本/外部脚本冲突

**证据**：
- [apps/api/src/app.ts:139-153](apps/api/src/app.ts:139) 设置 CSP `script-src 'self'`。
- [apps/web/index.html:62](apps/web/index.html:62) 加载外部脚本 `<script src="https://telegram.org/js/telegram-web-app.js">`。
- [apps/web/index.html:63-94](apps/web/index.html:63) 含**内联**启动守卫 `<script>(function(){...})()</script>`。
- [apps/web/index.html:106-107](apps/web/index.html:106) 内联 `onclick="location.reload()"` / `onclick="try{ localStorage.removeItem(...) ...}; location.reload();"`。

**用户视角影响**：一旦 P0-1 修复后 SPA 被正确托管，浏览器拿到 CSP header 即开始拒绝执行：
1. **Telegram WebApp SDK 加载失败** → `window.Telegram` 永远 `undefined` → 没有 `initData` → `auth.telegramLogin` 抛错 → 全员登录失败。
2. **启动守卫被屏蔽** → 加载失败的失败兜底机制失效。
3. **Reload / Reset 按钮失效** → 用户卡死时无恢复路径。

**修复方案**：CSP 必须放宽以下条目（添加，不删除已有）：
```
script-src 'self' 'unsafe-inline' https://telegram.org;
```
更优雅的做法是把内联脚本与 onclick 移除：
- 把 boot guard 改为 `<script src="/boot-guard.js">` 同源外联。
- 把 `onclick="..."` 改为 `<button id="boot-reload">`，并在 boot-guard 中 `document.getElementById('boot-reload').addEventListener('click', ...)`。
- 这样 CSP 仍可保留严格的 `'self' https://telegram.org`，没有 `'unsafe-inline'`。

**附加 P0-2.1（与 PhotoCapture 相关）**：[apps/api/src/app.ts:94-97](apps/api/src/app.ts:94)
```
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
```
拒绝了 `camera`。若 [packages/ui/src/components/PhotoCapture.tsx](packages/ui/src/components/PhotoCapture.tsx) 使用 `navigator.mediaDevices.getUserMedia()`，**收据/异常拍照功能将被浏览器静默屏蔽**。需要审计 PhotoCapture 的实现：
- 若用 `<input type="file" capture="environment">` —— **不受 Permissions-Policy 影响**，可放行。
- 若用 `getUserMedia` —— 必须改 Permissions-Policy 为 `camera=(self)`。

> 建议补一行 `grep -n getUserMedia packages/ui/src/components/PhotoCapture.tsx` 验证，本审核未读全 PhotoCapture（194 行）。

---

## 🚨 P0-3  `VITE_DEV_MOCK_INIT_DATA` 可在生产构建中旁路 Telegram 身份验证

**证据**：
- [apps/web/src/app/AuthGate.tsx:88](apps/web/src/app/AuthGate.tsx:88)：`const mock = import.meta.env.VITE_DEV_MOCK_INIT_DATA;`
- [apps/web/src/app/AuthGate.tsx:117](apps/web/src/app/AuthGate.tsx:117)：`const data = getTg()?.initData ?? import.meta.env.VITE_DEV_MOCK_INIT_DATA ?? '';`
- Vite 在构建时把 `import.meta.env.VITE_*` **内联**到产物里——production 构建只看构建时的 env，不看运行时。
- [scripts/deploy.ts:169](scripts/deploy.ts:169)：构建发生在**生产服务器上**（`cd /home/ubuntu/compass-alpha/apps/web && pnpm exec vite build`），用的是服务器的 `/home/ubuntu/compass-alpha/.env`。
- [.env.example:41](.env.example:41)：`VITE_DEV_MOCK_INIT_DATA=`（默认空，OK）。
- [README.md:36](README.md:36)、[CONTRIBUTING.md:196](CONTRIBUTING.md:196) 都在文档中提示开发者把这个值设为 `1`。

**攻击面**：如果服务器的 `.env` 中误带（或未来某个工程师为本地调试粘贴）此值，**生产 SPA 会把它当成有效 initData 发到 `auth.telegramLogin`**，后端 [services/telegramAuth.ts](apps/api/src/services/telegramAuth.ts) 会用真实 bot token 验签——`'1'` 当然验签失败——所以**目前**这条线索还活在"失败"的保护下。但风险点是：
1. 如果服务器 `.env` 写了某条**真实的过期 initData**或被某个工程师用合法 dev initData 替换，将允许冒充任意 Telegram 用户登录。
2. 当 Bot Token 在 `.env` 缺失时，[auth.ts:63-65](apps/api/src/trpc/routers/auth.ts:63) 直接抛 500——但发生时刻早于 mock 解码，是另一回事。

**修复方案**（任一）：
1. **加构建时硬开关**：在 [apps/web/vite.config.ts](apps/web/vite.config.ts) 里：
   ```ts
   if (mode === 'production' && process.env.VITE_DEV_MOCK_INIT_DATA) {
     throw new Error('VITE_DEV_MOCK_INIT_DATA must NOT be set in production builds');
   }
   ```
2. **删除运行时分支**：用 `import.meta.env.DEV` 守护：
   ```ts
   const mock = import.meta.env.DEV ? import.meta.env.VITE_DEV_MOCK_INIT_DATA : null;
   ```
   `import.meta.env.DEV` 在 production 构建一定是 `false`，整个分支会被 dead-code-elimination 干掉。
3. **CI / deploy.ts 增加 grep 校验**：构建前 `grep VITE_DEV_MOCK_INIT_DATA /home/ubuntu/compass-alpha/.env` 命中即 abort。

---

## 🚨 P0-4  生产 URL 是 Cloudflare quick-tunnel（一次性临时域名）

**证据**：
- [scripts/smoke.ts:19](scripts/smoke.ts:19)：默认 BASE = `https://franchise-cheese-pound-mills.trycloudflare.com`
- [scripts/browser-smoke.ts:25](scripts/browser-smoke.ts:25)、[scripts/browser-smoke-deep.ts:27](scripts/browser-smoke-deep.ts:27)：同样指向 trycloudflare.com 默认值。
- [AUTOSESSION_LOG.md:627](AUTOSESSION_LOG.md:627)：「The trycloudflare quick-tunnel URL still rotates on cloudflared」—— 自陈这是会**轮换**的临时 URL。
- [infra/caddy/Caddyfile:11](infra/caddy/Caddyfile:11) 的 `compass.example.com` 仍是**未替换的占位符**。

**问题**：
- `*.trycloudflare.com` 是 Cloudflare 的「Quick Tunnel」——免费、零配置、**重启即换域名**，**不提供任何 SLA**，禁止生产使用（Cloudflare 文档明确说明：「Quick Tunnels are designed for testing only」）。
- 这意味着每次重启 `cloudflared` 进程，URL 变化，所有用户 / Telegram 配置的 WebApp URL / 已存的浏览器历史全部失效。
- 此外，TLS 证书由 Cloudflare 控制，无 HSTS preload 资格（用户依赖临时域名时 HSTS 也无意义）。

**修复方案**：
1. 注册正式域名（任意 .com / .app / .io），通过 DNS 指向 Tencent Cloud VPS `129.204.59.183`。
2. 在该 VPS 上跑 [infra/caddy/Caddyfile](infra/caddy/Caddyfile)（替换 `compass.example.com` 为新域名），Caddy 会自动用 Let's Encrypt 申请证书。
3. 在 BotFather 把 WebApp URL 指向新域名。
4. 把所有 smoke 脚本的默认 BASE 改为新域名（保留 `COMPASS_BASE` 环境变量覆盖能力）。

---

## 🚨 P0-5  Bot 通知通道默认关闭——产品功能性缺失

**证据**（来自 Explore agent 对 `apps/worker/src/main.ts` 的扫描）：
- `BOT_DELIVERY_ENABLED` 默认 `false`，注释「Telegram unreachable from prod」（参考 [apps/worker/src/main.ts:58-77](apps/worker/src/main.ts:58)）。
- [ARCHITECTURE.md:497-503](ARCHITECTURE.md:497) 承诺「Bot 是主通知通道」，并列举十余个触发点（订单待审、补货异常、采购完成…）。
- [packages/i18n/src/catalogs/*](packages/i18n/src/catalogs/) 已经准备好对应通知文案。

**用户视角影响**：
- 订单提交、被审批、被拒、跑趟完成…**所有 Telegram 推送都不会发**。
- 用户只能靠 In-App 红点 + 主动打开应用刷新才能感知状态变化。
- 这与 README / ARCHITECTURE 的承诺严重不符，是**产品级缺陷**而非工程瑕疵。

**根因**：服务器到 Telegram 的网络不通（中国大陆出境）。

**修复方案**（按工作量从小到大）：
1. **首选**：在 Telegram API 路径上加 SOCKS5 代理，worker 通过代理出网。
2. **次选**：把 worker 推送转发到 Cloudflare Workers / 跑在墙外的 VPS 中转。
3. **最不济**：在 README / ARCHITECTURE 明确标注「Bot 通道在 M2 启用」，并把 UI 中所有「我们会通过 Telegram 通知你」的文案改为「请关注应用内通知」。

---

# 第二部分 · P1 高优问题（首周内必修）

## ⚠️ P1-1 ⓦ  `console.log(tsv)` 在生产代码中泄漏导出数据到浏览器控制台

**证据**：[apps/web/src/pages/AdminPage.tsx:6871](apps/web/src/pages/AdminPage.tsx:6871)：`console.log(tsv);`

**风险**：CSV/TSV 导出函数把全表数据打印到浏览器控制台。如果用户在公共设备打开 devtools 或浏览器历史可被他人翻阅，**整库可见数据外泄到日志**。

**修复**：删除该行；如必须，加 `if (import.meta.env.DEV) console.log(...)` 守护。

---

## ⚠️ P1-2 ⓦ  生产服务器 IP 硬编码在 `scripts/deploy.ts`

**证据**：[scripts/deploy.ts:44](scripts/deploy.ts:44)：`const HOST = 'ubuntu@129.204.59.183';`

**风险**：
- IP 进入版本控制 / 任何代码外发渠道（PR、Slack 截图、issue tracker）即被记录。
- 若服务器迁移，所有人需改源码。
- 该 IP 是 Tencent Cloud 北京区——攻击者可针对性扫描 SSH（22/tcp）。

**修复**：
```ts
const HOST = process.env.COMPASS_DEPLOY_HOST;
if (!HOST) { console.error('Set COMPASS_DEPLOY_HOST=ubuntu@<ip>'); process.exit(2); }
```
工程师本地的 `.zshrc` / `.bashrc` 维护该 env；CI/CD 通过 GitHub Secrets 注入。

---

## ⚠️ P1-3 ⓦ  `compass-api.service` 未入仓——配置漂移风险

**证据**：
- [infra/systemd/](infra/systemd/) 只含 `compass-worker.service`、`compass-backup.service`、`compass-backup.timer`。
- [scripts/deploy.ts:139](scripts/deploy.ts:139)：`sudo systemctl restart compass-api compass-worker`—— api 单元从未由部署脚本下发。
- [compass-worker.service:3](infra/systemd/compass-worker.service:3) 又 `After=postgresql.service compass-api.service`，依赖一个仓库里不存在的单元。

**风险**：服务器上 compass-api.service 由初代工程师手工写就，未版本化。一旦服务器迁移 / 重装，新机不可启。

**修复**：把服务器上的 `/etc/systemd/system/compass-api.service` 复制回仓库 `infra/systemd/compass-api.service`，加进 deploy.ts 的第 4a 步同步分发。

---

## ⚠️ P1-4  Caddyfile 占位域名未替换 + 头部不一致

**证据**：[infra/caddy/Caddyfile:5,11](infra/caddy/Caddyfile:5)：`compass.example.com`、`email ops@compass.example.com`。

**风险**：上线时若使用此文件不替换，Caddy 将永远不给真实域名签发证书。

**修复**：把域名抽到 `{$DOMAIN}` 环境变量，由 docker-compose / systemd 注入。同步把 Caddyfile 的 `Permissions-Policy` 与 app.ts 对齐（app.ts 多了 `payment=()`、`usb=()`）。

---

## ⚠️ P1-5  Dockerfile 未构建 `bot` 与 `worker` 但 compose 启动它们

**证据**：
- [infra/docker/Dockerfile:27-28](infra/docker/Dockerfile:27)：只构建 `@compass/web` 与 `@compass/api`。
- [infra/compose/docker-compose.prod.yml:32-33,40-41](infra/compose/docker-compose.prod.yml:32)：
  ```yaml
  bot:    command: ['bun', 'run', 'apps/bot/dist/main.js']
  worker: command: ['bun', 'run', 'apps/worker/dist/main.js']
  ```
- `apps/bot/dist` 与 `apps/worker/dist` **不存在**——容器启动即崩。

**修复**：在 Dockerfile 加：
```dockerfile
RUN pnpm --filter @compass/bot build
RUN pnpm --filter @compass/worker build
```
或者把 compose 改为 `bun run apps/bot/src/main.ts`（systemd 的 worker.service 走的就是这条路径）。

---

## ⚠️ P1-6  `@trpc/server`、`@trpc/client`、`@trpc/react-query` 仍在 `11.0.0-rc.648` 预发布

**证据**：
- [apps/api/package.json:22](apps/api/package.json:22)
- [apps/web/package.json:20-21](apps/web/package.json:20)

**风险**：RC 版本可能有未消化的 break，下次升级到 11.0.0 stable 时可能因 API 调整需要二次返工。tRPC v11 stable 已于 2026 年发布，可直接升。

**修复**：`pnpm up @trpc/server@^11 @trpc/client@^11 @trpc/react-query@^11`，跑 type-check + 集成测试。

---

## ⚠️ P1-7  `index.html` 启动文案与 `<html lang="en">` 均为英文硬编码

**证据**：[apps/web/index.html:2,14,98-110](apps/web/index.html:2)：
- `<html lang="en">` 固定 en。
- `Compass`、`Starting up…`、`Boot failed`、`App did not start within 12 s. Likely a JS module loading error.`、`Reload`、`Reset & reload` 全英文。

**风险**：CompassAlpha 主战场是乌兹别克斯坦中餐厅，前端 i18n 投入到 zh/ru/uz/en 四语言（[packages/i18n/src/catalogs/](packages/i18n/src/catalogs/)，每语 ~900 keys），却让首屏（启动失败时唯一可见的内容）只有英文。

**修复**：
1. 主线读 Telegram `initDataUnsafe.user.language_code` 在 `<script>` 中切换文案，按 zh/ru/uz/en 提供 4 套：
   ```js
   const lang = (navigator.language || 'en').slice(0,2);
   const TEXT = {
     zh: { startingUp: '启动中…', bootFailed: '启动失败', ... },
     ru: { ... }, uz: { ... }, en: { ... }
   }[lang in {zh:1,ru:1,uz:1}? lang : 'en'];
   ```
2. `<html lang="en">` 改成 `<html lang>` 然后 React mount 后用 `document.documentElement.lang = i18n.locale`。

---

## ⚠️ P1-8  ARCHITECTURE.md 与现实严重漂移——读者被误导

**证据 vs 实现对照**：

| ARCHITECTURE.md 声称 | 实际实现 |
|---|---|
| Hono + tRPC + Drizzle (Bun) | ✅ 一致 |
| Event-sourced 领域核心 | ✅ 一致（`packages/domain` + `events` + `decide` + `apply`） |
| Postgres RLS | ✅ 一致（[packages/db/src/rls.ts](packages/db/src/rls.ts)） |
| **Casbin-style ABAC + 策略引擎** | ❌ 不存在 `apps/api/src/policy/`，无表达式求值器。只有 `member_permission_overrides` 单 key allow/deny |
| **WebSocket + SSE 双通道** | ⚠️ 只有 WS（[apps/api/src/main.ts:50](apps/api/src/main.ts:50)），无 SSE / `realtime/sse.ts` |
| **完整 Offline-First**: SW + IDB + 同步协议 | ⚠️ 无 Service Worker；只有 IDB outbox（[apps/web/src/hooks/useOfflineQueue.ts](apps/web/src/hooks/useOfflineQueue.ts)） |
| **Bot + WebPush + In-App 三通道** | ⚠️ Bot 默认关闭（P0-5），WebPush 仅占位 no-op，仅 In-App 可用 |
| **LinguiJS ICU MessageFormat** | ❌ 自研 `packages/i18n`，手写 `{name}` 解析器，注释明确「待 M2 换 @formatjs」 |
| **双主题 Native / Apple** | ⚠️ ThemeProvider 支持但只见 `data-theme` 切换，未见两套 token 文件 |
| **Tailwind v4 + OKLCH `@theme` block** | ❌ [apps/web/package.json:34](apps/web/package.json:34) `tailwindcss: ^3.4.14` |
| **TanStack Router (v1) 文件路由** | ❌ 装了但未用；Shell 用 tab 状态 + lazy import |
| **OpenTelemetry 全链路** | ⚠️ `packages/telemetry` 存在但客户端实现是 batch span exporter 到自有端点，**未接 OTel collector** |
| **k6 负载测试** | ❌ 未发现 `tests/load/` 目录 |
| **`compass` CLI 完整命令集** | ⚠️ 仅 `org`、`user`、`project`、`test` 子命令，缺 `migrate`、`logs tail`、`deploy`、`impersonate` |

**修复**：要么把 ARCHITECTURE.md 改成「现状文档」+「未来路线图」分节；要么把实现补齐。**对于上线，建议改文档**——把未实现的标记为 "M2/M3 Planned"，避免新工程师 / 安全审计员被误导。

---

# 第三部分 · P2 中优问题

## 🟡 P2-1  巨石单文件——`AdminPage.tsx` 7477 行 / `admin.ts` 4539 行

**证据**：
- [apps/web/src/pages/AdminPage.tsx](apps/web/src/pages/AdminPage.tsx) 7477 行（M1.5 audit 已自陈，决定本轮不拆）
- [apps/api/src/trpc/routers/admin.ts](apps/api/src/trpc/routers/admin.ts) 4539 行
- [apps/web/src/pages/RunPage.tsx](apps/web/src/pages/RunPage.tsx) 3480 行

**大厂视角**：单文件超过 1500 行即开始触发 review 抗拒——超过 3000 行实质上无法被任何人完整理解，bug 滋生地。代码本身质量好但**结构上不可持续**。

**修复**（M2 起滚动）：
- AdminPage 按子域拆：`Admin/Members/`, `Admin/Roles/`, `Admin/Catalog/`, `Admin/Audit/`, `Admin/Debug/`。
- admin.ts router 按资源拆：`adminMembers.ts`、`adminCatalog.ts`、`adminStores.ts`、`adminSuppliers.ts`、`adminAudit.ts`，在 [trpc/router.ts](apps/api/src/trpc/router.ts) 合并 namespace。

---

## 🟡 P2-2  限流是单进程内存——多副本扩展即失效

**证据**：[apps/api/src/services/rateLimit.ts](apps/api/src/services/rateLimit.ts) 是进程局部 `Map`。代码注释自陈「单实例下 OK，未来切到 Redis」。

**影响**：
- 进程重启即重置 → 部署窗口内有短暂限流真空。
- 一旦扩展到 ≥ 2 副本，每副本独立计数，攻击者拿 2× 上限。

**修复**：换成 Redis 滑窗（`INCR` + `EXPIRE`）或 token bucket。`REDIS_URL` 已经在 env 中。架构文档明确提示了换库路径。

---

## 🟡 P2-3  CORS 白名单包含 `*.trycloudflare.com` 是过宽的开发便利

**证据**：[apps/api/src/app.ts:174](apps/api/src/app.ts:174)：`origin.endsWith('.trycloudflare.com') → return origin`

**风险**：任何人都可以开一个 trycloudflare tunnel，伪造合法 Origin 调用带凭据的 API。结合 `credentials: true`，浏览器会自动带上目标用户的 cookie / Authorization（如果有的话）—— 不过此 API 用 Bearer Token 走 LocalStorage，CSRF 攻击面有限，但仍是过宽白名单。

**修复**：
- 生产 build 完全去掉这条匹配：`if (env.NODE_ENV === 'production') return null;`
- 或者改为白名单具体的当前 tunnel：`if (origin === env.CF_TUNNEL_URL) return origin;`

---

## 🟡 P2-4  TypeScript `as any` 出现在 tRPC 中间件——类型贯通的裂缝

**证据**：[apps/api/src/trpc/trpc.ts:66,119,180,214](apps/api/src/trpc/trpc.ts:66) 五处 `opts.ctx as any` / `result as any`。

**为什么**：tRPC v11 RC 在 generic 推导上对 middleware 的 ctx 类型不够友好，遂强转。

**修复**：定义共享的 `MiddlewareCtx` 类型显式标注 `t.middleware<MiddlewareCtx>(...)`，eslint 加 `@typescript-eslint/no-explicit-any: error` 阻止后续滋生。

---

## 🟡 P2-5  Web 启动文件中四处 `as { Telegram?: ... }` 类型断言重复

**证据**：[apps/web/src/main.tsx:24](apps/web/src/main.tsx:24)、[apps/web/src/app/App.tsx:16,18](apps/web/src/app/App.tsx:16)、[apps/web/src/hooks/useTelegram.ts:65](apps/web/src/hooks/useTelegram.ts:65)、[apps/web/src/app/Shell.tsx:179](apps/web/src/app/Shell.tsx:179) 重复定义 `Window.Telegram` 局部类型。

**修复**：在 `apps/web/src/types/telegram.d.ts` 写一次：
```ts
declare global {
  interface Window { Telegram?: { WebApp?: TelegramWebApp } }
}
```

---

## 🟡 P2-6  `<html lang="en">` 与 `<meta name="theme-color" content="#ffffff">` 固定

**证据**：[apps/web/index.html:2,9](apps/web/index.html:2)。

**问题**：
- `lang="en"` 影响屏幕阅读器朗读发音、SEO、Chrome 翻译提示——对一个 ru/uz/zh 用户应用不友好。
- `theme-color` 固定白，深色主题下产生「白色 Notch」割裂。

**修复**：
- React mount 后 `document.documentElement.lang = locale`。
- 通过 `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1c1c1e">` + light 版分离，与 [apps/web/src/styles/index.css](apps/web/src/styles/index.css) 的 tokens.css 对齐。

---

## 🟡 P2-7  Bot 与 Worker 零测试覆盖

**证据**（来自 Explore agent）：
- [apps/bot/src/](apps/bot/src/)：0 个测试文件。
- [apps/worker/src/](apps/worker/src/)：0 个测试文件。

**影响**：worker 是关键的 outbox 引擎 + 通知派发，bug 会导致**通知丢失或风暴**。零测试不可接受。

**修复**：至少加 3 个集成测试：
1. outbox drain happy path。
2. outbox 处理失败时 retries++ 不出队。
3. 幂等键 GC。

---

## 🟡 P2-8  CI 缺 lint step

**证据**：
- [.github/workflows/ci.yml](. github/workflows/ci.yml) 未跑 `pnpm lint`。
- [apps/web/package.json:10](apps/web/package.json:10) 配置了 `eslint . --max-warnings 0`。

**修复**：在 unit job 后加 `- run: pnpm lint`。

---

## 🟡 P2-9  缺少 Dependabot / Renovate 自动依赖更新

**证据**：`.github/` 下无 `dependabot.yml`，无 renovate config。

**风险**：依赖漂移到 EOL 版本时无提醒；安全漏洞披露后无自动 PR。

**修复**：加 `.github/dependabot.yml`：
```yaml
version: 2
updates:
  - package-ecosystem: pnpm
    directory: /
    schedule: { interval: weekly }
```

---

## 🟡 P2-10  Telegram Bot 使用 long-polling 而非 webhook

**证据**：[apps/bot/src/main.ts:30](apps/bot/src/main.ts:30) 用 `bot.start({})` —— grammY 默认 long-polling。

**问题**：
- 长连接出境到 Telegram，CN 服务器 RT 高 + 容易被 GFW 丢包。
- 与 P0-5 的「Telegram unreachable」根因一致。
- Webhook 让 Telegram 推到我们的 endpoint，方向反转，更稳；但需要公网 HTTPS。

**修复**：当 P0-4 完成（有正式域名），切到 webhook：
```ts
bot.api.setWebhook(`${env.PUBLIC_URL}/bot/webhook`);
```

---

## 🟡 P2-11  CompassBeta 源码与多个 `.tar.gz` 部署包堆在父目录

**证据**（来自 `ls C:\Users\surface\Desktop\gemini`）：
```
compass-alpha-deploy.tar.gz
compass-alpha-fix1.tar.gz ... compass-alpha-fix7.tar.gz
compass-alpha-hotfix1.tar.gz
compass-alpha-m1batch.tar.gz
compass-alpha.tar.gz
```
**+** CompassBeta 整个旧仓库。

**问题**：
- 占盘空间，部署 tar.gz 是 deploy.ts 的中间产物 / 历史快照。
- 容易误传到 GitHub Release 之类公共渠道。

**修复**：脚本结束后 `unlink` tar 包；用 `.archive/` 目录隔离历史快照并加进 `.gitignore`。

---

## 🟡 P2-12  Telegram Bot 单 token，无最小权限保障

**证据**：[apps/bot/src/main.ts:12](apps/bot/src/main.ts:12) 直接读 `process.env.TELEGRAM_BOT_TOKEN`。

**问题**：bot token 一旦泄露，攻击者可冒充 bot 发任意消息给所有用户。无 token 轮换。

**修复**：
- 在 BotFather 把 bot 设为 "Privacy mode on"。
- 准备 hot/cold 双 token，定期人工轮换（季度）。
- 把 `TELEGRAM_BOT_TOKEN` 改用 Docker secret 而非 env_file（避免 `cat /proc/<pid>/environ` 泄露）。

---

## 🟡 P2-13  根目录 `TgBotGemini.pem`——SSH 私钥裸放桌面

**证据**：`C:\Users\surface\Desktop\gemini\TgBotGemini.pem`（项目外部、与 CompassAlpha 平级）。

**问题**：
- 桌面上的私钥被任何运行在该 Windows 账户下的进程访问（恶意软件、IDE 插件、远程桌面服务）。
- 一旦泄露 = 生产服务器被攻陷。
- 没有 passphrase 保护（否则 deploy.ts 用 `ssh -i` 时会卡住交互）。

**修复**：
- 把 .pem 移到 `%USERPROFILE%\.ssh\` 并 ACL 锁权限。
- 用 ssh-agent + passphrase，避免明文 .pem。
- 长期方案：用 Cloudflare Access for SSH 或 Tailscale，免 SSH 公网暴露 + 私钥本身可吊销。

---

## 🟡 P2-14  Caddyfile `handle_path /*` 语义错误

**证据**：[infra/caddy/Caddyfile:19](infra/caddy/Caddyfile:19)：`handle_path /* { ... }`。

**问题**：`handle_path` 会**剥离**匹配的前缀。`/*` 意为剥离整个 path 后给上游空字符串。Caddy 实际可能跳过此剥离（因为剥光是 nonsense），但**写法本身**对审阅者造成困惑。

**修复**：`handle /* {` 即可（不剥前缀，只做路由）。

---

## 🟡 P2-15  数据库连接用同一个角色——RLS 信任边界依赖单点

**证据**：[infra/compose/docker-compose.prod.yml:51](infra/compose/docker-compose.prod.yml:51) `POSTGRES_USER: compass`。整个 api 进程连 PG 用 `compass` 角色。

**问题**：如果 `compass` 角色拥有 `BYPASSRLS`（或是 superuser），RLS 形同虚设。

**修复**：
1. 校验 `SELECT bypassrls FROM pg_roles WHERE rolname='compass';` 必须是 `f`。
2. 给 worker 单独的 `compass_jobs` 角色，授予跨租户读写所需的最小权限，杜绝 worker 走应用层 org_id 过滤的疏漏。

---

## 🟡 P2-16  Sourcemap 默认关——但缺少远端 sourcemap 上传，生产报错无法回溯

**证据**：[apps/web/vite.config.ts:54](apps/web/vite.config.ts:54)：`sourcemap: process.env.VITE_SOURCEMAP === 'true'`。注释正确指出「不能给浏览器看 sourcemap，但 sentry 风格的远端上传也未实现」。

**修复**：
- 构建时 `VITE_SOURCEMAP=true` 生成 `*.map`，上传到 Sentry / GlitchTip / 自建 OTel collector，然后 **从 dist 目录删除** `*.map`。
- 用 `vite-plugin-sentry` 等可自动完成。

---

## 🟡 P2-17  WS 鉴权使用 access token 而非 short-lived ws-ticket

**证据**：[apps/api/src/main.ts:51-57](apps/api/src/main.ts:51)：「Auth via short-lived ?token=<jwt>; we accept the same access token the SPA uses for tRPC (M2 will replace with a dedicated ws-ticket procedure)」。

**问题**：
- access token 通过 URL query string 传递 → 进 Caddy access log → 落盘明文。
- 15min TTL 偏长（够攻击者用日志泄露的 token 建立长连接）。

**修复**：M2 任务，加 `auth.wsTicket()` procedure，颁发 30s TTL 单次使用的票据。

---

# 第四部分 · P3 低优 / 锦上添花

## 🔵 P3-1  Dockerfile 多余安装 nodejs+npm

[Dockerfile:6-7](infra/docker/Dockerfile:6)：`apk add nodejs npm` + `npm install -g pnpm@9.12.0`。

`oven/bun:1.1.38-alpine` 已自带 bun，可用 `bun install -g pnpm` 或在更上层用 `corepack enable && corepack prepare pnpm@9.12.0 --activate`，省 ~80MB layer。

## 🔵 P3-2  `apps/web/src/styles/index.css` 中 `*:focus-visible { outline: none; }` 与 a11y 冲突

[apps/web/src/styles/index.css:20-22](apps/web/src/styles/index.css:20)：禁掉默认 focus 轮廓。Button 组件自己加了 `focus-visible:ring-2`（[packages/ui/src/components/Button.tsx:11](packages/ui/src/components/Button.tsx:11)），但非 Button 元素（`<a>`、`<input>`、自定义可聚焦 div）就完全没了焦点提示——键盘用户残废。

**修复**：默认 ring：
```css
*:focus-visible { outline: 2px solid var(--c-ring); outline-offset: 2px; }
```
然后组件按需 `focus-visible:outline-none focus-visible:ring-2`。

## 🔵 P3-3  `ErrorBoundary.tsx:39` 留有 `console.error('[ErrorBoundary]', ...)`

[apps/web/src/app/ErrorBoundary.tsx:39](apps/web/src/app/ErrorBoundary.tsx:39)。可保留——这是兜底，仍应走 `getLogger().error(...)` 而非 console。

## 🔵 P3-4  `<meta name="viewport" ... user-scalable=no>` 阻止用户缩放

[apps/web/index.html:5-8](apps/web/index.html:5)。WCAG 2.1 SC 1.4.4 要求文字至少 200% 缩放——`user-scalable=no` 直接违反。Telegram WebApp 实践常这样写，但应在能确保所有文字均通过其他方式可放大的前提下。

**修复**：移除 `user-scalable=no, maximum-scale=1`，保留 `width=device-width, initial-scale=1, viewport-fit=cover`。

## 🔵 P3-5  i18n 自研 `format()` 不支持 ICU plural

[packages/i18n/src/index.ts:51-63](packages/i18n/src/index.ts:51) 注释自陈待 M2 换 `@formatjs/intl-messageformat`。当前用 `stripPluralWrappers` 兜底剥 plural 块——可读性差，bug 滋生。

**修复**：上线后立刻拨给 M2：换 `@formatjs/intl-messageformat`，~5KB gzip。

## 🔵 P3-6  Worker 没有运行 metric 暴露

`apps/worker/src/main.ts` 跑后只有 console / journal 日志。无 `/metrics` 端点供 Prometheus 抓取——backlog 大小、retry 数、heartbeat 都不可观测。

**修复**：暴露 `/metrics` HTTP 端点（Prometheus exposition format），加进 docker-compose（worker 单开端口）。

## 🔵 P3-7  缺少 robots.txt / sitemap.xml

应用对 SEO 无意义（背后是私域 Telegram Mini App），但加一行 `User-agent: * \n Disallow: /` 可避免被搜索引擎尝试索引（白屏 / 401 / JSON 错误页污染搜索结果）。

## 🔵 P3-8  缺少 PWA manifest.json

[apps/web/](apps/web/) 没有 `public/manifest.json`，ARCHITECTURE 承诺的 PWA 双形态未实现。`<link rel="manifest">` 也无。如果未来需要让用户「添加到主屏」，需补。

## 🔵 P3-9  `AUTOSESSION_LOG.md` 入仓——大厂 review 会反弹

`AUTOSESSION_LOG.md` 看起来是 AI 助手会话日志。可保留作历史，但放在仓库根目录跟 README 同级会迷惑外部审阅者。建议放进 `.archive/` 或加进 .gitignore 后写到本地。

## 🔵 P3-10  根目录 `smoke-failure-shell.png` 入仓

调试截图不应入主线分支。删除或挪到 `.archive/`。

---

# 第五部分 · 各维度专题评估

## 5.1 安全（Security）

| 项 | 评级 | 说明 |
|---|:-:|---|
| Telegram initData HMAC 验证 + 常量时间比较 | ✅ A | [services/telegramAuth.ts](apps/api/src/services/telegramAuth.ts) 已修，`timingSafeEqual` |
| JWT (HS256, 15min access / 30d refresh, jti tracking, family revoke, replay detect) | ✅ A | [services/refreshTokens.ts](apps/api/src/services/refreshTokens.ts) 教科书级别 |
| Postgres RLS + `withOrgContext` 事务包裹 | ✅ A- | 实施完整，但**未验证连接角色非 BYPASSRLS**（见 P2-15） |
| 速率限流（auth / mutation） | ✅ A- | 进程内 Map，单实例 OK；扩展到多副本需换 Redis |
| HMAC 时钟漂移 ±600s 容忍 | ✅ A | 真实场景考虑充分 |
| 幂等键（X-Idempotency-Key + DB cache） | ✅ A | risk-of-double-charge 类 mutation 全覆盖 |
| 上传：presigned PUT + content-type 白名单 + 8MB 上限 | ✅ A- | key 强制包含 `orgId/userId`，无法越权写他人 namespace |
| CSP / HSTS / X-Frame-Options / Referrer / Permissions Policy | ⚠️ B | CSP 设置严格但**未与 index.html 内联脚本对齐**（P0-2）；Permissions-Policy 可能误伤拍照功能 |
| CORS 白名单 | ⚠️ B | `*.trycloudflare.com` 过宽（P2-3） |
| 凭据管理 | ⚠️ C | `.env` 加密 ✓；但 `TgBotGemini.pem` 桌面裸放（P2-13）；生产 IP 入源码（P1-2） |
| 模拟 initData 旁路风险 | 🚨 D | `VITE_DEV_MOCK_INIT_DATA` 进入生产构建（P0-3） |
| SQL 注入 | ✅ A | Drizzle 全 parameterized，唯一 raw SQL 处（`set_config`）已用 sql template |
| XSS | ✅ A | 全代码无 `dangerouslySetInnerHTML`、`eval`、`innerHTML =` |
| CSRF | ✅ N/A | Bearer token 走 LocalStorage，不走 cookie，CSRF 不适用 |

## 5.2 代码质量与工程化（Code Quality）

| 项 | 评级 | 说明 |
|---|:-:|---|
| TypeScript `strict` + 额外 `noUncheckedIndexedAccess` / `noUnusedLocals` 等 | ✅ A | [tsconfig.base.json:17](tsconfig.base.json:17) 配置严格 |
| ESLint `--max-warnings 0` | ✅ A | 但**未跑在 CI**（P2-8） |
| `as any` / `@ts-ignore` 数量 | 🟡 B+ | 5 处在 trpc middleware，0 处在业务代码（P2-4） |
| 单元 + 集成测试 | ✅ A | 1500+ 行 domain unit，5 个 PG-gated integration（CI 跑） |
| 测试覆盖盲区 | ⚠️ C | bot 0 测试，worker 0 测试（P2-7） |
| 注释质量 | ✅ A+ | 极高水准，每个关键决策有 milestone 标签 + 为什么 |
| 命名一致性 | ✅ A | i18n key 全 dot.camelCase（M1.9-extra 修复后）；ULID + UUID 用法清晰 |
| 错误模型统一 | ✅ A | `DomainError` → tRPC errorFormatter → FE i18nKey 一根链 |
| 巨石文件 | ⚠️ C | AdminPage 7477 行 / admin.ts 4539 行（P2-1） |
| 架构文档真实性 | 🚨 D | ARCHITECTURE.md 多处与实现不符（P1-8） |
| Migration 一致性 | ✅ A | CI 强制 journal 与 .sql 文件对齐 |
| 依赖锁版本 | ✅ A | `--frozen-lockfile`，但用 RC（P1-6） |

## 5.3 UI / UX （前端）

| 项 | 评级 | 说明 |
|---|:-:|---|
| 设计系统（packages/ui）完备性 | ✅ A | 29 个组件，CVA + Radix 原语 + token 驱动；Sheet 自动接管 Telegram BackButton |
| 字体排印（M3.14 调小一档） | ✅ A | 字号 24/19/15/14/13/12/11/10/9，按设备/平台调校，h1/h2 烘焙 weight，其他可调 |
| Eyebrow 字距 token + CI 防漂移 | ✅ A+ | `tracking-eyebrow: 0.08em` + CI 检查（[ci.yml:109-157](.github/workflows/ci.yml:109)） |
| 触控目标 | ✅ A | Button md=h-10 (40px) / lg=h-13 (52px) / QtyControl 44×44 对称 |
| 深色模式 | 🟡 B | ThemeProvider 接入 Telegram themeChanged，但 token 文件未单独看到两套；启动 splash `prefers-color-scheme` 兼容 |
| a11y 焦点轮廓 | 🟡 B | Button 有 ring，但全局 `*:focus-visible{outline:none}`（P3-2） |
| `user-scalable=no` 违反 WCAG 1.4.4 | 🔵 P3 | 大厂级别会被驳（P3-4） |
| 启动 splash 多语言 | 🟡 B | 全英文（P1-7） |
| Telegram 集成深度（MainButton / BackButton / SettingsButton / Haptic） | ✅ A+ | `usePageMainButton` 防 flicker；Sheet 自动 BackButton；haptic 分级 |
| 离线支持 | 🟡 B | IDB outbox + 网络恢复重放，但无 Service Worker / 不可装 PWA |
| 响应式 | ✅ A | 移动优先 + viewport-fit=cover + safe-area-inset 计算 |
| 错误兜底 / 空状态 | ✅ A | EmptyState / Spinner / Banner 一致 |
| 国际化 | ✅ A | zh/ru/uz/en 全覆盖，CI parity 检查；Telegram 语言自动检测 + 用户偏好持久化 |
| 表单可访问性 | ✅ A- | Input/Textarea 有 `<label>` 关联，autoFocus 控制谨慎；Sheet `deferAutoFocusMs` 解决 iOS 键盘抢焦点 |
| 动效 | ✅ A | 240ms slideUp + fade + token 化的 `--t-base` / `--easing` |

## 5.4 性能与可扩展性

| 项 | 评级 | 说明 |
|---|:-:|---|
| 后端冷启动 | ✅ A | Hono on Bun，~30ms（架构文档声称） |
| 数据库索引 | ✅ A | 关键唯一约束 + 复合索引齐备（[packages/db/src/schema/auth.ts](packages/db/src/schema/auth.ts) 等） |
| N+1 | ✅ A | 抽查 [routers/order.ts](apps/api/src/trpc/routers/order.ts)、[routers/run.ts](apps/api/src/trpc/routers/run.ts) 均用 join / inArray 批量 |
| 投影器 (orderProjection / runProjection) | ✅ A- | 思路清晰，idempotent；未审计实际 SQL 执行计划 |
| 前端 bundle 分包 | ✅ A | AdminPage / RunPage lazy() + prefetch on idle |
| sourcemap | ⚠️ B | 生产无（防泄）；但无远端 sourcemap 上传（P2-16） |
| QueryClient 调优 | ✅ A | `refetchOnWindowFocus:false` + useRealtime 400ms coalesce |
| Optimistic Update | ✅ A | 教科书级别的 debounce + per-key serialize（[OrderPage.tsx:91-120](apps/web/src/pages/OrderPage.tsx:91)） |
| WebSocket | ✅ A- | Native Bun WS + 25s pingAll + hub.subscribe；fallback SSE 未实现 |
| 单实例瓶颈 | 🟡 B | 限流 + 实时 hub 都是单进程，扩展到多副本需重构（P2-2） |
| Bundle 大小目标 | ⚠️ B | 架构文档承诺首屏 ≤ 180KB gzip，本审核未实测；建议补一行 deploy.ts `du -h dist/*.js` 验证 |

## 5.5 基础设施与部署

| 项 | 评级 | 说明 |
|---|:-:|---|
| Dockerfile 多阶段 | ✅ A- | 但浪费层 + 未构建 bot/worker（P1-5 / P3-1） |
| Caddy 反向代理 + 自动 TLS | ✅ A- | Caddyfile 内容正确但有占位符（P1-4） |
| systemd 单元完备性 | 🚨 C | api.service 未入仓（P1-3）；worker.service 正确 |
| 健康检查 | ✅ A | `/health/live` + `/health/ready` (DB ping + projector lag) + `/health/version` |
| 蓝绿 / 滚动部署 | ❌ D | 当前 deploy.ts 是 `systemctl restart` —— 有秒级流量黑洞；架构承诺的蓝绿未实现 |
| 备份策略 | ✅ A+ | pg_dump -Fc + TOC 验证 + ≥ 1 KiB sanity + 14d 轮转 + 可选 S3 上传 + 失败 systemd 上报 |
| 备份恢复演练 | ⚠️ B | restore.sh 入仓但未自动化；建议每月人工验一次 |
| CI 流程 | ✅ A | 双 job：unit + integration（PG service）+ migration journal + i18n parity + typography drift |
| 缺 lint / dependabot | 🟡 P2 | （P2-8 / P2-9） |
| 凭据管理 | 🟡 B | env_file 注入；TG token 在 env，未走 Docker secret（P2-12） |
| 部署稳定性 | 🚨 C | quick-tunnel 不能用于生产（P0-4） |

---

# 第六部分 · 值得保留与表彰的设计（不要在重构中被弄丢）

下面这些做法已经达到或超越大厂水准，**修复 P0/P1 时务必保持不变**：

1. **Refresh token 家族 + 重放检测**（[services/refreshTokens.ts](apps/api/src/services/refreshTokens.ts)）—— 业界标杆实现，含 graceful migration（M1.9 之前的 jti-less token 给予一次性宽限）。
2. **Telegram initData 验证的常量时间比较 + ±600s 时钟漂移容忍**（[services/telegramAuth.ts](apps/api/src/services/telegramAuth.ts)）—— 真实世界 iOS 时钟问题考虑到位。
3. **idempotentMutation tRPC middleware**（[trpc.ts:178-237](apps/api/src/trpc/trpc.ts:178)）—— 24h cache + (key, route, userId) 唯一索引 + 失败不缓存。
4. **storeScope 三件套** —— `assertActorAssignedToStore` / `getActorStoreIds` / `effectivePermissionsForStore`（[storeScope.ts](apps/api/src/services/storeScope.ts)）。RBAC + per-store allow/deny override 完整覆盖大厂 RBAC 模型的 80%。
5. **Sheet 自动接管 Telegram BackButton + 全局 sheet 计数器**（[packages/ui/src/components/Sheet.tsx:30-58](packages/ui/src/components/Sheet.tsx:30)）—— 28 个 sheet 一次性修复，无 per-call-site 改动。
6. **`usePageMainButton` 防 flicker**（[useTelegram.ts:190-265](apps/web/src/hooks/useTelegram.ts:190)）—— ref 隔离 onClick 绑定与 per-render 更新，避免 iOS WebView 的 show/hide blip。
7. **Single-flight refresh token**（[lib/trpc.ts:19-66](apps/web/src/lib/trpc.ts:19)）—— 4 个 OrderPage 并发查询同时 401 时，只发一次刷新请求。
8. **CI 三重 drift guard** —— migration journal、i18n parity、typography drift（[ci.yml:73-157](.github/workflows/ci.yml:73)）—— 把"代码评审里靠人脑记住的事"全部自动化。
9. **错误日志中间件**（[trpc.ts:53-83](apps/api/src/trpc/trpc.ts:53)）—— 4xx warn / 5xx error 分级 + traceId + userId + path 结构化，journalctl 里直接 grep 路径定位。
10. **`/health/ready` 真做 DB ping + projector lag**（[app.ts:215-249](apps/api/src/app.ts:215)）—— 不是无脑 `{status:'ok'}`，LB 切流量正确。
11. **WebSocket 25s pingAll**（[main.ts:120-128](apps/api/src/main.ts:120)）—— 防 idle 被 Cloudflare 60s 切断。
12. **备份脚本三道闸**（[compass-backup.sh](infra/backup/compass-backup.sh)）—— 大小 + TOC + S3 失败不阻塞本地。
13. **OrderPage Optimistic Update 五层架构**（[OrderPage.tsx:91-120](apps/web/src/pages/OrderPage.tsx:91) 注释）—— `optimistic-on-tap + per-key debounce 250ms + per-key serialize + submit-awaits-flush + no-snap-rollback`。这是高延迟到中国大陆环境下的真实工程问题，处理方案教科书级别。
14. **DR (Decision Record) 模式**（[ARCHITECTURE.md:763-781](ARCHITECTURE.md:763)）—— 把决策摆台面。即使现实漂移了，思想方法正确。
15. **i18n CI parity + 4 语言全覆盖** —— 文档 / UI / 错误消息全 i18n key，CI 强制对齐。

---

# 第七部分 · 上线动作清单（建议优先级排序）

## 阶段 A — 上线前必修（48~72h，5 个 P0 + 3 个标 ⓦ 的 P1）

- [ ] A1. 补 SPA 静态托管（P0-1）—— Hono `serveStatic` 或 Caddy `file_server`
- [ ] A2. 调整 CSP 与 index.html 内联脚本对齐（P0-2 + P0-2.1）
- [ ] A3. 阻断 `VITE_DEV_MOCK_INIT_DATA` 在生产构建（P0-3）
- [ ] A4. 申请正式域名 + 切 Caddy / 关 trycloudflare（P0-4）
- [ ] A5. 通 Telegram bot 出境网络（P0-5）
- [ ] A6. 删 `console.log(tsv)`（P1-1）
- [ ] A7. 生产 IP 移出源码到环境变量（P1-2）
- [ ] A8. `compass-api.service` 入仓 + deploy.ts 同步分发（P1-3）

## 阶段 B — 首周内（剩余 P1）

- [ ] B1. Caddyfile 占位域名 + Permissions-Policy 对齐（P1-4）
- [ ] B2. Dockerfile 加 bot/worker build（P1-5）
- [ ] B3. tRPC RC → stable 升级（P1-6）
- [ ] B4. 启动 splash 多语言 + `<html lang>` 动态化（P1-7）
- [ ] B5. ARCHITECTURE.md 重写为现状 + 路线图（P1-8）

## 阶段 C — M2 滚动（P2）

按 P2-1 ~ P2-17 的顺序，每周一项。

## 阶段 D — M3+（P3）

按 P3-1 ~ P3-10 在余力时清理。

---

# 第八部分 · 上线 GO/NO-GO Checklist

> 这是最终拨杆。每项都需要可证明的"绿"才能 GO。

| # | 检查项 | 检查命令/证据 | 状态 |
|---|---|---|---|
| 1 | 正式域名 + Caddy auto-TLS | `curl -I https://<新域名>/` 返回 200 + valid LE 证书 | ☐ |
| 2 | SPA 入口可访问 | `curl https://<域名>/` 返回 HTML，含 `<div id="root">` | ☐ |
| 3 | SPA 路由 fallback 工作 | `curl https://<域名>/order` 返回相同 HTML | ☐ |
| 4 | CSP 允许 telegram.org 与必要内联脚本 | 浏览器 devtools Console 无 CSP violation | ☐ |
| 5 | Telegram WebApp SDK 加载成功 | `window.Telegram?.WebApp` 存在 | ☐ |
| 6 | `auth.telegramLogin` 真实 initData 工作 | 在 Telegram 内打开 mini app 能登录 | ☐ |
| 7 | `VITE_DEV_MOCK_INIT_DATA` 未泄入 prod | `grep -a VITE_DEV_MOCK_INIT_DATA apps/web/dist/assets/index-*.js` 应为空 | ☐ |
| 8 | tRPC 增删改查 happy path | smoke.ts 通过 | ☐ |
| 9 | Browser smoke 通过 | browser-smoke.ts + browser-smoke-deep.ts 通过 | ☐ |
| 10 | RLS 跨租户隔离 | rls-isolation.test.ts CI 绿 | ☐ |
| 11 | PG 角色非 BYPASSRLS | `SELECT bypassrls FROM pg_roles WHERE rolname='compass';` = `f` | ☐ |
| 12 | DB nightly backup 工作 | `systemctl status compass-backup.timer` active；`/home/ubuntu/compass-backups/` 有当日 dump | ☐ |
| 13 | Backup 恢复演练 | 手工 `pg_restore` 到隔离 DB 成功 | ☐ |
| 14 | api / worker journalctl 无 ERROR | `journalctl -u compass-api -u compass-worker --since '1h ago' | grep -i error` 空 | ☐ |
| 15 | Bot 通知到达真实用户 | 触发一次 order.Submitted，admin 收到 TG 消息 | ☐ |
| 16 | console.log 已清 | `grep -rn 'console\.\(log\|debug\|info\)' apps/web/src` 仅 ErrorBoundary 一处 | ☐ |
| 17 | CSP / HSTS / X-Frame 头到达浏览器 | `curl -I https://<域名>/` 含三项 | ☐ |
| 18 | sourcemap 未泄露 | `curl https://<域名>/assets/index-*.js.map` 返回 404 | ☐ |
| 19 | Telegram bot token 与 JWT secret 都 ≥ 32 字符且非默认值 | env.ts 启动时 zod 校验已强制；二次人工确认 .env | ☐ |
| 20 | 单实例 OOM 余量 | server 内存 free > 1GB | ☐ |

---

# 第九部分 · 长期建议（M2+ 路线图）

1. **多副本化** —— api 用 Hono 适配 cluster 模式；hub 改为 Redis Pub/Sub；rateLimit 改 Redis；deploy 切蓝绿。
2. **OpenTelemetry 全链路** —— 前端 `@opentelemetry/sdk-trace-web` + 后端 OTel SDK + Tempo + Grafana。前后端单 traceparent 串联。
3. **WebPush 真接通** —— VAPID + SW + 服务端推送；Bot 出境不通时的兜底。
4. **Service Worker + PWA manifest** —— 真做架构承诺的离线可用 + 主屏图标。
5. **TanStack Router 真接入** —— 用 search params 类型安全替代 navStore tab。
6. **ICU formatjs** —— 替换自研 i18n 解析器，原生 plural / select / number。
7. **k6 负载测试** —— 跑 baseline + spike 场景，沉淀 SLO 报警阈值。
8. **WebAuthn for admin** —— 高权限角色强制双因子。
9. **`compass` CLI 补齐** —— `migrate`、`logs tail`、`deploy`、`impersonate`。
10. **ABAC policy_rules 真实现** —— 当前只有静态 RBAC + override；business expression engine 是 M3 价值点。

---

# 第十部分 · 审核方法学说明

**本次审核覆盖**：

- ✅ 所有 root config（`package.json`、`tsconfig.base.json`、`turbo.json`、`pnpm-workspace.yaml`、`.gitignore`、`.env.example`、`.github/workflows/ci.yml`）
- ✅ 全部 `apps/api/src/{main,app,env}.ts` + tRPC 核心（`trpc.ts`、`context.ts`）+ 关键 service（`telegramAuth`、`refreshTokens`、`rateLimit`、`s3`、`storeScope`）+ infra (`jwt.ts`)
- ✅ 关键 router（`auth.ts`、`upload.ts` 全文；`admin.ts`、`order.ts`、`run.ts` 各取前 150-200 行 + 关键模式 grep）
- ✅ 全部 `apps/web/src/{main,app/App,app/AuthGate,app/Shell,lib/trpc,hooks/useTelegram,hooks/useOfflineQueue,styles/index,stores/authStore}.tsx`
- ✅ `apps/web/index.html`、`vite.config.ts`、`tailwind.config.js`、`package.json`
- ✅ `packages/ui/src/{theme,components/Sheet,components/Button}.tsx`
- ✅ `packages/i18n/src/index.ts`
- ✅ `packages/db/src/{rls,schema/auth}.ts`、迁移文件列表 + 0024 详读
- ✅ `infra/{caddy/Caddyfile,docker/Dockerfile,compose/docker-compose.{dev,prod}.yml,systemd/compass-worker.service,backup/compass-backup.sh}`
- ✅ `scripts/deploy.ts`、smoke 脚本元信息
- ✅ 文档：`README.md`、`ARCHITECTURE.md`、`docs/{M1.5-AUDIT,PERMISSION_MATRIX}.md`
- ✅ 跨文件模式 grep：`console.log`、`as any`、`@ts-ignore`、`dangerouslySetInnerHTML`、`eval`、`VITE_DEV_MOCK_INIT_DATA`、`trycloudflare`、`129.204.59.183`

**本次审核未覆盖**：

- ❌ `apps/web/src/pages/{AdminPage,RunPage,ConfirmPage,ApprovalPage,DebugPage}.tsx` 全文（仅样本与 grep）
- ❌ `apps/api/src/trpc/routers/{catalog,dishes,inventory,report,sales,system}.ts`
- ❌ `apps/api/src/services/{orderProjection,runProjection,eventStore,notify,notifyForEvent}.ts` 全文
- ❌ `packages/domain/src/{order,run}/{commands,state,events}.ts` 全文（领域核心，建议下一轮补审）
- ❌ `packages/contracts/src/schemas/*.ts` 全文
- ❌ 23 个 ui 组件细节（仅 Sheet / Button）
- ❌ 全部 24 个迁移文件 SQL 细节（仅最新一个 + 文件名列表）
- ❌ scripts/browser-smoke*.ts、smoke.ts 全文
- ❌ apps/api/__tests__/* 测试细节

**建议第二轮审核覆盖未读区**，尤其是：
1. `packages/domain` 的 `decide()` 与 `apply()` 纯函数完整覆盖（业务正确性的核心）
2. 24 个 migration 的 RLS 策略 SQL 完整审计
3. 投影器的 SQL 与并发安全
4. PhotoCapture 实际实现（与 Permissions-Policy 兼容性）

---

**审核签字**

- 审核员：Claude（Anthropic 官方 CLI 自动审核）
- 模型：claude-opus-4-7（1M context）
- 完成时间：2026-05-16
- 报告位置：`CompassAlpha/PRODUCTION_AUDIT.md`

> 本报告基于代码静态分析。所有发现的"Blocker"建议在上线决策前由人工二次复核——尤其是 P0-1（静态托管），存在「服务器上有未入仓的 nginx / Caddy 二次配置」覆盖此问题的可能性。
