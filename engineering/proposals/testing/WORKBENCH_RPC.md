# Workbench RPC test API

> 状态：设计已冻结，尚未实现。当前公开入口没有本文提出的 `host.workbench.open()`；现行测试必须遵循
> [`../../../docs/development/testing.md`](../../../docs/development/testing.md)。

## 决策问题

Plugin 如何在不启动浏览器、不打开 WebSocket listener、也不导入 Workbench internal registry 的情况下，测试自己发布的
Content、View 或 Attachment RPC？

冻结结论是：

1. 在 `@pluxel/runtime/test` 的 `RuntimeTestHost` 上提供唯一的 `host.workbench.open()` test driver；
2. 调用方传目标 Plugin 与 authored Workbench entry object，不传字符串 descriptor、definition key tuple 或 internal identity；
3. driver 创建真实 Workbench server session，并以本地 Cap'n Web `RpcStub` 作为 capability membrane；
4. 返回按 entry kind 推导、由一个 disposable lease 持有的 RPC capability；
5. Plugin 测试直接调用 RPC method 或 Content `root.run()`，不模拟表单、按钮、React query 或 router；
6. WebSocket、Origin、framing 和 disconnect 仍由少量 real-carrier conformance test 验证。

这不是通用 RPC mocking framework，也不改变 Workbench production protocol。

不经过 Workbench、由 Plugin 直接挂到 `ctx.elysia` 的业务 RPC 属于另一条 route/carrier 边界；见
[`DIRECT_RPC.md`](DIRECT_RPC.md)。

## 当前问题有真实重复

当前 S3、Redis 和 Fonts 测试已经使用正确的产品边界，但每个 package 都需要重复以下 internal wiring：

1. 从 `@pluxel/runtime/internal` 导入 `requireWorkbench()`；
2. 从 Plugin constructor 手工构造 node address；
3. 读取 registry layout 并按 `descriptor.kind + key` 搜索；
4. 创建带 principal 的 backend session；
5. 拼装 `layoutRevision`、target、descriptor 和 location；
6. 检查 `openEntry()` 的多层 discriminant；
7. 自己决定何时 dispose session、observer 和 returned root。

例如 S3 credential rotation 已经验证了正确链路：Workbench Content action 接收 password fields，authoritative schema 校验输入，
handler 更新 Vault，RPC response 不回显 secret，随后 Plugin 使用新 credential。问题不在测试能力缺失，而在正确调用方式只能从
framework internal tests 反向推导。

如果每个 Plugin 都复制这段代码，coding agent 很容易选择更短但错误的替代方案，例如直接调用私有 handler、构造 `RpcTarget`、
修改 Vault 文件或引入浏览器自动化。

## 测试边界

Plugin Workbench 测试验证：

```text
authored Workbench entry
  -> active Plugin publication
  -> Workbench session + principal
  -> layout/open admission
  -> Cap'n Web capability membrane
  -> RPC input validation / target method
  -> Plugin domain state, Vault or external adapter
  -> session/owner withdrawal cleanup
```

它不验证：

```text
React renderer
  -> form control
  -> pointer/keyboard event
  -> modal/router/query state
```

Shell 组件测试负责证明 presentation plan 会生成正确控件并发出对应 RPC。每个 Plugin 再模拟点击不会增加 server contract 的
可信度，只会引入 DOM selector、timing 和样式耦合。

## 冻结的作者 API

调用点应只出现一个新概念：打开 Plugin 已发布的 entry。

```ts
import { createRuntimeTestHost } from '@pluxel/runtime/test'
import { S3Plugin } from '@pluxel/storage'
import { S3Workbench } from '@pluxel/storage/workbench'

const ADMIN = Object.freeze({
	provider: '@pluxel/auth',
	subject: 'local:admin',
})

await using host = createRuntimeTestHost({
	vault: {},
	workbench: { enabled: true },
})

// Plugin setup omitted.

using credentials = await host.workbench.open({
	target: S3Plugin,
	entry: S3Workbench.buckets,
	principal: ADMIN,
	location: '/storage/s3',
})

const result = await credentials.root.run('rotate', {
	bucketId: 'assets',
	accessKeyId: 'replacement-access-key',
	secretAccessKey: 'replacement-secret-key',
})

expect(result.action).toMatchObject({ ok: true })
```

