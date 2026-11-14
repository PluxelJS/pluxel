---
title: Vite 项目脚本与 HMR
description: 在当前 Vite 模块图中执行普通 TypeScript，访问真实插件和 Context，并控制源码更新批次。
---

项目脚本由目标 Vite 的现有 ModuleRunner 加载。它与应用共享 Plugin constructor、能力 token 和模块身份，可以访问真实实例和 root Context。配置、插件、策略与日志使用 [Script SDK](./scripts.md)；已知插件还可通过 `pluxel dev sync` 取得[控制类型与配置源码描述](./plugin-control.md)，使用 `sdk.plugin(descriptor).instance()` 调用业务 API。脱离 Vite 的部署使用同一 SDK 的上传执行。

## 推荐工作流程

```sh
vp exec pluxel dev status
vp exec pluxel dev run host/web/dev/inspect.ts
```

先确认 profile、Vite root、instanceId 与 `application.state`。修改运行中应用的多个文件前暂停 HMR，完成检查后 apply 并核对应用报告与实际行为。命令在 stderr 的 `submitting` 事件中先给出 receipt 和请求摘要，接纳后给出 `accepted`；stdout 保留一个最终 JSON。保存 receipt，后续查询和取消始终定位原实例。

```sh
vp exec pluxel dev result RECEIPT
vp exec pluxel dev cancel RECEIPT
```

CLI 与 Vite 通过私有 Unix socket 上的 Cap’n Web 连接。发现目录和 socket 受当前用户文件权限保护；Vite 的公共 HTTP listener 不提供脚本执行。`dev status/instances/run/hmr` 查询现有实例，`pluxel dev` 才负责启动或复用配置的开发服务。

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
import type { ProjectScript } from '@pluxel/host-vite/project'
import { TodoPlugin } from '@example/todo-plugin'

export default (async (sdk) => ({
	status: await sdk.plugin(sdk.dev.address(TodoPlugin)).status(),
	todos: sdk.dev.instance(TodoPlugin).snapshot(),
})) satisfies ProjectScript

export const add = ((sdk, run) => {
	if (typeof run.input !== 'string') throw new TypeError('Expected a todo title')
	run.signal.throwIfAborted()
	return sdk.dev.instance(TodoPlugin).add(run.input)
}) satisfies ProjectScript
```

```sh
vp exec pluxel dev run host/web/dev/inspect.ts
vp exec pluxel dev run host/web/dev/inspect.ts --export add --input '"测试待办事项"'
```

`ProjectScript` 使用普通函数与 `satisfies`；没有运行时定义 helper。输入从 unknown 校验。通用 SDK 的 `plugin()` 和 `fork()` 同步选择目标，Host 操作返回普通 Promise。源码屏障结算后，执行器完成 TypeScript 检查并核对真实缓存模块的原始输入，声明或源码变化时会明确失败。返回可移植纯数据；实例、Context、函数和其他运行句柄留在目标进程。

`sdk.dev.address(Constructor)` 对当前 catalog 检查 constructor 身份后返回稳定节点地址。通用配置与生命周期方法使用这个地址。fork 使用 `{ plugin: TodoPlugin, forkId: 'east' }`，只查找已有节点。`sdk.dev.instance()` 返回实际当前实例；每次 restart/HMR 后重新取得。已取得的普通 JavaScript 对象无法通用撤销，不能跨 run 或 Host epoch 缓存。

通过 `sdk.dev.ctx.require(Token)` 访问应用已安装的能力。脚本借用 root，自己创建的订阅、RPC lease 和原生资源由脚本通过 `using`、`await using` 或 `try/finally` 释放；直接业务调用显式传递 `run.signal` 并 await 结算。通用 SDK 接纳的操作由执行内核跟踪并排空。

<span id="编辑配置"></span>

## 在线查看与更新插件配置

```ts no-twoslash
import type { ProjectScript } from '@pluxel/host-vite/project'
import { TodoPlugin } from '@example/todo-plugin'

export const increaseLimit = (async (sdk) => {
	const { get, patch } = sdk.plugin(sdk.dev.address(TodoPlugin)).config
	const current = await get()
	if (!current.ok) return current
	const limit = current.config.limit
	if (typeof limit !== 'number') throw new TypeError('Expected a numeric limit')
	const changed = await patch(
		{ set: { limit: limit + 1 } },
		{
			expectedManagedRevision: current.managedRevision,
		},
	)
	if (!changed.ok) return changed
	return {
		persistence: changed.persistence,
		application: changed.application,
		current: await get(),
		actual: sdk.dev.instance(TodoPlugin).config.limit,
	}
}) satisfies ProjectScript
```

`config` 是经过 Schema 计算的期望输出，修改只提交 managed input 的变更字段。查询还提供来源、遮盖路径和 managed revision。保存确认、desired 接纳和 generation 实际采用分别检查；详见 [SDK 配置操作](./scripts.md)与[配置指南](../plugin-development/configuration.md)。

日志用 `sdk.logs.mark()`、`read()`、`wait()`，与插件启停使用同一 SDK。没有历史 store 时会返回能力诊断，执行器不会自行安装日志 backend。日志 cursor 保留 epoch、retention 和 gap 含义。

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

函数返回 `{ ok: false }` 等领域结果时，run 仍可成功；调用方继续处理领域结果。执行记录区分 admission/load/execute/encode/cleanup，保留错误、独立清理错误及前后版本。部分写入后抛错或结果编码失败，已提交操作继续保留，执行器不会自动回滚或重投。

取消先关闭新的 SDK 接纳并传递 signal，正在进行的 Host 修改按真实生产路径结算。running run 在结算前保持 cancelling；同步死循环仍受同进程 JavaScript 的协作取消限制。断开连接保留已接纳 run，可用原 receipt 重连查询。结果过期、原 owner 消失与没有找到 run 分别报告；切勿用新的 run ID 自动重发写操作。

输入、返回值和单个源码文件各有 1 MiB 预算，结果保留最近 100 项且总计不超过 16 MiB。结果过期后仍保留有界接纳身份，旧 ID 不会再次执行。源码变化会明确报 `source_changed`；检查当前源码后再作新的显式提交。
