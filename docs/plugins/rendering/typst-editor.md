---
title: Typst 源码编辑
description: 人与 Agent 共同编辑普通 Typst 文件；Tiptap 负责结构化视图，JSON 保存业务数据。
---

在 Pluxel 中，`.typ` 源码文件始终是文档内容的唯一事实来源。用户可以通过基于 Tiptap 的可视化富文本界面直观修改段落、格式、表格与图题；AI Agent 或自动化流程也可以直接读写底层源码。复杂的业务参数和表格数据则由单独的 JSON 文件存储，编辑器的解析树与位置索引均可随时从源码完整重建。

## 模块子入口与职责划分

| 子入口                               | 运行环境与职责                                                  |
| :----------------------------------- | :-------------------------------------------------------------- |
| `.`（包根）、`/template`、`/browser` | 服务端编译、文档模板定义与矢量预览组件；无需编辑器依赖          |
| `/source`                            | Node.js 服务端环境下的源码工程与事务管理                        |
| `/source/browser`                    | 浏览器环境下的源码工程；异步加载语法解析器 WebAssembly 模块     |
| `/source/parser.wasm`                | 语法解析器 WASM 二进制文件资源入口                              |
| `/tiptap`                            | 原生核心编辑器工厂 `createTypstSourceEditor`（支持无 DOM 模式） |
| `/tiptap/react`                      | React 界面组件 `TypstSourceEditor` 及配套工具栏                 |
| `/tiptap/document/react`             | 针对受控业务模式的文档编辑器组件（无需接触原始 Typst 源码）     |
| `/document`                          | 服务端安全文档工程：提供只读投影、编辑准入与语义级导航          |

## 快速上手：在 React 中嵌入富文本编辑器

在前端项目中引入样式与解析器，直接挂载 `TypstSourceEditor`：

```tsx
import { createRoot } from 'react-dom/client'
import { createTypstSourceProject } from '@pluxel/plugin-typst/source/browser'
import { TypstSourceEditor } from '@pluxel/plugin-typst/tiptap/react'
import parserWasm from '@pluxel/plugin-typst/source/parser.wasm?url'
import '@pluxel/plugin-typst/tiptap/style.css'

async function mount(element: HTMLElement) {
	// 初始化浏览器源码工程
	const project = await createTypstSourceProject({
		parserWasm,
		files: {
			'main.typ': '= 季度业务复盘\n\n请在下方补充各部门进展。\n',
		},
	})

	const root = createRoot(element)
	root.render(<TypstSourceEditor project={project} path="main.typ" />)

	return {
		project,
		dispose: () => root.unmount(),
	}
}

mount(document.getElementById('root')!)
```

- `project.snapshot()` 可获取当前所有文件的最新版本与内容快照，用于提交持久化存储。
- 通过 `project.subscribe()` 可监听变更事件，实现实时的草稿自动保存或编译预览联动。

## 服务端与无 DOM 环境下的原生编辑器

在 Node.js 环境或自动化测试中，无需加载 DOM 即可直接使用 `createTypstSourceEditor` 执行结构化内容修改：

```ts
import { createTypstSourceProject } from '@pluxel/plugin-typst/source'
import { createTypstSourceEditor } from '@pluxel/plugin-typst/tiptap'

const project = createTypstSourceProject({
	files: { 'main.typ': '初始内容分析。\n' },
})

const editor = createTypstSourceEditor({
	project,
	path: 'main.typ',
	onIssues: (issues) => {
		if (issues.length) console.warn('编辑问题:', issues)
	},
})

try {
	// 在第一行后插入结构化节点
	editor.commands.insertContentAt(1, { type: 'text', text: '【已复核】' })

	// 获取修改后的真实 Typst 源码
	console.log(project.snapshot().files['main.typ'])
} finally {
	editor.destroy()
}
```

<span id="用户不接触源码的文档编辑"></span>

## 面向终端用户的安全受控文档编辑

在许多企业应用场景中，排版模板由设计人员维护，业务填报人员仅需填写指定的正文或表格，不应直接接触或破坏底层的 Typst 宏与版式定义。

此时可以使用 `/document` 提供的文档投影系统：

