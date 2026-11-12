# CompassAlpha — Architecture

> 现状描述与路线图。**与本文不一致的实现要么改代码、要么改文档——不能并存。**
> Status: v2.0 (现状对齐 + 路线图分离)
> Updated: 2026-11-10（按 2026-11 全面审查校对：生产链路、部署流水线、离线、限流、通知、测试）
> Authors: Compass team

---

## 0. 一句话定位

**CompassAlpha** 是为多门店餐饮链开发的采购协同 Telegram Mini App。

- 角色：staff（下单）→ manager（审批）→ purchaser（市场跑趟）→ deliver（配送）→ confirm（验收）
- 多门店、多语言（zh/ru/uz/en）、Telegram 内运行 + 桌面 PWA 形态（PWA 形态在 M2 完整接通）

---

## 1. 实际在跑的技术栈（Section A · 现状）

### 1.1 应用进程

| 进程          | 框架 / 运行时                                     | 入口                             | 端口                   |
| ------------- | ------------------------------------------------- | -------------------------------- | ---------------------- |
| `apps/api`    | Hono on Bun + tRPC v11 + Drizzle                  | `src/main.ts` (Bun.serve 直接调) | 3000 (HTTP + WS `/ws`) |
| `apps/web`    | React 18 + Vite + Tailwind v3 + TanStack Query v5 | `src/main.tsx`                   | 5173 (dev)             |
| `apps/bot`    | grammY v1.34 (long-polling)；生产没有运行它       | `src/main.ts`                    | —                      |
| `apps/worker` | Bun + 原始 SQL polling outbox (无 BullMQ)         | `src/main.ts`                    | —                      |

**重要事实**：

