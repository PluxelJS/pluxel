---
title: 服务端字体
description: 发现、注册和管理服务端字体，并为 Canvas、ECharts 与 Takumi 提供统一字体资源。
---

`@pluxel/fonts` 统一管理服务端字体：发现系统字体、注册 Plugin 随包携带的字体、保存从 Workbench 上传的字体，
并为 Canvas/ECharts 选择 native default、为 Takumi 等独立 renderer 提供可移植 bytes。

渲染依赖始终从 Fonts 向 renderer 建立：

```text
                  ┌─> CanvasPlugin -> EChartsPlugin
FontsPlugin ------┤
                  └─> TakumiPlugin
```

`FontsPlugin` 是服务端字体的唯一管理者，但不负责创建画布或图片。Canvas/ECharts 从它取得 native family snapshot；
Takumi 从它取得内容寻址的可移植资源，不直接修改 `@napi-rs/canvas` 的全局字体注册表。

## 何时直接使用 FontsPlugin

- Plugin 自带 `.ttf`、`.otf`、`.woff` 或 `.woff2` 文件，需要在服务端 renderer 中注册。
- 需要读取当前可用的字体 family 或 provider 默认字体。
- 自己实现 renderer，需要用 `revision` 使文字测量缓存失效。
- renderer 有自己的字体 registry，需要按 `portableFonts.revision` 读取 managed/programmatic bytes。
- 需要在 Plugin 的 Workbench 页面嵌入统一的字体选择器。

只使用 Canvas、ECharts 或 Takumi 的业务 Plugin 通常不必直接注入 Fonts；由对应 renderer 依赖它即可。

## 安装与 catalog

```sh package-install
npx nypm add @pluxel/fonts
```

host catalog 必须包含 `FontsPlugin`。直接使用字体能力的 Plugin 将它声明为 required dependency：

```ts twoslash
import { FontsPlugin } from '@pluxel/fonts'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin()
export class ReportsPlugin extends BasePlugin {
	constructor(private readonly fonts: FontsPlugin) {
		super()
	}
}
```

```ts no-twoslash
import { FontsPlugin } from '@pluxel/fonts'
import { ReportsPlugin } from '@acme/reports'

host.add([FontsPlugin, ReportsPlugin])
host.start(ReportsPlugin)
await host.commit()
```

系统字体由 `@napi-rs/canvas` 的 platform font manager 在 FontsPlugin 启动时发现。它不会安装或删除操作系统字体，也不会把字体文件发到浏览器。

## 注册 Plugin 随包携带的字体

使用绝对服务端路径注册静态资源：

```ts twoslash
import { FontsPlugin } from '@pluxel/fonts'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { fileURLToPath } from 'node:url'

@Plugin()
export class ReportsPlugin extends BasePlugin {
	constructor(private readonly fonts: FontsPlugin) {
		super()
	}

	protected override async init() {
		await this.fonts.registerFromPath({
			path: fileURLToPath(new URL('../assets/ReportSans.woff2', import.meta.url)),
			family: 'Report Sans',
		})
	}
}
```

`registerFromPath()` 只接受绝对路径，并使用异步、1 MiB 分块的 bounded 文件 IO。打开 handle 后会先检查 file type/size，
只分配不超过 `maxFontBytes` 的固定 Buffer；读取期间发生 truncate 或 grow 会拒绝，而不是使用无界 `readFile()`。
`family` 是可选 alias；省略时使用字体内嵌的 family metadata。

已经取得字节时使用 `register()`：

```ts no-twoslash
const registration = await this.fonts.register({
	data: fontBytes,
	family: 'Report Sans',
	signal,
})

console.log(registration.families)
registration.dispose()
```

`data` 必须是非空 `Uint8Array`，并在 Promise settle 前保持不变；snapshot 与内容 hash 会按 1 MiB chunk 让出 event
loop。managed record 的大 byte 编解码也使用相同 checkpoint，并在 payload copy/hash 前预检 envelope、声明长度、ID 与
时间字段。文件读取、snapshot 和 hash 可取消，最终
`GlobalFonts.register()` 是有单字体 byte ceiling、不可取消的同步 commit。返回的
`FontRegistration` 包含：

- `families`：本次注册新增或改变的 family。
- `active`：registration 是否仍有效。
- `dispose()`：提前移除注册；可重复调用。

注册归属于当前 caller generation。consumer 停止或被 replacement 时，即使没有手动 `dispose()`，FontsPlugin 也会移除对应 native `FontKey`。因此不要将 registration handle 跨 generation 缓存。

## 读取字体与默认选择

```ts no-twoslash
const families = this.fonts.families
const current = this.fonts.defaultFont
const revision = this.fonts.revision
```

`families` 是 detached、只读的 family snapshot。每项包含：

- `family`：字体 family 名称。
- `source`：`system` 或 `registered`。
- `styles`：可用的 weight、width 与 style。

`defaultFont` 包含 `family`、可安全放进 Canvas font shorthand 的 `cssFamily`，以及选择来源。解析优先级为：

1. provider-wide 持久化 preference。
2. `defaultFamily` host config。
3. 当前平台的自动系统字体。
4. generic `sans-serif`。

`source` 表示是哪一层选中了默认值：`preference`、`config`、`system` 或 `generic`，不是字体资源的来源。`preferredFamily` 或 `configuredFamily` 可能存在但暂时不可用，此时解析会继续 fallback。preference 是 Fonts 自身的 provider-wide domain state；即使 Workbench 未启用，它也继续生效。

