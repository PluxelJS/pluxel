# @pluxel/fonts

`@pluxel/fonts` 是 Pluxel 官方服务端字体 capability。它统一负责系统字体发现、provider-owned 上传集合、
默认字体选择、持久化、容量边界和原生资源回收；Canvas、ECharts 等 renderer 只消费字体快照。

Windows、macOS 与 Linux 字体由 `@napi-rs/canvas` 的 platform font manager 自动发现。`fonts.families` 标出
`system` / `registered` 来源，`fonts.defaultFont` 按 Workbench → host config → 系统自动选择 → generic 顺序解析。

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

	override init() {
		this.fonts.registerFromPath({
			path: fileURLToPath(new URL('../assets/ReportSans.woff2', import.meta.url)),
			family: 'Report Sans',
		})
	}
}
```

路径必须是服务端绝对路径。也可以用 `fonts.register({ data, family })` 注册 `Uint8Array`。这类代码资源绑定
caller generation；consumer stop/replacement 时 FontsPlugin 移除对应 `FontKey`。返回 handle 的 `dispose()` 只用于
提前删除，重复调用无副作用。

## 统一管理页面与 Selection Port

FontsPlugin 启动时自动加载唯一的 managed collection。它自己的 Workbench 页面负责上传、删除和 provider-wide
默认值，不要求 Canvas/ECharts 初始化第二套集合。Workbench 关闭时同一集合仍在 headless host 加载。

需要在其他插件详情页提供字体选择时，consumer 只挂载 selector Port：

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

selector 只读取 FontsPlugin 提供的系统/上传 family 选项并修改统一默认值；上传/删除 command 不从公开 Workbench
子入口导出，只存在于 FontsPlugin 自己的管理页面。Port 的 placement/grant 随 consumer 生命周期撤销，但字体数据、
选择和 native registration 仍由 FontsPlugin 持有。

```ts
host.cfg(FontsPlugin).set({
	defaultFamily: 'Noto Sans',
	maxRegistrationsPerConsumer: 32,
	maxManagedFonts: 64,
	maxFontBytes: 16 * 1024 * 1024,
})
```

系统字体不计入 limit，也不会被 cleanup 删除。`fonts.revision` 是 FontsPlugin-managed native registration/default
selection 的进程内 signal；Canvas 等 measurement cache 在它变化时丢弃旧宽度。绕过本插件直接修改
`GlobalFonts` 不属于该信号契约。重复读取的 frozen default/families snapshot 按 revision 复用，字体注册或选择变化后
下一次读取会生成新 snapshot。

完整用户路径见 [`docs/rendering/fonts.md`](../../../docs/rendering/fonts.md)，设计不变量见 [`DESIGN.md`](DESIGN.md)。
