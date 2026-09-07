---
title: Pi Agent
description: 以内置 engine 方式接入 Pi，并复用 Pluxel commands、Toolset、goal 和 bounded subagent。
---

需要让应用自身运行模型会话、流式输出和业务工具调用时使用 Pi Agent。`@pluxel/pi-agent` 目前仅供工作区内部使用，尚不能从外部项目安装。只想把命令交给已有 Agent 的应用，应使用 [Agent tools](./agent-tools.md)。

下面的内部集成使用 Pi 运行模型循环；业务工具仍由 Pluxel commands 和 Toolset 授权。

## 装配

Pi 插件 required-depend on `AgentToolsPlugin`。先用 AgentTools assignment 定义可选 tool setup，再为 Pi 设置默认项：

以下 `host` 是 [测试宿主](../development/testing.md)，用于验证装配。应用入口按 [添加插件](./index.md#把一个插件加入应用) 配置清单、配置记录和自动启动。

```ts no-twoslash
import { AgentToolsPlugin } from '@pluxel/agent-tools'
import { PiAgentPlugin } from '@pluxel/pi-agent'

await host.start(AgentToolsPlugin, {
	catalog: [NotesPlugin],
	initialConfig: {
		toolsets: [
			{ id: 'notes-read', label: 'Notes read', commandNames: ['notes.read'] },
			{ id: 'notes-write', label: 'Notes write', commandNames: ['notes.create'] },
		],
		agents: [
			{ agentId: 'researcher', label: 'Researcher', toolsetIds: ['notes-read'] },
			{ agentId: 'operator', label: 'Operator', toolsetIds: ['notes-read', 'notes-write'] },
		],
	},
})
await host.start(NotesPlugin)
await host.start(PiAgentPlugin, {
	initialConfig: {
		defaultToolSetupId: 'researcher',
		model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
	},
})
```

这里的 `host` 是 `createRuntimeTestHost()` fixture，`initialConfig` 只用于首次 lifecycle；production deployment 通过 ConfigService
管理相同 records。AgentTools assignment 用作 Pi 的 tool setup。模型 credential 不进入普通 Plugin config；Pi `ModelRuntime`
从标准 Pi credential store 读取。省略 `model` 时由 Pi 解析已配置的默认可用模型。

开始前先配置 Pi 支持的模型凭据，并确认 `NotesPlugin` 已注册 Toolset 中的命令。装配成功后执行下面的会话，检查是否收到 `text_delta`，以及 `researcher` 只发现读取工具；模型调用错误从 `prompt()` 的结果或异常处理。

## 创建会话

```ts no-twoslash
const pi = host.require(PiAgentPlugin)
const session = await pi.createSession({ toolSetupId: 'researcher' })

const unsubscribe = session.subscribe((event) => {
	if (event.type === 'text_delta') process.stdout.write(event.text)
})

session.setGoal('归纳今天的 notes')
const result = await session.prompt('完成当前 goal')

unsubscribe()
await session.dispose()
```

`createSession()` 会拒绝不存在的 setup，不会静默创建意外的空权限 session。Toolset 内 command 的注册、撤销或替换
会更新 Pi tool projection；每次 tool call 仍回到同一个 bound catalog，所以配置更新后的权限会在 dispatch 前重新检查。

## Goal 与 subagent

Goal 存在于真实 session state，可由调用方的 `setGoal()` / `completeGoal()` / `clearGoal()` 管理，也可由模型通过
`pluxel_goal` tool 管理。

`session.spawnSubagent(task, { signal })` 与模型可用的 `pluxel_subagent` 都会创建真实 child Pi session。调用方的
`AbortSignal` 会同时取消等待 admission 和已经开始的 child run，但不会 dispose parent。child 固定继承父 session
的 tool setup，不能借 delegation 切换到更高权限。`maxSubagentDepth`、`maxSubagentsPerSession`、
`maxConcurrentSubagents` 和 `maxSessions` 限制 fan-out；dispose parent 时会一起 abort、等待并清理 child。

## 有意关闭的 Pi 能力

集成固定使用 `noTools: 'builtin'`，并关闭 Pi extensions、skills、prompt templates、themes、AGENTS/context file discovery。
文件、shell、网络或业务工具都必须由 Pluxel command Plugin 发布并经过 AgentTools assignment。这样 Workbench disabled 的
headless host 与有界面 host 使用同一安全边界。

当前 session、goal 和完成后的 subagent record 只保存在内存中，尚不承诺 resume/persistence。Plugin 配置仍由
通用 Plugin Config 页面保存。

Pi Agent 当前没有专用 Workbench 会话管理界面。会话输出、取消与释放由调用它的应用负责；模型凭据仍由 Pi `ModelRuntime` 管理。
