# 采购页审计 · 2026-07-27

代码基线：`apps/web/src/pages/RunPage.tsx` + `pages/runs/**`，`packages/ui/src/tokens.css`，`packages/i18n`，`apps/api/src/trpc/routers/run.ts`。下面每条都对着真代码核过，行号是实际行号。

先说结论：老板说"这种格式设计是真的难看"，是对的，而且比"难看"更严重——**这一行的排版规则是反的，它会在采购员最需要数字的时候把数字删掉。** 不是审美问题，是数据问题。

---

## 一、最要命的几条

### 1. 行的排版规则是反的：名字不截断，数量和价格被挤没

`RunViews.tsx:1303` 商品名是 `shrink-0 truncate`。`shrink-0` 意味着这个 span 永远按 max-content 撑开、永远不会被压缩，所以 `truncate` 是一句死 CSS。旁边的 meta（`6 公斤 · ↺ 90K · 31 天前`）是 `min-w-0 flex-1`（`RunViews.tsx:1304`）——它是唯一能被压缩的东西。名字一长，**数量和价格被压到 0 宽度，名字自己再溢出按钮，压到 缺货 和 ✓ 底下**（行容器没有 `overflow-hidden`）。

同一个模式在四处重复：折叠待办行 `1303`、展开行 `1371`、已购行 `1551`、缺货行 `1621`，配送店铺行 `RunPanels.tsx:536`。已购行最惨：名字 `shrink-0`，`数量 × 单价 = 合计` 是 `min-w-0 flex-1 truncate`（`RunViews.tsx:1573`），后面跟两个 `shrink-0` 的文字按钮（`修改采购记录` / `撤销`）。俄语下这两个按钮 ~200px，343px 的行宽里，**采购员刚记完的金额是第一个消失的东西**。

讽刺的是，正确规则就写在 60 行外的同一个 feature 里：`RunPanels.tsx:1239-1241` —— "只有商品名和摊位名可以截断。每个数字都是 shrink-0，因为半截价格比换行价格更糟"。预览行（`RunPanels.tsx:1247-1265`）严格照做了，跑起来的行做的正好相反。

**代价**：任何名字长一点的 SKU（双语目录里很常见，俄语/乌兹别克语更常见），采购员站在摊位前看到的是一个名字、没有数量、没有价格。要买几公斤得点开行才知道。这是一个静默丢数据的布局，出现在最高频的屏幕上。

**修**：名字改 `min-w-0 flex-1 truncate`，数字改 `shrink-0`，行 `<li>` 加 `overflow-hidden` 兜底。五个 span，一次改完。

---

### 2. 87 行没有排序、没有搜索、没有筛选

