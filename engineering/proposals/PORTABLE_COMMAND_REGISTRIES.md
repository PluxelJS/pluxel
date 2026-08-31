# Owner-bound 可携带 Command Registry 与 Carrier 二阶段呈现

> 状态：proposed，尚未采纳、尚未实现。本文只定义 Pluxel Commands/Runtime 应提供的通用能力；
> KOOK、Discord、Chatbot 等具体 Plugin 只作为验证用例，不在本提案中修改。当前 API 仍以
> [`../COMMANDS.md`](../COMMANDS.md)、[`../RUNTIME.md`](../RUNTIME.md) 和
> [`../../docs/runtime/commands.md`](../../docs/runtime/commands.md) 为准。

## 决策摘要

Pluxel 应允许 provider Plugin 建立一份独立、typed、owner-bound 的 secondary command registry，
并允许其他 Plugin 把 command publication 直接注册进该 registry。建议 API 是：

```ts
const kookCommands = this.ctx.commands.createRegistry<KookCommandContext>()

const installed = owner.commands.register(command, {
	into: kookCommands,
})
```

其中：

- `createRegistry()` 创建空 registry，不继承、不复制、也不订阅 root catalog；
- registry 的生命周期属于创建它的 owner，例如 KOOK provider generation；
- publication 的生命周期属于执行 `register()` 的 owner，例如依赖 KOOK 的 consumer generation；
- 调用同时受 registry owner 与 publication owner 两个 generation gate 约束，任一方停止都会 fail closed；
- registry、publication、snapshot、subscription 和 installed handle 仍复用 `@pluxel/commands` 的唯一实现，
  Runtime 只叠加 owner admission/effects；
- 不新增 `@pluxel/runtime/commands` subpath，不给 provider 增加 `registryFor(ctx)`，也不为每个 consumer 建一份 registry。

Carrier 的公开 `bindCommand()` 默认接收 raw `Command`。它在自己的 registry 中完成 owner-bound registration，
然后用 command 的已校验 output 执行 carrier 专属的第二阶段 presenter：

```ts
protected override init() {
	// 只有需要被 Agent、HTTP 等 root consumer 发现时才发布到 root catalog。
	this.ctx.commands.register(reportCommand)

	this.kook.bindCommand(reportCommand, {
		routes: ['report'],
		positionals: ['reportId'],
		async present(output, { reply }) {
			await reply(`Report ${output.reportId}: ${output.status}`)
		},
	})
}
```

`present()` 在每条消息的 live invocation context 中取得 `reply()`；registration-time binding object
本身不保存某一次消息的 `reply()`。基础 command 保持 transport-neutral，Agent/HTTP 消费结构化 output，
KOOK 则在 output validation 成功后完成消息、卡片、附件、reaction 或多次 reply。

## 问题

当前 Runtime 只有一个 root registry。它适合发布可由 Agent、HTTP、CLI 和 Workbench 共同发现的基础 command，
但不能完整表达下面这种真实关系：

```text
consumer Plugin
  -> required dependency: KOOK Plugin
  -> 注册 KOOK route
  -> 执行 transport-neutral Command
  -> 根据已校验 output 做 KOOK reply/card/reaction
```

如果 KOOK 直接使用 `createCommandRegistry()` 并自己维护 `Map<Context, Registry>`，它必须重复解决：

- consumer stop、replacement 与 init rollback 后的 publication withdrawal；
- provider stop 后 retained command/router handle 的 fail-closed；
- in-flight command 的 abort 与 drain；
- caller Context 的并发隔离；
- base `CommandContext` 与 KOOK extended context 的类型兼容；
- registry snapshot、revision、subscription 和 compatible installed handle 语义。

这些都已经属于 Commands + Runtime owner lifecycle 的职责，不应由每个 carrier Plugin 再实现一遍。

反过来，把所有 KOOK command 自动镜像进 root catalog 也不正确。KOOK-native command 可能要求 message、guild、channel、
principal 或 `reply()`，不能诚实地被 Agent/HTTP 调用；即使 command 本身 transport-neutral，是否暴露给 root consumer
也应是 consumer 的显式 publication 决策，而不是 `bindCommand()` 的隐藏副作用。

