---
title: Typst 源码编辑
description: 人与 Agent 共同编辑普通 Typst 文件，按需组合 Tiptap、章节事务与预览。
---

普通 `.typ` 文件保存正文，Tiptap 提供可选的结构化视图。完整工程可以保留原有脚本、模板调用和未触及的源码。分章应用可以对可编辑正文采用可往返的 Typst 子集，让富文本、源码视图和 Agent 共享接纳规则。两种用法都可直接使用原生编译会话。 [Typst 编译用法](typst.md)

## 模块子入口与职责划分

| 子入口                               | 运行环境与职责                                                   |
| :----------------------------------- | :--------------------------------------------------------------- |
| `.`（包根）、`/template`、`/browser` | 服务端编译、文档模板定义与矢量预览组件；无需编辑器依赖           |
| `/source`                            | Node.js 服务端环境下的源码工程与事务管理                         |
| `/source/browser`                    | 浏览器环境下的源码工程；异步加载语法解析器 WebAssembly 模块      |
| `/source/parser.wasm`                | 语法解析器 WASM 二进制文件资源入口                               |
| `/tiptap`                            | 原生核心编辑器工厂 `createTypstSourceEditor`（支持无 DOM 模式）  |
| `/tiptap/react`                      | React 界面组件 `TypstSourceEditor` 及配套工具栏                  |
| `/document`                          | Node.js 的 `parseTypstDocument` 与 `printTypstDocument` 正文转换 |
| `/tiptap/document`                   | 从 Tiptap JSON 打开正文编辑器，支持无 DOM 模式                   |
| `/tiptap/document/react`             | 从 Tiptap JSON 挂载正文编辑器和工具栏                            |
| `/document/react`                    | 消费宿主提供的页图和导航，支持双向定位                           |

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

## 按章节编辑正文

`/document` 提供两项无状态转换。`parseTypstDocument(source)` 将单章 `.typ` 转为 `{ document, mapping }`。`printTypstDocument(candidate)` 接收待校验的 Tiptap JSON，返回 `{ source, document }`。`source` 是规范化的原生 Typst，`document` 是相应的规范化树。重新打开章节时从 `.typ` 重建文档树。

下面的 Node.js 示例将 Typst 和富文本输入接到同一个生成函数。它将成功结果保存为普通章节文件。

```ts
import { writeFile } from 'node:fs/promises'
import { parseTypstDocument, printTypstDocument } from '@pluxel/plugin-typst/document'

type ChapterInput = { kind: 'typst'; source: string } | { kind: 'tiptap'; document: unknown }

function convert(input: ChapterInput) {
	if (input.kind === 'tiptap') return printTypstDocument(input.document)
	const parsed = parseTypstDocument(input.source)
	return parsed.ok ? printTypstDocument(parsed.value.document) : parsed
}

const result = convert({
	kind: 'typst',
	source: '= 项目概述\n\n预计完成率为 $p = n / N$。',
})

if (result.ok) await writeFile('chapter.typ', result.value.source)
else console.error(result.issues)
```

语法错误和超出正文子集的用法分别返回 `INVALID_TYPST` 和 `UNSUPPORTED_SYNTAX`，区间 `[from, to)` 使用 UTF-8 字节偏移。`INVALID_DOCUMENT` 的 `path` 定位候选文档树中的字段。

React 页面把解析成功后的 `value.document` 作为 `TypstDocumentEditor` 的 `content`，从 `onChange` 接收富文本草稿。运行时入口是 `@pluxel/plugin-typst/tiptap/document/react`，样式沿用 `@pluxel/plugin-typst/tiptap/style.css`。Node.js 可用 `/tiptap/document` 的 `createTypstDocumentEditor()` 执行无 DOM 编辑，完成后调用 `editor.destroy()`。

宿主可按需开放本章原生源码。人或 Agent 读取获准章节的 `.typ` 和基线修订，提交修改后走相同的生成与接纳路径。宿主核对章节权限、修订、引用目标与素材，再提交生成的 `.typ`。可公开素材直接使用原文件。需要保护原件时，宿主提供获准的发布版，并用同一批输入产生预览和原生 PDF。PDF 保留编译器生成的文本、矢量内容和链接。 [分章项目书示例](../../../plugins/render/typst/tests/consumer/README.md) · [编译与 PDF 导出](typst.md)

## Agent 源码事务与增量补丁

有权直接修改完整 Typst 工程的 Agent 可以按基线和字节范围提交补丁。

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

## 正文子集的排版能力

| 文档元素                 | 原生 Typst 表达                                                                        |
| :----------------------- | :------------------------------------------------------------------------------------- |
| 段落、标题、列表、引用块 | Typst 标记语法，支持常见强调、对齐、字面字体和颜色                                     |
| 图片、表格和图题         | 本地 `#image(...)`、带表头和合并单元格的 `#table(...)`、`#figure(..., caption: [...])` |
| 行内数学和块级公式       | 原生 `$...$`，如 `$p = (n + 1) / N$`。编辑树保存 `attrs.expression`                    |
| 标签及引用               | `<label>`、`@label` 或 `#ref(<label>)`。目标 ID 使用实际 Typst 标签                    |

源文件的控制语句、导入、自定义调用和计算参数留在完整工程或宿主模板。正文转换按已支持的参数、节点和作用域接纳完整输入。解析和生成按规范化树往返，空白及等价格式写法会归一化。完整源码工程的结构化编辑使用保留式补丁，适用于自定义组件、静态 `#include` 和保留原式的草稿。工程还可使用 `/source/library` 的 `createTypstSourceLibrary()` 引入完整 Typst 模板所需的 MiTeX 和 `report.latex`。

<span id="编译与预览定位"></span>

## 源码与预览的双向位置同步

完整工程使用 `findTypstSourcePosition` 将编辑器位置转换成源码位置，再交给 `TypstPreviewView.revealSource()`。点击预览时，`findTypstEditorPosition` 将编译器提供的源码行列映射到 ProseMirror 位置，宿主调用 `editor.commands.focus(position)`。

分章应用从实际送编译的同一版本正文得到 `mapping`。宿主把本次编译的源码跨度和标签目标映射成章节 ID、编辑器区间及页面坐标，再交给 `TypstDocumentPreview`。预览按当前修订跟随编辑器并使用真实页面链接。模板内的固定目标可以只提供页面目的地。
