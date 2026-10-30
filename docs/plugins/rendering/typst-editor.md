---
title: Typst 源码编辑
description: 人与 Agent 共同编辑普通 Typst 文件；Tiptap 负责结构化视图，JSON 保存业务数据。
---

`.typ` 文件是正文权威。人通过 Tiptap 修改段落、样式、表格、图题和引用，Agent 直接修改同一份源码；JSON 数据与图片分别保存为普通文件。编辑器的 JSON、解析树和位置索引都能从源码重建。最终排版仍由 Typst 编译器决定。

本页维护编辑和源码事务。编译、字体、会话、资源预算与预览见 [Typst](./typst.md)。本包当前是 workspace 内的 private 包。

## 入口与安装

| 入口                          | 使用环境与职责                                     |
| ----------------------------- | -------------------------------------------------- |
| 包根、`/template`、`/browser` | 编译、文档定义、预览；无需编辑器或 parser          |
| `/source`                     | Node 源码项目与事务                                |
| `/source/browser`             | 浏览器源码项目；异步初始化匹配 parser WASM         |
| `/source/parser.wasm`         | 浏览器 bundler 的 WASM 资源入口                    |
| `/source/library`             | 创建可保存到项目中的 LaTeX、引用和字段 helper 文件 |
| `/tiptap`                     | 原生 `createTypstSourceEditor`，包括无 DOM 用法    |
| `/tiptap/react`               | `TypstSourceEditor` 与共用编辑控件                 |

按包的 optional peer 清单安装所选 Tiptap/React 依赖，Tiptap 各包使用同一版本。CSS 显式导入 `@pluxel/plugin-typst/tiptap/style.css`，其中包含公式预览样式。只编译或预览的应用不需要这些依赖。

## 最小 React 接入

以下是浏览器入口；`files` 应来自宿主读取的普通项目文件。创建 project 一次，各文件视图共享它，切换文件不用复制另一份正文。

```tsx
import { createRoot } from 'react-dom/client'
import { createTypstSourceProject } from '@pluxel/plugin-typst/source/browser'
import { TypstSourceEditor } from '@pluxel/plugin-typst/tiptap/react'
import parserWasm from '@pluxel/plugin-typst/source/parser.wasm?url'
import '@pluxel/plugin-typst/tiptap/style.css'

async function mount(element: HTMLElement) {
	const project = await createTypstSourceProject({
		parserWasm,
		files: { 'main.typ': '= 季度报告\n\n请填写分析。\n' },
	})
	const root = createRoot(element)
	root.render(<TypstSourceEditor project={project} path="main.typ" />)
	return { project, dispose: () => root.unmount() }
}

mount(document.getElementById('root')!).catch((error) => {
	document.getElementById('root')!.textContent = String(error)
})
```

`project.snapshot()` 返回当前 `{ revision, files }`，宿主只持久化这些普通文件。`subscribe` 在接纳后同步通知；异步磁盘保存、外部 watch、编译节流由宿主处理。`toolbar={false}` 可关闭常驻栏；`onEditor` 提供真实 Editor，`onIssues` 交付拒绝原因，`onReference(path, position)` 让宿主打开跨文件目标。

## 原生编辑器

Node 入口无需浏览器 WASM 参数。无 DOM 编辑使用同一套投影、准入和项目历史：

```ts
import { createTypstSourceProject } from '@pluxel/plugin-typst/source'
import { createTypstSourceEditor } from '@pluxel/plugin-typst/tiptap'

const project = createTypstSourceProject({ files: { 'main.typ': '原始分析。\n' } })
const editor = createTypstSourceEditor({
	project,
	path: 'main.typ',
	onIssues: (issues) => {
		if (issues.length) console.error(issues)
	},
})
try {
	editor.commands.insertContentAt(1, { type: 'text', text: '已核实：' })
	console.log(project.snapshot().files['main.typ'])
} finally {
	editor.destroy()
}
```