`host.workbench` 是 test driver，不是 Runtime Context capability。它可以稳定存在于 `RuntimeTestHost` 类型上，但 `open()` 必须在
Workbench disabled 时立即抛出明确 setup error；它不得创建 backend、修改 Context shape 或重建 host。

### 为什么选择 `host.workbench.open()`

- `host` 已经拥有目标 runtime、catalog、lifecycle 和 cleanup boundary；额外传 host 给 standalone helper 是重复信息。
- `workbench` namespace 明确区分 Plugin graph 操作和 UI-plane RPC；本次 surface 仍只有 `open()`。
- `open` 与 production protocol 的 `openEntry()` 使用相同动词，但省略重复的 `Entry` 后缀。
- 不使用 `mock` 或 `simulate`，因为 framework、publication、session、target 和 validation 都是真实实现。
- 不叫 `click`、`submit` 或 `fill`，因为 API 不包含 browser 行为。

当前提案只加入 `open()`。不得为了 namespace 对称预先加入 `client()`、`rpc()`、`driver()`、`find()` 或 `invoke()` alias。

### 输入类型

```ts
type WorkbenchTestOpenOptions<
	Entry extends WorkbenchEntry,
	TTarget extends PluginTestTarget = PluginTestTarget,
> = Readonly<{
	target: TTarget
	entry: Entry
	principal: WorkbenchPrincipal
	location?: string
}>

interface RuntimeWorkbenchTestDriver<TTarget extends PluginTestTarget = PluginTestTarget> {
	open<const Entry extends WorkbenchEntry>(
		options: WorkbenchTestOpenOptions<Entry, TTarget>,
	): Promise<OpenedWorkbenchTestEntry<Entry>>
}
```

这里复用 [`COMPOSABLE_HOST.md`](COMPOSABLE_HOST.md) 的 constructor / `PluginForkRef` target。Workbench 不建立第二套 test-only
identity；fork ref 若在 definition replacement 后已 stale，`open()` 必须拒绝并要求使用 next constructor 建立的 ref。

`principal` 必填，不提供隐藏的 test admin/default identity。Workbench open 本身就是 authorization、owner filtering、quota 和 audit
attribution 的边界；省略 principal 会让不关心 auth 的测试意外获得一种 production 中不存在的身份。与 authorization 无关的 package 可以
定义一个明确命名并复用的 fixture principal，但它仍出现在调用点或 package fixture 中。

`location` 保持 optional，并与 production `openEntry()` 的 route parameter 解析一致。helper 不单独接受 `params`，避免产生一条绕过
route matching 的测试路径。

### 为什么传 authored entry object

推荐：

```ts
entry: S3Workbench.buckets
```

不推荐：

```ts
entry: 'buckets'
entry: { kind: 'content', key: 'buckets' }
definition: S3Workbench, entryKey: 'buckets'
```

`workbench.define()` 返回的 entry 已经是不可变、带隐藏 descriptor metadata 和 invariant API brand 的 author contract。直接传它有
以下收益：

- TypeScript 从一个值推导 Content/View/Attachment kind 和 RPC API；
- coding agent 不需要记住 definition + key 的平行表示；
- 不允许手写 owner、kind 或 portable descriptor；
- helper 可以校验该 exact entry object 属于目标 Plugin 当前 active publication；
- replacement 后拿旧 module evaluation 的 entry 打开新 publication 会明确失败，而不是按同名 key 猜测兼容。

helper 内部可以读取 entry metadata，但不能把 metadata reader、registry publication 或 portable identity 暴露到 public test API。

### 返回类型

返回值是一个由 helper 拥有 cleanup 的 lease，并按 authored entry kind 收窄：

```ts
type OpenedWorkbenchTestEntry<Entry extends WorkbenchEntry> =
	Entry extends WorkbenchView<infer Api>
		? OpenedWorkbenchTestLease<{
				kind: 'view'
				api: RpcStub<Api>
			}>
		: Entry extends WorkbenchAttachmentPlacement<infer ProviderApi, infer ConsumerApi>
			? OpenedWorkbenchTestLease<{
					kind: 'attachment'
					provider: RpcStub<ProviderApi>
					consumer: [ConsumerApi] extends [never] ? undefined : RpcStub<ConsumerApi>
				}>
			: Entry extends WorkbenchContent<any>
				? OpenedWorkbenchTestLease<WorkbenchOpenedContent>
				: never
```

具体声明可以复用现有 protocol 类型，避免建立第二套 response model。上面的类型只说明必须保留的推导结果，不要求复制字段。

