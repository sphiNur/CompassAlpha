# CompassAlpha

> 下一代采购协同系统 — 多门店采购工作流、市场跑腿、签收对账、RBAC 与价格情报。
> CompassBeta 的完全重写，全方位超越前代。

**先读 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 再看代码。** 任何与架构方案不一致的实现都需要先改架构文档。
（架构 + 运维文档在仓库根目录的 `ARCHITECTURE.md` 和 `docs/RUNBOOK.md`。`docs/` 里还有 `EVENT_CATALOG.md` / `PERMISSION_MATRIX.md` / `API.md` / `DESIGN.md`。）

## 快速上手

```bash
# 1. 准备环境（要求 Bun 1.1.38, pnpm 9.x, Postgres 16, Redis 7）
cp .env.example .env
docker compose -f infra/compose/docker-compose.dev.yml up -d   # 起 PG + Redis + MinIO + Otel
# 注意：dev compose 把 PG 暴露在 5433，Redis 在 6380（避开本机已有进程）。
# .env.example 里的 DATABASE_URL/REDIS_URL 已对应这两个端口。

# 2. 安装依赖
pnpm install

# 3. 生成 + 迁移数据库 + 种子
pnpm db:generate
pnpm db:migrate
pnpm db:seed

# 4. 启动 API + Web
pnpm dev
# API:  http://localhost:3000
# Web:  http://localhost:5173
# Adminer (DB):  http://localhost:8080

# 5. 给自己授超管
pnpm compass user grant <你的 Telegram user id> --role super_admin --org default
```

> **Telegram 调试**：本地开发可用 `VITE_DEV_MOCK_INIT_DATA=1` 跳过 BotFather 真实签名，
> 走 mock 用户登录。生产环境强校验 HMAC（见 `apps/api/src/services/telegramAuth.ts`，
> 单元测试在 `apps/api/src/__tests__/telegramAuth.test.ts`）。

> **Bot 通知通道**：生产服务器到 `api.telegram.org` 出口被阻断时，部署 Cloudflare
> Worker 中继并设 `TG_RELAY_URL` + `COMPASS_RELAY_KEY` + `BOT_DELIVERY_ENABLED=true`。
> 详见 [`infra/cloudflare/README.md`](./infra/cloudflare/README.md)。

## 工程结构

```
apps/
├── api/      Hono + tRPC + Drizzle (Bun)
├── web/      React 18 + Vite + Tailwind v3 + TanStack Router
├── bot/      grammY (Bun)
└── worker/   BullMQ workers (Bun)

packages/
├── domain/      事件 + 聚合 + decide()（纯函数，无副作用）
├── db/          Drizzle schema + RLS + 迁移 + 种子
├── contracts/   tRPC 路由 + Zod schema（前后端共用）
├── ui/          Concord 设计系统（Native / Apple 双主题）
├── i18n/        ICU catalogs (zh, en, ru, uz) — 4 个文件，CI 校验键对齐
├── telemetry/   OpenTelemetry SDK + 客户端日志
└── cli/         compass 命令行

infra/
├── docker/      Dockerfile 多阶段
├── caddy/       Caddyfile
├── compose/     docker-compose.{dev,prod}.yml
├── systemd/     compass-api / compass-worker .service
└── backup/      pg_dump 夜间备份 + 还原脚本（见 docs/RUNBOOK.md）

docs/
├── EVENT_CATALOG.md
├── PERMISSION_MATRIX.md
├── API.md
├── DESIGN.md
├── RUNBOOK.md
└── M1.5-AUDIT.md     一次大审计的结果，可作为 audit 报告模板
```

## 常用命令

```bash
pnpm dev                          # API + Web 一起跑
pnpm dev:api                      # 只跑 API
pnpm dev:web                      # 只跑 Web
pnpm build                        # 全部构建
pnpm type-check                   # tsc --noEmit（CI 跑同一个）
pnpm test                         # 全部测试
SKIP_PG_TESTS=1 bun test ...      # 跳过 PG-gated 集成测试（CI 模式）
pnpm test:e2e                     # Playwright E2E
pnpm db:migrate                   # drizzle-kit migrate
pnpm db:studio                    # drizzle-kit studio
pnpm compass <command>            # CLI 入口

# 部署：
bun run scripts/deploy.ts         # 一键 tar→scp→migrate→restart→smoke
bun run scripts/deploy.ts --dry   # 只跑 smoke，不部署
```

## 增加新功能 / 修 bug 的标准流程

1. **写事件**：在 `packages/domain/src/<aggregate>/events.ts` 增加 event 类型（payload schema 是公共契约，改了要新事件类型）。
2. **写 reducer**：在 `state.ts` 的 `apply()` 加 case，更新 in-memory 投影。
3. **写命令**：在 `commands.ts` 的 `decide()` 加 case，做权限/校验，emit 事件。
4. **写 projector**：在 `apps/api/src/services/<aggregate>Projection.ts` 加 case，更新读模型表。
5. **写 migration**：`packages/db/migrations/00xx_*.sql` + `meta/_journal.json` 加同名条目（CI 会卡缺漏）。
6. **写 tRPC**：`apps/api/src/trpc/routers/<router>.ts` 加 procedure，调 `decide` + `appendEvents` + `projectXxx`。
7. **写 FE**：`apps/web/src/pages/...` 用 `trpc.xxx.useMutation`，乐观写缓存（参考 OrderPage.tsx 的 debounce + serialize 模板）。
8. **写 i18n**：所有用户可见字符串走 `i18n.t(...)`。**4 个 catalog 同时加** (`en/zh/ru/uz`)。CI 卡键对齐。
9. **测**：`packages/domain/.../*.test.ts` 加 unit；服务层 / API 层在 `apps/api/src/__tests__/` 加（PG-gated 用 `SKIP_PG_TESTS` 在 CI 跳过）。
10. **smoke**：`scripts/smoke.ts` 是 server 端，`scripts/browser-smoke*.ts` 是浏览器端，部署脚本都会跑。

> 历史决策放在仓库根的 `ARCHITECTURE.md` 第 "DR-XXX" 段；阶段性大审计放在 `docs/M1.x-AUDIT.md`。

## 核心设计原则

1. **事件源为真**：状态字段是事件流的投影，不是源。要审计、要撤回、要时间旅行 → 看事件流。
2. **多租户在 DB 强制**：Postgres RLS。即使应用层有 bug 也无法跨租户。
3. **离线优先**：所有写命令进 IDB outbox，UI 立即应用，网络恢复时按序重放。
4. **类型贯通到 SQL**：Drizzle SQL-first，前后端 tRPC 类型推断，Zod schema 跨端共用。
5. **可观测性是一等公民**：OTel trace 从前端点击穿到 DB 查询，根因分析不靠猜。
6. **i18n 不打折**：所有面向用户的字符串走 Lingui ICU，CI grep 检查 zh/en/ru/uz 全键存在。
7. **a11y 默认**：Concord 组件全部基于 Radix 原语，键盘可达、ARIA 正确、reduce-motion 尊重。

## 与 CompassBeta 的兼容性

**0%**。这是完全重写。Beta 仍保留在 `../CompassBeta`，可参考但不复用代码。
数据迁移工具（如果需要）放在 `infra/migrations/from-beta/`，按需开发。

## License

Proprietary. © 2026 Compass.
