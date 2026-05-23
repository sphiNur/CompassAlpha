# CompassAlpha 项目深度分析报告

> **日期**: 2026-05-20
> **版本**: 1.0
> **状态**: 业务逻辑与架构全景审计

## 1. 项目概览

**CompassAlpha** 是一个专为多门店餐饮连锁设计的采购协同系统，以 Telegram Mini App (TMA) 为核心载体，辅以桌面 PWA 形态。该系统是对前代 CompassBeta 的完全重写，旨在解决复杂的多人、多门店采购场景中的数据一致性、实时响应、离线操作及财务对账问题。

### 核心定位
- **下一代采购协同**：基于事件溯源 (Event Sourcing) 的闭环业务流。
- **高性能架构**：Bun + Hono + tRPC + Drizzle + React。
- **多语言原生支持**：zh/ru/uz/en 实时切换，适配中亚及跨国运营环境。
- **极简 UX**：针对移动端优化，支持快速连击、离线排队及触感反馈。

---

## 2. 业务流程与逻辑闭环 (Business Closed-Loop)

系统通过严格的状态机驱动，确保了从需求产生到财务结算的全链路闭环。

### 2.1 采购生命周期
1. **订单草拟 (Drafting)**:
   - 各门店 Staff 提交当日需求。
   - **逻辑特性**：支持同一门店多人协作提交，系统自动聚合 Totals。
2. **审批流水线 (Approval Pipeline)**:
   - Manager 对提交的订单进行 Claim (锁定) -> Approve/Reject。
   - **逻辑闭环**：只有 Approved 的订单才能进入采购环节；在进入 Run 之前支持 Unapprove 回滚。
3. **市场跑趟规划 (Market Run Planning)**:
   - Purchaser 根据所有已审批订单创建 Run (趟次)。
   - **决策支持**：支持按日、按趟次 (RunIndex) 灵活组织。
4. **市场采购 (Purchasing)**:
   - 采购员在市场实时操作：Buy (买入) / N/A (缺货)。
   - **多门店拆分**：支持单次大宗买入后，按需拆分 (Split) 到不同门店。
   - **价格情报**：系统自动记录 `price_history`，为后续供应商评估提供数据支持。
5. **配送与签收 (Delivery & Confirmation)**:
   - Purchaser 点击 Deliver 触发门店通知。
   - 店端进行确认 (Confirm)：支持 `ok`, `short`, `wrong`, `quality` 等状态标记，实现损耗跟踪。
6. **归档与结算 (Finalization)**:
   - Run Finished 后，关联的订单自动 Archived，进入财务对账阶段。

### 2.2 核心逻辑闭环 (Logic Loops)
- **并发控制闭环**：通过 `(streamId, seq)` 唯一约束，确保在多人同时操作同一订单时，逻辑不会产生冲突或覆盖。
- **状态回溯闭环**：事件溯源确保了每一笔订单、每一次采购都有完整的 Audit Log。支持“时间旅行”式的问题排查。
- **多租户闭环**：PostgreSQL RLS (Row-Level Security) 在数据库层面强制隔离 Org，代码层面的 Bug 无法导致数据越权。

---

## 3. 前端流程与技术细节 (Frontend Architecture)

前端基于 React 18 与 Vite 构建，深度集成 Telegram WebApp 环境。

### 3.1 实时同步与性能优化
- **WebSocket 主驱动**：`/ws` 通道实时推送状态变更，配合 TanStack Query 的 `invalidate` 实现近乎零延迟的 UI 刷新。
- **Optimistic Adjust (乐观调整)**：
  - 在 Order 页面，点击 +/- 立即更新本地缓存。
  - **抗延迟方案**：采用按 (StoreId, SKUId) 的 200ms 防抖及按 StoreId 的串行化提交，彻底解决了在高延迟网络环境下“数值回弹”的问题。
- **离线排队 (Offline Queue)**：
  - 网络断开时，所有写操作进入 IndexedDB Outbox。
  - 网络恢复后按序重放，配合服务端幂等键 (Idempotency Key) 确保不重复提交。

### 3.2 UI/UX 设计系统: Concord
- **双主题支持**：Native (适配 Telegram) 与 Apple (高对比度/精致感) 主题。
- **触控交互优化**：
  - `QtyControl`: 支持长按加速，满足快速录入需求。
  - `Sheet` 管理：自动接管 Telegram BackButton，提供符合原生系统的层级导航感。
  - `Haptic`: 关键节点提供物理震动反馈。
- **财务友好**：针对 UZS (乌兹别克斯坦苏姆) 大额面值设计的“千位输入模式”，极大提升了采购员的录入效率。

---

## 4. 逻辑闭环与安全性审计

### 4.1 安全模型
- **身份鉴权**：基于 Telegram initData 的 HMAC 强校验。
- **令牌管理**：Refresh Token 家族机制 + 重放检测，提供金融级的会话安全。
- **权限模型**：RBAC + Member-level Overrides，支持精细到“某人在某门店”的权限控制。

### 4.2 业务鲁棒性
- **幂等性保障**：所有写操作必须携带 `X-Idempotency-Key`，由后端中间件自动处理 24 小时内的重复请求。
- **原子性提交**：Run 规划、采购拆分等复杂操作均在单一事务中完成，确保状态一致。
- **容错处理**：针对 CN 等特殊网络环境，自研 Telegram 通道中继 (CF Worker)，确保通知触达。

---

## 5. 现状评估与未来方向 (Roadmap)

### 优势 (Current Strengths)
- **极高的技术完整度**：从事件驱动到 RLS 隔离，架构设计领先于常规企业应用。
- **极佳的用户体验**：针对 Telegram 弱网、单手操作场景做了深度专项优化。
- **可观测性基础**： traceId 贯通全链路。

### 改进建议 (Future Focus)
- **PWA 完全体 (M2)**：引入 Service Worker 实现完整的资源缓存。
- **可观测性升级**：正式接入 OpenTelemetry SDK 以支持更复杂的性能分析。
- **自动化测试补齐**：目前 E2E 覆盖了核心流程，但 Bot 与 Worker 的单元测试仍有缺口。

---

**报告撰写人**: Gemini CLI (Engineering Agent)
**归档路径**: `./COMPASS_ALPHA_ANALYSIS.md`
