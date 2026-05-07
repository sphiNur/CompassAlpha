# CompassAlpha — Architecture Master Plan

> 全方位超越 CompassBeta 的下一代采购协同 Mini App。  
> 本文是 CompassAlpha 的**唯一权威架构方案**。任何代码决策与本文冲突时，以本文为准。  
> Status: v1.0 · Author: 架构总设计 · Date: 2026-05-01

---

## 0. TL;DR — 与 CompassBeta 的差异一览

| 维度 | CompassBeta | CompassAlpha |
|---|---|---|
| 后端运行时 | Fastify on Bun | **Hono on Bun** (更轻、原生 WS、边缘友好) |
| ORM | Prisma | **Drizzle** (无独立迁移引擎、type-safe SQL、Bun 原生) |
| 状态模型 | 行级 status 字段 + 反向迁移 mutation | **Event-sourced 领域核心** (不可变事件流 + 投影) |
| 实时性 | 8s 轮询 | **WebSocket + SSE 双通道**，订阅式投影流 |
| RBAC | role.defaultPermissions + override | **Casbin-style 策略引擎 + Postgres RLS** |
| 多租户 | 应用层 orgId 过滤 | **PG Row-Level Security**，DB 级隔离 |
| 离线 | 选择性 mutation 队列 | **完整 OffLine-First**: SW + IDB + 同步对账协议 |
| 通知 | Phase 2 才做 | **第 0 天即有**：Bot + WebPush + In-App 三通道 |
| i18n | 硬编码 ternary 残留 | **ICU MessageFormat + 翻译图谱回退** |
| 设计系统 | Apple-only | **双主题 (Native / Apple)** 用户切换，Token 驱动 |
| 业务智能 | 无 | **历史均值建议 + 价格异常检测 + 供应商评分** |
| 测试 | 43 个单元测试 | **单元 + 契约 + E2E + 负载** 四层金字塔 |
| 部署 | tar+scp+nohup | **多阶段 Dockerfile + Caddy 自签 TLS + 健康探针** |
| 可观测性 | pino + 自研 ClientLog | **OpenTelemetry 全链路** + Loki + Grafana + 自研触达层 |
| 工具链 | npm script 散落 | **`compass` 统一 CLI**：`compass org`/`user`/`test`/`deploy` |

---

## 1. 业务域重构

### 1.1 核心实体（领域语言）

```
Organization        ─┬─ owns ──→ Store            (门店：一个分店/中央厨房)
                     ├─ owns ──→ Supplier         (供应商：原 Stall 的升级版)
                     ├─ owns ──→ Catalog          (产品目录，SKU 集合)
                     ├─ owns ──→ Workflow         (可配置工作流定义)
                     └─ owns ──→ Member           (用户在组织中的成员关系)

Member ─── has ──→ Role+ScopeBindings (一个 member 在不同 store 可有不同 role)

Catalog ─── contains ──→ SKU
SKU     ─── tracked-by ──→ PriceHistory (供应商→SKU→日期 的价格)
SKU     ─── preferred-from ──→ SupplierRecommendation (评分排序)

OrderDraft (per member, per day, per store) ──submit──► OrderRequest
OrderRequest ──claim+approve──► ApprovedOrder
ApprovedOrders ──aggregate──► RunPlan
RunPlan ──execute──► RunExecution (购买 + 拆分 + 派送)
RunExecution ──confirm-each-store──► ConfirmedRun

每一步都是 EventStream 上的一个不可变事件。
状态字段是事件的投影 (read model)，可以随时重建。
```

### 1.2 与 Beta 的关键差异

1. **Stall → Supplier**：`Supplier` 携带 `name, contact, rating(1-5), reliabilityScore(自动)`、`priceTrust(自动)`。  
   `RunItem` 不再要求一个 stall，而是一个**或多个**候选 supplier 报价；purchaser 在执行时记录"实际从哪家买"。
2. **OrderDraft 是隐式的**：staff 没点过加号则没草稿。打开页面不再 upsert 空 session。
3. **Workflow 可配置**：默认是 `staff→approve→purchase→deliver→confirm`，但 org 可以缩短为 `staff→purchase→confirm`（小组织无审批）。
4. **Run 不再 1 day = 1 run**：一天可以多趟（早市、午市补货）。`MarketRun.runIndex` 区分。
5. **价格历史是真理之源**：所有"今日单价"都查 PriceHistory 当日均值，不再每条 RunItem 各自带价格。
6. **半步数量是默认**：所有 SKU 的 step 由 unit 决定，无需 `multipleOf` 校验绕弯。

### 1.3 状态机：事件 + 投影

