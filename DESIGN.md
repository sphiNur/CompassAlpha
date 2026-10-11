---
version: alpha
name: Fine
description: 餐厅采购与门店运营工具。一个亮绿色负责所有主操作，浅灰绿底上的白色大圆角卡片，每屏最重要的数字最大。
colors:
  primary: "#9FE870"
  primary-pressed: "#8AD95C"
  primary-pale: "#E2F6D5"
  on-primary: "#163300"
  forest: "#163300"
  ink: "#0E0F0C"
  secondary: "#5D6159"
  neutral: "#FFFFFF"
  surface: "#F0F2EE"
  surface-sunken: "#E3E6DF"
  field: "#FFFFFF"
  line: "#C8CCC2"
  contrast: "#0E0F0C"
  on-contrast: "#9FE870"
  hero: "#0E0F0C"
  on-hero: "#9FE870"
  hero-text: "#DDE3D2"
  warning: "#FFD11A"
  warning-pale: "#FFF5CC"
  on-warning: "#3A2F12"
  warning-ink: "#4A3B1C"
  danger: "#D03238"
  danger-pale: "#FBE1DF"
  danger-ink: "#8E1F1C"
  on-danger: "#FFFFFF"
colors-dark:
  primary: "#9FE870"
  primary-pressed: "#8AD95C"
  primary-pale: "#163300"
  on-primary: "#163300"
  forest: "#9FE870"
  ink: "#F4F6F1"
  secondary: "#B6BAAF"
  neutral: "#121511"
  surface: "#2A2D29"
  surface-sunken: "#3A3E38"
  field: "#121511"
  line: "#51564D"
  contrast: "#F4F6F1"
  on-contrast: "#0E0F0C"
  hero: "#163300"
  on-hero: "#9FE870"
  hero-text: "#DDE3D2"
  warning: "#FFD11A"
  warning-pale: "#4A4023"
  on-warning: "#3A2F12"
  warning-ink: "#FFE680"
  danger: "#E5534F"
  danger-pale: "#3A1B1A"
  danger-ink: "#F3A6A2"
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
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  h2:
    fontFamily: system-ui
    fontSize: 1.375rem
    fontWeight: 600
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
  small:
    fontFamily: system-ui
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.45
  caption:
    fontFamily: system-ui
    fontSize: 0.8125rem
    fontWeight: 600
    lineHeight: 1.35
  money:
    fontFamily: system-ui
    fontSize: 1rem
    fontWeight: 700
    lineHeight: 1.2
    fontFeature: "tnum"
  money-lg:
    fontFamily: system-ui
    fontSize: 1.5rem
    fontWeight: 800
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
  page: 16px
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

2026-10-11 用户决定前端从零重做，设计语言取自 Wise。参照物有两个，冲突时以第二个为准：

1. getdesign.md 的 wise 条目（分析的是 Wise 官网）。
2. 用户给的 Wise 手机应用截图，7 个界面各有深浅两套（仓库外 `design-refs/wise-screens/`）。

批准的方案见 `docs/FRONTEND-PLAN.md`。

三条原则：

1. **打开就是待办。** 第一屏回答"现在有什么事等着我"。
2. **干活时全屏，一个按钮。** 进入一件事之后没有底部导航，只有内容和吸底的一个主按钮。
3. **数字最大。** 每屏最重要的那个数用最粗的字，放在 `hero` 色块里，每屏至多一块。

## 从 Wise 应用截图里量到并采纳的

截图宽 588 像素，对应 393 个单位，量到的像素除以 1.5。

| 项目 | 截图 | 这里 |
|---|---|---|
| 页面底色 | 浅色纯白，深色近黑 | `neutral` |
| 卡片 | 浅灰填充，圆角约 24，内边距约 16，无阴影无描边 | `surface`，`rounded.lg` |
| 可以添加的东西 | 虚线描边的卡片 | 同样；用于"加一个…"和空状态 |
| 页边距 | 16 | `spacing.page` |
| 列表行 | 行与行之间没有分隔线，靠留白 | 同样 |
| 行的文字 | 粗标题 16，灰色说明 14 | `label` + `small` |
| 页面标题 | 约 26–28，粗，但不是最粗 | `h1` 28 / 700 |
| 小节标题 | 约 22，半粗 | `h2` 22 / 600 |
| 分组标签 | 14，常规字重，不大写 | `small` |
| 按钮、搜索框、分段选项 | 胶囊形 | `rounded.pill` |
| 底部导航 | 悬浮的胶囊条，选中项有灰色胶囊底 | 同样 |
| 提醒 | 浅黄底卡片 | `warning-pale` |
| 主色 | 亮绿只在主按钮、选中的小标记、角标上 | 同样 |

没有照做的：

