---
title: Typst 文档
description: 复用 Typst 生成无状态 SVG，或用多文件会话生成同修订 Vector 预览与 PDF。
---

`@pluxel/plugin-typst` 是工作区内的专业级文档排版插件。它既支持直接传入 Typst 源码快速生成无状态的单张 SVG 图表或公式，也支持基于多文件模板创建长期持久化的会话（Session），在保障毫秒级增量编译的同时导出高保真 Vector 矢量预览与 PDF 文档。

## 核心运行环境

Typst 插件依赖宿主安装的底层支撑能力：
- **无状态 SVG 渲染（`renderSvg`）**：使用宿主共享的 `Workers` 线程池。
- **持久化文档会话（`open`）**：通过 `NodeModules` 服务加载当前平台编译的原生 Typst 动态库与专用编译 Worker。
- **字体服务**：通过 `FontsPlugin` 注册和分发排版所需的中英文可移植字体。

使用 `standardServices()` 或 `servicesPreset()` 装配的应用已预置这些基础服务。

## 直接生成无状态 SVG

对于需要静态渲染公式卡片、徽章或单页图表的场景，可直接调用 `renderSvg()`：

```ts no-twoslash
const svg = await this.typst.renderSvg(
	'#set page(width: auto, height: auto, margin: 8pt)\n#set text(size: 18pt)\n$sum_(i=1)^n i$',
	{ signal, timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 },
)

// svg 为 UTF-8 编码的 Uint8Array，MIME 类型为 image/svg+xml
await saveSvg(svg)
```

- 该方法在共享 Worker 内快速完成一次性编译并返回 SVG 字节，不保留任何中间状态或文件系统缓存。
- 源码受 `TypstConfig.maxInputBytes` 约束，生成的 SVG 受 `maxOutputBytes` 限制。

<span id="浏览器编译"></span>
## 纯前端浏览器编译（WebAssembly）

针对无需后端参与的纯前端场景，`@pluxel/plugin-typst/wasm` 提供了完全运行在浏览器 Web Worker 内的独立实现：

```ts no-twoslash
import { TypstPlugin, TypstConfig, TypstError } from '@pluxel/plugin-typst/wasm'
import type * as v from 'valibot'

const config = {
	compilerWasmUrl: '/assets/typst_ts_web_compiler_bg.wasm',
	rendererWasmUrl: '/assets/typst_ts_renderer_bg.wasm',
	fontUrls: ['/assets/LXGWWenKai-Regular.ttf'],
} satisfies v.InferInput<typeof TypstConfig>

try {
	const svg = await this.typst.renderSvg('#set text(font: "LXGW WenKai")\nHello, Pluxel!')
	return svg
} catch (error) {
	if (error instanceof TypstError && error.code === 'COMPILE_FAILED') {
		console.error('编译错误:', error.diagnostics)
	}
	throw error
}
```

- 使用官方 0.7.0 WebAssembly 编译与渲染模块，无需任何 Node.js 原生扩展。
- 支持在单次调用中通过 `files` 字段传入虚拟的辅助文件（如 JSON 数据或子模板）。

## 声明可配置报表模板

`@pluxel/plugin-typst/template` 提供了纯 TypeScript 的报表契约声明机制，用于与表单系统和前端 Studio 集成：

```ts no-twoslash
import * as v from 'valibot'
import { defineTypstDocument } from '@pluxel/plugin-typst/template'

export default defineTypstDocument({
	template: './main.typ',
	schema: v.object({
		title: v.optional(v.string(), '经营月报'),
		amount: v.optional(v.number(), 100),
	}),
	createFiles(data) {
		return {
			'/inputs/data.json': { kind: 'json', value: data },
		}
	},
})
```

- `template`：指向主入口 Typst 模板文件。
- `schema`：采用 Valibot 定义输入数据的字段规则。
- `createFiles`：将校验后的数据映射为模板内部读取的虚拟文件（如 `/inputs/data.json`）。

