---
title: 在线开发控制台
description: 让 coding agent 通过当前 Vite 执行 TypeScript，检查插件、修改配置、调用 Workbench API 并读取真实日志。
---

开发控制台让你保持 dev 运行，随时用 TypeScript 操作当前插件和数据。Coding agent 使用 CLI 提交脚本，代码在当前 Vite SSR 模块图和同一个 Node 宿主中执行；不用重启 dev 或创建测试宿主。

适合检查当前状态、填入测试数据、修改配置和验证真实调用。隔离的行为回归继续使用 [test host](./testing.md)。修改会作用于眼前这份应用；已经保存的配置和数据不会随脚本结束自动还原。

## 开启与发现

在现有 Vite route 上显式开启：

```ts no-twoslash
import { defineConfig } from 'vite'
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'

export default defineConfig({
	plugins: [
		staticRuntimeVitePlugin({
			entry: './src/pluxel.static.ts',
			devConsole: true,
		}),
	],
})
```

`dynamicRuntimeVitePlugin({ entry, devConsole: true })` 使用相同选项。启动项目原有的 Vite dev 命令，然后运行：

```sh
pluxel dev instances
pluxel dev run dev/inspect.ts
```

省略 `devConsole` 不安装控制台。两条 Vite integration 只在 serve 时安装；dynamic 的 `mode: 'distribution'` 拒绝开启。当前执行服务支持 Linux/macOS 等具有 Unix socket 文件权限的系统，Windows 尚不支持。

CLI 默认从命令当前目录向上找到最近的 `package.json`，只查询该目录的控制台；以命令工作目录为准，不以脚本路径为准。该项目没有运行中的控制台就报告 `dev_unavailable`，不会继续寻找父项目或其他项目的服务。

从 monorepo 顶层操作子项目，或 Vite root 与最近的 package 目录不同时，显式指定 `--root projects/my-host`。同一 root 只有一个运行实例时自动选择；有多个时报告 `ambiguous_instance`，必须用 `--instance <instanceId>` 选择。`--instance` 只在选定 root 内匹配，不进行全局搜索。它不会猜最近启动的实例，也不会替你启动另一个 dev。

dev 命令会在连接前拒绝未知选项；例如拼错 `--instance` 会返回 `invalid_input`，不会因此退回自动选择。`instances` 只按 root 列出候选，`--instance` 用于后续 `run/result/cancel`。

入口文件必须在所选 Vite root 内，不能放在 `.pluxel`、`.git` 或 `node_modules`。脚本依赖按原有 Vite 规则解析，可以 import 已允许的工作区源码。相对 CLI 文件路径从命令当前目录解析，`--root` 只选择宿主。

## Coding agent 工作流程

需要查看或修改**当前运行中的应用**时，coding agent 必须使用这套控制台。配置编辑、Workbench RPC 填数据、调用 Plugin 方法、启停插件和查看日志都在现有 dev 实例上完成；需要隔离环境和可重复断言时使用 test host。

1. 从项目的 Vite 配置或启动命令确定 root，用 `pluxel dev instances --root <project-root>` 发现实例。核对返回的 `root`、`pid` 和 `instanceId`，将选中的绝对 root 与 instanceId 记入任务上下文。
2. 后续 `run/result/cancel` 都显式传相同的 `--root` 和 `--instance`，避免切换工作目录或新增 dev 实例后改变操作目标。没有发现服务时先核对 root、原 dev 进程和 `devConsole` 配置。
3. 在该 root 内维护少数普通 TypeScript 操作文件，通过 default/named export 追加操作。先读取插件状态、配置描述或 Workbench layout，再按项目实际类型修改；参数经 `run.input` 传入并校验，跨次保存业务 ID 和 JSON 游标。
4. 检查外层请求是否成功、run 的 `state`，再检查脚本返回的领域 `ok`、apply report 和配置 `application`。修改后重新读取目标状态及相关日志；CLI 退出成功不等于配置已应用或插件已启动。
5. 保留 receipt 中的 root、instanceId 和 runId。工具超时或终端断开后，用这些字段查询 `result`；先确定已发生的操作，再决定下一次提交。已验证的行为需要回归保护时，另写隔离测试。

本仓库的 `projects/plugin-host` 已开启控制台，并提供只读的 `dev/inspect.ts`。保持该项目原有 dev 命令运行后，从仓库根目录调用：