## 目标

- 一个 provider generation 只维护一份 secondary registry，接收多个 consumer 的 publication。
- publication owner 与 registry owner 分离，但 stop/replacement/rollback 任一侧都能完整撤回资源。
- base command 可以无 adapter 地进入 extended-context registry。
- extended-context command 不能误入 root registry。
- carrier 可在基础 command output 之后执行 typed、live、可取消的第二阶段呈现。
- raw command definition、root publication、carrier binding 三者保持可独立组合。
- 保持 `@pluxel/commands` lifecycle-neutral；Pluxel 生命周期只在现有 `ctx.commands` capability 上组合。
- 热路径不扫描 Plugin graph，不按 consumer 建 registry，也不镜像 root catalog。

## 非目标

- 不把 KOOK route、message、reply、card 或 permission 概念加入 `@pluxel/commands`。
- 不让 secondary registry 自动继承 root catalog。
- 不让 `bindCommand()` 自动把 command 发布到 root catalog。
- 不把 presenter output 写回 `CommandDescriptor` 或 Agent schema。
- 不新增通用 Agent、Chatbot、Toolset 或 provider registry 到 Core/Runtime。
- 不通过 mutable global current caller、`Proxy` 或 AsyncLocalStorage 猜 registration owner。
- 不在本提案阶段修改任何具体 Chatbot/KOOK Plugin。

## 为什么使用 `createRegistry()`，而不是 `fork()`

`fork()` 通常暗示从父对象继承 snapshot、lineage 或 copy-on-write 状态；Pluxel 内部也已经用 Plugin fork 表示
同一 definition 的另一个独立 node。本提案需要的对象始终从空 catalog 开始，且 root publication 不会自动出现其中。

因此建议只提供一个名字：

```ts
this.ctx.commands.createRegistry<KookCommandContext>()
```

不同时保留 `fork()` alias。这样调用点能直接读出“创建一份 registry”，也避免未来调用方误以为它会跟随 root catalog。
如果实现验证最终证明 secondary registry 必须继承 root，再重新评估命名和同步语义；不能先用 `fork()` 隐藏尚未存在的继承。

## 概念与所有权

| 概念                | 所有者                           | 职责                                                        |
| ------------------- | -------------------------------- | ----------------------------------------------------------- |
| root registry       | Runtime root                     | 全局显式 publication、基础 management commands              |
| secondary registry  | 创建它的 provider generation     | 独立 catalog、revision、snapshot、subscription 与整体撤回   |
| command publication | 调用 `register()` 的 generation  | command owner gate、单条撤回、compatible installed identity |
| carrier binding     | 调用 `bindCommand()` 的 consumer | route grammar 与 presenter callback                         |
| invocation context  | carrier 的单次 request/message   | signal、deadline、message snapshot、`reply()` 等 live 能力  |

一个 entry 因而同时受两个 owner 控制：

```text
registry owner running? ----\
                             +--> admit execute --> raw Command --> presenter
publication owner running? -/             ^              ^              ^
                                           |              |              |
                                      composed signal   wire output   carrier context
```

两者可能相同，例如 provider 注册自己的 command；此时实现必须按 Context identity 去重，只取得一次 admission lease。

## 建议的 Runtime API

以下签名表达目标契约，最终实现可以调整内部 type alias，但不能改变所有权和类型方向：

```ts
import type {
	Command,
	CommandCatalogSnapshot,
	CommandContext,
	CommandDescriptor,
	CommandRegistration,
} from '@pluxel/commands'

export interface CommandRegistryHandle<Ctx extends CommandContext = CommandContext> {
	/** Register a publication owned by the generation that created this registry. */
	register<I, O>(command: Command<I, O, Ctx>): CommandRegistration<I, O, Ctx>

	list(): readonly CommandDescriptor[]
	snapshot(): CommandCatalogSnapshot
	subscribe(listener: (snapshot: CommandCatalogSnapshot) => void): () => void
	execute(name: string, candidate: unknown, context: Ctx): Promise<unknown>

	/** Withdraw the registry. Idempotent; already-admitted calls may settle. */
	dispose(): void
}

export interface CommandsService {
	/** Existing root publication. Only the common CommandContext is accepted. */
	register<I, O>(command: Command<I, O>): CommandRegistration<I, O>

	/** Publish into another Runtime-owned registry while retaining this service view's owner. */
	register<I, O, Ctx extends CommandContext>(
		command: Command<I, O, Ctx>,
		options: { into: CommandRegistryHandle<Ctx> },
	): CommandRegistration<I, O, Ctx>

	/** Create one empty registry owned by this service view's immutable Context. */
	createRegistry<Ctx extends CommandContext = CommandContext>(): CommandRegistryHandle<Ctx>
}
```

