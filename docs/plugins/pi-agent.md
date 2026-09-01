---
title: Pi Agent
description: 以内置 engine 方式接入 Pi，并复用 Pluxel commands、Toolset、goal 和 bounded subagent。
---

`@pluxel/pi-agent` 是 workspace preview。它把 Pi 用作模型循环、streaming、session compaction 与 tool calling engine，
不会把 Pi extension 系统变成第二套 Pluxel 插件 runtime。

## 装配

Pi 插件 required-depend on `AgentToolsPlugin`。先用 AgentTools assignment 定义可选 tool setup，再为 Pi 设置默认项：

```ts no-twoslash
import { AgentToolsPlugin } from '@pluxel/agent-tools'
import { PiAgentPlugin } from '@pluxel/pi-agent'

host.add([AgentToolsPlugin, PiAgentPlugin, NotesPlugin])
host.cfg(AgentToolsPlugin).set({
	toolsets: [
		{ id: 'notes-read', label: 'Notes read', commandNames: ['notes.read'] },
		{ id: 'notes-write', label: 'Notes write', commandNames: ['notes.create'] },
	],
	agents: [
		{ agentId: 'researcher', label: 'Researcher', toolsetIds: ['notes-read'] },
		{ agentId: 'operator', label: 'Operator', toolsetIds: ['notes-read', 'notes-write'] },
	],
})
host.cfg(PiAgentPlugin).set({
	defaultToolSetupId: 'researcher',
	model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
})
```

这里把 AgentTools assignment 用作 Pi 的 tool setup。模型 credential 不进入普通 Plugin config；Pi `ModelRuntime`
从标准 Pi credential store 读取。省略 `model` 时由 Pi 解析已配置的默认可用模型。

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

Pi Agent 当前不发布 Workbench Definition。若以后增加 session 管理界面，streaming、goal、subagent、abort 和并发状态应放在
完整 View 中，不拆成 Content；模型 credential 继续服从 Pi `ModelRuntime` 的 credential contract。