- `apps/api` 既跑 tRPC，**也通过 Hono `serveStatic` 直接服务 `apps/web/dist`**（M3.18 加），所以一个进程同时承担 API + SPA 托管。它前面是 nginx（:80）、cloudflared quick tunnel 和 Cloudflare Worker（见 1.3）。
- WebSocket 由 `Bun.serve` 原生处理（不走 Hono 适配层），见 [apps/api/src/main.ts:45](apps/api/src/main.ts:45)。
- `apps/worker` **不用 BullMQ**——用 PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED` 直接拉 outbox，足够单进程低吞吐场景。

### 1.2 共享包

| 包                   | 用途                                                                       |
| -------------------- | -------------------------------------------------------------------------- |
| `packages/contracts` | tRPC 路由的 Zod schema（前后端共用）                                       |
| `packages/db`        | Drizzle schema + 69 个迁移 + RLS 策略                                      |
| `packages/domain`    | 纯函数领域核心：events / decide / apply / state（无副作用，单元测试 100%） |
| `packages/ui`        | 约 30 个组件（Radix 原语 + CVA 变体 + Tailwind）+ ThemeProvider            |
| `packages/i18n`      | 自研轻量 ICU 解析器 + 4 个 catalog (zh/ru/uz/en)，CI 校验对齐              |
| `packages/telemetry` | 客户端日志 + batch span，发到 api 的 `system.log` 接口                     |
| `packages/cli`       | `compass org/user/platform/project` 子命令                                 |

### 1.3 基础设施

| 件             | 现状                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 边缘           | Cloudflare Worker `app-proxy`（TLS、源站地址存 KV）→ cloudflared quick tunnel → nginx :80 → api:3000；nginx 配置还不在仓库（review OPS-23） |
| 数据库         | PostgreSQL 18，启用 RLS                                                                                                                     |
| 队列 / Pub-Sub | PostgreSQL outbox 表（**未用 Redis Pub/Sub**）                                                                                              |
| 缓存 / 限流    | Redis 8（限流目前用进程内 Map，Redis 留作 M2 迁移目标）                                                                                     |
| 对象存储       | S3 兼容（兼容 MinIO / R2 / Tencent COS），自研 SigV4 presigned PUT                                                                          |
| 后端单元       | systemd: `compass-api`、`compass-worker`、`compass-backup.{service,timer}`、`compass-app-tunnel`、`compass-origin-watch.{service,timer}`    |
| 备份           | 每日 03:30 UTC `pg_dump -Fc` + 校验 + 14d 轮转 + 可选 S3 上传                                                                               |
| 容器           | 生产不用；`infra/compose/docker-compose.dev.yml` 只给本地开发                                                                               |

### 1.4 安全模型（现状）

| 主题       | 实现                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| 身份认证   | Telegram initData HMAC 验证（常量时间比较，±600s 时钟漂移容忍）                         |
| 会话       | JWT HS256；access TTL 15min，refresh TTL 30d，刷新令牌**家族 + jti + 重放检测**         |
| 多租户隔离 | PostgreSQL Row-Level Security，`SET LOCAL app.current_org_id` 事务级注入                |
| 鉴权       | RBAC + per-member allow/deny overrides（global + store scope）                          |
| 限流       | 进程内固定窗口（review COREAPI-26）；auth/login 5/min/IP，mutation 120/min/(user,route) |
| 幂等       | `X-Idempotency-Key` header + DB 缓存（24h TTL），覆盖 risky mutations                   |
| 上传       | Presigned PUT，对象 key 强绑 `orgId/userId/`，content-type 白名单                       |
| Web 安全头 | CSP / HSTS / X-Frame-Options / Referrer-Policy / Permissions-Policy（M3.18 全部齐备）   |
| CORS       | 白名单：FRONTEND_URL + Telegram WebView origins；trycloudflare 仅 dev/staging           |

**重要确认**：当前 RBAC + override 模型**不是** ABAC（没有表达式求值器）。M4 之前不考虑加 Casbin / 自研策略引擎——over-engineering。

### 1.5 实时通道（现状）

| 通道         | 实现                                                               |
| ------------ | ------------------------------------------------------------------ |
| WebSocket    | `/ws`，access JWT 作 ticket，per-org 频道，hub 25s pingAll 防 idle |
| SSE          | **未实现**（架构早期讨论过，未落地，需要时再上）                   |
| Long-polling | **未实现**（无 fallback）                                          |

**重要事实**：客户端依靠 WS 实时刷新读模型；WS 断线时由 TanStack Query 的 staleTime + 用户主动操作刷新兜底，**没有 SSE 降级**。

### 1.6 国际化

- 4 个 catalog：en（基线）/ zh / ru / uz
- 自研解析器：仅支持 `{name}` 插值 + 弱 plural 兜底（剥 `{n, plural, ...}` 块）
- CI 强制 4 个 catalog key 数对齐
- 语言来源优先级：用户 `auth.users.locale` > Telegram `initDataUnsafe.user.language_code` > navigator.language > en

**已知不足**：plural / select / number 格式化不完整。**M2 迁移到 `@formatjs/intl-messageformat`**。

### 1.7 离线支持

| 件             | 现状                                                                                   |
| -------------- | -------------------------------------------------------------------------------------- |
| Service Worker | 已启用（N12，2026-10-30）：只缓存应用外壳，数据请求不经过它（`apps/web/public/sw.js`） |
| PWA manifest   | **未提供**                                                                             |
| IDB outbox     | 已实现（`apps/web/src/lib/outbox/`），应用启动时为每个 procedure 注册重放处理函数      |
| 网络恢复       | `navigator.online` 事件触发顺序重放 + 服务端幂等键去重                                 |

**重要事实**：离线做到了 **mutation outbox + 网络恢复重放**，加上 SW 缓存的应用外壳（断网刷新也能打开，显示离线横幅）。没有 PWA manifest，数据不能离线读取。

### 1.8 可观测性

| 柱    | 现状                                                                            |
| ----- | ------------------------------------------------------------------------------- |
| 日志  | pino → journalctl（后端）；客户端 `@compass/telemetry` 走 `system.log` API → DB |
| 指标  | **无 Prometheus / Grafana**（架构早期讨论过，未接）                             |
| Trace | 自研 traceId（每请求生成 ULID + 透传 client），**未接 OpenTelemetry SDK**       |

**重要事实**：今天的可观测性是"自研最小够用"。M2 计划切到 OTel SDK 让前后端 trace 串成一根。

### 1.9 部署流水线

| 步            | 工具                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本地 → 服务器 | `scripts/deploy.ts`：来源闸门（工作区干净、正是 origin/main 的最新提交、CI 三个任务都绿、不比线上旧）+ 服务器上没有进行中的采购 → 单元测试 → 从 git 打包发布物（git 看得到的文件，LF）→ rsync（或 scp）→ 留存上一版 → 解包 → `pnpm install` → web 构建到 dist.next → 有待执行的迁移时先备份再迁移 → 换上新 bundle → 重启 api+worker → 等 `/health/ready` → smoke。服务器上每一步 `flock` 串行、有时限；失败用 `--rollback` 回到上一版 |
| 蓝绿 / 滚动   | **未实现**——目前是 `systemctl restart`，有几秒流量黑洞                                                                                                                                                                                                                                                                                                                                                                                |
| Smoke         | `scripts/smoke.ts`（tRPC + 健康检查，核对运行中的提交和重启时间）+ `scripts/browser-smoke{,-deep}.ts`（Playwright）                                                                                                                                                                                                                                                                                                                   |
| 监控告警      | **无**（pager / 监控面板未接）                                                                                                                                                                                                                                                                                                                                                                                                        |

### 1.10 测试金字塔

| 层           | 现状                                                      | 数量                                                                               |
| ------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 单元         | Bun test（CI "type-check + unit tests"）                  | domain / contracts / db / i18n / ui / api / worker / web / scripts，约 1800 个测试 |
| 集成（PG）   | Bun test + GitHub Actions Postgres service                | apps/api + apps/worker，约 720 个测试，含 RLS 隔离与 RLS 目录检查                  |
| 契约 (tRPC)  | packages/contracts 的单元测试（进了 CI，review TEST4-01） | —                                                                                  |
| E2E          | Playwright（CI "end-to-end (Playwright)"）                | `tests/e2e`：主流程、会话、渲染次数；部署后另跑 browser-smoke{,-deep}              |
| 负载 (k6)    | **未实现**                                                | —                                                                                  |
| bot / worker | worker 有单元和 PG 测试；bot 没有                         | —                                                                                  |

---

## 2. 路线图（Section B · 计划但未做）

> 所有以下条目在 M1 都是 **NOT IMPLEMENTED**。日期标 "tentative"。2026-11-10 校对：标 ✅ 的已经做了，其余仍未做。

### M2 · Q3 2026 — 离线 / 通知 / 可观测性补齐

- **Service Worker + PWA manifest**：完整 offline-first，桌面/iOS 主屏可装。✅ Service Worker（应用外壳，2026-10-30）；PWA manifest 仍未做。
- **WebPush 通道**：VAPID + SW，与 In-App / Bot 并列三通道。
- **`@formatjs/intl-messageformat`**：替换自研 i18n 解析器。
- **OpenTelemetry SDK**：客户端 `@opentelemetry/sdk-trace-web` + 后端 OTel SDK，trace 单根贯通。
- **bot / worker 测试覆盖**：每个核心 path 至少 1 个集成测试。✅ worker（单元 + PG）；bot 仍没有。
- **Redis 限流**：滑窗 INCR + EXPIRE，替换进程内 Map。
- **WS ticket procedure**：短 TTL 单次使用票据，替代 URL 内 JWT。

### M3 · Q4 2026 — 体验 / 性能 / 工具

- **TanStack Router 真接入**：用 search params 类型安全路由替代 navStore tab 模式。
- **AdminPage / RunPage / admin.ts 拆分**：✅ AdminPage 已拆（853 行）；✅ admin 路由已拆（ADM1-11，2026-11-12：`routers/admin/` 按领域分文件，审计在 `services/adminAudit.ts`，输入 schema 在 contracts）；RunPage（2946 行）仍是单文件巨石。
- **Apple theme token 集**：当前 ThemeProvider 已支持 `theme=apple`，但 token 文件未分离。
- **`compass` CLI 补齐**：`migrate`、`logs tail`、`deploy`、`impersonate` 子命令。
- **Sourcemap → Sentry 上传**：production 不带 sourcemap，但远端解码可用。
- **k6 负载基线**：高频路由（order.adjustItem / run.previewCreatable）做 spike + sustained 基线，建 SLO。

### M4 · 2027 — 规模化

- **多副本 api + Redis Pub/Sub hub**：替换进程内事件总线，支持横向扩展。
- **蓝绿 / 滚动部署**：零停机切换。
- **ABAC policy_rules 表达式引擎**：仅当 RBAC + override 模型证明不够再上。
- **WebAuthn for admin**：高权限角色强制 FIDO2 二因子。
- **bot webhook（非 polling）**：Telegram 主动推到 `apps/api/bot/webhook`。
- **Tailwind v4 评估**：v4 的 `@theme` block + OKLCH 是否值得迁移成本，待 v4 stable 一年后评估。

---

## 3. 数据层（Section A · 现状）

### 3.1 Schema 总览（Drizzle）

```
auth.*
  organizations           id, slug, name, plan, locale_default, timezone,
                          currency (M1.17), tax_rate_pct, prices_include_tax,
                          workflow jsonb, feature_flags jsonb
  users                   id, tg_user_id, tg_username, email, display_name,
                          display_name_locked, locale, last_seen_at
  members                 id, org_id, user_id, status, invited_by, joined_at
                          UNIQUE (org_id, user_id)
  member_store_assignments  member_id, store_id, assigned_at, assigned_by
                            PRIMARY KEY (member_id, store_id)
  roles                   id, org_id, slug, name, description, is_built_in,
                          rank
                          UNIQUE (org_id, slug)
  permissions             key PK, description
  role_permissions        role_id, permission_key
  member_role_bindings    id, member_id, role_id, scope_type, scope_id,
                          granted_by, expires_at
  member_permission_overrides  id, member_id, permission_key,
                               effect ('allow'|'deny'),
                               scope_type, scope_id,
                               granted_by, expires_at
  policy_rules            id, org_id, subject_expr, action, resource_expr,
                          effect, priority
                          -- 已建表但未通电，M4 之前未使用
  refresh_tokens          id (= JWT jti), user_id, token_hash, family,
                          parent_id, ip, user_agent, revoked_at, expires_at

