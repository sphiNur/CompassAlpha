# CompassAlpha 采购（Run）页面 — 分析与落地方案

> 日期：2026-07-26
> 代码基准：worktree `bold-sanderson-dede9c`，分支 `claude/procurement-page-optimization-5395f3`，与 `main` 完全一致（`git rev-list --left-right --count main...HEAD` = `0 0`）。
> 下文所有 `file:line` 均在该树（= main）上实测。
> 术语：**店铺** = 下单的门店；**摊位** = 采购点（供应商/档口）。

---

## 1. 项目现状

CompassAlpha 是给餐厅/店铺做**集中代采**的 Telegram Mini App：
几家店铺下单 → 审核 → 生成一次采购（run）→ 采购员在巴扎逐个摊位买货记价 → 送货到店 → 店铺确认 → 结算分摊。

架构：

- monorepo：`apps/{api,web,bot,worker}` + `packages/{db,domain,contracts,ui,i18n,cli,telemetry}`，pnpm + turbo。
- 后端 Hono + tRPC，**事件溯源**：`domain.events`（`stream_id`+`seq` 唯一约束就是并发锁），投影进 `read_model.*`。
- `packages/domain/src/run/commands.ts` 是唯一的权限与不变量执行点；tRPC 过程本身只做 `authedProcedure` + 门店范围检查。
- 读模型：`market_runs_v` / `run_items_v`(PK run+sku) / `run_item_stores_v`(PK run+sku+store，含迁移 0033 的按店价格与支付方式覆写) / `run_expenses_v`。
- 前端 React SPA，**没有 router**；`apps/web/src/app/Shell.tsx` 用 5 个 Tab 联合类型切页；采购 Tab 由权限 `run.purchase` 把守（`Shell.tsx:53`）。
- 实时：websocket 只发粗粒度 `run.changed`，前端整个 `[['run']]` key 失效；另有 6 秒轮询（`RunPage.tsx:569`）。
- 离线：IndexedDB outbox，只注册了 5 个过程（`RunPage.tsx:275/295/347/373/412`）。
- i18n：zh/en/ru/uz 四本目录，纯字面量对象，无类型约束。

**Run 页面的诚实状态**：`RunPage.tsx` 2138 行 + `apps/web/src/pages/runs/*` 5357 行 = **7495 行**，比拆分前的 7436 行单体**还多**。复杂度只是搬了家，没有减少，并且没有任何测试守住行为。

---

## 2. 分支与部署差异

### 2.1 实测事实

| 位置 | 分支 | 相对 main |
|---|---|---|
| `C:/Users/nur/Desktop/CompassAlpha`（**主开发目录 = 部署来源**） | `codex/procurement-collaboration-history-expenses` | **落后 59，领先 1** |
| `.claude/worktrees/bold-sanderson-dede9c` | `claude/procurement-page-optimization-5395f3` | 0 / 0 |
| GitHub `main` | — | 权威 |

```
git rev-list --left-right --count main...codex/procurement-collaboration-history-expenses
59      1
```

左 = 只在 main 上的 59 个提交；右 = 只在 codex 上的 1 个提交。
codex HEAD `6db0cf7` 的父提交就是合并基 `5b510a8`。

codex 唯一独有的提交：`6db0cf7 "wip: auth + login work in progress"`，9 个文件 / +731 −61，只碰 auth，**从未碰 RunPage**：

```
.env.example                                 |   9 +-
apps/api/src/__tests__/refreshTokens.test.ts |  36 +-
apps/api/src/__tests__/rls-isolation.test.ts |  55 +-
apps/api/src/trpc/routers/auth.ts            | 276 +-
apps/web/.env.example                        |   4 +-
apps/web/src/app/AuthGate.tsx                | 312 +-
apps/web/src/stores/authStore.ts             |  17 +-
scripts/browser-smoke-deep.ts                |  29 +
scripts/browser-smoke.ts                     |  54 +-
```

**合并是干净的**：`git merge-tree --write-tree main codex/...` 退出码 0，零冲突。codex 改的 9 个文件在 main 上全部与合并基逐字节相同——纯单边合并。迁移是超集（main = codex + `0034_run_amend_permission.sql`），无编号分叉。

其余 10 个本地分支（`ui-declutter`、`ui-declutter-3`、`integration/p0-ui-onto-procurement`、全部 `claude/*`）`git rev-list --count main..<branch>` 全部 = **0**，都是 main 的祖先，没有任何可抢救的独有提交。`claude/price-data-auto-fill-b96c13` 的 sha 就等于 main，是个空分支。

**结论**：main 是唯一权威且最完整的分支。没有任何东西丢在别的分支上。

### 2.2 部署管线的风险（最危险的一节）

`scripts/deploy.ts` 是 tar 本地工作目录 → scp → 服务器解压 → 重启 systemd → 重新 vite build。**不走 git，不走 GitHub。**

- `:129` **打包的是工作目录，不是 git ref**，脚本内无 clean-tree 检查。未提交、未推送的改动会直接上生产。
- `:135` `tar xzf ... --strip-components=1`，**原地覆盖、不带 `--delete`**。仓库里删掉的文件在服务器上永远留存。来回部署不同分支会在服务器上留下两棵树的并集（例如既有 `RunPage.tsx` 单体又有 `pages/runs/*`）。
- `:91` `releaseSha = git rev-parse HEAD`（本机 HEAD），流进 `VITE_BUILD_SHA` 和 `/health/version`。**版本号只是开发机上的一个标签，不是来源保证。**
- `:160` `pnpm --filter @compass/db migrate` 只前滚，无回滚路径。
- `:103-128` 的排除列表里**没有 `.git`（9.7 MB）也没有 `.claude`（222 MB）**。node_modules 的排除项锚定在 `CompassAlpha/apps/*`，匹配不到 `.claude/worktrees/*/apps/*`。实测 `.claude/worktrees/exciting-hodgkin-4b72af` 单目录 **206 MB**（含自己的 node_modules），每次部署都被 scp 到生产机。
- `.github/workflows/ci.yml:33-37` 只在 `push: [main]` / `pull_request: [main]` 触发。功能分支零门禁，且没有 deploy workflow——CI 绿不绿跟生产上跑什么毫无关系。

**如果今天从主开发目录跑 `deploy.ts`**：会把落后 59 个提交的旧代码推上生产、把 main 的 `runs/*` 树孤儿化留在磁盘上、并让数据库（已应用 0034）领先于代码，且无回滚。

### 2.3 服务器实际状态

无法从本会话确认——`COMPASS_DEPLOY_HOST` 未设置，`deploy.ts:54` 里的 `compass-pro.com` 只是注释示例（实测是无关第三方站点）。自查命令：

```bash
ssh -i ~/.ssh/compass_alpha.pem $COMPASS_DEPLOY_HOST "cd /home/ubuntu/compass-alpha && cat apps/web/dist/build-id.txt && wc -l apps/web/src/pages/RunPage.tsx && ls apps/web/src/pages/runs 2>/dev/null || echo 'NO runs/ dir'"
```

`RunPage.tsx` = 2138 行且有 `runs/` 目录 → 服务器是 main 系。
7436 行且无 `runs/` → 服务器是旧代码。
两者都有 → 磁盘上已经是两棵树的并集（`--strip-components=1` 无 `--delete` 的后果）。