```
Order Stream (按 sessionId 聚合):
  DraftStarted → ItemAdjusted* → NoteSet* → Submitted →
    {Claimed → Released}* →
    (Approved | Rejected) →
    [Withdrawn → DraftStarted'] →
    [Unapproved → Submitted']

Run Stream (按 runId 聚合):
  RunPlanned → SessionAttached* → ItemPurchased* → ItemUnavailable* →
    DeliveryStarted → StoreDelivered* → StoreConfirmed* → RunFinished

每条事件 (id, streamId, seq, type, payload, actorId, occurredAt, causationId) 持久化到 events 表。
投影器 (projector) 监听事件，更新 read_models.* 表 (orders_view, runs_view, etc.)。
```

**收益**：
- 撤回/反向迁移不需要新 mutation，直接 append `Withdrawn` 事件。
- 完整审计自带：每个字段是谁在何时改的。
- 时间旅行：给定 `streamId, seq` 重建任意历史状态。
- 并发安全：用 `(streamId, seq) UNIQUE` + `expectedSeq` 乐观锁取代 `claimedById = NULL` 黑魔法。

---

## 2. 技术栈

### 2.1 monorepo

```
CompassAlpha/
├── apps/
│   ├── api/                    # Hono + tRPC + Drizzle (Bun)
│   ├── web/                    # Vite + React 18 + Tailwind v4
│   ├── bot/                    # grammY (Bun) — Telegram 机器人
│   └── worker/                 # BullMQ workers (Bun) — 定时与异步任务
├── packages/
│   ├── domain/                 # 纯领域：events, aggregates, policies
│   ├── db/                     # Drizzle schema + migrations + RLS
│   ├── contracts/              # tRPC routers 类型 + Zod schema (zero-runtime)
│   ├── ui/                     # Concord 设计系统 (headless + tokens)
│   ├── i18n/                   # ICU 资源 + locale 检测
│   ├── telemetry/              # OpenTelemetry SDK + 客户端日志
│   └── cli/                    # `compass` 命令行工具
├── infra/
│   ├── docker/                 # Dockerfile 多阶段
│   ├── caddy/                  # Caddyfile (TLS + 反向代理)
│   ├── grafana/                # 仪表盘 JSON
│   └── compose/                # 本地 + prod compose
├── docs/
│   ├── ARCHITECTURE.md         # 本文
│   ├── EVENT_CATALOG.md        # 所有事件类型 schema
│   ├── PERMISSION_MATRIX.md    # 角色×资源×动作矩阵
│   ├── API.md                  # tRPC 路由清单
│   ├── DESIGN.md               # Concord 设计系统
│   └── RUNBOOK.md              # 运维手册
└── tests/
    ├── e2e/                    # Playwright
    └── load/                   # k6
```

### 2.2 选型理由（为什么不沿用 Beta）

| 替换 | 原因 |
|---|---|
| Fastify → **Hono** | Hono 在 Bun 下冷启动 < 30ms（Fastify ~120ms），原生 Web Standard `Request/Response`，`hono/trpc-server` 适配 tRPC v11，且支持 WebSocket 不需要再加 `@fastify/websocket`。 |
| Prisma → **Drizzle** | Prisma 在 Bun 下需要 binary engine，部署烦琐；Drizzle 是纯 TS、SQL-first、零运行时开销，`drizzle-kit` 原生支持 Postgres RLS DDL。 |
| `@trpc/react-query` → 同款但 v11 + **TanStack Query v5** | v5 的 `useQuery` 默认 `gcTime` 与 v4 默认不同；v11 的 `httpSubscriptionLink` 是 SSE 一等公民，订阅模型更稳。 |
| Tailwind v3 → **v4** | v4 的 `@theme` 块直接产出 CSS variables，动态主题切换不需要 class-based dark mode 那套技巧；OKLCH 颜色空间，HDR 屏幕色彩还原更准。 |
| Zustand only → **Zustand + Valtio** | Valtio 处理本地高频 mutable 状态（OrderPage 行级 qty 草稿），Zustand 处理跨页全局状态。Valtio 的 proxy 模型对 ItemRow 的高频 +/- 操作无渲染浪费。 |
| 自研 i18n → **LinguiJS** | ICU MessageFormat + 编译期产物（无运行时解析开销）+ 与 React 生态成熟集成。 |
| 自研 ClientLog → **OpenTelemetry** | 自研产物可保留作为 fallback，但 OTel 与生态工具（Grafana Tempo, Honeycomb）开箱即用，trace 跨前后端一根链路。 |

### 2.3 锁版本策略

- Bun: `1.1.x`（pin 到具体 patch，写在 `.bun-version`）
- Node: `20.x`（仅给 ESLint / Vite 等开发时使用）
- pnpm: `9.x`
- Postgres: `16-alpine`
- Redis: `7-alpine`
- 所有依赖 `pnpm-lock.yaml` 锁定，CI 强制 `--frozen-lockfile`

---

## 3. 数据层

### 3.1 Schema 总览（Drizzle）

