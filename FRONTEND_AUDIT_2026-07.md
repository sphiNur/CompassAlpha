# 前端缺陷审计与重构方案 — 2026-07-05

> 目标(owner 原话):整个前端要**非常简洁**。不要元素套元素、卡片套卡片;同一种元素不能大小样式不一;删掉一堆不必要的元素。该拆分的拆分,该重写的重写。**每个像素点都是有意义的。**

---

## 0. 一句话结论

**设计系统本身是健康的,病在落地层。** 不需要从零重写整个前端 —— 需要:**补全 ~8 个共享 primitive + 删除调用点的手搓副本 + 机械拆分两个 god-file**。这样"同元素不同尺寸"会从"靠人工对齐"变成"结构上不可能发生"。

对少数**三份复制**的子组件(FinanceSection、三个分组视图、DishesSection、权限矩阵、目录 CRUD),在抽取时**就地重写**到新 primitive 上。这是"拆分为主、局部重写",不是全量重写。

---

## 1. 审计方法与可信度

- **64 个 agent** 并行审计:2 个 god-file 各出拆分方案 + 8 个 finder 按区域/缺陷维度扫描。
- **102 条候选缺陷**,其中 **53 条 critical/high 逐条对抗式验证**(agent 打开引用行核对)—— **53/53 全部 confirmed**(4 条为 partial:结论成立,行号略有偏差)。
- 交叉核对(独立 grep,非 agent):
  - 硬编码 `oklch` 仅 **2 处**、硬编码 `[Npx]` 仅 **2 处**、字号几乎全落在 `text-label/body/h2` 阶上 → **token 与排版是自律的**。
  - AdminPage **219 个 `<div>`**、RunPage **143 个**;全站 **86 处 `ring-hairline` 卡片面**、`<Card>` 59 处 → **结构才是病灶**。
  - 正牌行 primitive 采用率极低:`ListRow` 8、`SectionRow` 11、`DetailRow` 5、`Tile` 6 —— 而手搓的行/卡片副本遍地。
  - 同一"卡片行"竖向内边距并存 **5 种**:`py-2`(13)/`py-3`(8)/`py-2.5`(7)/`py-1.5`/`py-1`。

---

## 2. 诊断:问题不在你以为的地方

你感到"乱",直觉是"样式没统一"。但真正的链条是:

```
primitive 层"差一个 prop / 少一个组件"
        ↓ 逼得
~40 个调用点手搓同一个 行 / 卡片 / 选择行 / 吸顶条 / 分组卡
        ↓ 每份副本各自漂移
8 种卡片 padding · 5 种行高 · 4 种控件高 · 同一 SKU 名 3 种字号
        ↓ 再叠加
两个 7000+ 行 god-file,没有模块边界去强制"一种行只有一种写法"
        ↓ 你看到的
元素套元素、卡片套卡片、同元素大小不一、一堆多余元素
```

**结论:不是缺 token,是调用点绕过了 primitive;不是设计错,是 primitive 少了几块拼图、god-file 拆掉了边界。**

---

## 3. 五大根因(已在源码核实)

1. **primitive 层在"重复的接缝处"恰好不完整。** `Card` 有 `CardHeader` 但**没有 `CardBody/CardFooter`**(`Card.tsx:24-28` 注释自认"把 body padding 交给调用点");`ListRow` 尾槽只有箭头、**没有 action 按钮槽**(`Rows.tsx:92-97`);`Tile` 写死 `bg-surface/p-4/text-display`(`Rows.tsx:178`)。**每一个下游不一致,都是某个 primitive 少一个 prop 的症状。**
2. **"卡片外观"是被重复声明的,不是被组合的。** 字面串 `rounded-[var(--r-card)] bg-[var(--c-surface)] ring-hairline` 在 `Card`、`SectionRow`、`ListRow`、`Tile` 里各写一遍(`Rows.tsx:41/106/117/178`)—— **5 个属主,任何一次调整必然漂移。**
3. **god-file 抹掉了"强制一种契约"的边界。** view+leaf+logic 全塞进 7852/7457 行一个模块,4 个 run 视图、5 个目录段各自长出自己的卡片外壳,因为没有东西**逼**它们走共享组件。
4. **已有 primitive 被绕过或变成孤儿。** `SectionLabel`、`Segmented`、`PageHeader` 都存在且正确,但调用点重新内联其 markup(`PageHeader` 零使用,`SectionFrame` 却手抄它的 `h1`)。没人被"要求"使用的 primitive,会腐化成"死代码 + N 份漂移副本"。
5. **缺少规范化的间距/高度 token。** 没有 `--card-pad / --row-h / --control-h`,于是 8 种卡片 padding、5 种行高、4 种控件高(`Input h-10` / `Select h-11` / `NumberInput·SearchInput·Segmented h-9`)全部共存 —— `Select.tsx:7` 甚至留着一句"与 Input 等高(h-11)"的**过期注释**,而 Input 早已降到 h-10。