`editor.getJSON()` 是派生结果，不应保存为正文。结构化编辑无法保留未知语义时拒绝该操作，原文不变；React 界面提供就地源码编辑。项目 `undo/redo` 同时撤销一笔事务涉及的全部文件，Editor 的撤销命令使用该历史。

无 DOM 调用传入原生 `JSONContent`，如上面的文本节点。字符串形式的 `insertContent` / `insertContentAt` 会走 HTML 解析，需要浏览器 DOM。

## Agent 与源码事务

补丁的 `from/to` 是**基线文件的 UTF-8 字节偏移**，不是 JavaScript 字符索引或编辑器位置。每批绑定 `baseRevision`，全部检查通过才接纳：

```ts
const baseline = project.snapshot()
const source = baseline.files['main.typ']
if (typeof source !== 'string') throw new Error('Expected text source')
const result = project.apply({
	baseRevision: baseline.revision,
	patches: [{ path: 'main.typ', from: 0, to: 0, text: '// 已复核\n' }],
})
if (!result.ok) console.error(result.issues)
```

`writablePaths` 可以限制已有可写文件。外部 Agent 改动由宿主读取完整文件快照后调用 `replace({ baseRevision, files })`；它重建视图并清空旧历史。旧修订操作返回 `CONFLICT`，不会按过期范围覆盖新文件。存储层仍需自己的磁盘 CAS 和原子提交；内存修订不代替外部文件锁。

允许保存暂时无效的 Typst，诊断包含文件、源码范围和修订。不要把“已保存”写成“编译成功”；保留上次成功预览时显示其源码修订，并停用过期定位。修复原文后，同一项目与编译会话可以继续使用。

文件中已有语法错误时，仍可编辑能确认的其他段落；结构化事务不能触碰未修复的错误范围或引入新错误。遇到拒绝先查看 `onIssues`，再通过源码入口修复，不要反复提交旧投影。

## 结构化支持与源码入口

| 内容                                             | 编辑方式                                 |
| ------------------------------------------------ | ---------------------------------------- |
| 段落、标题、列表、链接、常见文字样式、对齐、代码 | 原生编辑器操作，局部回写                 |
| 手工表格、合并单元格、多段单元格、表格外观       | 原生表格工具；保留未修改的参数与单元格   |
| 图片、figure、富文本题注                         | 图与题注作为同一结构，模板负责编号与版式 |
| 模板组件、JSON 字段                              | 显式参数或真实数据源控件                 |
| 未知内联表达式                                   | 原位源码节点，不吞掉两侧文字             |
| 未知块、循环、复杂调用                           | 保留源码，显式源码编辑                   |
| `let/import/set/show`、不能确认的语法            | 保留顺序与作用域；不能任意重排           |

无需在富文本界面模拟模板 `set/show` 的外观。无法确认的 builtin shadow、计算属性与动态语法保留源码；不求值后固化成可写正文。无操作打开/保存不改原字节，局部编辑不会把整个文件格式化。

例如，同文案但不同底色的表格单元格仍各自保留参数；合并或重排若无法确定这些参数的归属，会明确拒绝。修改完整链接的地址保留其内部强调与注释；局部选区不能把共享的未知链接结构拆成猜测出的新源码。

## 图表、公式与交叉引用

原生源码是引用事实：

```typst
#figure(image("../assets/revenue.svg"), caption: [季度营收 *对比*。]) <fig:revenue>

详见 @fig:revenue。
```

输入 `@` 可搜索项目内确认的图、表、公式标签。figure 的 label 输入修改会原子更新已确认的跨文件引用；`project.renameLabel` 提供同一操作。静态未命中可能是文献引用或动态 label，UI 显示未确认，编译器给出最终诊断。

`project.move({baseRevision,path,label,toPath,at})` 移动确认目标及题注；`project.copy({baseRevision,path,from,to,toPath,at})` 复制完整顶层块，分配无冲突 label，只重绑副本内部引用。范围都是 UTF-8。涉及未知作用域、无法确认的依赖或不允许写的文件时明确失败，不能把保留字节视作允许任意程序移动。

