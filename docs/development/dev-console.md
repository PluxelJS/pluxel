---
title: 在线开发控制台
description: 让 coding agent 通过当前 Vite 执行 TypeScript，检查插件、修改配置、调用 Workbench API 并读取真实日志。
---

开发控制台让你保持 dev 运行，随时用 TypeScript 操作当前插件和数据。Coding agent 使用 CLI 提交脚本，代码在当前 Vite SSR 模块图和同一个 Node 宿主中执行；不用重启 dev 或创建测试宿主。

适合检查当前状态、填入测试数据、修改配置和验证真实调用。隔离的行为回归继续使用 [test host](./testing.md)。修改会作用于眼前这份应用；已经保存的配置和数据不会随脚本结束自动还原。

## 开启与发现

先检查项目是否已有开启控制台的 Vite 进程。已有时直接发现实例；尚未配置时，在现有 Vite route 上显式开启：

```ts no-twoslash
import { defineConfig } from 'vite'
import { host } from '@pluxel/host-dev/vite'

export default defineConfig({
	plugins: [
		host({
			entry: './src/app.ts',
			devConsole: true,
		}),
	],
})
```

启动项目原有的 Vite dev 命令，然后运行：

```sh
pnpm exec pluxel dev instances --root /absolute/project-root
```

从返回结果确认 `root`、`pid` 和 `instanceId`。下面的 `/absolute/project-root` 与 `INSTANCE_ID` 必须替换为这次发现的值；脚本路径从当前终端目录解析。先创建“写一个可以反复运行的操作”中的 `dev/inspect.ts`，再运行它。

控制台属于 `@pluxel/host-dev`，没有安装官方服务也可以操作插件和基础配置。官方组合 `@pluxel/services/vite` 的 `vitePreset()` 接受同样的 `devConsole: true`。脚本通过 `dev.ctx` 借用当前 RootContext，自行 import 所需服务的 token 或 API；开启控制台不安装服务，也不配置日志 backend。

省略 `devConsole` 不安装控制台。Vite integration 只在 serve 时安装。当前执行服务支持 Linux/macOS 等具有 Unix socket 文件权限的系统，Windows 尚不支持。

CLI 默认从命令当前目录向上找到最近的 `package.json`，只查询该目录的控制台；以命令工作目录为准，不以脚本路径为准。该项目没有运行中的控制台就报告 `dev_unavailable`，不会继续寻找父项目或其他项目的服务。

从 monorepo 顶层操作子项目，或 Vite root 与最近的 package 目录不同时，显式指定 `--root projects/my-host`。同一 root 只有一个运行实例时自动选择；有多个时报告 `ambiguous_instance`，必须用 `--instance <instanceId>` 选择。`--instance` 只在选定 root 内匹配，不进行全局搜索。它不会猜最近启动的实例，也不会替你启动另一个 dev。

dev 命令会在连接前拒绝未知选项；例如拼错 `--instance` 会返回 `invalid_input`，不会因此退回自动选择。`instances` 只按 root 列出候选，`--instance` 用于后续 `run/result/cancel`。

入口文件必须在所选 Vite root 内，不能放在 `.pluxel`、`.git` 或 `node_modules`。脚本依赖按原有 Vite 规则解析，可以 import 已允许的工作区源码。相对 CLI 文件路径从命令当前目录解析，`--root` 只选择宿主。

## 写一个可以反复运行的操作

下面以 starter 的 `TodoPlugin` 为例。在所选 Vite root 内创建 `dev/inspect.ts`；其他项目替换为自己的包名和业务方法。成功结果应包含插件状态和当前 Todo 快照：

```ts no-twoslash
// dev/inspect.ts
import { defineDevConsole } from '@pluxel/host-dev/console'
import { TodoPlugin } from '@example/todo-plugin'

export default defineDevConsole(async (dev) => {
	return {
		status: await dev.plugins.status(TodoPlugin),
		todos: dev.plugins.require(TodoPlugin).snapshot(),
	}
})
```

需要写入数据时，在同一文件增加下面的 named export（合并已有 import）：

