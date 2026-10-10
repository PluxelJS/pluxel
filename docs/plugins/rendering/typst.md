---
title: Typst 文档
description: 用多文件输入生成同一修订的 Vector 预览与 PDF，并管理会话寿命。
---

`@pluxel/typst` 是 workspace 内的文档插件，当前保持 private。业务通过 constructor 注入 TypstPlugin。

## 接入前提

Typst 复用宿主的共享 Workers 执行编译，Workers 依赖 NodeModules 定位编译任务制品。这些是 Host 显式安装的服务，安装包或注册 TypstPlugin 不会自动挂载它们。

- 使用 `standardServices()` 或 `servicesPreset()` 的应用已包含 NodeModules 与 Workers，无需重复安装。
- 自行组合 Host 时，显式安装 `nodeModules(...)` 和 `workers(...)`。生产环境配置已构建的 artifact 来源；源码开发接入 Vite artifact 编译器。具体装配见 [Host 服务](../../host/services.md)与 [Node artifacts 安装说明](../../plugin-development/node-artifacts.md#选择安装能力)。
- 应用插件清单包含 FontsPlugin、TypstPlugin 与业务 consumer；FontsPlugin 是插件依赖，不是 Host 服务。无 Workbench、无 Persistence 也可使用部署字体，由 `FontsConfig.files` 提供宿主绝对路径。Typst 在模板中选择字体 family；Fonts 的 `defaultFamily` 用于 Canvas 等 renderer 的默认选择。仅管理上传字体和保存交互式默认偏好需要 Persistence，见[字体部署](./fonts.md)。

缺少 Workers 时，`open()` 会在 `ctx.require(Workers)` 处失败；不会回退到主线程编译。浏览器单独使用 `@pluxel/typst/browser` 展示已有产物不需要这些服务。

## 生成文档

以下片段位于已注入 TypstPlugin 的业务方法内。`report`、`items` 和文件来源已由业务验证；插件不接收业务 Schema。

```ts no-twoslash
import { TypstPlugin, TypstError, type TypstFiles } from '@pluxel/typst'

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

每次 update 完整替换动态文件表；空表可编译静态模板，省略旧文件即移除。调用方在操作 settle 前不得修改来源；多文件的一致版本由业务准备。之后可复用自己的对象、字节和文件。文件复制避免全量 JS Buffer，但 Typst 解析与排版仍占 native 内存。

JSON 编码拒绝非有限数字、BigInt、undefined、循环引用、类实例、accessor、稀疏数组等，错误包含文件及值位置。业务验证和精确金额/日期表示由调用方负责。

## 修订、取消与释放

同一 session 的更新串行，队列有界。每次成功更新在一个共享 Worker 任务中编译一次，并从同一 document 生成完整 Vector 和 PDF；session 保存最新产物，不保存跨任务 native compiler。`exportPdf` 校验修订并返回独立字节副本，不再次编译。

更新失败不替换最新成功修订。新成功更新使旧 revision 失效；已接纳的 PDF 导出不受后续更新影响。revision 仅在所属 session 中有效。预览可携带给应用通信层；浏览器入口为 `@pluxel/typst/browser`。

open/update 接受 AbortSignal 和可选 timeoutMs，deadline 包含排队时间。取消运行中 Worker 会请求终止线程，Promise 等待执行结算；不保证能立即抢占 native 调用。session 关闭会取消排队/在途更新，等确认退出后清理。`dispose()` 与 `await using` 共用同一次释放，provider 或 consumer 停止也会关闭 session。

无法确认线程退出时，Workers 报 `EXECUTION_UNSETTLED`，session 拒绝后续调用，释放报错并保留私有目录，避免删除仍在读取的资源；错误包含目录位置供宿主处理。

TypstError 的稳定 code 包括 INVALID_INPUT、LIMIT_EXCEEDED、COMPILE_FAILED、BUSY、CLOSED、STALE_REVISION。IO、Worker 和取消错误保留各自契约及 cause，不转换为语法错误。

## 浏览器预览

应用安装与编译器匹配的 `@myriaddreamin/typst.ts`、`@myriaddreamin/typst-ts-renderer`（当前 0.7.0），初始化 Renderer 后交给 `TypstPreviewView`。Renderer 仍由应用持有，View 拥有指定容器和每次渲染的短生命周期 RenderSession。以下使用 Vite 的 WASM URL 导入：

```ts no-twoslash
import { TypstPreviewView } from '@pluxel/typst/browser'
import { createTypstRenderer } from '@myriaddreamin/typst.ts'
import rendererWasmUrl from '@myriaddreamin/typst-ts-renderer/wasm?url'

const renderer = createTypstRenderer()
await renderer.init({ getModule: () => rendererWasmUrl })

await using view = new TypstPreviewView({ container, renderer, sessionId })
await view.show(packet) // true：已展示；false：过期或不属于此 session
```

packet 来自 `compiled.preview`。View 在离屏渲染完成后才替换容器；失败保留旧画面，应用展示错误。切换服务端 session 时先 await 旧 View 的 dispose，再在同一容器创建新的 View。关闭会等待渲染结束并清空容器。浏览器构建只导入 `/browser`，不要导入服务端根入口。

## 容量配置

`TypstConfig` 是 `configs.use()`、Host env/file 绑定和可选管理表单共用的 schema。部署复用导出值，不另写字段或从 Plugin 读取环境变量：

```ts no-twoslash
import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
import { FontsPlugin } from '@pluxel/fonts'
import { nodeModules } from '@pluxel/services/node'
import { workers } from '@pluxel/services/workers'
import { TypstConfig, TypstPlugin } from '@pluxel/typst'

export default defineHostApplication(() => ({
	plugins: [FontsPlugin, TypstPlugin], // 加入业务 consumer。
	services: [nodeModules(), workers()], // artifact 来源按接入前提配置。
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

配置文件例如 `{ "maxSessions": 2, "maxInputBytes": 67108864 }`。env 覆盖文件值；绑定路径、优先级和只读语义见 [Host 配置](../../host/configuration.md#绑定部署环境与-json-文件)。预算变更需重启插件，修改 env/file 需重建 Host。模板根、入口及文件表是业务方法输入，不进入全局配置；字体由 FontsPlugin 配置，线程池由 Host Workers 配置。

通过 Host 给 TypstPlugin 设置运行预算；这些配置不描述业务数据。以下为初始默认上限，可按代表性模板测量调整，不是性能保证。

| 配置             | 默认值    | 范围                                     |
| ---------------- | --------- | ---------------------------------------- |
| maxSessions      | 4         | provider 同时持有及准备中的 session      |
| maxQueuedUpdates | 8         | 每 session 等待中的 update               |
| maxFiles         | 4096      | 每份模板/输入/字体集合；模板同时统计目录 |
| maxTemplateBytes | 64 MiB    | 每 session 静态模板快照                  |
| maxInputBytes    | 256 MiB   | 每次动态输入                             |
| maxFontBytes     | 64 MiB    | 每 session 可移植字体快照                |
| maxOutputBytes   | 64 MiB    | 每修订 Vector + PDF 合计                 |
| maxJsonDepth     | 64        | 每份 JSON 嵌套深度                       |
| maxJsonValues    | 1,000,000 | 每份 JSON 值数量                         |

输入替换准备期间可同时保留旧输入和新输入，输出更新期间也可能同时持有旧产物与新产物；预算限制单份资源，不能等同于进程 RSS 上限。宿主 Workers 另行限制共享执行并发与排队。