```sh
pnpm exec pluxel dev instances --root projects/plugin-host
pnpm exec pluxel dev run projects/plugin-host/dev/inspect.ts --root projects/plugin-host --instance <instanceId>
```

其他项目替换 root 和脚本路径即可。跨工作目录调用时使用绝对路径；`--root` 选择运行宿主，不改变脚本路径的解析基准。

## 写一个可以反复运行的操作

下面以项目已有的 `TodoPlugin` 为例；方法和配置字段由你的 Plugin 定义：

```ts no-twoslash
// dev/inspect.ts
import type { DevConsole } from '@pluxel/runtime/dev'
import { TodoPlugin } from '@example/todo-plugin'

export default async function (dev: DevConsole) {
	return {
		status: await dev.plugins.status(TodoPlugin),
		todos: dev.plugins.require(TodoPlugin).snapshot(),
	}
}
```

新增操作可以写在同一文件的 named export 中：

```ts no-twoslash
import type { DevConsole, DevRunContext } from '@pluxel/runtime/dev'
import { TodoPlugin } from '@example/todo-plugin'

export async function add(dev: DevConsole, run: DevRunContext) {
	if (typeof run.input !== 'string') throw new TypeError('Expected a todo title')
	const result = dev.plugins.require(TodoPlugin).add(run.input)
	return result
}
```

```sh
pluxel dev run dev/inspect.ts
pluxel dev run dev/actions.ts --export add --input '"Verify current data"'
```

默认调用 default export；`--export` 选择具名函数。`--input` 是 JSON，较大输入可以用互斥的 `--input-file`；省略时 `run.input` 为 `undefined`。`DevRunContext` 同时提供 `id` 和 `signal`。跨进程的 input 类型始终是 unknown，需要脚本校验。

修改文件、增加 export、换文件、传入新参数都不需要重启。每次提交调用当前导出函数；模块顶层不是每次运行的入口，不要把写数据放在那里。HMR 更新代码，但不会自动重放脚本。

每次重新取得当前实例。`require()` 不自动启动插件，也不把旧 constructor 转成新 implementation；旧 target 会报告 `stale_target`。普通实例方法没有额外的可撤销代理，跨 await 后可能已经过期；需要 generation admission 的调用优先使用 commands、Workbench 或已有 database handle。

## 先发现，再修改

`await dev.plugins.list()` 返回当前管理状态及稳定 PluginNodeAddress。`status/start/stop/restart`、配置和日志过滤既接受地址，也接受 Plugin constructor。根据列表里的 definition entry/exportName，从项目源码或 package root import 对应 Plugin 后，就能用 `require()` 得到精确类型。

已有 fork 可用 `{ plugin: TodoPlugin, forkId: 'east' }` 表达。它不创建 fork。`require()` 只接受 typed target；不要拿一个地址强制断言成 Plugin 实例类型。

```ts no-twoslash
const stopped = await dev.plugins.stop(TodoPlugin)
const started = await dev.plugins.start(TodoPlugin)
return { stopped, started, current: await dev.plugins.status(TodoPlugin) }
```

控制接口返回真实执行结果与 apply report，不像 test host 那样注册临时 catalog 或自动把未达成状态转换成断言失败。读取领域结果中的 `ok`、实际状态和 lifecycle issues；CLI 成功执行脚本不代表业务操作一定成功。

## 编辑配置

先读当前值和字段描述，再验证或修改：

```ts no-twoslash
export async function inspectConfig(dev: DevConsole) {
	return {
		current: await dev.config.get(TodoPlugin),
		fields: await dev.config.describe(TodoPlugin),
	}
}

export async function increaseLimit(dev: DevConsole) {
	const patch = { maxItems: 100 }
	const checked = await dev.config.validate(TodoPlugin, patch)
	if (!checked.ok) return checked
	const applied = await dev.config.patch(TodoPlugin, patch)
	return { applied, current: await dev.config.get(TodoPlugin) }
}
```

`get()` 返回 saved raw values、defaults 和 desired/applied revision；`describe()` 返回可序列化的字段展示 plan，包含字段路径、约束和默认值。它不是原始 Valibot schema 对象。

`patch()` 是已有配置契约的浅合并。修改嵌套字段时，用 `describe()` 给出的 field path 调用 `patchField(target, { fieldPath, value })`，避免替换整个父对象。`reset(target, keys)` 清除指定顶层保存值；省略或空 keys 清除全部保存值。