- 服务端 `run.get` 按 `asc(i.skuId)` 排（`apps/api/src/trpc/routers/run.ts:1309）——skuId 是随机 UUID。
- `ActiveRunPanel` 直接 `run.items.map(...)`（`RunPanels.tsx:411`），没有任何客户端排序：不按目录、不按类别、不按摊位、不按名字、不按状态。
- `RunViews.tsx:344-351` 的注释断言 "The aggregate view sorts by sortIndex" —— **这是假的，从来没有过**。
- 搜索只存在于开跑前的预览卡（`RunPanels.tsx:1184` 的 `normalizeQuery` / `filterTokens`）。run 一开始，搜索框、匹配计数、无结果态全部消失。跑起来的那个 87 行列表，一个筛选器都没有。

**代价**：摊主举着一袋西红柿问"要不要"，找到那一行的唯一办法是从头滑 ~50 屏。已买的行还散落在原位（没有排序、没有状态标记），所以"还剩什么没买"每到一个摊位都要重扫 87 行。这一条基本可以单独解释"这个列表没法扫"。

**修**：把预览卡已有的搜索框和 `normalizeQuery` 提到 `ActiveRunPanel` 的列表卡上方，复用同一个 haystack；加两个筛选 chip（待办 / 缺货）。列表在 map 之前按 `状态(pending 先) → 摊位名 → 本地化商品名` 排一次，三个输入全在 payload 上。顺手删掉 `RunViews.tsx:344-351` 那句假注释。

---

### 3. 数量输入框拿展示格式化器当初始值：静默改数，上千直接锁死

`RunViews.tsx:1036-1038`：
```ts
const [qty, setQty] = useState<string>(formatQty(item.purchasedQty ?? item.plannedQty));
```
`handleSave`（`RunViews.tsx:1153`）把 `qty.trim()` 原样发给 `run.purchaseItem` 当 `actualQty`。而 `formatQty` 是展示层助手，文件顶上自己写着 "**never round-tripped back to the API**"（`lib/format.ts:16-17`），它做两件事（`format.ts:34-39, 88-90`）：四舍五入到 1 位小数，插千分位逗号。

两个后果：

- **静默改数**。计划 1.25 kg（两家店 0.5 + 0.75 的正常聚合，而且 `computeProportionalSplits` 自己就是 `.toFixed(3)` 出来的）预填成 `"1.3"`。一下 ✓，按 1.3 kg 计价，多算 4%，**屏幕上的数字和存进去的数字一致，两个都是错的**，没人能发现。
- **上千的行彻底死掉**。`formatQty(1200)` → `"1,200"`。`NumberInput` 是 `type="number"`，逗号非法 → 输入框渲染成**空白**；`Number("1,200")` 是 NaN → `canSave`（`RunViews.tsx:1190-1194`）永远 false → ✓ 永久灰。鸡蛋、袋装、按克算的东西，一行都记不了，还没有任何报错。

**修**：state 存原始服务端值，只在渲染时格式化；或者在 `handleSave` 里剥掉分隔符。`RunViews.tsx:1062` 的 reconcile effect 里同一个种子也要改。另外 `canSave` 为 false 时给一句可见的原因，别只给一个灰圆盘。

---

### 4. 折叠行的视觉分量整个倒过来了 —— 这就是"难看"的具体来源

按响度排这一行：**44px 满饱和蓝圆盘 ✓ > 橙色"31 天前" > 加粗商品名 > 其它一切。**
按采购员需要排：**商品名 > 数量 > 价格 > 新鲜度 > 保存。**

逐条：

- **✓ 圆盘是全屏最响的元素，而它不携带任何信息**（`RunViews.tsx:1338-1354`）。`h-11` + `bg-[var(--c-action)]`（`oklch(56% 0.18 250)` 满色度品牌蓝）+ 白勾，每一个 carried 行都一模一样。87 行、一屏 7 个，眼睛被一列蓝饼拖着走。饱和填充应该留给页面级唯一的提交（MainButton）。改成描边/浅色底（`ring-hairline` + `--c-action` 字），44px 命中区不变。
- **五个事实一个字重**（`RunViews.tsx:1304-1321）。数量、单位、`↺`、价格、天数全是 `text-label`（11px）`--c-fg-muted`，用 `·` 串成一句话。`tokens.css:22` 的 `--c-fg-subtle` 第三层墨色**在整个 RunPage 和 runs/** 里零使用**。数量是采购员要对摊主念出来的数字，它现在和时间戳一个视觉重量。数量应该升到 `text-body` + `--c-fg`，天数降到 `--c-fg-subtle`。
- **价格永远排不成一列**（`RunViews.tsx:1311-1315）。价格在流式文本里，前面是变长的"数量+单位+·"，所以每行 x 位置都不同——`font-mono tabular-nums` 白给。"哪一行的价格是正常值的 3 倍"是个纵向扫描问题，这个布局回答不了。预览行就是对的（`RunPanels.tsx:1257-1265` 把钱放在 `shrink-0` 尾格右对齐）。
- **左边缘在抖**。待办行没有前导标记，名字从 16px 起；已购行前面有 ✓（`RunViews.tsx:1550`）、缺货行有 ✗（`1620`），名字被推到 ~37px；行内边距还不一样（待办 `py-1.5`，另两个 `py-2`）。混排时左边缘锯齿、行距不齐。`PerStoreView` 已经解对了——`RunViews.tsx:170` 给三种状态都渲染 `·/✓/✗`。同一个文件里有现成答案，采购员真正编辑的三个视图没用。
- **橙色只有一处，标的是最不可行动的事实**。`STALE_PRICE_DAYS = 7`（`priceState.ts:21`），超过一周的参考价整段染 `--c-warning`（`RunViews.tsx:1316-1321`）——这是折叠待办行上唯一的彩色文字。主食一周一买，7 天是常态不是异常，所以老板看到的"8 行里 6 行橙"是稳态。而且 8 天和 31 天同一个橙，颜色连风险排序都做不到。**橙色变成壁纸之后，真正 31 天的那个也看不见了。**
- **右边缘有两种形状两种高度**。carried 行结尾是 44px 实心 ✓；无参考价行结尾是 ~22px 的 `填价` 药丸（`RunViews.tsx:1325-1328`）**并且完全没有 ✓**。两边都排不成列，而"一下就能记完"和"这个要打字"这两个最需要一眼分开的状态，靠一个还有另外四种含义的颜色来区分。
- **最少用的动作占了 87 行的永久横向空间**。`缺货` 是 `px-2 py-0.5 text-label` ≈ 20px 高（`RunViews.tsx:1331-1337`），夹在可点的名字区和 44px ✓ 中间。缺货一趟几次，✓ 一趟几百次。这 ~48px 正好是价格列右对齐需要的宽度。
- **单店行的 chip 行白白翻倍行高**。`showBreakdown = isMultiStoreRun && breakdown.length >= 1`（`RunViews.tsx:1226`）。三店 run 里只有一家要的商品很常见，这时渲染出的唯一 chip 上的数量，和上一行 `formatQty(item.plannedQty)` 是**同一个数**。多 22-24px 行高，重复一个没变的数字。行距从 ~44px 涨到 ~56-66px，812px 屏能装的行数少三分之一，87 行多滑约 10 屏。

**修**：给行一个 grid —— `[状态列 固定宽] [名字 flex-1 truncate] [数量 shrink-0] [价格 右对齐等宽定宽列] [动作槽 固定宽]`。✓ 去掉实心填充。`缺货` 降级到展开编辑器或滑动手势。`showBreakdown` 门槛改 `>= 2`，单店行把店铺名做成行内小标签或左侧色条。新鲜度不再染色，改成 `--c-fg-subtle` 层级；真要染色，只染最老的少数几行，别卡死 7 天。

---

### 5. 一键 ✓ 记不了转账 —— 分账数字系统性偏

折叠行（`RunViews.tsx:1290-1358`）只有：名字按钮、`缺货`、`✓`。💵/🏦 切换只存在于展开编辑器里（`RunViews.tsx:1470-1505`），`paymentMethod` 默认 `'cash'`（`RunViews.tsx:1048`）。Q7(b) 把折叠态变成了每个有价格的行的默认态，所以**快路径静默把每一笔都记成现金**。要记一笔转账，唯一办法是去点开一个你根本不想改价的行的价格编辑器。

**代价**：`finishSummary` 的 `totalCash` / `totalTransfer`（`RunPage.tsx:684, 717`）和每一条按店铺分账都是错的。经理拿去对银行流水的那个数字在悄悄漂。

**修**：折叠行上放一个紧凑的方式标记（长按 ✓ = 转账，或者本次 run 出现过转账后才显示 🏦 chip），或者像价格一样按摊位/按 SKU 把方式带过来。

---

### 6. 结束确认：不可逆的一步是一段灰色小字，而且它不说缺了什么、"沿用价格"统计恒假

`RunPage.tsx:1152-1167` 用 `+` 和 `\n` 把六段字符串拼成 `body`：套话、总额摘要、现金/转账、采购员新增、开销、沿用价格、按店铺结算清单（`${storeName}: ${formatMoney(ps.total)}${tail}`）。`ConfirmSheet.tsx:114-118` 把整坨塞进**一个** `<p className="whitespace-pre-line text-body leading-snug text-[var(--c-fg-muted)]">`。

于是：三家店要被记账的总额、每家店的金额、"N 项价格没人复核过"的风险行，全都是 13px `--c-fg-muted`、非等宽数字、不对齐、无强调，和"结束后，价格、数量、配送记录全部锁死"排版上一模一样。店铺名长度不同，金额左参差，没法竖着比。每段自带的 emoji（💵 🏦 🧾 ➕）在干排版该干的活。`ConfirmSheet` 还暴露了一个从没被用过的 `banner` 插槽（`ConfirmSheet.tsx:114`）。

更糟的是内容本身：

- **它不说什么没买到。** `finishSummary` 只数 `purchased`（`RunPage.tsx:679`），从不数 `unavailable`。一趟有 20 项缺货的 run，和全部买到的 run，确认文案**完全一样**。而 `RunHistory.tsx:451` 给同一个 run 算了 `unavailableCount`——记录锁死之后才告诉你。
- **"N 项沿用上次价格"结构性恒真，它的 stale 一半结构性恒零。** `countCarriedOver`（`priceState.ts:76-95`）靠"保存价 == 参考价"判定沿用。但每一次 `ItemPurchased` 都往 `price_history` 插一行（`runProjection.ts:675, 686`），而 `lastPriceBySku` 是 `DISTINCT ON (sku_id) ... ORDER BY observed_at DESC`，**没有排除本次 run**（`run.ts:1543-1548`）。6 秒轮询（`RunPage.tsx:625`）+ 每次保存 invalidate，保证点"完成"时客户端拿到的参考价就是刚存进去的那个。**所有已购行都完全相等，全部计为"沿用"**，不管价格是一键接受的还是重新敲的。同理 `observedAt` 是今天，`isStalePrice` 恒 false，`carriedOverStale` **永远是 0**——这条警告一次都没能触发过。

而这个数字正是"把价格编辑器藏起来"这个设计决定的**唯一安全论证**（`priceState.ts:13-18`）。论证的证据是假的，这个决定从来没被审计过。

**修**：body 别再拼字符串——传结构化 children：总额 `text-h2` 等宽半粗 `--c-fg` 独占一行；按店铺两列右对齐 `tabular-nums`；沿用/缺货/非 ok 验收用现成的 `banner` 插槽做成真 Banner。`finishSummary` 加 `unavailable` 计数，并且因为"完成"不可逆，**列出缺货商品名而不是只给数字**。服务端 `lastPriceBySku` 加 `AND run_id <> $runId`，然后拿一个混合了改价和沿用的 run 去验 `countCarriedOver`。

---

### 7. 两个死结：全缺货的 run 结束不了；共享开销 100% 记到一家店

**(a) 全缺货 run 走进死胡同。** `allItemsHandled` 允许全部 `unavailable` 推进到 `delivering`（`RunPage.tsx:641-648`）。但 `allStoresConfirmed` 从 `run.splits` 推导店铺集合，全缺货的 run **零 splits** → `involved.size === 0` → `return false`（`RunPage.tsx:651-654`）。`delivering` 的 MainButton 是 `visible: allStoresConfirmed`（`RunPage.tsx:912-918`）→ **"完成"按钮永远不出现**。页面主体也空的：门店清单 gate 在 `involvedStoreIds.length > 0`（`RunPanels.tsx:502`）。唯一出口是 Telegram ⋯ 齿轮菜单里的取消或撤销开始配送——而取消会扔掉"每一项都查过、都没有"这个唯一有价值的记录。

市场关门、供货商没来、全部断货——这不是边缘情况。

**修**：`if (involved.size === 0) return true;`，并给 delivering 面板一个明确的"没有可配送的东西"状态。

**(b) 共享开销默认把全额记到一家店。** 开销 sheet 以 `actualQty: '1'` 打开（`RunPage.tsx:1870`）——搬运费 / 打车 / 市场费的自然形状（1 × 30,000）。`evenSplit` 用 `Math.floor(q / storeIds.length)`（`RunSheets.tsx:663-669`），三家店：`floor(1/3) = 0`，映射成 `{A:'0', B:'0', C:'1'}`。提交时 `.filter(([, q]) => Number(q) > 0)`（`RunPage.tsx:2009-2011`）把 A、B 直接删掉，`settlePerStore` 把整笔算给 C。而屏幕上的文案写着"已选 {n} 个 · **自动平分**"（`zh.ts` `run.action.addExpense.splitHint`）。任何小于店铺数的 qty 都是这个下场。

**代价**：每一趟按默认方式录的共享成本，全额落在一家店的账上。结算时没人逐笔看开销的分摊，只看店铺总额，所以三家店里有一家每趟都被多收、另外两家被少收。

**修**：分**钱**不分数量——`qty*unitPrice/n`（最后一家吸收余数），或者保留 qty=1 让每家拿 `(1/n).toFixed(3)`。列是 `decimal(12,3)`，域层容忍 1e-6 漂移，`Math.floor` 没必要。另外别再静默过滤 0 数量的分摊——某家份额舍成 0 是 bug，该报出来。

---

### 8. 离线保存后行毫无变化；"87/87 待办" 是倒着数的

**(a) 离线不可见。** `purchaseItem.onError`（`RunPage.tsx:399-409`）在网络错误时清 `inlineSavingSkuId`、入 outbox、弹一个几秒就没的 toast。行仍然是 `pending`（服务端没回），所以**渲染得一模一样**：同样的价格、同样亮蓝的 ✓、没有排队标记、没有禁用态。`useOfflineQueue` 返回的 `pendingCount` 和 `online` —— 全 app grep 下来**零个渲染点**。

采购员在信号死角买 10 样，10 个 toast 各飘 3 秒，10 行全部还显示未买。再点一次是完全理性的反应。而 domain 的 `PurchaseItem` 没有 already-purchased 守卫，两次重放最后一次赢，覆盖数量/价格/支付方式，**绕过 `revisePurchase` 强制的原因字段**——finance 依赖的那条审计链断在这里。

同一个 toast 被丢弃时也不说是哪一项：`onDrop: () => toast.error(i18n.t('run.toast.syncFailed'))` → "有一笔已保存的操作未能同步，请复核"。在 87 行的列表里"请复核"不是一条人能执行的指令。

**修**：sticky 条上常驻 `pendingCount` 徽标；给行一个排队态（暗色 ✓ + ↑）并阻止同一 skuId 重复提交；`onDrop` 把商品名带上。

**(b) 进度指示器方向是反的。** `RunPanels.tsx:402-406` 把 **pending 数**塞进一个名字叫 `done` 的占位符，模板是 `'{done}/{total} 待办'`（`zh.ts:474`）。所以什么都没买时显示 **"87/87"**——全世界任何人读到的都是"100% 完成"；快结束时显示 "3/87"，读作"几乎没开始"。而且它把"已买"和"缺货"合成一桶：一项缺货和一项买到，对这个数字的影响完全一样。20 行之外的配送头部（`RunPanels.tsx:503-511`）用同样的 `{done}/{total}` 形状**正着数**，配送阶段两个方向相反的分数同屏可见。

它还是 `SectionLabel` 的 `meta` 槽，`font-normal --c-fg-muted`——整个 run 唯一的进度指示是卡片里最轻的文字。

**修**：改成 `{已买+缺货}/{总数}` 或者干脆 `还剩 {n}`，占位符改名，`tabular-nums` + `--c-fg`，头部下面加一条细进度线。

---

## 二、其余问题

### 列表 / 导航
- 默认视图（aggregate）**看不出这一行该在哪个摊位买**；`按摊位` 视图不是默认（`RunPanels.tsx:233-241`），chip bar 没有 aggregate 自己的 chip，退出 `按摊位` 靠再点一次已选中的 chip——不是可发现的手势。而且只有 `按摊位` 视图会传 `supplierId`（`RunPage.tsx:1715-1735`），别的路径写进 `price_history` 的 supplier 全是 NULL，**按摊位的价格历史永远攒不起来**。
- `按摊位` 视图每次保存后**在拇指底下重排**：`RunViews.tsx:352-366` 按 `pending:0 / purchased:1 / unavailable:2` 排序，保存顶行 → 它跳到桶底 → 下面每行上移一格。而这正是代码自己说"采购员站在摊位数东西"的视图（`RunViews.tsx:396-399`）。快速连点时第二下落在刚滑上来的那一行。
- 而 aggregate 视图**从不重排**（`RunPanels.tsx:411`）。同样 87 项，取决于一小时前点过的一个 chip（持久化到 localStorage），呈现两种互相矛盾的顺序。挑一个。
- 四个分组只有两个站得住：`按门店` 是只读的（`PerStoreView` 不含 `PurchaseRow`），跑到一半进去是死路；`按类型` 对应不了 bazaar 的任何物理概念，`<details open>` 全部展开等于没折叠，组内不排序，还藏掉扩展项和开销（见下）。
- 分组头部把**公斤、把、个加成一个数**：`RunViews.tsx:81 / 329 / 866` 的 `reduce((s,r)=>s+Number(r.qty))`，渲染成 `'{n} 个 SKU · {qty}'`（`zh.ts:478`），不带单位。2kg + 3把 + 1个 = "6"。这个数占着本该放该组金额或剩余数的位置。

### 阶段 / 流程
- **`按类型` 视图完全藏掉 `其他物品` 和所有开销。** `RunPanels.tsx:461-476` 和 `483-498` 的 gate 里，`perCategory` 只有在 `!showPerCategory` 时才成立；`PerCategoryView` 自己也不渲染这两张卡（对比 `PerVendorView` 在 `RunViews.tsx:448` 渲染了 `RunExtrasCard`——M3.31 就是为了修这一类 bug）。`ExpensesCard` 更离谱：gate 同时排除了 `perVendor`，而注释写着"Rendered in aggregate / perVendor view"——**三个分组视图里都看不到开销**。扩展项是员工自由文本请求，最容易被忘掉的东西。
- 即使在默认视图，`其他物品` 也排在 87 行**之后**，上方没有任何计数或标记。
- **标记扩展项"已买"和记录它花了多少，是两条不相连的动作。** `RunViews.tsx:597-624` 的状态循环和 `633-641` 的 `记价` 各走各的；`addExpense.onSuccess`（`RunPage.tsx:342-348`）只 invalidate + 关 sheet，不改状态。两种失败都是钱：打了 ✓ 没记开销 = 店铺白拿货；记了开销状态还是 `·` = 交接时看着没办、再买一遍。状态循环的唯一提示是 `title` tooltip——触屏上不存在。
- **配送和完成阶段，商品清单整个消失。** 列表卡 gate 在 `plannedOrEditing`（`RunPanels.tsx:290, 397`），`delivering` 时按 SKU 的清单和扩展项卡全部卸载，只剩一个"{n} 项 · 配送中"的店铺清单。交接那一刻——采购员站在店门口、经理在数袋子——恰恰是最需要按店铺清单的时刻。`run.splits` 一直带着每个 (sku, store) 的实际数量。
- **店铺验收反馈从不渲染。** `readModel.ts:295-298` 的 `confirmStatus` / `confirmNote` / `confirmPhotoUrl` 每次 6 秒轮询都在 payload 上，grep `apps/web/src/pages/RunPage.tsx` 和 `runs/**` —— 零命中（只有 `ConfirmPage.tsx` 用）。一家店回"少 2 公斤，附照片"和一家店全部完好，在配送清单上长得一模一样。采购员这时候往往还在附近，十分钟能补上；现在这条投诉是隐形的，run 走到完成，价格/配送/验收全部永久锁死。
- **"完成不了"时按钮直接消失。** `startDelivery` 是 `visible: allItemsHandled`（`RunPage.tsx:906-910`），一项没处理就整个按钮不渲染。注释说"用户从行徽标就知道还剩什么"——没有搜索、没有排序、87 行，他不知道。缺的信息不是"你不能继续"，是"**哪三行**"。
- **一个按钮两个相反动作。** 配送店铺行 `onClick={stage === 'pending' ? onDeliverStore : onRecallStore}`（`RunPanels.tsx:546-560`），样式相同、可访问名只描述状态不含动词。三个阶段（待配送/已送达/已确认）只靠一句灰色 `{n} 项 · {stage}` 区分——阶段 Badge 被删了，注释里承诺的 rail（`RunPanels.tsx:531-533`）没落地。行高 ~34px。
- **谁在跑这一趟，页面上没有。** `run.get` 返回 `claimedByDisplayName` / `previousClaimerDisplayName`（`run.ts:1550-1585`），`run.claim` / `run.releaseClaim` 都实现了，web 端**一处都没用**（grep 确认，只有 ApprovalPage 用 order 侧的对应物）。两个采购员可以同时录同一个 run，后写的静默覆盖先写的，没有 banner、没有 CONFLICT、也绕过 `revisePurchase` 的必填原因。`RunPage.tsx:1509` 的注释说 `+ 加项` gate 在"我持有 claim (C.2 gate)"——实际 gate 是 `RunPage.tsx:621` 的 `status === 'purchasing' || amending`，仅此而已。删掉这句注释。

### 输入 / 触控
- **一趟要打九次自由文本键盘。** 强制必填：缺货备注（`contracts/run.ts:141-145` `min(1)`）、取消缺货原因（`167-171` `min(1)`）、修改采购原因、加项原因、加开销名称+原因、撤销开始采购/配送原因、撤回配送原因。而 `undoPurchase` 的原因**已经**是 optional（`contracts/run.ts:182-186`，注释说"误点太常见，强制填原因像在惩罚 typo"）——同样的论证对市场里最高频的事件（缺货）却没应用。唯一的点选填充是开销模板 chip（`RunSheets.tsx:859-896`），证明这个模式可行、只是没推广。可预见的结果：到处填 "1"，审计链归零，时间照样花掉。
- **纠错动作全是 20px，制造错误的动作是 44px。** `px-2 py-0.5 text-label` ≈ 20.3px：`缺货`、`修改`、`撤销`、`取消缺货`；`×千` 切换和 `+ 加项` ≈ 18.3px（`RunPage.tsx:1499, 1543`）；`查看全部`（`RunHistory.tsx:139`）无 padding = 14.3px。`×千` 尤其危险——它 rescale 屏幕上和打开的编辑器里的每一个价格（`RunViews.tsx:1082-1091`），18px 目标，误触就是 1000 倍的金额误读。
- **描边按钮的边界是 1.2:1，根本不像按钮。** `--c-divider` 是 `oklch(0% 0 0 / 0.08)`（`tokens.css:47`），这 1px 边框是 `缺货`/`修改`/`撤销` 与普通灰字的**唯一**区别（它们无填充，字色就是 `--c-fg-muted`，和行内 meta 同色）。WCAG 1.4.11 要求 3:1。阳光下这条线不存在。需要一个 `--c-border-control`（≥3:1）和装饰性 `--c-divider` 分家。
- 每次行内保存都会把底部 tab 栏整体变半透明并禁用（`useAppMutating` → Shell）。为"点保存后马上切 tab"写的守卫，现在在一趟 87 次的常规 ✓ 上全部触发。
- `inlineSavingSkuId` 是单个 string（`RunPage.tsx:110`）：A 还在飞时点 B，A 的 ✓ 重新变亮、in-flight 态消失、`handleSave` 里的 `if (saving) return` 也失效。同时 `haptic()` 只在 `onSuccess` 里响（`RunPage.tsx:393-398`），慢网下点完手上没有任何确认——而重点一下正是丢单的机制。另：`RunPage.tsx:380-384` 的注释说"the app's mutation-in-flight guard serialises purchases"——**没有这样的守卫**，`useAppMutating` 只是把导航栏和主按钮变灰。删掉这句注释，idempotency key 改成随 call 传（走 `variables`），别共用一个 ref。
- Sheet 原语提供了 `deferAutoFocusMs`（专门为了消除 iOS WebView 键盘弹出时把 Save 按钮顶出视口的跳动），全 app 只有 `ApprovalPage.tsx:431` 用了。run 流程里每一个必填原因 sheet 都是裸 `autoFocus`。
- 行内打了字没保存，任何中断都会清空（`RunViews.tsx:1036-1044` 是行内 `useState`，切 tab 会卸载整棵树）。注释说"打开没保存的行没什么值得恢复的"——对没动过的行成立，对已经敲进价格的行不成立。debounce 存 sessionStorage 就够。
- 展开编辑器里 `NumberInput` 是 36px，旁边的 ✓ 和 💵 是 44px；价格是 grid 里唯一的 `1fr`，所有 `auto` 轨道（`×`、`K·UZS`、`= 合计`、💵、✓）先分完宽度，剩下的才给采购员要念给摊主听的六位数字。给价格轨道一个 `minmax(6ch, 1fr)` 下限。

### i18n
- **ICU 复数模板在 en / ru / uz 里是死代码。** `packages/i18n/src/index.ts:59-100` 的 `stripPluralWrappers` 把整个 `{n, plural, …}` 块替换成 `String(vars.n)` —— 名词被删掉，不是降级。受影响的 run 键：`run.label.skuCountAndQty`（`en.ts:579`, `ru.ts:515`, `uz.ts:529`）、`run.label.sessionsCount`、`run.label.itemsCount`、`run.label.itemsHint`、以及 en 的 `run.preview.unknownPrices`（`en.ts:613`）。俄语采购员看到的分组头是 **"12 · 34.5"**，异常 chip 是光秃秃的 **"3"**，配送行是 **"5 · Доставлено"**。zh 没有复数语法所以中文全对——这就是没人发现的原因。要么上 `@formatjs/intl-messageformat`，要么把 en/ru/uz 的复数语法删掉改成 zh 那种调用点安全的写法。加一条 catalog lint，运行时不支持时禁止出现 `, plural,`。
- **"UZS" 硬编码在多个 catalog 字符串里**：`zh.ts:601`（`addedByPurchaser`）、`630`（`expenses`）、`666`（`finish.summary`）、`720`（`history.totalLine`），以及 `unitPriceUzs` / `unitPriceUzsThousands`（键名本身就写死了假设）。而 `PurchaseRow`（`RunViews.tsx:1055`）、`ExpensesCard`、`PreviewSummaryCard` 都正确地从 session 读 `member.currency`（M1.21 就是为了解锁非 UZS 租户）。同一个结束确认段落里三种货币处理并存：写死后缀、session 后缀、`RunPage.tsx:1147-1149` 的裸 `formatMoney` 无后缀。
- **`×千` 的记号和它产生的值不一致。** 按钮标签是 `×千`（zh）/ `×1000`（en/ru/uz），但值后面缀的是硬编码的拉丁 `K`，六处调用点。折叠行的价格显示成 `90K`，**完全没有货币**（`RunViews.tsx:1313` 的 `formatMoney` 默认 `currency = null`）。展开行有个带原始 UZS 的 `title`，折叠行没有，触屏上 `title` 也够不着。俄语用 "тыс."，乌兹别克语用 "ming"。在摊位价格上搞错 1000 倍是这个屏幕能造成的最贵错误。
- **千位模式下 1000 以下的价格显示是错的。** `formatMoney(Number(lastPrice)/1000)` + "K"，`formatMoney` 封顶 1 位小数：850 → **"0.9K"**，300 → "0.3K"。存的值是对的（`toDisplayPrice`/`fromDisplayPrice` 保 3 位），**显示和记录不符**。香草、香料、按个卖的蛋全在 1000 以下。抽一个共享的 `formatThousands(raw)`（同一个表达式手写了五遍），3 位小数或 1000 以下回退到原始 UZS。
- **单位原始代码在 sheet 和历史里漏出。** `RunSheets.tsx:234, 778, 828, 1114` 和 `RunHistory.tsx:765, 770, 791` 直接渲染 `sku.unit`。`RunViews.tsx` 七月已经全部走 `useUnitLabel`。同一个 SKU 在列表里是 "6 公斤"，点开的 sheet 里是 "6 kg"，经理审计的历史记录里又是 "6 kg"。七个调用点，hook 是 drop-in。
- 历史页月份表头用 `d.toLocaleDateString(undefined, …)`（跟浏览器 locale，不是 `i18n.locale`），下面的行渲染裸 ISO `2026-07-26`（`RunHistory.tsx:126-129, 180`）。
- ru/en 的非公制单位没有复数形式："5 пучок"（应为 пучков）、"3 пара"、"5 bunch"。公制单位是缩写所以天然没问题——把剩下的也缩写掉（пуч., рул.）是最便宜的正确答案。这些字符串会进 `shareText.ts:47`，直接发到摊主的 Telegram。

### 无障碍
- **每一行的 `aria-label` 把这一行的内容全删了。** `RunViews.tsx:1300` `aria-label={skuName}`——按钮里包含名字、数量、`↺` 价格、天数、`填价` 药丸，全部被覆盖。`↺` 另外还是 `aria-hidden`。低视力采购员听到 87 个商品名，没有数量、没有价格、没有新鲜度。对比 `RunPanels.tsx:1496-1500` 的手风琴头，那里有一段注释专门解释为什么**不**加 aria-label——这个教训没传到行上。直接删掉这个 label，按钮的文本内容本身就是好名字。
- **87 个 ✓ 全部念作 "save purchase"，硬编码英文。** `RunViews.tsx:1344, 1514`；还有 `1430` "actual qty"、`1452` "unit price"、`1451` `placeholder="price"`（俄语界面里一个英文 placeholder）。catalog 里 `run.action.savePurchaseAriaLabel` / `actualQtyAriaLabel` / `unitPriceAriaLabel` **已经存在**（`zh.ts:653-655`），只是没用。而且 label 是常量，87 个按钮的可访问名完全相同、不带商品上下文，每一次点击都在往店铺账本里写钱。
- 状态标记（`·`/`✓`/`✗`）在四种行态里三种是 `aria-hidden`，而它是行状态的唯一载体。`+` 新增徽标和 🏦 转账徽标把 `aria-label` 挂在无 role 的 `<span>` 上——按 ARIA in HTML 规则对 generic 元素无效，大多数 AT 直接忽略。
- 💵/🏦 切换只显示和播报**当前状态**，从不说明动作，没有 `aria-pressed` / `role="switch"`（`RunViews.tsx:1470-1505`）。而两个文件外的 `×千` 切换正确设了 `aria-pressed`（`RunPage.tsx:1497`）。支付方式决定这笔钱落到哪一栏。
- `Chip` 硬编码 `role="tab"` 且 `aria-selected={selected || undefined}`——未选中的 chip **没有** `aria-selected` 属性，在 tablist 里非法。没有 tabpanel、没有 `aria-controls`，点已选中的 chip 是**取消选中**——tab 没有这个行为。tablist 的可访问名是硬编码英文 `ariaLabel="Run view mode"`（`RunPanels.tsx:307`）。
- `NumberInput` 用 `outline-none` + 仅 `focus:border-[var(--c-action)]` 替代（`NumberInput.tsx:47-49`）。焦点态是 1px 边框换色，而这一行专门做了 Enter 链式 数量→价格→保存（`RunViews.tsx:1421-1428），硬件键盘/开关设备用户找不到焦点在哪。
- 对比度：`--c-warning`（`oklch(72% 0.15 75)`，`tokens.css:29`）作为白底 11px 文字远低于 AA 的 4.5:1；`填价` 药丸是同色系橙字配 `--c-warn-bg` 橙底，更低。**这是行上唯一的彩色文字，也是最不可读的元素**——阳光眩光第一个抹掉的就是它。要么把 light 主题的 `--c-warning` 压到 `L≈0.57`，要么警告类药丸改成深墨色配浅色底（底色已经承载了"警告"语义，字色不需要重复一遍）。

### 数据一致性 / 其它
- **同一个"无参考价"数字在一屏上出现两次，分母不同。** `previewStats` 数的是**去重后的商品**（`previewStats.ts:52-64`，且文件解释了为什么），`group.unknownCount` 数的是**行**（每个 (店铺, 商品) 一行，`RunPanels.tsx:663-665`）。两者用同一个字符串 `run.preview.unknownPrices` 渲染三处。chip 说 3，下面店铺行加起来 7，措辞一模一样。
- 而且 `previewStats.ts:56` 的 unpriced 分支**没有** `kind === 'sku'` 检查（隔壁 `61-65` 的 noSupplier 有）——自由文本扩展项按构造永远不可能有参考价，所以这个数有一个采购员永远清不掉的地板。
- `无摊位` chip 跳到 `bySupplier` 的 `__unassigned__` 桶，但 `previewStats.noSupplier` 排除了扩展项而 bucket builder 把每个扩展项都塞进 `__unassigned__`（`RunPanels.tsx:1000-1010`）——chip 说 2，桶里可能 5 行。
- **预览页把这趟要花多少钱埋在 11px 灰句子里。** `RunPanels.tsx:1404-1410`：一个 `预估` eyebrow 加一个 `text-label text-[var(--c-fg-muted)]` 的 span，里面塞 "已知价格 87/120 项 · 至少 1,234,567"，连等宽都不是。而正下方每家店铺的金额是右对齐等宽 `--c-fg`（`RunPanels.tsx:1456-1458`）——**分项比它们的总和还要响**。经理打开这一屏就是为了回答"今天大概多少钱、其中多少是猜的"，而这是卡片里最不显眼的文字。
- 店铺金额印了两遍：估算头部一行一店（`RunPanels.tsx:1447-1461`），紧接着每个折叠手风琴头又是同样的店名 + `合计 {total} UZS · {n} 个无参考价`（`RunPanels.tsx:1519-1523`），同样的 `byStore` 对象。十二家店 = 十二行重复金额把商品列表推下一整屏。而且头部遍历未筛选的 `byStore`，手风琴遍历 `visibleByStore`——搜索激活时上下两块在描述不同的东西。
- 计划态 run 上，session 数被说了三遍：头部 Badge、warn Banner（"开始后将锁定 N 份已审核订单"）、`RunSessionsCard` 的 meta。而对一个**已存在**的 planned run，`RunPage.tsx:1657-1661` 用 `sessionIdsJson` 伪造 sessions 数组，所以这个锁定警告在讲一件早就发生过的事。警告在最常渲染的场景里是假的，教会操作员忽略 warn banner。
- 预览行用斑马纹（`RunPanels.tsx:1218`）叠在卡片 ring + 分组头灰带 + section `border-t` 之上——四个分组装置做一件事。斑马纹是给单行表格用的，这里的行是两行高、内部还有间距，条带高度不齐。扩展项徽标用裸 `text-[10px]`（`RunPanels.tsx:1252, 1305`）绕过了类型标尺，而 `text-meta`(10px) 在 `tokens.css:184` 已标 DEPRECATED。
- `其他物品` 用满幅 `--c-warn-bg` 黄底（`RunViews.tsx:109`，`RunPanels.tsx:1548, 1664`）。扩展项是每一单都有的正常内容，染成警告黄等于在说"这里有问题"。`--c-warning` 现在横跨 ~16 处、至少四种互不相干的含义（缺数据 / 数据过期 / 校验失败 / 普通内容）。把它收敛到唯一一种含义：**"需要动手，否则会挡住或搞砸这趟采购"**。
- `priceRowState`（`priceState.ts:36-38`）用 `args.lastPrice ? 'carried' : 'unpriced'`——字符串 `"0"` 是 truthy。参考价为 0 的行会渲染成 carried 形态**带 ✓**，但 `canSave` 要求 `Number(price) > 0`，所以 ✓ 永久灰，行上没有任何解释。改成 `Number(args.lastPrice) > 0`。
- 采购 sheet 列出**整个组织**的店铺而不是这趟的店铺（`RunSheets.tsx:132` `candidateStores = [...storeById.values()]`），隔壁 `AddItemSheet` 是过滤过的。10 店组织的 3 店 run 里要滚过 7 个无关字段，填错了要等服务端往返才报错。另外这个 sheet 用 `step={sku?.step ?? '1'}` 而行内用 `'0.1'`。
- 开销卡的空状态渲染的是 `run.action.addExpense.scopeSharedHint`（`RunViews.tsx:698-702`）——那句话是用来解释 sheet 里共享/按店切换的，孤零零挂在空的"目录外 & 开销"标题下是答非所问，而且鉴于上面的 `Math.floor` bug，这句话本身还是假的。
- 服务端 `previewCreatable` 算好的 `estimatedTotal` / `unknownPriceCount` 每次拉取都在传，客户端只从中取店铺名、金额全部重算（`RunPanels.tsx:1055-1067` 的注释解释了服务端版本看不到 `extrasJson` 所以不一致）。两个权威、一个已知错误、还在线上传。要么从响应里删掉，要么教服务端认识 `extrasJson`。别两个都留着。
- `PerVendorView` 每行做 `run.items.find(...)`（`RunViews.tsx:377`，87² 次）加 `run.splits.filter(...)`（`RunViews.tsx:400`），aggregate 视图重复同样的 splits filter（`RunPanels.tsx:418`），而 6 秒轮询每次都产生新数组身份。`RunPanels.tsx:187-195` 已经为 demand 预算了 map——照做 `splitsBySku` / `itemBySku`，并在有编辑器打开时暂停或拉长轮询。
- `SectionLabel.tsx:27-29` 的文档写 "text-label (12 px)"，实际是 11px（M3.14 之后）；`RunPanels.tsx:583` 同样的 12px 说法。这是个以"单一真相来源"为存在理由的组件。

---

## 三、反而是对的 —— 别顺手"修"掉

1. **预览的按店铺行是这一页唯一排版正确的行**（`RunPanels.tsx:1247-1294`）：名字截断、每个数字 `shrink-0`、金额右对齐成真列、等宽半粗，而且规则白纸黑字写在 `1239-1241`。**跑起来的行应该照抄它**，不是反过来。
2. **展开编辑器的键盘链**（`RunViews.tsx:1421-1450`）：聚焦全选 + Enter 从数量跳价格再跳保存。单手操作下这是真正好用的东西，`RunViews.tsx:1487-1500` 关于 44px 高 / 36px 宽的推理是量过的真思考，不是抄来的教条。重构行的时候必须带走。
3. **价格编辑器 opt-in 这个决定本身是对的**（`priceState.ts:13-18`）。大部分主食价格不变，每行都挂完整的 数量×价格×方式×✓ 网格确实是噪音。它的问题不在决定，在于它的安全对价（`countCarriedOver`）是坏的、结束表又把这个数字渲染成灰色小字。修那两个，别退回旧网格。
4. **`↺` 该删，但每行下面的按店铺 chip 是对的**（`RunViews.tsx:1228-1263`）：在正确的时刻回答"这是给谁买的"，并且按状态取正确的数据源（pending 取需求，purchased 取实际 splits）。只该改触发门槛（`>= 2`），不该删。
5. **预览手风琴的滚动锚定 + 默认折叠 + 搜索绕过折叠**（`RunPanels.tsx:764-790, 1170-1201`）是一对很少有人做对的搭配。
6. **`previewStats` 的去重规则和"至少"措辞是诚实的**，`settlement.ts` / `previewStats.ts` 是纯函数、有测试、被结束表和历史表共用——这正是这两处金额能对得上的原因。
7. **API 侧的确定性排序和 `lastPriceObservedAtBySku` 并行 map** 都是对的判断（`run.ts:1300-1313`，注释解释了堆序会让刚保存的行跳到底部）。问题是客户端在这个确定性基础上没有再排一次序。
8. **公制单位缩写（кг / г / л / мл / шт）不用管**——缩写不变格，它们天然绕过了复数问题。
9. **缺货走 reason sheet 而不是即刻生效**（`RunPage.tsx:1741-1743`），以及**已购行的 `撤销` 不要求原因**——这两个是对的，只是 `撤销` 的红色不该是文字层里唯一的饱和色。
10. **开始采购按钮的联网 gate**（`RunPage.tsx:868-888`）推理扎实。它恰好证明了别处对离线状态的沉默是疏漏而不是策略。

---

## 四、我建议的动手顺序

**第一批 —— 一天之内，全在 `PurchaseRow` 里，不动任何数据流**
1. `shrink-0 truncate` → `min-w-0 flex-1 truncate`（五处名字 span），数字改 `shrink-0`，行加 `overflow-hidden`。
2. 数量 state 存原始值，渲染时才格式化（顺带修 reconcile effect）。
3. 折叠行改成固定五轨 grid：状态列 / 名字 / 数量 / 右对齐价格列 / 固定动作槽。✓ 去实心填充；`缺货` 降级出折叠行；`↺` 删掉；`showBreakdown` 门槛改 `>= 2`；三种状态统一 padding；新鲜度改 `--c-fg-subtle`。
4. 删掉 `aria-label={skuName}`；四个硬编码英文 aria-label + 一个 placeholder 换成已存在的 catalog 键。

> 这一批把"难看"和"看不到数字"一起解决，并且解锁了第二批——因为价格一旦成列，列表才值得排序和搜索。

**第二批 —— 让 87 行可用**

5. `ActiveRunPanel` 客户端排序（状态 → 摊位 → 名字），同样应用到 `PerCategoryView` 的组内；删掉那句假注释。
6. 把预览的搜索框提到列表卡上方 + 两个筛选 chip。
7. 头部改成 `已买 N · 缺货 M · 剩 K` + `finishSummary.total` 挂到 sticky 条。
8. `按摊位` 在有 ≥2 个摊位时设为默认；给 aggregate 自己的 chip；冻结 `PerVendorView` 的排序（按 run id 存 ref），别在拇指底下重排。

**第三批 —— 钱和流程的正确性（可与第二批并行，代码不重叠）**

9. `allStoresConfirmed`：空 involved set 视为已确认；delivering 面板加"没有可配送内容"状态。
10. 共享开销分钱不分数量，去掉 `Math.floor`，停止静默过滤 0 份额。
11. `lastPriceBySku` 加 `AND run_id <> $runId`；然后用混合 run 验 `countCarriedOver`。
12. 结束确认改成结构化 JSX：总额 h2 等宽、按店铺两列右对齐、沿用/缺货/非 ok 验收走 `banner` 插槽；`finishSummary` 加 `unavailable` 并列出缺货商品名。
13. 折叠行加支付方式（长按 ✓ 或按摊位记忆）。

**第四批 —— 环境适配**

14. 离线：sticky 条常驻 `pendingCount`、行级排队态、`onDrop` 带商品名；`inlineSavingSkuId` 改 `Set`；`handleSave` 里同步 `haptic('light')`；idempotency key 随 call 传；删掉那句假注释。
15. 必填原因全部加 3-4 个 catalog 预设 chip（照抄开销模板那一行），`unmarkUnavailable.reason` 改 optional。
16. 所有 sheet 传 `deferAutoFocusMs={280}`。
17. 药丸家族统一 `min-h-11`；新增 `--c-border-control`（≥3:1）；`--c-warning` 压暗并收敛到唯一含义；`其他物品` 黄底改 `--c-surface-2`。

**第五批 —— i18n 与被藏起来的内容**

18. 复数：上 `intl-messageformat` 或删语法二选一 + catalog lint。
19. 九个字符串里的 `UZS` 改 `{currency}`；`K` 后缀改 catalog 键并和 `×千` 标签共用同一个 token；抽 `formatThousands`；`useUnitLabel` 补到 sheets 和 history。
20. `RunExtrasCard` / `ExpensesCard` 从 viewMode 条件里拿出来，无条件渲染；`addExpense.onSuccess` 联动 `markExtraStatus('bought')`；配送阶段继续渲染按店铺清单并把行项塞进配送确认 sheet；渲染 `confirmStatus` / `confirmNote` / `confirmPhotoUrl`。

**明确不要做**：不要重写这一页。键盘链、carried-price 的安全会计、预览手风琴的滚动锚定、纯函数结算模块，都是靠真实反馈攒出来的，重写最容易顺手丢掉。要修的是**那一行**，不是这个功能集。