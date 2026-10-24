---
title: Typst 区域编辑
description: 通过可选 Tiptap 入口编辑原生 JSON，生成可定位的 Typst 正文并复用同修订预览与 PDF。
---

`@pluxel/plugin-typst` 在同一个包中提供独立前端入口。服务端仍使用 [TypstPlugin](./typst.md)，文档定义仍是 `/template` 的 `defineTypstDocument({ template, schema, createFiles? })`。Monaco、worker 和 Vite 接线由消费应用拥有。

在源码仓库可运行 `mise exec -- vp run @pluxel/plugin-typst#compile`，再运行 `mise exec -- vp run typst` 打开浏览器体验页，测试正文、模板源码与排版预览的双向定位。它与 Studio 共用编辑器、工具栏和预览组件，以本地 native 服务编译；启动、保存范围及具体操作见 [consumer 说明](https://github.com/PluxelJS/pluxel/blob/main/plugins/render/typst/tests/consumer/README.md#interactive-browser-playground)。

## 入口与安装

| 入口            | 能力                                                                      | 需要的编辑器 peers                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 包根            | native Plugin、会话、PDF                                                  | 无                                                                                                                                                            |
| `/template`     | 纯文档定义                                                                | 无                                                                                                                                                            |
| `/browser`      | 无框架预览、页码/目录状态、普通源码位置与双向定位                         | 无                                                                                                                                                            |
| `/tiptap`       | 原生 JSON 校验、扩展、Markdown、区域生成和映射；可在无 DOM 的 Node 中使用 | `@tiptap/core`、`@tiptap/pm`、`@tiptap/starter-kit`、`@tiptap/extension-table`、`@tiptap/extension-image`、`@tiptap/extension-text-style`、`@tiptap/markdown` |
| `/tiptap/react` | 字段 NodeView、区域组件、分组工具栏、浮动菜单和字段选择器                 | 上列 peers，加 `@tiptap/react`、`react`、`react-dom`                                                                                                          |

Tiptap peers 使用已验收的同一版本 `3.32.0`；React 集成使用 React 19。对应依赖均为 optional peers，只使用编译或预览无需安装它们。选用相应入口时必须安装依赖，缺失时明确报错。浏览器从子路径导入，不从包根取运行时值；包级已有 native 依赖的下载成本仍存在。本包当前 private，验收对象是本地构建制品，未发布到 registry。

样式单独从 `@pluxel/plugin-typst/tiptap/style.css` 导入，由宿主决定加载。JS 和声明入口不隐式加载 CSS，保留 Node / SSR 导入能力。样式作用于 `.typst-*` 控件及带表格外观标记的官方表格 DOM，不改变未安装样式扩展的表格；宿主可用 CSS 变量调整配色。

## 区域、数据与原生编辑

正文直接保存 Tiptap `JSONContent`，不经过 Markdown 归档。宿主持有模板身份/修订、权限、原始业务输入和各区域 JSON。区域声明属于模板配置，保存的草稿不能覆盖规则。

```tsx no-twoslash
import { useState } from 'react'
import '@pluxel/plugin-typst/tiptap/style.css'
import type { JSONContent, TypstEditorConfig } from '@pluxel/plugin-typst/tiptap'
import {
	TypstRegionEditor,
	TypstEditorToolbar,
	TypstFieldPicker,
} from '@pluxel/plugin-typst/tiptap/react'

// Stable declarations, including the extension array. Do not recreate it on every render.
const config: TypstEditorConfig = {
	regions: [{ id: 'body' }, { id: 'notes' }],
	fields: [{ path: ['customer', 'name'], label: '客户名称' }],
	extensions: [],
}
const fontFamilies = ['Noto Serif CJK SC', 'Liberation Serif']

export function Body({
	loadedDraft,
	parsedData,
	onSnapshot,
}: {
	// The host changes key only when replacing the document/template or loading a full draft.
	loadedDraft: { key: string; regions: Record<string, JSONContent> }
	parsedData: unknown
	onSnapshot(regionId: string, content: JSONContent): void
}) {
	const [active, setActive] = useState('body')
	const [error, setError] = useState('')
	return (
		<>
			{error && <p role="alert">{error}</p>}
			<nav aria-label="正文区域">
				{config.regions.map(({ id }) => (
					<button key={id} type="button" onClick={() => setActive(id)}>
						{id}
					</button>
				))}
			</nav>
			{config.regions.map(({ id }) => (
				<div key={`${loadedDraft.key}:${id}`} hidden={active !== id}>
					<TypstRegionEditor
						regionId={id}
						content={loadedDraft.regions[id]!}
						config={config}
						data={parsedData}
						onChange={(content) => onSnapshot(id, content)}
						onValidationError={(issues) => setError(issues.map((item) => item.message).join('\n'))}
					>
						{(editor) => (
							<TypstEditorToolbar editor={editor} fontFamilies={fontFamilies}>
								<TypstFieldPicker editor={editor} fields={config.fields} />
							</TypstEditorToolbar>
						)}
					</TypstRegionEditor>
				</div>
			))}
		</>
	)
}
```

`content` 是挂载时的初始值；`onSnapshot` 在宿主保存最新原生 JSON 快照，不把组件变成受控输入。同一组件不因 React 更新调用 `setContent`。`config` 和 `extensions` 保持稳定；扩展数组身份改变会重建 Editor，不能在每次 render 中内联新数组。宿主校验另一份完整草稿后，显式设置新的 `loadedDraft = { key: crypto.randomUUID(), regions: checked.value.regions }`；换文档、模板修订或重新加载同一保存槽也使用新 key 挂载，并清除宿主暂存的旧候选与定位；这样不会沿用被替换草稿的 history。切换区域可保留各区域组件，保留原生 history；卸载会释放 Editor。也可直接组合 `createTypstExtensions` / `createTypstReactExtensions` 与官方 `Editor`、`useEditor`、`EditorContent`，自行处理原始输入准入。

默认 React 界面提供分组图标工具栏、段落/标题类型菜单、文字上下文菜单和 `/` 插入命令。选择文字不会自动弹出格式条；文字右键或 `Shift+F10` / 菜单键才打开基于官方 React `BubbleMenu` 的格式条。右键落在已有文本选区内时保留范围，落在外部时先把光标移到点击处。表格内右键、同样的快捷键或表边入口打开表格菜单；当前为文本选区时，同一面板显示“单元格文字格式”，并保留表格样式与结构操作。只读或输入法组合输入期间不拦截文本右键，源码 textarea 和卡片中的只读数据文本也保留浏览器菜单。可用项随区域规则与 `editable` 权限变化，最终准入仍由同一原生 transaction 校验。

字体、字号、文字颜色和背景颜色位于默认收起的“排版”内，展开后仍是同一个“排版扩展”工具栏。收起不卸载 Editor、不改变选区或撤销历史。字体菜单来自 `TypstEditorToolbar.fontFamilies`，该参数只提供选择项，不安装字体；省略且当前正文没有字体时，字体菜单禁用。后端通过 [Fonts](./fonts.md) 或会话字体输入提供真实字体，浏览器能否显示同一字体取决于宿主 CSS 和本机字体；最终排版以 native 预览/PDF 为准。字号菜单提供常用 pt 值；颜色菜单提供色板、自定义十六进制色值和单独清除。“清除排版”一次移除这四项，保留加粗等其他格式；选择“模板字体/模板字号”恢复继承模板。每次操作沿用原生事务和 undo。

这些格式复用官方 [TextStyleKit](https://tiptap.dev/docs/editor/extensions/functionality/text-style-kit) 的 `textStyle` Mark，仍存于同一份原生 JSON：

| 属性              | 准入值                                                                                                                                            | Typst 输出             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `fontFamily`      | 单个由 Unicode 字母/数字、空格或连字符组成的家族名，可带一对外层引号；数字开头的词需加外引号，如 `"DIN 1451"`。不接受列表、转义或 CSS-wide 关键字 | `text(font: ...)`      |
| `fontSize`        | 正数 `pt` 或 `px`，`1px = 0.75pt`                                                                                                                 | `text(size: ...)`      |
| `color`           | 十六进制 3/4/6/8 位，或整数 RGB 通道的 `rgb()` / `rgba()`                                                                                         | `text(fill: ...)`      |
| `backgroundColor` | 同上，支持 alpha                                                                                                                                  | `highlight(fill: ...)` |

`null` 表示继承。区域的 `marks` 显式允许 `textStyle` 才开放这行；未声明 `marks` 时与其他内置 Mark 一样可用；只读和输入法期间说明禁用原因。无效值、相对字号、CSS 变量和未知样式均明确拒绝。HTML 的受控 `span style` 可以保留四项格式；导入沿用浏览器 CSSOM 的等价表示，例如 `rgb()` 色值和字体外层引号，已保存的原生 JSON 不因此改写。Markdown 不承载它们，导出返回 `lossless: false` 和格式损失诊断，不能用输出覆盖原生 JSON。Markdown 候选覆盖带排版格式的区域也会被复杂内容检查阻止。

`placeholder` 设置空段落提示。`slashCommands` 可添加宿主业务操作，回调只组合传入的原生 chain，由共享菜单统一删除 `/query` 并执行一次 transaction；不要在回调中自行 `run()` 或产生外部副作用：

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

字段路径是非空 `string[]`，不使用点号拆分；例如 `['items', '0', 'name']` 可读取数组首项。路径按实际父值解释：数组使用索引，对象仍使用字符串键，因此对象的 `'0'` 键不会被改成数组访问。`data` 必须是宿主 schema 解析后的输出；仅绑定声明过的 string/number/boolean，nullable 字段需显式配置 `nullText`。字段在 React 中不可直接改文字，但可以通过原生命令删除整个节点。更新 provider 数据只改变显示，不产生正文 transaction 或 undo 记录。草稿只保存原始业务输入；解析输出仅用于展示和一次编译，不能回写草稿，否则 transform 会重复执行。

官方 StarterKit、TableKit、Image 提供标题、列表、引用、代码、格式、表格和逻辑图片。区域的 `nodes`、`marks`、`fields` 可缩小允许范围；它们是内容规则，不能代替宿主授权。Link 默认接受 http(s)、mailto、tel 和页内锚点；`allowLink` 可提供宿主自己的规则，空值、空白和控制字符仍会拒绝。图片 `src` 是宿主逻辑 ID，`resolveImage(id)` 将它映射到预备好的 `/inputs/` 资源，不读取任意磁盘路径。

`createEditorExtensions()` 只组合官方 Tiptap 扩展，可直接用于普通 `Editor`。`createTypstExtensions(config)` 在这组能力上加入 `DataField` 与宿主的 `config.extensions`；`createTypstReactExtensions` 为字段及已安装的模板组件、源码块提供 NodeView。表格样式、模板组件和源码块均需分别显式安装。

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

安装后，表格上下文菜单中增加“表格样式”组，提供跟随模板、网格、网格·无左右框、三线表和无边框；选择跟随模板即清除覆盖。它不占顶部工具栏的新一行。表格结构操作仍调用官方 TableKit 命令，卸载样式扩展只移除这组样式项。操作只修改当前表格，保留原生选区和撤销；只读、输入法组合输入及未获准的选项不能提交。也可从 `/tiptap/react` 单独挂载 `TypstTableStyleControls`，传入安装了该扩展的官方 `Editor`，无需使用区域组件。

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

React 宿主可把 `TypstBlockPicker` 放进工具栏插槽，只显示已安装且当前区域允许的类型。卡片显示名称、原生拖拽手柄和“块操作”菜单；拖拽调整顺序，点击名称或空白处选中节点并定位预览。右键或菜单按钮提供“复制一份”和“删除”，均沿用原生命令与 history。“复制一份”在当前文档内插入带新实例 ID 的节点，不承诺系统剪贴板往返。控件操作及参数、数据文本的选择不触发预览跳转。

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
// templateFiles 是相对模板树的 Typst 文本，inputFiles 是 /inputs/ 内的 JSON 文本。
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

`parseTypstMarkdown({ markdown, regionId, config, data? })` 使用官方 MarkdownManager/GFM；Node 无 DOM 与浏览器使用相同 tokenizer。字段仅接受完整的受控标签：

```html
<data-field path='["customer","name"]'></data-field>
```

代码块或行内代码中的标签保持文字；非法属性或字段路径明确失败。Markdown 是转换输入，不能替代原生 JSON。`exportTypstMarkdown` 成功值含 `{ markdown, lossless, issues }`；合并表格、多段单元格、显式表格样式、模板组件、源码块及缺少可往返 Markdown 映射的业务节点等可得到可读文字，但 `lossless: false` 时不能用来覆盖原区域。模板组件导出为说明文字，源码块导出为普通 `typst` 代码围栏，重新导入不会恢复可执行节点。原生 JSON 保存完整表格属性；`typstTableStyle: null` 本身不构成 Markdown 损失，重新导入后仍使用宿主配置的默认样式，其他复杂结构仍需检查。

`parseTypstHtml` 只在浏览器使用 DOMParser，先检查原始标签、属性、业务规则，再走官方 schema，拒绝会被浏览器或 ProseMirror 静默丢弃的内容。`parseTypstClipboard` 根据显式 HTML/plain text 输入选择解析路径；Markdown 导入用 `asMarkdown: true`。默认 React 组件拦截富文本粘贴并报告失败；代码块内保留原生粘贴语义。

安装表格样式扩展时，`getHTML()` 的 `data-typst-table-style` 保留显式选择或继承状态，受控 HTML 导入按同一配置校验后恢复。HTML 仅承诺属性往返，不是最终分页排版交付；复杂表头分隔线和无左右框的边界依赖编辑器 decoration，静态 HTML 不带这些标记。模板组件和源码块未声明 HTML 导入映射，不能通过复制 HTML 恢复；使用 JSON 保存。最终表格外观及跨页表头以 Typst 预览/PDF 为准。

从原生选区捕获目标使用 `captureTypstCandidateTarget({ selection: editor.state.selection, regionId, baseRevision, scope: 'blocks' })`，先检查 `ok`。`scope: 'region'` 不产生 range；`blocks` 将字符选区扩展为完整顶层块，非空选区的结束边界排他；折叠光标在块边界选择后一个块，在文档结尾选择最后一个块。嵌套正文取外层顶层块，表格的单元格选区包含所属整张表，原子节点选区取该节点，AllSelection 包含全部块。没有可捕获块时返回 `INVALID_CANDIDATE_RANGE`。捕获不修改正文和选区，区域、修订与范围在同一动作固定；UI 应显示扩展后的范围，不能把几个字符当作整个区域的授权。

候选形状为 `{ regionId, baseRevision, markdown, range? }`。省略 `range` 替换整个区域；`range: { from, to }` 指定该修订下非空、完整的顶层块范围，`to` 不包含在内。不能把段落内的字符偏移直接作为范围；不完整边界返回 `INVALID_CANDIDATE_RANGE`。

宿主固定目标后调用 `prepareTypstCandidate` 查看原文、目标范围与候选的对照，提供当前 JSON、config、data、currentRevision 和 `canEdit(regionId)`；接纳时再调用 `applyTypstCandidate`，其中 `currentRevision` 与 `data` 用函数读取最新事实，权限也再次检查。输入文字变化后旧准备结果失效，接纳绑定已展示且准备成功的内容；修改文字不更新已固定的 baseRevision。两次都要求严格的修订相等，不自动把旧范围迁移到新文档。只检查目标范围能否无损往返 Markdown，再校验合并后的完整区域；外围的图表、源码块、复杂表格及格式保持原节点。目标本身含不能无损转换的内容时返回 `COMPLEX_CONTENT`，不能借局部范围删除组件。

例如让 LLM 只改图表旁边的分析段落，可把该段落的完整顶层范围与当前修订交给候选接口。准备结果的 `document` 仅包含替换内容，提交成功只产生一次原生 transaction，一次 undo 可恢复；失败保留原文。SDK 不调用模型，不把流式 token 写入正式正文；组件参数、顺序和删除仍通过原生结构操作完成。

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

[Report Template Studio](https://github.com/PluxelJS/pluxel/blob/main/projects/report-template-studio/README.md)使用上述入口实现正常源码预览与区域报表；Monaco 和双 worker 留在应用。其“客户服务报告”包含固定模板、两个区域、客户切换、合并表格、提示块与确定性 Markdown 候选。独立 consumer 的运行和构建制品验收见 [consumer 测试](https://github.com/PluxelJS/pluxel/blob/main/plugins/render/typst/tests/consumer/README.md)。

Studio 与独立 consumer 默认显式安装 `TypstTableStyle`。Studio 同名 `.editor.json` 的顶层可选 `table` 对象使用相同的 `defaultStyle`、`allowedStyles` 选项，例如 `"table": { "defaultStyle": "three-line", "allowedStyles": [] }` 锁定三线表默认外观；省略 `table` 保持跟随原 Typst 模板并允许四种逐表覆盖。Studio 的 `studioEditorConfig` 将这份宿主配置转换为扩展选项，保存的草稿不能覆盖它。

独立 consumer 的图表报告显式安装模板组件与源码块：“渠道收入与目标”整体位于正文顺序中，后续行动区提供源码块；外层模板负责页面和固定标题。页面左侧以“正文 / 数据 / 模板 / AI 候选”切换工作区，桌面右侧持续显示预览；切换标签保持 Editor 与撤销历史，预览跳转打开对应工作区。AI 候选选择“当前选中块”后只替换完整选中段落，方便验证 LLM 的 Markdown 修改与图表共存。

窄屏用“编辑 / 预览”切换，隐藏面板仍保留 Editor/history 和预览实例。“保存”写入本浏览器的单一槽；保存状态与编译/显示修订独立，失败保留未保存事实。替换示例或重开前检查正文、数据与未应用源码/参数输入；取消保留当前 Editor。刷新/关闭使用浏览器 `beforeunload`，提示依赖用户激活与平台支持，不能保证浏览器崩溃或系统终止时保留尚未保存的内容。
