---
title: Typst 文档
description: 复用 Typst 生成无状态 SVG，或用多文件会话生成同修订 Vector 预览与 PDF。
---

`@pluxel/plugin-typst` 是 workspace 内的文档插件，当前保持 private。业务通过 constructor 注入 TypstPlugin。本页维护编译、资源、会话和产物契约；正文、Agent Markdown、图题表题、公式和引用的使用见[区域编辑](./typst-editor.md)。

模板是普通多文件 Typst 项目。页面设计与章节组合继续使用原生 `#import` / `#include`；可编辑正文由 Tiptap JSON 生成区域文件，再由模板包含。编译器不要求模板的文件结构与编辑器 AST 相互模拟。

## 接入前提

Typst 通过 NodeModules 定位独立编译制品；每个文档会话拥有一个常驻 Worker 和 native compiler。无状态 `renderSvg()` 使用 Host 的共享 Workers。这些是 Host 显式安装的服务，安装包或注册 TypstPlugin 不会自动挂载它们。

- 使用 `standardServices()` 或 `servicesPreset()` 的应用已包含 NodeModules，无需重复安装。
- 自行组合 Host 时，会话只需 `nodeModules(...)`；调用 `renderSvg()` 另需 `workers(...)`。生产环境配置已构建的 artifact 来源；源码开发接入 Vite artifact 编译器。具体装配见 [Host 服务](../../host/services.md)与 [Node artifacts 安装说明](../../plugin-development/node-artifacts.md#选择安装能力)。
- 应用插件清单包含 FontsPlugin、TypstPlugin 与业务 consumer；FontsPlugin 是插件依赖，不是 Host 服务。无 Workbench、无 Persistence 也可使用部署字体，由 `FontsConfig.files` 提供宿主绝对路径。Typst 在模板中选择字体 family；Fonts 的 `defaultFamily` 用于 Canvas 等 renderer 的默认选择。仅管理上传字体和保存交互式默认偏好需要 Persistence，见[字体部署](./fonts.md)。

缺少 NodeModules 时，插件启动会明确失败；不会回退到主线程编译。浏览器单独使用 `@pluxel/plugin-typst/browser` 展示已有产物不需要这些服务。

本 private workspace 包使用固定 typst.ts 0.7.0 源码与最小 NAPI 补丁，构建时自动准备当前平台的原生制品，需要 Git、Rust 1.99.1 和系统 C/C++ 链接工具；安装 Rust 可执行 `rustup toolchain install 1.99.1 --profile minimal`。源码开发首次使用前运行 `vp run @pluxel/plugin-typst#prepare:native`。已打包应用带有原生制品，终端用户无需 Rust；源码和构建约定见[原生绑定](https://github.com/PluxelJS/pluxel/blob/main/plugins/render/typst/native/README.md)。

## 直接生成 SVG

只需要静态卡片、公式或可信 Typst 文本时，直接调用注入的 `TypstPlugin.renderSvg(source, options)`；无需创建文档会话：

```ts no-twoslash
const svg = await this.typst.renderSvg(
	'#set page(width: auto, height: auto, margin: 8pt)\n#set text(size: 18pt)\n$sum_(i=1)^n i$',
	{ signal, timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 },
)
// svg 是调用方拥有的 Uint8Array，mediaType 为 image/svg+xml。
await saveSvg(svg)
```

`source` 是完整的可信 Typst 源码，页面尺寸、边距和字号沿用源码；插件不插入包装模板。每次调用在共享 Worker 内创建本包同一 native compiler、编译并导出 plain SVG，不保留 session、修订或文件工作区。源文件和输出不会写入业务目录。需要模板资源、动态文件、增量更新或 PDF 时使用下面的 `open()` 会话。

请求先通过共享 Worker 接纳，再分块检查源码 UTF-8 字节数并读取当时的 FontsPlugin 可移植字体。源码受 `TypstConfig.maxInputBytes` 限制，字体受 `maxFontBytes/maxFiles` 限制；输出上限取调用参数与 `TypstConfig.maxOutputBytes` 的较小值。省略 `maxOutputBytes` 使用 provider 配置，省略 `timeoutMs` 不设请求 deadline。字体仍使用内嵌 family 名。

取消、deadline、provider 或 caller 停止会撤销排队任务或终止执行线程；Promise 等待线程执行结算，不提前释放执行额度。普通语法错误返回带 diagnostics 的 `TypstError('COMPILE_FAILED')`，可修改源码后继续调用。输入/输出超限为 `LIMIT_EXCEEDED`，共享队列/执行和取消错误保留原生契约。可信源码仍可触发 Typst 自带/系统字体及包加载；此入口不是安全沙箱，受限 Markdown 公式由 [Typst 数学扩展](./takumi-markdown.md#工作区可选的-typst-数学)先校验再调用它。

## 浏览器编译

`@pluxel/plugin-typst/wasm` 导出独立的 `TypstPlugin` 与 `TypstConfig`，在浏览器 Web Worker 内运行真实 Pluxel 插件，提供 `renderSvg(source, options?): Promise<Uint8Array>`。它使用官方 0.7.0 WASM 编译器和渲染器，不需要 NodeModules、Workers 服务、FontsPlugin 或本地原生绑定。`/browser` 仍只负责展示已有预览产物；服务端主入口的会话 API 保持原契约。

宿主为这个插件提供完整配置，没有 CDN 或默认字体地址：

```ts no-twoslash
import { TypstPlugin, TypstConfig, TypstError } from '@pluxel/plugin-typst/wasm'
import type * as v from 'valibot'

const config = {
	compilerWasmUrl: '/assets/typst_ts_web_compiler_bg.wasm',
	rendererWasmUrl: '/assets/typst_ts_renderer_bg.wasm',
	fontUrls: ['/assets/LXGWWenKai-Regular.ttf'],
} satisfies v.InferInput<typeof TypstConfig>
// 把 config 作为 TypstPlugin 的配置记录交给宿主。

// 在已注入 TypstPlugin 的业务方法内：
try {
	const svg = await this.typst.renderSvg('#set text(font: "LXGW WenKai")\nHello, Pluxel!')
	return svg // UTF-8 image/svg+xml，字节由调用方持有。
} catch (error) {
	if (error instanceof TypstError && error.code === 'COMPILE_FAILED') {
		return { diagnostics: error.diagnostics }
	}
	throw error
}
```

WASM 文件必须与已安装的 `@myriaddreamin/typst-ts-web-compiler` / `typst-ts-renderer` 0.7.0 匹配。插件为资源下载和初始化设置了 30 秒启动时限。字体在插件启动时读取，源码使用字体文件内嵌的 family 名；显式 `fontUrls: []` 适合不含文字的图形。入口固定为本次 `source` 对应的 `/main.typ`；可通过 `TypstSvgOptions.files` 提供本次编译使用的文本文件：

```ts no-twoslash
const svg = await this.typst.renderSvg('#include "sections/body.typ"', {
	files: {
		'/sections/body.typ': '#let data = json("/inputs/data.json")\n#text(data.title)',
		'/inputs/data.json': JSON.stringify({ title: 'Browser document' }),
	},
})
```

`files` 是绝对 POSIX 文件路径到文本的只读记录，接纳调用时复制。省略时没有附加文件；`/main.typ` 不允许覆盖，空路径段、`.`、`..`、反斜杠和 NUL 均以 `INVALID_INPUT` 拒绝，不做路径改写。所有文件只属于这次调用，成功或失败后均清空；后续调用必须重新提供所需文件。插件不读取站点文件、不加载 Typst 包注册表，也不注入模板。返回完整 SVG，不包含渲染器 JavaScript。

一次只接纳一个编译，重叠调用拒绝为 `BUSY`；未启动或已停止时为 `CLOSED`，空源码为 `INVALID_INPUT`。语法错误通过 `COMPILE_FAILED` 与 diagnostics 返回，修改源码后可继续调用。资源加载与底层 WASM 错误保留原始异常。每次编译释放自己的 world/session，插件停止通过 effects 释放 compiler/renderer。

WASM 编译会同步占用所在 Worker，插件没有软取消或时间上限。宿主负责超时后终止 Worker，并在页面退出时停止应用、终止 Worker；终止也会回收该 Worker 的 WASM 线性内存。需要 PDF、二进制文件资源或保留编译状态的编辑会话时继续使用服务端入口。完整浏览器装配和交互示例见 [Examples](/examples)。

Examples 打开即启动，通过示例列表切换「Typst 实时排版」与「插件热替换」。两者共用同一运行实例，切换时保留草稿与撤销记录；运行记录可在底部展开。排版示例复用 `TypstRegionEditor` 和区域生成器，提供正文格式、列表、表格、Typst 模板编辑，以及正文与预览的块级双向跳转。编辑后自动编译；处理中保留上次预览，禁用旧修订的导航，成功后恢复。示例为生成的顶层块附加 Typst 链接，使用官方 SVG 中的真实链接区域定位；跨页区域由编译器拆分。官方 WASM 0.7.0 没有开放原生补丁的字符来源查询，因此这里不宣称字符级精度；桌面端的精确导航见[编辑与定位](./typst-editor.md#预览与定位)。

在「插件热替换」示例中切换排版版本，会向 `host.updateCatalog()` 提交另一版同身份的 `ThemePlugin`。真实 Core 替换排版插件、重建依赖它的 `ReportPlugin`，保留 `TypstPlugin` 及其 WASM 实例；编辑器、撤销记录和 Worker 均不重建。页面展示实际更新报告和生命周期事件。两版插件经过相同的 Pluxel 编译变换后预先打包，模拟新模块送达；这里演示真实插件热替换，不提供浏览器内 TypeScript 构建器或开发服务器。初次资源加载后，编辑、编译和插件切换都可离线运行。

## 定义可编辑报表

`@pluxel/plugin-typst/template` 提供纯 TypeScript 文档契约，不加载 native compiler、Node 服务或插件。Studio 的报表入口采用 `目录/目录.ts`，名称由入口文件名决定，报表定义采用 default export：

```ts no-twoslash
import * as v from 'valibot'
import { defineTypstDocument } from '@pluxel/plugin-typst/template'

export default defineTypstDocument({
	template: './main.typ',
	schema: v.object({
		title: v.optional(v.string(), '示例报表'),
		amount: v.optional(v.number(), 100),
	}),
	// 可选；data 类型自动推导为 schema 解析后的输出。
	createFiles(data) {
		return { '/inputs/data.json': { kind: 'json', value: data } }
	},
})
```

`template` 相对入口解析；`schema` 是同步 Valibot object schema，允许使用 `valibot-form` 元数据描述表单。宿主从外部接收输入、合并 Valibot defaults 并校验，再调用同步 `createFiles`；省略此函数时生成 `/inputs/data.json`。生成文件只支持虚拟 `/inputs/` 内的 JSON 或文本，不写进模板工作区。实际 `.typ`、主题和字体属于源文件，可跨报表复用。

`defineTypstDocument` 保留定义对象并提供类型推导；执行隔离、路径/模块校验、数据存储和调用 native session 由宿主负责。底层 TypstPlugin 仍消费已生成的 `TypstFiles`，不会自行执行此入口或加载业务 schema。

## 生成文档

以下片段位于已注入 TypstPlugin 的业务方法内。`report`、`items` 和文件来源已由业务验证；插件不接收业务 Schema。

```ts no-twoslash
import { TypstPlugin, TypstError, type TypstFiles } from '@pluxel/plugin-typst'

// this.typst 是 constructor 注入的 TypstPlugin。
await using session = await this.typst.open({
	root: templateRoot, // 绝对路径
	entry: 'report.typ',
})

const files = {
	'/inputs/report.json': { kind: 'json', value: report },
	'/inputs/items.json': { kind: 'json', value: items },
	'/inputs/locale.json': { kind: 'file', path: localePath },
	'/inputs/logo.png': { kind: 'bytes', bytes: logoBytes },
} satisfies TypstFiles

try {
	const compiled = await session.update({ files, signal, timeoutMs: 30_000 })
	const pdf = await session.exportPdf(compiled.revision)
	await sendPreview(compiled.preview)
	await savePdf(pdf)
} catch (error) {
	if (error instanceof TypstError && error.code === 'COMPILE_FAILED') {
		showDiagnostics(error.diagnostics)
	} else {
		throw error
	}
}
```

模板使用原生文件加载：

```typst
#let report = json("/inputs/report.json")
#let items = json("/inputs/items.json")
#let locale = json("/inputs/locale.json")
= #report.title
#for item in items [#item.name: #item.amount #linebreak()]
#image("/inputs/logo.png", width: 2cm)
```

## 输入和所有权

| kind  | 输入                  | 语义                                                                                  |
| ----- | --------------------- | ------------------------------------------------------------------------------------- |
| json  | `value: unknown`      | 校验 JSON 可编码性后编码；接受普通业务 interface 和 readonly 数据，无业务 Schema 检查 |
| text  | `text: string`        | UTF-8 内容                                                                            |
| bytes | `bytes: Uint8Array`   | 保持原始字节                                                                          |
| file  | `path: string \| URL` | 宿主绝对路径或 file: URL，复制到私有磁盘空间后使用                                    |

核心只内置 JSON 编码。CBOR 等由应用安装自己的编码库，将结果作为 bytes 或 file 传入。已有大 JSON 文件可直接提供，不必先解析为 JS 对象。

逻辑路径必须是规范的 `/inputs/…` 路径，禁止空段、`.`、`..`、反斜杠及文件/目录冲突。静态模板根目录不得包含 `inputs`。模板内符号链接仅允许指向根目录内的内容。

`open` 复制模板目录并固定 FontsPlugin 的可移植字体；调用前应完成所需字体注册。字体使用内嵌 family 名，不支持 Canvas family alias。Typst 自带/系统字体与外部 Typst 包仍按上游环境加载，不属于插件目录快照或资源配额；需要固定环境时将依赖放入模板目录并控制部署字体。可信模板执行不是安全沙箱。

`update({ files, template? })` 中可选 `template` 完整替换模板树（包括删除的文件和 entry）；省略则复用上次模板快照。字体在整个会话内固定：字体变化须释放旧 session 后重新 open。

同一 session 保留 native compiler 和 shadow VFS；只将变更内容映射、删除内容取消映射，native 编译前刷新文件读取缓存并保留 memoized 计算。输入单独变化时不重新复制模板或加载字体。

每次 update 完整替换动态文件表；空表可编译静态模板，省略旧文件即移除。调用方在操作 settle 前不得修改来源；多文件的一致版本由业务准备。之后可复用自己的对象、字节和文件。文件复制避免全量 JS Buffer，但 Typst 解析与排版仍占 native 内存。

JSON 编码拒绝非有限数字、BigInt、undefined、循环引用、类实例、accessor、稀疏数组等，错误包含文件及值位置。业务验证和精确金额/日期表示由调用方负责。

## 修订、取消与释放

同一 session 的更新与按页 PNG 渲染串行，共用有界队列。每个会话保留专用 Worker、native compiler 与 shadow VFS；每次更新只同步变更或删除的文件，再编译一次，从同一 document 生成 Vector、PDF 与源码定位信息。`exportPdf` 校验修订并返回独立字节副本，不再次编译。

更新失败不替换最新成功修订。新成功更新使旧 revision 失效；已接纳的 PDF 导出不受后续更新影响。revision 仅在所属 session 中有效。预览可携带给应用通信层；浏览器入口为 `@pluxel/plugin-typst/browser`。

open/update/renderPage 接受 AbortSignal 和可选 timeoutMs，deadline 包含排队时间。取消运行中 Worker 会终止会话线程，Promise 等待执行结算，该会话随后 CLOSED，须重新 open；不保证能立即抢占 native 调用。session 关闭会取消排队/在途操作，等确认退出后清理。`dispose()` 与 `await using` 共用同一次释放，provider 或 consumer 停止也会关闭 session。

无法确认线程退出时，编译客户端报 `EXECUTION_UNSETTLED`，session 拒绝后续调用，释放报错并保留私有目录，避免删除仍在读取的资源；错误包含目录位置供宿主处理。

TypstError 的稳定 code 包括 INVALID_INPUT、LIMIT_EXCEEDED、COMPILE_FAILED、BUSY、CLOSED、STALE_REVISION。IO、Worker 和取消错误保留各自契约及 cause，不转换为语法错误。

文档会话的 diagnostics.path 相对工作区，目录分隔符统一为 `/`；range 的行和字符位置从 0 开始。原生诊断消息与源码范围保留，修复对应文件后可在同一会话继续更新。

## 服务端按页 PNG

先读取 `compiled.preview.navigation.pages` 和 `outline` 选择所需页面，再从同一成功修订按需取图。无需浏览器、额外端口或重新编译：

```ts no-twoslash
const image = await session.renderPage({
	revision: compiled.revision,
	page: 2,
	scale: 2,
	region: { x: 20, y: 40, width: 300, height: 200 },
	timeoutMs: 10_000,
})
// image.data 是 PNG；width/height 是像素尺寸，region 是实际像素对齐区域（pt）。
```

`page` 和 `revision` 为正整数；页码越界、非有限值或越过纸张边界的区域报 `INVALID_INPUT`。`scale` 表示每 pt 的像素数，默认 2，上限 8；省略 `region` 渲染整页。`TypstPageImage` 返回 revision、page、format（`png`）、data、width、height、region。

PNG 直接使用保留的成功文档；源码或输入发生变更后，应用须提交 update，并检查自己的工作区/输入版本，不能把旧修订图片称为最新结果。排队的 `renderPage` 在执行时校验修订：如果前面的 update 已成功推进 revision，则报 `STALE_REVISION`。普通渲染参数、配额或过期错误保留会话，可修正参数重试。

[Report Template Studio 的程序接入](https://github.com/PluxelJS/pluxel/blob/main/projects/report-template-studio/README.md#程序接入)在应用层持有这些 session。外部 Node 消费者通过其公开 client 连接常驻应用，使用应用编译 revision 获取 PNG/PDF 文件产物；session 的创建、字体更新和释放由应用管理。

区域裁剪在整页原生栅格化后进行，因此保留原页面渐变、背景与裁切语义。**即使只请求局部，整页栅格仍须满足单边不超过 8192 px、总计不超过 16,000,000 像素**；超限请降低 scale，返回 `LIMIT_EXCEEDED`。PNG 同时受 `maxOutputBytes` 限制。区域向外对齐到像素边界，返回的 region 表达实际采样范围。不要一次性把长文档所有页转换为图片塞入模型上下文；调用方可按目录选择少量页并按需查看局部。

## 浏览器预览

应用安装与编译器匹配的 `@myriaddreamin/typst.ts`、`@myriaddreamin/typst-ts-renderer`（当前 0.7.0），初始化 Renderer 后交给 `TypstPreviewView`。Renderer 仍由应用持有，View 拥有指定容器和每次渲染的短生命周期 RenderSession。以下使用 Vite 的 WASM URL 导入：

```ts no-twoslash
import { TypstPreviewView } from '@pluxel/plugin-typst/browser'
import { createTypstRenderer } from '@myriaddreamin/typst.ts'
import rendererWasmUrl from '@myriaddreamin/typst-ts-renderer/wasm?url'

const renderer = createTypstRenderer()
await renderer.init({ getModule: () => rendererWasmUrl })

await using view = new TypstPreviewView({ container, renderer, sessionId })
await view.show(packet) // true：已展示；false：过期或不属于此 session
```

packet 来自 `compiled.preview`。View 在离屏渲染完成后才替换容器；失败保留旧画面，应用展示错误。切换服务端 session 时先 await 旧 View 的 dispose，再在同一容器创建新的 View。关闭会等待渲染结束并清空容器。浏览器构建只导入 `/browser`，不要导入服务端根入口。

`packet.navigation` 与 Vector/PDF 属于同一次编译：`points` 包含工作区相对路径、以 1 开始的 UTF-16 源码行列（结束位置不包含在范围内）、页码，以及页面局部坐标的矩形；`outline` 包含标题、层级、页码和坐标；`pages` 包含每页的 `page`、`width`、`height`，页码以 1 开始，尺寸单位为 pt。坐标单位为 pt。生成的 `/inputs/` 和根目录外文件不作为源码跳转目标。

View 统一管理 SVG CTM 坐标、普通点击/拖选过滤、页码/目录跟随和高亮；宿主通过普通位置回调连接编辑器，并维护文件/草稿版本与可见目标选择。保留旧预览时不能直接套用已修改源码的行列。Typst 的布局映射来自原生文档 span，TypeScript 的转换 sourcemap 由 Vite 管理，二者不互相替代。每修订最多 200,000 个有效定位点，超限明确失败。

可选 `/tiptap` 与 `/tiptap/react` 支持命名正文区域、文字排版、表格、题注、LaTeX 公式、交叉引用、数据字段和 Markdown 候选。公式生成附带固定 MiTeX 文本资源，不要求动态导包；完整生成文件仍由宿主加入私有模板树，原生 `#include` 与标签解析保持 Typst 自身语义。安装、生成、持久化与定位见 [Typst 区域编辑](./typst-editor.md)。根入口、`/template` 和 `/browser` 不要求安装 Tiptap/React。

## 容量配置

`TypstConfig` 是 `configs.use()`、Host env/file 绑定和可选管理表单共用的 schema。部署复用导出值，不另写字段或从 Plugin 读取环境变量：

```ts no-twoslash
import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { nodeModules } from '@pluxel/services/node'
import { TypstConfig, TypstPlugin } from '@pluxel/plugin-typst'

export default defineHostApplication(() => ({
	plugins: [FontsPlugin, TypstPlugin], // 加入业务 consumer。
	services: [nodeModules()], // artifact 来源按接入前提配置。
	envBindings: [
		envBinding(TypstPlugin, {
			config: { schema: TypstConfig, mapping: { maxSessions: 'TYPST_MAX_SESSIONS' } },
		}),
	],
	fileBindings: [
		fileBinding(TypstPlugin, {
			config: { schema: TypstConfig, path: './typst.json' },
		}),
	],
}))
```

配置文件例如 `{ "maxSessions": 2, "maxInputBytes": 67108864 }`。env 覆盖文件值；绑定路径、优先级和只读语义见 [Host 配置](../../host/configuration.md#绑定部署环境与-json-文件)。预算变更需重启插件，修改 env/file 需重建 Host。模板根、入口及文件表是业务方法输入，不进入全局配置；字体由 FontsPlugin 配置，常驻线程数量由 maxSessions 限制。

通过 Host 给 TypstPlugin 设置运行预算；这些配置不描述业务数据。以下为初始默认上限，可按代表性模板测量调整，不是性能保证。

| 配置             | 默认值    | 范围                                           |
| ---------------- | --------- | ---------------------------------------------- |
| maxSessions      | 4         | provider 同时持有及准备中的 session            |
| maxQueuedUpdates | 8         | 每 session 等待中的 update                     |
| maxFiles         | 4096      | 每份模板/输入/字体集合；模板同时统计目录       |
| maxTemplateBytes | 64 MiB    | 每 session 静态模板快照                        |
| maxInputBytes    | 256 MiB   | 每次动态输入或无状态 SVG 源码 UTF-8            |
| maxFontBytes     | 64 MiB    | 每 session 可移植字体快照                      |
| maxOutputBytes   | 64 MiB    | 每修订 Vector + PDF + 定位信息合计，或单次 SVG |
| maxJsonDepth     | 64        | 每份 JSON 嵌套深度                             |
| maxJsonValues    | 1,000,000 | 每份 JSON 值数量                               |

输入替换准备期间可同时保留旧输入和新输入，输出更新期间也可能同时持有旧产物与新产物；预算限制单份资源，不能等同于进程 RSS 上限。每个会话至多一个常驻线程，maxSessions 限制总数，maxQueuedUpdates 限制各会话等待队列；会话不占用共享 Workers 的执行槽。无状态 SVG 使用 Host 的 Workers 并发与队列预算，不占用 `maxSessions`。
