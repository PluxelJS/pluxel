---
title: Host 自动化脚本
description: 使用普通 TypeScript 读取配置、计算、条件修改、核对采用，并通过 CLI 提交与查询运行。
---

脚本导出一个普通函数。执行器传入 `ScriptSdk` 与本次运行的 `{ id, input, signal }`。`sdk.plugin(target)` 同步选择插件；异步控制操作统一返回 `Promise<Result<T, E>>`，直接使用目标 Host 的实现。单次操作可以直接返回：

```ts
import type { Script } from '@pluxel/host/agent'

export default ((sdk, run) => {
	run.signal.throwIfAborted()
	return sdk.plugins.list()
}) satisfies Script
```

远程 Node 应用接收作者侧编译的 JavaScript 制品，应用机器只需运行时。已知插件使用[生成的控制入口](./plugin-control.md)，可直接推导配置类型并调用实际实例的方法。Vite 项目脚本还可以 import 项目模块和访问 Context，见[开发控制台](./dev-console.md)。两种加载方式使用同一组 Host SDK 方法。

多步操作使用普通 async/await：检查 `result.isErr()` 并提前返回，从 `result.value` 读取成功值。脚本可以直接返回已有 SDK Result 或普通 JSON。需要构造或组合 Result 时，使用 `import { Result } from '@pluxel/core/better-result'`；上传编译器和加载器将这个入口绑定到目标共享库。进阶组合见 [Better Result](../plugin-development/better-result.md#组合多个可能失败的步骤resultgen)。

## 读取、计算、条件修改与核对采用

以下 `scripts/scale.ts` 使用 QueuePlugin 的控制入口，将数值配置 `concurrency` 乘以输入中的倍数。目标插件需要声明这个配置字段；希望运行中立即采用时，还需注册配置更新监听器，见[插件配置](../plugin-development/configuration.md)。运行中应用也可通过 `script sync` 或 `dev sync` 取得入口，见[控制材料同步](./plugin-control.md#取得控制入口)。

```ts
import type { Script } from '@pluxel/host/agent'
import { QueuePlugin } from '@acme/pluxel-plugin-queue/control'

export default (async (sdk, run) => {
	if (!run.input || typeof run.input !== 'object' || Array.isArray(run.input)) {
		throw new TypeError('Expected { factor: number }')
	}
	const { factor } = run.input as Record<string, unknown>
	if (typeof factor !== 'number' || !Number.isFinite(factor)) {
		throw new TypeError('Expected a finite factor')
	}
	const { get, patch } = sdk.plugin(QueuePlugin).config
	const before = await get()
	if (before.isErr()) return before
	run.signal.throwIfAborted()
	const desired = before.value.config.concurrency * factor
	const changed = await patch(
		{ set: { concurrency: desired } },
		{ expectedManagedRevision: before.value.managedRevision },
	)
	if (changed.isErr()) return changed
	const actual = await get()
	if (actual.isErr()) return actual
	return {
		changed: changed.value,
		actual: actual.value,
		adopted:
			actual.value.application === 'applied' &&
			actual.value.appliedRevision === changed.value.desiredRevision &&
			actual.value.config.concurrency === desired,
	}
}) satisfies Script
```

插件引用的 `config.get()` 同时返回原始保存输入 `managedInput`、合成输入 `effectiveInput`、Schema 输出 `config`、来源 `sources`、被遮盖路径 `shadowedPaths` 和版本。`managedInput: null` 表示尚无保存记录。编辑时提交 `{ set?, remove? }`；`remove` 使用字符串路径数组。`config.reset()` 清除全部保存输入，传入路径列表则只清除这些路径，随后恢复来源合成。配置对象和其中的方法都可以提取到局部变量，目标由引用固定。

`expectedManagedRevision` 比较本 Host 的配置保存版本。冲突返回 `Err`，其中 `error.code` 为 `revision_conflict`、`state` 为 `unchanged`。重新读取后由任务决定如何处理，执行器不会重投。`config.validate(change)` 只预检候选输入，后续写入仍需自己的版本条件。来源优先顺序和只读策略见 [Host 配置](../host/configuration.md#保存配置和运行策略)。

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

`plugins.list()` 的成功值提供节点地址、期望与实际状态、诊断和最近更新，适合发现与巡检。`sdk.plugin(descriptorOrAddress)` 固定目标，随后通过引用的 `status/start/stop/restart` 操作节点；`fork(id)` 返回另一个目标引用。启停成功值为应用报告；报告存在生命周期或协调问题时返回 `lifecycle_failed`，错误携带完整 `report`，保留已提交的变化。生成描述符的引用还提供 `instance()`，成功值直接是本次运行的业务实例视图，方法与资源寿命见[实例调用](./plugin-control.md#调用原插件实例)。

`policy.get/validate/patch/reset` 管理 Host 执行策略，修改使用相同的 `expectedManagedRevision` 条件。策略结果会区分已保存策略与需要重建 Host 才采用的设置。`updates.latest()` 读取 Host 最近一次更新报告，没有记录时返回 `null`。

日志沿用应用配置的 Core Logging 历史流。以下脚本在重启前标记范围，随后最多等待两秒读取该节点的前 100 条日志：

```ts
import type { Script } from '@pluxel/host/agent'

export default (async (sdk) => {
	const nodes = await sdk.plugins.list()
	if (nodes.isErr()) return nodes
	const node = nodes.value[0]
	if (!node) return { skipped: 'no_plugin' }
	const history = await sdk.logs.streams()
	if (history.isErr()) return history
	const stream = history.value.streams[0]
	if (!stream) return { skipped: 'no_history_stream' }
	const plugin = sdk.plugin(node.address)
	const cursor = await sdk.logs.mark(stream.streamId)
	if (cursor.isErr()) return cursor
	const report = await plugin.restart()
	if (report.isErr()) return report
	const logs = await sdk.logs.wait(cursor.value, {
		filter: { plugin: plugin.address },
		limit: 100,
		timeoutMs: 2000,
	})
	if (logs.isErr()) return logs
	const status = await plugin.status()
	if (status.isErr()) return status
	return { report: report.value, status: status.value, logs: logs.value }
}) satisfies Script
```

`logs.read(cursor, { limit, filter })` 立即读取，成功值的新 `cursor` 可用于下一批。`wait` 的 `timeoutMs` 必填，范围为 1–300000；到时返回当前读取结果，取消返回 `Err` 并移除订阅。每批默认 100 条，最多 10000 条。

日志流重置、替换或超过保留窗口时返回明确的 `epoch_mismatch`、`stream_replaced` 或 `from_too_old` 等结果；调用方决定从哪里重新开始。缺少 Logging 或历史存储会给出 `logging_unavailable` / `store_unavailable` 诊断，SDK 不安装新存储。日志窗口内也可以存在其他并发操作产生的记录。

## 向 Node 应用提交

在作者项目直接安装 CLI、Core、脚本类型和编译器，使用 Node 24 或更新版本：

```sh
pnpm add -D @pluxel/cli @pluxel/core @pluxel/host @pluxel/rolldown typescript
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
pnpm exec pluxel script run ./scripts/scale.ts \
  --endpoint https://app.example.com \
  --credentials-file ./admin.json \
  --input '{"factor":2}' \
  --receipt-file ./receipts/scale.receipt
```

`--input-file FILE` 可替代 `--input`。默认调用 `default` 导出，具名函数用 `--export NAME`。作者侧先进行 TypeScript 检查和打包，上传 JS 工厂与源码映射。经清单验证的纯描述符和普通计算依赖可随脚本打包；`@pluxel/core/better-result` 使用受控共享绑定。其余框架运行时、Node builtin、原生扩展和运行时动态 import 在上传模式中拒绝。异步工作放入导出函数，工厂顶层同步初始化。需要项目模块或 Context 时使用 Vite 项目模式。

CLI 在首次提交前向 stderr 输出 `{ stage: 'prepared', receipt }`，收到接纳后输出 `{ stage: 'accepted', receipt }`。`--receipt-file` 在上传前以 `0600` 新建文件，父目录需已存在，同名文件不会覆盖。stdout 返回单个 `{ receipt, run }` JSON；编译、连接或调用失败时返回 `{ receipt?, error }`。默认等待结算，`--detach` 在接纳后返回；`--timeout` 默认为 30000，最大 300000 毫秒，包含排队与加载时间。

查询和取消传入原 receipt token：

```sh
pnpm exec pluxel script result "$(cat ./receipts/scale.receipt)" --credentials-file ./admin.json
pnpm exec pluxel script cancel "$(cat ./receipts/scale.receipt)" --credentials-file ./admin.json
```

receipt 记录原 endpoint、执行实例、run ID 和请求摘要，权限仍由重新认证的原主体决定。断线后可查询原运行；receipt 本身不授予权限。接纳响应丢失时先查询原 receipt，避免再次提交产生新任务。执行实例关闭或结果过期会明确报错，CLI 会核对原实例与摘要。

## 失败、取消和释放

`run.state: 'succeeded'` 表示函数返回、结果编码和 SDK 清理已完成。顶层共享 Result 由执行边界通过原生 `Result.codec` 编码为 `{ status: 'ok', value }` 或 `{ status: 'error', error }`；领域 `Err` 仍是成功运行中的业务结果。原有 JSON 返回值继续作为普通数据。识别依据是共享库的实际 Result 实例，JSON 的同名字段不会改变执行语义。

SDK 的预期失败以 `Err` 返回，错误是包含 `code`、`message` 的只读数据。按 `error.code` 缩小类型，原配置、持久化和应用报告继续保留。生命周期失败同样携带完整报告，可能已有部分变化生效。持久化确认失败保留 `state: 'unknown'`，先核对当前状态。关闭后的异步调用返回 `scope_closed`，禁止交错的业务与管理调用返回 `borrowed_generation_conflict`，已知取消返回 `cancelled`。

`plugin()` 和 `fork()` 是同步选择器，错误参数或关闭的 run 同步抛错。异步操作的错误参数形状、无效数值和未知实现缺陷仍可 reject；原业务方法保持自己的返回类型、异常和资源协议。加载、执行、结果编码或清理失败形成 `failed`，带有阶段和错误，清理错误另存 `cleanupError`。

Result 的 payload 使用同样的 JSON 约束。嵌套 Result、业务 Error/TaggedError 实例和资源句柄需要作者在自己的边界通过显式 codec 或数据投影处理；执行器不会调用任意 `toJSON`。

脚本的每个 Host 操作独立提交。前几步已成功而后一步失败时，原修改继续有效。执行器不自动回滚或重放；需要批量逐项处理时用普通循环检查各步 Result。普通返回值和 Result payload 均须为 JSON 数据，实例、Context、函数、循环引用、BigInt 或带 getter 的对象会在编码阶段失败。输入与结果分别限 1 MiB，结果保留有界；需要后续访问的对象返回业务 ID。

取消先传递 `run.signal` 并关闭新的 SDK 调用，状态可保持 `cancelling`，直到已接纳的 Host 操作和脚本真正结算。Node 和 Vite 都使用协作取消；自定义等待应监听 signal，同步死循环无法由同一事件循环的 timer 强制中断。已发生的修改保持原结果，终态保留执行错误与前后版本以便核对。

客户端断线保留已接纳任务。显式取消、管理员授权撤回、退出认证、Host 被撤回或执行所有者关闭会取消对应运行。Node 执行所有者随应用存活，Vite 执行所有者随开发实例存活。结果只存在于原所有者的有限保留内存中；应用重启后要根据业务状态人工确认，不从 receipt 自动重投。

运行结束时 SDK 拒绝新调用并等待它已接纳的工作，移除本次日志等待订阅。SDK 借用 Host，清理不关闭应用。脚本自己创建的原生资源仍使用 `using`、`await using` 或 `try/finally` 释放；实例及 Context 借用限定在本次运行及当前 generation 内。

## 在同进程直接使用

自定义宿主工具可以在已启动 Host 上直接创建 scope，无需认证通道或官方 Services：

```ts
import { createScriptScope } from '@pluxel/host/agent'
import task from './scripts/scale'

await host.start()
const controller = new AbortController()
const scope = createScriptScope({ ctx: host.ctx, signal: controller.signal })
try {
	const value = await task(scope.sdk, {
		id: 'local-scale',
		input: { factor: 2 },
		signal: controller.signal,
	})
	console.log(value)
} finally {
	await scope.dispose()
}
```

这里的 `host` 由调用方创建和关闭。`scope.abort(reason)` 关闭接纳并通知在途 SDK 操作，`dispose()` 等待结算；可在其后读取 `scope.snapshot()` 的 Host 版本。需要队列、run 查询与可移植结果时使用 `ScriptExecutor` / `executeHostScript`，Node 制品加载器单独从 `@pluxel/host/agent/node` 引入。实现边界与验证入口见[脚本架构](https://github.com/PluxelJS/pluxel/blob/main/engineering/AGENT_WORKFLOW.md)。
