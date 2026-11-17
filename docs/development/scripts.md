---
title: Host 自动化脚本
description: 使用普通 TypeScript 读取配置、计算、条件修改、核对采用，通过 Node 客户端或 CLI 提交与查询运行。
---

脚本导出一个普通函数。执行器传入 `ScriptSdk` 与本次运行的 `{ id, input, signal }`。`sdk.plugin(nodeAddress)` 同步选择插件节点；异步控制操作成功直接返回值，失败抛出 `ScriptError`，直接使用目标 Host 的实现。单次操作可以直接返回：

```ts
import type { Script } from '@pluxel/agent-sdk/host'

export default ((sdk, run) => {
	run.signal.throwIfAborted()
	return sdk.plugins.list()
}) satisfies Script
```

远程 Node 应用接收作者侧编译的 JavaScript 制品，应用机器只需运行时。已知插件使用[生成的控制入口](./plugin-control.md)，可直接推导配置类型并调用实际实例的方法。Node 和 Vite 脚本使用同一个 `Script` 类型和 `ScriptSdk`，通过 `sdk.ctx` 使用内建 Context 能力，通过 `sdk.ctx.service(Service)` 借用应用安装的服务。Vite 项目脚本可以 import 当前模块图中的项目模块与服务声明，见[开发控制台](./dev-console.md)。

按目标选择执行方式，脚本函数保持相同：

