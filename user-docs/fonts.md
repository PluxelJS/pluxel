# 服务端字体管理

`@pluxel/fonts` 是服务端字体事实与管理状态的唯一 owner。它统一发现系统字体，持有只供当前 Pluxel host 使用的
上传字体集合和默认选择，并为图片、SVG、PDF 或其他 native renderer 提供快照；它不把字体安装到操作系统，也不负责
把字体文件发送给浏览器。

## 系统字体与默认选择

`@napi-rs/canvas` 会在模块加载时调用平台 font manager，自动发现 Windows、macOS 与 Linux 的系统字体和标准用户
字体目录。Fonts 在 provider 启动时记录这份 baseline：`fonts.families` 中每项都有 `source: 'system' | 'registered'`。
它不轮询字体目录；进程运行期间新安装的系统字体会在下次 Fonts provider 或进程重启后出现。

```ts
const current = this.fonts.defaultFont
// { family, cssFamily, source, workbenchFamily?, configuredFamily? }

const revision = this.fonts.revision // renderer measurement cache invalidation signal
```

默认解析优先级是：Workbench 持久化选择 → `FontsPlugin.defaultFamily` 配置 → 当前操作系统的已安装字体优先表 →
`sans-serif` generic。`family` 用于 native renderer，`cssFamily` 已正确引用，可直接拼入 Canvas font shorthand。

## 安装与 catalog

```bash
pnpm add @pluxel/fonts
```

把 `FontsPlugin` 放入 static/dynamic host catalog。需要字体的插件通过 constructor 声明 required dependency：

```ts
import { FontsPlugin } from '@pluxel/fonts'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { fileURLToPath } from 'node:url'

@Plugin({ displayName: 'Documents' })
export class DocumentsPlugin extends BasePlugin {
	constructor(private readonly fonts: FontsPlugin) {
		super()
	}

	override init() {
		this.fonts.registerFromPath({
			path: fileURLToPath(new URL('../fonts/DocumentSerif.woff2', import.meta.url)),
			family: 'Document Serif',
		})
	}
}
```

`registerFromPath()` 只接受服务端绝对路径，并同步调用 native registry；不要把 Workbench 输入或其他不可信字符串
直接作为路径。已经读入内存的字体使用 `fonts.register({ data, family })`。两种入口都会在注册前检查 byte limit，
原生 parser 拒绝文件时抛出 `FontsError`，其 `code` 可用于稳定分支。

注册归当前 caller Context 所有。通常不需要保存返回值；consumer stop、replacement、rollback 和 shutdown 都会自动
移除对应 native key。如果业务上要提前卸载动态字体，调用 handle 的幂等 `dispose()`。

## 上传管理与 Selection Port

FontsPlugin 启动时会自动从自己的 persistence namespace 恢复唯一的 managed collection；这项业务状态不依赖
Workbench 是否打开。字体上传、删除和持久化只由 FontsPlugin 自己的 Workbench 页面负责。

Canvas、ECharts 或第三方 renderer 如果希望在自己的插件详情页提供字体入口，只挂载窄的 Selection Port：

```ts
import { FontsSelectionPort } from '@pluxel/fonts/workbench'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'

const FontsTab = workbench.portOutlet({
	id: 'Fonts',
	port: FontsSelectionPort,
	placement: workbenchContract.tab({ label: 'Fonts' }),
})

override init() {
	this.ctx.workbench.mount(FontsTab, {
		selection: workbench.bind.rpc(() => this.fonts.selectionManager()),
	})
}
```

Port renderer 和候选数据都来自 direct required dependency `FontsPlugin`；consumer 只决定 tab placement，并绑定
provider 提供的 selector。selector 可以读取系统/上传字体候选、查看当前默认值并修改这个统一默认值，不能上传或删除
字体。Workbench disabled 时 mount 不创建资源或 UI，但 FontsPlugin 仍恢复 managed collection 并提供服务端字体能力。

FontsPlugin 的管理页面会列出 generic、系统与动态注册 family，并允许上传、删除和设置 provider 级默认值。修改原子写入 Fonts 自己的
persistence namespace，所有 consumer 随后读取同一个结果；清空 Workbench override 会恢复 host 配置或系统自动值。
若选择的 managed font 暂时卸载，preference 会保留但运行期降级，font 重新出现后自动恢复。

上传使用内容与 family alias 共同生成的 server ID；相同输入是幂等安装。每个字体以单个原子 persistence record 保存，
不会出现 index 已更新而 bytes 尚未写入的中间状态。损坏记录会让 FontsPlugin 启动失败，并通过正常 dependency graph
阻塞 renderer dependent，避免运行状态显示成功但字体集合不完整。

## 配置与可见性

```ts
host.cfg(FontsPlugin).set({
	config: {
		defaultFamily: 'Noto Sans',
		maxRegistrationsPerConsumer: 32,
		maxManagedFonts: 64,
		maxFontBytes: 24 * 1024 * 1024,
	},
})
```

`defaultFamily` 省略时自动选择。默认每个 caller 最多 32 个程序化注册、统一 managed collection 最多 64 个字体，
单文件最大 16 MiB。系统字体不占这些配额。`fonts.families` 返回 detached readonly snapshot，包含系统字体和当前进程
可见注册；它不是 native registry handle。插件不会暴露 `GlobalFonts.removeAll()`，也不会在 cleanup 时删除系统字体或
进程中其他库注册的字体。