```
auth.*
  organizations           id, slug, name, plan, locale_default, created_at
  users                   id, tg_user_id, tg_username, display_name, locale, deleted_at
  members                 id, org_id, user_id, status, joined_at  -- (org_id, user_id) UNIQUE
  roles                   id, org_id, slug, name, is_built_in
  permissions             id, key, description  -- 全局静态字典
  role_permissions        role_id, permission_id
  member_role_bindings    id, member_id, role_id, scope_type, scope_id, granted_by, expires_at
                          -- scope_type ∈ ('global', 'store')
  policy_rules            id, org_id, subject_expr, action, resource_expr, effect, priority
                          -- Casbin-style ABAC 规则；defaults seed from roles, but admins can layer custom

inventory.*
  stores                  id, org_id, name, address, geo, timezone, is_active
  suppliers               id, org_id, name, contact_phone, contact_tg, rating_avg, reliability_score, price_trust_score, photo_url
  store_supplier_prefs    store_id, supplier_id, rank  -- 偏好排序（这家店在选 supplier 时的默认顺序）
  categories              id, org_id, slug, sort_index, names_jsonb (i18n)
  skus                    id, org_id, category_id, code, names_jsonb, unit, step, image_url, is_archived
  sku_supplier_links      sku_id, supplier_id, default_price, last_seen_price, last_seen_at
  price_history           id, sku_id, supplier_id, store_id, run_id, unit_price, qty, observed_at  -- INSERT-only

domain.*
  events                  id ULID, stream_id, seq, type, payload jsonb, actor_id, occurred_at, causation_id, correlation_id
                          -- (stream_id, seq) UNIQUE
  snapshots               stream_id, seq, state jsonb, created_at  -- 重建优化

read_model.*  (投影器维护，可随时 drop+rebuild)
  order_sessions_v        id, org_id, store_id, member_id, order_date, status,
                          claimed_by, claimed_at, last_seq, totals jsonb
  order_items_v           session_id, sku_id, qty, note, last_edited_by, last_edited_at
  market_runs_v           id, org_id, run_date, run_index, status, planned_total, actual_total, last_seq
  run_items_v             run_id, sku_id, planned_qty, purchased_qty, supplier_id, unit_price, status
  run_item_stores_v       run_id, sku_id, store_id, qty, delivered_at, confirmed_at, confirm_note, photo_url

ops.*
  notifications           id, org_id, recipient_user_id, channel, template, payload jsonb, sent_at, read_at, dedup_key
  audit_log               id, org_id, actor_id, action, resource, resource_id, before jsonb, after jsonb, ip, user_agent, occurred_at
  feature_flags           org_id, key, value jsonb  -- per-org config (price_alert_threshold, workflow_steps, etc.)
  client_logs             同 Beta，保留作为 OTel 之外的最后兜底

sync.*
  outbox                  id, aggregate, aggregate_id, event_id, payload, retries, next_attempt, sent_at  -- 事务外发
  idempotency_keys        key, route, response jsonb, expires_at  -- 幂等保护
```

### 3.2 PG Row-Level Security

每张含 `org_id` 的表启用 RLS：

```sql
ALTER TABLE inventory.skus ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON inventory.skus
  USING (org_id = current_setting('app.current_org_id')::uuid);
```

API 在每个请求开始时执行 `SET LOCAL app.current_org_id = $1`（事务级）。即便业务代码忘记加 `where org_id = ?`，数据库也会拒绝跨租户读写。

### 3.3 索引清单（必须有的，CI 检查）

```
events:               (stream_id, seq) UNIQUE, (type, occurred_at), (correlation_id)
order_sessions_v:     (org_id, store_id, member_id, order_date) UNIQUE WHERE status != 'archived'
                      (org_id, status, order_date DESC)
market_runs_v:        (org_id, run_date, run_index) UNIQUE
price_history:        (sku_id, observed_at DESC), (supplier_id, observed_at DESC)
notifications:        (recipient_user_id, sent_at DESC), (dedup_key) UNIQUE WHERE dedup_key IS NOT NULL
client_logs:          BRIN on occurred_at + GIN on payload (jsonb_path_ops)
```

### 3.4 迁移策略

- `drizzle-kit generate` 产出 SQL 迁移文件，纳入 git。
- 上线流程：`compass db migrate` 调用 `drizzle-kit migrate`，幂等。
- 破坏性变更（drop column, rename）走两阶段：先双写，再删旧列，间隔不少于 1 个生产 release。
- RLS 策略变更必须配套写测试：`tests/db/rls.test.ts` 用两个 org 跨查证 0 行。

---

## 4. 后端 (apps/api)

### 4.1 进程结构