inventory.*
  stores                  id, org_id, name, code, address, geo, timezone,
                          is_active, sort_index
  suppliers               id, org_id, name, contact_phone, contact_tg,
                          rating, reliability_score, price_trust_score
  store_supplier_prefs    store_id, supplier_id, rank
  categories              id, org_id, slug, sort_index, names_jsonb
  skus                    id, org_id, category_id, code, names_jsonb,
                          unit, step, image_url, is_archived,
                          tax_rate_pct (M1.17)
  sku_supplier_links      sku_id, supplier_id, is_preferred,
                          default_price, last_seen_price, last_seen_at
  price_history           id, sku_id, supplier_id, store_id, run_id,
                          unit_price, qty, observed_at  -- INSERT-only

domain.*
  events                  id ULID, stream_id, seq, type, payload jsonb,
                          actor_id, occurred_at, causation_id, correlation_id
                          UNIQUE (stream_id, seq)
  projector_cursors       stream_id, last_seq, last_event_occurred_at
  policy_decisions        id, org_id, actor_id, action, resource_type,
                          resource_id, decision, inputs jsonb,
                          scope_store_id, occurred_at
                          -- 用作 admin audit log（M1.0 把 ABAC 决策审计表
                          -- 复用为 admin 操作审计；M4 还原 ABAC 用途时
                          -- 需要拆表）