修改始终经过真实 validation、persistence 和 notification。检查返回的 `application`：`applied`、`deferred`、`saved-not-applied` 含义不同。validate 不保存，但它与之后的 patch 不是一个原子操作；patch 会重新验证。需要 restart 的 Plugin 应显式 restart，而不是直接写 config 私有字段。

## 调用 Workbench RPC 填入数据

宿主需要正常启用 Workbench；控制台不会隐式开启它。先用 `dev.workbench.list({ target, principal })` 查看当前 layout，再从项目代码 import exact descriptor。descriptor 保留 API 类型，让 coding agent 能按真实签名传参。

下面假设项目已导出 `TodoWorkbench.editor`，其 View API 提供 `add({ title })`：

```ts no-twoslash
import type { DevConsole } from '@pluxel/runtime/dev'
import { TodoPlugin, TodoWorkbench } from '@example/todo-plugin'
import { detachWorkbenchPortableValue } from '@pluxel/runtime/workbench/client'

export default async function (dev: DevConsole) {
	const principal = { provider: 'dev-console', subject: 'coding-agent' }
	using editor = await dev.workbench.open({
		target: TodoPlugin,
		entry: TodoWorkbench.editor,
		principal,
	})
	const created = await detachWorkbenchPortableValue(
		editor.api.add({ title: 'Created through the real Workbench API' }),
	)
	return created
}
```

principal 显式表达本次调用身份，插件仍可按自己的授权规则拒绝。它不证明浏览器登录成功。open 使用真实本地 Cap’n Web session；View 返回 typed `api`，Attachment 返回 `provider/consumer`，交互 Content 返回 `root`。形状与 test 的 Workbench driver 一致。

每个 RPC 都必须 await，结束时用 using 释放句柄；run scope 会兜底释放遗留 session。对象或数组形式的 RPC 结果使用 `detachWorkbenchPortableValue()` 转成普通数据并释放 transport result；需要业务校验时仍要单独校验。不要跨运行保存 RpcStub，不要返回整个打开的 handle 给 CLI。React 渲染、点击、真实 WebSocket 和登录链路仍需浏览器或 carrier 测试。

## 调用业务方法与读取数据库

优先调用 Plugin 的公开业务方法或已注册 command：

```ts no-twoslash
const commands = dev.commands.list()
const result = await dev.commands.execute('todo.add', { title: 'Agent fixture' })
return { commands, result }
```

直接实例访问适合项目自己的诊断和 fixture。它不会自动给任意字段修改补齐业务校验、通知、数据库写入或缓存失效；没有通用 `state.patch(path, value)`。

Plugin 如果有意公开 owner-bound database handle，可以像 test 一样使用其 `read()` / `transaction()`；PGlite 就是当前 dev root 的那一个实例。控制台不提供 root SQL admin，不读取 Plugin private field，也不会重新打开 data directory。没有公开 handle 时使用领域方法或 command 填数据。

`dev.http.fetch(new URL('/health', dev.http.origin))` 调用当前进程内 HTTP directory；逻辑 origin 不可用于物理网络连接。

## 日志与续读

```ts no-twoslash
export async function restartWithLogs(dev: DevConsole) {
	const cursor = await dev.logs.mark()
	const result = await dev.plugins.restart(TodoPlugin)
	return {
		result,
		logs: await dev.logs.read({ cursor, target: TodoPlugin, limit: 200 }),
	}
}
```

`mark()` 刷出当前 store 缓冲后取游标；`read()` 有界扫描并返回下一 cursor。`hasMore` 时继续用返回的 cursor 读下一页。stream reset、retention gap 和 logging root 变化都会明确报告，不能当成“没有日志”。cursor 是 JSON 数据，可以保存并作为后续脚本输入，按 `DevLogCursor` 的字段校验后续读。

`tail()` 用于浏览最近窗口，默认 200、最多 2000；不能用它证明没有更早的匹配。`wait()` 默认等 5 秒，最多 30 秒，还受 run deadline/signal 约束；reason 区分 `available`、`more`、`timeout` 和 `reset`。`more` 表示还有待扫描页，不代表已匹配目标日志。

默认 launcher 在 devConsole 开启时增加或复用 bounded store，Workbench 关闭也能读日志；显式 custom/silent logging 优先，没有可用 store 时抛出 code 为 `logs_unavailable` 的 `DevConsoleError`。日志等级、redaction 和保存窗口沿用宿主设置，不自动打开 debug。

每次执行的外层结果还带 host epoch、前后 catalog/state revision，以及可用时的日志起止 cursor。游标表示时间窗口，不是因果 trace；后台任务和浏览器可能同时产生日志。