```
apps/api/src/
├── main.ts                # 启动入口
├── app.ts                 # Hono app 工厂
├── env.ts                 # @t3-oss/env + Zod
├── trpc/
│   ├── context.ts         # 构建 ctx (orgId, userId, traceId, request, set rls var)
│   ├── procedures.ts      # publicProc / authedProc / policyProc(action, resourceFn)
│   ├── trace.ts           # OTel span 包装
│   └── routers/
│       ├── auth.ts
│       ├── catalog.ts     # categories + skus
│       ├── supplier.ts
│       ├── store.ts
│       ├── order.ts       # commands + queries
│       ├── run.ts
│       ├── delivery.ts
│       ├── confirm.ts
│       ├── price.ts
│       ├── report.ts
│       ├── notify.ts
│       ├── system.ts      # health, version, log ingestion
│       └── admin.ts       # purge, grant, impersonate (super_admin only)
├── domain/
│   ├── order/
│   │   ├── events.ts      # discriminated union of all order events
│   │   ├── aggregate.ts   # apply(state, event) -> state'
│   │   ├── commands.ts    # decide(state, command, ctx) -> events[]
│   │   └── projector.ts
│   ├── run/...
│   └── shared/
│       ├── eventBus.ts
│       └── ulid.ts
├── policy/
│   ├── engine.ts          # ABAC eval
│   ├── builtin.ts         # 默认规则种子
│   └── decisions.ts       # 决策审计写入
├── realtime/
│   ├── ws.ts              # Hono WS endpoint
│   ├── sse.ts             # tRPC subscription transport
│   └── hub.ts             # 订阅注册中心 (per-org channel)
├── infra/
│   ├── db.ts              # Drizzle client
│   ├── redis.ts
│   ├── s3.ts              # 兼容 R2/MinIO
│   ├── jwt.ts
│   ├── otel.ts
│   └── outbox.ts
└── tests/
    └── ...
```

### 4.2 中间件链

```
request → otel.span()
        → cors (origin allowlist + *.trycloudflare.com + Telegram WebView)
        → rate-limit (sliding window in Redis, 100/min default; per-route override)
        → auth.parse (JWT or Telegram initData) → ctx.userId / ctx.orgId
        → rls.set (SET LOCAL app.current_org_id)
        → idempotency (for mutations with Idempotency-Key header)
        → trpc handler
        → outbox.commit (post-tx 事件外发)
        → otel.end
```

### 4.3 命令处理（Order 例）

```ts
// domain/order/commands.ts
export function decide(state: OrderState, cmd: OrderCommand, ctx: PolicyCtx): OrderEvent[] {
  switch (cmd.type) {
    case 'AdjustItem': {
      const allowed = canEditOrderItem(state, ctx);
      if (!allowed) throw new ForbiddenError('order.edit', allowed.reason);
      if (cmd.qty < 0) throw new ValidationError('qty must be >= 0');
      const step = ctx.sku.step;
      if (cmd.qty % step !== 0) throw new ValidationError(`qty must be multiple of ${step}`);
      // ... idempotent merge: if last event for this item has same qty, no event.
      return [{ type: 'ItemAdjusted', skuId: cmd.skuId, from: prev, to: cmd.qty, byMemberId: ctx.memberId }];
    }
    case 'Submit': { ... }
    case 'Claim': { ... }
    case 'Approve': { ... }
    case 'Reject': { ... }
    case 'Withdraw': { ... }
    case 'Unapprove': { ... }
  }
}
```

测试用例不是 "test endpoint" 而是 "test pure decide()"。100% 单元覆盖、不需要 DB。

### 4.4 投影器

```ts
// domain/order/projector.ts
export const orderProjector: Projector = {
  streams: ['order'],
  apply: async (event, tx) => {
    switch (event.type) {
      case 'DraftStarted':
        await tx.insert(orderSessionsV).values({ id: event.streamId, ..., status: 'draft' });
        break;
      case 'ItemAdjusted':
        await tx.insert(orderItemsV).values({ ... }).onConflictDoUpdate({ ... });
        break;
      // ...
    }
    await tx.update(orderSessionsV).set({ lastSeq: event.seq }).where(...);
  }
};
```

投影是 idempotent（再放一遍同一事件结果一致）。如果投影 schema 变更，drop read_model.* 表并 `compass project rebuild order` 重放。

### 4.5 实时通道

- **WS** (`/ws`)：客户端连上即认证（短期 ticket from `auth.wsTicket`），server 维护 `(orgId, channel) → Set<sockets>`。事件投影成功后 `hub.publish(orgId, 'order:'+sessionId, event)`。
- **SSE** (`/trpc/...?subscription=1`)：tRPC v11 标准 subscription transport，便于普通查询同链路升级到流。
- 客户端两条通道选其一：Telegram WebView 在 iOS 上 WS 偶有阻断，自动 fallback 到 SSE。
- 事件序号 (`seq`) 让客户端可以 "resume from seq=N"，断线重连不丢事件。

### 4.6 错误模型

统一错误对象：