### 2.4 推荐的和解顺序

1. `git checkout main && git merge codex/procurement-collaboration-history-expenses` —— merge-tree 已证明零冲突。**开 PR**，让 CI 的 PG 集成任务真跑一遍 codex 改过的 `refreshTokens.test.ts` / `rls-isolation.test.ts`（这两个文件从没被 CI 跑过）。auth 那段自称 `wip`，git 会静默合并，**运行时必须人工验证登录流程**。
2. 主开发目录切到 `main`。**在切走之前一次都不要跑 `deploy.ts`。**
3. 删掉 10 个已被 main 完全包含的分支；删掉 `.claude/worktrees/exciting-hodgkin-4b72af`（206 MB）与 `heuristic-solomon-432ee8` 两个已不在 `git worktree list` 里的孤儿目录。
4. 加固 `deploy.ts`：加 `--exclude=CompassAlpha/.git`、`--exclude=CompassAlpha/.claude`；工作树不干净或 HEAD 不在 main 时拒绝执行；`releaseSha` 从已推送的远程 ref 取；**新增飞行前检查：`market_runs_v` 里存在 `purchasing`/`delivering` 状态的 run 时中止部署**（采购员正在巴扎里，换掉半个前端是数据完整性事故）。
5. CI 触发条件放宽到 `push: ['**']`。
6. 之后所有代码一律基于 main 开功能分支、走 PR 合回 main。

---

## 3. Run 页面诊断（按严重度）

**P0 — 部署管线会吃掉这次改造。** 见第 2 节。

**P0 — 计划页完全只读，采购员看得见整张单子却记不了一分钱价格。**
三处独立强制：契约层每个写操作都要 `runId`（`packages/contracts/src/schemas/run.ts:76-79`）；领域层 `PurchaseItem` 对不在 `state.items` 里的 SKU 抛 `run.errors.itemNotInRun`；UI 层唯一带价格输入的 `PurchaseRow` 只从 `ActiveRunPanel` 挂载。结构性的，不是漏做。

**P0 — 结算把短交/错货当作没发生。**
`StoreItemConfirmed{status:'short'}` 被投影写进 `run_item_stores_v.confirm_status`（`apps/api/src/services/runProjection.ts:212`），然后**没有任何消费方**——投影自己的注释承认了（`runProjection.ts:246`："status='short') are NOT yet honored in the delta"）。`settleItemLine`（`apps/web/src/pages/runs/lib/settlement.ts:51`）只读 qty 与 unitPrice。同时 `apps/web/src/pages/ConfirmPage.tsx` 里 `formatMoney|currency` 命中数 = **0**——店铺在看不到金额的情况下签收，报了短缺进了黑洞，然后被按全额计费、库存按全额入账。**这是穿着 UX 外衣的钱账错误。**

**P1 — 实际采购时的默认视图是没有任何分组的一整面墙。**
`viewMode` 默认 `'aggregate'`（`RunPanels.tsx:205`）；按摊位 chip 只在 `distinctSupplierCount >= 2` 时渲染（`:255`）；再点一次已选中的 chip 会**退回 aggregate**（`:294`）。默认屏是 `run.items.map`，无排序、无折叠、已买/缺货的行也不消失。

**P1 — 行序不稳定，会在手指底下重排。**
`run.get` 查 `runItemsV.findMany` **没有 orderBy**（`apps/api/src/trpc/routers/run.ts:1218`），Postgres 返回堆顺序，每次 UPDATE 后 MVCC 把新元组写到堆尾；叠加 6 秒轮询（`RunPage.tsx:569`）。每保存一行，整张列表可能重排一次。

**P1 — 摊位归属是假的。**
行内保存硬编码 `supplierId: null`（`RunPage.tsx:1611`，另见 `:1428/:1688/:1713/:1742`），投影原样写进 `price_history.supplier_id`。所以"上次在这个摊位多少钱"在数据上不可能实现；按摊位分桶用的是**全局首选链接**（`is_preferred`），不是实际购买地点。

**P2 — 整体视图无信息量且是默认落地页。**
`RunPanels.tsx:1129` `preview.plannedItems.slice(0, 8)`，每行两个 span：名称 + `formatQty(qty) {sku?.unit}`。无价格、无合计、无店铺、无摊位、无排序、无点击、无溢出提示（`:1124-1127` 注释记录了 M1.11 故意删掉 "+N more"）。默认就是 `'overall'`（`:687-691`）。它还打印**原始单位码**（`:1135`），同一个商品在这里读作 "kg"、在按店铺读作 "公斤"（`currentUnitLabel`，`:1005`）。

**P2 — 折叠状态与需求正好相反。**
`RunPanels.tsx:694` `useState<Record<string,boolean>>({})` + `:1009` `collapsedGroups[key] === true` → 初始全部**展开**；`:1010` 独立翻转每个 key → 可以同时开无限个。

**P2 — 价格输入永远占屏，且键盘是死路。**
`RunViews.tsx:1005-1006` 价格已从 `item.unitPrice ?? lastPrice` 预填，`:1144` `canSave` 已为真——输入框对绝大多数行纯属噪音。qty 输入有 `step={step}`（`:1271`），价格输入**没有**（`:1278`）；无 `enterKeyHint`、无 Enter 处理、无 autoFocus、无 select-on-focus；✓ 按钮 `h-8 min-w-8`（`:1316/:1331`）≈32px，低于 44px 触控标准。

**P2 — 供应商语言的复制功能已被重构杀死。**
`apps/web/src/hooks/useI18n.ts:193 useVendorName` 和 `:224 useVendorUnitLabel` 完整实现、**零调用点**（全仓只剩 `SettingsSheet.tsx:85` 一条注释）。`RunPanels.tsx:975-976` 的 `formatLineForText` 用本地 `currentSkuName`/`currentUnitLabel`，只看操作者 locale。**点"发送"给乌兹别克摊主，粘过去的是中文品名。** 这是 M3.45/M3.48 两个里程碑 + 迁移 `0031_user_secondary_locale.sql` + 设置界面 + 20 个 i18n key 的成果，被 `c910718 "refactor: simplify procurement preview layout"` 静默还原——没有一个测试报警。

**P3 — 一批已知未修的洞：**
`run.startDelivery` 领域层**不检查任何权限**（`packages/domain/src/run/commands.ts:489-503`）；`report.purchaseLines` 忽略 0033 的按店价格覆写，财务报表与 run 页会对不上；`sku_supplier_links.default_price/last_seen_price` 是**死列**（唯一写入方 `run.ts:566-587` 从不写），所以 `estimatedUnitPrice` 生产环境恒为 null；`prices.view` 权限在 `packages/db/src/seed-data.ts:36/120/158` 声明并授予，全仓**零执行点**。

---

## 4. 逐条回应

### Q4 — 按摊位手风琴（全部收起、单开、再点关闭）

**结论**：做，严格单开。**但必须同批把"实际采购时的默认视图"定成按摊位，并加 SKU 名称过滤条**——否则你会给一个默认根本打不开的视图做一个精致的手风琴。

**为什么**

