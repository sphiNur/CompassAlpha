---
version: alpha
name: Compass
description: 面向餐厅供应链的低密度 Telegram 小程序界面。钱优先，一屏一个主操作。
colors:
  primary: "#0F6B4F"
  primary-pressed: "#0B523C"
  on-primary: "#FFFFFF"
  ink: "#1C1C1E"
  secondary: "#636366"
  neutral: "#F2F2F7"
  surface: "#FFFFFF"
  surface-sunken: "#E5E5EA"
  line: "#D1D1D6"
  success: "#0F6B4F"
  warning: "#B4762A"
  warning-ink: "#8A5A1C"
  danger: "#B3261E"
  info: "#2A5B9B"
typography:
  display:
    fontFamily: system-ui
    fontSize: 2rem
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
  h1:
    fontFamily: system-ui
    fontSize: 1.75rem
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  h2:
    fontFamily: system-ui
    fontSize: 1.25rem
    fontWeight: 700
    lineHeight: 1.25
  body:
    fontFamily: system-ui
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: system-ui
    fontSize: 0.9375rem
    fontWeight: 600
    lineHeight: 1.4
  caption:
    fontFamily: system-ui
    fontSize: 0.8125rem
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "0.01em"
  money:
    fontFamily: system-ui
    fontSize: 1rem
    fontWeight: 600
    lineHeight: 1.2
    fontFeature: "tnum"
  money-lg:
    fontFamily: system-ui
    fontSize: 1.5rem
    fontWeight: 700
    lineHeight: 1.15
    fontFeature: "tnum"
rounded:
  sm: 10px
  md: 12px
  lg: 20px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  page: 20px
  xl: 24px
  xxl: 32px
  xxxl: 48px
components:
  page:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "{spacing.page}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 16px
  row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: 16px
    height: 56px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 52px
  button-primary-pressed:
    backgroundColor: "{colors.primary-pressed}"
  button-secondary:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 52px
  button-ghost:
    textColor: "{colors.primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 44px
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 52px
  chip-payment-cash:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 8px
  chip-payment-transfer:
    backgroundColor: "{colors.info}"
    textColor: "{colors.on-primary}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 8px
  chip-status:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 8px
  stepper:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink}"
    typography: "{typography.money}"
    rounded: "{rounded.sm}"
    size: 44px
  nav-item:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary}"
    typography: "{typography.caption}"
    height: 56px
  nav-item-active:
    textColor: "{colors.primary}"
  money-value:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.money-lg}"
---

## Overview

Compass 是采购员与店长**在手机上、边干活边用**的工具：在市场里定价、在店里签收、打烊前日结。

因此设计的首要目标是**降低密度、让钱一眼可读**，而不是塞进更多信息。当前界面被反馈为"很乱、非常密集"——新设计从零开始，不继承任何现有布局。

三条原则：

1. **一屏一个主操作。** 每屏只有一个 `button-primary`，其余动作降级为 secondary / ghost。主操作永远吸底、拇指可及。
2. **金额是第一公民。** 所有数量与金额用 `money` / `money-lg`，等宽数字（`tnum`），右对齐成列，绝不与正文挤在一起。
3. **留白即功能。** 行高 56px、页边距 20px、区块间距 24px 是底线，不是上限。宁可让用户滚动，也不要让他眯眼。

## iOS 参照

视觉语言借鉴 iOS 自带的「提醒事项」和「备忘录」：安静、分组清楚、内容自己说话。我们运行在 Telegram 的 WebView 里，不是原生应用，所以分成照做的和变通的两类。

**照做**

| iOS 的做法 | 这里怎么做 |
|---|---|
| 分组列表（inset grouped）：灰底上的白色圆角卡片，没有描边 | `page` 用 `neutral` #F2F2F7，`card` 和列表用 `surface` 白色、`rounded.md` 12px，不描边 |
| 分隔线从文字起点开始，一直到右边缘，不顶到左边 | 列表行之间的发丝线左侧缩进 16px；第一行上方没有线 |
| 大标题 | 每屏一个 `h1`（28px 粗体），写在内容最上方，直接说这一屏是什么 |
| 分组标题是粗体的短句，不是小号全大写 | `h2`（20px 粗体） |
| 系统字体，三档字重 | `system-ui`，在 iPhone 上就是 San Francisco；字重只用 400 / 600 / 700 |
| 按下去有反馈 | 行按下变灰（`surface-sunken`），主按钮按下变深，次按钮按下加深一档 |
| 能点开的行右侧有一个 › | 同样；本身就是动作的行（"加一个商品"）不带 ›，文字用 `primary` 色 |
| 分段控件：下沉的轨道，选中项浮起 | `ChoiceGroup`：`surface-sunken` 轨道，选中项白底、`primary` 文字 |
| 输入框和次按钮是灰色填充，不描边 | `Field`、`button-secondary`、`stepper` 都用 `surface-sunken` 填充 |
| 一个强调色，其余是灰阶 | `primary` 绿是唯一的强调色，其余都是 iOS 的灰阶 |