`CommandRegistryHandle.register()` 是 provider 注册自身 command 的短路径。跨 Plugin publication 必须从
publication owner 的 service view 发起：

```ts
owner.commands.register(command, { into: providerRegistry })
```

不能设计成：

```ts
providerRegistry.register(command, { owner })
```

后者让任意调用点传入裸 Context，容易把资源错误归属给别的 generation。`owner.commands` 本身已经是 Runtime 创建的
immutable owner view，应继续作为唯一 registration authority。

最终 TypeScript declarations 必须用 type probes 证明：

```ts
declare const base: Command<Input, Output, CommandContext>
declare const kook: Command<Input, Output, KookCommandContext>
declare const kookRegistry: CommandRegistryHandle<KookCommandContext>

kookRegistry.register(base) // accepted: extended context contains the base context
kookRegistry.register(kook) // accepted
ctx.commands.register(base) // accepted in root
ctx.commands.register(kook) // rejected: root cannot construct required KOOK fields
ctx.commands.register(base, { into: kookRegistry }) // accepted and owner-bound to ctx
```

如果 TypeScript variance 需要调整 overload 的泛型排列，优先保持上面的可观察结果，不导出 unchecked cast helper。

## Registry 生命周期语义

### 创建与隔离

`createRegistry()` 创建一个空 registry，并立刻把幂等 disposer 登记到创建者 effects。它不读取 root snapshot，
不订阅 root registry，也不在 root catalog 中产生 descriptor。创建者 init rollback 时该 registry 必须撤回。

Registry handle 必须携带 Runtime root identity。把 host A 的 handle 传给 host B 的 `commands.register(..., { into })`
必须同步以稳定 `COMMAND_CONFIG` reason 拒绝，不能跨 root 形成 owner/gate 引用。

### Publication

`owner.commands.register(command, { into })` 完成三件事：

1. 将 command wrapper 注册进目标 registry；
2. wrapper 固定 registry owner 与 publication owner，不读取 mutable current caller；
3. 将单条 disposer 登记到 publication owner effects。

目标 registry 已 dispose、name 冲突、descriptor 非法或 owner effects 已关闭时，调用同步/异步失败都不得留下半条 entry。
手动 dispose publication 只撤回后续 lookup/discovery，不取消已经进入的调用，也不关闭同 owner 的其他 publication。

### 执行

无论调用来自 `registry.execute()`、`CommandRegistration.execute()` 还是 router 保留的 installed handle，都必须经过相同的
双 owner wrapper：

1. 先检查 registry 仍 active；
2. 取得 registry owner admission；
3. 取得 publication owner admission；
4. 将 call signal 与两个 owner signal 组合后传给 command；
5. settle 后按相反顺序释放 lease。

任一步失败都释放此前取得的 lease，并翻译为现有 `CommandError('ABORTED', ...)`。不能只在
`registry.execute()` 外层加 gate，否则 retained installed handle 会绕过 registry owner withdrawal。

### Provider stop

provider stop/replacement 先关闭 registry owner generation gate，因此：

- 新 execute 立即 fail closed；
- 已接纳 execute 收到 abort，并进入 generation drain；
- provider effects 随后 dispose registry、withdraw entries 与 subscriptions；
- retained installed handle 最终返回 `COMMAND_NOT_FOUND`，不能继续调用 consumer command。

### Consumer stop

consumer stop/replacement 先关闭 publication owner gate，因此：

- 旧 route 即使短暂仍可 resolve，也无法进入 consumer command；
- 已接纳 command/presenter 收到 abort，consumer drain 等待其 settle；
- effects 按逆序先撤回 carrier route，再撤回 registry publication；
- provider 和其他 consumer 的 entries 不受影响。