read_model.*       (投影器维护，可 drop + replay 重建)
  order_sessions_v        id, org_id, store_id, initiated_by_member_id,
                          submitted_by_member_id, order_date, status,
                          claimed_by_member_id, claimed_at, submitted_at,
                          decided_at, decided_by_member_id, reject_reason,
                          run_id, last_seq, notes, extras_json (M3.16-C)
  order_items_v           session_id, sku_id, contributor_member_id, qty,
                          note, updated_by_member_id, updated_at
  market_runs_v           id, org_id, run_date, run_index, status,
                          planned_total, actual_total, last_seq
  run_items_v             run_id, sku_id, planned_qty, purchased_qty,
                          supplier_id, unit_price, status
  run_item_stores_v       run_id, sku_id, store_id, qty,
                          delivered_at, confirmed_at, confirm_note, photo_url

ops.*
  notifications           id, org_id, recipient_user_id, channel, template,
                          payload jsonb, sent_at, read_at, dedup_key
  client_logs             id, user_id, occurred_at, level, message,
                          context jsonb

sync.*
  outbox                  id, aggregate, aggregate_id, event_id, payload,
                          retries, next_attempt, sent_at
  idempotency_keys        key, route, user_id, response jsonb, expires_at
                          UNIQUE (key, route, user_id)
```

### 3.2 PG Row-Level Security

每张含 `org_id` 的表启用 RLS：

```sql
ALTER TABLE inventory.skus ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON inventory.skus
  USING (org_id = current_setting('app.current_org_id', true)::uuid);
```

API 在每个事务内执行 `SELECT set_config('app.current_org_id', $1, true)`。`withOrgContext` ([packages/db/src/rls.ts](packages/db/src/rls.ts)) 是唯一入口。

**部署时验证**：deploy.ts 的 4a-pg 步会查询 `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`，结果必须为 `f`，否则部署拒绝。

### 3.3 迁移策略

- 24 个迁移文件（0000~0024）由 `drizzle-kit generate` + 手工 RLS DDL 组成。
- CI 强制 `packages/db/migrations/meta/_journal.json` 与 `.sql` 文件名一一对应。
- 破坏性变更走两阶段：先双写，再删旧列，跨至少一个发布周期。
- 部署时 `pnpm db:migrate` 幂等执行。

---

## 4. 后端 (apps/api · 现状)

### 4.1 进程结构（实际）

```
apps/api/src/
├── main.ts                     # Bun.serve 入口 + WS upgrade
├── app.ts                      # Hono app 工厂 + 安全头 + CORS
├── http/webApp.ts              # SPA 托管：静态文件、index.html 回退
├── env.ts                      # @t3-oss/env + Zod
├── infra/
│   ├── jwt.ts                  # signAccess / signRefresh / verify*
│   └── log.ts                  # pino instance
├── trpc/
│   ├── router.ts               # 路由聚合
│   ├── trpc.ts                 # initTRPC + errorFormatter + middleware
│   │                             (errorLog / mutationRateLimit / idempotency)
│   ├── context.ts              # createContext: JWT 验签 + loadSession + withOrg
│   └── routers/
│       ├── admin/              (管理台，ADM1-11 按领域拆分；路径仍是 admin.<name>)
│       │   ├── index.ts        (把各文件的 procedure 展开成一个 router)
│       │   ├── guards.ts       (requireAdmin / requireOrgAdmin 等权限门)
│       │   ├── scope.ts        (管理员能管哪些门店、看到哪些成员)
│       │   ├── grants.ts       (能否转授角色或权限键)
│       │   ├── notify.ts       (变更后的实时通知)
│       │   └── overview / members / invites / memberStores / roles /
│       │       overrides / stores / catalog / expenseTemplates / audit /
│       │       maintenance.ts
│       ├── attendance.ts       (考勤：打卡、排班、考勤表)
│       ├── auth/               (登录与会话，COREAPI-09 按流程拆分；路径仍是 auth.<name>)
│       │   ├── index.ts        (把各文件的 procedure 展开成一个 router)
│       │   ├── limits.ts       (各登录入口按地址限频)
│       │   ├── modes.ts        (本服务器开放哪些登录方式：loginModes / nonTelegramStatus)
│       │   ├── loginResult.ts  (登录返回的令牌和会话；换组织时结束旧的刷新链)
│       │   └── telegram / invite / refresh / organizations / account /
│       │       dev / nonTelegram.ts
│       ├── order.ts            (todaySession / adjustItem / submit /
│       │                        approve / reject / claim / withdraw / unapprove)
│       ├── run.ts              (previewCreatable / create / purchaseItem /
│       │                        markUnavailable / dispatch / confirm / finish)
│       ├── catalog.ts          (categories / skus / suppliers)
│       ├── dishes.ts           (recipes / dish-defined orders, M1.16)
│       ├── inventory.ts        (stock movements, M1.15)
│       ├── nav.ts              (底部导航的待办角标)
│       ├── platform.ts         (平台：套餐与各组织的订阅)
│       ├── report.ts           (daily / weekly aggregations)
│       ├── sales.ts            (sales records, M1.17)
│       ├── settlement.ts       (门店日结)
│       ├── system.ts           (log ingestion / health / version)
│       └── upload.ts           (presigned PUT)
├── services/
│   ├── eventStore.ts           # appendEvents + readStream
│   ├── orderProjection.ts      # 事件 → read_model.order_*
│   ├── runProjection.ts        # 事件 → read_model.run_* / run_item_*
│   ├── notify.ts               # In-App 通知投递
│   ├── notifyForEvent.ts       # 事件 → 通知模板路由
│   ├── refreshTokens.ts        # issueRefresh / consumeRefresh / 家族吊销
│   ├── rateLimit.ts            # 进程内固定窗口
│   ├── s3.ts                   # 自研 SigV4 presigned PUT
│   ├── sessionPayload.ts       # 客户端拿到的会话：成员身份、门店、各店权限
│   ├── storeScope.ts           # RBAC + override per-store 评估
│   └── telegramAuth.ts         # initData HMAC + timing-safe
└── realtime/
    └── hub.ts                  # per-org Pub/Sub（进程内）+ pingAll