**变通，以及原因**

| iOS 的做法 | 这里的做法 | 原因 |
|---|---|---|
| 导航栏，带返回和标题 | 顶部只有当前门店，夹在 Telegram 自己的两个按钮之间 | 屏幕顶部左右两角被 Telegram 的"关闭"和菜单按钮盖住，那里放不了自己的控件；返回用 Telegram 的返回按钮 |
| 大标题随滚动收进导航栏 | 大标题跟着内容滚走，不收起 | 没有可以收进去的导航栏；用脚本模拟在低端 Android 上会卡顿 |
| 底部标签栏：图标加 10px 文字 | 只有文字，13px | 之前的规则：不用图标代替文字。采购员在市场里单手、戴手套操作，文字不需要再解码一次 |
| 半透明毛玻璃的栏 | 不透明的白色栏加一条发丝线 | `backdrop-filter` 在旧 Android WebView 上要么没有、要么掉帧 |
| 弹层顶部有一个可以向下拖的小横条 | 没有横条；点遮罩或返回关闭 | 弹层不支持拖动关闭，画一个拖不动的横条是在骗人 |
| 次要文字 `#8E8E93` | `secondary` #636366 | 我们把次要信息放在正文字号上，`#8E8E93` 在白底只有 3.3:1，户外看不清；#636366 是 5.9:1 |
| 系统蓝、系统红 | `info` #2A5B9B、`danger` #B3261E | 系统蓝、系统红上面放白字都不到 4.5:1，而"转账"标记正是蓝底白字 |
| 向左滑一行出现"删除" | 点开行，在弹层里删 | 横向手势和 Telegram 的边缘返回手势冲突，而且看不见、发现不了 |
| 正文 17px | 正文暂定 16px | 等现场 Android 的文字放大数据，见 `docs/REDESIGN.md` 第 4 节 |
| 深色模式 | 仅浅色 | 不在这次重做范围内 |

## Colors

