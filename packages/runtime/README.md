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

插件通过 owner-bound `ctx.commands.register(command)` 发布命令。返回值同时是保留精确 input/output 类型的 executable
registration 与幂等 disposer；registration 自动进入当前 generation effects，也可手动撤销。每个 root 只有一个 command
registry，Runtime 的 `list()`、`snapshot()`、`subscribe()` 和 throwing `execute()` 直接委托它，不复制 catalog 状态。
CommandsService 只增加 owner execution gate；generation stop 时由 Core 统一关闭 admission、abort 并等待已接纳调用，再
drain effects。

需要持久化 Agent allowlist 的宿主使用 `await ctx.root.agentTools.catalog(agentId)`。这个 bound catalog 只公开过滤后的
`list()`/`snapshot()`/`subscribe()` 与单一 `execute()`，并在每次调用时重新检查当前 Toolset assignment；发布工具和执行
工具必须使用同一个 catalog，不能绕过它直接调用 root registry。

单独构建的 Node ESM entry 使用 `defineNodeModule(import.meta.url, literal)` 声明，并通过
`ctx.nodeModules.use(declaration, setup)` 消费。首次 load/setup 会阻塞插件启动；开发期 staged replacement 与 owner
cleanup 由 runtime 管理。artifact 不定义 worker 或任务协议。

CPU-bound / thread-safe native 工作使用 `defineWorkerTask<Input, Output>()` 和 `ctx.workers.run()`。所有插件共享一个
root-owned、lazy、bounded、owner-fair 的 worker-thread pool；插件不依赖具体 pool 实现。输入输出必须可 structured clone，
插件 stop 会取消并等待已接纳工作及 running worker 的真实退出。caller cancellation 可以先结束公开 Promise，但对应 active slot
只在 worker termination settle 后归还。`run(..., { transfer: [buffer] })` 可把大型 `ArrayBuffer` ownership 立即转入已接纳任务，
避免第二次字节复制；buffer 会同步 detach，后续失败不回滚。默认 admission snapshot 也可显式改成
`inputOwnership: 'borrowed'`，由 caller 保持输入到 Promise settle 并省略重复 clone。普通异步 I/O 与短小 native 调用不应
为了“统一”而额外跨线程。

如果输入预算 walk/snapshot 本身较重，使用 `ctx.workers.runPrepared(task, prepare, options)`：runtime 先完成同一
global/per-owner fair admission 并保留一个 execution slot，之后才在 host 调用 cooperative `prepare(signal)`，再 dispatch
其 cloneable 返回值。queue full 不会执行 prepare；callback error 保留领域类型。它不支持 transfer，默认 snapshot prepared
value；明确 borrow-until-settle 时可选 `inputOwnership: 'borrowed'`。

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

this.ctx.workbench?.mount(extension, {
	commands: workbench.bind.rpc(() => new ExampleRpc(this)),
})
```

consumer 只需把一个 Port 的同名 resources 一对一注入 placement 时，用 `portOutlet()` 省略重复 Contract：

```ts
const settings = workbench.portOutlet({
	port: SettingsPort,
	placement: workbenchContract.tab(),
})

this.ctx.workbench?.mount(settings, {
	settings: workbench.bind.rpc(() => new SettingsRpc(this)),
})
```

需要重命名、组合或只提供部分 consumer resources 时继续使用显式 `workbenchContract.define({ outlets })`。

公开入口：

- `@pluxel/runtime`：唯一作者入口，原样转发 core API，并注册配置、HTTP、persistence 等常驻能力；
- `@pluxel/runtime/services/vault`：Vault 的公开 type-only contract；backend 只由 host 顶层 `vault` object 安装；
- `@pluxel/runtime/workbench/contract`：browser-safe resource、View、placement 和 Port Contract；
- `@pluxel/runtime/workbench`：server-only Extension、entry 和 Binding；
- `@pluxel/runtime/workbench/ui`：浏览器 resource facade、hooks、受限 host capability 与 declarative Pane Kit；
- `@pluxel/runtime/web`：framework-neutral discovery、Management Client 与版本化 wire DTO；
- `@pluxel/runtime/web/react`：只负责把 Management Client 注入 React，不包含官方 Workbench transport。

默认 `/web` discovery 只报告 `workbench.enabled`；catalog revision、renderer、resource 和 session endpoint
属于尚未标准化的 View-host protocol，不进入 Management v1。使用 `/web/react` 或 `/workbench/ui` 时，宿主必须提供
`react` peer；headless 与默认 `/web` 消费者不会加载它。

`RuntimeManagementClientOptions` 只配置 Level 1 connection/auth：`origin`、HTTP/RPC base、
`credentials`、`fetch` 与 `adminAccess: false | { onBlocked }`。SSE namespace、layout session 和
transport lifecycle 只属于内部 `@pluxel/runtime/web/internal` client。

宿主只通过顶层 `workbench: { enabled: true }` 安装 Workbench Plane。关闭后不创建 registry、compiler、watcher、artifact route 或
resource transport，插件业务 HTTP 和生命周期不受影响。Workbench 启用时同时安装 Management Plane；关闭 Workbench 后只有显式
提供顶层 `management` object 才安装 headless management route。`management.pluginGroups` 定义与 UI 无关的宿主 catalog layout。
Management 访问由真实 socket peer 和 `ctx.managementAccess` 上唯一 running provider 决定：provider ready 时认证所有 peer（包括
loopback）；provider absent/unready 时仅 loopback 可恢复，remote/unknown fail closed。官方 `@pluxel/auth` 提供 OIDC、password 与
password+TOTP；认证策略不进入 host config，public OIDC 不要求 Vault。自定义 provider 的 `authorize()` 只取得 URL、method、
headers 与 owner-bound signal，不取得或消费 Management operation body。

生产 static Node listener 默认监听 `0.0.0.0`，可用成对的 `PLUXEL_TLS_CERT`/`PLUXEL_TLS_KEY` 接收内联 PEM 内容或 PEM 文件路径并直接
终止 TLS；加密 private key 可另设 `PLUXEL_TLS_PASSPHRASE`。不安全的 remote Management 请求会在 provider callback 前拒绝。
尚未标准化的官方 View-host transport 只存在于 `@pluxel/runtime/web/internal`，不是第三方 host 的兼容承诺。
