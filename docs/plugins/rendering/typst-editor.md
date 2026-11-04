---
title: Typst 源码编辑
description: 人与 Agent 共同编辑普通 Typst 文件；Tiptap 负责结构化视图，JSON 保存业务数据。
---

`.typ` 文件是正文权威。人通过 Tiptap 修改段落、样式、表格、图题和引用，Agent 直接修改同一份源码；JSON 数据与图片分别保存为普通文件。编辑器的 JSON、解析树和位置索引都能从源码重建。最终排版仍由 Typst 编译器决定。

本页维护编辑和源码事务。编译、字体、会话、资源预算与预览见 [Typst](./typst.md)。本包当前是 workspace 内的 private 包。

## 入口与安装

| 入口                          | 使用环境与职责                                              |
| ----------------------------- | ----------------------------------------------------------- |
| 包根、`/template`、`/browser` | 编译、文档定义、预览；无需编辑器或 parser                   |
| `/source`                     | Node 源码项目与事务                                         |
| `/source/browser`             | 浏览器源码项目；异步初始化匹配 parser WASM                  |
| `/source/parser.wasm`         | 浏览器 bundler 的 WASM 资源入口                             |
| `/source/library`             | 创建可保存到项目中的 LaTeX、引用和字段 helper 文件          |
| `/tiptap`                     | 原生 `createTypstSourceEditor`，包括无 DOM 用法             |
| `/tiptap/react`               | `TypstSourceEditor` 与共用编辑控件                          |
| `/tiptap/document`            | 仅接收语义文档的原生 `createTypstDocumentEditor`            |
| `/tiptap/document/react`      | 不加载源码项目的 `TypstDocumentEditor`                      |
| `/document`                   | 服务端安全投影、编辑准入与导航 `createTypstDocumentProject` |
| `/document/react`             | 不加载解析器的页图预览 `TypstDocumentPreview`               |

按包的 optional peer 清单安装所选 Tiptap/React 依赖，Tiptap 各包使用同一版本。CSS 显式导入 `@pluxel/plugin-typst/tiptap/style.css`，其中包含公式预览样式。只编译或预览的应用不需要这些依赖。

编辑器、表单与浮层通过 `light-dark()` 跟随宿主文档的 CSS `color-scheme`，不自行读取系统主题。宿主可用 `:root { color-scheme: light dark; }` 跟随系统，或设为 `light` / `dark` 显式选择；未声明时为浅色。正文中明确指定的颜色和排版预览中的文档颜色保持原值。

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

`project.snapshot()` 返回当前 `{ revision, files }`，宿主只持久化这些普通文件。`subscribe` 在接纳后同步通知；异步磁盘保存、外部 watch、编译节流由宿主处理。`toolbar={false}` 可关闭常驻栏；`onEditor` 在编辑器挂载后提供真实 Editor，释放时通知 `null`。`onIssues` 交付拒绝原因，`onReference(path, position)` 让宿主打开跨文件引用目标，`onOpenFile(path)` 让导入行打开真实项目模块，由宿主决定文件视图。

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

## 用户不接触源码的文档编辑

需要把模板和章节文件留在服务端时，使用服务端 `/document` 的 `createTypstDocumentProject`，浏览器使用 `/tiptap/document/react` 的 `TypstDocumentEditor` 和 `/document/react` 的 `TypstDocumentPreview`。它们复用源码模式的文字格式、列表、表格、公式和图题控件，浏览器入口不加载 source/parser。单篇正文和多章正文使用同一契约，章节目录、模板编排、权限、存储和通信仍由宿主持有。

