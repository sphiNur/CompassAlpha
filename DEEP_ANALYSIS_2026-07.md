# CompassAlpha — 生产就绪深度分析与演进规划

> **日期**: 2026-07-03
> **方法**: 7 个领域并行深挖 + 对每条 critical/high 发现做对抗性核实（尽量证伪）+ 文档与 git 历史交叉比对。关键发现已由我本人对照源码二次核对。
> **前置约束**: 系统已在生产环境为付费客户服务，采用事件溯源（事件流是唯一真相源），任何建议都以「数据连续性 + 零/低停机」为前提。

---

## 0. 结论先行（TL;DR）

**不重写。整体、以及全部 7 个模块，独立评审一致给出 `keep` 或 `refactor`，没有任何一个模块被判为需要重写。**

理由很硬：
1. **架构选型是对的且已被生产验证**。事件追加与读模型投影在**同一个 Postgres 事务内同步完成**，从结构上消除了事件溯源系统头号风险——事件流与读模型漂移。`(stream_id, seq)` 唯一约束做乐观并发、事务性 outbox 做通知投递，都是教科书级的正确做法。
2. **代码质量异常高**。几乎每一处非显然决策都带有「日期 + 里程碑 + 原因」的注释，多个安全单元有回归测试（RLS 逐表隔离、refresh token 重放、Telegram HMAC、S3 SigV4 对齐 AWS 官方测试向量）。前端把 iOS/Telegram 的各种坑收敛在独立模块里，而不是散落成补丁。
3. **重写会摧毁而非创造价值**。它会把「已解决的漂移风险」重新引入，把数月踩坑换来的 iOS WebView 修复全部作废，并让生产事件库直面迁移风险——**换来零架构收益**。

真正需要的是一份**外科手术式加固清单**：约 2–3 周、逐项可独立上线、全部不触碰已存储数据。下面按危险程度排列。

---

## 1. 最危险的三件事（各一句话）

1. **离线队列会在用户切换标签页时，静默地永久删除已提示「已保存」的财务写入**（采购/支出/配送），因为共享的 IndexedDB outbox 被任何当前页面刷新时，会丢弃它不认识的过程条目——集市弱网正是本 App 的核心使用场景。
2. **整套系统（应用 + Postgres + 备份）都在一台 VPS 上，异地备份是可选的、且上传失败只打印 WARN 并以 0 退出**——一次磁盘/账号故障即同时抹掉事件库、读模型和全部 14 天备份，付费客户数据不可恢复。
3. **门店级采购员可以对不属于自己门店的 Run 执行带钱的写操作**（记采购、改价、结算、取消），因为所有 run 写操作只校验「同 org」而跳过了读路径上明确执行的「门店归属」校验。

---

## 2. 已核实发现清单（按核实后严重度排序）

> 「✅确认」= 对抗性核实端到端成立；「⬇️降级」= 核实后严重度下调；下一节单列被证伪项。

### 🔴 Critical

| # | 发现 | 位置 | 后果 | 状态 |
|---|------|------|------|------|
| C1 | 离线队列跨页静默丢弃财务写入 | `apps/web/src/hooks/useOfflineQueue.ts:58-65` | 三个页面注册各自不相交的 replay map，`flush()` 遍历**整个共享 outbox**，凡当前页不认识的过程直接 `outbox.remove()`，无 toast、无日志。RunPage 排队 `run.purchaseItem` 后切到 Order/Confirm 标签 → 联网 → 采购记录被永久删除，服务器从未收到。 | ✅确认 |
| C2 | 单机部署 + 异地备份可选且静默失败 | `infra/backup/compass-backup.sh:93-113`；`compass-api.service:4` | DB 与备份同盘；`.env.example` 里根本没有 `BACKUP_S3_*` 键；上传失败走 `WARN ... exit 0`，systemd 视为成功。RPO 24h，且最坏情况全量不可恢复。 | ✅确认 |

### 🟠 High

