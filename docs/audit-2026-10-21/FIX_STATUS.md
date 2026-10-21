# 审计问题修复进度（2026-10-21）

- 分支：`fix/audit-2026-10-21`，基于 `c49ba3e`，已推送，PR：https://github.com/sphiNur/CompassAlpha/pull/56（CI 全绿）
- 改动规模（第一、二轮）：75 个已有文件修改（+4501 / −1669），29 个新代码或测试文件，2 个迁移（0047、0048）
- 问题编号对应 `docs/PROJECT_COMPREHENSIVE_AUDIT.md` §9

## 本地验证结果

| 检查 | 结果 |
|---|---|
| `tsc --noEmit`，12 个 workspace | 全部通过 |
| web ESLint `--max-warnings 0` | 通过 |
| CI 同款非 PG 单测（domain、i18n、ui、api、worker、web） | **483 pass / 0 fail / 151 skip** |
| i18n 四语键数一致（各 1395）、ICU 复数检查、未翻译字面量检查、typography 检查、console.log 检查 | 全部通过 |
| 迁移 journal 与 SQL 文件一致性 | 通过（49 个） |
| web 生产构建 | 通过 |
| **PG 集成测试 + Playwright E2E** | **CI 全部通过**（PR #56，提交 `87d409b`：集成测试 248/248，E2E 全过）。CI 首轮发现并修复了 3 个问题：审批按钮“认领→通过”竞态、“所见即所批”误把审批人自己的认领当成他人修改、`run.create` 日期校验排在权限检查前 |
| Telegram 真机、E2E | 未运行 |

## 已修复：可由代码或领域设计直接判定的问题

| ID | 修复内容 |
|---|---|
| CA-01 | 订单被认领后，员工仍能看到回执和“由 X 审核中”的提示 |
| CA-02 | 被驳回的订单回到员工订货页，可修改后重新提交（沿用领域层已有的 rejected → 编辑 → 提交流程） |
| CA-05 | 采购员的供应商选择器改用 `catalog.suppliers`，并默认过滤已归档供应商 |
| CA-07 | 修改成员显示名需要 `org.admin`，或者成员所在的每家门店都归操作者管理且操作者 rank 更高；写入审计 |
| CA-08 | 停用、启用门店只允许 `org.admin`；`org.admin` 可以恢复已停用的门店，恢复时检查门店数限额 |
| CA-13 | CI 集成测试改为运行整个 `__tests__` 目录 |
| CA-14 | reproject、repair、diagnose 脚本改用系统 RLS 上下文；RUNBOOK 按真实的 systemd 拓扑重写 |
| CA-15 | 通知深链 `/approve`、`/run`、`/confirm`、`/order` 会切换到对应 Tab |
| CA-16 | 前端权限门控与后端对齐：目录、菜品、角色、移出组织、门店新建和归档、财务设置；平台管理员可以进入 Platform |
| CA-18 | 套餐限额：恢复成员、接受邀请时检查限额，限额检查加咨询锁 |
| CA-21（部分） | 销售和报损使用稳定的幂等键，避免重试导致重复扣减 |
| CA-22 | 管理多家门店的成员可以切换门店 |
| CA-23 | 销售按门店或组织时区划分日期；财务日期预设改用本地日历 |
| CA-24 / CA-25（部分） / CA-26 | “再报一批”不再带入上一批的数量；卸载或切页前未发出的修改会先发出；提交有防重锁和稳定幂等键；重复的提交、通过、驳回视为成功 |
| CA-27（部分） | 审批卡片能显示 extras；无效 extras 行有提示 |
| CA-28 | 清理测试数据时会清 outbox 和 Run 的库存流水（日结修订表未改动，待决策） |
| CA-29 / CA-30 | 采购只能分配到本 Run 涉及的门店；“合并”不再丢失其他门店的需求；收货确认要求已送达且未确认 |
| CA-31 | 取消 Run 会发通知；attach 后会广播；outbox 只为实际插入的通知写入；dedupKey 带 seq；收件人排除已停用成员、过期绑定和被 deny 的成员 |
| CA-33 / CA-34 / CA-35 | 切换组织、登出时重置导航；Sheet 打开时显示 Telegram 返回键（**需真机验证**）；WS 重连后补拉数据；被驱逐或 token 过期的连接会关闭，客户端重连并刷新 token；WS 连接时校验成员状态 |
| CA-36 | `run_expenses_v`、dishes、dish_ingredients 纳入统一 RLS（FORCE + system 分支） |
| CA-39 | 授权、撤权、移出、邀请、分配门店、改名、改订阅都写审计；改订阅不再清空备注和未提交的字段 |
| CA-40 | 分类可以恢复归档；选择器不显示已归档项；重复的 slug 或 code 给出明确错误 |
| CA-44 / CA-45 / CA-47 / CA-48 / CA-50 | 删掉重复渲染的 BatchStrip；孤儿会话修复对已结束的 Run 改为归档；删除确认无引用的死代码；补齐缺失的 i18n 键并替换硬编码文案；登录失败页显示 TG ID |
| 其他 | `grantRole.expiresAt` 校验；`memberUnassignStore` 加 rank 门；`system.log` 单条大小上限；worker 定时清理过期的 refresh token；`report.runCount` 改为去重计数；Run 删除开销需确认；不可取消时隐藏“取消采购单” |

