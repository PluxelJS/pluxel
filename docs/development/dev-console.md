---
title: 在线开发控制台
description: 控制现有 Vite 的 HMR 批次，提交 TypeScript 操作，检查应用状态、配置、Workbench 和日志，并恢复原操作结果。
---

开发控制台在**现有 Vite 的同一个 Host** 中执行项目 TypeScript，也可直接控制 Pluxel 源码更新批次。它适合分阶段修改、检查在线状态、修改配置和验证实际调用。写入不会随脚本结束还原；可重复的隔离回归使用 [test host](../plugin-development/testing.md)。还不知道声明位置时先用[源码查询](./inspection.md)。

已有应用从下方工作流程开始；多文件编辑读 [HMR 批次控制](#hmr-批次控制)，设置启动入口读[项目配置](#项目入口与启动方式)，操作超时或断线读[结果恢复](#结果取消和恢复)，日志查询读[有界日志](#有界操作日志与等待)。进程启动失败、编译错误和 stdout/stderr 的排查由[工作区指南](./workspace-toolchain.md#agent-的日志与排障顺序)维护。

## Coding agent 工作流程

1. 读取项目 AGENTS 与 `package.json` 的 `pluxel.dev`，用 `dev status` 确认 profile、Vite root、实例、`hmr` 与 `application.state`。需要运行且尚未运行时才执行 `dev`；status、instances、run、hmr 不自动启动。多个匹配实例时先 `dev instances`，再明确 `--instance`，不挑最近进程。
2. 运行中的应用需要跨文件或连续编辑时，先记录原 `hmr.mode`，用同一目标的 `dev hmr pause` 等待当前批次结算。修改完成并通过相关静态检查后 `dev hmr apply`，检查更新报告。只做只读检查时无需暂停。
3. 在选定 Vite root 内写普通导出函数，用同一目标提交 `dev run`。检查 run state、领域结果、应用/生命周期报告及相关日志；实际应用行为也要验证，CLI 成功不等于业务正确。
4. 更新失败保持暂停，修复后再 apply。成功且待处理变化清空、原模式为 auto 时才 `dev hmr resume`；不在 finally 中无条件恢复，也不替其他任务恢复原本 paused 的实例。保存每次操作的 `receipt`；结果不确定时查询原操作，不直接重放写入。

```sh
# 下游应用：使用配置的默认 profile
vp exec pluxel dev status
vp exec pluxel dev run host/web/dev/inspect.ts
# 前台 local profile 的后续操作也选 local
vp exec pluxel dev status --profile local
```

上述 `vp exec` 在应用项目根运行；源码仓库使用 `vp run pluxel`，已有脚本为 `projects/plugin-host/dev/inspect.ts`。`--root` 只控制 Pluxel 配置查找，不改变 shell 目录、包管理器查找 CLI 或脚本相对路径的基准。跨目录直接使用项目 CLI 与脚本的绝对路径：

```sh
/absolute/project/node_modules/.bin/pluxel dev run /absolute/project/host/web/dev/inspect.ts --root /absolute/project --profile local
```

`application.state` 为 `ready`、`updating` 或 `unavailable`；非 ready 时检查 `application.latestUpdate` 的阶段、结果和诊断。进程 running、代理启动页或 HTTP 成功都不能证明应用已采用修改。源码求值失败后可修正并由原进程接纳；首次 Host/服务/应用准备失败会中止 Vite 启动，修复后重新启动。

## HMR 批次控制

默认 `auto` 模式继续自动更新，同时合并编辑期间积压的文件事件。跨文件修改可在求值、候选构建和生命周期提交之前暂停，将一轮修改显式作为一批应用：

```sh
vp exec pluxel dev status
vp exec pluxel dev hmr pause
# 修改源码，运行本次改动需要的静态检查
vp exec pluxel dev hmr apply
vp exec pluxel dev status
vp exec pluxel dev run host/web/dev/inspect.ts
# 确认更新成功、没有待处理变化且原模式为 auto 后执行
vp exec pluxel dev hmr resume
```

| 命令             | 行为                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `dev hmr pause`  | 立即切到 paused，等待已经执行的批次结算；watcher 继续记录并合并变化                          |
| `dev hmr apply`  | 切到 paused，等待当前批次后应用一批已观察的待处理变化；完成后仍为 paused，没有变化则无需更新 |
| `dev hmr resume` | 等待当前批次后切到 auto，应用一批待处理变化；后续变化继续自动更新，不等待全局空闲            |
| `dev status`     | 同时读取 HMR 调度状态和应用状态，不触发应用                                                  |

`hmr` 命令使用与 `dev run` 相同的 `--root`、`--profile`、`--instance` 选择规则，以及 `--timeout`、`--detach`、receipt 和 [result/cancel](#结果取消和恢复) 协议。它直接调用 Host-vite 的控制通道，不加载操作脚本；应用源码损坏或暂时没有可用 Host 时仍可控制。完整 Host replacement 保留当前 Vite 实例的 HMR 模式；Vite 进程重启后是新实例，重新查询状态，旧 receipt 不转接。

`dev status` 的 `hmr` 包含：

| 字段                                     | 含义                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `mode`                                   | `auto` 或 `paused`，属于整个 Vite 实例                                                         |
| `running`                                | 是否正在执行更新批次；paused 仍可能正在等待旧批次结束                                          |
| `pending.files` / `pending.full`         | 合并的待处理文件数；超过 4096 个不同文件时折叠为完整重新核对请求，`full: true`，不丢弃更新意图 |
| `observedRevision` / `attemptedRevision` | 已观察变化与已尝试批次的 revision；attempted 不代表应用成功                                    |

成功的控制操作在结果 `value` 中返回 `{ hmr, application }`，最近更新仍以 `application.latestUpdate` 为准。检查其中 outcome、phase 和节点 lifecycle issue；操作失败时通过 `dev status` 读取报告，失败批次会保留待处理变化以便显式重试。auto 模式只有新观察到变化才再次尝试，不循环重试同一失败批次。先求值/准备失败可保留旧应用；已经停止旧 generation 后的失败按实际生命周期状态报告，暂停不提供回滚。

每个实例只运行一个更新批次，后续文件变化合并到一份有界集合；重复保存同一路径不会形成等长的执行队列。暂停覆盖 Pluxel 应用、插件来源、失败恢复输入和由这些候选触发的制品更新。文件观察、来源路径校验和 Vite 缓存失效仍可发生；普通浏览器 React/CSS HMR、请求触发的 transform、Vite 配置变更导致的 server restart 不在此范围，已开始的更新也不会被强制中断。不要通过重启服务代替 apply。

apply 使用执行时文件内容，不冻结磁盘，也不承诺发现所有尚未被 watcher 观察的修改。执行期间新观察的变化留给下一批；在报告中看到 pending 时，先确认编辑已完成再 apply。并行 agent 修改同一实例时由一个协调者控制批次；paused 不是每个客户端独占的锁。该调度限制重复更新与积压，不承诺消除应用资源泄漏或单次构建的内存峰值。

暂停且存在待处理的运行时修改时，普通 `dev run` 会以 `hmr_pending` 拒绝加载，不自行应用半成品代码；先通过 status/进程日志检查，再 apply。没有待处理修改时可在 paused 模式执行脚本。HMR 控制取消不回滚模式或已开始的应用，超时/断线后用原 receipt 确认真实结果，不自动重发控制命令。

## 写一个可以反复运行的操作

以 starter 的 `TodoPlugin` 为例，在 `host/web/dev/inspect.ts` 中定义操作：

```ts no-twoslash
import { defineDevConsole } from '@pluxel/host-vite/console'
import { TodoPlugin } from '@example/todo-plugin'

export default defineDevConsole(async (dev) => ({
	status: await dev.plugins.status(TodoPlugin),
	todos: dev.plugins.require(TodoPlugin).snapshot(),
}))

export const add = defineDevConsole(async (dev) => {
	if (typeof dev.input !== 'string') throw new TypeError('Expected a todo title')
	return dev.plugins.require(TodoPlugin).add(dev.input)
})
```

```sh
vp exec pluxel dev run host/web/dev/inspect.ts
vp exec pluxel dev run host/web/dev/inspect.ts --export add --input '"Verify current data"'
```

默认调用 default export；`--export` 选择具名函数。`--input` 与 `--input-file` 互斥，输入类型为 unknown，省略时是 undefined；在函数内校验。`dev.id` / `dev.signal` 属于本次执行。`defineDevConsole()` 只提供类型推导，支持同步、异步和无返回值函数，不在模块加载时执行。

修改脚本、增加 export 或换输入都不需要重启。**副作用写在导出函数内**：模块顶层不保证每次运行，HMR 不会自动重放操作。入口不能位于 `.pluxel`、`.git` 或 `node_modules`，返回值必须是[有界 JSON](#执行边界)。

## 项目入口与启动方式

`package.json` 的 `pluxel.dev` 直接按名称声明 profile。普通项目可用 `"pluxel": { "dev": { "app": { "command": "vp dev" } } }`，不需要 Pitchfork。官方应用模板提供两种启动方式：

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

| 输入              | 契约                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `default`         | 保留字段，必须指向已声明 profile；选择顺序为显式 `--profile` → default → 唯一 profile，否则报错                         |
| profile 的 `root` | 相对声明 package 的 Vite 根目录，默认 `.`；realpath 必须留在该目录内。模板 Vite root 是 `host/web`，应用声明则在 `host` |
| `command`         | 在声明 package 目录执行的前台命令；Ctrl+C 停止。不能使用立即退出的后台启动器或回调 `pluxel dev` 自身                    |
| `pitchfork`       | 短服务名，与 command 必须且只能选一个；原生 start 等待就绪后返回，服务继续运行，stop/restart/logs 仍用 Pitchfork        |
| `console`         | 默认 true，要求 Vite 开启 devConsole；false 仅支持没有 Pluxel Host 的 Pitchfork 服务                                    |
| CLI `--root`      | 配置发现起点，默认 cwd；向上找最近的 pluxel.dev，止于 Git / pnpm workspace 边界，不绕过已找到的配置                     |

一个 package 可有多个 profile，并可共用 Vite root。`vp run dev` 使用模板默认 `app`；`vp run dev:local` 使用 `local`。它们共用默认数据目录，**profile 只区分控制台归属，不隔离数据**：使用同一数据时先 `pitchfork stop app` 再切换；并行时显式设置不同 `PLUXEL_DATA_ROOT`。

控制台 profile 的 status/instances/run/hmr 只连接现有实例，不调用 Pitchfork。CLI 按真实 Vite root 和启动归属筛选，再选择唯一实例；多个候选必须 `--instance`，该选项不能绕过绑定：

- command：CLI 自动注入 `PLUXEL_DEV_PROJECT` / `PLUXEL_DEV_PROFILE`，核对声明 package 的真实目录与 profile 名，无需手配环境变量。
- Pitchfork：核对控制台捕获的 `serviceId` 短服务名，启动后额外核对 Pitchfork 返回的完整 ID；按 URL 唤醒也保留原生身份。同 root、同短名但不同 namespace 仍可能需要选 instance。

`dev` 启动或复用，重复调用读取当前实例的 Application / Workbench 地址；首次前台启动直接保留 Vite 输出。CLI 用一行显示 profile 与 starting/started/reused；终端样式直接遵循 [Node `styleText`](https://nodejs.org/api/util.html#utilstyletextformat-text-options) 的终端检测与颜色环境变量规则，无 Pluxel 专属开关。`urlOutput` 和 status JSON 保持纯文本，展示文本不作为路由协议。启动失败保留命令退出码；复用或托管启动后应用 updating 会提示，unavailable 返回 2，均不停止服务。

无 Host 的服务示例是本仓库 `docs: { "root": "projects/docs", "pitchfork": "docs", "console": false }`。`vp run docs` 选择它：等待 Pitchfork 就绪，再显示最新状态与实际 URL；`dev status --profile docs` 同样查询 Pitchfork。run、hmr、instances 和 `--instance` 在启动/连接前报 `unsupported_console`，不生成应用或 Workbench 状态。本仓库默认 profile 为 `plugin-host`，root 为 `projects/plugin-host`。

开发 scripts 与首次 CLI 构建由[工作区指南](./workspace-toolchain.md#管理开发服务)维护；这里不新增服务管理命令或后台 supervisor。

## 开启控制台与直接连接 Vite

模板已经开启。自行装配时在现有 Vite 集成中设置：

```ts no-twoslash
import { defineConfig } from 'vite'
import { host } from '@pluxel/host-vite'

export default defineConfig({
	plugins: [host({ entry: './src/app.ts', devConsole: true })],
})
```

`@pluxel/services/vite` 的 `vitePreset()` 也接受 `devConsole: true`。省略时不安装；只在 serve 生效，不额外安装官方服务或日志 store。当前支持 Linux/macOS 的私有 Unix socket，Windows 尚不支持。

没有 pluxel.dev 配置时，控制台使用最近 package 根目录；显式 `--root` 且向上未发现配置时直接使用该目录。没有配置却传 `--profile` 会报错。

```sh
vp exec pluxel dev instances --root /absolute/vite-root
vp exec pluxel dev run /absolute/vite-root/dev/inspect.ts --root /absolute/vite-root --instance INSTANCE_ID
```

若找到配置，仍遵守上节 profile 规则。发现只限选定 Vite realpath；多候选报 `ambiguous_instance`，不向其他项目回退。重启后重新发现实例，旧 receipt 始终指向原进程。

## 先发现，再修改

| 操作                                                          | 返回与限制                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `await dev.plugins.list()` / `status(target)`                 | 当前 Host 状态及稳定 PluginNodeAddress；target 可为地址或 Plugin constructor                                 |
| `await dev.plugins.start/stop/restart(target)`                | `PluginApplyReportSnapshot`，检查实际状态、错误和阻塞关系；CLI 成功不代表 Plugin 启动成功                    |
| `dev.plugins.isRunning(target)`                               | 同步查询运行状态                                                                                             |
| `dev.plugins.require(Plugin)` / `require({ plugin, forkId })` | 精确类型的当前实例；不创建 fork、不自动启动、不把旧 constructor 转为新 implementation，过期时报 stale_target |
| `await dev.updates.latest()`                                  | 最近应用更新或 null；包含尚未进入插件目录的新入口加载错误                                                    |

每次执行重新取得 Plugin/service handle。普通实例跨 await 可能过期；需要 generation admission 的调用使用 Commands、Workbench 或已有 database handle。生命周期语义见[生命周期](../plugin-development/lifecycle.md)，不要注册临时 catalog 来代替当前应用。

## 编辑配置

配置方法接受稳定地址或 Plugin constructor，沿真实 validation、persistence 和 notification 路径执行。在前面的脚本中增加具名导出：

```ts no-twoslash
export const increaseLimit = defineDevConsole(async (dev) => {
	const current = await dev.config.get(TodoPlugin)
	if (!current.ok) return current
	const result = await dev.config.patch(TodoPlugin, { maxItems: 100 })
	return { result, current: await dev.config.get(TodoPlugin) }
})
```

`get/validate/patch/reset` 返回 `HostPluginConfigResult`，先检查 ok；get 含保存值、默认值和 desired/applied revision，mutation 的 report 已投影为稳定地址。**保存不等于应用**：检查 application/applyFailure，含义与重启决策见[运行中配置更新](../plugin-development/configuration.md#让运行中的-plugin-接收配置更新)。不要直接改 config 私有字段。

patch 是浅合并，嵌套修改先读并保留其他字段；`reset(target, keys)` 删除指定顶层保存值，省略或空 keys 会重置全部。validate 不保存，与随后的 patch 不构成事务；patch 会重新验证。

## 访问已安装服务

应用声明依赖，脚本显式 import 各包 API；all/root 能力用 `dev.ctx.require(Token)`，owner-only 能力必须经实际插件 Context。`dev.ctx` 仅借用本次 Host，不能跨 run/Host replacement 缓存 Context、实例、handle 或 session。直接服务调用需自行传 `dev.signal`、await 完成，并用 using/try-finally 释放资源。

按任务读取：[Commands](../plugin-development/commands.md)、[Workbench 资源](../workbench/renderer-resources.md)、[日志](#有界操作日志与等待)。验证真实 HTTP ingress 时对已发现的应用 URL 使用 fetch 并传 signal，不猜端口或绕过 listener。数据库使用业务方法或插件公开的 owner-bound handle，不重新打开应用数据目录。

控制台调用已发布的 Workbench View，直接使用真实 descriptor 推导类型：

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

替换为项目真实 View 和业务方法。principal 由项目提供，形状为 `{ provider: string, subject: string, displayName?: string }`，不是控制台授予的管理员身份。using 关闭 entry/session，signal 也能触发释放；`consumeWorkbenchValue` 接管普通 RPC 数据并释放其 transport 资源，不能返回 stub/handle 或重复 dispose。同一次操作仍须检查领域结果；[数据 ownership](../plugin-development/contracts.md#数据与资源分别持有)遵循领域包契约。

## 有界操作日志与等待

Core 的 `dev.ctx.logger` 可直接使用；输出、过滤和 store 由 [Host 日志配置](../host/configuration.md#host-logging-plan)决定。控制台不创建 store、不修改路由、不在结果中自动附加日志。在线读取使用既有 Logging 能力：

```ts no-twoslash
import { defineDevConsole } from '@pluxel/host-vite/console'
import { Logging, markLogs, readLogs } from '@pluxel/services/logging'
import { pluginNodeAddressOf } from '@pluxel/core'
import { TodoPlugin } from '@example/todo-plugin'

export const restartWithLogs = defineDevConsole(async (dev) => {
	const logging = dev.ctx.require(Logging)
	const cursor = markLogs(logging)
	const report = await dev.plugins.restart(TodoPlugin)
	return {
		report,
		logs: readLogs(logging, cursor, {
			limit: 100,
			filter: { plugin: pluginNodeAddressOf(TodoPlugin) },
		}),
	}
})
```

`filter.plugin` 接受稳定 PluginNodeAddress；fork 使用 `dev.plugins.list()` 返回的目标地址。过滤只匹配该节点，依赖节点的问题需结合 report 另查其日志；省略 filter 则读取该时间窗的所有记录。

`markLogs(logging, streamId = 'default')` flush 后标记末尾，可为已配置但尚无记录的 stream 创建空存储；未配置且不存在时抛错。readLogs 返回有界记录和下一 cursor，可保留用于分页。等待用同包的 `await waitForLogs(logging, cursor, { filter, limit: 100, signal: dev.signal })`：返回首批匹配记录或 cursor 失效结果，无匹配时等到取消；完成/取消释放订阅，取消按 signal.reason 拒绝，不改变日志生产或过滤配置。

cursor 是 JSON `{ rootId, streamId, bootId, epoch, nextSeq }`，跨进程输入仍需校验。不得忽略 `root_mismatch`、`stream_replaced`、`store_unavailable`、`epoch_mismatch`、`from_too_old`、`invalid` 或拼接不同 Host/stream 的序号；游标只划定时间窗口，不保证记录全由本次操作产生。

## 结果、取消和恢复

操作命令的 stdout 是单个 JSON envelope，领域返回值在成功 snapshot 的 value 中；同时检查退出码和 stderr（帮助/参数解析失败使用普通 CLI 输出）。同步 run 接纳时先在 stderr 给出 receipt，run/result/cancel 同样保留它及 root/instanceId/runId 诊断。

```sh
vp exec pluxel dev run host/web/dev/seed.ts --detach
vp exec pluxel dev result RECEIPT
vp exec pluxel dev cancel RECEIPT
```

原样保存 receipt；它绑定原 root、instanceId、runId、serviceId，不含 nonce，不授予额外权限。result/cancel 只接受 receipt，不再接受 profile/root/instance，原进程消失就失败，绝不转投重启后的实例或重新执行。raw runId 只是诊断。

| 观察结果              | 含义与下一步                                                    |
| --------------------- | --------------------------------------------------------------- |
| 退出码 0              | 已完成或 detach 已接纳；继续检查 run state 与领域结果           |
| 退出码 1              | 失败、取消或客户端错误；按 error.code 分支，不匹配 message/hint |
| 退出码 2 / cancelling | 尚未结束；使用原 receipt 查询                                   |
| outcome_unknown       | 无法确认是否写入；先查询原结果，不能直接重放                    |
| result_expired        | 已超过结果保留窗口；从领域状态和日志核对                        |

断线不自动重试或取消。默认 timeout 为 30 秒，`--timeout` 允许 1–300000 毫秒且包含排队；超时只发协作取消，脚本 settle 前不让出执行位置，CPU 死循环仍会阻塞宿主。取消关闭新的控制台操作入口，已接纳配置/生命周期操作继续排空，已写入数据不回滚；直接服务操作仍需显式传 signal。

取消终态为 cancelled，error 保留取消原因，另有执行/释放异常时保留 executionError；业务 AggregateError 不伪装成执行/清理阶段，预算内保留子错误和 SuppressedError。失败或返回值编码错误都可能发生在写入之后。

## 执行边界

控制台是受信任项目代码执行，不是沙箱；权限等于 dev 宿主。通信只走当前用户私有 Unix socket/discovery，不在公共 Vite HTTP listener 暴露 eval。脚本和 HMR 控制各自串行执行；HMR、浏览器和后台任务仍可与脚本交错，一段脚本不是全局事务。

脚本及辅助模块遵循当前 Vite 编译、解析和模块身份。已知依赖变化等待真实 watcher；auto 模式等待已接纳的有限批次，paused 且有运行时待处理变化时报 `hmr_pending`。禁用/忽略 watcher 可能等到超时。首次加载只保证当前已提交 Host 和已观察更新，不承诺发现全部磁盘修改。提交后入口改变报 source_changed，依赖使用执行时模块图，不提供全文件系统 snapshot。完整 Host replacement 取消旧脚本 run、撤回其 driver；新提交使用当前 epoch，旧 run 不转接新 Host。HMR 控制属于 Vite 实例，独立于这个脚本执行 scope。

仅返回 JSON 投影：对象 undefined 省略，数组 undefined/顶层无返回值编码为 null；函数、BigInt、非有限数字、循环、accessor、class instance、RPC capability 明确失败，不调用 toJSON。运行上限如下；优先复用少量脚本和 named exports：

| 预算                               | 上限                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------- |
| 同时执行 / 排队                    | 脚本和 HMR 控制各 1 / 16，两类操作互不占用执行位置                          |
| 输入、输出                         | 各 1 MiB、64 层、100000 节点                                                |
| 保留完成结果                       | 最近 100 个、总计 16 MiB；过期报 result_expired                             |
| 每实例请求去重                     | 最多接纳 100000 次；相同请求 ID 不重复执行，不承诺进程崩溃后的 exactly-once |
| 脚本入口 / 每入口本地依赖 / 单文件 | 128 / 4096 / 1 MiB                                                          |

进程内依赖注入使用 `host({ entry, bindings })` / `vitePreset({ entry, bindings })`：创建集成时浅复制并冻结为 startup.bindings，省略为空对象；资源始终由注入方拥有，不随脚本释放。开发会话与 bindings 的关闭顺序见 [Vite 应用接入](../host/configuration.md#vite-开发)。
