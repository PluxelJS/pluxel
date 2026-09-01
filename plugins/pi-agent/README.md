# `@pluxel/pi-agent`

Pluxel 官方 Pi embedded engine 插件。Pi 提供模型循环、streaming、session compaction 和工具调用；Pluxel 继续拥有
Plugin graph、commands、tool policy 和生命周期。

本包当前是 workspace preview。它使用 `@earendil-works/pi-coding-agent`，不会启动 Pi TUI 或第二套插件系统。

```ts
import { AgentToolsPlugin } from '@pluxel/agent-tools'
import { PiAgentPlugin } from '@pluxel/pi-agent'

host.cfg(AgentToolsPlugin).set({
	toolsets: [{ id: 'notes', label: 'Notes', commandNames: ['notes.read'] }],
	agents: [{ agentId: 'assistant', label: 'Assistant', toolsetIds: ['notes'] }],
})
host.cfg(PiAgentPlugin).set({ defaultToolSetupId: 'assistant' })

const session = await host.require(PiAgentPlugin).createSession()
session.setGoal('Summarize the notes')
const result = await session.prompt('Complete the current goal')
await session.dispose()
```

Pi built-in filesystem/shell tools and default extension, skill, prompt-template and context discovery are disabled。每个
Pluxel command 被映射为 provider-safe Pi tool name，但执行 closure 始终调用同一个 bound `AgentCommandCatalog.execute()`。

会话和 goal 当前只在内存中保存。`pluxel_goal` 允许模型读取和更新 goal；`pluxel_subagent` 创建继承父会话
tool setup 的 bounded child，并受到深度、每会话数量、并发和总 session 限制。Plugin teardown 会 abort、等待 idle，
再 dispose 全部 root/child Pi sessions。直接调用 `spawnSubagent(task, { signal })` 时，signal 会取消排队或 child run，
不会释放 parent session。

完整设计见 [`DESIGN.md`](DESIGN.md)。