## 已修复：按产品负责人决策实现

| ID | 决策 | 实现 |
|---|---|---|
| CA-03 | 默认只带今天的订单，旧单可以勾选 | 预览按日期分组，今天的默认勾选，旧单高亮并显示天数；可以选择记账日期（不能晚于今天）；“加入”也走同样的选择 |
| CA-04 | 配送中可以开新单 | 迁移 0047：唯一约束只覆盖 planned / purchasing；RunPage 增加多 Run 切换；ConfirmPage 支持多个配送中的 Run |
| CA-06 | 按实收数量入账 | 短缺必须填实收数量，错货和质量问题默认 0；库存按实收入账（旧事件仍按全量）；有问题时通知采购员和店长；RunPage 与历史页显示实收数量 |
| CA-09 / CA-10 | 日结页内录销售；回填权限并去掉兜底 | 日结页增加“今日销售”折叠区；迁移 0048 **只**为内置角色补 3 项权限（manager: sales.record、inventory.adjust；staff: sales.record），不会重新授予管理员手动去掉的其他权限；去掉 `users.manage` 兜底 |
| CA-11 | 商品 + 开销，分开展示 | 新增共享的 `services/runMoney.ts`；history、list、report、结束确认、通知都统一显示“商品 / 开销 / 合计”。冻结的 `actual_total` 仍然只含商品，事件另外记录 itemsTotal 和 expensesTotal |
| CA-40 | 至少一种语言 | SKU、分类的名称至少填一种语言，空的语言不写入，显示时回退到其他语言 |
| CA-42 | 未被认领时可以直接通过 | 审批卡片直接显示“通过 / 驳回 / 认领” |
| CA-20 | 日结功能可以跳过 | 本轮不做 |

## 部署注意事项（行为变化）

- **API 与 web 必须同时部署**：旧客户端提交“短缺”时不带实收数量，会被拒绝；收货、采购的门店范围校验更严格。
- 迁移 0048 会改变生产环境的权限：店员获得 `sales.record`。但店员没有日结 Tab，所以实际上仍然进不了销售入口，见下方待决策 #3。
- 依赖 `users.manage` 来做销售、盘点、报损的**自定义角色**会失去这些能力。
- 财务报表的历史数字会变化：现在包含开销和门店覆盖价。
- 门店“恢复”同时会把已归档（deletedAt）的门店一起恢复。

## 第三轮：授权由我决定的事项（2026-10-21）

产品负责人表示“全都由你自己做”。以下决策都选择了**保守、可回退**的方案：