| # | 发现 | 位置 | 后果 | 状态 |
|---|------|------|------|------|
| H1 | run 写操作全部跳过门店归属校验 | `apps/api/src/trpc/routers/run.ts:2068-2069`（runSimpleCommand） | `run.get`/`run.list` 做门店重叠校验（M3.33 修的跨店信息泄露），但 claim/purchaseItem/revisePurchase/finish/cancel 只做 `loadRun(orgId)`。域层只查扁平权限、不看门店绑定。runId 经 `hub.publish` 向全 org 广播，可发现 → 门店 A 采购员可对纯服务门店 B 的 Run 记账、改价、取消。 | ✅确认 |
| H2 | 离线重放无稳定幂等键 → 幽灵重复扣款 | `apps/web/src/lib/trpc.ts:164-169`；`useOfflineQueue.ts:7-9` | 每次请求 `genKey()` 生成新 key，服务端幂等中间件永远命中不了；iOS「Load failed」被当作瞬时错误重放，但该错误也发生在「请求已到达、仅响应丢失」时。`run.purchaseItem` 域层不拒绝已购项 → 重放追加第二条 `ItemPurchased`，`price_history` 无 `onConflict` → 每次重放插入重复价格观测，污染价格分析。代码注释自己承认这是「等复现的高价值待办」。 | ✅确认 |
| H3 | 离线队列毒丸阻塞 + 状态对用户不可见 | `useOfflineQueue.ts:70-81` | 只丢弃 CONFLICT/BAD_REQUEST/NOT_FOUND；`PRECONDITION_FAILED`（run 已结束时排队采购重放必现的 `runFrozen`）、FORBIDDEN、500 全被当瞬时错误 → `retries++`（无上限）+ `break`，永久阻塞其后所有条目。`pendingCount` 从未渲染，用户以为「已保存」。 | ✅确认 |
| H4 | 灾难恢复 reproject 脚本无法运行 | `apps/api/scripts/reproject.ts:192-193,248-249` | 两处 replay 查询 `SELECT actor_user_id, actor_member_id FROM domain.events`，但该表只有 `actor_id`。Postgres 在 TRUNCATE 之后、单事务内抛 42703 → 回滚。读模型损坏时**唯一的重建路径今天就跑不通**。（事务回滚保证无数据丢失，故 high 非 critical。） | ✅确认 |
| H5 | purge 脚本一键清空所有租户事件库 | `packages/db/src/purge-fake-data.ts:55-185` | 自动向上加载仓库根 `.env`（生产机上即生产 DSN），然后对整个 `domain.events`、全部读模型、所有门店/SKU/供应商执行**无 WHERE** 的 DELETE，唯一闸门是 `--apply`，无环境判断、无 org 范围、无目标库确认。`drain-outbox.ts` 证实此类脚本已对生产库跑过（2026-05-05 purge）。 | ✅确认 |
| H6 | 无任何监控与告警 | `infra/systemd/*.service`（无 OnFailure）；`.env.example:67` | 无 OnFailure、无 uptime 探针、无错误上报；OTel 指向本机不存在的 collector；RUNBOOK 让运维查 Loki 但 infra 里没有 Loki。worker 夜间崩溃 → 审批推送停 → 客户投诉才发现；备份可静默失败数周。 | ✅确认 |
| H7 | 无可用回滚 + RUNBOOK 虚构 | `docs/RUNBOOK.md`「回滚」段 vs `deploy.ts:135` | RUNBOOK 写的是 `docker tag ... && docker compose up`，但生产是 systemd 跑 `bun run src/main.ts`，主机上根本没有镜像。真实 deploy 用 `--strip-components=1` 就地覆盖上一版本，销毁回滚源。事故中翻开 RUNBOOK，命令全部失效。 | ✅确认 |
| H8 | 生产边缘 nginx 配置未纳入版本控制 | `deploy.ts:22`；`infra/` 无 nginx | 提交的是从未服役的 Docker/Caddy 栈；真实边缘是「Cloudflare + nginx」，含承重的 `Cache-Control: no-store` 修复，只存在于主机上。VPS 重建即多日重构。 | ✅确认 |
| H9 | deploy 管道 `| tail` 掩盖 install/build 失败 | `deploy.ts:143,266` | 与已修的 migrate 同类 bug：`pnpm install 2>&1 | tail -5` 的退出码是 tail 的（恒 0）。install 失败 → 仍重启 API → 缺依赖崩溃循环；vite build 失败 → 旧前端资源仍在，浏览器 smoke 打旧包通过 → DEPLOY GREEN 但新 API + 旧前端。 | ✅确认 |
| H10 | deploy 发布的是本地工作树、无 CI 门禁、测试在重启后才跑 | `deploy.ts:101-135,282-328` | tar 打包的是磁盘现状（含未提交改动），而版本 sha 取自 git HEAD → `/health/version` 可能与实际代码不符。单测/集成/smoke 全在 `systemctl restart` **之后**执行。 | 证据充分（核实中断） |
| H11 | 迁移直接作用于生产、迁移前无备份、无 down 脚本 | `deploy.ts:148-168`；备份仅每夜 03:30 | 恢复点只有昨夜 dump。一条坏的 data-mutating 迁移即丢失整个营业日、所有租户。 | 证据充分（未核实） |
| H12 | CLI `user grant` 绕过全部授权保护 | `packages/cli/src/commands/user.ts:38,94-109` | API 的 grantRole 强制「rank<80 必须门店级」（2026-05-05 事故后加的），CLI 全不校验，`--scope` 默认 global，且 `member_role_bindings` 无 CHECK 约束。一条习惯性命令即重演「到处都是 manager」的跨租户泄露。 | 证据充分（核实中断） |
| H13 | `read_model.run_expenses_v` 完全没有 RLS | `0030_run_expenses.sql`；`900_rls_policies.sql` | 唯一带钱的读模型表（金额、支付方式、小票照片 URL）缺失 RLS 兜底。今天唯一读路径按 runId + org 校验父级，故无活跃泄露——是**纵深防御缺口**，一个未来漏写 WHERE 即失去保护。 | ✅确认（critical→high） |

