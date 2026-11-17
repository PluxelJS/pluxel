---
title: Agent SDK
description: 按执行位置选择源码查询、进程内 Host 操作或外部 Node 客户端函数。
---

`@pluxel/agent-sdk` 是 agent 和自动化程序的公共库，按代码执行的位置选择入口：

| 入口                       | 执行环境             | 调用                                                                                           |
| -------------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `@pluxel/agent-sdk/source` | Node，可读取项目源码 | `inspectPlugin`、`listPlugins`、`inspectFile`、`inspectProject`                                |
| `@pluxel/agent-sdk/host`   | 已启动的 Host 内部   | `Script`、`ScriptSdk`、`ScriptError`、`createScriptScope`                                      |
| `@pluxel/agent-sdk/client` | 外部 Node 程序       | `listHosts`、`runScript`、`controlHmr`、`getScriptResult`、`cancelScript`、`syncPluginControl` |

包要求 Node 24 或更新版本，不提供混合根入口。源码查询和客户端函数直接用 `node tool.mjs` 调用；终端命令的选择见下节。代码调用无需启动 CLI，也不需要额外的 client 会话或脚本包装。

## 终端命令

`@pluxel/cli` 提供唯一的 `pluxel` 可执行入口，按需挂载 Agent SDK 拥有的 `script run/result/cancel/sync` 和 `dev instances/run/hmr/sync`。SDK 统一维护这些命令的帮助、参数、输入与凭据文件、receipt 保存、JSON 与进度输出和退出码。安装 SDK 本身只提供库，不增加可执行命令。

`pluxel dev` 的服务启动、复用和前台进程仍由 CLI 管理。`dev status` 对 Host 复用 SDK 发现，对 `scripts: false` 服务查询 Pitchfork；两者都不会启动服务。命令用法见[自动化脚本](./scripts.md)与[开发控制台](./dev-console.md)，普通 Node 程序直接使用下文的函数入口。

## 查询源码

`/source` 接收显式工作区，每次调用自行结算，见[源码查询](./inspection.md)。它使用 Rolldown 的共享静态分析器，不创建 Host、脚本执行器或远端连接。同一个标准 definition 可来自源码发现、生成控制入口或运行节点的 `address.definition`。

## 操作进程内的 Host