```ts no-twoslash
import { defineDevConsole } from '@pluxel/host-dev/console'
import { TodoPlugin } from '@example/todo-plugin'

export const add = defineDevConsole(async (dev) => {
	if (typeof dev.input !== 'string') throw new TypeError('Expected a todo title')
	const result = dev.plugins.require(TodoPlugin).add(dev.input)
	return result
})
```

```sh
pnpm exec pluxel dev run dev/inspect.ts --root /absolute/project-root --instance INSTANCE_ID
pnpm exec pluxel dev run dev/inspect.ts --export add --input '"Verify current data"' --root /absolute/project-root --instance INSTANCE_ID
```

默认调用 default export；`--export` 选择具名函数。`--input` 是 JSON，较大输入可以用互斥的 `--input-file`；省略时 `dev.input` 为 `undefined`。`dev` 同时提供本次执行的 `id` 和 `signal`。跨进程的 input 类型始终是 unknown，需要脚本校验。

`defineDevConsole()` 推导回调参数与返回类型，只定义操作，不会在模块加载时执行。同步、异步或无返回值函数均可使用。

修改文件、增加 export、换文件、传入新参数都不需要重启。每次提交调用当前导出函数；模块顶层不是每次运行的入口，不要把写数据放在那里。HMR 更新代码，但不会自动重放脚本。

每次重新取得当前实例。`require()` 不自动启动插件，也不把旧 constructor 转成新 implementation；旧 target 会报告 `stale_target`。普通实例方法没有额外的可撤销代理，跨 await 后可能已经过期；需要 generation admission 的调用优先使用 commands、Workbench 或已有 database handle。

## Coding agent 工作流程

需要查看或修改**当前运行中的应用**时，coding agent 必须使用这套控制台。配置编辑、Workbench RPC 填数据、调用 Plugin 方法、启停插件和查看日志都在现有 dev 实例上完成；需要隔离环境和可重复断言时使用 test host。

1. 从项目的 Vite 配置或启动命令确定 root，用 `pluxel dev instances --root <project-root>` 发现实例。核对返回的 `root`、`pid` 和 `instanceId`，将选中的绝对 root 与 instanceId 记入任务上下文。
2. 后续 `run/result/cancel` 都显式传相同的 `--root` 和 `--instance`，避免切换工作目录或新增 dev 实例后改变操作目标。没有发现服务时先核对 root、原 dev 进程和 `devConsole` 配置。
3. 在该 root 内维护少数普通 TypeScript 操作文件，通过 default/named export 追加操作。先读取插件状态、当前配置或服务公开的 layout，再按项目实际类型修改；参数经 `dev.input` 传入并校验，跨次保存业务 ID 和 JSON 游标。
4. 检查外层请求是否成功、run 的 `state`，再检查脚本返回的领域 `ok`、apply report 和配置 `application`。修改后重新读取目标状态及相关日志；CLI 退出成功不等于配置已应用或插件已启动。
5. 保留 receipt 中的 root、instanceId 和 runId。工具超时或终端断开后，用这些字段查询 `result`；先确定已发生的操作，再决定下一次提交。已验证的行为需要回归保护时，另写隔离测试。

本仓库的 `projects/plugin-host` 已开启控制台，并提供只读的 `dev/inspect.ts`。仓库根目录的 `pnpm pluxel` 脚本调用本地 CLI，保留当前目录作为相对路径基准。保持该项目原有 dev 命令运行后，从仓库根目录调用：

```sh
pnpm pluxel dev instances --root projects/plugin-host
pnpm pluxel dev run projects/plugin-host/dev/inspect.ts --root projects/plugin-host --instance <instanceId>
```

安装了 `@pluxel/cli` 的用户项目仍使用 `pnpm exec pluxel`，替换 root 和脚本路径即可。跨工作目录调用时使用绝对路径；`--root` 选择运行宿主，不改变脚本路径的解析基准。

## 先发现，再修改