provider 是 required dependency 时，Core 的 consumer-before-provider stop order 仍是第一层保证；双 owner wrapper 是 retained
handle、平台 callback 和手动 disposal 路径的局部安全边界，不能依赖 stop order 代替它。

### 手动 registry dispose

手动 `registry.dispose()` 关闭后续 publication、lookup 和 execute，并撤回全部 entries。它与单条 registration dispose 一样，
不伪装成新的 Core generation gate，因此已经接纳的调用允许 settle；若需要 abort 整个 provider generation，仍由正常 Plugin
stop/replacement 完成。重复 dispose 必须无操作。

## Carrier 二阶段模型

一条可复用 command 已经拥有完整的输入/输出 validation pipeline。Carrier 不需要把 `reply()` 塞进基础 command，
而是在成功得到已校验 wire output 后执行第二阶段：

```text
raw message
  -> route/token parsing
  -> candidate
  -> authorization / rate limit / principal mapping
  -> base Command.execute(candidate, extended context)
  -> validated wire output
  -> carrier presenter(output, same extended context)
  -> reply/card/attachment/reaction
```

以 KOOK 作为 API 形状验证时，可以使用：

```ts
interface KookCommandContext extends CommandContext {
	readonly message: KookMessageSnapshot
	reply(content: KookReply): Promise<void>
}

type KookCommandBinding<I, O> = ArgvBinding<I> & {
	present?: (output: O, context: KookCommandContext) => void | Promise<void>
}

bindCommand<I, O>(
	command: Command<I, O, KookCommandContext>,
	binding: KookCommandBinding<I, O>,
): Registration
```

由于函数参数类型的兼容方向，普通 `Command<I, O, CommandContext>` 可以传给这个 `bindCommand()`；
真正要求 `KookCommandContext` 的 command 只能进入 KOOK registry，不能进入 root registry。

`present()` 的契约是：

- 只在 command 成功且 output validation 完成后调用；
- 取得与 command 相同、已经组合 cancellation 的 invocation context；
- output 类型保持 command 的精确 wire output；
- 可以 reply 零次、一次或多次，也可以发送 card/attachment/reaction；
- 不改变 command descriptor、output schema 或返回给其他 carrier 的数据；
- presenter failure 是 carrier/integration failure，不伪装成 command 业务 validation failure；
- command failure 不调用 `present()`，由 KOOK 统一的 `CommandError` presenter 处理。

如果省略 `present()`，KOOK 可以使用自己的默认 output renderer；void command 默认不产生成功 payload。需要直接使用
message/reply 的 KOOK-native command 仍然合法，但推荐把可复用业务逻辑放在 base command，把传输呈现留在 `present()`。

## `bindCommand(raw)`，而不是要求 installed command

Raw `Command` 不是“只有 schema 的未安装描述”；它已经包含唯一、完整、会校验 input/output 的 `execute()` pipeline。
它缺少的是 publication identity 与 lifecycle，而 KOOK 的 local registration 正好会补上这两项：

```text
raw Command
  -> caller-owned register(..., { into: kookRegistry })
  -> local InstalledCommand
  -> argv/message route bind
```

因此普通 carrier API 不应强制调用方先注册 root，再把 root installed handle 交给 KOOK。那会错误地把两项独立决策绑定在一起：

- root publication：是否允许 Agent/HTTP/Workbench 发现和执行；
- KOOK binding：是否提供 KOOK route 和 presentation。

需要两者时显式复用同一 raw definition：

```ts
this.ctx.commands.register(reportCommand)
this.kook.bindCommand(reportCommand, { routes: ['report'], present })
```

只需要 KOOK 时只调用 `bindCommand()`。KOOK 内部取得的 local installed handle 已足够让 router 保留 compatible publication identity。

未来若出现“只 mount 一个已经存在的 root publication，并且必须跟随 root 中由其他 owner 完成的 compatible replacement”这一
独立需求，可以另行论证 `mountCommand(installed, binding)`。在没有真实调用点前，本提案不增加第二套 API，也不让
`bindCommand()` 隐式查 root registry。