- 需求本身对：采购员物理上站在一个摊位前，这是一条行走路线，不是对照表。
- 但目标屏幕选错了。`RunPanels.tsx:205` 默认 `'aggregate'`；`:255` 少于 2 个摊位时按摊位 chip 根本不渲染；`:294` 再点一次会退回 aggregate。
- 严格单开 + **全站没有任何搜索/过滤**（`RunViews.tsx`/`RunPanels.tsx` 里 grep search/filter 只命中 memo 里的数组 `.filter()`），会让巴扎里最常见的事件变得无解：这个摊位没货，三个摊位之后买到了——那一行被藏在另一个收起的面板里，而且分桶用的是**计划中的**首选摊位。今天全展开还能滚动扫名字，改完就扫不了了。
- 折叠头必须能干活。今天是 `run.label.skuCountAndQty`（"{n} 个 SKU · {qty}"），采购过程中这个数字**从不变化**，收起后等于没信息。

**怎么做**

1. 新建 `apps/web/src/pages/runs/lib/accordion.ts`：`useSingleOpenAccordion({storageKey, keys})`，状态 `useState<string|null>(null)`（**全部收起**），`toggle(k) = setOpenKey(c => c===k ? null : k)`。keys 变化时把失效的 openKey 剪成 null。按 runId 分键持久化到 localStorage。纯 reducer，配 `runs/lib/__tests__/accordion.test.ts`（与现有 `priceMath.test.ts`/`settlement.test.ts` 同形）。
2. 替换 `RunPanels.tsx:694` `collapsedGroups`、`:1009` `isCollapsed`、`:1010` `toggleGroup`。按店铺与按摊位**共用**这份状态（key 前缀 `store:` / `supplier:`），所以必须**实例化两次、两个 storageKey**，否则会把 `store:` 的 key 泄漏进摊位视图。当前视图只有 1 个分组时视为常开。
3. `viewMode` 默认改成：`showPerVendor` 为真时持久化默认 `'perVendor'`，并**移除 `:294` 的"再点一次退回 aggregate"**。
4. 折叠头重写（`RunViews.tsx:312-325`）：第一行 `🛒 名称` + 右对齐 `计划 3/7`；第二行 `已花 {money}` + 待办数 + 缺货数（danger 色）+ 摊主 @tg/电话。
   **进度标签写"计划 x/y"，不写裸 ✓**——桶是按 `run.supplierBySku[skuId]`（首选链接，`RunViews.tsx:287-289`）分的，而实际购买写 `supplierId: null`（`RunPage.tsx:1611`），绿勾会撒谎。
5. 金额累加**必须在累加器处防空**：先 `if (!item.unitPrice || !item.purchasedQty) continue;` 再调 `settleItemLine`。原因：`settlement.ts:64` 的非覆写分支是裸的 `Number(item.unitPrice) * Number(item.purchasedQty)`，**没有空值保护**（有保护的是 `splitSubtotal`，`:35`），而 `types.ts` 里 `unitPrice: string | null`，一个 NaN 会毒掉整个摊位头。同时 `RunViews.tsx:295-300` 的 buckets memo 目前只带 `{skuId, plannedQty, status}`，得先把 unitPrice/purchasedQty 带进来。
6. 收起的面板用 CSS `hidden`，**绝不卸载**——`PurchaseRow` 自己持有 qty/price 局部状态（`RunViews.tsx:999-1006`），卸载会静默删掉采购员刚敲进去但没点 ✓ 的价格。
7. 滚动增量钉住：点击处理器里先记 `headerEl.getBoundingClientRect().top`，`useLayoutEffect` 里再测一次，差值加到滚动容器的 `scrollTop`。容器是 `Shell.tsx` 的 `<main class="min-h-0 flex-1 overflow-y-auto">`，用 `getScrollParent` 向上走 `overflowY` 找。**不要用 `scrollIntoView`**（会跟 sticky header 打架，且 Telegram 模式下 header 变成静态占位）。
8. 头部标记结构修正：今天是 `role="button" tabIndex={0}` 的 div **里面套着真 `<button>`**（发送按钮），无效嵌套 + 读屏陷阱。改成 flex 行：第一个子元素是真 `<button aria-expanded aria-controls>`，发送按钮作**兄弟节点**（于是可以删掉 `e.stopPropagation()`）。`+`/`-` 字形换成箭头，用已存在但从未被引用的 `run.preview.expand` / `run.preview.collapse`。
9. **同批加一条置顶的 SKU 名称过滤条**，外加一个常开的"还没买到"伪桶（所有 unavailable + 计划摊位已关闭仍 pending 的行）。
10. 顺手把摊位来源做实：`RunViews.tsx:407` 的 `onSave={onSavePurchaseInline}` 改成 `onSave={(p) => onSavePurchaseInline({...p, supplierId: b.supplierId})}`，`RunPage.tsx:1611` 转发而不是硬编码 null。契约已允许（`packages/contracts/src/schemas/run.ts:76` `supplierId: UuidSchema.nullable()`），**零后端改动**。这是 Q7"只问变了的价格"唯一缺的输入。

**风险**

- 不是性能优化。CSS 隐藏意味着所有 `PurchaseRow` 仍挂载，6 秒轮询仍全量重渲染，再加上新的摊位统计会多跑一遍金额。整棵 run 树里没有一个 `memo(`——真卡了就上 `React.memo`，**不要**改成卸载面板。
- 收起带焦点的价格输入会触发 blur、掉 Telegram 数字键盘。值还在（所以不卸载），但看不见——所以"未保存草稿"小标记（`✎ n`）是必需的第二阶段，不是可选项。
- 按摊位视图在只有 1 个摊位的 run 里整个不渲染（`:255`），所以进度/金额**不能只存在于摊位头上**。

---

### Q5 — 按店铺视图要显示每项的摊位和价格

**结论**：做，**扁平列表 + 摊位标签 + 两行行式**，不要嵌套三级。但先回答一个问题：你说的是**计划页**的按店铺，还是**采购中**的按店铺？两者是完全不同的两块代码。

**为什么**

- **计划页（`PreviewSummaryCard`）**：价格**已经在渲染**了——`RunPanels.tsx:913-920` 的 `lineFormula` 输出 `qty unit * price = total`，`:1054` 调用。缺的只有摊位名。而 `preview.supplierBySku` **已经是 props**，按摊位分组的 memo 在 `:870/:882` 已在读它。**这一半是纯渲染改动，零 API 改动。**
- **采购中（`PerStoreView`）**：`RunViews.tsx:155-178` 每行只有状态字形（·/✓/✗）+ SKU 名 + `formatQty(r.qty) {r.sku?.unit ?? ''}`。**没有价格、没有摊位、原始单位码、完全只读、没有任何折叠。** 如果你抱怨的是"边买边看的那个屏幕"，这个提案原样落地不解决任何问题。
- 有一个**真 bug 必须先修**：`RunPage.tsx:1563-1582` 那个把 `run.get` 塞进预览 props 的适配器，**没有传 `lastPurchasePriceBySku`**。而回退链第二级 `supplierBySku[].estimatedUnitPrice` = `default_price ?? last_seen_price` 是死列。所以 run 处于 `planned` 状态时，按店铺**每一行都显示"待询价"**。Q5 的"价格必须显示"在那块屏幕上今天是 100% 不满足的。
- 不做嵌套：嵌套 store→摊位→item 就是按摊位（摊位→store→item，`RunPanels.tsx:1294-1319`）的转置，两个三级视图看同一份数据——正是让整体视图变废的那种冗余。在 ~312px 内容宽度下每个子标题约 28px，8 个摊位的 30 行店铺光装饰就烧 ~224px。而"这个摊位在这家店的小计"在 `:1300` **已经有了**。按 (摊位, 名称) 排序能免费得到同样的视觉聚类。

