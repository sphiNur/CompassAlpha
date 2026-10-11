---
version: alpha
name: Fine
description: 餐厅采购与门店运营工具。一个亮绿色负责所有主操作，浅灰绿底上的白色大圆角卡片，每屏最重要的数字最大。
colors:
  primary: "#A3E635"
  primary-pressed: "#8FD11F"
  primary-pale: "#E4F7CC"
  on-primary: "#10140B"
  forest: "#1F3A12"
  ink: "#10140B"
  secondary: "#454745"
  neutral: "#EBEEE7"
  surface: "#FFFFFF"
  surface-sunken: "#DEE3D8"
  line: "#D5D9D0"
  success: "#2EAD4B"
  warning: "#FFD11A"
  warning-pale: "#FFF1B8"
  warning-ink: "#4A3B1C"
  danger: "#C8322F"
  danger-pale: "#FBE1DF"
  danger-ink: "#8E1F1C"
  on-danger: "#FFFFFF"
typography:
  display:
    fontFamily: system-ui
    fontSize: 2rem
    fontWeight: 900
    lineHeight: 1.05
    letterSpacing: "-0.03em"
    fontFeature: "tnum"
  h1:
    fontFamily: system-ui
    fontSize: 1.75rem
    fontWeight: 900
    lineHeight: 1.1
    letterSpacing: "-0.03em"
  h2:
    fontFamily: system-ui
    fontSize: 1.25rem
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: system-ui
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: system-ui
    fontSize: 1rem
    fontWeight: 600
    lineHeight: 1.4
  caption:
    fontFamily: system-ui
    fontSize: 0.8125rem
    fontWeight: 600
    lineHeight: 1.35
  money:
    fontFamily: system-ui
    fontSize: 1rem
    fontWeight: 800
    lineHeight: 1.2
    fontFeature: "tnum"
  money-lg:
    fontFamily: system-ui
    fontSize: 1.5rem
    fontWeight: 900
    lineHeight: 1.1
    fontFeature: "tnum"
rounded:
  sm: 12px
  md: 16px
  lg: 24px
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
    rounded: "{rounded.lg}"
    padding: 16px
  hero:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.primary}"
    typography: "{typography.display}"
    rounded: "{rounded.lg}"
    padding: 20px
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
  button-secondary:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 52px
  button-ghost:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 44px
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-danger}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 52px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    borderColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: 52px
  chip-payment-cash:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
  chip-payment-transfer:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.primary}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
  chip-status-done:
    backgroundColor: "{colors.primary-pale}"
    textColor: "{colors.forest}"
  chip-status-pending:
    backgroundColor: "{colors.warning-pale}"
    textColor: "{colors.warning-ink}"
  chip-status-problem:
    backgroundColor: "{colors.danger-pale}"
    textColor: "{colors.danger-ink}"
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
    backgroundColor: "{colors.primary-pale}"
    textColor: "{colors.ink}"
---

## Overview

Fine 是餐厅的采购与门店运营工具：店员下单，店长审批，采购员在市场里买货，门店签收。人们边干活边用它，常常单手，常常在日光下。

2026-10-11 用户决定前端从零重做，设计语言取自 Wise（getdesign.md 的 wise 条目），不沿用此前的任何界面，也不照 iOS 做。批准的方案见 `docs/FRONTEND-PLAN.md`。

三条原则：

1. **打开就是待办。** 第一屏回答"现在有什么事等着我"。审批和签收是出现在首页上的事，不是导航里的地方。
2. **干活时全屏，一个按钮。** 进入一件事之后没有底部导航，只有内容和吸底的一个主按钮。
3. **数字最大。** 每屏最重要的那个数用最粗的字，放在墨色块里（`hero`），每屏至多一块。

## Colors

- **Primary (#A3E635) 亮绿，配墨色字。** 唯一的强调色，只用于主操作。它不做文字色：亮绿字在白底上读不清。需要绿色的字用 **Forest (#1F3A12)**。
- **Ink (#10140B) / Secondary (#454745)：** 正文与次要文字。
- **Neutral (#EBEEE7) 灰绿底 + Surface (#FFFFFF) 白卡：** 层次靠这两个底色的对比，不用阴影，不用描边。`surface-sunken` (#DEE3D8) 是填充色：次按钮、数量增减、未选中的选项。
- **状态三种，各有底色和字色，主色不兼作成功色：** 完成 `primary-pale` + `forest`；等待 `warning-pale` + `warning-ink`；有问题 `danger-pale` + `danger-ink`。
- **Danger (#C8322F)：** 只用于破坏性操作的按钮，配白字。
- **付款方式：** 现金是浅底墨字，转账是墨底亮绿字。两种标记在任何一屏都放在金额正下方、与金额右对齐。

## Typography

系统字体：要同时显示中文、俄文、乌兹别克文和英文，系统字体最稳，也不用下载。

- 最粗的字（900）只给页面标题和屏级数字；分组标题和金额 800；按钮和标签 600；其余 400。
- 正文 16px，标签 16px，说明与标记 13px，没有更小的字。
- 金额一律等宽数字、右对齐成列。

## Layout

- 页边距 20px，区块间距 24px。
- 列表行最小高 56px，触摸目标至少 44px。
- 按钮和导航的文字按俄文的长度留空间：放不下就换行，不截断，不缩小。
- 宽屏上整个应用居中成一列。

## Shapes

- `rounded.lg` 24px：卡片、列表、墨色块、弹层顶角。
- `rounded.md` 16px：按钮。
- `rounded.sm` 12px：输入框、数量增减、分段选项。
- `rounded.pill`：状态与付款方式标记。

## Components

- `hero`：墨色块，里面是这一屏最重要的数字（亮绿、最粗）和一两行说明。每屏至多一块。
- `button-primary`：亮绿底墨色字，每屏一个，吸底。
- `button-secondary`：灰绿填充、墨色字。`button-ghost`：只有墨色字。`button-danger`：红底白字，只在确认弹层里。
- `input`：白底、1px 墨色描边、12px 圆角。描边是为了在日光下看得见边界。
- `row`：左边名称和一行说明，右边金额或状态，中间不放第三列。
- `stepper`：数量增减。数量为零的商品不显示它，只显示一个"加"。
- 分段选项：选中的是墨底亮绿字，未选中的是灰绿填充。
- 导航：只有文字；当前项是浅绿底。

## Do's and Don'ts

**Do**
- 每个元素都要有功能或含义：拿掉它，用户会少知道一件事或少做成一个动作吗？不会就删。
- 每屏一个主操作，吸底。
- 金额等宽、右对齐。
- 空状态和错误状态都给出下一步。

**Don't**
- 不要把亮绿当文字色，不要在亮绿上再放绿色。
- 不要引入第二个强调色。
- 不要用阴影或描边做层次（输入框的描边除外）。
- 不要把三个以上动作并排成一行。
- 不要用图标代替文字。
- 不要引入 `spacing` / `typography` 之外的临时数值。

## Implementation

- 本文件的 YAML 是唯一来源。`packages/ui/tailwind-preset.js` 把它映射成 Tailwind 主题，`packages/ui/src/kit/__tests__/tokens.test.ts` 在两者不一致时失败。先改本文件，再改 preset。
- 组件在 `@compass/ui/kit`。包名里的 compass 是历史遗留，产品名是 Fine。
- 仅浅色。