```ts
class DomainError extends Error {
  code: 'VALIDATION' | 'FORBIDDEN' | 'CONFLICT' | 'NOT_FOUND' | 'RATE_LIMITED' | 'INTERNAL';
  i18nKey: string;     // 'order.errors.alreadyClaimed'
  context: Record<string, unknown>;
  retriable: boolean;
}
```

tRPC errorFormatter 把 i18nKey 透传到客户端，客户端用本地化字符串展示。**永远不把英文错误消息直接显示给用户。**

### 4.7 速率与配额

- 默认 100 req/min/IP（写）+ 300 req/min/IP（读）
- `order.adjustItem` 单独 600/min/user（高频 +/-）
- `system.log` 100 req/min/session, body ≤ 64KB
- 每 org 月度 quota（事件数、存储 MB），达 80% 通知 owner，达 100% 写入只读

---

## 5. 前端 (apps/web)

### 5.1 工程结构

```
apps/web/src/
├── main.tsx
├── app/
│   ├── App.tsx
│   ├── routes.tsx          # 路由表 (TanStack Router)
│   ├── providers.tsx       # QueryClient + tRPC + I18n + ThemeProvider + ErrorBoundary
│   └── auth/
│       ├── AuthGate.tsx
│       └── flow.ts
├── pages/
│   ├── home/HomePage.tsx
│   ├── order/OrderPage.tsx
│   ├── approve/ApprovalPage.tsx
│   ├── run/RunPage.tsx
│   ├── deliver/DeliverPage.tsx
│   ├── confirm/ConfirmPage.tsx
│   ├── reports/...
│   ├── admin/...
│   └── debug/DebugPage.tsx
├── features/              # 跨页特性模块（按业务边界，不按技术分层）
│   ├── order-draft/
│   ├── claim-review/
│   ├── price-alert/
│   ├── supplier-picker/
│   └── photo-capture/
├── ui/                    # 设计系统 re-export from @compass/ui
├── lib/
│   ├── trpc.ts
│   ├── ws.ts              # WebSocket client + reconnect
│   ├── sync/              # 离线同步引擎
│   ├── idb.ts
│   ├── telemetry.ts
│   ├── telegram.ts
│   └── time.ts            # 客户端 / 服务端时间偏移修正
├── stores/
│   ├── authStore.ts
│   ├── themeStore.ts
│   └── localDraftStore.ts # Valtio
├── hooks/
│   ├── useTelegram.ts
│   ├── useMainButton.ts
│   ├── useBackButton.ts
│   ├── useSubscription.ts
│   ├── useOptimistic.ts
│   └── usePermission.ts
└── styles/
    ├── tokens.css         # 由 @compass/ui 注入的主题变量
    └── index.css
```

### 5.2 离线同步引擎

CompassBeta 的 offline queue 是"个别 mutation 单独包"，CompassAlpha 改成**通用同步层**：

```
本地写 → CommandLog (IDB) → 立即应用到 OptimisticView (内存)
                          → outbox 队列 → 网络恢复时按序重放
                          → 服务端确认 → 移除 CommandLog → 替换 OptimisticView 为 Confirmed
                          → 冲突 (服务端 expectedSeq mismatch) → 调和策略 (最后写者胜 / 让用户选 / 自动合并)
```

每个命令携带 `clientId + clientSeq`，服务端用 `(clientId, clientSeq)` 作为幂等键，重放安全。

### 5.3 设计系统 Concord（替换 Beta 的 Apple-only）

- **Tokens**：颜色、字号、圆角、阴影、动画时长。所有 token 是 CSS variables，主题切换零成本。
- **两套主题**：
  - `Native`：跟随 `Telegram.WebApp.themeParams`，与平台融为一体（深色/浅色）。
  - `Apple`：移植 Beta 的 Apple 风格，作为高定选项。
- **组件**：基于 Radix UI primitives（Dialog, Popover, Tooltip, Toast 已无障碍化）+ CVA 变体 + Tailwind 样式。
- **a11y 默认**：键盘导航、ARIA、焦点环、reduce-motion 自动尊重。
- **关键组件**清单：
  - 表面：`Surface`, `Card`, `Sheet`, `Popover`, `Dialog`
  - 表单：`Input`, `Select`, `Combobox`, `DatePicker`, `Stepper`, `QtyControl`, `Switch`
  - 反馈：`Toast`, `Banner`, `Skeleton`, `Spinner`, `EmptyState`, `ErrorState`
  - 导航：`Tabs`, `BottomNav`, `Breadcrumb`, `BackChevron`
  - 数据：`DataState<T>`, `List`, `VirtualizedList`, `Avatar`, `Badge`, `Stat`
  - 业务复合：`SkuRow`, `SupplierCard`, `RunItemRow`, `DeliveryProgress`
- **Polymorphic + asChild**：参考 Radix `asChild` 模式，更彻底的组合性。