---

## 4. 缺陷主题(按影响排序,53 条已验证的归纳)

| # | 主题 | 严重度 | 条数 | 代表证据(file:line) |
|---|------|:---:|:---:|------|
| T1 | **God-file**:view+logic+data 焊死在两个 7000+ 行模块,无法强制统一行/卡契约 | 🔴 critical | 6 | `AdminPage.tsx:180-7852`(~40 组件/6 领域);`RunPage.tsx:1-7457`(30 实体,含 2088 行编排体) |
| T2 | **Primitive-gap**:共享 markup 因"缺组件/差一 prop"在 N 个调用点手搓 | 🔴 critical | 14 | 行外壳复制 9×;选择行复制 5×;吸顶条逐字复制 4×;权限矩阵 3× |
| T3 | **同元素不同尺寸**:同一语义元素在不同处 size/padding/height/surface 各异 | 🔴 critical | 16 | SKU 名 3 种字号(`OrderPage:962` h2 / `:1134` body / `ConfirmPage:322` / `RunPage:5040`);卡片 8 种 padding;控件 4 种高;行 5 种高 |
| T4 | **卡片套卡片**:card-in-card / 边框盒套边框盒,一处叠多层 ring+radius | 🟠 high | 8 | `RunPage:3904-3958`(Card→手写头→内层 ring warn 盒);`:6854-6935`(ring 盒套 ring Card,3 层);`ConfirmPage:270-431`(5 层) |
| T5 | **多余元素**:组件体重复、冗余 CTA/分割线、死代码、孤儿 primitive | 🟠 high | 9 | FinanceSection 三份复制(`:7369-7547`,~180 行);LogRow 逐字复制(`DebugPage:262/314`);LanguageSheet 死重复;`PageHeader` 零使用;结算逻辑复制(`:774-880` vs `:6994-7112`) |
| T5b | **违反自己文档的 UI 规则**(UI-6 密列 / UI-5 单强调 / UI-1 装饰 emoji) | 🟠 high | 7 | UI-6:N 个 ring 卡片而非一个边框容器(`AdminPage:4606/4903/5210/5886/6503`);UI-5:审批行 primary+danger+pearl 等重(`ApprovalPage:341-366`) |
| T6 | **primitive 内部互相打架**,消费者继承不一致 | 🟠 high | 6 | surface 串重打 5 次;控件高 h-11/h-10/h-9;`NumberInput` 用 border 而别人用 ring;`Chip` 与 `Tab` 是同一 pill 的两份实现 |

> 完整 53 条明细(每条含 evidence + fix + 验证结论)已归档在审计原始输出;上表是可执行的归并视图。

### 最能说明"同元素不一"的 4 个铁证

- **一个 SKU 名 3 种字号**:`OrderPage.tsx:962` = `text-h2`(15px),同文件 `:1134` = `text-body`(13px),`RunPage.tsx:5037-5040` 注释白纸黑字说"已统一到 text-body …与 Order/Confirm 对齐",结果 OrderPage 又漂回 h2,**把 RunPage 记录在案的那次统一给打破了**。
- **一种卡片面 8 种 padding**:`p-1 / p-2 / p-3 / p-4 / px-3 py-2 / px-4 py-2.5 / px-4 py-3 / px-3 py-1` —— 因为 `Card` 根本没有 padding 契约(`Card.tsx:13` 不设任何内边距)。
- **一种表单控件 4 种高**:`Input h-10` / `Select h-11` / `NumberInput·SearchInput·Segmented h-9`。任何把 Input 和 Select 并排的表单,边缘都对不齐。
- **一种分割行 5 种高**:`py-1 / py-1.5 / py-2 / py-2.5 / py-3`。同一 finance 明细,daily 用 `py-2`、bySupplier 用 `py-1.5`。

---

## 5. 重构方案

### 5.1 新增/合并共享 primitive —— 从根上消灭"同元素不一"

> 原则:**让"手搓"变得不可能。** 每个 primitive 落地后,立刻删除它取代的所有内联副本,并加 CI grep 禁止其原始 class 串出现在 primitive 之外。