`await dev.plugins.list()` 返回当前 Host 的插件状态和稳定 PluginNodeAddress。`status/start/stop/restart` 与配置操作接受地址或 Plugin constructor；`require()` 接受具体 constructor 或 `{ plugin: ConnectorPlugin, forkId: 'east' }`，返回精确类型的运行实例。typed target 不会创建 fork，也不自动启动插件。

```ts no-twoslash
await dev.plugins.stop(TodoPlugin)
await dev.plugins.start(TodoPlugin)
return { current: await dev.plugins.status(TodoPlugin) }
```

生命周期操作返回可直接传回 CLI 的 `PluginApplyReportSnapshot`，其中插件身份是稳定地址，保留实际生命周期问题、错误与阻塞关系。检查报告中的实际状态与问题，再重新读取目标状态。`plugins.isRunning()` 同步查询当前运行状态。控制台不注册临时 catalog，也不把领域失败转换成测试断言；CLI 成功执行不表示插件一定启动成功。

`await dev.updates.latest()` 返回最近一次应用更新，包括尚未进入插件目录的新入口加载错误。结合 `plugins.list()` 的节点状态与相关日志判断候选被拒绝、旧版本保留或提交后的启动失败；没有已记录更新时返回 `null`。

## 编辑配置

先读当前值，再验证或修改：

```ts no-twoslash
export const inspectConfig = defineDevConsole(async (dev) => {
	return {
		current: await dev.config.get(TodoPlugin),
	}
})

export const increaseLimit = defineDevConsole(async (dev) => {
	const patch = { maxItems: 100 }
	const checked = await dev.config.validate(TodoPlugin, patch)
	if (!checked.ok) return checked
	const applied = await dev.config.patch(TodoPlugin, patch)
	return {
		result: applied,
		current: await dev.config.get(TodoPlugin),
	}
})
```

`get()` 返回保存的配置、默认值和 desired/applied revision。四个配置方法直接返回 Host 的 `HostPluginConfigResult`，先检查 `ok`，再读取成功值。保存结果的 `report` 已投影为稳定地址，可直接返回整个结果；仍应检查 `application` 和 `applyFailure`，保存成功不等于运行实例已采用新配置。

`patch()` 是已有配置契约的浅合并；修改嵌套字段前先读取当前对象，明确提供需要保留的字段。`reset(target, keys)` 清除指定顶层保存值；省略或空 keys 清除全部保存值。

修改始终经过真实 validation、persistence 和 notification。检查返回的 `application`：`applied`、`deferred`、`saved-not-applied` 含义不同。validate 不保存，但它与之后的 patch 不是一个原子操作；patch 会重新验证。需要 restart 的 Plugin 应显式 restart，而不是直接写 config 私有字段。

## 访问已安装服务

脚本所在应用声明所需包依赖；`host-dev` 不引用这些包，也不提供服务代理。all/root 能力统一使用 `dev.ctx.require(Token)`。owner-only 能力仍必须通过实际插件 Context 使用，不能用 root 代替插件 owner。

```ts no-twoslash
import { defineDevConsole } from '@pluxel/host-dev/console'
import { HttpServer } from '@pluxel/services/http'

export default defineDevConsole(async (dev) => {
	const http = dev.ctx.require(HttpServer)
	const response = await http.fetch(new Request('http://local.dev/health', { signal: dev.signal }))
	return { status: response.status, body: await response.text() }
})
```

这个请求使用当前进程内 HTTP directory，逻辑 origin 不是物理监听地址。应用必须已安装 HTTP 服务；服务缺失按能力解析契约报错，不影响其他控制台操作。

Commands、Workbench RPC 和日志查询同样调用各包现有 API，参见 [Commands](../runtime/commands.md)、[Workbench](../workbench/index.md) 和 [结构化日志](../runtime/logging.md)。Workbench 的 principal、session 和 RPC 结果释放遵循其原有契约；控制台不会替脚本创建或回收这些资源。Plugin 公开的业务方法也可直接通过 `dev.plugins.require()` 调用。数据库访问使用业务方法或插件公开的 owner-bound handle，不重新打开应用的数据目录。