**怎么做**

1. **先修**：`RunPage.tsx:1563-1582` 适配器加一行 `lastPurchasePriceBySku: runDetailQuery.data.lastPriceBySku ?? {}`。`run.get` 已经算好并返回（`apps/api/src/trpc/routers/run.ts:1439/1499`），前端类型也已声明。
2. `PreviewLine` 类型（`RunPanels.tsx:590-600`）加 `supplierId` / `supplierName`；在 byStore memo（`:764-797`）里解析一次，然后让 bySupplier memo（`:864-867`）改读 `line.supplierId`——**一个解析点，不是两个**。
3. 每个店铺内部排序（`:805-817` 之后加 `g.items.sort()`）：sku 在 extra 前 → `supplierName` localeCompare（**null 桶钉最后**）→ 名称。这同时修掉一个真缺陷：`perStoreDemand` 来自无 orderBy 的 `orderItemsV.findMany`，今天的行序是堆顺序。
4. `renderLine`（`:1019-1065`）改两行式，用新的 `opts.showSupplier` 门控（按摊位在 `:1305` 也调它，不门控会把那个视图一起改掉）：
   - 第 1 行：`[extras徽章] [名称 flex-1 truncate] ....... [行小计 shrink-0 font-mono 半粗]`
   - 第 2 行：`[🛒 摊位名 truncate max-w-[45%]] · [qty unit × 单价 shrink-0 font-mono 弱化]`
   - 规则：**只有品名和摊位名可以截断，任何数字都是 `shrink-0` 永不截断**。参照已存在的同形实现 `apps/web/src/pages/runs/history/RunHistory.tsx:794-846`。
5. 空态：无价 → 右槽渲染 `run.preview.priceUnknown`（待询价）warning 色；无摊位 → `❓ run.previewSupplier.unassigned` warning 色。摊位渲染成**弱化文本，不是可点药丸**——`run.setSkuPreferredSupplier`（`run.ts:566-586`）是全 SKU 全局的，点一下门店 A 的番茄会静默改掉门店 B 和 C 的。
6. Q4 的手风琴（共享状态）必须**同批上线**——两行行式让列表高度翻倍，是折叠在为它买单。
7. **分享文本**（最高价值的一步，因为这是店铺经理唯一能看到这些数据的通道；Run tab 由 `run.purchase` 把守，`Shell.tsx:53`，店铺经理永远打不开这个页面）：`formatLineForText`（`:973-981`）加 `opts?: {withPrice, withSupplier}`，`buildStoreText`（`:983-990`）两个都传 true 并追加小计页脚。**`buildSupplierText`（`:992-1002`）两个都不传。**
8. **`buildSupplierText` 今天已经在泄漏**：`:994-996` 把每个 `store.storeName` 当段标题推进去——粘给摊主的消息里已经列举了你所有店铺的名字。顺手改成默认按摊位合并数量的扁平清单（这也是摊主真正想要的）。
9. 价格涨跌 delta **不放在预览里**（预览显示的价格本身就是 `lastPurchasePriceBySku`，跟自己比毫无意义）。放到 `PurchaseRow`：`item.unitPrice` vs `run.lastPriceBySku[skuId]`，两者都已在线上。单独一张票。

**风险**

- **第 7 步是披露决策，不是技术决策**，而且比看上去更硬：`shareOrCopyText`（`RunPanels.tsx:943-971`）是**先写剪贴板再打开 Telegram 会话选择器**。带价的店铺清单会躺在剪贴板上，而采购员离误点到任意会话（包括他从同一屏用的摊主会话）只有一次误触。如果价格要进店铺消息，那条消息必须走**独立发送路径**（明确目标会话、不写剪贴板、发送前一行预览）。
- 相关：`prices.view` 权限在 `seed-data.ts:36/120/158` 声明并授予 manager/purchaser，**staff 没有**，而全仓零执行点。要么把带价变体门控在它上面（并真的执行），要么删掉这个 key。
- 采购中的 `PerStoreView` 如果也要，那是另一份更大的工作（加价格、加摊位、加折叠、顺手修 `RunViews.tsx:174` 的原始单位码泄漏）。

---

### Q6 — 整体视图还需要吗

**结论**：**删掉这个 tab，降到两个**（按店铺 / 按摊位），把"预估合计 + 例外条"提升成**永远可见的头部**。但默认视图用**自适应**规则，不要写死 `bySupplier`。

**为什么**

- 它展示的每一个数字都是按店铺的**严格子集**：`RunPanels.tsx:1129-1140` 就是 8 行截断的 `名称 + 数量`。按店铺同样的 SKU 拆到店铺，同样的数量，外加单价、行小计、每店合计、无参考价计数、其他物品、发送按钮。
- 它还是默认落地页（`:687-691`）——每个新用户第一眼看到的是三个视图里信息量最低的那个。
- 值得建的东西**与分组方式无关**，所以不能藏在 tab 后面。合计和例外数是关于整张单子的事实，不是第三种切法。现成先例就在旁边：分店预算块（`:1100-1121`）只门控 `preview.perStoreBudgets?.length`，**不门控 view**，故意渲染在三个视图之上。
- 团队已做过一次同样的实验并成功：`RunPanels.tsx:267-276` 的注释记录了 M3.28 砍掉采购态 aggregate chip 的理由——"聚合视图是编辑面，不是用户会想切进去的'视图'"。
- **但不能写死默认 `bySupplier`**：按摊位完全依赖 `preview.supplierBySku`，服务端只从 `inventory.sku_supplier_links WHERE is_preferred = true` 构建（`run.ts:341`），而该表全仓**唯一写入方**是 `run.setSkuPreferredSupplier`（`run.ts:566-586`）——一次手工指派一个 SKU，入口还只在按摊位视图里点 SKU 名（`RunPanels.tsx:1305`）。新目录或没手工配过的组织，按摊位会塌成一个"未指定摊位"大桶。那比 8 行清单更糟，而且同批还把退路 tab 删了。

**怎么做**