| Primitive | 位置 | 消灭什么 |
|---|---|---|
| **Surface base / `surface()` util** | `packages/ui/Card.tsx` | 5 处独立重打的 `rounded-card bg-surface ring-hairline`;Card/Row/Tile/Banner-info 全部组合它 |
| **`CardBody` + `CardFooter` + `Card padding` prop** | `Card.tsx` | 8 种卡片 padding 漂移(**最高杠杆**,直接消除 `Card.tsx:24-28` 那句"padding 交给调用点") |
| **`Row` / `ListRow` 加 `trailing` action 槽** | `Rows.tsx` | 9× 手搓行外壳 + 5 种分割行高;尾槽支持 action 按钮而不只是箭头 |
| **`PickerRow`**(label+hint+selected+onClick) | `Rows.tsx` | SettingsSheet/LanguageSheet/StoreSwitcher 里 5× 手搓选择行 + surface-vs-surface2 背景分歧 |
| **`StickyPageBar`** | `packages/ui` | 4 页逐字复制的吸顶条 + `min-h-7/min-h-9/none` 高度分歧 + chrome-pad 安全区接线 |
| **`NameCell`**(双语主/次名) | `packages/ui` | Order/Confirm/Run 三种不兼容的 SKU 名渲染 → 一种 |
| **控件高 token `--control-h` + `PillButton` + `FieldLabel`** | `packages/ui` + tokens | 4 种控件高统一;`Chip`+`Tab` 合成一个 pill;字段标签"大写与否"只决定一次 |
| **`ExpandableGroupList`** | `packages/ui` | FinanceSection 三份复制 + History 展开卡 → 一个渲染器 |
| **`ListEditor<TDraft>` + `NameFieldsML`** | `packages/ui` | 5 份目录 CRUD 骨架 + 3 份四语名表单;顺带把 UI-6"密列=一个边框容器"焊进去 |
| **`PermissionMatrix`** | `packages/ui` | admin 三处手搓的命名空间分组权限矩阵 |
| **`PaymentMethodChips` / `StoreSplitChips` / `GroupCardHeader`** | `packages/ui` | run 域三个叶子各 3× 复制(支付方式、按店 pill、分组卡头) |

配套新 token:`--card-pad`、`--row-h`、`--control-h`(每种角色**只选一个值**)。

### 5.2 两个 god-file 拆分

**AdminPage.tsx(7852 → ~180 行 router)** — 判定 **refactor-split**(局部 rewrite-on-extract):

```
pages/admin/
  AdminPage.tsx          ~180  仅:鉴权 + 读 navStore 抽屉状态 + SectionFrame + 分发
  adminNav.ts            ~110  Section/Sub 类型 + titleForSection + nativeConfirm
  SectionFrame.tsx       ~60   返回按钮 + Telegram back 接线 + h1
  sections/WorkspaceSection.tsx        ~180
  people/{PeopleSection, MemberCard, memberSheets}.tsx
  permissions/{PermissionsSection, roleSheets}.tsx   (建 PermissionMatrix)
  stores/{StoresSection, StoreInventoryTab, StoreSalesTab, StoreSettingsTab}.tsx
  catalog/{Categories,Skus,Suppliers,ExpenseTemplates,Dishes}Section.tsx  (建 ListEditor + NameFieldsML)
  operations/{Activity,History,Audit,PriceReport,Finance,Maintenance}Section.tsx  (建 ExpandableGroupList)
```
每文件 <300 行。服务契约耦合的逻辑**逐字保留**。FinanceSection / DishesSection / StoreSettingsTab 带 3× 重复 JSX,**抽取时就地重写**到新 primitive。

**RunPage.tsx(7457 → ~280 行 composer)** — 判定 **refactor-split**:

```
pages/runs/
  RunPage.tsx            ~280  查询 + 挂载子视图的组合体
  lib/{priceMath, settlement}.ts        结算/千位/比例分摊,逻辑整体搬移
  hooks/{useRunMutations, useConfirmDispatch}.ts   ~25 mutations + 270 行 confirm switch
  views/GroupedRunViews.tsx             聚合/按店/按供应商/按类别 → 走同一 PurchaseList 外壳
  components/{PurchaseRow, ActiveRunPanel, ExpensesCard, RunExtrasCard, ...}.tsx
  sheets/{PurchaseSheet, AddItemSheet, ...}.tsx
  history/{RunHistorySection, RunHistoryDetailSheet}.tsx
```
`settlement.ts` 的 `computeRunSettlement()` 同时供 finishSummary 与历史明细,消除 `:774-880` vs `:6994-7112` 的 140 行重复。

### 5.3 逐目标 re-plan