LaTeX 与原生 Typst 数学语法是两种语言。原生 `$...$` 保留原式；已有 LaTeX 能力使用显式 helper，文件先由宿主生成并持久化：

```ts
import { createTypstSourceLibrary } from '@pluxel/plugin-typst/source/library'
const libraryFiles = await createTypstSourceLibrary()
// 将 libraryFiles 的每个 path/text 保存进同一个项目，再送入编译快照。
```

```typst
#import "lib/pluxel.typ" as report
#show: report.document
#set math.equation(numbering: "(1)")

#report.latex("E = mc^2", block: true) <eq:energy>

#report.reference(<eq:energy>, caption: auto)
```

引用显示对应 `caption: auto`（跟随模板）、`false`（不附题注）、`true`（编号与题注）。`false` 保留 Typst 模板的 supplement，如“图 1”，不保证只输出数字。helper 对题注内自引用、互引用使用短引用以终止展开。修改 helper 文件本身会使原有语义识别失效，此时调用保留为源码。

## 模板与 JSON 数据

普通 `include/import` 组合文件；一个文件被多次 include 时，编辑的是共享源文件。项目相对路径允许规范化后仍在 root 内的 `../`。无需在编辑器保存另一份依赖图。

声明组件绑定真实 module/export，支持字符串、数值、布尔 literal 参数。`data` 指定 JSON 参数名，值仍由该 JSON 文件拥有：

```ts
const project = createTypstSourceProject({
	files,
	components: [
		{
			module: 'template/blocks.typ',
			name: 'metrics',
			label: '指标卡',
			parameters: { title: { type: 'string', label: '标题' } },
			data: 'data',
		},
	],
})
```

```typst
#import "../template/blocks.typ": metrics
#metrics(data: json("../data/sales.json"), title: "本季指标")
```

参数控件只改调用参数；数据控件改 `data/sales.json`。字段可写为 `#report.field(json("../data/sales.json"), ("company",))`。业务 schema 校验由数据所有者负责；未确认的计算参数和动态绑定保留源码，不伪装成可编辑静态值。

“插入”菜单和 `/` 命令从 `project.components` 的只读声明及当前 JSON 文件生成候选。组件选项明确显示绑定文件，字段选项显示文件与路径；一次操作将普通 import 与调用写入同一源码事务，一次撤销即可移除。参数采用模板默认值，随后可编辑。缺少 helper、JSON 无效或当前位置的作用域改变了绑定含义时，插入明确失败，原文不变。

字段目录在打开或搜索时生成，每次列出前 100 个匹配字段；继续细化搜索可访问大型数组后部的路径。MiTeX 自带的 WASM JSON 资源不作为业务字段枚举。

## 编译与预览定位

编译完整源文件树。更新已有 session 时，`update({ template: { root, entry }, files: {} })` 可替换普通项目树；`files` 始终是完整输入表，不是增量 patch，遗漏项会移除。不要每次按键重建 Host 或编译器。纯数据改动会重算真实图表，分析正文保持原文。

源码 revision 每次接纳改变；session revision 只在成功编译后改变。宿主把二者关联，保存、编译、显示分别报告。

`findTypstEditorPosition({ projection, sourcePosition })` 接受 native 的 **1-based UTF-16** 行列；`findTypstSourcePosition({ projection, position })` 接受 ProseMirror 位置。只对同一当前修订使用映射。compiler 诊断则是 0-based UTF-16，需要先换算；未知源码通常只能定位到所属源节点。

可复跑示例与真实 PDF/浏览器证据见 [源码工作区](https://github.com/PluxelJS/pluxel/tree/main/projects/typst-agent-workspace)。浏览器体验页由 `mise exec -- pitchfork start typst` 启动；源文件选择、JSON 数据、源码修复、保存重开和 PDF 都使用上述公开能力。