[演示工作区](http://typst.pluxel.localhost:8088)把三种用法放在同一页：左侧“文件”打开经营报告和审批表，“章节”打开源码留在服务端的项目书。两者共用 Worksplit 编辑标签和右侧预览分组，切换保留草稿；私有源码的边界由服务端控制，不依赖独立页面。

```ts
import { createTypstSourceProject } from '@pluxel/plugin-typst/source'
import { createTypstDocumentProject } from '@pluxel/plugin-typst/document'

const project = createTypstSourceProject({
	files: {
		'main.typ': '#set page("a4")\n#include "body.typ"\n',
		'body.typ': '= 项目说明 <intro>\n\n请填写正文。\n',
	},
	writablePaths: ['body.typ'],
})
const documents = createTypstDocumentProject({
	project,
	documents: [{ id: 'body', title: '正文', path: 'body.typ' }],
})
const view = documents.view()
const result = documents.edit({
	baseRevision: view.revision,
	id: 'body',
	document: view.documents[0]!.document,
})
if (!result.ok) console.error(result.issues)
// 宿主只保存 project.snapshot().files；撤销重做仍用 project.undo()/redo()。
```

`documents` 可以是数组，也可以是返回当前声明的函数；宿主新增或重排章节后，下一次 `view()` 会重新读取。每个声明的 `path` 只在服务端使用，`id` 和 `title` 是宿主提供的公开文档身份；可选 `label` 把模板生成的章节标题映射到该正文的位置 0，不要求章节标题出现在正文文件内。`view()` 返回 `TypstDocumentSnapshot`，每篇正文包含 `editable`，来自原项目的 `isWritable(path)`。`edit()` 同时检查修订、可写性和语义准入，返回安全的 `CONFLICT / NOT_FOUND / READ_ONLY / INVALID_EDIT`，不传出原始源码诊断。

源码仍是唯一正文。传输中的语义 JSON 只是当前修订的编辑视图，不能作为另一份正文长期保存。宿主将 `onChange` 交给 `documents.edit()`，再把新视图回传。相同内容的回传保留选区，输入法组合期间延后替换。`editable={false}` 关闭当前编辑视图；后端的项目权限独立校验。需要远端历史时向编辑器提供 `history`，由宿主把 undo/redo 接回同一个源码项目，省略则使用本地编辑历史。

`references` 是本体产生的 `{ id, title, kind, location? }`，`kind` 为 `heading | figure | table | equation`，可编辑目标的 `location` 为 `{ documentId, position }`。本体把私有 Typst label 转成不透明 ID，正文、搜索和复制不暴露原标签；`onReference(documentId, position)` 由宿主打开相应正文。模板内的固定目标可以通过服务端 `references: [{ label, title, kind }]` 声明，没有编辑器位置也能插入引用、在预览中跳转。ID 和固定内容 key 只在当前 document project 的生命周期内有效；重新打开后从新视图取值，不把旧语义草稿移交给新实例。

文件开头的 import 与环境配置留在服务端；其他未知表达式变成 `documentBlock / documentInline`，只携带不透明 key 和“固定内容”标题，准入拒绝伪造、删除或更改这些节点。图片和本地链接通过 `resources: [{ path, url }]` 显式映射为公共 URL，路径解析与回写由本体处理；未注册的本地资源会拒绝投影，要求宿主补齐声明。资源 URL 的认证和实际内容由宿主管理。原生 Editor 入口允许组合 Tiptap 扩展，额外节点仍需明确的服务端读写契约。

宿主捕获源码修订并完成 native 编译后，调用 `documents.navigation({ revision, navigation: packet.navigation })`。`revision` 是编译输入的源码修订，不能用 session revision 替代；若源码已更新，返回 `CONFLICT`。结果包含公开文档位置、页面尺寸、矩形、真实 label 目标和原生链接，排除路径、源码行列、私有标签、不安全 scheme 和未注册的本地 URL。目标来自同次编译的 introspector，链接来自原生 Frame，支持动态章节标题和正文之外的固定区域。这些字段约束针对语义快照和导航 DTO；原生 PDF 保留 Typst 导出的命名目的地。

宿主给导航结果的每个 page 添加受控 PNG `url` 后，作为 `TypstDocumentPreviewData` 传给 `TypstDocumentPreview`；沿用 `/tiptap/style.css`。`revision` 提供当前源码修订，`pending` 表示仍有未同步草稿。旧图可以继续显示，但禁用旧坐标和链接。编辑器 `onSelection(position)` 生成新的 `selection: { documentId, position }` 即可跟随，重复同位点击也需新对象；`onReveal` 可加 `explicit: true`。`following={false}` 暂停自动跟随，显式请求仍生效。预览 `onSelect(location)` 让宿主打开正文并聚焦光标；预览里的原生内部链接只滚动目标页，保留编辑器焦点。宿主只需处理面板与 transport，不再实现命中、滚动、高亮或引用矩形合并。

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

### 新建项目文件

宿主通过 `createFile` 创建普通项目文件，不需要用完整快照替换来清空已有编辑历史：

```ts
const created = project.createFile({
	baseRevision: project.revision,
	path: 'sections/chapter.typ',
	contents: '= 新章节\n\n正文。\n',
})
if (!created.ok) console.error(created.issues)
```

路径必须是规范的项目相对路径，不能含空段、`.`、`..`、反斜杠或 NUL，也不能与现有文件或目录冲突。旧修订和已存在的文件返回 `CONFLICT`，非法路径返回 `INVALID_PATH`；非法内容类型或含孤立代理项的字符串返回 `INVALID_SOURCE`。空字符串和暂时无效的 Typst 草稿可以创建；`Uint8Array` 会复制，后续修改输入或快照的字节不会改动项目。

创建是一笔独立事务：撤销移除文件，重做恢复内容，先前编辑仍在历史中。新文件可写，显式 `writablePaths` 中未列出的已有文件仍只读。`writablePaths` 限制已有文件的编辑，不授权创建；与外部 `replace` 一样，宿主决定是否向用户开放 `createFile`，并负责权限、持久化及编译。创建 `.typ` 不会自动在其他文件添加 `include`；新的路径、标签和模块绑定会进入当前项目的索引与补全。

创建章节并更新已有目录或 `include` 时，可用一笔 `apply({ baseRevision, createFiles, patches })`。`createFiles` 是新路径到字符串或字节的表；`patches` 只定位基线已有文件，不能同时补丁修改新文件。任一路径、权限或补丁检查失败时整笔不接纳；成功只增加一次修订、通知和历史记录，撤销同时恢复目录并移除新文件。

## 结构化支持与源码入口

| 内容                                             | 编辑方式                                 |
| ------------------------------------------------ | ---------------------------------------- |
| 段落、标题、列表、链接、常见文字样式、对齐、代码 | 原生编辑器操作，局部回写                 |
| 手工表格、合并单元格、多段单元格、表格外观       | 原生表格工具；保留未修改的参数与单元格   |
| 图片、figure、富文本题注                         | 图与题注作为同一结构，模板负责编号与版式 |
| 内容组件、数据字段引用                           | 显式参数或真实数据源控件                 |
| 未知内联表达式                                   | 原位源码节点，不吞掉两侧文字             |
| 未知块、循环、复杂调用                           | 保留源码，显式源码编辑                   |
| 独立成行的静态 `include`                         | 独立章节节点，可移动并打开原文件编辑     |
| `let/import/set/show`、不能确认的语法            | 保留顺序与作用域；不能任意重排           |

无需在富文本界面模拟模板 `set/show` 的外观。无法确认的 builtin shadow、计算属性与动态语法保留源码；不求值后固化成可写正文。无操作打开/保存不改原字节，局部编辑不会把整个文件格式化。

例如，同文案但不同底色的表格单元格仍各自保留参数；合并或重排若无法确定这些参数的归属，会明确拒绝。修改完整链接的地址保留其内部强调与注释；局部选区不能把共享的未知链接结构拆成猜测出的新源码。

## 模块导入与节点控件

“插入”与 `/` 菜单提供“导入模块…”和“插入章节…”两个入口。路径输入从当前文件所在目录补全，只显示当前层的目录与 `.typ` 文件；输入 `../` 切换到上一级。方向键选择，`Enter` 或鼠标点击目录进入下一层；确认文件时立即完成引入。`Tab` 只补全路径并保留表单，方便继续配置别名或成员；已输入完整文件路径也可按 `Enter` 提交。`Escape` 先关闭可见候选，没有候选时直接取消草稿。确认文件前不会改动正文，也不会预先生成一个导入。

`#import "../components/blocks.typ"` 用于使用文件中的函数、样式等定义，支持默认模块名、别名、指定成员及 `*`；“别名或指定成员”展开后配置绑定。静态字符串 `#import` 使用原生 `typstImport` 节点，导入行显示模块和绑定。点击模块由 `onOpenFile` 打开对应项目文件，设置浮层使用同一路径补全。组件与字段插入所需的导入也使用该节点。已有导入保留声明顺序，不能跟随正文移动、复制或删除，以免改变作用域。

`#include "appendix.typ"` 用于把另一个文件的正文排在当前位置，适合拆分章节。独立成行的静态字符串 `#include` 使用 `typstInclude` 章节节点，可以移动、复制或删除；节点显示路径并可打开原文件，内容由 Typst 在预览中排版，不展开成当前编辑器中的副本。章节设置可以修改文件路径；是否允许编辑被引用文件仍由宿主的 `writablePaths` 决定。文件中的定义不会因为 `include` 而导入当前作用域。行内 `include` 保留为原位源码，不把两侧文字拆成新的段落。

路径、别名和成员修改经过同一源码准入；无操作保持字节不变，能确认的属性仅替换对应源码范围。不能保留注释的修改会拒绝并指向源码视图。动态 `import/include` 表达式、其他未支持的环境语句继续保留为源码，不求值为静态依赖。

导入、内容组件、字段与源码控件共用编辑器浮层，正文中的节点保持紧凑。点击组件标题或设置按钮编辑参数；显式开放编辑的行内字符串、数值和布尔字段直接编辑业务值，复杂 JSON 才显示源码输入。浮层自动聚焦输入框，`Escape` 取消，`Ctrl/Cmd+Enter` 应用；输入法组合期间的 Enter 只确认输入，不提交表单。未修改的浮层点击外部或 Tab 移出后关闭；已修改草稿保留至应用或取消，重复点击原入口会聚焦原草稿，另开设置或插入入口也先回到该草稿。显式关闭后焦点返回触发器，外点关闭则保留外部焦点。设置仍遵守文件可写性、修订检查与项目历史。

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

编辑器生成带显式题注策略的引用时，会在引用所在位置直接构造 `#metadata((__pluxel_reference: true, target: <eq:energy>, show-caption: false))`，仍由 `report.document` 统一显示。这样编号与展开的题注都能定位到这次引用，而原图题注保留自己的位置。手写 `#report.reference` 继续按上述语义编辑和排版；其生成内容的原生来源属于 helper 定义，不能提供调用位置的精确定位。

## 文档模板、内容组件与数据字段

文档模板拥有整篇文档的结构、排版与固定区域；内容组件负责图表、指标卡等局部内容。同一个组件可以由模板固定放置，也可以插入正文自由编排。内置或外部自定义描述来源，不改变组件的职责。

普通 `include/import` 组合文件；一个文件被多次 include 时，编辑的是共享源文件。项目相对路径允许规范化后仍在 root 内的 `../`。正文区域直接使用普通源文件，不需要独立槽位 DSL 或隐藏正文状态。

宿主通过 `writablePaths` 声明填报视图允许修改的文件：模板入口、组件定义可以只读，正文与业务 JSON 可以写。省略时所有现有文件可写，显式 `[]` 表示全部只读。`project.isWritable(path)` 返回该现有文件的可写状态，不存在的路径返回 false。结构化编辑、源码补丁与跨文件操作均经过项目准入；宿主的外部 `replace()` 接纳另一份完整快照，不受该编辑白名单限制，真实存储权限仍由宿主负责。

声明组件绑定真实 module/export，支持字符串、数值、布尔 literal 参数。`data` 指定 JSON 参数名，值仍由该 JSON 文件拥有：

```ts
const project = createTypstSourceProject({
	files,
	writablePaths: ['sections/body.typ', 'data/sales.json'],
	components: [
		{
			module: 'components/blocks.typ',
			name: 'metrics',
			label: '指标卡',
			parameters: { title: { type: 'string', label: '标题' } },
			data: 'data',
		},
	],
})
```

```typst
#import "../components/blocks.typ": metrics
#metrics(data: json("../data/sales.json"), title: "本季指标")
```

参数控件只改调用参数；数据控件改 `data/sales.json`。字段可写为 `#report.field(json("../data/sales.json"), ("company",))`。业务 schema 校验由数据所有者负责；未确认的计算参数和动态绑定保留源码，不伪装成可编辑静态值。

数据字段拥有业务值，正文中的行内字段引用只拥有这次展示。移动、复制或删除引用不修改业务数据；修改 JSON 后，模板、正文与组件在下次编译时共同读取新值。`#let` 是 Typst 局部绑定，不是业务字段声明；任意变量和计算表达式不会自动变成可写字段。

字段默认只展示。React 视图通过 `editableFields` 开放数据编辑入口，无需为普通字符串、数字或布尔值编写控件：

```tsx
<TypstSourceEditor
	project={project}
	path="sections/body.typ"
	editableFields={[
		{ file: 'data/sales.json', path: ['company'] },
		{ file: 'data/sales.json', path: ['period'] },
	]}
/>
```

`file` 使用项目根目录相对路径，`path` 是 JSON 属性或数组下标的路径数组。声明一个路径会开放其子树；`path: []` 显式开放整份 JSON，组件的“共享数据”控件才允许编辑完整 JSON。未开放的行内字段显示普通文本，共享数据仍可只读查看；数组 `length` 等派生值始终只读，不会回退成整份 JSON 的编辑入口。开发者可省略 `editableFields` 或传入 `[]`，使全部数据控件只读。

数据文件仍须通过 `project.isWritable(file)`；字段声明不能放开只读文件。模板源码只读时，可以编辑另一个文件里已开放的字段；`editable={false}` 则关闭整个视图内的写操作。`editableFields` 配置此视图提供的控件，不改变项目 `apply()` 的文件写入契约。宿主自行决定是否提供 JSON 源码或其他业务编辑入口，存储授权仍由宿主持有。

正文中手工编排的表格使用内置表格能力，直接回写普通 `#table`。从业务 JSON 生成的统计表、图表由 Typst 内容组件负责排版；复杂数据录入界面由宿主业务表单承担，使用同一项目事务修改 JSON。`renderComponentParameters` 只定制组件调用参数，不承担共享业务数据编辑，也不替换 Typst 输出。

固定表格填报可以直接复用上述文件边界：只读 `.typ` 持有标题、单元格和排版，可写 JSON 持有姓名、选项和多行文字。宿主表单将一次字段填写提交为一笔 `project.apply()`，沿用项目撤销、保存和编译；无需先把复杂版式投影成可编辑 DOM。多行文字先保存为普通字符串；确需列表、公式或图片时，再以独立可写 `.typ` 文件通过 `include` 组合。长内容的最小留白与跨页规则由文档模板持有。

[独立 consumer](https://github.com/PluxelJS/pluxel/blob/main/plugins/render/typst/tests/consumer/README.md)在同一文件树中提供经营报告和项目申请审批表两个文件夹，覆盖自由正文与固定表格两种入口；使用 Worksplit 原生文件标签与分屏组成桌面工作区，支持新建 `.typ`，并在相邻完整文档预览中检查章节组合。第三个分章项目书使用独立文档入口，用户只编辑章节正文。审批表的基础填报控件目前由这个宿主示例提供，尚未增加公共表单 schema。

“插入”菜单和 `/` 命令从 `project.components` 的只读声明及当前 JSON 文件生成候选。组件选项明确显示绑定文件，字段选项显示文件与路径；一次操作将普通 import 与调用写入同一源码事务，一次撤销即可移除。参数采用组件默认值，随后可编辑。缺少 helper、JSON 无效或当前位置的作用域改变了绑定含义时，插入明确失败，原文不变。

通用参数控件可以恢复组件默认值，操作会删除调用处的对应参数，不修改组件定义。数字输入留空使用默认值，显式输入 `0` 保留零；字符串输入留空保留空字符串，使用“恢复默认”才删除该参数。布尔选项也提供“组件默认”。

React 接入可用 `renderComponentParameters` 定制某个组件的局部参数表单。回调在参数表单渲染时同步执行，返回 null/undefined 使用默认控件；需使用 hooks 时返回自己的 React 组件。`values` 是当前参数草稿，`onChange(nextValues)` 替换这份草稿；删除 key 表示移除对应 literal 参数。组件负责其内部订阅与清理，渲染错误沿 React 正常边界传播。编辑器继续拥有应用/取消、修订检查、源码准入与撤销：

```tsx
<TypstSourceEditor
	project={project}
	path="sections/body.typ"
	renderComponentParameters={({ component, values, disabled, onChange }) =>
		component.module === 'components/blocks.typ' && component.name === 'metrics' ? (
			<input
				aria-label="指标卡标题"
				disabled={disabled}
				value={String(values.title ?? '')}
				onChange={(event) => onChange({ ...values, title: event.currentTarget.value })}
			/>
		) : undefined
	}
/>
```

字段目录在打开或搜索时生成，每次列出前 100 个匹配字段；继续细化搜索可访问大型数组后部的路径。MiTeX 自带的 WASM JSON 资源不作为业务字段枚举。

## 编译与预览定位

编译完整源文件树。更新已有 session 时，`update({ template: { root, entry }, files: {} })` 可替换普通项目树；`files` 始终是完整输入表，不是增量 patch，遗漏项会移除。不要每次按键重建 Host 或编译器。纯数据改动会重算真实图表，分析正文保持原文。

源码 revision 每次接纳改变；session revision 只在成功编译后改变。宿主把二者关联，保存、编译、显示分别报告。

`findTypstEditorPosition({ projection, sourcePosition })` 接受 native 的 **1-based UTF-16** 行列；`findTypstSourcePosition({ projection, position })` 接受 ProseMirror 位置。只对同一当前修订使用映射。compiler 诊断则是 0-based UTF-16，需要先换算；未知源码通常只能定位到所属源节点。

编辑器到预览的自动跟随接 `onSelection(position)`，映射后调用 `view.revealSource(point)`；该回调也会在同一光标处重复点击时通知。自动跟随只滚动预览并高亮，不转移编辑焦点或改变活动标签。源码改变而预览尚旧时，宿主保留当前光标，等新预览 `show()` 成功且与项目 revision 一致后重新映射；隐藏的预览面板重新显示后也要定位。`onReveal` 用于用户主动要求查看预览，可切换到预览面板。测试页提供“跟随光标”开关，关闭后仍支持预览点击返回编辑器。

函数调用的 native span 不含开头的 `#`，位置映射会落到调用表达式内。段落末尾的光标可回看同一文本块的前一字形。自定义组件的输出若只保留组件定义处的 span，当前成品没有调用实例位置，测试页会提示暂不支持定位；不要用邻近文字或另一个组件实例冒充。

预览命中转换为编辑器位置后，宿主用 `editor.commands.focus(position)` 同时设置选区、聚焦并滚动到可见区域。切换文件或从源码视图返回时，保留待定位位置，在目标视图的 `onEditor` 收到已挂载实例后应用；仅设置选区不能保证用户看见目标。测试页用真实鼠标验证两个方向、同文件靠下正文、跨页、字段、源码模式返回及跨文件路径，并验证输入后新编译自动跟随。

可复跑示例与真实 PDF/浏览器证据见 [源码工作区](https://github.com/PluxelJS/pluxel/tree/main/projects/typst-agent-workspace)。浏览器体验页由 `mise exec -- pitchfork start typst` 启动；源文件选择、JSON 数据、源码修复、保存重开和 PDF 都使用上述公开能力。
