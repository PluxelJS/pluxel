# @pluxel/fonts

`@pluxel/fonts` 是 Pluxel 官方服务端字体 capability。它统一负责系统字体发现、provider-owned 上传集合、
默认字体选择、持久化、容量边界和原生资源回收；Canvas/ECharts 消费 native snapshot，Takumi 等独立
renderer 消费内容寻址的可移植资源。

Windows、macOS 与 Linux 字体由 `@napi-rs/canvas` 的 platform font manager 自动发现。`fonts.families` 标出
`system` / `registered` 来源，`fonts.defaultFont` 按 provider preference → host config → 系统自动选择 → generic
顺序解析。`setPreferredFamily()` 可在 headless host 中修改同一个 provider-wide preference。

## 程序化注册

业务插件随代码携带的静态字体仍由调用方拥有，但注册和 native key 始终由 FontsPlugin 管理：

```ts
import { FontsPlugin } from '@pluxel/fonts'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { fileURLToPath } from 'node:url'

@Plugin()
export class ReportsPlugin extends BasePlugin {
	constructor(private readonly fonts: FontsPlugin) {
		super()
	}

	override async init() {
		await this.fonts.registerFromPath({
			path: fileURLToPath(new URL('../assets/ReportSans.woff2', import.meta.url)),
			family: 'Report Sans',
		})
	}
}
```

路径必须是服务端绝对路径并使用异步的 bounded 分块文件 IO：打开后先检查 size，只按允许的大小分配，并拒绝读取期间
truncate/grow 的文件。也可以 `await fonts.register({ data, family, signal })` 注册
`Uint8Array`；bytes 在 Promise settle 前保持不变，copy 与内容 hash 会 cooperative yield。managed record 的大 byte
编解码也使用相同 checkpoint，恢复时会在 payload copy/hash 前先检查 envelope 大小与 metadata。最终 native registry commit
有单字体 byte ceiling，但上游不提供可取消入口。这类代码资源绑定
caller generation；consumer stop/replacement 时 FontsPlugin 移除对应 `FontKey`。返回 handle 的 `dispose()` 只用于
提前删除，重复调用无副作用。

## 统一管理页面与 Selection Attachment

FontsPlugin 启动时自动加载唯一的 managed collection。Collection 是 Fonts 自己的业务对象，不是 Workbench
collection、resource 或 capability entity；字体增删不会改变 layout、producer 或 Attachment identity。Workbench
关闭时同一集合仍在 headless host 加载。

需要在其他插件详情页提供字体选择时，consumer 只放置 Fonts 拥有的 selector Attachment：

```ts
import { FontsWorkbench } from '@pluxel/fonts/workbench'
import { workbench } from '@pluxel/runtime/workbench'

export const ReportsWorkbench = workbench.define({
	fonts: FontsWorkbench.selection.place(workbench.tab({ label: 'Fonts' })),
})

override init() {
	this.ctx.workbench?.publish(ReportsWorkbench, {
		fonts: { provider: this.fonts },
	})
}
```

`FontsWorkbench` 固定包含一个 manager View 和一个 provider-only selection Attachment。Selector 直接取得 Fonts
提供的 catalog/selection API；consumer 不创建转发 target。Placement 随 consumer generation 撤销，但 renderer、API、
字体数据、选择和 native registration 都由 FontsPlugin 持有。上传和删除只出现在 manager View。

```ts
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

caller-triggered register/path-read/portable-read 在 copy、文件 IO 与 hash 前进入 generation-local owner-fair scheduler；
queue 满时以 `FONT_BUSY` 拒绝。provider cleanup 会 abort active cooperative work、拒绝 queued work 并等待 drain。
Managed 操作保持串行并受独立 pending ceiling 约束。managed 与 programmatic key 合计还受
`maxNativeRegistrations` / `maxTotalFontBytes` 约束。

系统字体不计入 limit，也不会被 cleanup 删除。`fonts.revision` 是 FontsPlugin-managed native registration/default
selection 的进程内 signal；Canvas 等 measurement cache 在它变化时丢弃旧宽度。绕过本插件直接修改
`GlobalFonts` 不属于该信号契约。重复读取的 frozen default/families snapshot 按 revision 复用，字体注册或选择变化后
下一次读取会生成新 snapshot。

`fonts.portableFonts` 是 managed 与 caller registration 的 frozen metadata snapshot；system fonts 没有
FontsPlugin-owned bytes，因此不在其中。renderer 先比较 `portableFonts.revision`，只在变化时调用
`await readPortableFont(id, { signal })` cooperative 取得 detached byte copy 并重建/更新自己的 registry，避免每次
render 复制全部字体。可移植性仍是 renderer 的业务策略；通用 Workbench selector 不伪造第二份 filtered collection。

完整用户路径见 [`docs/plugins/rendering/fonts.md`](../../../docs/plugins/rendering/fonts.md)，设计不变量见 [`DESIGN.md`](DESIGN.md)。
