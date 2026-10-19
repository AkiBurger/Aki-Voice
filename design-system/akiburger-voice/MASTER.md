# AkiBurger Voice · 设计系统（MASTER）

> 本文件是本项目 UI 的**唯一权威规范**。任何界面改动都必须先读这里。
> 生成方式：用开源技能库 [ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) 的
> `--design-system` 与 `--domain` 检索生成，再由 Lead 按"深色桌面创作工具"场景校订。

---

## 0. 选型依据（来自技能库检索，不是拍脑袋）

| 维度 | 检索查询 | 命中结果 | 采用 |
|---|---|---|---|
| 风格 | `dark professional dashboard tool`（domain=style） | **Adobe Spectrum**（创作工具/媒体工作流/密集但清晰/强焦点态） + Dark Mode (OLED) | ✅ Spectrum 为主，OLED 深底为辅 |
| 配色 | `dark audio production studio professional`（domain=color） | **Podcast Platform**：Dark audio + warm accent（底 #0F0F23 / 卡 #1B1B30 / 主 #1E1B4B / 辅 #312E81 / 强调 #F97316 / 边 #4338CA） | ✅ 采用其色相，按对比度微调亮度 |
| 字体 | `technical developer tool dark`（domain=typography） | **Modern Dark Cinema (Inter System)**：单一字族、700 标题 / 600 小标题 / 400 正文、mono 用于代码 | ✅ 采用（离线回退到系统字） |
| UX | `dark mode contrast` / `keyboard shortcuts desktop`（domain=ux） | 文本对比 ≥4.5:1；焦点可见；完整键盘导航；tab 顺序与视觉一致 | ✅ 强制遵守 |

**产品定位**：本地 AI 声音克隆 / 配音工作台（桌面 Web UI，中文，深色）。用户长时间盯屏幕、频繁合成与试听，所以：**深底、低眩光、暖色 CTA、信息密度中等偏高、键盘可达**。

---

## 1. 设计基调

- **风格**：Adobe Spectrum 式创作工具 —— 语义化 token、精确层级、密集但可读的控件、强焦点态。
- **模式**：仅深色（不做浅色切换；`color-scheme: dark` 让原生控件跟随）。
- **设计旋钮**：Variance 3（克制） / Motion 2（微动效） / Density 7（偏密）。
- **一句话**：像专业音频软件一样克制，像消费级应用一样顺滑。

---

## 2. 颜色（语义 token，禁止组件里写裸 hex）

```css
:root {
  color-scheme: dark;

  /* 表面层级：从深到浅，最多用 3 层 */
  --bg:           #0B0B18;   /* 页面底 */
  --surface-1:    #14142A;   /* 侧栏 / 页头 */
  --surface-2:    #1B1B30;   /* 卡片 */
  --surface-3:    #27273B;   /* 输入框底 / 悬停 */
  --border:       #2C2C48;   /* 常规边框 */
  --border-strong:#4338CA;   /* 选中/强调边框（来自配色库） */

  /* 文字 */
  --fg:           #F8FAFC;   /* 主文字：对比 17:1 */
  --fg-muted:     #94A3B8;   /* 次要文字：对比 7.6:1 */
  --fg-faint:     #64748B;   /* 占位/禁用：仅用于非关键信息 */

  /* 品牌与交互 */
  --primary:      #6366F1;   /* 品牌/激活/边框色 */
  --primary-text: #818CF8;   /* 文字用主色（小字对比度 ≥4.5:1；--primary 仅 3.8~4.4:1，别拿来写小字） */
  --primary-soft: rgba(99, 102, 241, 0.14);
  --accent:       #F97316;   /* 唯一主 CTA（合成按钮） */
  --on-accent:    #0F172A;
  --ring:         #F97316;   /* 焦点环 */

  /* 语义状态 */
  --success:      #22C55E;
  --warning:      #F59E0B;
  --danger:       #EF4444;
}
```