### 🟡 Medium（择要）

- **金额精度契约漂移**：`common.ts` 的 3 位小数 decimal 同时用于 kg 数量（对）和货币（错），客户端可提交 `10.005`，Postgres 存入 `numeric(*,2)` 四舍五入为 `10.01`，而事件 payload（jsonb）保留 `10.005` → 事件真相与读模型/报表按设计不一致，重放累积次分误差。（`db-schema`）
- **浮点金额数学未测试**：结算合计用 IEEE-754 float 求和再 `toFixed(2)`，域层、投影列、客户端预览三处各自舍入，无测试锁定三者一致。（`quality-tests`）
- **一批 API 授权/加固中缺口**（均有代码定位，未逐条核实）：`order.setNote` 漏门店校验；`memberSetStatus` 无 rank 校验（rank-60 经理可停用 rank-80 管理员）；`system.recentLogs` 对任意成员开放全 org 遥测；限流键可被伪造的 `x-forwarded-for` 绕过、无 IP 时完全不限流；Telegram initData 24h 窗口 + 无重放追踪；`consumeRefresh` SELECT-then-UPDATE 竞态（未检查 rowCount）；S3 预签名不签 Content-Length（任意大小上传）+ 扩展名取自客户端文件名（潜在存储型 XSS）；`run.ts` 供应商查询用仓库自己文档记为「坏」的 `IN ${array}` 绑定 → 首选供应商映射可能静默为空。
- **idempotency 中间件回放已损坏**：命中缓存时返回裸 payload 而非 tRPC MiddlewareResult → 回放 500。今天潜伏（前端从不重用 key），但幂等契约实际失效。（`api-routers`，high→medium）
- **worker 挂起 / hub 在提交前 publish / worker sweep 从读模型推 seq / WS 仅在握手时鉴权**：见 `api-core`，均 medium，自恢复或有兜底。
- **仅 0000 有 drizzle snapshot**：schema TS 与实际 DDL 漂移无校验，已导致过一次 `sales.qty numeric(10,2)` 静默截断（0018 修复）。
- **无保留策略**：outbox/client_logs/policy_decisions 只增不删；outbox pending 索引非 partial，轮询延迟随历史线性退化。
- **`member_store_assignments` 无外键**：门店访问授权表可留孤儿行。
- **测试盲区**：run 带钱过程从未经 router+投影事务测试；order router 从未经 caller 测试；离线队列、worker outbox、reproject 零测试；`@compass/e2e` 包根本不存在（`pnpm test:e2e` 静默空跑，假绿）。

---

## 3. 诚实呈现：被核实为「误报或过度定级」的项

对抗性核实的价值一半在于**砍掉唬人但不成立的发现**：