- **Primary (#0F6B4F) — "Produce Green"：** 唯一的交互色，用于主按钮、当前导航项、金额强调。采购与生鲜的语境色，刻意避开通用蓝。
- **Ink (#1C1C1E) / Secondary (#636366)：** 正文与次要文本。二级信息用颜色区分，不靠缩小字号——小字是密度的元凶。
- **Neutral (#F2F2F7) 分组灰底 + Surface (#FFFFFF)：** 层次靠灰底上的一层白卡片建立；`line` #D1D1D6 只用作卡片内部的分隔发丝线。`surface-sunken` #E5E5EA 是填充色：输入框、次按钮、分段控件的轨道、行的按下态。
- **Warning (#B4762A)：** 待办、超期、未定价。只用作**填充**（状态点、徽标底）：它在白底上只有 3.77:1，当文字不达标。需要警示色文字或在其上放白字时用 **Warning Ink (#8A5A1C)**（白底 5.9:1）。
- **Danger (#B3261E)：** 仅用于破坏性操作（取消采购单、删除），不得用于普通强调。
- **付款方式**：`chip-payment-cash` 用中性底，`chip-payment-transfer` 用 info 蓝——两种付款方式**在任何列表里都必须呈现为同一位置的固定标记**，便于扫视。

## Typography

全部使用 `system-ui`（Telegram WebView 的原生字形，零字体加载开销）。8 个字体角色、6 个实际字号（13 / 15 / 16 / 20 / 24 / 28px，另有 32px 的 `display`），禁止临时发明新尺寸。字重只有 400 / 600 / 700 三档。

- `display` / `money-lg`：屏级总额（日结现金、采购单金额）。
- `h1` / `h2`：每屏一个的大标题，与分组标题。
- `body` / `label`：正文与按钮。
- `caption`：仅用于标签与徽标——**不用于承载信息主体**。
- `money` / `money-lg` 强制 `tnum`：一列金额必须字位对齐，否则无法扫读。

## Layout

- 页面边距 **20px**（`spacing.page`）；区块之间 **24px**；标签与值之间 **8px**。
- 列表行最小高 **56px**（触摸目标 44px + 呼吸）。
- 主操作按钮吸底，距安全区 16px；滚动内容底部留出按钮高度。
- 手机上**单列**。任何两列以上的排版都必须先证明它在 390px 宽下可读。

## Elevation & Depth

**几乎不用阴影。** 层次顺序：`neutral` 灰底 → `surface` 白卡片 → 卡片内的 `line` 发丝线。卡片不描边。只有底部弹层（sheet）与吸底主按钮允许一层轻阴影（实现里唯一的阴影 token：`shadow-raised`）。禁止卡片套卡片。

## Shapes

- `rounded.sm` 10px：输入框、数量增减、分段控件里的选中项。
- `rounded.md` 12px：卡片、分组列表、所有按钮、分段控件的轨道。
- `rounded.lg` 20px：底部弹层的顶角。
- `rounded.pill` 999px：徽标、付款方式 chip、导航上的待办数量。

## Components

- `button-primary`：每屏唯一。52px 高，12px 圆角。
- `button-secondary` / `button-ghost`：次级与三级动作。secondary 是灰色填充加 `primary` 文字；ghost 只有 `primary` 文字、没有底，只用于"返回/取消"这类不产生数据的动作。
- `button-danger`：破坏性动作，必须在弹层内二次确认。
- `row`：最小 56px 高的信息行。左为名称（可带一行同字号、次要色的说明），右为 `money` 金额，中间不允许再塞第三列。文字放不下就换行、行变高，不截断、不缩小。
- `stepper`：44px 触摸单元的数量增减，灰色填充，中间是 `money` 数字。
- `chip-payment-cash` / `chip-payment-transfer`：付款方式标记。**固定放在金额正下方、与金额右对齐**——它说明的是"这笔钱怎么付的"，所以跟着金额走；无论名称多长，采购、签收、日结三处的 chip 都落在同一条右边线上。
- `chip-status`：状态用**文字**表达，文字始终是 ink 色；前面的小圆点用 warning / success / danger 填充，只为扫视时归类。
- `nav-item` / `nav-item-active`：底部导航，**只有文字、没有图标**（文字就是控件，图标是第二个要解码的东西）；选中态用 primary 文字色加粗，不用填充块。待办数量跟在文字后。
- `money-value`：金额展示单元。

## Do's and Don'ts

**Do**
- **每个元素都必须有功能或含义。** 屏幕上任何一处，都要能回答"它帮用户做了什么决定或动作"。答不出来的，删掉。
- **把屏幕用满、用对。** 空间要么承载信息，要么帮助阅读（分组、留白），不允许存在既无信息也无作用的区域。
- 每屏只放一个主操作，吸底。
- 金额一律 `tnum` 右对齐成列。
- 二级信息用颜色和留白降级，不用缩小字号。
- 空状态、错误状态都给出**下一步动作**（"重试"、"去下单"）。
- 付款方式在采购→签收→日结的每一处都可见且位置一致。

**Don't**
- **不要有没有功能和意义的元素**：纯装饰图形、只为好看存在的图标、为填满版面而塞的区块、不承载任何信息的留白。
- 不要把三个以上动作并排成一行。
- 不要用图标代替文字作为主要标签（市场里戴着手套、单手操作）。
- 不要用阴影做层次。
- 不要把正文放在 `caption` 字号上。
- 不要引入 `spacing` / `typography` 之外的临时数值。

> 留白是功能（帮助扫读与触摸），不是装饰。**判定标准**：拿掉这个元素后，用户是否会少知道一件事、或少做成一个动作？不会 → 删。

## Implementation

- 本文件的 YAML 是唯一来源。`packages/ui/tailwind-preset.js` 把它映射成 Tailwind 主题（`text-body`、`p-lg`、`bg-primary`、`rounded-pill`、`h-control` …），`packages/ui/src/kit/__tests__/tokens.test.ts` 在两者不一致时失败。**先改本文件，再改 preset。**
- 组件在 `@compass/ui/kit`。重做过的屏幕只从这里取组件；`@compass/ui` 根导出的旧组件随最后一个旧屏一起删除。
- 开发环境打开 `/?kit` 可以看到全部组件；`tests/e2e/tests/kit.spec.ts` 在 390px 宽的真实浏览器里实测字号、行高、触摸目标、金额对齐和付款方式位置。
- 仅浅色。Telegram 处于深色模式时界面仍为浅色；深色是之后单独加一组 token 的事，不在这次重做范围内。
- 暂时留在 Tailwind 3：升级到 4 会同时改变尚未重做的旧屏的默认样式，并把最低浏览器抬到 Safari 16.4 / Chrome 111。等旧屏删完、且确认了现场设备的浏览器版本后再议。
