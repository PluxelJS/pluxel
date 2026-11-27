---
title: Typst API 速览
description: 外部应用如何接入 Typst 编译、预览、富文本和 Agent 源码编辑。
---

`@pluxel/plugin-typst` 当前是 workspace 私有包。外部项目可接入 Pluxel 源码，或使用为目标平台构建的制品。原生编译入口需要带 `native/compiler.node` 的完整构建。 [跨仓库源码接入](../../development/source-workspaces.md) · [原生构建](https://github.com/PluxelJS/plugins/blob/9a631b7b5ea0d49edb6290e17d94b111f9c8745b/render/typst/native/README.md)

| 外部应用能做什么                           | 使用的 API                                                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 生成公式、徽章、图卡                       | 包根的 `renderSvg(source, options)`                                                                                    |
| 用同一模板反复生成报表 PDF、页图和矢量预览 | 包根的 `open()` → `update()` → `exportPdf(revision)` / `renderPage({ revision, page })`                                |
| 在网页展示矢量预览、目录和编辑器双向跳转   | `/browser` 的 `TypstPreviewView.show(preview)`、`revealSource()` 和 `onNavigate`                                       |
| 让人和 Agent 编辑同一套 `.typ` 文件        | `/source`（Node）或 `/source/browser`（浏览器），搭配 `/tiptap/react` 的 `TypstSourceEditor`                           |
| 在固定模板里提供章节富文本编辑             | `/document` 的 `parseTypstDocument()` / `printTypstDocument()`，搭配 `/tiptap/document/react` 的 `TypstDocumentEditor` |
| 在浏览器 Worker 内编译 SVG                 | `/wasm` 的 `TypstPlugin.renderSvg(source, { files })`，由宿主提供 WASM 和字体 URL                                      |

## Node 端编译报表

Host 注册 `FontsPlugin`、`TypstPlugin` 和下面的消费插件，并安装 `nodeModules()`。需要 `renderSvg()` 时再安装 `workers()`。`servicesPreset()` 已包含这两项服务。 [宿主装配](./typst.md#核心运行环境)

把下面内容存为模板目录下的 `main.typ`。表单和业务校验由应用负责，模板直接读取 JSON。

```typst
#let report = json("/inputs/report.json")
= 经营月报
营收：#report.revenue 万元
```

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { TypstError, TypstPlugin } from '@pluxel/plugin-typst'

@Plugin()
export class ReportsPlugin extends BasePlugin {
	constructor(private readonly typst: TypstPlugin) {
		super()
	}

	async render(root: string, revenue: number) {
		// root 是模板目录的绝对路径
		await using session = await this.typst.open({ root, entry: 'main.typ' })
		try {
			const { revision, preview } = await session.update({
				files: { '/inputs/report.json': { kind: 'json', value: { revenue } } },
			})
			const pdf = await session.exportPdf(revision)
			const page = await session.renderPage({ revision, page: 1 })
			return { ok: true, pdf, png: page.data, preview } as const
		} catch (error) {
			if (error instanceof TypstError && error.code === 'COMPILE_FAILED') {
				return { ok: false, diagnostics: error.diagnostics } as const
			}
			throw error
		}
	}
}
```

要做实时预览，让同一文档复用一个 session。每次 `update()` 传完整文件表。编译失败时，上一次成功修订的产物仍可读取。原生编译应使用受信任的模板和源码。 [会话契约](./typst.md#多文件编译会话与-pdf-导出)

只要一张公式图时，在消费插件内直接调用 `await this.typst.renderSvg('#set page(width: auto, height: auto)\n$sum_(i=1)^n i$')`，得到 SVG 字节。

## 完整工程与 Agent 编辑

```ts
import { createTypstSourceProject } from '@pluxel/plugin-typst/source'

const project = createTypstSourceProject({
	files: { 'main.typ': '= 月报\n\n待复核。\n' },
})

const result = project.apply({
	baseRevision: project.revision,
	patches: [{ path: 'main.typ', from: 0, to: 0, text: '// 已复核\n' }],
})
if (!result.ok) throw new Error('源码事务未接纳', { cause: result.issues })
const filesToSave = result.value.files
```

应用持久化 `filesToSave`。在浏览器中，用 `createTypstSourceProject({ files, parserWasm })` 打开同一文件表，再挂载 `<TypstSourceEditor project={project} path="main.typ" />`。编辑器支持表格、公式、题注和引用。需要与预览双向定位时，用同一源修订的映射连接编辑位置和排版坐标。 [浏览器编辑与导航](./typst-editor.md)

## 固定模板里的章节编辑

```ts
import { parseTypstDocument, printTypstDocument } from '@pluxel/plugin-typst/document'

const parsed = parseTypstDocument('= 项目概述\n\n预计完成率为 $p = n / N$。')
if (!parsed.ok) throw new Error('章节解析失败', { cause: parsed.issues })
const document = parsed.value.document // 交给 TypstDocumentEditor 的 content
const printed = printTypstDocument(document) // 实际应用传编辑器 onChange 的值
if (!printed.ok) throw new Error('章节编辑未通过校验', { cause: printed.issues })
const chapterSource = printed.value.source
```

宿主保存 `chapterSource`，决定可编辑章节、发布的资源和预览导航。如果用户只需填表，直接保存业务 JSON，再用上面的会话重排即可。 [分章项目书与审批表示例](https://github.com/PluxelJS/plugins/blob/9a631b7b5ea0d49edb6290e17d94b111f9c8745b/render/typst/tests/consumer/README.md)