1. `PreviewView` 类型去掉 `'overall'`；`:687-691` 初始化器改自适应：`已指派SKU数 / 总SKU数 >= 0.5 ? 'bySupplier' : 'byStore'`。localStorage 白名单本来就只认 `byStore|bySupplier`（`:690`），存量 `'overall'` 自动落到新默认，**零迁移代码**。
2. 分段控件数组缩到两项（`:1077-1097`），删掉 `:1123-1141` 整块。
3. **四本 i18n 目录同时**删 `run.previewView.overall`（en.ts:594、zh.ts:487、ru.ts:524、uz.ts:538）——CI 用 `grep -cE "^  '[a-z]"` 逐本比 key 数（现在四本都是 901），漏一本直接失败。
4. 分店预算块（`:1100-1121`）换成汇总头。合计与无参考价计数**从客户端 byStore memo 派生**，不要用服务端 `perStoreBudgets`：后者只来自 `order_items_v`，看不见 `extrasJson`，而客户端 `addPreviewLine` 会把 extras 计入未知——两个数字今天就能对同一家店给出不同答案。原每店行保留成可折叠明细。
5. **标成覆盖率，不是现金数。** 服务端（`run.ts:449-455` 的 `continue`）和客户端都把无价行整条剔出求和，所以这个数系统性偏低；而且运费/搬运/市场费这些 run expense **在预览阶段根本不存在**（只在 `RunPage.tsx:654-663` 的 finishSummary 里汇总）。写成 `已知 {n}/{total} 项 · 至少 {money}`，**绝不写 `≈`**，更不要让人当成"该带多少现金"。
6. 例外条：两枚可点的 chip —— `无摊位 {n}` / `无参考价 {n}`。点"无摊位"切到按摊位并展开未指定桶。修复路径（VendorPickerSheet → `run.setSkuPreferredSupplier` → 失效预览）已经存在，只是今天没人知道要去点 SKU 名。**这一条要在切换默认视图之前上线**，让指派路径先变得可发现。
7. Δ 对比上一次采购：**不要从 `run.list` 取基线**。`run.ts:942-947` 是先 SQL `.limit(50)` 再在 JS 里按门店范围过滤（`:963-970`），单店经理在多店组织里可能 50 行全是别人的店；而且每行的 `actualTotal` 是**组织级**总额（`:1046` 展开 `...run`），只有 `storeTotals` 是按范围裁过的。改用 `run.history`（已过滤 `finished`）或加一个在 SQL 里裁范围的小查询。取不到基线就整块不渲染。
8. **先修 `RunPage.tsx:1563-1582` 适配器**（同 Q5 第 1 步），否则 `planned` 状态下新合计读作 0。
9. 唯一真正丢掉的能力（跨店铺汇总同一 SKU 的数量，"苹果 12kg"而不是"A店5kg/B店7kg"）搬进按摊位，做成**每摊位的 SKU 汇总行 + 按店明细**（`:1294-1319`）。这个需求只在你站在某个摊位前时才成立。
10. 新头部用 `<SectionLabel>`，不要手搓 class 字符串——CI 有排版守卫（`.github/workflows/ci.yml:110-158`）会 grep 那串精确的 eyebrow class 并失败。

**风险**

- 例外条在真实数据上可能极其吵：`estimatedUnitPrice` 恒为 null，整个价格估算只靠 `price_history`，任何从未买过的 SKU 永远是"无参考价"。**上线前先在生产数据上量一下真实占比**，如果常态是 40%，这个 chip 就是墙纸。
- 计数型文案没有复数：`packages/i18n/src/index.ts:51-63` 的 `format()` 只做 `{name}` 单花括号替换，注释明说"调用方自己按 count 分支"。`{n} 无摊位` 在中文自然，在 en/ru 会出 "1 stalls"。

---

### Q7 — 新建采购这一步必要吗 + 价格默认不显示

**结论**：
(a) **删掉"新建采购"确认弹层，保留 run 对象，在采购员第一个真实动作时隐式创建**——但联网门禁放在**进页面时**，不是第一次保存时。
(b) 价格默认收起可以做，**但"按上次价格批量确认"必须只对整数计件 SKU 开放，且必须在来源标记做完之后**；先单独上线纯赚不亏的键盘改进。

#### (a) 新建采购

**为什么**

- 那个确认在防一个**不存在**的后果。它的红色警告文案说"将锁定 {n} 份审核通过的订单…这些订单不能再被编辑"——但 `packages/domain/src/order/commands.ts:617` 已经对 `status === 'approved'` 抛 `order.errors.lockedByStatus`。**店铺员工在审核那一刻就失去了编辑权。**
- 真正改变的只有一件事：`order.unapprove` 变得不可能（`packages/domain/src/order/commands.ts:485` `if (state.runId) throw preconditionFailed('order.errors.alreadyInRun')`）。那是**审核人**的能力，不是店铺员工的，而且可逆（`run.ejectSession` 把会话退回 `approved`、`runId=null`）。所以这个 key 不该删，该**改写**成"本次采购将锁定 {n} 份订单，锁定后无法退回审核"，并作为内联 banner 而不是模态门。
- 而它自称保护的那个"撤销"是**坏的**：`packages/contracts/src/schemas/run.ts:194-197` `RunReasonOnlyInputSchema.reason = z.string().min(1)`，而前端 cancel 故意设 `requireReason:false / reasonOptional:true`（`RunPage.tsx:1110-1111`）并发送空串。误点 → 齿轮 → 取消 → 不填理由 → BAD_REQUEST → 一个通用 error toast。
- "生成采购单页面"甚至不是一个页面：`run.section.readyToPlan` 只是 `PreviewSummaryCard` 的 CardTitle，内联渲染在 RunPage 上（应用无 router）。**"从生成采购单页直接开始"字面意思就是把那张卡片变成可写的。**
- run 对象不能删：`runId` 承载 `events.stream_id`+`UNIQUE(stream_id,seq)`、`market_runs_v UNIQUE(org,date,index)`、`order_sessions_v.run_id`、三张读模型的外键、`inventory.movements` 幂等键、`price_history.run_id`、worker 的孤儿清扫。**隐式创建，不是取消创建。**
- 用前端隐式创建、不用服务端惰性创建：`purchaseItem` 的线上契约硬要求 `runId`，领域层拒绝任何不在 `state.items` 里的 SKU。而 `run.create` 已支持 `startImmediately:true` 在同一事务里发 `PlanRun + StartPurchase`（`run.ts:704-716`），前端两个调用点本来就都传 true。代价只是当天第一次保存多一次往返。

**怎么做**