### 5.4 路由 & 权限

- 用 **TanStack Router**（v1）：文件路由、类型安全 search params、loader 数据预取。
- `beforeLoad` 钩子里做权限检查；不通过则 `throw redirect(...)`。比 `<RequirePermission>` 更早（在渲染之前）。
- `homePathFor(permissions)` 沿用 Beta 的好做法，作为 `/` 的 redirect 目标。

### 5.5 性能预算

- 首屏 JS bundle ≤ 180KB gzip（Beta 当前 ~280KB）
- LCP ≤ 1.8s on Slow 4G
- INP ≤ 100ms 在所有交互
- 图片：`<PhotoCapture>` 输出 ≤ 200KB JPEG，懒加载 + AVIF fallback

### 5.6 PWA + Telegram 双形态

- 既能装在桌面/iOS 主屏，也能在 Telegram WebView 跑。
- `useTelegram()` 自动检测：
  - 有 `Telegram.WebApp` → 走 MainButton/BackButton/initData 流。
  - 没有 → 渲染网页版 Header + footer CTA + cookie/JWT 登录（magic link）。
- Service Worker 缓存 shell + API 响应（stale-while-revalidate），离线可用。

---

## 6. 通知与机器人 (apps/bot + apps/worker)

### 6.1 三通道触达

| 通道 | 用途 | 实现 |
|---|---|---|
| Telegram Bot | 主通知（订单待审、补货异常、采购完成…） | grammY 长连接（开发）/ Webhook（生产） |
| WebPush | PWA 形态下的浏览器推送 | VAPID + Service Worker |
| In-App | 实时铃铛 + 历史中心 | WS + `notifications` 表 |

### 6.2 触发点（开机即接）

```
order.Submitted          → 通知该 store 的 approver
order.Claimed            → 通知 owner ("Manager X is reviewing")
order.Rejected           → 通知 owner（带 reason）
run.Planned              → 通知所有 purchaser
run.ItemUnavailable      → 通知 admin 和被拒的 owner
delivery.StoreDelivered  → 通知 store 的 confirm 人
confirm.Issue            → 通知 admin + purchaser
priceAlert.SpikeDetected → 通知 super_admin
run.Finished             → 通知所有相关 store
```

### 6.3 去重

`notifications.dedup_key` UNIQUE：例如 `order:${id}:submitted` 防止投影重放重复发。

### 6.4 Worker 任务

- 每分钟：扫 `outbox` 重发失败事件
- 每 5 分钟：刷新 supplier `reliability_score`
- 每天 0:00：归档 staff 草稿、生成日报、清 7 天前的 `client_logs`
- 每天 1:00：跑价格异常检测，写 `priceAlert.SpikeDetected`
- 每周一 9:00：发周报到 super_admin

---

## 7. 安全

### 7.1 鉴权

- Telegram initData HMAC 校验（与 Beta 相同），timestamp 不超过 24h。
- 颁发 access token (15 min) + refresh token (30 day, rotating) 对，**短 access token 让被盗 token 风险骤降**。
- WebAuthn 可选绑定（高权限角色：admin/super_admin 强制）。
- 对外端点全 HTTPS，HSTS 1y preload。

### 7.2 鉴权（授权）

ABAC 策略示例：

```
allow if subject.role in {'staff'} and action == 'order.adjust'
       and resource.session.memberId == subject.memberId
       and resource.session.status in {'draft','rejected'}

allow if subject.role in {'manager'} and action == 'order.adjust'
       and resource.session.claimedBy == subject.memberId
       and resource.session.status == 'submitted'

deny  if resource.session.status in {'in_run','approved'} and action == 'order.adjust'
```

每次决策写 `policy_decisions`（采样 10%，错决 100%）。出问题时可回放策略 + 输入。

### 7.3 输入

- 所有路由输入 Zod 严格 mode (`strict()`)。
- 上传文件强类型检查 + magic-byte sniff（不是只看 Content-Type）。
- 富文本字段（仅 `note`）只允许换行+空格+常见标点；HTML 一律转义。
- SQL 由 Drizzle 类型安全；任何 raw SQL 必须经 `sql<T>` 模板。

### 7.4 秘密

- `.env` 不进 git；`apps/api/env.ts` 启动校验。
- 生产用 `docker secrets` 或宿主机 `${env}` 注入。
- 每个 secret 至少 256-bit 随机；定期轮换 JWT 签名密钥（dual-key 平滑切换）。

### 7.5 多租户

- 每个 PG 连接 `SET LOCAL app.current_org_id`（事务内）。
- 后台任务用专用角色 `app_jobs`，bypass RLS；其代码必须显式 `where org_id = ?`。
- 测试套件含 "无 RLS 上下文则查询返回 0 行" 的烟雾测试。

### 7.6 速率与滥用

