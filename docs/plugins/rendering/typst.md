---
title: Typst 文档
description: 复用 Typst 生成无状态 SVG，或用多文件会话生成同修订 Vector 预览与 PDF。
---

`@pluxel/plugin-typst` 可以从 Typst 源码生成 SVG，也可以在编译会话中反复编译多文件工程，并从同一次排版生成矢量预览、PDF 和页面 PNG。

[外部应用 API 速览](typst-quickstart.md)

## 核心运行环境

Typst 插件依赖宿主安装的底层支撑能力：

- **无状态 SVG 渲染（`renderSvg`）**：使用宿主共享的 `Workers` 线程池。
- **文档编译会话（`open`）**：通过 `NodeModules` 服务使用专用编译 Worker，Worker 加载当前平台的原生 Typst 动态库。
- **字体服务**：通过 `FontsPlugin` 注册和分发排版所需的中英文可移植字体。

使用 `servicesPreset()` 装配的应用已预置这些基础服务。

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

## 多文件编译会话与 PDF 导出

`open({ root, entry })` 复制本地 Typst 模板目录并固定字体快照。宿主负责验证表单或业务输入，再通过 `/inputs/` 下的文件传给模板。例如，`main.typ` 可以使用 `json("/inputs/report.json")` 读取已验证的报表数据。

```ts no-twoslash
import { TypstError, type TypstFiles } from '@pluxel/plugin-typst'

await using session = await this.typst.open({
	root: '/path/to/templates/monthly-report',
	entry: 'main.typ',
})

const files: TypstFiles = {
	'/inputs/report.json': { kind: 'json', value: reportData },
	'/inputs/logo.png': { kind: 'bytes', bytes: logoBytes },
}

try {
	const compiled = await session.update({ files, signal, timeoutMs: 30_000 })
	await savePdf(await session.exportPdf(compiled.revision))
	await broadcastPreview(compiled.preview)
} catch (error) {
	if (error instanceof TypstError && error.code === 'COMPILE_FAILED') {
		console.error(error.diagnostics)
	} else {
		throw error
	}
}
```

- 每次 `update` 提交完整的 `/inputs/` 文件表，省略的文件会从输入中移除。调用方保持输入内容稳定，直到 `update` 结算。编译器在内部增量同步变化的文件。
- `update` 可以同时提供新的 `template: { root, entry }`。编译成功后才采用新模板并发布修订。编译失败保留原模板和上次成功的预览、PDF 及页面 PNG，调用方可以在原会话修正输入并重试。
- `exportPdf(revision)` 和 `renderPage({ revision, page })` 读取会话保留的成功修订，过期修订返回 `STALE_REVISION`。
- `signal` 或 `timeoutMs` 在排队和输入准备阶段只取消当前请求。在原生执行期间取消会关闭会话，随后用 `await using` 或 `dispose()` 释放会话名额和临时资源。原生执行已返回成功结果时，单次调用的取消窗口结束。

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
	sessionId: compiled.preview.sessionId,
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
	page: 1,
})

console.log(image.width, image.height) // 像素尺寸
await saveImage('page-1.png', image.data)
```

- `page` 从 `1` 开始。`scale` 表示每个 Typst point 对应的像素数，默认 `2`，最大 `8`。
- 可用 `region: { x, y, width, height }` 按页面内的 Typst point 指定裁剪范围。实际范围对齐到像素边界，由 `image.region` 返回。
- 整页每边最多 `8192` 像素，总计最多 `16,000,000` 像素。裁剪请求也受这两个整页上限约束。

## 配置项与配额

通过 `TypstConfig` 可在应用层统筹管理编译会话的资源配额：

| 配置项                | 默认值      | 说明                                                                |
| :-------------------- | :---------- | :------------------------------------------------------------------ |
| `maxSessions`         | `4`         | 同时持有的编译会话上限                                              |
| `maxQueuedOperations` | `8`         | 每个会话中等待执行的 `update` 和 `renderPage` 总数                  |
| `maxFiles`            | `4096`      | 模板目录条目、动态文件和字体各自的数量上限                          |
| `maxTemplateBytes`    | `64 MiB`    | 模板目录的文件字节上限                                              |
| `maxInputBytes`       | `256 MiB`   | 单次更新的输入文件总量或单次 SVG 调用的源码字节数                   |
| `maxOutputBytes`      | `64 MiB`    | 单次编译的 Vector、导航和 PDF 总量，或单次 SVG、页面 PNG 的字节上限 |
| `maxFontBytes`        | `64 MiB`    | 可移植字体快照的字节上限                                            |
| `maxJsonDepth`        | `64`        | 单个 JSON 输入文件的最大嵌套深度                                    |
| `maxJsonValues`       | `1,000,000` | 单个 JSON 输入文件的值数量上限                                      |