```ts
import { createTypstSourceProject } from '@pluxel/plugin-typst/source'
import { createTypstDocumentProject } from '@pluxel/plugin-typst/document'

// 1. 服务端加载完整工程，声明哪些文件允许用户修改
const project = createTypstSourceProject({
	files: {
		'main.typ': '#set page("a4")\n#include "body.typ"\n',
		'body.typ': '= 项目概述 <intro>\n\n请在此处输入正文。\n',
	},
	writablePaths: ['body.typ'],
})

// 2. 将特定文件抽象为可编辑的语义文档
const documents = createTypstDocumentProject({
	project,
	documents: [{ id: 'body', title: '正文部分', path: 'body.typ' }],
})

// 3. 生成向前端暴露的轻量文档视图（不泄露服务端文件路径）
const view = documents.view()

// 4. 接收前端回传的富文本变更并应用修改
const result = documents.edit({
	baseRevision: view.revision,
	id: 'body',
	document: view.documents[0]!.document,
})

if (!result.ok) {
	console.error('修改校验未通过:', result.issues)
}
```

- 前端仅需引入轻量的 `TypstDocumentEditor`，无需在浏览器端解析语法或加载 WASM。
- 服务端会校验修订号与字段权限，确保用户操作不会破坏未授权的章节或宏指令。

文档投影中的 JSON 来自当前源码修订，编辑成功后仍写回同一源码工程。固定内容、引用身份和历史由该工程及投影实例维护。

宿主通过 `resources: [{ path, url }]` 将允许公开的本地资源映射为 URL，并负责这些 URL 的访问控制和实际响应内容。`writablePaths` 只限定源码写入范围；资产下载、PDF 导出及编译环境的读取权限由宿主分别控制。

## Agent 源码事务与增量补丁

Agent 或外部后台可以通过基于字节范围的精确补丁（Patches）进行协同修改：

```ts
const baseline = project.snapshot()
const result = project.apply({
	baseRevision: baseline.revision,
	patches: [
		{
			path: 'main.typ',
			from: 0,
			to: 0,
			text: '// 由 Agent 于 2026-11-05 校验\n',
		},
	],
})

if (!result.ok) {
	console.error('补丁冲突或权限错误:', result.issues)
}
```

- 补丁的 `from` 和 `to` 使用基线文件的 UTF-8 字节偏移。
- 只有基线版本匹配且所有检查通过时，事务才会原子生效并生成新的修订版本。

## 结构化富文本能力与映射规则

编辑器针对主流 Typst 语法提供了开箱即用的可视化操作支持：

| 语法结构                           | 交互体验                                          | 源码回写规则                                             |
| :--------------------------------- | :------------------------------------------------ | :------------------------------------------------------- |
| 段落、标题、列表、加粗、斜体、代码 | 原生富文本输入体验                                | 回写为对应的 Markdown/Typst 常用符号（`*`、`_`、`=` 等） |
| 手工排版表格                       | 支持增删行/列、合并单元格、边框背景调节           | 回写为标准的 `#table(...)` 语法                          |
| 图片与图题（Figure）               | 统一的图片插入控件，支持编辑 Caption              | 回写为 `#figure(image(...), caption: [...]) <label>`     |
| 数学公式                           | 支持行内公式与独立块公式，提供即时渲染预览        | 回写为原生 `$ ... $` 语法                                |
| 交叉引用（References）             | 键入 `@` 自动补全当前工程中已声明的图表与章节标签 | 回写为 `@label` 语法                                     |
| 章节包含（Include）                | 树状章节卡片，可调整顺序或跳转子文件              | 回写为 `#include "..."`                                  |

<span id="编译与预览定位"></span>

## 源码与预览的双向位置同步

为提供类似 Overleaf 或现代文档编辑器的流畅体验，系统提供了高精度的双向光标跟随机制：

1. **从源码跳转预览**：
   在编辑器光标变动时，调用 `findTypstSourcePosition` 将当前光标位置转换为 Typst 源码位置，并通过 `TypstPreviewView.revealSource()` 在预览面板中高亮并滚动到对应区域。

2. **从预览跳转源码**：
   在预览面板中点击任意文本或图表时，预览组件将命中点的物理坐标转换为行列信息，通过 `findTypstEditorPosition` 转换为 ProseMirror 节点位置，并调用 `editor.commands.focus(position)` 聚焦选区。