- Cloudflare（或 Caddy + 自带 rate-limit 模块）边缘做粗粒度限流。
- API 内 Redis sliding window 做精细限流。
- 5xx 错误率超阈值自动开熔断（`opossum`）。

---

## 8. 可观测性

### 8.1 三柱

| 柱 | 工具 | 内容 |
|---|---|---|
| 日志 | pino → Loki | 服务端结构化日志；client 通过 `system.log` 搬运到同库 |
| 指标 | OpenTelemetry → Prometheus → Grafana | RED 指标 + 业务指标（DAU、订单数、运行成功率） |
| Trace | OpenTelemetry → Tempo | 客户端点击 → 后端 → DB 查询，一根 traceparent 串到底 |

### 8.2 客户端遥测

继承 Beta 的 `lib/logger.ts` 思想，但：

- 改写为 `@compass/telemetry` 包，浏览器端基于 `@opentelemetry/sdk-trace-web` + 自定义 batch span exporter（指向 `system.spans` 端点）。
- 自动埋点所有 `<Button>` / `<Card.Interactive>` / route change / RPC。
- 离线时 IDB 缓存 spans，上线后批量发送（同 Beta 思路）。

### 8.3 SLO

- **可用性**：99.5% / 月（约 3.6h 可允许停机）
- **API 延迟**：p99 < 400ms（除 reports/exports）
- **WS 延迟**：p99 < 800ms 端到端
- 违反 SLO 触发告警到运营 TG 群

### 8.4 用户可见调试

`/debug` 页保留并升级：

- **Trace 视图**：粘贴 traceId 看完整调用链（前端 click → 后端 router → DB query），渲染成时间轴。
- **会话回放**：5 分钟以内的 click/nav/rpc 事件 timeline，带截图（仅 admin 可看）。
- **特性开关**：toggle org-level feature flags（带二次确认）。
- **测试模式 + 净化**：沿用 Beta 的 future-date + purge 思路。

---

## 9. 测试策略

### 9.1 金字塔

| 层 | 工具 | 数量目标 | 边界 |
|---|---|---|---|
| 单元 | Vitest | 200+ | 纯函数（domain/decide, projector, policy.eval, i18n.format） |
| 契约 | Vitest + tRPC test client | 80+ | 每个路由的 happy + error，不打 DB（mock infra） |
| 集成 | Vitest + 实际 PG (testcontainers) | 40+ | RLS、事件投影、并发 claim、迁移幂等 |
| E2E | Playwright | 15+ | 关键路径：登录→下单→审批→采购→收货→验收 |
| 负载 | k6 | 5+ | 每个高频路由的 baseline 与 spike 场景 |

### 9.2 必跑用例

- B1 拆分总和 = 实购总量
- B2 半步数量 step 校验
- B3 拒绝必须带 reason
- B4 已 finished 的 run 不可改
- B5 confirm note 在 issue 时必填
- B6 多 staff 同店并发：互不影响、各自独立 session
- B7 价格 1.2× 阈值告警
- B8 RLS：跨 org 读为 0
- B9 idempotency：相同 key 二次提交不重复
- B10 离线重放：30 个本地命令重连后顺序正确
- B11 撤回（withdraw）后重新编辑不丢字段
- B12 反审批（unapprove）若已进 run 则失败
- B13 WS 断线重连不丢事件（resume from seq）
- B14 投影重建：drop+rebuild 后所有 read_model 与重建前一致
- B15 跨语言：zh/en/ru/uz 全键存在性检查（CI grep）

### 9.3 CI

- PR：lint → typecheck → unit + 契约 → 集成（带 PG container） → build
- 主线合并后：E2E (Playwright) + 部署预发
- 每周：负载基线对比

---

## 10. 部署与运维

### 10.1 构建产物

```
Dockerfile (多阶段)
  stage build-deps     pnpm install --frozen-lockfile
  stage build-shared   build packages/* (drizzle generate, lingui compile)
  stage build-api      bun build apps/api/src/main.ts → out/api
  stage build-web      pnpm --filter web build → out/web
  stage runtime        oven/bun:1.1-alpine + out/api + out/web (web 由 api 静态服务)
```

镜像 < 120MB（Beta 的 tar 部署 ~600MB node_modules）。

### 10.2 拓扑

```
         ┌────────────────────────────────┐
         │  Caddy (auto-TLS, edge cache)  │
         └────────┬───────────────┬───────┘
                  │               │
          /api/*  │       /*      │  (静态 + SPA fallback)
                  ▼               ▼
           ┌─────────────┐  ┌──────────┐
           │ api (Bun)   │  │  web 静态 │ (由 api 同进程兜底)
           └──────┬──────┘  └──────────┘
                  │
        ┌─────────┼──────────┐
        ▼         ▼          ▼
     Postgres   Redis      S3/R2
```

蓝绿部署：`compass deploy` 先把新 container 拉起在 8081，健康探针 PASS 后切换 Caddy upstream。