`/host` 为 Node 和 Vite 脚本导出同一个 `Script`、`ScriptSdk` 和 `ScriptError`。执行器注入 SDK，控制操作成功直接返回值、失败抛错；`sdk.ctx` 是只有 `service(...)` 的根服务访问视图。`sdk.ctx.service(Service)` 借用已安装服务；`const ctx = await sdk.plugin(address).context()` 借用当前运行代的 owner 服务视图。必需声明、可选 ref、远端生成材料与失效规则见[借用已安装的服务](./scripts.md#借用已安装的服务)。Vite 从当前模块图加载服务声明，见[开发控制台](./dev-console.md)。持有现成 Host 的进程也可以直接借用它：

```ts no-twoslash
import { createScriptScope } from '@pluxel/agent-sdk/host'

await using scope = createScriptScope({ ctx: host.ctx })
const status = await scope.sdk.plugin(nodeAddress).status()
console.log(status)
```

scope 关闭时排空已接纳的操作，Host 的寿命由创建者管理。`/host` 的运行依赖不包含 Node、Services 或编译器。

## 从 Node 连接现有 Host

`/client` 的函数接收显式目标，每次调用自行关闭连接。目标二选一：

- 本地 `{ root, profile?, instance? }`：从 `root` 查找项目已有的 `pluxel.dev` 配置，选择匹配的 Vite 实例；没有实例时返回错误，不启动服务。
- 远端 `{ endpoint, credentials? }`：连接显式 endpoint，沿用 Management 认证。`credentials` 接收 `password`、`code` 或已有的 `cookie`；凭据文件由调用方读取。

本地发现返回 `{ workspace, root, profile?, instances }`。多个匹配实例时，执行操作要求明确选择 `instance`；返回的实例信息不包含控制台 nonce 或 socket 路径。坏记录或协议不匹配会明确失败，`failure.context` 提供记录路径与期望/实际协议；已知 `instance` 和原 receipt 只读取所属记录，仍验证目录权限与目标握手。

```js
import { listHosts } from '@pluxel/agent-sdk/client'

const discovery = await listHosts({ root: process.cwd() })
console.log(discovery.instances)
```

本地执行在目标 Vite 模块图中加载项目文件。远端执行在调用方使用 Rolldown 编译并上传，接收端不需要源码或编译器。`file` 相对于调用方 cwd；本地文件必须位于选中的 Vite root 内。远端执行还需要 Host 显式授予脚本权限，见[执行边界](./scripts.md#向-node-应用提交)。

```js
import { writeFile } from 'node:fs/promises'
import { runScript, HostClientError } from '@pluxel/agent-sdk/client'

try {
	const { receipt, run } = await runScript({
		target: { root: process.cwd() },
		file: './dev/task.ts',
		// 提交前保存，文件已存在时拒绝覆盖；每次操作选择新文件。
		onPrepared: (receipt) => writeFile('./task.receipt', receipt, { flag: 'wx', mode: 0o600 }),
	})
	if (run.state !== 'succeeded') throw new Error(JSON.stringify({ receipt, run }))
	console.log(run.value) // 若业务返回 Result DTO，继续检查其 status。
} catch (error) {
	if (error instanceof HostClientError) console.error(error.code, error.receipt)
	throw error
}
```

同一 `runScript` 接受远端 `target: { endpoint, credentials }`；`exportName` 默认 `default`，`input` 在调用时复制为有界 JSON。`timeoutMs` 默认 30000、最大 300000，约束 Host 执行（含接纳和加载）。默认等待至终态或执行期限再加五秒；`detach: true` 在接纳后返回。等待返回并不保证已经结算，始终检查 `run.state`。

`onPrepared(receipt)` 在提交前被等待，保存失败则不提交；`onAccepted({ receipt, run })` 在接纳后被等待。连接或查询失败抛出 `HostClientError`，包含 `code`、`failure` 和已生成的 `receipt`。Host 运行失败通过 `run.state/error` 返回；业务结果继续保留在 `run.value` 中，不把不同层次的失败合并。

```js
import { readFile } from 'node:fs/promises'
import { getScriptResult, cancelScript } from '@pluxel/agent-sdk/client'

const receipt = await readFile('./task.receipt', 'utf8')
const current = await getScriptResult(receipt)
console.log(current.run)
// 显式请求取消；返回 cancelling 时仍需用同一 receipt 核对结算。
const cancelled = await cancelScript(receipt)
console.log(cancelled.run)
```

远端 receipt 的查询或取消额外传 `{ credentials }`；连接位置和原实例由 receipt 决定，不接受重定向目标。receipt 不携带凭据，也不授予权限。提交响应丢失时先查询原 receipt，不重提任务。

各客户端函数支持 `signal`。中断会关闭客户端连接、停止等待，已接纳的任务仍由 Host 管理；需要取消任务时显式调用 `cancelScript`。调用方回调的 IO 由调用方管理。控制材料发布在原子安装开始前响应取消，开始安装后完成发布并返回实际结果。

`controlHmr({ target, action: 'pause' | 'apply' | 'resume' })` 仅接受本地目标，与执行共享 timeout、detach、receipt 和回调契约；仍需核对 [HMR 与应用报告](./dev-console.md#hmr-批次控制)。`syncPluginControl({ target, out, packageName?, definition? })` 要求显式输出目录，两个筛选条件互斥，均省略则同步全部。返回的定义包含准确模块、导出名与可复制 `importStatement`；远端只需材料读取权限，无需脚本执行权限，详见[控制材料](./plugin-control.md#取得控制入口)。