1. **先修撤销，但不要动 `RunReasonOnlyInputSchema`。** 那个 schema 被 4 个过程共用（`run.ts:2024 reopen` / `:2069 undoStartPurchase` / `:2082 undoStartDelivery` / `:2114 cancel`），其中 3 个的领域层仍硬要求非空理由（`commands.ts:687/996/1016`）。放松它只会把校验从 tRPC 边界推进领域层的抛错。正确做法：新增 `RunCancelInputSchema`（`reason: z.string().max(500).optional().default('')`），**只给 `run.cancel` 用**。
2. **先堵两个并发 run 的洞。** `PlanRun` 只判 `state.status !== 'absent'`（对全新 stream id 恒真），DB 唯一键是 `(org_id, run_date, run_index)` 而不是"每组织一个非终态 run"。`activeRun` 取排序后第一条（`RunPage.tsx:550`；`run.ts:946` `runDate DESC, runIndex DESC`），所以第二个 run 会**静默盖住**第一个及其所有已记录的采购。加分区唯一索引 `market_runs_v (org_id) WHERE status IN ('planned','purchasing','delivering')`，并让 `run.create` 在已有活跃 run 时返回它而不是再造一个。
3. **迁移必须同时改 journal。** CI 有一步 diff `packages/db/migrations/*.sql` 与 `meta/_journal.json` 并 `exit 1`（`.github/workflows/ci.yml:74-92`；journal 现停在 idx 34 / `0034_run_amend_permission`）。新增 `0035_*.sql` 时必须同步加 `{idx, version, when, tag}`，否则连 type-check 都跑不到。
4. **runIndex 竞态加有界重试。** `run.ts:615-621` 是"读 max + 1"，冲突映射成 `CONFLICT run.errors.alreadyPlanned`（`:742`）——这个文案本身就误导（那是索引竞态，不是"已存在采购单"）。隐式创建后这个竞态会从一次刻意点击挪进巴扎流程中间，必须在唯一键违例上重读 max 重试 1–2 次。
5. 删掉 `RunPage.tsx:1787-1839` 的创建 Sheet、`:794-810` 的 MainButton 分支、`:918-931` 的 sheetPrimary 分支。四本目录里的 `run.header.newRun` / `run.action.createNewRun` / `run.action.planRun` / `run.action.aggregateInfo` 一并清理；`run.banner.planLockWarning` **改写不删**。注意 en.ts:568-569 是跨行值，不是一行删除。
6. 无 run 分支（`RunPage.tsx:1508-1527`）渲染与采购态同一套面（同样三种分组、同一个 `PurchaseRow` 叶子），`lastPrice` 喂 `preview.lastPurchasePriceBySku`。
7. `ensureRun()`：有活跃 run 返回其 id，否则 `await create.mutateAsync({sessionIds, startImmediately:true})`，然后回放原动作。
8. **联网门禁放在进页面，不是保存时。** 无活跃 run 且 `!navigator.onLine` 时，整张价格网格从首帧就渲染成禁用 + 常驻 banner"需要网络开始今天的采购"。否则采购员已经走到摊位、谈完价、敲完 6 位数、递了现金，才被告知开不了单。更好：在他**打开采购 tab 且有信号时**（在家/在门口）就建 run。理由：`run.create` 不在离线注册表里（`RunPage.tsx:178-219`），而 outbox 的分类器对 `CONFLICT/BAD_REQUEST/NOT_FOUND/PRECONDITION_FAILED` 是**永久丢弃**（`useOfflineQueue.ts:83-97`），只有一个通用 toast。
9. 创建后弹一个带内联"撤销"的 toast（调 `run.cancel({runId, reason:''})`，第 1 步落地后合法），齿轮里保留常驻取消。
10. 把"哪些店铺在今天这单里"从弹层搬成**常驻头部行**：`2026-07-26 · 3 家店铺 · 42 件商品`，可点开现有的 RunSessionsCard。这是创建流程里唯一一个真正的选择（今天两个调用点都是隐式 `sessions.map(s=>s.id)`，用户从来没得选过）。
11. 顺手补 `run.create` 缺失的广播：它不发 `run.changed`、不发被它锁住的会话的 `order.changed`、不调 `dispatchRunEventNotifications`（对比 `run.ts:2366-2372`）。
12. 加测试：`packages/domain/src/run/run.test.ts` 补"第二个活跃 run 被拒"和"CancelRun 空理由"；`apps/api/src/__tests__/cancel-run-cascade.test.ts` 补放松后的 reason。

#### (b) 价格默认不显示

**为什么**

- 数据早就在了：`run.get` 返回 `lastPriceBySku`（`run.ts:1439-1452`，`DISTINCT ON (sku_id) ... ORDER BY observed_at DESC`），`PurchaseRow` 已用它预填价格（`RunViews.tsx:1005-1006`）并作为弱化提示显示。**"价格已知"这个判据零后端改动。**
- **但单纯的"点开才显示"是净增加点击。** 今天一个没变价的商品是**一次点击**（价格已预填、✓ 已可用）；变价的是两次点击 + 输入。改完之后没变价的仍是一次（除非批量按钮上线），变价的变成"点行展开 + 输入 + Enter"——**更慢**。折叠只有在批量按钮成立时才回本。
- **而批量按钮有一个钱账问题**：它不只假设价格，必然也假设**数量**。`RunViews.tsx:999` qty 从 `item.purchasedQty ?? item.plannedQty` 预填，`:1144` `canSave` 只要求 qty>0 && price>0。在巴扎买菜是按重量的，计划 3kg、秤上 2.6kg 是常态而非边缘情况。而这个假设的数量正是计费基准（`settlement.ts:31-37`）**和库存入账基准**（`runProjection.ts:262-279`）。一次点击给三家店按没称过的重量计费，并给它们记上从没到货的库存。
- **而且没有任何地方区分"人看过的价"和"系统假设的价"**——包括收尾结算那一刻。`RunPage.tsx:620-663` 的 finishSummary 只有求和。同时每一个被接受的价格都写一条 `price_history` 观测（`runProjection.ts:666`），成为**下一次采购的基线**。一次随手的"全部确认"会逐日复利。

**怎么做（按顺序，不可跳）**

1. **先上纯赚不亏的键盘改进，与折叠解耦**：展开时 `autoFocus` 价格输入并 `select()`；加 `enterKeyHint='next'`；加 `onKeyDown` Enter → `handleSave()` → 聚焦下一行价格；给价格输入补 `step`（qty 有，`RunViews.tsx:1271`；价格没有，`:1278`）；✓ 从 `h-8 min-w-8`（`:1316/:1331`）放大到 44px。
   **这些都在 `RunViews.tsx` 调用点上做，不要动 `packages/ui/src/components/NumberInput.tsx`**——它已 `forwardRef` 并 spread `...rest`，这些全是纯 call-site props；改共享组件会把 Order/Approval/Admin 三个页面拖进爆炸半径。
2. **稳定行序**（折叠 + 键盘串联的前置条件）：`run.ts:1218` 加 `orderBy: asc(skuId)`；客户端把"无价"排最前、"沿用上次"次之、"已确认"最后。
3. **补价格时间戳**：`run.get` 的那个查询已经 `ORDER BY observed_at DESC` 然后把时间戳丢掉。改成返回 `{price, observedAt}`，对超过 ~7 天的"沿用"行显示陈旧标记。同批把 `sql.raw` 拼的 IN 列表换成 `run.ts:1408` 已在用的绑定数组形式。
4. **来源标记（Q4 第 10 步）必须先落地**：行内保存带上摊位 id，并在 `run_items_v` 或事件里记录"这个价是本次人工输入的"。**没有第 5 步的前提就是它。**
5. **收尾确认里加一行**：`N 项沿用上次价格未修改，其中 M 项超过 7 天`。**没有这一行，不上任何批量确认。**
6. 三态行：
   - A「沿用上次」（pending 且有 lastPrice 且未触碰）→ 折叠成一行，价格用 `--c-fg-muted` + `↺` 标记；
   - B「本次已确认」→ 现有 purchased 分支不变；
   - C「无参考价」→ 价格槽渲染成 warning 色的 `[填价]` chip，**绝不是空输入框**。点行原地展开现有网格。
   **关键：折叠态那一行必须从 `lastPrice` prop 渲染，不能从 `PurchaseRow` 的局部 state。** 因为 `:1005` 只在挂载时 seed 一次，而 `:1024` 的对账 effect 对 `pending` 行**故意提前返回**——叠加 6 秒轮询，别人买了同一个 SKU 之后 prop 变了、折叠行还在显示挂载时的旧数字。展开那一刻（用户接管）才交给局部 state。
