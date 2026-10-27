---
title: Typst 区域编辑
description: 模板负责页面，Tiptap JSON 保存分区域正文，Agent Markdown 编辑同一份内容；支持图表题注、LaTeX 公式和交叉引用。
---

`@pluxel/plugin-typst` 将模板设计和正文编辑分开：**Typst 模板掌管页面，Tiptap JSON 是正文权威，Agent Markdown 是同一正文的编辑投影。** 编辑器和 agent 可以修改基础文字样式、对齐、图片、表格、题注、公式和引用；模板决定页面、章节组合、行距、段间距、缩进、题注位置和编号格式。

`TypstRegionEditor` 默认带完整编辑界面；`onChange` 交付原生正文快照，保存、业务数据和编译由宿主连接。Typst 负责最终换行与分页，不把编辑器的浏览器排版视作最终页面，也不从任意 Typst 源码反解 Tiptap JSON。

| 要完成的任务                     | 从这里开始                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------- |
| 在 React 应用里编辑正文          | [安装依赖](#入口与安装) → [挂载一个区域](#最小-react-接入)                      |
| 已有 Tiptap Editor，自己组合界面 | [原生编辑器与自定义控件](#业务数据与自定义控件)                                 |
| 按章节填写并组成完整报告         | [模板与正文区域](#模板与正文区域) → [准入、生成与编译](#准入生成与编译)         |
| 编辑图题、表题、公式和引用       | [图表、公式与交叉引用](#图表公式与交叉引用) → [Agent Markdown](#agent-markdown) |
| 把正文排版为预览或 PDF           | [准入、生成与编译](#准入生成与编译) → [预览与定位](#预览与定位)                 |

服务端仍使用 [TypstPlugin](./typst.md)，文档定义仍是 `/template` 的 `defineTypstDocument({ template, schema, createFiles? })`。Monaco、worker 和 Vite 接线由消费应用拥有。

源码仓库可运行 `mise exec -- vp run @pluxel/plugin-typst#compile`，再运行 `mise exec -- vp run typst` 打开体验页；保存范围及操作见 [consumer 说明](https://github.com/PluxelJS/pluxel/blob/main/plugins/render/typst/tests/consumer/README.md#interactive-browser-playground)。

体验页在服务 URL 后加 `/?example=operations-report` 打开图表报告：左侧为“正文 / 数据”，右侧为“Typst 预览 / 原始 Typst / Markdown”三个标签。示例包含文字排版、带题注的图表组件、表格、LaTeX 公式和跨区域引用；Markdown 默认实时显示当前区域或选中块，点击“编辑这份 Markdown”固定候选，经检查接纳后更新正文与排版，并回到同一标签的实时内容。原始 Typst 可编辑外层模板；手机通过“编辑 / 预览”切换左右面板，面板内保留同样的标签。

## 入口与安装

本包当前为 workspace 内的 **private 包，未发布到 registry**。先通过项目既有 workspace 或构建制品流程接入本包；下面命令只补齐所选编辑器入口的第三方依赖。

| 入口            | 能力                                                                | 编辑器依赖                                               |
| --------------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| 包根            | native Plugin、会话、PDF                                            | 无 Tiptap / React 依赖；服务端装配见 [Typst](./typst.md) |
| `/template`     | 纯文档定义                                                          | 无                                                       |
| `/browser`      | 无框架预览、页码/目录和双向定位                                     | 无                                                       |
| `/tiptap`       | 原生 JSON 校验、扩展、Markdown、区域生成；可在无 DOM 的 Node 中使用 | 下列基础依赖                                             |
| `/tiptap/react` | 字段 NodeView、区域组件和完整编辑 UI                                | 基础依赖 + React UI 依赖                                 |

基础编辑器依赖使用同一 Tiptap 版本：

```sh
npm install @tiptap/core@3.32.0 @tiptap/pm@3.32.0 @tiptap/starter-kit@3.32.0 \
  @tiptap/extension-table@3.32.0 @tiptap/extension-image@3.32.0 \
  @tiptap/extension-text-style@3.32.0 @tiptap/extension-text-align@3.32.0 \
  @tiptap/extension-mathematics@3.32.0 @tiptap/suggestion@3.32.0 \
  @tiptap/markdown@3.32.0 katex@0.16.22
```

React 完整界面再安装以下依赖；已有 React 19 应用保留同一份 React 实例：

```sh
npm install react@19.3.1 react-dom@19.3.1 @tiptap/react@3.32.0 @tiptap/extensions@3.32.0 \
  @tiptap/extension-drag-handle-react@3.32.0 @tiptap/extension-drag-handle@3.32.0 \
  @tiptap/extension-node-range@3.32.0 @tiptap/extension-collaboration@3.32.0 \
  @tiptap/y-tiptap@3.0.7 yjs@13.6.27 y-protocols@1.0.6
```

TypeScript React 项目还需自己的 `@types/react` / `@types/react-dom` 19.x 类型依赖。块拖动复用官方 [DragHandle React](https://tiptap.dev/docs/editor/extensions/functionality/drag-handle-react)，其 peer 链带来 collaboration/Yjs 依赖；区域编辑器没有启用多人协作，也没有替换原生 history。本包直接声明的编辑器 peers 均为 optional；清单同时包含官方扩展要求的间接 peers。只消费编译或预览时不需要这组依赖，选用对应编辑器入口后则必须满足。

样式单独从 `@pluxel/plugin-typst/tiptap/style.css` 导入，由宿主决定加载；它同时引入 KaTeX 样式，公式字体资源随应用的 CSS 打包。JS 和声明入口不隐式加载 CSS，保留 Node / SSR 导入能力。样式作用于 `.typst-*` 控件及带表格外观标记的官方表格 DOM，不改变未安装样式扩展的表格；宿主可用 CSS 变量调整配色。浏览器只从子路径导入运行时值，不导入包根；包级 native 下载与根入口 peer 元数据仍存在。

独立制品验收会把构建结果移出工作区，显式安装各阶段 peers，使用 `npm --legacy-peer-deps --ignore-scripts` 检查无源码 alias 的导入、严格类型、浏览器构建及真实 native/PDF。它不证明 registry 发布或所有包管理器的自动 peer 安装路径已验证；具体阶段见 [制品验收](https://github.com/PluxelJS/pluxel/blob/main/plugins/render/typst/tests/consumer/README.md#isolated-package-acceptance)。

## 模板与正文区域

正文直接保存各区域的 Tiptap `JSONContent`。宿主持有模板身份/修订、原始业务输入和区域 JSON；区域声明属于模板配置。一个区域对应一份可独立填写的正文，例如“经营分析”“后续行动”。界面可以按文件或章节导航，但目前的持久化仍是原生 JSON 草稿，不生成另一份需要同步的 `.md` 正文文件。

生成器为区域产生 `_editor/regions/<regionId>.typ`。模板使用 Typst 自身的 `#include` 组合正文，不需要在 Tiptap AST 或 Markdown 中模拟文件依赖：

```typst
#set par(leading: 0.65em, spacing: 1em, first-line-indent: 2em)

= 经营分析
#include "/_editor/regions/analysis.typ"

= 后续行动
#include "/_editor/regions/actions.typ"
```

上例的绝对路径从模板根解析；主模板也可以先包含其他 `.typ` 章节，再由章节引入对应正文。只有最终被主模板包含的内容进入报告；引用目标也必须实际进入同一份 Typst 文档。生成文件供模板消费，不作为用户可写源码打开。

基础文字格式和段落对齐允许局部覆盖；清除覆盖后恢复模板继承。列表层级属于正文，普通段落首行/左右缩进、行距、段间距、分栏和固定左右布局由模板安排。固定图表和文字块可以由模板或注册组件组合；当前正文没有通用可编辑双栏容器。

## 区域、数据与原生编辑

### 最小 React 接入

下面是一个完整单区域组件。`documentKey` 由宿主提供，稳定标识当前打开的草稿；`onSnapshot` 接收编辑后的原生 JSON，宿主决定何时保存。未传入 `onValidationError` 时，组件以 `role="alert"` 显示初始内容和编辑事务的准入错误。

```tsx no-twoslash
import '@pluxel/plugin-typst/tiptap/style.css'
import type { JSONContent, TypstEditorConfig } from '@pluxel/plugin-typst/tiptap'
import { TypstRegionEditor } from '@pluxel/plugin-typst/tiptap/react'

// Stable configuration; add fields and extensions only when needed.
const config: TypstEditorConfig = { regions: [{ id: 'body' }], fields: [] }
const initialContent: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }

export function Body({
	documentKey,
	onSnapshot,
}: {
	documentKey: string
	onSnapshot(content: JSONContent): void
}) {
	return (
		<TypstRegionEditor
			key={documentKey}
			regionId="body"
			config={config}
			content={initialContent}
			data={{}}
			onChange={onSnapshot}
		/>
	)
}
```

加载已有草稿时，将 `initialContent` 换成经校验的该区域 JSON。`data={{}}` 适用于没有数据字段的正文；需要字段时传入下文说明的 schema 解析结果。`onValidationError` 接管错误呈现：传入后组件不再显示默认 alert，宿主需自行展示初始准入和编辑失败，并在成功编辑、文档替换时清除陈旧状态。初始失败通过挂载后的回调报告，不创建 Editor。

### 保存、替换与切换区域

`content` 是当前原生 Editor 实例的初始快照；`onChange` 向宿主报告最新原生 JSON，不把组件变成受控输入。同一实例后续收到的 `content` 不替换或卸载现有正文，即使新值无效也不会覆盖已接纳内容。`data` 只更新字段显示。`regionId` 或扩展数组身份改变会创建新 Editor，因此应保持 `config`、`extensions` 稳定，并为每个区域保留自己的组件。

宿主校验另一份完整草稿后，传入其区域 JSON 并更新 `documentKey`。换文档、模板修订或重新加载同一保存槽都使用新 key 挂载，并清除旧候选与定位；这样不会沿用被替换草稿的 history。正常编辑、保存快照或更新业务数据时保持 key，避免重建正在使用的 Editor。初始准入失败没有创建 Editor；修正初始 JSON 后，也需提供新 key 重试。

多个区域在 `config.regions` 中分别声明。为每个区域挂载一个 `TypstRegionEditor`，使用稳定的 `${documentKey}:${regionId}` 作为 React key，并在外层容器用 `hidden` 切换可见区域；不要只渲染当前区域再反复卸载。每个区域保留自己的 Editor/history，`onChange` 按 `regionId` 保存对应 JSON；卸载组件会释放 Editor。需要跨区域 `@` 补全时，将当前完整区域集合传入 `regions={draft.regions}`；组件以当前原生 Editor 的内容覆盖同名区域快照，避免自己的未保存修改落后于候选列表。未提供 `regions` 时只列出当前区域的对象。

### 业务数据与自定义控件

字段路径是非空 `string[]`，不使用点号拆分；例如 `['items', '0', 'name']` 可读取数组首项。路径按实际父值解释：数组使用索引，对象仍使用字符串键，因此对象的 `'0'` 键不会被改成数组访问。`data` 必须是宿主 schema 解析后的输出；仅绑定声明过的 string/number/boolean，nullable 字段需显式配置 `nullText`。字段在 React 中不可直接改文字，但可以通过原生命令删除整个节点。更新 provider 数据只改变显示，不产生正文 transaction 或 undo 记录。草稿只保存原始业务输入；解析输出仅用于展示和一次编译，不能回写草稿，否则 transform 会重复执行。

官方 StarterKit、TableKit、Image 提供标题、列表、引用、代码、格式、表格和逻辑图片。区域的 `nodes`、`marks`、`fields` 可缩小允许范围；它们是内容规则，不能代替宿主授权。Link 默认接受可解析的完整 http(s) 地址、mailto、tel 和页内锚点；URL 检查不改写保存的原字符串。`allowLink` 可提供宿主自己的规则，空值、空白和控制字符仍会拒绝。图片 `src` 是宿主逻辑 ID，`resolveImage(id)` 将它映射到预备好的 `/inputs/` 资源，不读取任意磁盘路径。

`children(editor)` 可在常驻条下、正文上添加业务参数表单等控件。确需自定义常驻条时设置 `toolbar={false}`，然后在 `children` 内组合 `TypstEditorToolbar` 与原生命令，沿用区域的权限、字体选项和输入法状态；关闭常驻条不会关闭右键、键盘菜单或 slash。

`placeholder` 设置空段落提示。`slashCommands` 向常驻“插入”、块旁“＋”和 slash 添加宿主业务操作；一份声明覆盖三种入口。回调只组合传入的原生 chain，共享菜单负责在需要时删除 `/query`，并执行一次 transaction；不要在回调中调用 `run()`、`focus()`、`dispatch` 或产生外部副作用，预演可多次执行该回调：

```tsx no-twoslash
import type { TypstSlashCommand } from '@pluxel/plugin-typst/tiptap/react'

const extraCommands: TypstSlashCommand[] = [
	{
		id: 'supplement',
		title: '补充说明',
		keywords: ['说明', 'note'],
		command: (chain) => chain.insertContent('请核对相关资料。'),
	},
]
// <TypstRegionEditor {...props} slashCommands={extraCommands} />
```

已有界面可直接组合 `createTypstExtensions` / `createTypstReactExtensions` 与官方 `Editor`、`useEditor`、`EditorContent`，自行处理原始输入准入。

`createEditorExtensions()` 保留基础官方 Tiptap 扩展组合，可直接用于普通 `Editor`。`createTypstExtensions(config)` 加入数据字段、图表及题注、官方 LaTeX 数学节点、结构化引用和宿主的 `config.extensions`；`createTypstReactExtensions` 提供相应 NodeView。表格样式、模板组件和源码块仍分别显式安装，不因支持图题或公式而开放任意源码。

这一层沿用官方 Tiptap `Editor`、commands 和扩展，不要求宿主学习另一套编辑协议。原生接入方式可对照 [Tiptap React](https://tiptap.dev/docs/editor/getting-started/install/react)，自定义持久化节点仍须满足本页的[业务节点与输出](#业务节点与输出)契约。

### 默认编辑界面

`TypstRegionEditor` 默认提供完整编辑界面。常驻条提供撤销/重做、段落/标题样式、字体、字号、加粗/斜体/下划线、文字色/高亮、清除文字格式、段落对齐、无序/有序列表、链接和插入；在列表内显示增加/减少缩进。工具组随编辑容器宽度换行；容器不超过 420px 时，字体选择收至“…”（格式）的完整面板，字号与颜色仍可直接操作。常驻控件与右键面板复用同一命令、权限和原生选区。

文字右键、`Shift+F10` / 菜单键和“格式”按钮打开同一个完整面板，按钮也适用于触屏。选择文字不会自动弹层。已有选区内右键保留范围，选区外右键先把光标移到点击处；光标处也能设置接下来输入的文字格式。进入表格时，常驻条下显示表格尺寸与常用结构操作；“更多…”、完整面板和表边入口提供表格样式及完整结构操作。只读或输入法组合输入期间不拦截文本右键，源码 textarea 和卡片中的只读数据文本也保留浏览器菜单。可用项随区域规则与 `editable` 权限变化，最终准入仍由同一原生 transaction 校验。

字段、表格、已安装的模板组件/源码块和宿主业务动作集中在“插入”菜单，也可输入 `/` 搜索；宿主不再逐项拼装字段或组件选择器。“插入”使用当前原生选区，slash 只删除本次查询文本；块前的“＋”在指定块后插入，选择内容前不产生空段落或撤销记录。三种入口复用同一命令与准入检查。选择“表格”后填写行数、列数和是否首行表头，默认 3×3 并启用首行表头；行数允许 1–50、列数允许 1–20，越界显示错误，不自动截断。取消不会修改正文或删除 slash 查询。插入与块操作菜单采用非模态焦点：Tab 沿浏览器顺序移出即关闭，Escape 从弹层内任意控件取消并返回入口；输入法组合输入期间不接管 Escape。

普通段落、标题、引用、列表、表格和图片有就地块操作入口。点击操作柄可转换类型、复制、删除或上下移动，拖动操作柄可调整顺序；键盘与触屏也可用当前块入口和移动按钮；`Alt+F10` 聚焦当前块入口，`Shift+F10` 仍打开文字格式。目标是打开菜单时的整个顶层块，表格不会误作用于一个单元格。转换只提供当前结构能完整保留内容的选项；复杂结构不能通过转换悄悄丢掉内容。菜单打开后正文变化会取消旧目标。模板组件与源码块沿用卡片自己的入口；复制中的实例使用新 ID，移动保留原 ID，操作支持原生撤销。

### 文字格式与导入规则

“清除文字格式”移除选区的可清除文字 Mark，包括链接和四项排版；空光标处清除后续输入格式。它遵循原生扩展的 `clearable: false` 保护，保留段落结构与对齐。通过链接按钮或 `Mod+K`（macOS 为 Command，其他平台为 Ctrl）添加或修改链接：选中文字时修改该范围，在已有链接中修改整个链接，在空光标处可输入显示文字并插入。链接面板可以移除链接或在新标签打开当前有效地址。URL 遵循相同的区域与链接准入规则，错误不会回写正文。输入链接、字号等控件时，原生文字选区继续高亮。

字体、字号、文字颜色和背景颜色与加粗等基础格式共用当前原生选区；格式面板内连续调整时保持面板。字体菜单来自 `TypstRegionEditor.fontFamilies`，传入字体家族名，该参数只提供选择项，不安装字体；省略且当前正文没有字体时，字体菜单禁用。后端通过 [Fonts](./fonts.md) 或会话字体输入提供真实字体，浏览器能否显示同一字体取决于宿主 CSS 和本机字体；最终排版以 native 预览/PDF 为准。字号菜单提供常用 pt 值；颜色菜单提供色板、自定义十六进制色值和单独清除。“清除排版”只移除这四项，保留加粗、链接、段落结构与对齐；选择“模板字体/模板字号”恢复继承模板。混合选区的字体、字号、颜色、段落样式与对齐明确显示“混合”，不会用首段的值代表整个范围；空光标优先显示原生后续输入格式。每次操作沿用原生事务和 undo。

这些格式复用官方 [TextStyleKit](https://tiptap.dev/docs/editor/extensions/functionality/text-style-kit) 的 `textStyle` Mark，仍存于同一份原生 JSON：

| 属性              | 准入值                                                                                                                                            | Typst 输出             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `fontFamily`      | 单个由 Unicode 字母/数字、空格或连字符组成的家族名，可带一对外层引号；数字开头的词需加外引号，如 `"DIN 1451"`。不接受列表、转义或 CSS-wide 关键字 | `text(font: ...)`      |
| `fontSize`        | 正数 `pt` 或 `px`，`1px = 0.75pt`                                                                                                                 | `text(size: ...)`      |
| `color`           | 十六进制 3/4/6/8 位，或整数 RGB 通道的 `rgb()` / `rgba()`                                                                                         | `text(fill: ...)`      |
| `backgroundColor` | 同上，支持 alpha                                                                                                                                  | `highlight(fill: ...)` |

`null` 表示继承。区域的 `marks` 显式允许 `textStyle` 才开放这些排版设置；未声明 `marks` 时与其他内置 Mark 一样可用；只读和输入法期间说明禁用原因。无效值、相对字号、CSS 变量和未知样式均明确拒绝。HTML 的受控 `span style` 可以保留四项格式；导入沿用浏览器 CSSOM 的等价表示，例如 `rgb()` 色值和字体外层引号，已保存的原生 JSON 不因此改写。普通 Markdown 不承载它们，导出返回 `lossless: false` 和格式损失诊断，候选不能有损覆盖原生 JSON。供 agent 编辑时使用下文的 [`format: 'agent'`](#agent-markdown) 保留这些格式。

段落对齐复用官方 [TextAlign](https://tiptap.dev/docs/editor/extensions/functionality/textalign)，作用于 `paragraph` 和 `heading` 的 `attrs.textAlign`，支持 `left`、`center`、`right`、`justify`；`null` 或缺省继承模板。选择“模板对齐”清除覆盖，原生 `setTextAlign` / `unsetTextAlign` 与 `Ctrl/⌘+Shift+L/E/R/J` 快捷键仍可用。JSON、HTML 和 Typst/PDF 保留对齐；显式左、中、右对齐在该段关闭模板的两端对齐，清除后恢复模板规则。HTML 接受 `<p>`、`<h1>` 至 `<h6>` 上单个 `style="text-align: center"` 形式的声明，值限上述四项；不接受额外 CSS、重复声明、`!important` 或 `start/end/inherit`。普通 Markdown 无法承载显式对齐，导出返回 `lossless: false` 并在 `attrs.textAlign` 给出诊断；候选不能有损替换该范围。Agent Markdown 通过 `:::attrs` 保留对齐，复杂节点再使用局部原生表示。

## 图表、公式与交叉引用

### 题注、label 与对象身份

图片、表格和已安装的模板组件/源码块都可以添加题注。选中未包装的对象，在工具条点击“添加图题”或“添加表题”；正文保存一个 `figure`，其中依次包含原对象和 `figureCaption`。表格仍使用原生 TableKit 编辑，题注是可直接编辑的富文本，与对象一起移动、复制和删除，不是旁边恰好相邻的独立段落。

在题注末尾按 Enter 进入图表后的正文段落；若已有紧邻的段落则直接进入，否则插入一个新段落，可单次撤销。Shift+Enter 仍在题注内换行。

| 信息    | 保存位置与用途                                                       |
| ------- | -------------------------------------------------------------------- |
| 题注    | `figureCaption` 的行内内容，说明图表；可以有基础格式、字段或行内公式 |
| `label` | 图表或独立公式的可编辑标签，如 `fig:revenue`；交给 Typst 生成标签    |
| `id`    | 对象的稳定身份；结构化引用保存这个值，不随题注或 label 改名          |
| 编号    | 不保存到正文；由 Typst 按实际文档顺序和模板规则计算                  |

图题、表题与常驻的“引用 label”输入框排列在图表内容下方同一行，直接编辑即可；独立公式也使用相同的 label 输入。按 Enter 或离开输入框时校验并提交，一次撤销可恢复；Escape 恢复正文当前值，不产生新的正文修改。格式错误、重名或提交冲突会保留本地输入并提示原因，可以修改后再提交，也可以使用“恢复 label”放弃输入。label 与题注、公式源码分别编辑，不需要展开设置面板。

label 以字母或数字开头，支持中文等 Unicode 字母，后续可含字母、数字、组合标记、冒号、点、下划线或连字符，最长 128 个字符；整份区域集合内不能重复。id 由编辑命令生成；通过 agent 新建对象时需提供唯一 id。原始 JSON 校验不自动补写或改名修复冲突。

图表和独立公式可以没有 label，此时输出不编号，也不能成为结构化引用目标。设置 label 时必须有稳定 id。清空已有 label 或删除对象后，引用节点保留，编辑器显示目标缺失；生成器返回 `INVALID_REFERENCE`，不会把坏引用静默转换成文字。修复目标、重新设置 label 或删除不再需要的引用后继续生成。

改题注和 label 不改变 id，因此正文中的结构化引用继续指向同一对象。移动保留身份；复制分配新 id 与 label，复制子树内同时包含的引用随复制对象重绑定。同一界面会话内剪切后首次粘贴会在原对象确已移除、目标允许该内容且无身份冲突时保留身份；再次粘贴按复制处理。**模板或原生源码中手写的 `@旧label` 不属于这套结构化引用，修改 label 后需显式更新这些源码。**

底层命令为 `insertTypstFigure({ body, caption?, label? })`、`wrapTypstFigure(position, caption?)`、`duplicateTypstFigure(position)` 和 `insertTypstReference(targetId)`；题注内容和属性修改仍使用原生 Tiptap transaction。所有输入必须满足当前 schema、区域准入和属性校验。

### LaTeX 公式

公式直接保存 LaTeX 源码，复用官方 [Tiptap Mathematics](https://tiptap.dev/docs/editor/extensions/nodes/mathematics) 的 `inlineMath` / `blockMath` 节点和命令。通过“插入”或 `/` 选择行内、独立公式；点击公式会在原位置展开 LaTeX 编辑框，草稿实时更新局部 KaTeX 预览。按 Ctrl/⌘+Enter、点击“完成”或离开编辑框时提交并收起，一次撤销恢复源码；Escape 或“取消”放弃未提交输入。行内公式同样在正文原位置编辑，不弹出浮层。

独立公式的 label 单独编辑和撤销，修改源码不会同时修改 label；行内公式没有编号和引用身份。只读区域可以展开源码查看，不能提交修改。尚未提交或校验失败的 label / LaTeX 输入仍参与宿主的保存和离开检查。

编辑器用 KaTeX 显示，Typst 输出调用固定的 [MiTeX 0.2.7](https://typst.app/universe/package/mitex/)。同一份 LaTeX 贯穿 JSON、Markdown 和编译，不做 LaTeX 与 Typst 数学语法的双向改写。KaTeX 与 MiTeX 的命令和宏支持并不完全相同：编辑器预览错误与最终编译错误分别展示，公式源码保留供修复；成功在其中一端显示不等于另一端已验证。

包含公式时，生成结果附带 `_editor/mitex/` 的固定运行时、许可和声明。它是现有 `templateFiles` 内的文本资源，WASM 通过 JSON 字节数组加载；不依赖部署机器的 MiTeX 包缓存，不在编译时联网下载，也不要求异步初始化 JavaScript 转换器。公式资源合计约 0.82 MiB，会计入宿主模板资源预算。浏览器 WASM 编译仍需宿主显式加载合适的数学字体，模板选择其实际家族名；native 的字体契约见 [Typst](./typst.md)。

### 输入 `@` 插入引用

在正文或题注中输入 `@`，使用官方 [Suggestion](https://tiptap.dev/docs/editor/api/utilities/suggestion) 补全。候选按 label、题注/公式源码、类型和区域搜索；上下键选择、Enter 插入、Escape 关闭。节点保存 `{ type: 'reference', attrs: { target: '稳定id' } }`。编辑器显示当前 `@label`，不猜测最终“图 2”“式 (3)”编号。

跨区域补全需要 `TypstRegionEditor.regions` 提供整份报告的当前 JSON。独立宿主可用 `collectTypstReferenceTargets(regions, config?)` 取得 `{ id, label, kind, regionId, title, position }`；输入应先准入，`position` 是该区域的原生位置，不是跨文件全局坐标。只校验单一区域不能判断另一份文件的目标是否存在；`generateTypstRegions` 针对完整集合解析引用并检查重复 id / label 和缺失目标。

### 由模板统一排版

生成器将图表映射成 Typst `figure`，表格使用 `kind: table`；独立公式使用 MiTeX 生成的 `math.equation`，引用解析成目标当前 label。模板直接使用 Typst 的规则，例如：

```typst
#set math.equation(numbering: "(1)")
#show figure.where(kind: table): set figure(supplement: [表])
#show figure.where(kind: table): set figure.caption(position: top)
#show figure.where(kind: table): set block(breakable: true)
#show figure.where(kind: image): set figure(supplement: [图])

#include "/_editor/regions/analysis.typ"
#include "/_editor/regions/actions.typ"
```

带题注的长表需要上例的 `block(breakable: true)` 规则才能跨页；表格内容与重复表头仍由 Typst/TableKit 结构决定，不因添加题注而拆成多个正文对象。公式默认是否编号仍由模板决定；需要常规公式引用时，应开启 `math.equation` 编号。题注位置、图表和公式的前缀、字体、间距及最终编号属于模板。固定在模板中的图表也可直接使用 Typst `figure` 和标签，但目前编辑器的 `@` 候选只索引正文 JSON 对象，不解析任意模板源码中的标签。[Typst Figure](https://typst.app/docs/reference/model/figure/)、[Equation](https://typst.app/docs/reference/math/equation/) 和 [Reference](https://typst.app/docs/reference/model/ref/) 维护原生排版规则。

## 可选表格样式

`TypstTableStyle` 是官方 TableKit 之上的可卸载扩展，不替换表格节点或增删行列、合并、缩放等官方命令。区域编辑器通过 `config.extensions` 显式安装：

```ts no-twoslash
import { TypstTableStyle, type TypstEditorConfig } from '@pluxel/plugin-typst/tiptap'

const config: TypstEditorConfig = {
	regions: [{ id: 'body' }],
	fields: [],
	extensions: [
		TypstTableStyle.configure({
			defaultStyle: null,
			allowedStyles: ['grid', 'grid-open-sides', 'three-line', 'borderless'],
		}),
	],
}
```

每张表只增加 `attrs.typstTableStyle`，值为 `null`、`'grid'`、`'grid-open-sides'`、`'three-line'` 或 `'borderless'`。`null` 或缺省表示跟随 `defaultStyle`；`defaultStyle` 默认也是 `null`，此时 Typst 输出继续使用模板原有规则，编辑区以网格作为可编辑外观。`allowedStyles` 默认开放四种显式样式，只限制逐表覆盖；空数组锁定为跟随模板，仍可使用配置的默认样式。

安装后，表格完整上下文面板增加“表格样式”组，提供跟随模板、网格、网格·无左右框、三线表和无边框；选择跟随模板即清除覆盖。可从当前表格工具条的“更多…”打开面板；离开表格时快捷工具条收起。表格结构操作仍调用官方 TableKit 命令，卸载样式扩展只移除这组样式项。操作只修改当前表格，保留原生选区和撤销；只读、输入法组合输入及未获准的选项不能提交。也可从 `/tiptap/react` 单独挂载 `TypstTableStyleControls`，传入安装了该扩展的官方 `Editor`，无需使用区域组件。

`grid-open-sides` 保留内部横纵网格和上下边线，只移除左右外框；跨行、跨列合并后按实际列边界判断。三线表使用上下边线，以及连续完整表头后的分隔线；没有这样的表头时只有上下边线，不自动把首行改成表头。跨表头边界的合并单元格不会触发表头重复或分隔线。无边框表格仅在聚焦编辑时显示辅助虚线，不进入 Typst 输出。

卸载扩展后官方表格结构与命令仍可用。重新载入已有草稿前，宿主需显式移除 `typstTableStyle` 属性并确认放弃其外观；未安装扩展时严格准入会拒绝该未知属性，包括 `null`，不会替宿主改写已保存 JSON。字段能力可独立保留。

## 可选模板组件与源码块

区域内的标题、手工表格、图片、模板组件和源码块按同一份 Tiptap JSON 的顺序生成。外层模板通过 `#include` 决定区域的位置，并负责纸张、页眉页脚及固定内容；组件顺序由区域正文决定。

`TypstTemplateBlock` 把宿主注册的 Typst 模板作为可移动原子节点。定义保存可信源码；草稿只保存组件引用、稳定实例 ID、参数和数据绑定。`TypstSource` 独立开放直接编写 Typst 的原子节点；安装其中一个不会自动开放另一个。

```ts no-twoslash
import {
	TypstTemplateBlock,
	TypstSource,
	type JSONContent,
	type TypstEditorConfig,
} from '@pluxel/plugin-typst/tiptap'

const config: TypstEditorConfig = {
	regions: [{ id: 'body' }],
	fields: [],
	extensions: [
		TypstTemplateBlock.configure({
			templates: [
				{
					id: 'channels',
					label: '渠道收入',
					source:
						'#heading(level: 2)[#props.title]\n#for item in data [#par[#item.name: #item.actual]]',
					defaults: { title: '渠道收入' },
					validateProps: (props) => typeof props.title === 'string' && props.title.length > 0,
				},
			],
		}),
		TypstSource,
	],
}
const initial: JSONContent = {
	type: 'doc',
	content: [
		{
			type: 'templateBlock',
			attrs: {
				id: 'channels-primary',
				template: 'channels',
				props: { title: '本期渠道收入' },
				dataPath: ['channels'],
			},
		},
		{ type: 'paragraph', content: [{ type: 'text', text: '在这里分析收入变化。' }] },
		{
			type: 'typstSource',
			attrs: { id: 'source-note', source: '#text(size: 9pt)[负责人：#data.analyst]' },
		},
	],
}
// 将 config、initial 与宿主解析后的 data 交给前面的 TypstRegionEditor。
```

模板定义的 `id` 必须唯一；实例 `attrs.id` 在同一区域内跨两种节点保持唯一，重排时保留，复制时生成新 ID。`props` 是 JSON 对象，由可选 `validateProps` 校验；`defaults` 供插入器创建新实例，不在载入草稿时合并或修复已有参数。`dataPath` 是字符串数组，`[]` 绑定完整解析输入，也可绑定对象、数组或值；有当前数据时会检查路径存在。模板中的局部变量 `props` 和 `data` 分别对应实例参数与绑定值，源码块的 `data` 对应完整解析输入。组件内部生成的图表和数据表整体编辑参数；需要逐格编辑时仍使用官方 Tiptap 表格。

安装扩展后，UI 和程序共用原生 Tiptap 命令：`editor.commands.insertTypstTemplateBlock({ template: 'channels', dataPath: ['channels'] })` 使用定义的 defaults；显式 `props` 替换 defaults，不进行合并。`props` / `dataPath` 只有省略或 `undefined` 时使用默认值；显式 `null` 等非法值拒绝，不回退默认参数或完整输入绑定。`editor.commands.insertTypstSource(source)` 要求显式提供源码，包括空字符串。`duplicateTypstTemplateBlock(position)` 和 `duplicateTypstSource(position)` 接收对应节点起始的原生位置，在其后插入独立副本并选中它。每次创建分配区域内唯一 ID，深复制实例参数；移动继续使用官方 drag/drop 并保留 ID。返回 `false` 时不提交，宿主应据此显示失败。`editor.can()` 预演不生成 ID、不修改默认参数、正文或 history。只读、区域准入和组合输入限制同样适用于程序调用。载入和粘贴仍需严格校验，缺失/重复 ID 不自动修复。

React 区域编辑器按已安装扩展和当前区域规则在“插入”和 slash 菜单提供组件操作，宿主无需另装选择器。卡片显示名称、原生拖拽手柄和“块操作”菜单；拖拽调整顺序，点击名称或空白处选中节点并定位预览。右键或菜单按钮提供“复制一份”和“删除”，均沿用原生命令与 history。“复制一份”在当前文档内插入带新实例 ID 的节点，不承诺系统剪贴板往返。控件操作及参数、数据文本的选择不触发预览跳转。

模板卡片的“参数与数据”只读展示 `props` 和当前绑定数据；数据来自已有 `TypstDataProvider`，不写入正文 JSON 或产生撤销记录。宿主需要参数编辑时，可提供业务表单，选中目标节点后使用官方 `updateAttributes` 等命令修改 `props` / `dataPath`，仍受同一准入规则约束。

独立 consumer 的“渠道组件参数”是这种组合的实例：选中渠道卡片后编辑标题，复用宿主已有 validator；确认只修改当前 ID 的 props，一次撤销恢复。待确认标题随组件实例保留，切换选区或区域后选回仍可继续编辑；确认或明确取消才结束本次修改。数据绑定固定为完整输入，表单不允许改成模板不接受的形状；取消和校验失败不写正文。源码与参数表单的未应用输入属于宿主离开/保存检查，隐藏表单仍参与检查；取消或应用后提示同步更新，不能被编译成功冒充已保存。

源码块保留“编辑 Typst 源码”，未应用的源码只留在控件内，点击“应用组件修改”后才成为可撤销的草稿修改。卸载扩展不删除普通编辑能力；含对应节点的草稿必须由宿主明确转换，否则准入返回 `UNKNOWN_NODE`。

源码块直接参与 Typst 编译，编译错误保留草稿供修复；它不保证能反解为可视化段落或表格。宿主决定是否授权源码编辑及编译器可用资源；此扩展不是 Typst 代码安全沙箱。普通 Markdown 的 `typst` 代码围栏仍是展示代码，不能隐式执行。

## 准入、生成与编译

`validateTypstRegion` / `validateTypstRegions` 在 ProseMirror 规范化前检查原始 JSON，拒绝未知节点、Mark、属性、区域集合、无 serializer 的持久化扩展和非法表格；text 节点携带子内容也会拒绝，不能依赖 ProseMirror 丢掉子内容后再检查。`validateTypstDraft` 还检查 `formatVersion: 1`、模板身份及修订。恢复错误为 `{ ok: false, issues }`；每项包含稳定 `code`、`message`，以及适用的 `regionId`、JSON `path` 或 `fieldPath`。保留原文供修复，不使用 `getJSON()` 丢掉未知输入后伪装成功。

```ts no-twoslash
import { generateTypstRegions } from '@pluxel/plugin-typst/tiptap'

const generated = generateTypstRegions({
	regions: draft.regions,
	config,
	data: parsedData,
	snapshotRevision: clientRevision,
})
if (!generated.ok) {
	showIssues(generated.issues)
	return
}
// templateFiles 是相对模板树的生成文本资源（含所需公式运行时）；inputFiles 是 /inputs/ 内的 JSON 文本。
await writePrivateTemplateFiles(generated.value.templateFiles)
// hostInputs 是本次完整 createFiles/默认数据/资源文件表。
if (
	Object.keys(hostInputs).some(
		(path) => path === '/inputs/editor' || path.startsWith('/inputs/editor/'),
	)
) {
	showIssues([{ code: 'EDITOR_RESOURCE_CONFLICT', message: '/inputs/editor/ 已被占用' }])
	return
}
const files = { ...hostInputs }
for (const [path, text] of Object.entries(generated.value.inputFiles)) {
	files[path] = { kind: 'text', text }
}
const compiled = await session.update({ files, template: privateTemplate })
const pdf = await session.exportPdf(compiled.revision)
await showPreview(compiled.preview)
await savePdf(pdf)
```

上例的 session 创建与 `await using` 释放见[文档会话](./typst.md#生成文档)。宿主把生成文件写入自己拥有的临时模板副本；不要写回共享源码缓存。区域路径为 `_editor/regions/<regionId>.typ`，固定模板用相对 `#include` 引入；组件实例各有 `_editor/blocks/<regionId>/<instanceId>.typ`。数据位于 `/inputs/editor/data.json`，组件参数和绑定存于 `/inputs/editor/blocks/<regionId>/<instanceId>.json`。`_editor/` 和 `/inputs/editor/` 由区域编辑保留，宿主必须拒绝与模板或 `createFiles` 的冲突，不能覆盖后继续编译。

正文改变时提交完整新模板树 `update.template`；仅数据改变复用模板，只更新输入文件。生成 Typst 源码保持字符串、Unicode、Marks、合并/跨行单元格、列宽、多段内容与字段的语义；不把表格转成 Markdown。表头跨行合并延伸到正文时，该表保留表头单元格样式但不重复表头，避免把正文纳入每页重复区域。生成器不执行业务 schema，不发明第二份数据契约。

宿主保存原始输入与区域 JSON 的同一份草稿，使用独立存储版本做条件写入；客户端修订覆盖未保存的 data、regions、模板和资源变化。模板修订不匹配必须明确处理。普通 Typst 编译诊断保留原有 `TypstError`；不把 Worker/IO/取消统一包装成正文校验错误。

## 业务节点与输出

自定义 Tiptap 扩展通过 `extensions` 加入，同时为持久化节点/Mark 提供 `nodeMappings` / `markMappings`。扩展声明结构和属性名，mapping 声明属性值校验及 Typst 输出。有属性的扩展必须提供 `validateAttributes`，它也收到 schema 默认值。

serializer 使用 `context.children(node)` 复用子节点校验和序列化，`context.text(value)` / `context.string(value)` 编码外部文字。业务固定排版代码由可信宿主映射提供；需要用户编写源码时显式安装上述 `TypstSource`。若接受业务 HTML，还需给 node mapping 声明 `html.tag`、允许属性与值校验，再由扩展 `parseHTML` 解析。Studio 的 [提示块](https://github.com/PluxelJS/pluxel/blob/main/projects/report-template-studio/src/shared/editor.ts)和独立 [consumer](https://github.com/PluxelJS/pluxel/blob/main/plugins/render/typst/tests/consumer/main.tsx)是实际调用方。

## Markdown、HTML 与候选

`parseTypstMarkdown({ markdown, regionId, config, data?, format? })` 使用官方 MarkdownManager/GFM；Node 无 DOM 与浏览器使用相同 tokenizer。`format` 默认是 `'markdown'`，普通格式的字段仅接受完整的受控标签：

```html
<data-field path='["customer","name"]'></data-field>
```

代码块或行内代码中的标签保持文字；非法属性或字段路径明确失败。Markdown 是转换输入，不能替代原生 JSON。`exportTypstMarkdown` 成功值含 `{ markdown, lossless, issues }`；合并表格、多段单元格、显式表格样式、带题注/标识的图表、结构化引用、模板组件、源码块及缺少可往返 Markdown 映射的业务节点等可得到可读文字，但 `lossless: false` 时不能用来覆盖原区域。模板组件导出为说明文字，源码块导出为普通 `typst` 代码围栏，重新导入不会恢复可执行节点。原生 JSON 保存完整表格属性；`typstTableStyle: null` 本身不构成 Markdown 损失，重新导入后仍使用宿主配置的默认样式，其他复杂结构仍需检查。

### Agent Markdown

导出、导入与候选都指定 `format: 'agent'`，用于让 coding agent 编辑富文本。粗体、斜体、标题、列表、链接及普通表格继续复用 Tiptap 的 Markdown 规则；四项文字排版和字段绑定增加以下非 HTML 标记：

```md
# 分析

[textStyle {"fontFamily":"Noto Serif CJK SC","fontSize":"12pt","color":"#dc2626","backgroundColor":"#fff2cc"}]**重点**与*解释*[/textStyle]

客户：[dataField {"path":["customer","name"]}]
```

标记属性是 JSON 对象，值规则与原生 JSON 相同。字段保存路径，实际值仍由当前 data 决定。样式可以包住字段；不支持嵌套同名 `textStyle`，需要变换样式时使用相邻标记。行内代码、代码围栏和反斜杠转义的标记保持字面量；不完整标记、非法 JSON 和不支持的属性会返回 issues。

段落对齐和简单表格的样式使用 `:::attrs` 给**一个** Markdown 块补充原生属性，正文仍然直接可编辑：

```md
:::attrs {"textAlign":"center"}
这段文字居中。
:::

:::attrs {"typstTableStyle":"three-line"}
| 项目 | 金额 |
| ---- | ---- |
| 服务 | 120  |
:::
```

属性名和值仍由该节点的 schema 与宿主配置决定。导出只补充标准语法未承载的属性；例如居中标题仍可直接把 `##` 改为 `###`。属性块和原生节点块独占 Markdown 块，与前后段落用空行分隔；嵌套属性块使用更长的外层冒号围栏。字体空白边界、带格式的字段、下划线或无法用普通 Markdown 精确表示的局部 Mark 组合，可使用 `[marks 原生Mark数组]内容[/marks]`；最小行内原生节点表示为 `[tiptap 原生节点JSON]`。这些表示由导出器按需要选择，普通加粗和斜体仍优先使用 `**` / `*`。

图表使用专用包装，题注保持可读的行内 Markdown；嵌套围栏的外层比内层长。以下表格、题注和引用属于同一份正文：

```md
::::figure {"id":"quarterly-table","label":"tbl:quarterly"}
| 项目 | 金额 |
| ---- | ---- |
| 服务 | 120  |

:::caption
季度收入，单位：**万元**。
:::
::::

详细数据见 [ref {"target":"quarterly-table"}]。
```

公式使用官方 `$...$`、`$$...$$` LaTeX Markdown 语法。独立公式的 id / label 放在单块属性包装中：

```md
增长率为 $g = (v_1-v_0)/v_0$。

:::attrs {"id":"growth-equation","label":"eq:growth"}
$$
g = \frac{v_1-v_0}{v_0}
$$
:::

计算方法见 [ref {"target":"growth-equation"}]。
```

id 是引用关系的依据，label 是可改的 Typst 名称；编辑现有对象时保持 id。新建图表或独立公式时，为它分配整份报告内唯一的 id / label，并让 `[ref]` 使用 id。题注和 label 分别编辑，不把“图 3”写死到题注。复杂合并表格、无法用行内语法精确保留的题注等仍可能使用最小原生子树表示；不要清洗掉导出器保留的标记。普通 Markdown 没有这些图表身份与引用约定，仍需检查 `lossless`，不能因为公式本身有 `$` 语法就宣称整份文档无损。

模板实例、可执行源码、合并单元格及其他不能通过上述语法往返的子树，使用完整原生节点块。例如以下组件仍引用宿主安装的 `summary` 模板：

```md
:::tiptap
{"type":"templateBlock","attrs":{"id":"summary-1","template":"summary","props":{"title":"结论"},"dataPath":["report"]}}
:::
```

Agent 可以直接修改 JSON 参数；模板定义、区域权限、属性、实例 ID 唯一性和 serializer 仍按现有规则校验。这不是任意节点注册入口。普通 `typst` 代码围栏继续表示代码展示；只有显式安装并允许的 `typstSource` 原生节点具有源码语义。

导出递归保留能用标准规则表达的内容，只对无法保留的局部使用原生标记；一个带格式的段落不会使整篇文档退回 JSON。成功返回前会实际回读并比较原生文档，`lossless: true` 表示在同一 config 下保留节点、Mark 和属性语义，不承诺保留原 Markdown 拼写或 JSON 键顺序。格式仍是原生 JSON 的编辑投影，不能用普通 Markdown 工具清洗后假定无损。

```ts no-twoslash
const source = exportTypstMarkdown({ document, regionId, config, data, format: 'agent' })
if (!source.ok) throw new Error(JSON.stringify(source.issues))
// 将 source.value.markdown 交给 agent；接纳返回的 editedMarkdown 前准备候选。
const prepared = prepareTypstCandidate({
	candidate: { regionId, baseRevision, markdown: editedMarkdown, format: 'agent' },
	currentRevision,
	document,
	config,
	data,
	canEdit,
})
if (!prepared.ok) throw new Error(JSON.stringify(prepared.issues))
```

删除样式标记或原生块会形成相应的删除候选，不会隐式补回旧内容；接纳前审阅修改。编辑器的 `getMarkdown()` 与默认剪贴板入口仍使用普通 Markdown；需要保真投影时调用上述 SDK 入口。

### HTML 与候选接纳

`parseTypstHtml` 只在浏览器使用 DOMParser，先检查原始标签、属性、业务规则，再走官方 schema，拒绝会被浏览器或 ProseMirror 静默丢弃的内容。`parseTypstClipboard` 根据显式 HTML/plain text 输入选择解析路径；Markdown 导入用 `asMarkdown: true`。默认 React 组件拦截富文本粘贴并报告失败；代码块内保留原生粘贴语义。

安装表格样式扩展时，`getHTML()` 的 `data-typst-table-style` 保留显式选择或继承状态，受控 HTML 导入按同一配置校验后恢复。HTML 仅承诺属性往返，不是最终分页排版交付；复杂表头分隔线和无左右框的边界依赖编辑器 decoration，静态 HTML 不带这些标记。图片/表格的 figure 包装、富文本题注、LaTeX 数学节点和 reference 有受控 HTML 映射；原始属性仍在官方 parser 规范化前校验。模板组件和源码块未声明 HTML 导入映射，不能通过复制 HTML 恢复；包含这类 body 的 figure 同样需要 JSON/Agent Markdown 保存。最终表格外观及跨页表头以 Typst 预览/PDF 为准。

从原生选区捕获目标使用 `captureTypstCandidateTarget({ selection: editor.state.selection, regionId, baseRevision, scope: 'blocks' })`，先检查 `ok`。`scope: 'region'` 不产生 range；`blocks` 将字符选区扩展为最近共同容器中的完整块，非空选区的结束边界排他；折叠光标在块边界选择后一个块，在文档结尾选择最后一个块。嵌套正文可直接选中列表项、提示块或单个单元格内的段落；跨多个单元格的选区扩展到整张表，原子节点选区取该节点，AllSelection 包含全部块。没有可捕获块时返回 `INVALID_CANDIDATE_RANGE`。提取该范围的原文时使用 `editor.state.doc.copy(editor.state.doc.slice(from, to).content).toJSON()`，避免把单元格等外围容器一起导出。捕获不修改正文和选区，区域、修订与范围在同一动作固定；UI 应显示扩展后的范围，不能把几个字符当作整个区域的授权。

候选形状为 `{ regionId, baseRevision, markdown, format?, range? }`。`format` 必须与交给 agent 的导出格式一致。省略 `range` 替换整个区域；`range: { from, to }` 指定该修订下同一父节点内非空、完整的块范围，`to` 不包含在内。不能把段落内的字符偏移或独立的表格行/单元格结构直接作为范围；跨父节点或不完整边界返回 `INVALID_CANDIDATE_RANGE`。

宿主固定目标后调用 `prepareTypstCandidate` 查看原文、目标范围与候选的对照，提供当前 JSON、config、data、currentRevision 和 `canEdit(regionId)`；接纳时再调用 `applyTypstCandidate`，其中 `currentRevision` 与 `data` 用函数读取最新事实，权限也再次检查。输入文字变化后旧准备结果失效，接纳绑定已展示且准备成功的内容；修改文字不更新已固定的 baseRevision。两次都要求严格的修订相等，不自动把旧范围迁移到新文档。普通格式检查目标范围能否无损往返；agent 格式直接校验候选的完整语义。两者都校验合并后的完整区域；外围的图表、源码块、复杂表格及格式保持原节点。普通 Markdown 目标含不能无损转换的内容时返回 `COMPLEX_CONTENT`；Agent Markdown 可通过原生块编辑这些内容。

例如让 LLM 只改图表旁边的分析段落，可把该段落的完整范围与当前修订交给候选接口。准备结果的 `document` 仅包含替换内容，`mergedDocument` 是验证后将得到的整个区域 JSON。它不能绕过提交时的最新版本、权限和文档校验。提交成功只产生一次原生 transaction，一次 undo 可恢复；失败保留原文。SDK 不调用模型，不把流式 token 写入正式正文；候选与界面结构操作最终都提交原生 transaction。

## 预览与定位

共享 View 的生命周期见[浏览器预览](./typst.md#浏览器预览)。`TypstPreviewView` 支持 `scrollContainer`、`onStateChange`、`isNavigationCurrent` 和 `onNavigate`；`state` 给出当前 packet、页数、当前页和目录项。`jumpToPage`、`jumpToPosition`、`revealSource` 与 `refresh` 管理滚动和高亮。普通点击经拖选/修饰键过滤及 SVG CTM 转换后返回 `{ preview, point }`；`pointAtPreview` / `pointAtSource` 可供其他编辑器直接使用。

生成结果的 `mapping` 绑定 `snapshotRevision`，包含 Unicode 字符、原子节点和嵌套块的范围。`findTypstRegionPosition` 将同快照 `_editor/` 的 native 源码位置映射到 `{ regionId, from, to, source? }`；`from` / `to` 已是可直接使用的 ProseMirror UTF-16 位置，**不要再加 1**。文本点击定位到对应字符，字段和图片按完整节点定位；表格、列表及自定义节点通过 `context.children` 保留内部位置。

模板组件按实例定位；同一模板插入多次时，独立生成文件和稳定实例 ID 区分各次输出，不能把图表中的计算结果伪装成可编辑正文字符。源码块同样能定位预览，反向点击还返回 `source: { line, column }`，是一基 UTF-16 行列，已去掉生成文件的数据前缀。宿主选中该源码节点并把 `source` 作为 transaction 的 `typst-navigation` 元数据提交，React NodeView 会展开源码并定位；存在未应用源码修改时保留修改并提示，不套用旧坐标。

`findTypstGeneratedPosition` 同时接收该次成功编译的 `navigation`，将光标映射到对应的真实字形。不可见空白取同一内容块内最近的可见字符，没有渲染点时返回 `undefined`。连字按编译器的字形簇定位，无法溯源到字符的计算表达式保留整体范围。原生字面量解析处理引号、反斜杠、Unicode 转义与 emoji；多行代码块使用保留行来源的 Typst raw 语法。真实 `.typ` span 交给源码编辑器，生成文件不作为可写文件打开。native 使用一基 UTF-16 行列，diagnostic range 使用零基；生成范围结束位置不包含在内。

宿主在 `pointerup` 中触发反向定位时，应从编辑器内的折叠 DOM 选区通过 `editor.view.posAtDOM` 取得位置；此时 ProseMirror 的 `selectionchange` 事务可能尚未更新 `editor.state.selection`。拖选、修饰键点击和编辑器外的选区不触发预览跳转。

```ts no-twoslash
import { findTypstGeneratedPosition } from '@pluxel/plugin-typst/tiptap'

const source = findTypstGeneratedPosition({
	mapping: generated.value.mapping,
	navigation: compiled.preview.navigation,
	regionId,
	position,
	snapshotRevision: clientRevision,
})
if (source) view.revealSource(source)
```

宿主必须校验当前草稿和源文件版本，选择可见且明确所属的 pane，并在异步打开后再次复核；匹配的未保存 data/regions 可导航，未保存源码对应的旧预览不可冒充当前输出。编译调度采用一个在途请求和最新待处理快照，旧结果不发布。普通错误保留旧画面并标注过期；导出当前草稿时先取得匹配成功修订，使用该修订导出。不要逐键 abort native 任务：取消会终止并关闭会话。

编译失败的 diagnostics 使用该次请求的客户端修订与生成 mapping，不能借用上一份成功预览。诊断 range 为零基 UTF-16 行列，传给一基导航前各加一；`_editor/` 位置通过 mapping 回到区域/组件，不作为用户源码打开。草稿已改变时只展示旧原因，停用旧坐标。编译成功的 warning 仍展示，且不阻止当前预览/PDF；生成前的失败可能没有 mapping。HTTP 等边界应显式投影错误类别、code、message、path 和 diagnostics，保留 Worker、IO、取消与未知异常意义。

## 可运行消费者

[Examples](/examples) 在纯浏览器内复用共享区域编辑器、生成器与真实 Pluxel Host，通过 Typst WASM 展示短文档编辑和块级双向定位；编译不经过服务端。WASM 与原生导航精度的区别见[浏览器编译](./typst.md#浏览器编译)。

[Report Template Studio](https://github.com/PluxelJS/pluxel/blob/main/projects/report-template-studio/README.md)使用上述入口实现正常源码预览与区域报表；Monaco 和双 worker 留在应用。其“客户服务报告”包含固定模板、两个区域、客户切换、合并表格、提示块与确定性 Markdown 候选。独立 consumer 的运行和构建制品验收见 [consumer 测试](https://github.com/PluxelJS/pluxel/blob/main/plugins/render/typst/tests/consumer/README.md)。

Studio 与独立 consumer 显式安装 `TypstTableStyle`。Studio 同名 `.editor.json` 的可选 `table` 配置复用[已有表格样式选项](#可选表格样式)；省略时跟随原 Typst 模板，仍可逐表选择外观。不需要为基本正文编辑增加额外样式策略。

独立 consumer 的图表报告显式安装模板组件与源码块：“渠道收入与目标”整体位于正文顺序中，后续行动区提供源码块；外层模板负责页面和固定标题。页面左侧以“正文 / 数据”切换工作区，右侧以“Typst 预览 / 原始 Typst / Markdown”切换视图；切换标签保持 Editor 与撤销历史，预览跳转打开对应正文或源码标签。Markdown 选择“当前选中块”并点击“编辑这份 Markdown”后，只替换完整选中段落，方便验证 LLM 的 Markdown 修改与图表共存。

窄屏用“编辑 / 预览”切换，隐藏面板仍保留 Editor/history 和预览实例。“保存”写入本浏览器的单一槽；保存状态与编译/显示修订独立，失败保留未保存事实。替换示例或重开前检查正文、数据与未应用源码/参数输入；取消保留当前 Editor。刷新/关闭使用浏览器 `beforeunload`，提示依赖用户激活与平台支持，不能保证浏览器崩溃或系统终止时保留尚未保存的内容。