- **门店经理可铸造 super_admin**（原 high）→ **不成立**。`admin.ts:1143-1150` 在 isGlobalAdmin 启发式之后还有与 grantRole 同款的严格 rank 闸门（`role.rank >= actorRank` 即 FORBIDDEN 并回滚），经理 rank 60 无法授出 rank ≥80 角色。
- **bot 在生产已死导致无法 onboarding**（原 high）→ **降为 low**。/id 确实在生产不通，但 Mini App 的拒绝访问页会直接展示用户 Telegram id 并一键复制（`AuthGate.tsx:346-366`），且用户一打开 App，`telegramLogin` 就已落库 tgUserId，授权流不依赖 bot。
- **run_expenses 无 RLS**（原 critical）→ **high**：无活跃泄露，是纵深防御缺口。
- **dishes RLS 未 FORCE / 全策略 fail-open**（原 high）→ **medium**：确为死兜底/既定债务，但所有路径都在 `ctx.withOrg` 内显式按 org 过滤，无可达的跨租户泄露。
- **worker 永久挂起 / WS token 过期致页面永久 stale**（原 high）→ **medium**：前者因运行时 fetch 默认超时而自恢复；后者任一次交互即自愈。

---

## 4. 模块级裁决

| 模块 | 规模 | 裁决 | 一句话理由 |
|------|------|------|-----------|
| API 核心（事件溯源/投影/outbox/实时） | ~17.7k LOC | **keep** | 同事务同步投影从结构上消除漂移；重写只会引入它当前规避的风险。修 reproject SQL 是最紧急单项。 |
| API 路由 / 鉴权 / 多租户 | 同上 | **refactor** | 架构稳，但授权是每过程手工拼装 → 必然漂移。修 4 个安全缺口 + 把门店/权限校验收敛进共享 procedure builder + CI 把 PERMISSION_MATRIX 与代码绑定。 |
| Web 前端（React TMA） | ~22.6k LOC | **refactor** | 「一堆 hack」实为收敛良好、带日期注释的 iOS 修复。修离线队列（C1/H2/H3）+ 把 AdminPage(7852)/RunPage(6810) 机械拆分为已命名的子组件文件。 |
| DB / 迁移 / RLS / 契约 | ~7.4k LOC | **refactor** | 事件库设计正确、迁移有纪律、精度类型对。一周加固：补 RLS、fail-open→fail-closed、purge 护栏、schema 漂移 CI、金额契约拆分。 |
| 基础设施 / 部署 / CI | ~2.4k LOC | **refactor** | 运维成熟度约 4/10。CI 集成任务（真 PG + 非属主 NOBYPASSRLS 角色）是最强项；短板是单点、无告警、无回滚、配置漂移。一周可到 ~7/10。 |
| Bot + CLI | ~0.3k LOC | **keep** | 太小无重写价值。补 CLI grant 护栏 + DB CHECK 约束，明确 bot 的生产去留。 |
| 测试 / 质量 | — | **keep** | 现有的远超同龄项目。缺的是补充：run 带钱过程 router 级测试、reproject 重放 CI、离线重复重放测试、抽取并测试前端结算数学、一条不打桩的端到端。 |

---

## 5. 行动规划（P0 本周 / P1 本月 / P2 本季度）

按「每单位工作量降低的风险」排序。全部逐项可独立上线，不触碰已存储数据。

### P0 — 本周（保护生产，多为纯前端/脚本/配置，几乎零迁移风险）

1. **C1 离线队列跨页丢失**：把 replay map 提升为 App 级单一注册表（由各页填充），仅在确认所有页都不认识某过程时才丢弃，且丢弃/毒丸必带 toast + 遥测。**纯前端，最高性价比。**
2. **H2 稳定幂等键**：把 `X-Idempotency-Key` 从 outbox 条目的 `clientSeq` 派生，首次尝试也带上。服务端支持已存在。
3. **H3 毒丸阻塞**：把 PRECONDITION_FAILED/FORBIDDEN 加入终止集并 toast；retries 设上限；把 `pendingCount` 渲染成角标。
4. **H1 run 写操作门店校验**：在 runSimpleCommand（及 finish/cancel）套用与 `run.get` 相同的门店重叠闸门。约十几行，纯应用层。
5. **H4 修 reproject SQL**（`actor_id AS actor_user_id, NULL AS actor_member_id`）+ 加一个 CI 冒烟跑通它。这是头号风险类的唯一恢复路径。
6. **C2/H6 备份与告警（当周内在服务器核实）**：确认 S3 桶里真有 dump；上传失败改为非零退出；加 `OnFailure=` 经现有 tg-relay 发 Telegram 告警 + 一个免费外部 uptime 探针打 `/health/ready`。
7. **H5 purge 脚本护栏**：要求回打目标 DSN host/db + `--org <uuid>` 范围 + 非 localhost 需 `I_UNDERSTAND_THIS_IS_PROD=1`。
8. **H9 deploy 去掉 `| tail`**（或 `set -o pipefail`）。