7. **批量确认，仅限整数计件 SKU**：`sku.step` 已喂到每一行（`RunPanels.tsx:400` `step={sku?.step ?? '0.1'}`），把批量按钮门控在 `step === '1'`（箱、扎、包），**排除所有小数步长的称重商品**。C 态行一律排除并留在原地。点开走现有 ConfirmSheet，逐行列出 名称·数量·单价·行小计 + 分组合计。
8. **批量后端 mutation 的失败语义必须写死。** `run.purchaseItem` 一次一个 SKU，且 mutation 限流 120/分/路由/用户，150 个 SKU 的"全部确认"超预算。但新加的 `run.purchaseItems` 有个陷阱：run 流上任何乐观并发冲突映射成 `CONFLICT run.errors.staleSeq`（`run.ts:2409-2411`），而客户端 `classifyReplayError`（`useOfflineQueue.ts:88-97`）把 `CONFLICT` 判为**终态并丢弃**。今天这代价是一行；批量之后是另一个采购员记了一件商品就摧毁 40 笔钱账写入。
   二选一：(a) 返回逐项结果数组、部分成功也提交；(b) 保持原子但**不入离线队列**，无网时回落到逐行路径。无论哪种，都要逐项幂等键 + `CONFLICT` 专门重试（重读 seq、重决策、重追加）再落到分类器。
   同时把 `run.addPurchaserItem` / `run.addExpense` 补进前端 `IDEMPOTENT_MUTATIONS`（`apps/web/src/lib/trpc.ts:132-140`，服务端 `run.ts:1610/1642` 已标幂等，客户端却不发 key）。
9. 新 SKU（`lastPrice === null`）→ C 态，排在分组最前，排除于所有批量。它只有两个出口：填价，或标缺货——而标缺货今天强制自由文本。加 3 个预设理由 chip（`run.unavailable.reasonOutOfStock` / `.reasonTooExpensive` / `.reasonQuality`，**四本目录都要加**），自由文本保留兜底。
10. 任何新的价格读写都必须走 `apps/web/src/pages/runs/lib/priceMath.ts` 的 `toDisplayPrice`/`fromDisplayPrice`——×1000 模式**默认开启**，漏一处就差 1000 倍。

**风险**

- `claude/price-data-auto-fill-b96c13` 分支是**空的**：sha = `c2a0639` = main，`git log main..branch` 为空。它提供不了任何东西。
- 隐式创建把 runIndex 竞态挪进巴扎（见 (a) 第 4 步）。
- 批量接受的价格会自我强化：写进 `price_history` → 成为下次的 `lastPriceBySku` → 再被批量接受。第 3、4、5 步是唯一刹车。
- 部分实现的三态行（有折叠、没批量）会让市场里**更慢**。要么整套上，要么只上第 1 步。

---

## 5. Q8 — 额外建议（8 条，按优先级）

**1. 修部署管线，并禁止在活跃 run 期间部署**
为什么重要：见第 2 节。今天部署会让生产上同时残留两棵前端树、数据库领先于代码、且无回滚——对正在巴扎里的采购员来说这是数据完整性事故。
代价：~2 小时 + 一条飞行前 SQL 检查。

**2. 复活供应商语言的复制文本**
为什么重要：这是离你实际工作最近的功能——把一张摊主能读懂的清单递过去。`useI18n.ts:193/224` 完整实现、零调用点。今天点"发送"粘进摊主 Telegram 的是中文品名。
代价：改动 ~1 小时，但必须**连测试一起上**——写测试需先把 `formatLineForText`/`buildStoreText`/`buildSupplierText`（`RunPanels.tsx:973-1007`，全是组件体内闭包、都没导出）抽到 `runs/lib/shareText.ts` 成纯函数。合计 ~半天。

**3. 让短交/错货真正生效，并在确认页显示金额**
为什么重要：三家店共用一个采购员，整个产品的意义就是"谁欠谁多少"。今天 `confirm_status` 写了没人读，短交仍按全额计费、库存按全额入账，而 `ConfirmPage.tsx` 里 `formatMoney|currency` 命中数为 0——收货人在看不到账单的情况下签字。
代价：L，约 1 周。碰事件、投影、领域求和、两条报表查询和一个新 UI 面。
**注意**：`report.purchaseLines` 今天就已经忽略 0033 的按店覆写（用 `ri.unit_price` 而不是 `ris.unit_price`），得同批修。另外 `inventory.movements` 有分区唯一键，重投影是 no-op——历史行不会自动修正，需要显式回填或调整流水，这必须是个**决定**而不是默认。

**4. 让离线状态可见，并让重放对钱安全**
为什么重要：巴扎的 LTE。`useOfflineQueue` 本身写得不错，然后它返回的 `pendingCount` / `online` **在全前端零消费**——采购员只会看到一次"已离线保存" toast，没有任何常驻信号说明还有 14 笔没发出去。更糟：只有 `run.purchaseItem` 在入队时带稳定幂等键（`RunPage.tsx:347`），`:275/:295/:373/:412` 都不带，而 `run.addPurchaserItem`/`run.addExpense` 服务端已标幂等、客户端集合里却没有 → 丢响应重放会重复记一笔账外采购或一笔费用。
代价：指示器 ~半天，幂等键 ~2 小时。

**5. 修掉价格行的三个拇指级缺陷**
为什么重要：这是采购员一趟要碰几百次的面，单手、站着。(a) 行序在手指下重排（`run.ts:1218` 无 orderBy + 6 秒轮询）；(b) 原始单位码泄漏——`RunViews.tsx:174/1200/1230/1386` 直接渲染 `sku.unit`，读作 "bunch" 而预览卡读作 "把"；(c) 键盘死路 + 32px 的 ✓。
代价：S，三条加起来不到一天。

**6. 给摊位一个行走顺序**
为什么重要：采购员走的是市场里一条固定路线，而按摊位视图按 `supplierName.localeCompare` 排序（`RunPanels.tsx:896-899`），字母序对应不了任何物理空间。`inventory.suppliers` 是**唯一**没有 `sort_index` 的目录表（categories/skus 等 5 张都有）。
代价：M，2–3 天（一次迁移 + 后台拖拽排序 + 排序函数）。
**不要复活 `inventory.store_supplier_prefs.rank`**——行走顺序是市场和采购员的属性，不是下单店铺的属性，按店排会给一趟物理行程三种不同顺序。

**7. 干掉摊位前的强制打字**
为什么重要：站在摊位前最常见的两件事是"他没货"和"他有别的规格"。两件都强制自由文本。热路径上那一个是 **`run.unmarkUnavailable`**（"我在 A 摊标了缺货，在 C 摊买到了"）——`packages/contracts/src/schemas/run.ts:170` 是 `z.string().min(1)`，前端 `RunPage.tsx:1185` `requireReason: true`。于是"找到了"要走：找到那一行 → 开确认弹层 → 湿手指打字 → 确认 → 才能填价。同一文件里 `UndoPurchaseInputSchema`（`:185`）已经是 `.optional().default('')`——放松的先例就在隔壁。
代价：理由 chip ~1 天；`unmarkUnavailable` 放松 + 去掉确认弹层 ~2 小时；替换品（`ItemUnavailable` + `PurchaserItemAdded` 原子成对、带原 skuId）~3 天。

