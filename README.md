# CompassAlpha

> 下一代采购协同系统 — 多门店采购工作流、市场跑腿、签收对账、RBAC 与价格情报。
> CompassBeta 的完全重写，全方位超越前代。

**先读 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 再看代码。** 任何与架构方案不一致的实现都需要先改架构文档。

## 快速上手

```bash
# 1. 准备环境（要求 Bun 1.1.38, pnpm 9.x, Postgres 16, Redis 7）
cp .env.example .env
docker compose -f infra/compose/docker-compose.dev.yml up -d   # 起 PG + Redis + MinIO + Otel

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

## 工程结构

```
apps/
├── api/      Hono + tRPC + Drizzle (Bun)
├── web/      React 18 + Vite + Tailwind v4 + TanStack Router
├── bot/      grammY (Bun)
└── worker/   BullMQ workers (Bun)

packages/
├── domain/      事件 + 聚合 + decide()（纯函数，无副作用）
├── db/          Drizzle schema + RLS + 迁移 + 种子
├── contracts/   tRPC 路由 + Zod schema（前后端共用）
├── ui/          Concord 设计系统（Native / Apple 双主题）
├── i18n/        Lingui ICU catalogs (zh, en, ru, uz)
├── telemetry/   OpenTelemetry SDK + 客户端日志
└── cli/         compass 命令行

infra/
├── docker/      Dockerfile 多阶段
├── caddy/       Caddyfile
├── compose/     docker-compose.{dev,prod}.yml
└── grafana/     仪表盘 JSON

docs/
├── ARCHITECTURE.md
├── EVENT_CATALOG.md
├── PERMISSION_MATRIX.md
├── API.md
├── DESIGN.md
└── RUNBOOK.md
```

## 常用命令

```bash
pnpm dev                  # API + Web 一起跑
pnpm dev:api              # 只跑 API
pnpm dev:web              # 只跑 Web
pnpm build                # 全部构建
pnpm type-check           # tsc --noEmit
pnpm test                 # 全部测试
pnpm test:e2e             # Playwright E2E
pnpm db:migrate           # drizzle-kit migrate
pnpm db:studio            # drizzle-kit studio
pnpm compass <command>    # CLI 入口
```

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