## Provider 内部形状

下面只是 Pluxel 通用能力的验收草图，不是本提案对 KOOK Plugin 的实现修改：

```ts
@Plugin()
export class KookPlugin extends BasePlugin {
	private commands!: CommandRegistryHandle<KookCommandContext>
	private readonly router = createArgvRouter<KookCommandContext>()

	protected override init() {
		this.commands = this.ctx.commands.createRegistry<KookCommandContext>()
		// client/message listener setup remains provider-owned.
	}

	bindCommand<I, O>(
		command: Command<I, O, KookCommandContext>,
		binding: KookCommandBinding<I, O>,
	): Registration {
		const owner = this.ctx.caller ?? this.ctx
		const projected = projectKookPresentation(command, binding.present)
		const installed = owner.commands.register(projected, { into: this.commands })
		let route: Registration
		try {
			route = this.router.bind(installed, binding)
		} catch (error) {
			installed.dispose()
			throw error
		}

		return adoptKookBinding(owner.effects, route, installed)
	}
}
```

这里没有：

- `registryFor(ctx)`；
- `WeakMap<Context, CommandRegistry>`；
- 依赖 mutable `this.ctx.caller` 的延迟 lookup；
- root catalog mirror/subscription；
- 要求 consumer 保存或传入 root installed handle。

`this.ctx.caller` 只在 dependency facade 的同步 `bindCommand()` 调用期间读取一次，随后 immutable owner 被封装进 Commands
registration。异步 message dispatch 不再读取 caller，也不会因并发调用串线。

`projectKookPresentation()` 必须让 base command 与 presenter 位于同一个 owner-bound execute wrapper 中。不能先 await base command、
释放 consumer lease，再调用 presenter；否则 consumer 恰好 replacement 时可能执行已撤回 generation 捕获的 callback。

## 原子性与错误边界

`bindCommand()` 同时产生 local publication 和 carrier route。建议顺序是：

1. owner-bound local registration；
2. router binding；
3. 将 router disposer 登记到同一 owner effects；
4. 返回一个按 route → publication 顺序幂等清理的 combined registration。

任一步失败都按相反顺序回滚已经创建的资源。publication 的自动 cleanup 可以留在 effects 中成为幂等 no-op，不能为了清除
一条已取消 cleanup 而暴露 Runtime effects internals。

Route conflict、command name conflict 和非法 binding 是 consumer init failure。Command failure 使用既有 `CommandError`；
presenter、KOOK SDK 或 reply failure 保留 cause 进入 provider diagnostics，并由 carrier 的统一错误边界决定是否发送 fallback。

## 性能预算

本设计的常态成本应为：

- 每个 provider generation 一份 registry，而不是每个 consumer 一份；
- 每条 binding 一条 registry map entry、一条 router entry 和两个 owner effects cleanup；
- register/withdraw/name lookup 为均摊 O(1)；
- snapshot 只在 registry revision 改变时重建；
- dispatch 不扫描 Plugin graph、consumer list 或 root catalog；
- base command descriptor 继续使用 frozen snapshot，不为 presenter 复制 schema；
- 双 owner相同时 admission 去重，不重复组合相同 signal。

实现验收应增加至少 1,000 条、100 个 consumer 的趋势 probe，确认 registration/withdrawal 不出现
`O(consumers × commands)` registry 扫描。该 probe 用于防回归趋势，不作为跨机器延迟 SLA。

## 被拒绝的方案

### Provider 自己维护 `registryFor(ctx)`

它把 owner cache、rollback、replacement、retained handle 和 drain 重新交给每个 provider，实现重复且容易依赖 mutable caller。
本提案用一份 provider registry + caller CommandsService publication 代替。

### 每个 consumer 一份 registry

它避免 command name 冲突，但让 dispatch 必须扫描或维护第二层 aggregate index；help/snapshot/revision 也需要跨 registry 合并。
Provider 本来就拥有统一 route namespace，因此 name/route collision 应在同一 registry/router 中明确拒绝。

### 自动镜像 root registry

它无法表达“只在 KOOK 可用”，会扩大 exposure，并要求同步 policy、withdrawal 和 extended context compatibility。
Root 与 carrier publication 必须显式、独立。

