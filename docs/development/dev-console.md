---
title: 在线开发控制台
description: 让 coding agent 通过当前 Vite 执行 TypeScript，检查插件、修改配置、调用 Workbench API 并读取真实日志。
---

开发控制台让你保持 dev 运行，随时用 TypeScript 操作当前插件和数据。Coding agent 使用 CLI 提交脚本，代码在 Host 专用的 `pluxel` Vite environment 和同一个 Node 宿主中执行；不用重启 dev 或创建测试宿主。

适合检查当前状态、填入测试数据、修改配置和验证真实调用。隔离的行为回归继续使用 [test host](../plugin-development/testing.md)。修改会作用于眼前这份应用；已经保存的配置和数据不会随脚本结束自动还原。

还不清楚插件、Part 或 config schema 在哪里声明时，先用[源码查询](./inspection.md)定位；它不需要运行 Vite，也不读取当前 Host 状态。

官方工作区由 [Pitchfork](./workspace-toolchain.md#管理开发服务)管理服务进程，普通 Vite 项目也可以使用前台命令。开发控制台不依赖 Pitchfork：它连接选定 Vite root 下的现有实例。应用业务日志和操作通过控制台执行；进程 running、代理启动页和 HTTP 响应不能代替应用状态与业务结果。

## 项目入口与启动方式

`package.json` 的 `pluxel.dev` 直接按名称声明开发 profile。普通 Vite 项目：

```json
{
	"pluxel": {
		"dev": {
			"app": { "command": "vp dev" }
		}
	}
}
```

每个 profile 的 `root` 默认是声明配置的 package 目录；Vite root 不同才填写相对此目录的路径。`command` 在声明配置的目录执行，必须保持前台运行；不要填入会立即退出的后台启动器，也不要回调 `pluxel dev` 自身。首次启动直接保留 Vite 终端输出，Ctrl+C 结束前台进程。再次执行时复用归属当前 profile 的唯一实例并重新显示地址，不重复启动。

官方应用模板同时提供默认 Pitchfork 服务与前台调试入口：

```json
{
	"pluxel": {
		"dev": {
			"default": "app",
			"app": { "root": "host/web", "pitchfork": "app" },
			"local": { "root": "host/web", "command": "vp run @example/host#dev:server" }
		}
	}
}
```

`vp run dev` 使用默认 `app`，`vp run dev:local` 显式使用 `local`。它们是同一应用的两种启动方式，共用 Vite root 和默认数据目录；profile 只区分控制台归属，不隔离数据。使用同一份数据时，先 `pitchfork stop app` 再运行 `vp run dev:local`；需要并行运行时，为进程显式设置不同的 `PLUXEL_DATA_ROOT`。控制台操作前台实例时也使用 `--profile local`。

每个 profile 必须在 `command` 与 `pitchfork` 中选择一个。`pitchfork` 是 `pitchfork.toml` 中的短服务名。框架仓库默认选择 `plugin-host`，其 root 为 `projects/plugin-host`，服务名为 `plugin-host`。CLI 委托 Pitchfork 启动或复用，再核对完整服务 ID 与控制台的 `serviceId`，显示该服务的实时地址。启动命令返回后服务继续运行；停止、重启和进程日志使用原生 `pitchfork stop/restart/logs <完整服务ID>`。Pluxel 不自行创建后台 supervisor。

一个 package 可以声明多个 profile，使用不同目录，也可以使用同一个 Vite root；各 profile 独立选择前台命令或 Pitchfork。选择顺序是 **显式 `--profile` → `pluxel.dev.default` → 唯一 profile**；仍不能确定时才要求指定名称。`default` 是保留字段，值必须指向已声明的 profile，不是另一个 profile 或启动命令。

文档站等没有 Pluxel Host 的服务可显式声明 `console: false`，目前只支持 Pitchfork。例如本仓库：

```json
{
	"pluxel": {
		"dev": {
			"default": "plugin-host",
			"plugin-host": { "root": "projects/plugin-host", "pitchfork": "plugin-host" },
			"docs": { "root": "projects/docs", "pitchfork": "docs", "console": false }
		}
	}
}
```

`vp run docs` 执行 `pluxel dev --profile docs`：等待 Pitchfork 就绪，再读取最新服务状态与公开 URL，重复执行也显示当前信息，不生成 Workbench 或应用控制台状态。`pluxel dev status --profile docs` 查询 Pitchfork 状态；该 profile 的 `run`、`instances` 与 `--instance` 不受支持，会在启动或连接前报告 `unsupported_console`。应用模板没有文档站，因此只生成实际存在的 `app` / `local`。

`root` 必须位于声明配置的目录内，它是 Vite 根目录，不是应用声明目录：模板的应用声明在 `host`，Vite root 在 `host/web`。CLI 从当前目录向上寻找最近声明 `pluxel.dev` 的 package.json，止于最近 Git / pnpm workspace 边界；跨目录用 `--root /absolute/project` 改变配置发现起点。`--root` 不绕过找到的 profile 配置，也不改变脚本路径相对终端当前目录的基准。

```sh
# 使用默认 profile（或项目唯一的 profile）
vp exec pluxel dev
vp exec pluxel dev status
vp exec pluxel dev run host/web/dev/inspect.ts
# 切换 profile：启动和后续操作使用同一个名称
vp exec pluxel dev --profile app
vp exec pluxel dev status --profile app
vp exec pluxel dev run /absolute/project/host/web/dev/inspect.ts --root /absolute/project --profile app
```

profile 的 `console` 默认 `true`，要求 Vite 开启 `devConsole`。此时 `dev status` 查看应用状态，`dev instances` 列出匹配 profile 的实例。**控制台 profile 的 status、instances、run 不调用 Pitchfork；所有 status/instances/run 都不自动启动服务**。CLI 先按 Vite root 与启动归属筛选，再选择实例：

- 前台命令由 CLI 自动传入 `PLUXEL_DEV_PROJECT` 与 `PLUXEL_DEV_PROFILE`，无需项目手动配置。控制台按声明配置的 package 真实目录、profile 名和 Vite root 核对归属；其他 package 的同名 profile、相同目录的其他 profile 或手动 Vite 不会被误选。
- Pitchfork profile 按控制台捕获的 `serviceId` 核对短服务名；启动时额外核对 Pitchfork 返回的完整服务 ID。代理按访问启动也保留原生服务身份。
- 筛选后只有一个实例时自动选中；多个时使用 `--instance` 明确选择。同 root、同短服务名但不同 namespace 仍可能有多个候选。`--instance` 只能在当前 profile 的候选中选择，不能越过归属检查。

profile 表达项目的启动方式及运行归属，`instanceId` 标识其中一次运行；不需要单独登记实例。没有 `pluxel.dev` 配置时，控制台可以按 root 连接手动启动的 Vite，见下节。

启动后的地址与重复调用的地址共用 Vite 的展示逻辑，不重放日志或猜 Workbench 路径。控制台 profile 需要 `devConsole: true`，模板已经配置。`dev instances` 的 `urlOutput` 是 Vite 的当前展示文本，不作为路由协议解析，也不缓存在实例文件中。启动失败保留启动命令退出码；复用实例或 Pitchfork 启动后检查发现应用更新中时附带提示，应用不可用时返回退出码 2，服务不会因此被停止。

应用模板的 `vp run dev` 直接执行 `pluxel dev`；源码仓库直接执行 `node packages/cli/bin/pluxel.mjs dev`，不重复执行构建任务图。源码 checkout 首次使用前运行 `vp run @pluxel/cli#compile`；后续仅在 launcher 提示 CLI 过期时重建。

## Coding agent 工作流程

1. 读取项目 AGENTS 和 `package.json` 的 `pluxel.dev`；使用 Pitchfork 时再读 `pitchfork.toml`。用 `dev status` 核对 profile、Vite root、实例和应用状态；只有需要运行且尚未运行时才执行 `dev`。
2. 使用同一 profile 提交 `dev run`；该 profile 有多个实例时显式指定 `--instance`。在 Vite root 内维护少数 TypeScript 操作文件；先读插件状态、配置或服务 layout，再按实际类型操作，输入经 `dev.input` 校验。
3. 检查请求、run state、脚本领域返回值和 apply report，修改后再读状态与相关日志。CLI 成功不等于配置已应用或插件已启动。
4. 保存输出的 `receipt`；超时或终端断开后用 `dev result <receipt>` 查询原操作。不要因为应用已重启，就把旧操作重新投递给新实例。需要可重复回归保护时另写隔离测试。

本仓库已有只读脚本，根目录调用：

```sh
vp run pluxel dev status
vp run pluxel dev run projects/plugin-host/dev/inspect.ts
```

下游使用 `vp exec pluxel`。脚本路径始终相对终端当前目录，且文件必须在选定 Vite root 内；跨目录操作可使用绝对脚本路径。

## 开启控制台与直接连接 Vite

在现有 Vite 集成上显式开启；开启控制台不会安装官方服务或配置日志 backend：

```ts no-twoslash
import { defineConfig } from 'vite'
import { host } from '@pluxel/host-vite'

export default defineConfig({
	plugins: [host({ entry: './src/app.ts', devConsole: true })],
})
```

官方 `@pluxel/services/vite` 的 `vitePreset()` 也接受 `devConsole: true`。省略时不安装控制台；控制台只在 serve 时安装。当前支持具有 Unix socket 文件权限的 Linux/macOS，Windows 尚不支持。

`application.state` 为 `ready`、`updating` 或 `unavailable`；`application.latestUpdate` 保留最近一次应用接纳的阶段、结果与诊断。源码求值失败后可修正源文件，由同一进程重新接纳。首次 Host 创建、服务准备或应用准备失败会中止 Vite 启动并释放资源，不输出就绪地址；修复后重新启动。

没有 `pluxel.dev` 声明的普通 Vite 项目也可以连接控制台。不指定 `--root` 时使用最近 package 根目录；显式 `--root` 且向上未发现配置时使用该目录本身：

```sh
vp exec pluxel dev instances --root /absolute/vite-root
vp exec pluxel dev status --root /absolute/vite-root --instance INSTANCE_ID
vp exec pluxel dev run /absolute/vite-root/dev/inspect.ts --root /absolute/vite-root --instance INSTANCE_ID
```

若发现 profile 配置，上述命令仍按显式 `--profile`、default、唯一 profile 的顺序选择并筛选。没有配置却指定 `--profile` 会报错，不忽略这个选择。多个候选时 `run` 报 `ambiguous_instance`，先从 `instances` 选择准确 ID。实际实例发现只在选定 Vite root 的 realpath 下进行，不向其他项目回退。重启后重新发现当前实例，旧操作的 receipt 仍只指向旧实例。

命令在连接前拒绝未知选项。入口文件不能放在 `.pluxel`、`.git` 或 `node_modules`，依赖按原有 Vite 规则解析；指定 root 或 profile 都不改变 CLI 文件路径相对终端当前目录的解析基准。

## 写一个可以反复运行的操作

下面以 starter 的 `TodoPlugin` 为例。在所选 Vite root 内创建 `dev/inspect.ts`；其他项目替换为自己的包名和业务方法。成功结果应包含插件状态和当前 Todo 快照：

```ts no-twoslash
// dev/inspect.ts
import { defineDevConsole } from '@pluxel/host-vite/console'
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
import { defineDevConsole } from '@pluxel/host-vite/console'
import { TodoPlugin } from '@example/todo-plugin'

export const add = defineDevConsole(async (dev) => {
	if (typeof dev.input !== 'string') throw new TypeError('Expected a todo title')
	const result = dev.plugins.require(TodoPlugin).add(dev.input)
	return result
})
```

```sh
vp exec pluxel dev run host/web/dev/inspect.ts
vp exec pluxel dev run host/web/dev/inspect.ts --export add --input '"Verify current data"'
```

默认调用 default export；`--export` 选择具名函数。`--input` 是 JSON，较大输入可以用互斥的 `--input-file`；省略时 `dev.input` 为 `undefined`。`dev` 同时提供本次执行的 `id` 和 `signal`。跨进程的 input 类型始终是 unknown，需要脚本校验。

`defineDevConsole()` 推导回调参数与返回类型，只定义操作，不会在模块加载时执行。同步、异步或无返回值函数均可使用。

修改文件、增加 export、换文件、传入新参数都不需要重启。每次提交调用当前导出函数；模块顶层不是每次运行的入口，不要把写数据放在那里。HMR 更新代码，但不会自动重放脚本。

每次重新取得当前实例。`require()` 不自动启动插件，也不把旧 constructor 转成新 implementation；旧 target 会报告 `stale_target`。普通实例方法没有额外的可撤销代理，跨 await 后可能已经过期；需要 generation admission 的调用优先使用 commands、Workbench 或已有 database handle。

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

脚本所在应用声明所需包依赖；`host-vite` 不引用这些包，也不提供服务代理。all/root 能力统一使用 `dev.ctx.require(Token)`。owner-only 能力仍必须通过实际插件 Context 使用，不能用 root 代替插件 owner。

```ts no-twoslash
import { defineDevConsole } from '@pluxel/host-vite/console'

export default defineDevConsole(async (dev) => {
	const input = dev.input
	if (
		typeof input !== 'object' ||
		input === null ||
		!('origin' in input) ||
		typeof input.origin !== 'string'
	) {
		throw new TypeError('input.origin must be an HTTP(S) application URL')
	}
	const origin = new URL(input.origin)
	if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
		throw new TypeError('input.origin must use HTTP(S)')
	}
	const response = await fetch(new URL('/health', origin), { signal: dev.signal })
	return { status: response.status, body: await response.text() }
})
```

通过 `--input '{"origin":"http://localhost:5173"}'` 指定已发现的应用监听地址；请求经过真实监听器。不要猜测端口，也不要借用内部 dispatcher 绕过实际 ingress。

Commands、Workbench RPC 和日志查询同样调用各包现有 API，参见 [Commands](../plugin-development/commands.md)、[Workbench](../workbench/index.md) 和 [结构化日志](../plugin-development/logging.md)。Workbench 的 principal、session 和 RPC 结果释放遵循其原有契约；控制台不会替脚本创建或回收这些资源。Plugin 公开的业务方法也可直接通过 `dev.plugins.require()` 调用。数据库访问使用业务方法或插件公开的 owner-bound handle，不重新打开应用的数据目录。

需要调用已发布的 Workbench View 时，使用其真实 descriptor 推导 RPC 类型，无需手写代理接口：

```ts no-twoslash
import { defineDevConsole } from '@pluxel/host-vite/console'
import { pluginNodeAddressOf } from '@pluxel/core'
import { openLocalWorkbenchEntry } from '@pluxel/workbench/server'
import { consumeWorkbenchValue } from '@pluxel/workbench/client'
import { ExamplePlugin, ExampleWorkbench } from './example-plugin'
import { developmentPrincipal } from './development-principal'

export const inspectWorkbench = defineDevConsole(async (dev) => {
	using opened = await openLocalWorkbenchEntry(dev.ctx, {
		target: pluginNodeAddressOf(ExamplePlugin),
		entry: ExampleWorkbench.overview,
		principal: developmentPrincipal,
		signal: dev.signal,
	})
	return await consumeWorkbenchValue(opened.api.inspectDto(), 'Overview inspection')
})
```

将 `ExamplePlugin`、`ExampleWorkbench.overview` 和 `inspectDto()` 替换为项目实际已发布的 View 与业务方法。`developmentPrincipal` 由项目显式定义，满足 `{ provider: string, subject: string, displayName?: string }`；它是本次调用的身份声明，不是控制台自动授予的管理员身份。

`using` 在脚本离开作用域时关闭打开的 entry 与其本地 session，传入 `dev.signal` 还会在取消时释放这些资源。`consumeWorkbenchValue` 接管并验证 RPC 返回的普通数据，原地深冻结后移除并释放顶层 transport 资源；不能直接将 RPC stub 或 opened handle 返回 CLI。取消不会撤销已经接纳的业务变更，仍应检查返回的领域结果。

`this.ctx.logger` 是 Core 基础能力，插件无需 import Logging 包；脚本也能使用 `dev.ctx.logger`。输出、过滤和日志存储由宿主的 logging 配置决定。需要查询存储时显式使用 `@pluxel/services/logging` 的 `Logging` 能力和 store API；控制台不自动增加 store，也不在执行结果里附加日志游标。读取日志时保留存储本身的 epoch、retention 和 gap 语义，返回有界的普通数据。

日志可以在业务操作前标记位置，随后读取或等待相关记录：

```ts no-twoslash
import { defineDevConsole } from '@pluxel/host-vite/console'
import { Logging, markLogs, readLogs } from '@pluxel/services/logging'
import { TodoPlugin } from '@example/todo-plugin'

export const restartWithLogs = defineDevConsole(async (dev) => {
	const logging = dev.ctx.require(Logging)
	const cursor = markLogs(logging)
	const report = await dev.plugins.restart(TodoPlugin)
	return { report, logs: readLogs(logging, cursor, { limit: 100 }) }
})
```

`markLogs` 会先 flush 已缓冲日志，首次访问尚无记录的已配置 stream 时创建空存储，不增加 sink 或修改路由；未配置的 stream 报错。默认 stream 是 `default`。返回的 JSON cursor 可保留并用于下一次操作；`readLogs` 返回下一 cursor，可分页继续读。`root_mismatch`、`stream_replaced`、`epoch_mismatch` 和 `from_too_old` 明确表示宿主更换、stream 更换、reset 和 retention 缺口，不能自动忽略。跨进程输入仍需按 `LogCursor` 字段校验。

等待后续记录用 `await waitForLogs(logging, cursor, { filter, limit: 100, signal: dev.signal })`，从 `@pluxel/services/logging` 导入。它返回首批匹配记录或 cursor 失效结果，取消时以 signal 的 reason 拒绝并撤销订阅。等待不改变日志过滤与缓冲配置；没有匹配输出时持续到 signal 取消。

`dev.ctx` 只借用本次执行的 Host。不要跨执行或 Host replacement 缓存 Context、Plugin、服务 handle 或 RPC session。直接服务调用不会自动绑定取消；传入 `dev.signal`，await 所有调用，并用 `using` 或 `try/finally` 释放脚本创建的资源。

## 结果、取消和恢复

操作命令在 stdout 输出单一 JSON envelope；帮助和参数解析失败遵循普通 CLI 输出规则，同时检查退出码与 stderr。同步 run 接纳后，stderr 先输出包含 `receipt` 的接纳信息；run/result/cancel 输出同样保留 receipt 与 root/instanceId/runId 诊断。领域返回值在成功运行 snapshot 的 `value` 中。长操作可以先 detach：

```sh
vp exec pluxel dev run host/web/dev/seed.ts --detach
vp exec pluxel dev result RECEIPT
vp exec pluxel dev cancel RECEIPT
```

将 `RECEIPT` 换成输出的 `receipt` 字符串，原样保存和传回。它绑定原 root、instanceId、runId 和 serviceId，不包含 socket nonce，也不授予额外权限。`result/cancel` 不接受 profile、root 或 instance 参数，不会随当前目录或项目配置变化而改变对象。原进程不存在时明确失败；即使同名服务已经重启，也不会转投新实例或重新执行。

客户端错误保留稳定 `error.code` 和面向人的 `message`，并尽量提供目标 context 与恢复 hint。无法确定结果时保留原操作 receipt；先查询已接纳的操作，不能直接重放写操作。raw `runId` 只用于诊断，不能代替 receipt。程序按 code 分支，不匹配 message 或 hint 文本。

| 观察结果                  | 含义与下一步                                          |
| ------------------------- | ----------------------------------------------------- |
| 退出码 `0`                | 已完成或 detach 已接纳；继续检查 run state 和领域结果 |
| 退出码 `1`                | 失败、取消或客户端错误；按结构化 `code` 处理          |
| 退出码 `2` / `cancelling` | 尚未结束；使用原 receipt 查询                         |
| `outcome_unknown`         | 无法确认是否已写入；先查询原结果，不能直接重放        |
| `result_expired`          | 保留结果已过期；从领域状态和日志核对实际结果          |

断线不自动重试或取消已接纳的操作。取消后的最终状态为 `cancelled`，`error` 保留取消原因；并发发生的执行或释放异常保存在 `executionError`。普通业务 `AggregateError` 不被拆成执行/清理两阶段；诊断在预算内保留子错误和 `using` 的 `SuppressedError`。

默认时限 30 秒，可用 `--timeout` 请求 1 至 300000 毫秒；时限包含排队。超时发出协作取消信号，尚未 settle 的脚本不会提前让出执行位置。CPU 死循环仍会阻塞同进程 dev；执行器不会为强制停止单个脚本而杀掉整个宿主。

每个 host 串行执行脚本，最多排队 16 个。一段脚本不是全局事务，HMR、浏览器和后台任务仍能交错。已提交的插件操作、配置和数据不会自动回滚。请 await 所有 driver/RPC 操作，并对自建 timer、文件等资源使用 using、try/finally 和 dev.signal。取消会立即关闭新的控制台操作入口；已经接纳的配置或生命周期操作会继续排空。直接调用的服务需要脚本显式传入 `dev.signal`，不承诺强制中断或自动回收。

仅返回 JSON 投影：对象 undefined 字段省略，数组 undefined 和顶层无返回值编码为 null。函数、BigInt、非有限数字、循环引用、accessor、class instance 和 RPC capability 会明确失败；不自动调用 toJSON。输入/输出最多 1 MiB，另有 64 层/100000 节点限制。编码失败也可能发生在业务写入之后，不应直接重跑。

完成结果保留最多 100 个、总计 16 MiB，过期返回 `result_expired`。同一宿主保留请求去重记录，最多接纳 100000 次；相同请求 ID 不重复执行。进程消失或通信结果不确定时，CLI 报 `outcome_unknown`，不要把它理解为操作未发生。

## 执行边界

控制台只通过当前用户私有的 Unix socket 与项目 discovery 文件通信，不在公共 Vite HTTP listener 上提供 eval 路由。它运行的是受信任的项目代码，权限等于 dev 宿主，不是恶意代码沙箱。

脚本与辅助模块走当前 Vite 编译、解析和模块身份规则。已知依赖刚修改时，执行会等待 Vite 观察变更并完成更新；控制台不会再制造一次热更新。禁用或忽略这些文件的 watcher 可能使执行等待至超时。首次加载保证当前已提交宿主与已观察更新，不承诺发现所有尚未观察的磁盘修改。提交后入口文件改变会报告 `source_changed`，依赖使用执行时模块图，不承诺整棵文件系统 snapshot。

每宿主最多跟踪 128 个脚本入口，每个最多 4096 个本地依赖文件，源码文件最多 1 MiB。优先复用少数诊断文件和 named exports。完整宿主替换会取消旧 run 并撤回其 driver；后续提交连接当前 host epoch。

开发集成需要注入进程内依赖时，`host({ entry, bindings })` 与 `vitePreset({ entry, bindings })` 接受普通对象，并在创建集成时浅复制、冻结为 `startup.bindings`，供应用的 配置工厂与 `prepare` 使用。省略时是冻结的空对象；对象中的资源仍由注入方拥有，不随控制台执行释放。

## 有界操作日志与等待

`markLogs(logging, streamId?)` 标记已 flush 的末尾；`readLogs(logging, cursor, { limit: 100, filter })` 返回有界记录和下一 cursor。`waitForLogs(logging, cursor, { signal, limit: 100, filter })` 等待首批匹配记录或 cursor 失效，signal 必填，取消与完成都会释放订阅。三者均从 `@pluxel/services/logging` 导入，使用同一 store，不创建控制台专用日志通道。

cursor 是普通 JSON，包含 rootId、streamId、bootId、epoch、nextSeq；不可把不同 Host 或重建 stream 的序号相接。读取保留 `root_mismatch`、`stream_replaced`、`store_unavailable`、`epoch_mismatch`、`from_too_old` 与 `invalid` 的失败分支。mark 可为已配置但尚无记录的 stream 创建空存储，未配置且不存在时抛错。调用示例见 [开发控制台](./dev-console.md)。
