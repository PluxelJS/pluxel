# @pluxel/runtime

插件实现包本身允许不存在时，用 type-only import 和 opaque optional ref 声明增强能力：

```ts
import type { AuditPlugin } from 'pluxel-plugin-audit'
import { definePluginRef } from '@pluxel/runtime'

const Audit = definePluginRef<AuditPlugin>()

this.plugins.use(Audit, (audit) => audit.registerSource(this))
```

ref 与 `plugins.use()` 由 semantic pass lower 成 optional definition edge。ref 不 import、安装、注册或默认运行 package；
provider absent、当前未运行或 start-failed 不阻塞 consumer，running generation 出现、消失或 replacement 时 Core 用正常 graph plan
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

Runtime 不定义 Agent、Toolset 或 provider adapter。需要 Agent allowlist 时安装普通官方 Plugin
`@pluxel/agent-tools`；它把 Toolset/assignment 放进标准 Plugin config，并在这个唯一 registry 上生成受限 catalog。
外部 Agent adapter 也应是普通 Plugin，通过 constructor dependency 消费它，而不是取得 Runtime 特例。

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

Runtime 保持业务 HTTP 与 optional Workbench 正交。Workbench 作者面只有固定 definition、Direct View API、
Attachment 和 owner-bound publication：

```ts
import type { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'

interface ExampleApi extends RpcTarget {
	snapshot(): ExampleSnapshot
}

export const ExampleWorkbench = workbench.define({
	settings: workbench.view<ExampleApi>({
		renderer: workbench.entry(import.meta.url, './ui/settings.tsx'),
		placement: workbench.tab({ label: 'Settings' }),
	}),
})

this.ctx.workbench?.publish(ExampleWorkbench, {
	settings: ({ principal, signal }) => new ExampleTarget(this, { principal, signal }),
})
```

Renderer 默认导出零 props React component，通过 exact descriptor 取得 target：

```tsx
const { api, host } = useWorkbench(ExampleWorkbench.settings)
```

跨 Plugin UI 使用 Attachment：provider 声明 renderer/API，consumer 用 `attachment.place(...)` 决定位置，并在
publication binding 中传入 constructor-injected provider Plugin。Collection、account、font 等动态数据仍是 Plugin
领域对象，不按 item 创建 Workbench entry。

公开入口：

- `@pluxel/runtime`：唯一 Plugin 作者入口，转发 core API 并增加 runtime capabilities；
- `@pluxel/runtime/services/vault`：Vault 的公开 type-only API；backend 只由 host 顶层 `vault` object 安装；
- `@pluxel/runtime/capnweb`：固定 Cap’n Web `RpcTarget` / `RpcStub` 和 WebSocket session bridge；
- `@pluxel/runtime/workbench`：browser-safe definition、View、Attachment、placement 和 publication types；
- `@pluxel/runtime/workbench/react`：exact descriptor hook、host facade 与 declarative Pane Kit；
- `@pluxel/runtime/workbench/client`：conforming Shell 的 layout/opened-handle client；
- `@pluxel/runtime/web`：portable Runtime session、Management API 和严格校验的 wire DTO；
- `@pluxel/runtime/web/react`：Management client 的 React Context adapter。

Management control 把持久策略与本次进程生命周期分开：`client.plugins.setAutoStart()` 只修改 RuntimeState 的
`autoStart`，`client.plugins.applyLifecycleCommands()` 只执行 `start | stop | restart`。公开状态分别返回
`autoStart`、process-local `sessionIntent`、`desiredState`、`activationReason` 和 observed `lifecycleState`；调用方
不能用 auto-start policy 猜测 Plugin 是否正在运行。

Workbench document 只创建一条 `/__pluxel/runtime/session` WebSocket。认证 challenge、Management、Workbench
layout/openView、Plugin API、logs follow 和 observer 都使用同一个 Cap’n Web object graph。认证/publication epoch
失效或 socket broken 时完整 reload；同一 document 不 feature reconnect，也不切换备用 API transport。

MF2 manifest 和 remote JS/CSS 仍由 HTTP 提供；浏览器写入 `HttpOnly` cookie 使用一个 same-origin、single-use
cookie-commit POST。这些端点不承载 Management 或 Plugin RPC。

宿主只通过顶层 `workbench: { enabled: true }` 安装 Workbench Plane。关闭后不创建 registry、compiler、watcher、
MF producer route 或 session transport，插件业务 HTTP 和生命周期不受影响。Workbench 启用时同时安装 Management Plane；
关闭 Workbench 后只有显式提供顶层 `management: true` 才安装 headless management；`management` 不接受 object。
Plugin catalog sections 按 committed declaration 的 provider role、package-root、source direct parent-directory 依次自动派生；
不读取 dependency edges 或运行状态。用户布局只作为 Management persistence 中的 definition-family 偏好覆盖。

Management 访问由真实 socket peer 和 `ctx.managementAccess` 上唯一 running provider 决定：真实 loopback peer 取得 Runtime
recovery principal；remote/unknown 必须使用可信 physical HTTPS carrier，并由 ready provider 完成认证，否则 fail closed。
官方 `@pluxel/auth` 提供 OIDC、password 与 password+TOTP。自定义 provider 只取得建立 authentication session 所需的
request metadata 和 owner-bound signal，不取得 Management operation body。

生产 static Node listener 默认监听 `0.0.0.0`，可用成对的 `PLUXEL_TLS_CERT`/`PLUXEL_TLS_KEY` 接收内联 PEM 内容或 PEM
文件路径并直接终止 TLS；加密 private key 可另设 `PLUXEL_TLS_PASSPHRASE`。不安全的 remote Management session 会在
provider callback 前拒绝。

完整 Workbench 作者用法见 [`docs/workbench/index.md`](../../docs/workbench/index.md)，内部不变量见
[`engineering/WORKBENCH.md`](../../engineering/WORKBENCH.md)。