```

### 4.2 中间件链

```
request → security headers (CSP/HSTS/...)
        → cors (env-aware allowlist)
        → trpcServer / serveStatic / health
        → app.notFound
```

tRPC 内部：

```
each procedure → errorLogMiddleware (4xx warn, 5xx error)
                ↓
                [authedProcedure 起] auth check (Bearer JWT)
                ↓
                [mutationRateMiddleware] 120/min/(user,route)
                ↓
                [permissionProcedure(key) 时] 权限位检查
                ↓
                [idempotentMutation 时] X-Idempotency-Key 去重
                ↓
                handler (调 decide → appendEvents → projector → hub.publish)
```

### 4.3 命令处理（Order 例）

```ts
// packages/domain/src/order/commands.ts —— 纯函数
export function decide(state: OrderState, cmd: OrderCommand, ctx: ActorCtx): OrderEvent[] { ... }
export function apply(state: OrderState, event: OrderEvent): OrderState { ... }
```

```ts
// apps/api/src/trpc/routers/order.ts —— 调用方
mutation: async ({ ctx, input }) => {
  return ctx.withOrg(async (tx) => {
    const events = await readStream(tx, streamId);
    const state = events.reduce(apply, emptyState());
    const newEvents = decide(state, command, actor);
    await appendEvents(tx, streamId, state.lastSeq, newEvents);
    await projectOrder(tx, newEvents);
    hub.publish(orgId, 'order:' + sessionId, ...);
    return { ok: true };
  });
}
```

### 4.4 错误模型

```ts
class DomainError extends Error {
  code:
    | 'VALIDATION'
    | 'FORBIDDEN'
    | 'CONFLICT'
    | 'NOT_FOUND'
    | 'PRECONDITION_FAILED'
    | 'RATE_LIMITED'
    | 'INTERNAL';
  i18nKey: string;
  context: Record<string, unknown>;
}
```

tRPC `errorFormatter` 把 `DomainError.i18nKey` 透传到客户端，客户端 `useErrToast` 用本地化字符串展示。**永远不把英文错误消息直接显示给用户。**

### 4.5 速率与配额（M1）

- auth.telegramLogin / auth.refresh: **5/min/IP**（per-route）
- 全 mutation: **120/min/(user, route)**
- `system.log`: **100/min/session**, body ≤ 64KB
- 进程内 Map，固定窗口（窗口交界处最多放过两倍，review COREAPI-26）；M2 迁 Redis 滑窗

### 4.6 SPA 托管

`apps/api/src/http/webApp.ts` 的 `serveWebApp()` 服务 `apps/web/dist`：`serveStatic({ root: webDist })` 给静态文件；`/assets/*` 下没有的文件回 404，不回页面（否则边缘会把页面当成资源存下，review OPS-14）；其余路径回 `index.html`，用 `{ root, path: 'index.html' }` 按 root 解析，与进程的工作目录无关。生产时 nginx 在 api 前面，可能先回答这些路径。

---

## 5. 前端 (apps/web · 现状)

### 5.1 工程结构

依赖只能向下：lib/、stores/ < hooks/ < components/ < pages/ < app/。上层可以引用下层，下层不引用上层；`apps/web/eslint.config.js` 的 4d 规则检查（测试除外）。

```
apps/web/src/
├── main.tsx                # Vite 入口；语言探测 + preload catalog + React mount
├── app/
│   ├── App.tsx             # ErrorBoundary > ThemeProvider > ToastProvider
│   │                          > trpc.Provider > QueryClientProvider > AuthGate > Shell
│   ├── AuthGate.tsx        # 登录后才画 app；之前是登录页 / 改名引导 / 无门店、无权限页
│   ├── auth/               # 登录状态机 useSignIn、启动参数 launch、两个“忙”判断 signInPhase 和这些页面
│   ├── Shell.tsx           # 外壳：把顶栏、<main>、主按钮和底部导航组合起来
│   ├── shell/              # 外壳的各部分：tab 表、页面表、底部导航、顶栏、深链、离线横幅、主按钮
│   ├── ErrorBoundary.tsx
│   └── useWarmRunQueries.ts # 启动时预取采购页的数据
├── pages/
│   ├── OrderPage.tsx       (1403 行) — 下单
│   ├── ApprovalPage.tsx    (650 行)  — 审批
│   ├── RunPage.tsx         (3480 行, M3 拆分目标) — 采购 + 配送 + 验收
│   ├── ConfirmPage.tsx     (506 行)  — 验收
│   ├── AdminPage.tsx       (7477 行, M3 拆分目标) — 管理员
│   └── DebugPage.tsx       (346 行)  — 调试（admin 子 tab）
├── components/
│   ├── LanguageSheet.tsx
│   ├── SettingsSheet.tsx
│   ├── PageMenuContext.tsx # 页面登记放进设置面板的操作
│   ├── resilientLazy.tsx   # 页面分块加载失败时的重试占位
│   └── StoreSwitcher.tsx   # 门店胶囊与门店选择
├── config/timings.ts
├── hooks/
│   ├── useI18n.ts          # 订阅式 catalog 切换 + format
│   ├── useTelegram.ts      # Telegram 启动、BackButton、SettingsButton 的 hook
│   ├── useTelegramChromeInsets.ts # Telegram 顶部按钮占的位置 → CSS 变量（测算在 lib/chromeInsets.ts）
│   ├── usePageMainButton.ts # 页面主按钮（Shell 画在底栏上方）
│   ├── useRealtime.ts      # WS + 400ms coalesce invalidate
│   ├── useOfflineQueue.ts  # 页面读写 outbox 的 hook
│   ├── useOutboxReplay.ts  # 应用级重放：注册处理函数、触发 flush
│   ├── useErrToast.ts      # mutation 失败的 toast
│   ├── useStoreContext.ts  # 当前门店、能否切换门店
│   ├── usePhotoUploader.ts # <input type="file"> 上传，非 getUserMedia
│   ├── useScrollTapSuppression.ts # 抑制滚动中误触
│   └── useVersionCheck.ts  # 检测 build-id 变化 → 提示刷新
├── lib/                    # 不含 hook 和组件，不 import hooks/、components/、pages/、app/（eslint 检查）
│   ├── trpc.ts             # createTRPCReact + httpLink + 单航班 refresh + X-Idempotency-Key
│   ├── idb.ts              # outbox 持久化
│   ├── outbox/             # 离线 outbox：engine.ts（flush、write-ahead）、policy.ts（纯规则）、replayHandlers.ts
│   ├── telegram.ts         # WebApp SDK：getTg / isInTelegram / haptic
│   ├── storeContext.ts     # 能否切换门店、切换前的未保存守卫
│   ├── localSession.ts     # 重置会话：清登录、导航和查询副本，保留 outbox
│   ├── format.ts           # money / qty 格式
│   ├── errorText.ts        # 错误信息 → catalog key
│   ├── networkError.ts
│   ├── searchMatch.ts      # 跨语言 SKU 搜索
│   └── telegramLinks.ts    # tg:// / t.me/ 链接构造
├── stores/
│   ├── authStore.ts        # Zustand + persist 'compass.auth'
│   └── navStore.ts         # Zustand + persist 'compass.nav.v1' (tab + admin drill)
├── styles/index.css
└── types/
    └── telegram.d.ts       # M3.18 集中 Window.Telegram 全局类型
```

### 5.2 状态管理

- **TanStack Query v5**（远端状态）：`refetchOnWindowFocus: false`（M3.10），靠 WS 实时刷新做主驱动 + 用户主动操作兜底
- **Zustand**（本地持久化状态）：authStore + navStore
- **本地高频 mutable**：直接 React state（OrderPage 的 qty 调节用 useRef + Map）

**不用** Redux / MobX / Valtio / Jotai。

### 5.3 设计系统

- 约 30 个组件，基于 **Radix Primitives**（Dialog / Tooltip / Toast 等）+ **CVA**（class-variance-authority）+ Tailwind utility classes
- **Theme**：CSS variables，通过 `data-theme="native|apple|dark"` 切换。`native` 主题跟随 Telegram `themeChanged` 事件
- **Typography**：M3.14 字号 scale (24/19/15/14/13/12/11/10/9)，对 Android Telegram WebView 调校
- **Sheet 组件**：自动接管 Telegram BackButton 关闭顶层 sheet（M1.5），全局 sheet 计数让 SectionFrame 在 sheet 打开时让出 BackButton

### 5.4 路由

- **不用** TanStack Router（虽然安装过，但 M3 才接入；M1 已从 package.json 移除）
- 当前是 **tab-based 单 SPA**：tab 列表只有一份（`stores/navStore.ts` 的 `TAB_KEYS`），当前 tab 存在 navStore 并持久化；`app/shell/tabs.ts` 给每个 tab 定权限、标签和图标，`app/shell/pages.tsx` 给每个 tab 定页面
- 除下单页外，每个页面都通过 `resilientLazy()` + Suspense **code-split**；管理、采购、审核、验收四页在有权限时空闲预取（`app/shell/usePagePrefetch.ts`），重新打开时停留的那一页由 `main.tsx` 提前下载
- 设置面板（齿轮）也单独分块：第一次打开时加载，之后一直挂载；登录后空闲预取（2026-11-12，启动包预算 `scripts/check-entry-budget.ts` 用完了）
- 深链：每个 tab 都能用路径打开（如通知按钮的 `/approve`，可带 `?store=`），bot 链接用 `startapp=tab_<name>`；`app/shell/useDeepLinkTab.ts` 走与点 tab 相同的检查，切换后从地址栏去掉路径，刷新不会重复应用

### 5.5 国际化

- 用户语言来源优先级：`auth.users.locale` > `Telegram.initDataUnsafe.user.language_code` > `navigator.language`
- 4 catalog 静态/动态导入：en 静态，zh/ru/uz 动态（`preloadCatalog`）
- CI 检查 4 个 catalog key 数对齐

### 5.6 离线同步

```
本地写 → 立即更新 React Query cache (optimistic)
       → 调 tRPC mutation
       ├─ 成功 → WS 推 → useRealtime 400ms coalesce → invalidate query
       └─ 网络失败 → useOfflineQueue.enqueue → IDB outbox
                   → online 事件 → 顺序重放 (serverside idempotency 去重)
```

### 5.7 安全与启动

- **CSP 严格**：`script-src 'self' https://telegram.org`，无 `'unsafe-inline'`
- **启动守卫外联**：`/boot-guard.js` 多语言（zh/ru/uz/en） + 12s failsafe + 错误捕获，符合 CSP
- **VITE_DEV_MOCK_INIT_DATA**：构建期硬校验 + 运行期 DEV 守卫（仅 dev build 可用）+ deploy 时 grep 服务器 `.env`

---

## 6. 通知与机器人

### 6.1 通道（现状）

| 通道               | 状态        | 用途                                                                        |
| ------------------ | ----------- | --------------------------------------------------------------------------- |
| **In-App**         | ⚠️ 只写不读 | 写入 `ops.notifications`，但前端没有读取它的入口（review COREAPI-05，待定） |
| **Bot (Telegram)** | ⚠️ 中转可达 | 通过 Cloudflare Worker `tg-relay` 中转 `api.telegram.org`（CN 出境受阻）    |
| **WebPush**        | ❌ 未做     | M2                                                                          |

### 6.2 触发点（事件 → 通道）

```
order.Submitted          → In-App + Bot (该 store 的 approver)
order.Claimed            → In-App + Bot (owner)
order.Rejected           → In-App + Bot (owner, 带 reason)
run.Planned              → In-App + Bot (all purchasers)
run.ItemUnavailable      → In-App + Bot (admin + owner)
delivery.StoreDelivered  → In-App + Bot (store 的 confirm 人)
confirm.Issue            → In-App + Bot (admin + purchaser)
run.Finished             → In-App + Bot (所有相关 store)
```

### 6.3 去重

`ops.notifications.dedup_key` UNIQUE（如 `order:${id}:submitted`），防止投影重放重复发。

### 6.4 Worker 任务

- 每 5s：扫 `sync.outbox` 重发未投递事件
- 每 60s：heartbeat 心跳日志
- 每 1h：清 `sync.idempotency_keys` 过期行

---

## 7. 安全（现状深入）

### 7.1 鉴权

- Telegram initData HMAC-SHA256 验证（`createHmac('sha256', 'WebAppData').update(botToken)` 派生 secret），timestamp ±600s 时钟漂移容忍。
- access token 15min，refresh token 30d，**家族 + jti + 重放检测**（pre-M1.9 jti-less token 走 grandfather 一次性宽限）。

### 7.2 鉴权（授权）

- **RBAC**：role × permissions 静态字典
- **Per-member overrides**：global / per-store 的 allow + deny pair
- **Per-store 评估**：`assertHasPermissionInStore(member, key, storeId)` 在每个 mutation 入口检查
- **Rank 规则**：actor 只能授予 rank 严格小于自己的角色（防自我复制）

### 7.3 输入

- 所有路由 input Zod `strict()`
- 上传文件 content-type 白名单 + 8MB 上限 + key 强绑 `orgId/userId/`
- 富文本（仅 `note`、`extras.note`）按字符长度限制
- SQL 全 parameterized（Drizzle）；唯一 raw SQL 是 `set_config(...)` 用 sql 模板

### 7.4 秘密

- `.env` 不进 git；`apps/api/src/env.ts` 启动时 Zod 校验
- 生产 `.env` 由 systemd `EnvironmentFile` 注入
- JWT secret ≥ 32 字符；轮换走 dual-key 平滑切换（待 M2 实现轮换工具）

### 7.5 多租户

- 每个事务 `SELECT set_config('app.current_org_id', $1, true)`
- 后台 worker 用 `compass_jobs` 角色（M2 加，目前 worker 用 `compass`——short-term 风险）
- deploy 时验证 `compass` 角色 `BYPASSRLS = false`
- 租户键是 `auth.organizations.id`；store、人员、角色、目录、订单、采购与报表都由它隔离
- 一个 Telegram 身份可属于多个组织；session 返回 `memberships`，`auth.switchOrganization` 换租户并下发绑定该租户的新 refresh token
- refresh token 带 `org` + `mid`，刷新不会跳回“第一条 membership”；旧 token 用 `users.last_org_id` 兼容
- `auth.createOrganization` 自助开通组织，并在同一事务内创建默认角色、feature flags、工作流和首位管理员
- 产品级流程与边界见 `docs/MULTI_TENANCY.md`

### 7.6 速率与滥用

- M1：进程内 Map，固定窗口（review COREAPI-26）
- M2：Redis 滑窗
- 边缘暂无 WAF（M3 评估 Cloudflare Pro）

---

## 8. 关键决策记录（DR）

```
DR-001  2026-05-01  Hono over Fastify          冷启动 + 原生 WS
DR-002  2026-05-01  Drizzle over Prisma        Bun 原生、SQL-first、RLS DDL 友好
DR-003  2026-05-01  Event-sourced domain core  审计 / 撤回 / 时间旅行 一次性解决
DR-004  2026-05-01  Postgres RLS               应用层 bug 不再能跨租户泄露
DR-005  2026-05-01  自研 i18n (M2 切 formatjs)  M1 不上 LinguiJS 减少依赖
DR-006  2026-05-01  自研 SigV4 presign         避开 @aws-sdk 的 10MB 依赖
DR-007  2026-05-01  RBAC + per-member override  M4 之前不上 ABAC
DR-008  2026-05-01  WS only (无 SSE 降级)      iOS Telegram WebView WS 当下稳定
DR-009  2026-05-01  Outbox + Idempotency       事务一致 + 重试安全
DR-010  2026-05-01  Stall → Supplier 升级       加评分/可靠度/价格信任
DR-011  2026-05-01  RunIndex 同日多趟           适配早午两次补货
DR-012  2026-05-01  Bun 1.1.x pinned            部署一致性
DR-013  2026-05-06  Sheet 自动 BackButton       28 sheet 一次性修复 + 全局计数
DR-014  2026-05-07  Refresh token 家族 + 重放   M1.9 安全 baseline
DR-015  2026-05-08  Idempotency middleware      24h cache，risky mutation 全覆盖
DR-016  2026-05-15  Tab-based nav (无路由)      M1 减依赖；M3 接 TanStack Router
DR-017  2026-05-16  AdminPage / RunPage lazy    code-split，权限可见时 idle prefetch
DR-018  2026-05-16  Hono serveStatic SPA       api 进程同时托管 SPA + tRPC
DR-019  2026-05-16  CSP 严格 + 外联 boot-guard  无 'unsafe-inline'，三方仅 telegram.org
DR-020  2026-05-16  CF Worker Telegram 中转    CN 出境 api.telegram.org 受阻
```

---

## 9. 不做清单（防止过度工程）

- **不做微服务拆分**。M4 之前所有服务在同 monorepo，单进程跑。规模到 50 万 DAU 再考虑。
- **不引入 GraphQL**。tRPC 类型推断已够用。
- **不做服务端 SSR**。Telegram Mini App + PWA SPA 体验最佳。
- **不引入 Redux / MobX / Valtio**。Zustand + TanStack Query 覆盖所有场景。
- **不上 Casbin / 自研 ABAC**。RBAC + override 足够 M3 之前业务复杂度。
- **不做"AI 助手"功能**。M2 完成离线/通知/可观测性后再评估。

---

## 10. 阅读指引

| 想了解…            | 看…                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------ |
| 业务领域语言       | [packages/domain/src/{order,run}/events.ts](packages/domain/src/order/events.ts)     |
| 命令处理           | [packages/domain/src/{order,run}/commands.ts](packages/domain/src/order/commands.ts) |
| 权限矩阵           | [docs/PERMISSION_MATRIX.md](docs/PERMISSION_MATRIX.md)                               |
| 事件 catalog       | [docs/EVENT_CATALOG.md](docs/EVENT_CATALOG.md)                                       |
| 运维 / 备份 / 恢复 | [docs/RUNBOOK.md](docs/RUNBOOK.md)                                                   |
| 第一次部署         | [scripts/deploy.ts](scripts/deploy.ts) 顶部注释                                      |

---

**文档结束**。任何与本文不一致的实现都需要先修订本文（提 PR 改 ARCHITECTURE.md），或者把改动落地到 §2 路线图相应里程碑。