### 10.3 备份

- 每天 03:00 PG `pg_basebackup` + WAL 持续归档到 S3，保留 30 天。
- 灾备演练：每月一次从备份重建到隔离环境，跑 smoke。

### 10.4 健康探针

- `GET /health/live`：进程活着
- `GET /health/ready`：DB ping + Redis ping + 最近事件投影时延
- `GET /health/version`：commit sha + build time

---

## 11. CLI 工具 `compass`

```
compass org create <slug> [--name "..."]                # 创建组织
compass org list
compass user grant <tg-id> --role super_admin --org <slug>
compass user impersonate <user-id> --ttl 30m            # 颁发短期 token，前端 ?as=token 进入
compass test purge --org <slug> --from <date> --to <date>  # 即 Beta 的 purgeTestData，CLI 版
compass project rebuild <stream-name>                   # drop+replay 投影
compass migrate                                         # drizzle-kit migrate + RLS 策略同步
compass logs tail --org <slug> --level error
compass deploy [--env prod] [--strategy blue-green]
```

CLI 与 API 共享 `packages/contracts`，不重复实现业务逻辑。

---

## 12. 路线图（按交付优先级）

### Milestone 0 — Foundation（本次会话目标）

- [x] 文件归档：原项目 → CompassBeta
- [x] 架构方案：本文
- [ ] Monorepo 骨架：package.json / turbo / tsconfig / pnpm-workspace
- [ ] Drizzle schema 完整版（含 RLS DDL）
- [ ] domain/order 事件 + decide + projector + 单测
- [ ] apps/api 启动 OK，`auth.me` + `order.adjust` + `order.submit` 可用
- [ ] apps/web 启动 OK，OrderPage 完整、用 WS 订阅本店事件、离线可写

### Milestone 1 — Core Workflow

- [ ] 完整 order/run/delivery/confirm 链路（含撤回/反审批的事件版）
- [ ] Concord 设计系统全套组件（Native + Apple 主题）
- [ ] Bot 三通道通知接通
- [ ] OTel + Loki + Grafana

### Milestone 2 — Intelligence

- [ ] 历史均值建议（"你周五通常订 5kg 牛肉"）
- [ ] 价格异常检测（slope + z-score）
- [ ] Supplier 评分自动维护
- [ ] 报表导出 Excel

### Milestone 3 — Hardening

- [ ] WebAuthn for admins
- [ ] 全量 RLS 测试
- [ ] 蓝绿部署 + 备份恢复演练
- [ ] CLI 完整命令集

---

## 13. 决策记录（DR）

每个重大决策一行：

```
DR-001  2026-05-01  Hono over Fastify          冷启动 + 原生 WS
DR-002  2026-05-01  Drizzle over Prisma        Bun 原生、SQL-first、RLS DDL 友好
DR-003  2026-05-01  Event-sourced domain core  审计、撤回、时间旅行 一次性解决
DR-004  2026-05-01  Postgres RLS               应用层 bug 不再能引发跨租户泄露
DR-005  2026-05-01  TanStack Router            类型安全路由 + loader 预取
DR-006  2026-05-01  Tailwind v4 + OKLCH        动态主题 + HDR 色彩
DR-007  2026-05-01  Lingui ICU                 plural/select 编译期，无运行时解析
DR-008  2026-05-01  OpenTelemetry              生态标准，跨前后端单根 trace
DR-009  2026-05-01  Bun 1.1.x pinned           部署一致性
DR-010  2026-05-01  Stall→Supplier 升级        加评分/可靠度/价格信任
DR-011  2026-05-01  RunIndex 同日多趟          适配早午两次补货
DR-012  2026-05-01  ABAC + 决策审计            白名单+黑名单可层叠，支持自定义
DR-013  2026-05-01  WebSocket + SSE 双通道     iOS WebView WS 偶有阻断时降级
DR-014  2026-05-01  Outbox + Idempotency       事务一致 + 重试安全
DR-015  2026-05-01  PWA 双形态                 脱离 Telegram 容器也能用
```

---

## 14. 不做清单（防止过度工程）

- 不做微服务拆分。所有服务在同一 monorepo，单进程跑。规模到 50 万 DAU 再考虑。
- 不引入 GraphQL。tRPC 类型推断已经够用，再多一层 schema 是负担。
- 不做服务端 SSR。Telegram Mini App 与桌面 PWA 都是 SPA 体验最佳。
- 不引入 Redux/MobX。Zustand + Valtio + React Query 三件套覆盖所有场景。
- 不写自己的 ORM/HTTP framework。轮子风险远大于收益。
- 不做"AI 助手"功能直到 M2 完成。先把基础做扎实。

---

文档结束。任何与本文不一致的实现都需要先修订本文（提 PR 改 ARCHITECTURE.md）。