## 结果、取消和恢复

命令执行结果在 stdout 输出单一 JSON envelope。帮助输出和参数解析失败遵循普通 CLI 输出规则，agent 还需检查退出码与 stderr。同步 run 接纳后，stderr 会先输出一行包含 root/instanceId/runId 的 receipt，方便 agent 工具超时后恢复查询。run/result/cancel 返回的 snapshot 同样带 root，便于 agent 校验目标。领域返回值在成功运行 snapshot 的 `value` 中。长操作可以先 detach：

```sh
pluxel dev run dev/seed.ts --detach
pluxel dev result <run-id>
pluxel dev cancel <run-id>
```

客户端错误保留稳定 `error.code` 和面向人的 `message`，并尽量提供 `error.context.root`、`error.context.instanceId` 和下一步 `error.hint`。root 仅在成功解析目标项目后出现，不会为未知项目猜一个路径。无法确定执行结果时还保留 runId；agent 应据此恢复查询，不能直接重放写操作。多实例错误的 `error.candidates` 只含公开候选信息，选择后用同一 root 与明确 instanceId 重新调用。

例如下面的诊断表示需要先查原运行结果；程序按 code 分支，不匹配 message 或 hint 文本：

```json
{
	"ok": false,
	"error": {
		"code": "outcome_unknown",
		"message": "The operation outcome is unknown.",
		"runId": "run-id",
		"context": { "root": "/workspace/my-host", "instanceId": "instance-id" },
		"hint": "Read the retained result before submitting again."
	}
}
```

```sh
pluxel dev result run-id --root /workspace/my-host --instance instance-id
```

退出码 0 表示成功完成或 detach 已接纳；1 表示失败/取消/客户端错误；2 表示仍未结束。`result` 读取当前状态，不能把 `cancelling` 当成 `cancelled`。断线不自动重试，不自动取消已经接纳的操作。多个实例时，恢复查询带原 instanceId。

默认时限 30 秒，可用 `--timeout` 请求 1 至 300000 毫秒；时限包含排队。超时发出协作取消信号，尚未 settle 的脚本不会提前让出执行位置。CPU 死循环仍会阻塞同进程 dev；执行器不会为强制停止单个脚本而杀掉整个宿主。

每个 host 串行执行脚本，最多排队 16 个。一段脚本不是全局事务，HMR、浏览器和后台任务仍能交错。已提交的插件操作、配置和数据不会自动回滚。请 await 所有 driver/RPC 操作，并对自建 timer、文件等资源使用 using、try/finally 和 run.signal。取消会立即关闭新 driver 操作的入口，并把 signal 传给 commands、HTTP 和日志等待；已经接纳的配置或生命周期操作会继续排空，不承诺强制中断。

仅返回 JSON 投影：对象 undefined 字段省略，数组 undefined 和顶层无返回值编码为 null。函数、BigInt、非有限数字、循环引用、accessor、class instance 和 RPC capability 会明确失败；不自动调用 toJSON。输入/输出最多 1 MiB，另有 64 层/100000 节点限制。编码失败也可能发生在业务写入之后，不应直接重跑。

完成结果保留最多 100 个、总计 16 MiB，过期返回 `result_expired`。同一宿主保留请求去重记录，最多接纳 100000 次；相同请求 ID 不重复执行。进程消失或通信结果不确定时，CLI 报 `outcome_unknown`，不要把它理解为操作未发生。

## 执行边界

控制台只通过当前用户私有的 Unix socket 与项目 discovery 文件通信，不在公共 Vite HTTP listener 上提供 eval 路由。它运行的是受信任的项目代码，权限等于 dev 宿主，不是恶意代码沙箱。

脚本与辅助模块走当前 Vite 编译、解析和模块身份规则。已知依赖刚修改时，执行会等待 Vite 观察变更并完成更新；控制台不会再制造一次热更新。禁用或忽略这些文件的 watcher 可能使执行等待至超时。首次加载保证当前已提交宿主与已观察更新，不承诺发现所有尚未观察的磁盘修改。提交后入口文件改变会报告 `source_changed`，依赖使用执行时模块图，不承诺整棵文件系统 snapshot。

首版每宿主最多跟踪 128 个脚本入口，每个最多 4096 个本地依赖文件，源码文件最多 1 MiB。优先复用少数诊断文件和 named exports。完整宿主替换会取消旧 run 并撤回其 driver；后续提交连接当前 host epoch。