Content 继续暴露 canonical `WorkbenchContentRoot`：

```ts
await opened.root.run('rotate', rawInput)
await opened.root.load()
await opened.root.subscribe(observer)
```

不生成 `opened.actions.rotate(typedInput)`。`run(actionKey, rawInput)` 的 `rawInput: unknown` 是真实不可信 RPC 边界，Plugin 测试需要能
提交 malformed input 并验证 `validation_failed`。为测试方便而把它改成 schema output type 会绕过最重要的 server validation 用例。

View 与 Attachment 的 authored API 已由 `WorkbenchView<Api>` / `WorkbenchAttachment<Api>` 声明，因此返回相应 `RpcStub<Api>`，不退化为
`RpcTarget` 或 `unknown`。

### Cleanup contract

`open()` 返回同步 `Disposable`，与当前 Workbench session/Cap'n Web stub 惯例一致：

```ts
using opened = await host.workbench.open(...)
```

lease 必须幂等，并按逆序释放：

1. returned RPC envelope/capability duplicates；
2. local session stub；
3. Workbench server session。

Plugin stop、replacement、publication revision 或 host disposal 先发生时，lease 的后续调用应表现为真实 broken/aborted capability；再次
dispose 不抛出。helper 不能用 detached plain object 隐藏 withdrawal 行为。

## 本地 RPC 的实现要求

driver 不应直接调用 `WorkbenchServerSession.target`。它应在 test implementation 内部使用 Cap'n Web 的本地 stub：

```ts
const session = backend.createSession(principal, invalidate)
const rpc = new RpcStub(session.target)
```

随后通过 `rpc.layout()` 与 `rpc.openEntry()` 完成打开。这保留 Cap'n Web 的 deep-copy、capability projection、callback、brokenness、
`dup()` 和 disposal 行为，同时不创建 socket。

这里的 `RpcStub` constructor 是 `@pluxel/runtime/test` 的实现细节。无需因此扩展 `@pluxel/runtime/capnweb` 的 production profile，
也不向 Plugin 作者暴露 MessagePort 或 transport factory。

本地 stub 不证明 WebSocket carrier 正确。以下行为只在现有 real-listener tests 验证：

- WebSocket handshake/subprotocol；
- same-origin `Origin` admission；
- byte framing 和网络级 serialization compatibility；
- peer disconnect 与 socket close；
- carrier backpressure、timeout 和 shutdown ordering。

不得给 `open()` 增加 `transport: 'local' | 'websocket'`。不同测试边界使用不同 host，不能由一个 options flag 隐式改变执行拓扑。

## 打开算法与失败

实现顺序固定为：

1. 解析 `target` 为 canonical Plugin node address；
2. 确认 Runtime host 未 dispose 且 Workbench enabled；
3. 读取 authored entry metadata，并确认它属于该 target 当前 active publication；
4. 用必填的 `principal` 创建 Workbench server session；
5. 建立本地 `RpcStub`，通过 RPC 读取 target layout；
6. 以 server-issued owner/kind/key identity 找到唯一 layout entry；
7. 通过 RPC 调用 `openEntry()`，传递当前 layout revision 与 optional location；
8. 校验返回 kind 与 authored entry 一致，把 capability ownership 转移给 test lease；
9. 任一步失败时释放已经创建的所有资源，再抛出 setup error。

`open()` 是 assertive fixture helper。以下失败表示测试 setup 或 framework publication 与测试声明不一致，因此直接抛出带 target、entry
和稳定 Workbench failure code 的错误：

- Workbench disabled；
- target 不存在或未运行；
- target 没有发布该 exact entry；
- layout 中 entry unavailable；
- `openEntry()` 返回 `layout_changed`、`target_unavailable`、`factory_failed`、`factory_timeout` 或 `quota_exceeded`；
- 实际 opened kind 与 authored entry kind 不一致。

不要同时增加 `tryOpen()`。测试 Workbench framework 自身 failure matrix 的代码继续使用 internal protocol；普通 Plugin 测试关心的领域
失败仍由其 RPC method 的 production result 表达，不会被 helper 转成 throw。

## Credential/Vault 的标准测试形状

Workbench 中填写 auth key 不是普通 Plugin config mutation，而是 credential provisioning：secret 进入 owner-aware Vault，Workbench
只提供交互入口。标准测试分三层。

### 1. RPC 到 Vault 的集成测试