| 目标             | 命令                                                 | 类型与模块来源                                                                        |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 当前开发应用     | `pluxel dev run ./dev/task.ts`                       | 当前 Vite 模块图；可直接导入项目 class 与服务声明                                     |
| 已部署 Node 应用 | `pluxel script run ./scripts/task.ts --endpoint URL` | 作者侧检查并上传；使用包的 `./control` 或[同步材料](./plugin-control.md#取得控制入口) |

Node 每次执行重新初始化上传模块的局部变量；Vite 复用模块缓存，顶层状态可能跨 run 保留。将业务工作放在导出函数中，每次从参数取得 SDK；只在当前 run 中使用 SDK 引用与实例视图。

多步操作使用普通 async/await，直接使用成功值。默认让异常中断后续步骤；只有任务能恢复时才写 `catch`。脚本返回普通 JSON，原插件业务方法保留自己的返回值与失败协议。需要组合业务 Result 时，从 `@pluxel/core/better-result` 导入，见 [Better Result](../plugin-development/better-result.md#组合多个可能失败的步骤resultgen)。

## 读取、计算、条件修改与核对采用

以下 `scripts/scale.ts` 使用 QueuePlugin 的控制入口，将数值配置 `concurrency` 乘以输入中的倍数。目标插件需要声明这个配置字段；希望运行中立即采用时，还需注册配置更新监听器，见[插件配置](../plugin-development/configuration.md)。运行中应用也可通过 `script sync` 或 `dev sync` 取得入口，见[控制材料同步](./plugin-control.md#取得控制入口)。

```ts
import type { Script } from '@pluxel/agent-sdk/host'
import { QueuePlugin } from '@acme/pluxel-plugin-queue/control'

export default (async (sdk, run) => {
	if (!run.input || typeof run.input !== 'object' || Array.isArray(run.input)) {
		throw new TypeError('Expected { factor: number }')
	}
	const { factor } = run.input as Record<string, unknown>
	if (typeof factor !== 'number' || !Number.isFinite(factor)) {
		throw new TypeError('Expected a finite factor')
	}
	const { get, patch } = sdk.plugin(QueuePlugin.nodeAddress()).config
	const before = await get()
	run.signal.throwIfAborted()
	const desired = before.config.concurrency * factor
	const changed = await patch(
		{ set: { concurrency: desired } },
		{ expectedManagedRevision: before.managedRevision },
	)
	const actual = await get()
	return {
		changed,
		actual,
		adopted:
			actual.application === 'applied' &&
			actual.appliedRevision === changed.desiredRevision &&
			actual.config.concurrency === desired,
	}
}) satisfies Script
```

插件引用的 `config.get()` 同时返回原始保存输入 `managedInput`、合成输入 `effectiveInput`、Schema 输出 `config`、来源 `sources`、被遮盖路径 `shadowedPaths` 和版本。`managedInput: null` 表示尚无保存记录。编辑时提交 `{ set?, remove? }`；`remove` 使用字符串路径数组。`config.reset()` 清除全部保存输入，传入路径列表则只清除这些路径，随后恢复来源合成。配置对象和其中的方法都可以提取到局部变量，目标由引用固定。

`expectedManagedRevision` 比较本 Host 的配置保存版本。冲突抛出 `ScriptError`，其 `details.code` 为 `revision_conflict`、`details.state` 为 `unchanged`。重新读取后由任务决定如何处理，执行器不会重投。`config.validate(change)` 只预检候选输入，后续写入仍需自己的版本条件。来源优先顺序和只读策略见 [Host 配置](../host/configuration.md#保存配置和运行策略)。

保存和运行采用分别查看：

| 返回字段                              | 含义                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `persistence`                         | 本次保存确认及其保留范围；写入确认失败可能为 `unknown`                              |
| `application: 'applied'`              | 当前运行 generation 已采用目标配置                                                  |
| `application: 'deferred'`             | 节点尚未运行，目标配置供后续启动使用                                                |
| `application: 'saved-not-applied'`    | 目标已保存，运行通知缺失、失败或 generation 已变化；检查 `applyFailure` 和 `report` |
| `desiredRevision` / `appliedRevision` | 已验证目标与当前 generation 已采用的版本                                            |

修改被其他来源遮盖的保存值可以推进保存版本，同时保持目标配置和运行版本。一次成功写入也可能被后续操作覆盖，所以需要实际采用时要像示例一样重新读取并比较目标版本。

## 插件、策略、更新与日志

`plugins.list(options?)` 返回有界发现页，成功值为 `{ nodes, catalogRevision, runtimeStateRevision, nextCursor }`。`nodes` 提供节点地址、期望与实际状态、诊断和最近更新；两个 revision 分别描述已接纳的定义集合与运行意图。按 package / definition 定向查询及分页规则见[动态发现](./plugin-control.md#动态安装后的发现与操作)。`sdk.plugin(Provider.nodeAddress())` 固定默认节点，`Provider.nodeAddress(id)` 选择已声明的 fork，随后通过引用的 `status/start/stop/restart` 操作节点。源码定位使用独立的 [`@pluxel/agent-sdk/source`](./inspection.md) 函数，可直接接收发现节点的 `address.definition`。启停成功值为应用报告；报告存在生命周期或协调问题时抛出 `lifecycle_failed`，异常的 `details.report` 保留完整报告及已提交的变化。生成地址保留的类型关联还提供 `instance()`，通过 `const { instance } = await plugin.instance()` 取得本次运行的业务实例视图，方法与资源寿命见[实例调用](./plugin-control.md#调用原插件实例)。

包管理器动态新增的插件在 Host 接纳后同样可发现，尚未启动也能查询。默认通过 `sdk.plugins.list({ packageName })` 定向发现包，已知完整 definition 时传 `{ definition }`；按页的 `nextCursor` 继续查询，再按节点的 default/fork 选择，将返回的完整 `address` 直接交给 `sdk.plugin()`。已有地址无需先列举。分页、材料同步与 class import 的使用条件见[动态安装后的发现与操作](./plugin-control.md#动态安装后的发现与操作)。

`policy.get/validate/patch/reset` 管理 Host 执行策略，修改使用相同的 `expectedManagedRevision` 条件。策略结果会区分已保存策略与需要重建 Host 才采用的设置。`updates.latest()` 读取 Host 最近一次更新报告，没有记录时返回 `null`。

日志沿用应用配置的 Core Logging 历史流。以下脚本在重启前标记范围，随后最多等待两秒读取该节点的前 100 条日志：

```ts
import type { Script } from '@pluxel/agent-sdk/host'
import { QueuePlugin } from '@acme/pluxel-plugin-queue/control'

export default (async (sdk) => {
	const plugin = sdk.plugin(QueuePlugin.nodeAddress())
	const history = await sdk.logs.streams()
	const stream = history.streams[0]
	if (!stream) return { skipped: 'no_history_stream' }
	const cursor = await sdk.logs.mark(stream.streamId)
	const report = await plugin.restart()
	const logs = await sdk.logs.wait(cursor, {
		filter: { plugin: plugin.address },
		limit: 100,
		timeoutMs: 2000,
	})
	const status = await plugin.status()
	return { report, status, logs }
}) satisfies Script
```

`logs.read(cursor, { limit, filter })` 立即读取，成功值的新 `cursor` 可用于下一批。`wait` 的 `timeoutMs` 必填，范围为 1–300000；到时返回当前读取结果，取消抛出 `cancelled` 并移除订阅。每批默认 100 条，最多 10000 条。

读取选项直接使用 `@pluxel/core/logging` 的 `LogReadOptions`；`filter.plugin` 接受完整节点地址，`wait` 在相同选项上要求 `timeoutMs`。

日志流重置、替换或超过保留窗口时抛出明确的 `epoch_mismatch`、`stream_replaced` 或 `from_too_old` 等错误；调用方决定从哪里重新开始。缺少 Logging 或历史存储会给出 `logging_unavailable` / `store_unavailable` 诊断，SDK 不安装新存储。日志窗口内也可以存在其他并发操作产生的记录。

## 借用已安装的服务

`sdk.ctx` 是当前 run 的根 Context 视图，内建能力直接通过 `sdk.ctx.logger`、`sdk.ctx.effects`、`sdk.ctx.events` 使用；应用配置日志后可读取 `sdk.ctx.logging`。这些能力无需服务声明或生成材料。SDK 视图的 `effects` 管理本次 run 登记的资源，run 关闭时自动释放；显式 dispose 该 scope 也不会关闭 Host 或插件。

Vault、Commands 等由应用安装的服务通过 `service(...)` 读取。直接导入服务声明或生成的服务描述符表示必需依赖；缺失时抛出 `ContextServiceMissingError`。可选依赖用 `defineServiceRef<T>()` 取得引用，仅未安装时返回 `undefined`，访问拒绝、构造失败和契约失配继续抛出。

上传脚本从生成的 `./control` 或同步模块导入服务值与对应的 `FooInstance` 类型，不加载本地服务实现：

```ts
import type { Script } from '@pluxel/agent-sdk/host'
import { defineServiceRef } from '@pluxel/core'
import { Commands, type CommandsInstance } from '@pluxel/services/control'

const CommandsRef = defineServiceRef<CommandsInstance>()

export default ((sdk) => {
	const required = sdk.ctx.service(Commands)
	const optional = sdk.ctx.service(CommandsRef)
	sdk.ctx.logger.info('Inspecting installed commands')
	return { sameService: required === optional, commands: required.list() }
}) satisfies Script
```

上例要求目标应用安装 Commands。`Commands` 和 `CommandsRef` 定位同一声明、同一服务，`defineServiceRef` 不生成另一份定义。同步输出的 `services` 包含实际模块、导出名和 `importStatement`；名称冲突时使用该输出的名字。Vite 项目脚本可以直接导入当前模块图中的服务 class，并用 `defineServiceRef<Service>()` 表达可选集成。

服务使用与 Plugin definition 相同的规范入口和具名导出规则，但没有节点地址、fork 或独立启停。远端按服务声明身份定位接收端已安装的服务，再核对生成的 API 契约摘要；本地实现对象、安装路径、包版本和材料 snapshot 都不是服务身份。服务未安装时不会自动创建或安装 provider，声明契约失配时重新同步并检查脚本。

需要 Plugin owner 服务时，先借用一个已运行节点的 Context：

```ts
import type { Script } from '@pluxel/agent-sdk/host'
import { ElysiaApp } from '@pluxel/services/control'
import { QueuePlugin } from '@acme/pluxel-plugin-queue/control'

export default (async (sdk) => {
	const ctx = await sdk.plugin(QueuePlugin.nodeAddress()).context()
	const app = ctx.service(ElysiaApp)
	return { routes: app.routes.length }
}) satisfies Script
```

`context()` 捕获当前 running generation，不会启动节点。返回的 Plugin Context 直接提供 `logger`、`effects`、`events`、`fs()` 和 `tinybase`，应用安装的服务继续通过 `service` 读取，各项能力保持原生 API。run 关闭或该 generation 被停止、重启、替换后，旧视图与已借用能力失效，重新调用 `context()` 取得新 generation。`sdk.ctx` 允许根访问，节点 Context 允许 owner 访问，两者都保留安装权限。脚本自己创建的订阅、RPC lease 和其他资源仍须按原 API 释放。

## 向 Node 应用提交

程序调用使用 [`@pluxel/agent-sdk/client`](./agent-sdk.md#从-node-连接现有-host) 的 `runScript`、`getScriptResult` 和 `cancelScript`，可直接运行普通 Node 文件。以下 CLI 命令使用同一客户端实现。

在作者项目安装所用依赖，使用 Node 24 或更新版本：

```sh
vp add -D @pluxel/cli @pluxel/agent-sdk @pluxel/core @pluxel/host typescript
```

目标应用使用官方管理服务时显式开启脚本执行，例如现有应用装配中的：

```ts
import { servicesPreset } from '@pluxel/services/preset'

// 在 defineHostApplication 的 startup 回调中
const services = await servicesPreset(startup, { workbench: false, scripts: true })
```

手动组合管理服务则使用 `managementHttp({ scripts: true })`，其余认证与管理服务装配见 [Management](../host/management.md)。默认关闭执行能力。开启它授予管理员在目标 Node 进程内执行受信任代码的权限；Node 模块工厂使用同进程加载，拥有进程级 JavaScript 能力。启用此选项的应用负责信任提交者。

凭据文件为 JSON，接受 `password`、`code` 或已认证会话的 `cookie`，按目标认证方式提供。密码或验证码挑战自动按该文件应答；OIDC 先完成浏览器认证，再提供会话 cookie。凭据文件自行限制为当前用户可读，避免提交到版本库。

```sh
mkdir -p receipts
vp exec pluxel script run ./scripts/scale.ts \
  --endpoint https://app.example.com \
  --credentials-file ./admin.json \
  --input '{"factor":2}' \
  --receipt-file ./receipts/scale.receipt
```

`--input-file FILE` 可替代 `--input`。默认调用 `default` 导出，具名函数用 `--export NAME`。作者侧先进行 TypeScript 检查和打包，上传 JS 工厂与源码映射。经清单验证的生成插件地址、服务描述符和普通计算依赖可随脚本打包。生成提供者的标准工厂、`@pluxel/agent-sdk/host` 的运行时导出与 `@pluxel/core/better-result` 使用目标框架的受控共享绑定；捕获 `ScriptError` 时沿用目标进程的类身份。其余框架运行时、Node builtin、原生扩展和运行时动态 import 在上传模式中拒绝。异步工作放入导出函数，工厂顶层同步初始化。需要直接 import 项目模块或服务实现时使用 Vite 项目模式。

run、result 和 cancel 的 stdout 返回单个 `{ ok: true, value: { receipt, run } }` JSON；编译、连接或查询失败时返回 `{ ok: false, error: { code, message, receipt?, diagnostics?, context? } }`。dev 与 script 的 sync 同样使用 `{ ok, value/error }`，成功值的 `definitions` 与 `services` 提供可复制的 `importStatement`，见[控制材料同步](./plugin-control.md#取得控制入口)。`script` 缺少子命令、拼错子命令或含未知选项时也返回单个 `invalid_input` JSON，退出码为 `1`；通过 `pluxel script --help` 查看命令。默认等待结算，`--detach` 在接纳后返回；`--timeout` 默认为 30000，最大 300000 毫秒，包含排队与加载时间。

TypeScript 检查失败的 `error.diagnostics` 保留 `{ file?, line?, column?, code, message }`，行列从 1 开始。静态确定不可调用的导出会在检查时拒绝，动态类型由执行时核验；业务输入仍由函数按任务校验，JSON 可移植性检查不替代业务 Schema。

### 保存和恢复 receipt

`script run`、`dev run` 和 `dev hmr` 均支持 `--receipt-file FILE`。CLI 在首次提交前以 `0600` 新建文件，写入完成后才向 stderr 输出 `{ stage: 'prepared', receipt }`；收到接纳后输出 `{ stage: 'accepted', receipt }`。路径相对终端当前目录，父目录需已存在，每次新操作使用新文件名；同名文件不会覆盖，写入失败不会提交操作。

查询和取消直接读取保存的文件，避免复制长 token：

```sh
vp exec pluxel script result --receipt-file ./receipts/scale.receipt --credentials-file ./admin.json
vp exec pluxel script cancel --receipt-file ./receipts/scale.receipt --credentials-file ./admin.json
```

也可将原 receipt token 作为唯一位置参数传入；它与 `--receipt-file` 必须且只能选择一个。文件只包含一个完整 token，可带一个末尾换行，不接受 JSON 包装、额外空白或多行内容；错误文件不会触发连接。

上传与 Vite 项目执行共享 `pluxel-script-v3` receipt。它记录原执行实例、run ID、请求摘要及连接方式：远程保存 endpoint，本地保存 Vite root 和可选 serviceId。所有运行统一用 `script result/cancel` 查询或取消，本地 receipt 使用原控制台认证，省略 `--credentials-file`；远程权限由重新认证的原主体决定。断线后可查询原运行；receipt 本身不授予权限。接纳响应丢失时先查询原 receipt，避免再次提交产生新任务。执行实例关闭或结果过期会明确报错，CLI 会核对原实例与摘要。

## 失败、取消和释放

`run.state: 'succeeded'` 表示函数返回、结果编码和 SDK 清理已完成，返回的 JSON 位于 `run.value`。未捕获的 SDK 控制错误形成 `failed`，后续步骤停止。

CLI 退出码按执行状态判断：`failed/cancelled` 为 1，等待结束时仍未结算为 2，`succeeded` 或 `--detach` 已接纳为 0。

SDK 的预期失败抛出 `ScriptError`。`error.code` 是错误码，`error.details` 保留包含 `code`、`message` 和原领域字段的只读联合；按 `details.code` 缩小类型。执行回执中的 `run.error.details` 保留同一份领域数据。生命周期失败携带完整 `report`，可能已有部分变化生效。持久化确认失败保留 `state: 'unknown'`，先核对当前状态。关闭后的调用抛出 `scope_closed`，禁止交错的业务与管理调用抛出 `borrowed_generation_conflict`，已知取消抛出 `cancelled`。

需要针对失败恢复时，再捕获具体错误。例如版本冲突可以交还给任务重新决策：

```ts
import { ScriptError, type Script } from '@pluxel/agent-sdk/host'
import { QueuePlugin } from '@acme/pluxel-plugin-queue/control'

export default (async (sdk) => {
	const { get, patch } = sdk.plugin(QueuePlugin.nodeAddress()).config
	const current = await get()
	try {
		return await patch(
			{ set: { concurrency: current.config.concurrency + 1 } },
			{ expectedManagedRevision: current.managedRevision },
		)
	} catch (error) {
		if (error instanceof ScriptError && error.details.code === 'revision_conflict') {
			return { changed: false, reason: error.details.code, current: await get() }
		}
		throw error
	}
}) satisfies Script
```

服务访问与缺失、权限和契约错误见[借用已安装的服务](#借用已安装的服务)。插件自己的业务 Result、异常和资源协议保持原样。

`sdk.plugin()` 同步选择目标，错误参数或关闭的 run 同步抛错。提供者的 `definitionAddress()`、`nodeAddress()` 和 `nodeAddress(id)` 只生成地址，不查询或启动插件。异步操作的错误参数形状、无效数值和未知实现缺陷仍可 reject；原业务方法保持自己的返回类型、异常和资源协议。加载、执行、结果编码或清理失败形成 `failed`，带有阶段和错误，清理错误另存 `cleanupError`。

如果原业务方法返回共享 Better Result，脚本可以显式处理它，也可以作为顶层业务结果返回。执行边界用原生 `Result.codec` 编码为 `{ status: 'ok', value }` 或 `{ status: 'error', error }`；业务 `Err` 留在成功运行的 `run.value` 内，由调用方判断。识别依据是共享库实例，普通 JSON 的同名字段不改变执行语义。Result payload 使用相同的 JSON 约束；嵌套 Result、业务 Error/TaggedError 和资源句柄由作者显式投影，执行器不会调用任意 `toJSON`。

脚本的每个 Host 操作独立提交。前几步已成功而后一步失败时，原修改继续有效。执行器不自动回滚或重放；需要批量逐项处理时，用普通循环和任务明确需要的 `try/catch` 收集结果。普通返回值和 Result payload 均须为 JSON 数据，实例、Context、函数、循环引用、BigInt 或带 getter 的对象会在编码阶段失败。输入与结果分别限 1 MiB，结果保留有界；需要后续访问的对象返回业务 ID。

编码错误的 `context.path` 指出失败位置（例如 `$.items[2].handle`），`context.valueKind` 表示值类别；共享 Result 从 `$.value` 或 `$.error` 标记 payload。检查该位置并显式投影成数据后再提交，已有修改仍需按原 receipt 核对。

取消先传递 `run.signal` 并关闭新的 SDK 调用，状态可保持 `cancelling`，直到已接纳的 Host 操作和脚本真正结算。Node 和 Vite 都使用协作取消；自定义等待应监听 signal，同步死循环无法由同一事件循环的 timer 强制中断。已发生的修改保持原结果，终态保留执行错误与前后版本以便核对。

客户端断线保留已接纳任务。显式取消、管理员授权撤回、退出认证、Host 被撤回或执行所有者关闭会取消对应运行。Node 执行所有者随应用存活，Vite 执行所有者随开发实例存活。结果只存在于原所有者的有限保留内存中；应用重启后要根据业务状态人工确认，不从 receipt 自动重投。

运行结束时 SDK 拒绝新调用并等待它已接纳的工作，移除本次日志等待订阅。SDK 借用 Host，清理不关闭应用。脚本自己创建的原生资源仍使用 `using`、`await using` 或 `try/finally` 释放；实例及 Context 借用限定在本次运行及当前 generation 内。

## 在同进程直接使用

自定义宿主工具可以在已启动 Host 上直接创建 scope，无需认证通道或官方 Services：

```ts
import { createScriptScope } from '@pluxel/agent-sdk/host'
import task from './scripts/scale'

const controller = new AbortController()
await using scope = createScriptScope({ ctx: host.ctx, signal: controller.signal })
const value = await task(scope.sdk, {
	id: 'local-scale',
	input: { factor: 2 },
	signal: controller.signal,
})
console.log(value)
```

这里的 `host` 由调用方创建和关闭。`scope.abort(reason)` 关闭接纳并通知在途 SDK 操作，`await using` 或显式 `dispose()` 等待同一个幂等结算过程；可在其后读取 `scope.snapshot()` 的 Host 版本。需要队列、run 查询与可移植结果时使用 `ScriptExecutor` / `executeHostScript`，Node 制品加载器单独从 `@pluxel/host/internal/agent/node` 引入。实现边界与验证入口见[脚本架构](https://github.com/PluxelJS/pluxel/blob/main/engineering/AGENT_WORKFLOW.md)。