### P1 — 本月

9. **H13 补 RLS 完整性**：`run_expenses_v` ENABLE+FORCE，加入 900 策略文件；FORCE dishes/dish_ingredients。扩展 rls-isolation 测试：枚举 pg_tables，任何带 org_id 却无策略的表即失败——从根上堵住复发。
10. **H7/H8/H10/H11 部署管道**：改为从干净 git ref 发布（`git status --porcelain` 非空即拒绝、`git archive HEAD`）、保留上一版本用符号链接回滚、迁移前 `pg_dump`、gate 于该 sha 的 CI 绿灯；把生产 nginx 配置纳入 `infra/`，重写 RUNBOOK 对齐 systemd 现实，删除/隔离未用的 Docker/Caddy 栈。
11. **API 授权收敛**：修 setNote/memberSetStatus/recentLogs/限流 IP/refresh 竞态；抽出 `storeScopedProcedure`/`runScopedProcedure`；CI 快照测试把 seed 权限与代码引用的 key 对齐。
12. **金额正确性**：拆分 `MoneyStringSchema`（≤2 位）与数量 schema；抽取域层/投影/前端三处金额数学并加一致性测试。
13. **补测试**：run 带钱过程 router 级 PG 测试、order/run 权限矩阵测试、reproject 重放 CI、离线重复重放测试、worker outbox 测试；修或删 `test:e2e`（当前假绿）。
14. **H12 CLI grant 护栏 + `member_role_bindings` CHECK 约束**；CLI 变更写 `ops.audit_log`。

### P2 — 本季度

15. **fail-open → fail-closed RLS**：分阶段引入显式 bypass 角色，翻转 API 用户，再去掉 `IS NULL` 逃逸——多租户已上线，这是最高杠杆的隔离加固。
16. **worker 独立最小权限 DB 角色**（compass_jobs）；worker HTTP send 移出事务 + 加超时 + WatchdogSec。
17. **机械拆分 god 文件**：AdminPage/RunPage 的已命名子组件各自成文件，RunPage 的 mutation 集群抽成 `useRunMutations(runId)`。逐段一个 PR，行为不变。
18. **保留策略与索引**：outbox pending partial 索引、client_logs/outbox 夜间清理、policy_decisions `(org_id, occurred_at)` 索引、补 `member_store_assignments` 外键、drizzle schema↔DDL 漂移 CI。
19. **WS ticket 化**（去掉 URL 里的 access JWT）；限流迁到 Redis；文档去虚构（API.md/EVENT_CATALOG.md/PERMISSION_MATRIX.md/RUNBOOK.md 描述了未实现的 ws-ticket/snapshots/ABAC/BullMQ/Loki，运维上不可信）。

---

## 6. 文档现状（重要）

`cf8854f`(M3.18, 2026-05-17) 一天内落地了 PRODUCTION_AUDIT 的全部 5 个 P0 与 8 个 P1，所以那两份审计文档作为**状态报告已过期**（但 P2/P3 条目多数仍准）。`ARCHITECTURE.md` v2.0 大体准确但数字陈旧（说 24 个迁移，实为 34；低估文件体积）。`docs/API.md / EVENT_CATALOG.md / PERMISSION_MATRIX.md / RUNBOOK.md` 描述了**未实现的设计**（ws-ticket、每 200 事件快照、ABAC policy_rules、BullMQ、Loki、docker 部署），**运维时不可信**——这本身是 P1 级风险（H7）。

---

*方法论：本报告由 7 个领域代理并行深挖，对每条 critical/high 发现派独立「证伪者」核实，再由人对最承重的三条（C1 离线丢失、H1 run 越权、H13 run_expenses RLS）对照源码二次确认。严重度均为核实后的修正值。*