至少保留一条完整链路：

```ts
using credentials = await host.workbench.open({
	target: ConnectorPlugin,
	entry: ConnectorWorkbench.credentials,
	principal: ADMIN,
})

const secret = 'test-secret'
const result = await credentials.root.run('replace', { authKey: secret })

expect(result.action).toMatchObject({ ok: true })
expect(JSON.stringify(result)).not.toContain(secret)

const plugin = host.require(ConnectorPlugin)
expect(await plugin.ctx.vault!.kv().get('auth-key')).toBe(secret)
await expect(plugin.probe()).resolves.toMatchObject({ authenticated: true })
```

这条测试同时证明 principal/admission、RPC validation、Vault owner、无 secret 回显和实际业务消费。

### 2. 领域功能测试

其他业务测试不必重复打开 Workbench。Workbench action handler 应调用 Plugin 自己拥有的 credential controller/service；领域 fixture 可以
通过同一个内部领域入口准备状态，再测试请求、rotation、retry 和 cleanup。不要为了减少样板提供通用 `host.vault.setFor()`，它会让测试
绕过 owner、key schema、flush 和 readiness policy。

### 3. Shell UI 测试

Workbench Shell 只需集中验证：password presentation 产生 password control、confirm 行为正确、提交的 raw object 进入 `root.run()`、
结果触发正确 UI state。Plugin package 不重复进行 DOM interaction。

### 启动状态约束

如果 credential 只能通过该 Plugin 自己的 Workbench entry 录入，Plugin 不能因 credential 缺失而在 `init()` 中启动失败：

```text
credential missing
  -> Plugin start failed
  -> publication absent
  -> credential can never be supplied
```

这类 Plugin 应以明确的 `unconfigured` 状态运行并发布 onboarding RPC；只有依赖 credential 的具体业务操作返回稳定
`credential_missing`。如果 Plugin 的核心能力确实不能无 credential 启动，credential 必须由 host/Vault preflight 在 Plugin lifecycle 前提供，
不能依赖其自身 Workbench。

## 明确不提供

本提案不提供：

- `simulateClick()`、`fillForm()` 或 browser selector DSL；
- 任意 method string 的 `rpc.call(name, args)`；
- 直接 new Plugin Workbench `RpcTarget` 的 helper；
- public Workbench registry、publication map 或 descriptor reader；
- 通用 `host.vault.setFor()` / raw encrypted file mutation；
- 自动安装 Workbench/Vault；
- local/WebSocket transport switch；
- `mockWorkbenchRpc()` alias。

这些入口要么丢失类型和生命周期，要么跨越安全/所有权边界，要么把不同层级的测试重新耦合。

## 验收条件

实现只有同时满足以下条件才可采纳：

1. `@pluxel/runtime/test` public type test 能从 View/Attachment entry 推导正确 `RpcStub<Api>`；
2. Content 可以直接测试 valid、malformed 和 unknown action input；
3. local stub 证明参数/结果不是与 server target 共享的可变 object identity；
4. principal 原样进入 open context，但不出现在不应暴露它的 RPC DTO；
5. Workbench disabled 时不创建 backend，并给出明确 setup error；
6. target stopped、replaced 或 host disposed 后，旧 capability 无法继续调用；
7. `using` 正常结束、open failure 和 callback throw 都不会遗留 session、observer 或 owner lease；
8. static Content 不创建 root，interactive Content 返回真实 root stub；
9. Attachment provider/consumer API 和 owner identity 保持正确；
10. 迁移 S3 credential rotation 与 Fonts manager/selection 两组真实测试，删除它们对 `requireWorkbench()` 的依赖；
11. 保留至少一组 real WebSocket Runtime Session test，证明本 helper 没有替代 carrier conformance；
12. 更新 `docs/development/testing.md`，明确 Plugin RPC test 与 Workbench Shell UI test 的选择边界。

## Prototype 实现问题

以下问题可以在 prototype 中决定，不应改变作者 mental model：

- local `RpcStub` 返回的 envelope 如何 transfer/dup，使 helper 自己释放中间 result 而不提前关闭 nested root；
- static Content 是否在类型层精确去掉 `root`，还是复用 production `WorkbenchOpenedContent` discriminant；
- setup error 是否需要 test-only error class，或 message + existing Workbench failure code 已足够。

除非调用方确实需要 catch 分支，不为了测试 setup error 新建稳定 public error hierarchy。