`this.ctx.logger` 是 Core 基础能力，插件无需 import Logging 包；脚本也能使用 `dev.ctx.logger`。输出、过滤和日志存储由宿主的 logging 配置决定。需要查询存储时显式使用 `@pluxel/logging` 的 `Logging` 能力和 store API；控制台不自动增加 store，也不在执行结果里附加日志游标。读取日志时保留存储本身的 epoch、retention 和 gap 语义，返回有界的普通数据。

`dev.ctx` 只借用本次执行的 Host。不要跨执行或 Host replacement 缓存 Context、Plugin、服务 handle 或 RPC session。直接服务调用不会自动绑定取消；传入 `dev.signal`，await 所有调用，并用 `using` 或 `try/finally` 释放脚本创建的资源。

## 结果、取消和恢复

命令执行结果在 stdout 输出单一 JSON envelope。帮助输出和参数解析失败遵循普通 CLI 输出规则，agent 还需检查退出码与 stderr。同步 run 接纳后，stderr 会先输出一行包含 root/instanceId/runId 的 receipt，方便 agent 工具超时后恢复查询。run/result/cancel 返回的 snapshot 同样带 root，便于 agent 校验目标。领域返回值在成功运行 snapshot 的 `value` 中。长操作可以先 detach：

```sh
pnpm exec pluxel dev run dev/seed.ts --detach --root /absolute/project-root --instance INSTANCE_ID
pnpm exec pluxel dev result RUN_ID --root /absolute/project-root --instance INSTANCE_ID
pnpm exec pluxel dev cancel RUN_ID --root /absolute/project-root --instance INSTANCE_ID
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

每个 host 串行执行脚本，最多排队 16 个。一段脚本不是全局事务，HMR、浏览器和后台任务仍能交错。已提交的插件操作、配置和数据不会自动回滚。请 await 所有 driver/RPC 操作，并对自建 timer、文件等资源使用 using、try/finally 和 dev.signal。取消会立即关闭新的控制台操作入口；已经接纳的配置或生命周期操作会继续排空。直接调用的服务需要脚本显式传入 `dev.signal`，不承诺强制中断或自动回收。

仅返回 JSON 投影：对象 undefined 字段省略，数组 undefined 和顶层无返回值编码为 null。函数、BigInt、非有限数字、循环引用、accessor、class instance 和 RPC capability 会明确失败；不自动调用 toJSON。输入/输出最多 1 MiB，另有 64 层/100000 节点限制。编码失败也可能发生在业务写入之后，不应直接重跑。

完成结果保留最多 100 个、总计 16 MiB，过期返回 `result_expired`。同一宿主保留请求去重记录，最多接纳 100000 次；相同请求 ID 不重复执行。进程消失或通信结果不确定时，CLI 报 `outcome_unknown`，不要把它理解为操作未发生。

## 执行边界

控制台只通过当前用户私有的 Unix socket 与项目 discovery 文件通信，不在公共 Vite HTTP listener 上提供 eval 路由。它运行的是受信任的项目代码，权限等于 dev 宿主，不是恶意代码沙箱。

脚本与辅助模块走当前 Vite 编译、解析和模块身份规则。已知依赖刚修改时，执行会等待 Vite 观察变更并完成更新；控制台不会再制造一次热更新。禁用或忽略这些文件的 watcher 可能使执行等待至超时。首次加载保证当前已提交宿主与已观察更新，不承诺发现所有尚未观察的磁盘修改。提交后入口文件改变会报告 `source_changed`，依赖使用执行时模块图，不承诺整棵文件系统 snapshot。

首版每宿主最多跟踪 128 个脚本入口，每个最多 4096 个本地依赖文件，源码文件最多 1 MiB。优先复用少数诊断文件和 named exports。完整宿主替换会取消旧 run 并撤回其 driver；后续提交连接当前 host epoch。

开发集成需要注入进程内依赖时，`host({ entry, bindings })` 与 `vitePreset({ entry, bindings })` 接受普通对象，并在创建集成时浅复制、冻结为 `startup.bindings`，供应用的 `configure/prepare` 使用。省略时是冻结的空对象；对象中的资源仍由注入方拥有，不随控制台执行释放。