| 目标 | 动作 | 要点 |
|---|:---:|---|
| `pages/AdminPage.tsx`(7852) | **拆分** | → `pages/admin/*`,一文件一组件;逻辑逐字保留 |
| AdminPage FinanceSection / 3 权限 sheet / 5 目录段 | **重写** | 抽取时重建到 `ExpandableGroupList` / `PermissionMatrix` / `ListEditor+NameFieldsML`,行为不变、外壳统一 |
| `pages/RunPage.tsx`(7457) | **拆分** | → `pages/runs/*`;域逻辑整体搬移 |
| RunPage 3 个分组视图 + 结算数学 | **合并** | 三种外壳并到 `PurchaseList`;两份结算并到 `computeRunSettlement()` |
| `pages/OrderPage.tsx`(1500) | **拆分** | 抽出 `SessionExtrasEditor`+`ExtraRowEditor`(~320 行自包含);行改走 `Row`+`NameCell` |
| `pages/ConfirmPage.tsx`(270-431) | **重写** | 拆掉 Card 5 层套;CTA 只渲染一次(删 `:403-430` 冗余 Button) |
| `components/LanguageSheet.tsx` | **删除** | SettingsSheet 已完整重实现且两者都挂载;globe 按钮指向唯一 picker |
| `packages/ui/PageHeader.tsx` | **删除** | 零使用;SectionFrame 手抄了它 —— 二选一,别两份都留 |
| `pages/{Debug,Approval}Page.tsx` | **合并** | Debug 抽 `LogRow`;Approval 合并双 Banner + 降级 Reject 为 ghost(UI-5) |
| `packages/ui/{Card,Rows,Select,Input,NumberInput,Segmented,Chip,Tabs}.tsx` | **重写(内部)** | 补全缺口 + 收敛内部分歧,**保留好用的 API** |
| tokens.css + Rows API + SectionLabel + Segmented | **保留** | 已验证自律;只**新增** `--card-pad/--row-h/--control-h`,不动能用的 |

---

## 6. 执行顺序(7 阶段:行为不变、最快见"干净")

> 每阶段独立可发布;primitive 先行,消费者随后逐个采纳。

- **Phase 0 — 地基 token + Surface(低风险、不可见但解锁一切)**:加 `--card-pad/--row-h/--control-h` + Surface base;`Card/SectionRow/ListRow/Tile` 改为组合 Surface。纯内部,无视觉变化。顺手删 `Select.tsx:7` 过期注释。
- **Phase 1 — 补全核心 primitive(高可见价值,仍行为不变)**:`CardBody/CardFooter`+padding prop、`Row` 尾 action 槽、统一控件高、抽 `PillButton`+`FieldLabel`。消费者一采纳,卡片/行/控件立刻全局对齐。
- **Phase 2 — 在最吵的调用点采纳(最快见效)**:Order/Confirm/Run 列表行走 `Row`+`NameCell`(灭 SKU 名 3 字号);抽 `StickyPageBar` 换 4 页吸顶条;加 `PickerRow` 删 LanguageSheet 与 5 份内联 picker。小 diff、立即收敛、各自可发。
- **Phase 3 — run 域叶子 + 视图合并**:`PaymentMethodChips/StoreSplitChips/GroupCardHeader`+`PurchaseList`+`computeRunSettlement()`;三分组视图并到一套外壳;拍平 `RunPage:3904-3958 / 6854-6935` 的卡套卡。
- **Phase 4 — 拆 RunPage god-file**:叶子就位后机械抽取到 `pages/runs/*`,逻辑逐字进 hooks/settlement;RunPage → ~280 行。逐模块验证零行为变化。
- **Phase 5 — admin primitive + 拆 AdminPage**:`ExpandableGroupList/ListEditor/NameFieldsML/PermissionMatrix`;FinanceSection/目录/权限 sheet 重建其上(灭三份复制);再机械拆 AdminPage → ~180 行 router。**最大的文件放最后,等它依赖的 primitive 都在了。**
- **Phase 6 — 收尾 + 防回归**:OrderPage extras 拆分、DebugPage `LogRow`、ApprovalPage banner/UI-5、装饰 emoji(UI-1)清扫、死代码清除。加 CI grep:**禁止 raw surface/row/sticky-bar class 串出现在 primitive 之外**,让收敛无法回退。

---

## 7. 明确不要动的(保留)

- `tokens.css` 与 M3.14 字号阶(已证自律)。
- `Rows.tsx` 的 API 形状、`SectionLabel`、`Segmented`(正确,只是没被充分使用)。
- 事件溯源/离线队列/幂等/乐观更新/结算等**域逻辑**(硬赢来的,拆分中整体搬移、逐字保留)。
- Shell 的**竖向**框架与安全区数学(单点、干净)。问题只在**横向** chrome 未单点化。

> ⚠️ 已知陷阱(勿盲扫):部分 emoji 编码状态(现金/转账、已派/未派供应商、店/组织)—— 替换为文字或颜色,别直接删信号。`--app-chrome-pad` 的 -left/-right 变体是 iOS Telegram Close 按钮避让,承重,勿动。vendor 复制消息模板里的 emoji 是聊天内容,非 UI chrome,勿动。

---

*审计:64 agents / 102 候选 / 53 critical-high 全部对抗验证 / 独立 grep 交叉核对。方案为"拆分为主、局部重写、primitive 根治",全程行为保持。*