**8. 用测试收尾拆分，而不是继续拆文件**
为什么重要：拆分把 RunPage 从 7436 行变成 2138 + 5357 = **7495 行**。真正的缺陷是没有任何东西守住跨移动的行为，这正是第 2 条那个功能被静默删除的原因。`settlement.ts:11-15` 的文件头自己承认活没干完："更完整的按店结算聚合（finishSummary 的 byStore vs 历史明细的 perStore）仍然内联在 RunPage 里"。**两份互相分歧的"谁欠谁多少"实现，是最不该留重复的地方。**
代价：M，3–4 天。顺序：(1) 抽 shareText 并写供应商语言的特征测试；(2) 调和 finishSummary.byStore 与历史明细，把胜出者搬进 `settlement.ts`；(3) 之后再谈进一步抽取。
**同时做一件 5 分钟的事**：给 `zh.ts`/`ru.ts`/`uz.ts` 加 `satisfies Record<CatalogKey, string>`。今天它们是裸对象字面量，`index.ts` 用 `as CatalogModule` 强转，CI 只比 key 数量——一个 key 在 uz 里拼错，数量不变、类型通过、乌兹别克用户静默回退到俄语再回退到英语。而乌兹别克用户正是这个产品的受众。

> **前端没有 DOM 测试环境**：`apps/web/package.json` 里没有 `@testing-library/react`、没有 `happy-dom`、没有 `jsdom`，也没有 `bunfig.toml` 预加载。现有前端测试全是纯函数测试。
> 所以：手风琴 reducer、排序比较器、行状态分类（A/B/C）、`lineFormula`、shareText 这些**导出成纯函数并单测**；滚动增量钉住、autoFocus/select、两行截断这些**明确列为人工 QA 清单**。

---

## 6. 落地顺序

### 步骤 0 — 分支决策（先做，其他一切都被它挡着）

所有代码**基线是 `main`**，从 main 开功能分支、走 PR 合回 main。当前 worktree `bold-sanderson-dede9c` 与 main 一致（0/0），可以直接在里面干活，但要建有名字的功能分支。

- 0a. 从 main 合并 `codex/...`（merge-tree 已验证零冲突），开 PR 让 CI 的 PG 集成任务真跑一遍 codex 改过的 `refreshTokens.test.ts` / `rls-isolation.test.ts`。**运行时验证 auth WIP**——这是整个分支分歧里唯一的真风险。
- 0b. 主开发目录切到 main。**在此之前一次都不要跑 `deploy.ts`。**
- 0c. 删掉 10 个已被完全包含的分支和 2 个孤儿 worktree 目录。

### 步骤 1 — 部署与门禁

Q8-1 全套：clean-tree + 分支检查、`--exclude .git/.claude`、sha 取自远程 ref、活跃 run 期间禁止部署、CI 触发放宽到所有分支。
**这一步不解锁任何功能，但没有它，下面每一步都可能被一次误部署抹掉。**

### 步骤 2 — 一周的低成本高价值修复（可与步骤 3 并行）

- 修 `RunPage.tsx:1563-1582` 适配器缺 `lastPurchasePriceBySku`（Q5/Q6 的共同前置，两行）。
- `run.ts:1218` 加 orderBy + 客户端稳定排序（Q7-b 与 Q4 的前置）。
- Q8-5 的键盘/单位/触控三件套。
- Q8-2 抽 shareText + 供应商语言复制复活 + 特征测试。
- Q8-4 离线指示器 + 幂等键。
- i18n `satisfies` 类型约束。
- 新增 `RunCancelInputSchema`（Q7-a 第 1 步），修好撤销。

### 步骤 3 — 后端小硬骨头（解锁 Q7）

- 一活跃 run 分区唯一索引 + `run.create` 返回既有 run（迁移 0035 + **journal 条目**）。
- runIndex 竞态有界重试；`run.create` 补 `hub.publish` 与通知派发。
- 行内保存带上摊位 id（`RunPage.tsx:1611`）——**这是"只问变了的价格"的数据前提，开始积累 per-摊位 价格历史**。它需要数周才能产出可用数据，所以越早越好。
- `run.get` 的 `lastPriceBySku` 返回 `observedAt`。

### 步骤 4 — Q6（最便宜的可见胜利）

删 `overall` tab（四本目录同步）、自适应默认、汇总头（覆盖率式合计，不是现金数）、例外条 chip。**例外条要先于默认视图切换上线。**
解锁：让"无摊位"变得可发现 → 让按摊位视图真的有数据 → 让 Q4 有意义。

### 步骤 5 — Q4 + Q5（必须同批，共享折叠状态）

`accordion.ts` hook + 两个 storageKey、把采购态默认视图改成按摊位并移除"再点退回 aggregate"、折叠头（写"计划 x/y"不写裸 ✓、金额累加防空）、CSS 隐藏不卸载、滚动增量钉住、头部 a11y 重构、**SKU 名称过滤条 + "还没买到"常开桶**、按店铺两行行式 + 摊位标签 + 摊位聚类排序。
分享文本的价格披露**单独拆出来**（见下方待拍板第 1 条）。

### 步骤 6 — Q7（最大的一块）

删创建弹层、无 run 屏可写、`ensureRun()`、**进页面时的联网门禁**、常驻店铺范围头部行、撤销 toast、删死掉的 planned 态 UI。
然后是三态行 + 批量确认——**批量确认必须等到步骤 3 的来源标记积累出数据、且收尾确认加上"N 项沿用未复核"之后**，并且只对 `step === '1'` 的计件 SKU 开放。

### 步骤 7 — 延后（按此顺序）

Q8-3（短交结算 + 确认页金额，L，且要连 `report.purchaseLines` 的覆写 bug 一起修）→ Q8-6（摊位行走顺序）→ Q8-7（替换品）→ Q8-8（settlement 调和）。
`run.startDelivery` 缺权限检查（`commands.ts:489-503`）单独一张小票，随时可插。

---

## 7. 需要你拍板的三件事

1. **采购价格要不要给店铺看？**
   Q5 第 7 步会让购买成本第一次出现在店铺员工眼前（结算本来就按这个金额向店铺计费，所以站得住脚，但这是商业决定）。相关：`prices.view` 权限声明了却零执行（`seed-data.ts:36/120/158`），staff 角色没有它——要么把带价变体门控在它上面并真的执行，要么把这个 key 删掉。
   **另外，摊主消息今天已经在泄漏你所有店铺的名字**（`RunPanels.tsx:994-996`），这条建议无条件改掉。

2. **Q5 你说的"按店铺"是哪一块？**
   计划页（改动小、价格已在渲染，缺摊位名）还是采购中的 `PerStoreView`（`RunViews.tsx:155-178`，无价无摊位无折叠只读，改动大得多）。

3. **门店范围的采购员能不能看到其他店铺的花费？**
   `run.get` 是全有全无——只要 run 覆盖你名下任意一家店，你就拿到全部 `items[]` 和 `splits[]`（`run.ts:1199-1223`），而默认 purchaser 角色不持有 `run.create.org`，在别的地方都是被裁范围的。Q4 的"本摊位已花"和 Q5 的逐行价格都会把组织级金额渲染给按店裁范围的人。
   要么在 `run.get` 里按门店裁 `splits[]`，要么明确写下"允许"——但要是个决定，不是意外。