`revision` 是进程内字体注册与默认选择的变更信号。renderer 应把它纳入文字测量 cache key，或在其变化时清空缓存。直接操作 `GlobalFonts` 不会遵守这一契约。

独立 native renderer 不能共享 Canvas `GlobalFonts` 时，使用轻量 metadata snapshot 与按需 byte read：

```ts no-twoslash
const snapshot = this.fonts.portableFonts

for (const font of snapshot.fonts) {
	const detachedBytes = await this.fonts.readPortableFont(font.id, { signal })
	// 注册进 renderer-local registry；按 snapshot.revision 复用结果。
}
```

`portableFonts` 只包含 Workbench managed uploads 和 `register()` / `registerFromPath()` 资源。metadata snapshot 会缓存，
不因轮询复制 font bytes；`readPortableFont(id, { signal })` 才 cooperative 返回 detached `Uint8Array`。相同 bytes + family alias 使用同一
content ID，最后一个 registration 释放后才从集合移除。平台自动发现的 system font 没有 FontsPlugin-owned 文件，
因此诚实地不进入可移植集合。

## Workbench 管理与 Selection Attachment

FontsPlugin 自己的 manager View 管理 provider-owned 字体集合：上传、删除字体并设置默认 family。上传字体持久化在
host persistence 中，provider 重启时会恢复；这个集合是 Fonts 的领域状态，不是 Workbench 平台概念，也不属于任一
Canvas/ECharts consumer。

其他 Plugin 不应复制上传管理界面。如果只需在自己的详情页让用户选择统一默认字体，放置 Fonts 提供的 Attachment：

```ts no-twoslash
import { FontsWorkbench } from '@pluxel/fonts/workbench'
import { workbench } from '@pluxel/runtime/workbench'

export const ReportsWorkbench = workbench.define({
	fonts: FontsWorkbench.selection.place(workbench.tab({ label: 'Fonts' })),
})

protected override init() {
	this.ctx.workbench?.publish(ReportsWorkbench, {
		fonts: { provider: this.fonts },
	})
}
```

`FontsWorkbench.selection` 是 provider-only Attachment。Renderer 通过
`useWorkbench(FontsWorkbench.selection)` 取得 Fonts 提供的 `FontSelectionApi`，公开 `snapshot()` 和
`setPreferredFamily(family | null)`；传 `null` 恢复 host config 或自动选择。Consumer 不创建转发 target，也不拥有
字体 catalog/selection。Canvas、ECharts 和 Takumi 已各自放置这个 selector，普通业务 Plugin 通常不需要重复添加。

Workbench disabled 只会关闭界面，不会阻止 managed fonts 恢复、程序化注册或 headless 渲染。

## 配置

host 通过 Plugin config 配置 FontsPlugin：

```ts no-twoslash
host.cfg(FontsPlugin).set({
	defaultFamily: 'Noto Sans',
	maxRegistrationsPerConsumer: 32,
	maxNativeRegistrations: 512,
	maxTotalFontBytes: 256 * 1024 * 1024,
	maxConcurrentFontTasks: 4,
	maxQueuedFontTasks: 32,
	maxQueuedFontTasksPerConsumer: 8,
	maxPendingManagedTasks: 32,
	maxManagedFonts: 64,
	maxFontBytes: 16 * 1024 * 1024,
})
```

| 字段                            |    默认值 | 职责                                           |
| ------------------------------- | --------: | ---------------------------------------------- |
| `defaultFamily`                 |  自动选择 | Workbench 没有 override 时优先使用的系统字体   |
| `maxRegistrationsPerConsumer`   |      `32` | 一个 caller 同时持有的程序化 registration 上限 |
| `maxNativeRegistrations`        |     `512` | 此 FontsPlugin node 持有的 native key 总上限   |
| `maxTotalFontBytes`             | `256 MiB` | active native registrations 的合计 bytes       |
| `maxConcurrentFontTasks`        |       `4` | 同时进行的 caller copy/read/hash 数            |
| `maxQueuedFontTasks`            |      `32` | 所有 caller 合计等待的字体任务数               |
| `maxQueuedFontTasksPerConsumer` |       `8` | 单个 caller 等待的字体任务数                   |
| `maxPendingManagedTasks`        |      `32` | 已接纳的串行 Workbench 操作数（含 active）     |
| `maxManagedFonts`               |      `64` | provider-owned 持久化集合的字体数上限          |
| `maxFontBytes`                  |  `16 MiB` | 单个注册或上传字体文件的字节上限               |

系统字体不计入 `maxManagedFonts`，也不会被 FontsPlugin cleanup。尺寸、像素、图片解码和 DPR 都不属于 Fonts 配置：它们分别由 Canvas 与 ECharts 负责。

## 错误处理

字体操作失败时抛出 `FontsError`，可按 `error.code` 分类：

- `NOT_RUNNING`：provider 或 caller generation 已停止。
- `INVALID_INPUT`：路径、字节、文件名或 family alias 无效。
- `INVALID_FONT`：native registry 拒绝字体。
- `FONT_TOO_LARGE`、`FONT_LIMIT_EXCEEDED`：触发 byte/count 配额。
- `FONT_BUSY`：全局或 caller 字体任务队列已满。
- `FONT_NOT_FOUND`：选择或删除的字体不存在。
- `CORRUPT_FONT_STORAGE`：持久化 managed font 或默认选择损坏。

不要依赖错误 message 做分支；message 用于诊断，稳定分类在 `code`。

默认字体变化只影响之后创建的 Canvas context 和之后执行的 ECharts/Takumi render。已经准备好的文字布局与已有
native context/renderer state 保持不变；portable 集合变化会让 Takumi 在新 revision 创建新的 registry。