| 事项 | 决策 | 实现 |
|---|---|---|
| CA-12 ntfy 源站 | 签名而不是换架构 | origin-watch 用 HMAC-SHA256 给发布的地址签名，app-proxy 配置了 `ORIGIN_SIGNING_KEY` 后只接受有效签名（7 天时效，常量时间比较）；不配置时行为不变。上线步骤见 `infra/cloudflare/app-proxy/README.md` 和 RUNBOOK |
| 店员录销售 | 开放 | 有 `sales.record` 但没有 `settlement.record` 的人显示独立的“销售”Tab；有日结权限的人仍在日结页录 |
| 销售作废 | 做 | `sales.void`：必须填原因，权限同录入，冲回库存（`consumption_reversed`），重复作废是幂等的；迁移 0049 |
| CA-17 店长可见范围 | 收窄 | 非 `org.admin` 只能看到自己门店的成员、角色持有人、门店、事件和审计；TG ID 只给 `org.admin` |
| CA-19 邀请 | 列表 + 撤销 | `memberInviteList` / `memberInviteRevoke`；邀请人被停用、移除或失去权限后，邀请失效；迁移 0050 |
| 改名 | 加 rank | `org.admin` 修改他人显示名也需要 rank 更高（super_admin 除外） |
| CA-32 站内通知 | 暂不做收件箱 | worker 每小时清理：通知 90 天、已发送的 outbox 30 天、client_logs 30 天 |
| CA-37 部署 | 先构建后切换 | 前端先构建到 `dist.next`，原子替换后保留 `dist.prev`，最后才重启 API |
| CA-27 / CA-25 / CA-43 | 做 | 只含 extras 的订单可以提交；离线修改冻结日期，过期的不再创建草稿；审批会比对版本，订单已被他人修改时拒绝并刷新 |
| CA-54 / CA-55 | 做 | 库存行可以查看最近流水；可以为没有记录的 SKU 建期初盘点；菜品保存改为单事务，拒绝重复原料 |
| 币种 | 跟随组织币种 | 采购相关文案中写死的 UZS 改为 `{currency}`（还有 3 个没有调用方的旧键保留未改） |
| CA-20 日结 | 不做 | 按产品负责人的指示，本轮跳过 |
| 截单时间、店长确认收货、审批自己的订单 | 维持现状 | 这些是业务规则，没有证据表明当前做法有错，改动风险大于收益 |

第三轮之后的本地验证：tsc 12/12 通过；lint 通过；单测 **525 pass / 0 fail / 164 skip**（PG）；i18n 四语各 1434 键；迁移 journal 51/51；构建通过。CI 的 web 单测范围已扩大到整个 `apps/web/src`。

## 仍需运维处理（无法在代码中完成）

1. **合并与部署**：审阅并合并 PR #56；API 与 web 同时部署。
2. **CA-12 上线**：生成密钥，写入服务器的 `/home/ubuntu/.config/compass-origin.key`，再执行 `wrangler secret put ORIGIN_SIGNING_KEY` 和 `wrangler deploy`。
3. **生产环境核查**：连库角色是否 BYPASSRLS；`FRONTEND_URL` 是否为 https；经 workers.dev 的 WebSocket 能否握手；备份是否真实产出。
4. **Telegram 真机验证**：Sheet 返回键、深链落点、多 Run 切换。
5. **部署注意**：API 与 web 必须同时部署；迁移 0047–0050 只做加法，没有破坏性变更。
6. bot 的 systemd 部署（CA-53）：生产服务器出口访问不了 Telegram，需要运维决定是否改用 webhook，经 Worker 中转。

## 仍未做（低优先级）

- 日结相关（CA-20、purge 日结修订）——按指示跳过
- CA-49 精度问题、CA-41 拆分 `admin.ts` / `run.ts`、CA-38 指标与告警
- 归档 SKU 时检查配方引用（D-15）；3 个没有调用方的旧 UZS 文案键