- **按钮高度**。截图里约 40；这里是 52，因为用户单手、戴手套。
- **商品行左边的圆形**。截图里每行都有一个 48 的圆。门店、人、任务类型有东西可放，照做；商品目录有两百行，放一个只有首字母的圆不提供信息。
- **全大写的超大姓名**。那是专有字体的品牌瞬间；而且大写转换在土耳其语里会出错。整个界面不做任何大写转换。
- **输入框不描边**。截图里金额输入框是灰卡片上的白块。日光下白和浅灰分不清，这里保留一圈细线。
- **导航上约 11 的小字**。这里最小 13。

## Colors

每个颜色都有浅色和深色两个值（`colors` 与 `colors-dark`），实现成 CSS 变量。屏幕里不出现色值，只出现名字。

- **Primary 亮绿，配墨色字。** 唯一的强调色，只用于主操作。它不做文字色；需要绿色的字用 **Forest**。
- **Neutral 是页面，Surface 是卡片，Field 是输入框。** 浅色下是白、浅灰、白；深色下是近黑、深灰、近黑。层次靠这三者的深浅，不用阴影。
- **Surface-sunken** 是卡片上再下沉一层的填充：次按钮、未选中的选项、数量增减、现金标记。
- **Contrast / On-contrast** 是小面积的最强对比：选中的选项、转账标记。浅色下是墨底亮绿字，深色下是浅底墨字（深色下如果也用亮绿，会和主按钮分不清）。
- **Hero / On-hero** 是放屏级数字的色块：浅色下墨底亮绿字，深色下深绿底亮绿字。
- **状态三种**：完成 `primary-pale` + `forest`；等待 `warning-pale` + `warning-ink`；有问题 `danger-pale` + `danger-ink`。主色不兼作成功色。
- **付款方式**：现金是下沉填充加墨字，转账是 `contrast`。任何一屏都放在金额正下方、与金额对齐。

深浅对比里**不变**的：亮绿主按钮和它上面的墨色字；圆角、间距、字号；状态的三种含义。**会变**的：页面、卡片、输入框的明暗关系整体反过来；绿色文字从深绿变成浅绿；最强对比从"墨底"变成"浅底"。

## Typography

系统字体：要同时显示拉丁、西里尔、汉字、假名和阿拉伯字母，系统字体最稳，也不用下载。

- 最粗的字（900）只给 `display`，也就是 `hero` 里的数字。页面标题 700，小节标题 600，按钮和行标题 600，其余 400。
- 正文和行标题 16，说明 14，标记 13，没有更小的字。
- 金额一律等宽数字。

## 多语言与方向

要支持英文、中文、俄文、乌兹别克文、维吾尔文、土耳其文、日文，以后还会加。

- **任何地方都不依赖文字的长度。** 放不下就换行，不截断，不缩小，不写死宽度。
- **能从右到左。** 维吾尔文按阿拉伯字母处理。间距和对齐只用"开头 / 结尾"，不写左右；指方向的符号（›）在从右到左时翻转。
- **数字不翻转。** 金额、数量增减（− 数量 +）在任何语言里都从左到右，并与周围的文字隔离。
- **不做大写转换。** 土耳其文的 i / İ 规则特殊。
- 加一种语言只加一个文案文件；CI 检查所有已登记语言的键一致。

## Layout

- 页边距 16，区块间距 24。
- 列表行最小高 56，触摸目标至少 44。
- 宽屏上整个应用居中成一列。

## Shapes

- `rounded.lg` 24：卡片、列表、色块、弹层顶角。
- `rounded.md` 16：输入框。
- `rounded.sm` 12：小块填充。
- `rounded.pill`：按钮、分段选项、数量增减、导航、状态与付款方式标记。

## Do's and Don'ts

**Do**
- 每个元素都要有功能或含义：拿掉它，用户会少知道一件事或少做成一个动作吗？不会就删。
- 每屏一个主操作，吸底。
- 图标必须和文字一起出现。
- 空状态和错误状态都给出下一步。

**Don't**
- 不要把亮绿当文字色，不要在亮绿上再放绿色。
- 不要引入第二个强调色。
- 不要用阴影做层次；描边只用于输入框和"可以添加"的虚线卡片。
- 不要把三个以上动作并排成一行。
- 不要只有图标没有文字。
- 不要写左、右，不要写色值，不要引入 `spacing` / `typography` 之外的临时数值。

## Implementation

- 本文件的 YAML 是唯一来源。`packages/ui/tailwind-preset.js` 把它映射成 Tailwind 主题和 CSS 变量，`packages/ui/src/kit/__tests__/tokens.test.ts` 在两者不一致、或深色缺了某个名字时失败。先改本文件，再改 preset。
- 组件在 `@compass/ui/kit`。包名里的 compass 是历史遗留，产品名是 Fine。
- 深色跟随系统（Telegram 内跟随 Telegram 的主题）；`data-theme` 可以强制。
- 截屏：`E2E_SHOTS_DIR=<目录> pnpm test:e2e` 出浅色，加 `E2E_COLOR_SCHEME=dark` 出深色。