### `bindCommand(installed)` 作为唯一入口

它迫使 KOOK binding 依赖 root publication，把 carrier route 与全局 exposure 耦合。Installed handle 适合明确 mount 既有 publication
的高级场景，不应成为普通 local registration 的前置条件。

### 把 `reply()` 放入 registration-time binding

Registration 没有 message、channel、principal 或 cancellation epoch；一个 live `reply()` 不能安全跨多次消息复用。
Binding 只保存 presenter function，`reply()` 每次 invocation 注入。

### 把 KOOK presenter 写回 Command

这会让基础 descriptor/execute 捕获 transport capability，使 Agent/HTTP 消费者必须理解 KOOK 输出，并破坏一个 command definition
跨 carrier 复用的边界。Presenter 属于 binding，不属于 command kernel。

## 实施顺序

提案被接受后按以下顺序实施；在第 1 至 4 步完成前不修改真实 Chatbot/KOOK Plugin：

1. 在 Runtime tests 中用 synthetic provider fixture 固化 `createRegistry()` 与 targeted `register(..., { into })` 类型/生命周期。
2. 重构 `CommandsService`，让 root 和 secondary registry 共用一个 owner-aware backend wrapper，不复制 registry 实现。
3. 增加双 owner admission、cross-root rejection、registry disposal 与 retained handle tests。
4. 增加 carrier fixture，验证 raw command output → presenter → reply 的二阶段顺序和 cancellation。
5. 更新 `engineering/COMMANDS.md`、`engineering/RUNTIME.md`、`docs/runtime/commands.md` 与 package README。
6. 为 public Runtime API 添加 Tegami entry，再评估一个真实 provider Plugin 的迁移。

`@pluxel/commands` 若无需新 primitive，不应因为 Runtime wrapper 而扩大 public API。若实现确实需要 lifecycle-neutral bulk dispose/closed
registry primitive，必须先以独立 package test 证明其语义，不导出 Runtime Context 或 owner 类型。

## 验收条件

- root registry 行为和现有 management command catalog 完全不变。
- secondary registry 初始为空，root 与不同 secondary registry 互相不可见。
- 一个 provider registry 可接收多个 consumer publication，不存在 per-consumer registry/cache。
- provider stop/replacement、consumer stop/replacement、任一 init rollback 都撤回正确范围。
- 已接纳调用在任一 owner stop 时收到 abort，并被对应 generation drain 等待。
- manual publication dispose 不取消已接纳调用；manual registry dispose 不假装停止 Plugin generation。
- retained installed handle 不能绕过 registry owner 或 publication owner gate。
- 同 owner 双 gate 去重；不同 owner 任一关闭都 fail closed。
- cross-root target 同步以稳定 configuration reason 拒绝且不产生 publication。
- base-context command 可进入 extended registry，extended-context command 在 root registration 处 typecheck 失败。
- presenter 只取得已完成 output validation 的值，并与 base command 共用 consumer admission/cancellation。
- presenter 不出现在 root descriptor、Agent schema 或 command examples 中。
- `bindCommand(raw)` 不自动产生 root publication；显式 root register + carrier bind 可复用同一 raw command。
- source scan 中不存在新 `registryFor`、`@pluxel/runtime/commands` 或 provider-owned caller registry map。
- Runtime/Commands typecheck、tests、build、format、lint 与 workspace package boundary checks 通过。

## 否决条件

出现以下任一结果，应暂停而不是用更多 facade 修补：

- 无法在不暴露裸 owner Context override 的情况下实现 cross-owner publication；
- installed handle 的执行无法同时保留 registry/publication 两侧 withdrawal；
- TypeScript 无法同时表达 base → extended 可赋值和 extended → root 拒绝；
- provider 必须扫描所有 consumer registry 才能 route 或生成 snapshot；
- 二阶段 presenter 必须绕过 consumer generation admission 才能工作；
- 实现要求 `@pluxel/commands` 依赖 Core/Runtime lifecycle。

发生否决条件时，应保留当前 root-only Runtime capability，让具体 provider 暂时显式使用普通 `@pluxel/commands` registry，
而不是发布一个所有权不诚实的便携 API。
