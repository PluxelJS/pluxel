# @pluxel/runtime

插件实现包本身允许不存在时，用 type-only import 和 opaque optional ref 声明增强能力：

```ts
import type { AuditPlugin } from 'pluxel-plugin-audit'
import { definePluginRef } from '@pluxel/runtime'

const Audit = definePluginRef<AuditPlugin>()

this.plugins.use(Audit, (audit) => audit.registerSource(this))
```

ref 与 `plugins.use()` 由 semantic pass lower 成 optional definition edge。ref 不 import、安装、注册或默认启用 package；
provider absent/disabled/start-failed 不阻塞 consumer，running generation 出现、消失或 replacement 时 Core 用正常 graph plan
重启 consumer closure。`plugins.use()` 只允许在 `init()` 中直接调用，callback 必须同步，返回资源进入 generation effects。

所有 runtime plugin owner protocol 使用结构化 `PluginNodeAddress`。class name、constructor 与 `displayName` 只用于
代码或展示，不作为 RuntimeState、config、logging、HTTP、Workbench、commands 或 persistence identity。
definition address 标识源码实现，node address 再区分 default/fork 部署；对应 Slot 只是同一 address 在 Core registry 内的
引用 key。公开诊断/CLI 使用可逆 reference，HTTP/Workbench 使用可读 v1 route，短 label 只在当前 catalog revision 内用于展示。

单独构建的 Node ESM entry 使用 `defineNodeModule(import.meta.url, literal)` 声明，并通过
`ctx.nodeModules.use(declaration, setup)` 消费。首次 load/setup 会阻塞插件启动；开发期 staged replacement 与 owner
cleanup 由 runtime 管理。artifact 不定义 worker 或任务协议。

CPU-bound / thread-safe native 工作使用 `defineWorkerTask<Input, Output>()` 和 `ctx.workers.run()`。所有插件共享一个
root-owned、lazy、bounded、owner-fair 的 worker-thread pool；Tinypool 不进入插件 API。输入输出必须可 structured clone，
插件 stop 会取消并等待已接纳工作。`run(..., { transfer: [buffer] })` 可把大型 `ArrayBuffer` ownership 立即转入已接纳任务，
避免第二次字节复制；buffer 会同步 detach，后续失败不回滚。普通异步 I/O 与短小 native 调用不应为了“统一”而额外跨线程。

Runtime 保持业务 HTTP 与 optional Workbench 正交。Workbench 分为 browser-safe Contract、server Extension 和
owner-bound Binding：

```ts
// browser-safe module
const ExampleUi = workbenchContract.define({
	resources: { commands: workbenchContract.rpc<ExampleCommands>() },
	views: {
		Overview: {
			placements: [workbenchContract.tab()],
		},
	},
})

// server module
const extension = workbench.extension({
	contract: ExampleUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})

this.ctx.workbench.mount(extension, {
	commands: workbench.bind.rpc(() => new ExampleRpc(this)),
})
```

consumer 只需把一个 Port 的同名 resources 一对一注入 placement 时，用 `portOutlet()` 省略重复 Contract：

```ts
const settings = workbench.portOutlet({
	port: SettingsPort,
	placement: workbenchContract.tab(),
})

this.ctx.workbench.mount(settings, {
	settings: workbench.bind.rpc(() => new SettingsRpc(this)),
})
```

需要重命名、组合或只提供部分 consumer resources 时继续使用显式 `workbenchContract.define({ outlets })`。

公开入口：

- `@pluxel/runtime`：唯一作者入口，原样转发 core API，并注册配置、HTTP、persistence 等常驻能力；
- `@pluxel/runtime/services/vault`：宿主显式启用 Vault；未导入时不注册 Vault backend 或 eager preflight；
- `@pluxel/runtime/workbench/contract`：browser-safe resource、View、placement 和 Port Contract；
- `@pluxel/runtime/workbench`：server-only Extension、entry 和 Binding；
- `@pluxel/runtime/workbench/ui`：浏览器 resource facade、hooks、受限 host capability 与 declarative Pane Kit；
- `@pluxel/runtime/web`：host browser transport 与 Workbench Context。

宿主只通过顶层 `workbench` 配置启用整套能力。关闭后不创建 registry、compiler、watcher、artifact route 或
resource transport，插件业务 HTTP 和生命周期不受影响。