**规则**
- 主 CTA 全站只有一个：**合成**（暖橙色 `--accent`）。其余按钮用 secondary / ghost。
- 激活态导航：`--primary-soft` 背景 + 3px `--primary` 左竖条。
- 危险操作（删除/清空）：文字按钮 + `--danger`，不做大色块。
- 不得使用渐变文字、霓虹发光、纯黑 #000 大面积背景。
- 正文 vs 背景对比必须 ≥ 4.5:1；`--fg-faint` 只能用于占位符/禁用态。

---

## 3. 字体

```css
--font-sans: "Inter", "Segoe UI", system-ui, "Microsoft YaHei UI", sans-serif;
--font-mono: "JetBrains Mono", "Cascadia Mono", Consolas, monospace;
```

| 层级 | 字号 | 字重 | 字距 | 用途 |
|---|---|---|---|---|
| Display | 40px | 700 | -1.2px | 评测大分数 |
| H1 | 24px | 600 | -0.4px | 页面标题 |
| H2 | 16px | 600 | 0 | 卡片标题 |
| Body | 14px | 400 | 0 | 正文（行高 1.55） |
| Input | 15px | 400 | 0 | 输入框/台词框 |
| Label | 12px | 500 | +0.02em | 字段名、按钮小字 |
| Caption | 12px | 400 | 0 | 辅助说明 |
| Mono | 12.5px | 400 | 0 | 日志、种子、分数数字 |

数字统一 `font-variant-numeric: tabular-nums`（分数、时间、进度不跳动）。

---

## 4. 间距 / 圆角 / 阴影

- 间距阶梯：`4 / 8 / 12 / 16 / 24 / 32 / 48`
- 卡片内边距 `20px`；卡片间距 `16px`；页面左右 `32px`
- 圆角：卡片 `12px`、按钮/输入 `8px`、胶囊 `999px`
- 阴影：卡片无阴影或 `0 1px 2px rgba(0,0,0,.24)`；浮层/下拉 `0 8px 24px rgba(0,0,0,.35)`
- **禁止** hover 位移（transform: translateY）造成布局跳动

---

## 5. 动效

- 时长 `150~200ms`，缓动 `cubic-bezier(.2,.6,.2,1)`
- 只允许动物理属性：颜色、背景、边框、透明度、阴影
- 禁止动画 width/height（进度条除外，用 transition 宽高由 JS 直接设值可接受）
- 必须支持 `@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition-duration: 1ms !important; } }`
- 悬停只改背景/颜色 + 150ms；按下可用 `filter: brightness(.95)`

---

## 6. 组件规范

### 按钮
| 类型 | 高度 | 样式 |
|---|---|---|
| Primary（合成） | 40px | `--accent` 底 + `--on-accent` 字，600 字重 |
| Secondary | 32px | `--surface-2` 底 + `--border` 边 |
| Ghost / 小工具 | 28px | 透明底，hover `--surface-3` |
| 危险文字按钮 | auto | `--danger` 文字，无底色 |

所有按钮：`cursor: pointer`（`disabled` 时 `not-allowed` + 透明度 .5）、`border-radius: 8px`、`transition: 150ms`。
**图标按钮必须带 `title` + `aria-label`**。

### 输入框
- 高 34px，背景 `--surface-3`，边框 `--border`，圆角 8px
- focus：边框 `--accent` + `box-shadow: 0 0 0 2px var(--primary-soft)`
- 错误：边框 `--danger` + 字段下方 12px 红字

### 卡片
- 背景 `--surface-2`、边框 1px `--border`、圆角 12px、内边距 20px
- 卡片标题：H2（16/600）+ 右侧操作区；不做整卡 hover 效果（列表卡片除外）

### 导航（侧栏）
- 宽度 220px；`<aside>` 背景 `--surface-1`，右侧 1px 边框
- 分组标题：Label 12/500 `--fg-faint`，上下间距 12px
- 导航项：高 34px、图标 18px、文字 13.5px；激活 = 3px 左竖条 + `--primary-soft` 底 + 文字 `--fg`
- 保留 `data-view` 属性；当前页 `aria-current="page"`

