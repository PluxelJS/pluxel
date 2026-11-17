---
title: Vite 项目脚本与 HMR
description: 在当前 Vite 模块图中执行普通 TypeScript，访问真实插件和 Context，并控制源码更新批次。
---

项目脚本由目标 Vite 的现有 ModuleRunner 加载。它与应用共享 Plugin constructor、服务声明和模块身份。配置、插件、策略与日志使用 [Script SDK](./scripts.md)，异步控制操作成功直接返回值，失败抛出 `ScriptError`。`sdk.plugin(Constructor.nodeAddress())` 按当前实现选择节点，并通过 `.instance()` 借用受守卫的实例；通过 `pluxel dev sync` 取得[控制类型与配置源码描述](./plugin-control.md)后，生成提供者的 `.nodeAddress()` 通过同一入口提供准确配置类型。脱离 Vite 的部署使用同一 SDK 的上传执行。

源码定位使用 `@pluxel/agent-sdk/source` 的普通函数，直接运行 Node；声明、Part、Schema 和应用输入的查询见[源码查询](./inspection.md)。

程序调用从 [`@pluxel/agent-sdk/client`](./agent-sdk.md#从-node-连接现有-host) 使用 `listHosts`、`runScript`、`controlHmr` 和原 receipt 查询。以下 CLI 命令使用相同实现；服务启动仍由项目配置与 Pitchfork 管理。

## 推荐工作流程

```sh
vp exec pluxel dev status
vp exec pluxel dev run host/web/dev/inspect.ts --receipt-file inspect.receipt
```

先确认 profile、Vite root、instanceId 与 `application.state`。修改运行中应用的多个文件前暂停 HMR，完成检查后 apply 并核对应用报告与实际行为。命令在 stderr 先输出 `{ stage: 'prepared', receipt }`，接纳后输出 `{ stage: 'accepted', receipt }`；stdout 保留一个最终 `{ ok: true, value: { receipt, run } }` JSON。命令失败使用 `{ ok: false, error }`，已准备的 receipt 保留在 error 中。保存 receipt，后续查询和取消始终定位原实例。

```sh
vp exec pluxel script result --receipt-file inspect.receipt
vp exec pluxel script cancel --receipt-file inspect.receipt
```

`dev run` 和 `dev hmr` 都可在提交前保存 receipt，文件路径相对终端当前目录。创建、失败与恢复规则统一见[保存和恢复 receipt](./scripts.md#保存和恢复-receipt)。

CLI 与 Vite 通过私有 Unix socket 上的 Cap’n Web 连接。发现目录和 socket 受当前用户文件权限保护；Vite 的公共 HTTP listener 不提供脚本执行。`dev status/instances/run/hmr` 查询现有实例，`pluxel dev` 才负责启动或复用配置的开发服务。

`dev status/instances/run/hmr/sync` 的参数缺失、未知选项和多余位置参数统一在 stdout 输出单个 `{ ok: false, error: { code: 'invalid_input', message } }`，退出码为 `1`，stderr 不输出额外文本诊断。`--help` 保持普通帮助文本。

未知 `dev` 子命令同样返回 `invalid_input` JSON。多个实例时，错误列出 `candidates` 并提示使用 `--instance`；保持原 `--root` 和 `--profile`，不要自动选第一个实例。提交结果不确定时，提示使用原 receipt 的查询命令，不建议重新提交。

发现记录损坏或版本不匹配时，错误 `context` 包含 `root`、`recordFile`，协议错误另含 `expectedProtocol` / `actualProtocol`。默认发现会报告这些记录；已知 `--instance` 或原 receipt 只读取目标记录，无关坏记录不阻断它。核对路径与进程后可显式清理已废弃记录；客户端不自动删除。客户端与目标使用同一版本的脚本控制协议。

<span id="hmr-批次控制"></span>

## HMR 批次控制

```sh
vp exec pluxel dev hmr pause
# 编辑源码并完成静态检查
vp exec pluxel dev hmr apply
vp exec pluxel dev run host/web/dev/inspect.ts
vp exec pluxel dev hmr resume
```

`pause` 等待已接纳批次结算，然后保持 `paused`，watcher 继续收集变化。`apply` 应用有限的一批待处理变化，完成后仍保持暂停。`resume` 完成有限待处理工作后回到 `auto`。失败时保持暂停修复；成功且原来为自动模式时才恢复。

状态中的 `hmr` 提供 mode、running、pending.files/full 和 observedRevision/attemptedRevision。最近的候选与生命周期结果在 `application.latestUpdate`。控制请求成功后继续检查应用是否 ready、更新是否被采用以及实际行为。

HMR 控制属于 Vite 实例，在应用启动失败或 Host replacement 期间仍可用。暂停且有待处理运行时变化时，项目脚本以 `hmr_pending` 结束；脚本不会自动 apply。执行中的普通脚本不占有整个 HMR/coordinator 锁，更新可以与脚本中的 await 交错。

## 编写可交互的开发脚本

在目标 Vite root 内创建 `dev/inspect.ts`。以下示例使用应用自己的 TodoPlugin；`snapshot()`、`add()` 是该插件公开的业务方法。

```ts no-twoslash
import type { Script } from '@pluxel/agent-sdk/host'
import { TodoPlugin } from '@example/todo-plugin'

export default (async ({ plugin }) => {
	const todo = plugin(TodoPlugin.nodeAddress())
	const status = await todo.status()
	const { instance } = await todo.instance()
	return { status, todos: instance.snapshot() }
}) satisfies Script

export const add = (async (sdk, run) => {
	const title = run.input
	if (typeof title !== 'string') throw new TypeError('Expected a todo title')
	run.signal.throwIfAborted()
	const { instance } = await sdk.plugin(TodoPlugin.nodeAddress()).instance()
	return instance.add(title)
}) satisfies Script
```

```sh
vp exec pluxel dev run host/web/dev/inspect.ts
vp exec pluxel dev run host/web/dev/inspect.ts --export add --input '"测试待办事项"'
```

项目与上传脚本统一使用 `Script` 和 `satisfies`；输入从 unknown 校验。`Provider.nodeAddress(id?)` 取得默认节点或 fork 地址，`sdk.plugin(address)` 同步选择目标。成功值直接使用，默认让异常中断后续步骤，需要恢复时按[自动化脚本](./scripts.md#失败取消和释放)捕获。源码屏障结算后，执行器完成 TypeScript 检查并核对真实缓存模块的原始输入，声明或源码变化时会明确失败。返回 JSON 或共享的顶层 Result，由执行边界编码；实例、Context、函数和其他运行句柄留在目标进程。

脚本采用所在目录最近的 `tsconfig.json`，其模块解析条件应与 Host 一致。前端配置常清空 `customConditions`，从插件发行声明读取类型；服务端 Vite 使用 `@pluxel/hmr` 加载源码时，这两种输入会被源码守卫拒绝。官方 starter 为服务端脚本提供 `host/web/dev/tsconfig.json`，继承 Host 的 Node、源码条件和装饰器配置：

```json
{
	"extends": "../../tsconfig.json",
	"include": ["**/*.ts"]
}
```

自定义目录结构时，让脚本目录继承自己的 Host 配置。前端继续使用其原配置。

`sdk.plugin(Constructor.nodeAddress())` 的状态、生命周期、动态配置和实例获取都在同一 committed 操作内核对 constructor 身份。HMR 替换实现后，原引用抛出 `stale_target`；重新 import 当前实现再选择。同一实现 restart 后可用原引用重新取得新 generation，旧实例视图失效。fork 使用 `Constructor.nodeAddress('east')`，它保留相同实现证据，选择不会物化节点。引用和原业务成员的寿命见[实例调用](./plugin-control.md#调用原插件实例)。

源码 class 的地址保留实例签名与精确实现证据，配置使用未知字段的动态类型。生成控制入口额外关联 Schema 输入、输出及 Part 配置树；需要准确字段类型时使用生成提供者的地址。动态发现得到的普通节点地址同样提供动态配置操作，由脚本自行检查。

Node 与 Vite 脚本都通过 `sdk.ctx` 使用根 Context 的内建能力，通过 `await sdk.plugin(address).context()` 借用已运行节点的 Plugin Context；应用安装的服务用各自视图的 `service(Service)` 读取。视图固定本次 run 和 generation 的接纳范围，不交付原始 Context。内建属性、必需/可选服务引用和声明契约见[服务访问](./scripts.md#借用已安装的服务)。Vite 负责把导入的服务声明与应用保持在同一模块图。自己创建的订阅、RPC lease 和原生资源由脚本通过 `using`、`await using` 或 `try/finally` 释放；直接业务调用显式传递 `run.signal` 并 await 结算。通用 SDK 接纳的操作由执行内核跟踪并排空。

<span id="编辑配置"></span>

## 在线查看与更新插件配置

```ts no-twoslash
import type { Script } from '@pluxel/agent-sdk/host'
import { TodoPlugin } from '@example/todo-plugin/control'

export const increaseLimit = (async ({ plugin }) => {
	const todo = plugin(TodoPlugin.nodeAddress())
	const { get, patch } = todo.config
	const current = await get()
	const limit = current.config.limit
	const changed = await patch(
		{ set: { limit: limit + 1 } },
		{ expectedManagedRevision: current.managedRevision },
	)
	const currentConfig = await get()
	const { instance } = await todo.instance()
	return {
		persistence: changed.persistence,
		application: changed.application,
		current: currentConfig,
		actual: instance.config.limit,
	}
}) satisfies Script
```

`config` 是经过 Schema 计算的期望输出，修改只提交 managed input 的变更字段。查询还提供来源、遮盖路径和 managed revision。保存确认、desired 接纳和 generation 实际采用分别检查；详见 [SDK 配置操作](./scripts.md)与[配置指南](../plugin-development/configuration.md)。

日志用 `sdk.logs.mark()`、`read()`、`wait()`，与插件启停使用同一 SDK。没有历史 store 时会抛出能力诊断，执行器不会自行安装日志 backend。日志 cursor 保留 epoch、retention 和 gap 含义。

<span id="项目入口与启动方式"></span>

## 配置 profile 与启动方式

Vite 配置显式启用项目执行：

```ts no-twoslash
import { defineConfig } from 'vite'
import { host } from '@pluxel/host-vite'

export default defineConfig({ plugins: host({ entry: './app.ts', scripts: true }) })
```

使用官方服务附件时同样设置 `vitePreset({ entry, scripts: true })`。此开发入口只在 development profile 可用。

```json
{
	"pluxel": {
		"dev": {
			"default": "app",
			"app": { "root": "host/web", "pitchfork": "app" },
			"local": { "root": "host/web", "command": "vp run @example/host#dev:server" },
			"docs": { "root": "docs", "pitchfork": "docs", "scripts": false }
		}
	}
}
```

`root` 相对声明 package；pitchfork 与 command 二选一。显式 `--profile` 优先于 default，多个 profile 没有默认时必须选择。相同目标匹配多个实例时加 `--instance`；此参数保留 profile 与启动归属检查。无配置的手动 Vite 可以用 `--root` 选择其真实根目录。只有 Pitchfork profile 可以设置 `scripts: false`，用于没有 Pluxel Host 的文档站等服务。

## 失败、取消与恢复

SDK 控制操作的未捕获异常形成执行失败，领域细节保留在 `run.error.details`；原业务返回值继续遵循自己的协议。已提交修改继续保留。取消、编码、清理和原 receipt 查询规则由[自动化脚本](./scripts.md#失败取消和释放)维护。

输入、返回值和单个源码文件各有 1 MiB 预算，结果保留最近 100 项且总计不超过 16 MiB。结果过期后仍保留有界接纳身份，旧 ID 不会再次执行。源码变化会明确报 `source_changed`；检查当前源码后再作新的显式提交。