## 多文件持久化会话与 PDF 导出

在需要频繁更新正文并实时预览的编辑器或批处理服务中，建议通过 `open()` 创建编译会话：

```ts no-twoslash
import { TypstPlugin, TypstError, type TypstFiles } from '@pluxel/plugin-typst'

await using session = await this.typst.open({
	root: '/path/to/templates/monthly-report',
	entry: 'main.typ',
})

const files: TypstFiles = {
	'/inputs/report.json': { kind: 'json', value: reportData },
	'/inputs/logo.png': { kind: 'bytes', bytes: logoBytes },
}

try {
	// 提交增量更新并执行编译
	const compiled = await session.update({ files, signal, timeoutMs: 30_000 })

	// 获取指定修订版本的 PDF 二进制数据
	const pdf = await session.exportPdf(compiled.revision)
	await savePdf(pdf)

	// 获取用于前端渲染的矢量预览包
	await broadcastPreview(compiled.preview)
} catch (error) {
	if (error instanceof TypstError && error.code === 'COMPILE_FAILED') {
		console.error(error.diagnostics)
	} else {
		throw error
	}
}
```

- 会话内部维护了内存虚拟文件系统（Shadow VFS）和增量编译状态，后续仅传入变化文件即可快速重新编译。
- 每次成功编译会推进修订版本号（`revision`），`exportPdf()` 能够精准提取指定版本的产物。

<span id="浏览器预览"></span>
## 浏览器矢量预览组件

前端可以通过 `@pluxel/plugin-typst/browser` 提供的 `TypstPreviewView` 高性能渲染矢量预览包：

```ts no-twoslash
import { TypstPreviewView } from '@pluxel/plugin-typst/browser'
import { createTypstRenderer } from '@myriaddreamin/typst.ts'
import rendererWasmUrl from '@myriaddreamin/typst-ts-renderer/wasm?url'

const renderer = createTypstRenderer()
await renderer.init({ getModule: () => rendererWasmUrl })

await using view = new TypstPreviewView({
	container,
	scrollContainer: viewport,
	renderer,
	sessionId,
})

// 展示服务端编译生成的 preview 数据包
await view.show(compiled.preview)

// 设置缩放模式：'fit-width'（适应页宽）、'fit-page'（适应整页）或固定数值
view.setZoom('fit-width')
```

- 自动处理多页滚动、高清晰度矢量渲染与视口自适应。
- 携带了源码与排版位置的映射点集，方便实现点击预览定位源码、以及在源码中编辑时同步定位预览页面的交互。

## 服务端按页位图光栅化（PNG）

若需在没有浏览器的后端环境中直接生成各页面的预览图片或长图，可直接调用会话的 `renderPage`：

```ts no-twoslash
const image = await session.renderPage({
	revision: compiled.revision,
	page: 1, // 页码（从 1 开始）
	scale: 2, // 渲染缩放倍率（默认 2x）
	region: { x: 0, y: 0, width: 595, height: 842 }, // 可选：局部裁剪区域（单位：pt）
})

console.log(image.width, image.height) // 像素尺寸
await saveImage('page-1.png', image.data)
```

- 局部裁剪区域会在像素边界自动对齐并保留背景与渐变效果。
- 确保整页像素总数不超过系统上限（默认 16,000,000 像素）。

## 配置项与配额

通过 `TypstConfig` 可在应用层统筹管理编译会话的资源配额：

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `maxSessions` | `4` | 宿主允许同时保有的常驻编译会话数 |
| `maxQueuedUpdates` | `8` | 单个会话允许排队的最大增量更新请求数 |
| `maxTemplateBytes` | `64 MiB` | 静态模板目录的最大体积上限 |
| `maxInputBytes` | `256 MiB` | 单次动态更新传入文件的最大数据量 |
| `maxOutputBytes` | `64 MiB` | 编译生成的产物（PDF + Preview）最大允许大小 |
| `maxFontBytes` | `64 MiB` | 注册字体的最大内存占用 |
