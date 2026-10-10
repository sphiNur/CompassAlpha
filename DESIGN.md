---
version: alpha
name: Compass
description: 面向餐厅供应链的低密度 Telegram 小程序界面。钱优先，一屏一个主操作。
colors:
  primary: "#0F6B4F"
  primary-pressed: "#0B523C"
  on-primary: "#FFFFFF"
  ink: "#111827"
  secondary: "#6B7280"
  neutral: "#FAFAF8"
  surface: "#FFFFFF"
  surface-sunken: "#F2F1ED"
  line: "#E8E6E2"
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
    fontSize: 1.5rem
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  h2:
    fontFamily: system-ui
    fontSize: 1.125rem
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: system-ui
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: system-ui
    fontSize: 0.9375rem
    fontWeight: 550
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
    fontWeight: 650
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
  md: 14px
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
    rounded: "{rounded.sm}"
    padding: 16px
    height: 56px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    height: 52px
  button-primary-pressed:
    backgroundColor: "{colors.primary-pressed}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    height: 52px
  button-ghost:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    height: 44px
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
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
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.money}"
    rounded: "{rounded.md}"
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

## Colors

- **Primary (#0F6B4F) — "Produce Green"：** 唯一的交互色，用于主按钮、当前导航项、金额强调。采购与生鲜的语境色，刻意避开通用蓝。
- **Ink (#111827) / Secondary (#6B7280)：** 正文与次要文本。二级信息用颜色区分，不靠缩小字号——小字是密度的元凶。
- **Neutral (#FAFAF8) 暖纸底 + Surface (#FFFFFF)：** 层次靠一层卡片与发丝线（`line` #E8E6E2）建立，不靠阴影堆叠。
- **Warning (#B4762A)：** 待办、超期、未定价。只用作**填充**（状态点、徽标底）：它在白底上只有 3.77:1，当文字不达标。需要警示色文字或在其上放白字时用 **Warning Ink (#8A5A1C)**（白底 5.9:1）。
- **Danger (#B3261E)：** 仅用于破坏性操作（取消采购单、删除），不得用于普通强调。
- **付款方式**：`chip-payment-cash` 用中性底，`chip-payment-transfer` 用 info 蓝——两种付款方式**在任何列表里都必须呈现为同一位置的固定标记**，便于扫视。

## Typography

全部使用 `system-ui`（Telegram WebView 的原生字形，零字体加载开销）。8 个字体角色、5 个实际字号（13 / 15 / 16 / 18 / 24px，另有 32px 的 `display`），禁止临时发明新尺寸。字重 550 / 650 在没有可变字体的旧 Android 上会就近取到 700，可接受。

- `display` / `money-lg`：屏级总额（日结现金、采购单金额）。
- `h1` / `h2`：页面标题与卡片标题。
- `body` / `label`：正文与按钮。
- `caption`：仅用于标签与徽标——**不用于承载信息主体**。
- `money` / `money-lg` 强制 `tnum`：一列金额必须字位对齐，否则无法扫读。

## Layout

- 页面边距 **20px**（`spacing.page`）；区块之间 **24px**；标签与值之间 **8px**。
- 列表行最小高 **56px**（触摸目标 44px + 呼吸）。
- 主操作按钮吸底，距安全区 16px；滚动内容底部留出按钮高度。
- 手机上**单列**。任何两列以上的排版都必须先证明它在 390px 宽下可读。

## Elevation & Depth

**几乎不用阴影。** 层次顺序：`neutral` 底 → `surface` 卡片 → `line` 发丝线。只有底部弹层（sheet）与吸底主按钮允许一层轻阴影（实现里唯一的阴影 token：`shadow-raised`）。禁止卡片套卡片。

## Shapes

- `rounded.sm` 10px：列表行、输入框。
- `rounded.md` 14px：卡片、弹层。
- `rounded.lg` 20px：底部弹层的顶角。
- `rounded.pill` 999px：所有按钮、徽标、付款方式 chip。

## Components

- `button-primary`：每屏唯一。52px 高，胶囊形。
- `button-secondary` / `button-ghost`：次级与三级动作。ghost 只用于"返回/取消"这类不产生数据的动作。
- `button-danger`：破坏性动作，必须在弹层内二次确认。
- `row`：最小 56px 高的信息行。左为名称（可带一行同字号、次要色的说明），右为 `money` 金额，中间不允许再塞第三列。文字放不下就换行、行变高，不截断、不缩小。
- `stepper`：44px 触摸单元的数量增减，中间是 `money` 数字。
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