### 列表 / 表格
- 行高 36px（标注页 40px），hover `--surface-3`，行间 1px `--border`
- 名称左对齐、数值右对齐、操作最右

### 波形 / 播放器
- 波形画布高度 72px，填充 `--primary`，播放进度 `--accent`，背景 `--surface-3`
- 播放按钮 32px 圆形 ghost，图标 SVG

### 状态徽标
- 高 20px、字号 11px、圆角 999px、背景为对应语义色 12% 透明、文字为语义色

### 进度条
- 轨道 6px `--surface-3`，填充 `--primary`，圆角 999px

---

## 7. 图标（重要）

**禁止使用 emoji 作为图标**（技能库明确列为反模式）。全部改为**内联 SVG sprite**：

- 在 `index.html` 顶部放一个隐藏的 `<svg xmlns=... class="svg-sprite" aria-hidden="true">`，内含 `<symbol id="i-xxx" viewBox="0 0 24 24">`（Lucide 风格：`stroke="currentColor" stroke-width="1.75" fill="none" stroke-linecap="round" stroke-linejoin="round"`）。
- 使用方式：`<svg class="icon" aria-hidden="true"><use href="#i-play"/></svg>`，`.icon { width:16px; height:16px }`。
- 必需图标：`play pause square(stop) mic folder-upload search trash-2 pencil check x clock star chart settings download refresh-cw waveform plus chevron-down alert-triangle info cpu translate layers save rotate-ccw volume-2 eye filter eraser database`

---

## 8. 无障碍

- 全局 `:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }`
- 页面首个可聚焦元素是「跳到主内容」链接
- 侧栏 `<nav aria-label="主导航">`；内容区 `<main id="main">`
- 所有图标按钮 `aria-label`；纯装饰图标 `aria-hidden="true"`
- 弹窗/确认用原生 `confirm()` 可接受（v0.2）
- 键盘：Tab 顺序 = 视觉顺序；Ctrl+Enter 合成；Esc 关闭展开面板

---

## 9. 响应式

| 断点 | 行为 |
|---|---|
| ≥1440px | 基准：侧栏 220 + 内容 max-width 1160 居中 |
| 1100–1439px | 侧栏 220，合成页右栏 320 |
| <1100px | 侧栏收成 64px 图标版（`title` 提示），隐藏英文副标题 |
| <860px | 两栏变单栏；按钮一行最多 2 个；隐藏顶栏次要徽标 |

不允许出现横向滚动条。

---

## 10. 反模式（见到就打回）

- ❌ emoji 当图标
- ❌ 组件里写裸 hex（必须用 token）
- ❌ 低对比正文（<4.5:1）
- ❌ hover 位移/缩放导致布局跳动
- ❌ 0ms 状态突变（必须有 150–200ms 过渡）
- ❌ 焦点不可见
- ❌ 大面积纯黑 #000 或霓虹发光
- ❌ 多个主 CTA 争抢注意力
- ❌ 浅色卡片混进深色界面

---

## 11. 交付前检查清单

- [ ] 无 emoji 图标，全部内联 SVG sprite
- [ ] 颜色全部走 token，无裸 hex
- [ ] 正文对比 ≥4.5:1（用 `--fg` / `--fg-muted`，不用 `--fg-faint` 承载信息）
- [ ] 所有可点击元素 `cursor:pointer`，图标按钮有 `aria-label`
- [ ] `:focus-visible` 可见（Tab 走一遍全页）
- [ ] 过渡 150–200ms，且 `prefers-reduced-motion` 生效
- [ ] 无双栏布局在 <860px 溢出
- [ ] 无横向滚动（1440/1100/860 三档实测）
- [ ] 数字使用 tabular-nums
- [ ] 深色下滚动条、原生 select/audio 已深色化（`color-scheme: dark`）
- [ ] 页面 6 个视图都能进入且不报错
