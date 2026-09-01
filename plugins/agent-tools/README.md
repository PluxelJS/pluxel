# `@pluxel/agent-tools`

Pluxel 官方 Agent command allowlist 插件。它把统一 command catalog 中的稳定 command name 组合为 Toolset，
再把 Toolset 显式分配给 Agent；没有 assignment 的 Agent 默认看不到任何命令。

## 使用

```sh
pnpm add @pluxel/agent-tools @pluxel/commands @pluxel/runtime
```

把 `AgentToolsPlugin` 和业务 command 插件放进 host catalog，然后使用标准 Plugin config 声明策略：

```ts
import { AgentToolsPlugin } from '@pluxel/agent-tools'

host.cfg(AgentToolsPlugin).set({
	toolsets: [{ id: 'notes-read', label: 'Notes read', commandNames: ['notes.read'] }],
	agents: [{ agentId: 'assistant', label: 'Assistant', toolsetIds: ['notes-read'] }],
})
```

这里使用的是测试 host config handle；production static/dynamic host 通过自己的 ConfigService 管理同一 record。同一 schema 会出现在通用 Plugin 配置页。可选的
Agent tools Workbench Content 由宿主渲染，实时只读展示 published commands、Toolset、缺失 command、Agent assignment 和未分组 command；编辑仍走通用 Config 页面，不加载 Plugin 自有 React UI。

外部 Agent adapter 应是普通 Plugin，并通过 required dependency 取得受限 catalog：

```ts
import { AgentToolsPlugin, type AgentCommandCatalog } from '@pluxel/agent-tools'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin()
export class ExampleAgentPlugin extends BasePlugin {
	private catalog!: AgentCommandCatalog

	constructor(private readonly agentTools: AgentToolsPlugin) {
		super()
	}

	protected override init() {
		this.catalog = this.agentTools.catalog('assistant')
		const unsubscribe = this.catalog.subscribe((snapshot) => {
			// 把 snapshot.descriptors 投影为 provider tools；available=false 时撤销全部 tools。
		})
		return unsubscribe
	}

	executeTool(name: string, input: unknown) {
		return this.catalog.execute(name, input)
	}
}
```

adapter 自己负责 MCP/OpenAI/Claude 等 provider schema、工具名映射、身份、授权、确认、审计和输出呈现。
发布工具与执行调用必须使用同一个 bound catalog；绕过它调用裸 `ctx.commands.execute()` 会绕过 assignment。

Toolset 中暂时没有注册的 command name 会保留。对应 Plugin 以后发布同名 command 时，catalog subscription
会自动给出新 snapshot。配置更新不会取消已经进入 command owner admission 的调用，只影响之后的调用。

`snapshot()` 提供同一 catalog/policy 的 detached 诊断投影，可用于 provider 的 tool setup 选择器；它不是第二份
policy store。实际 tool call 仍必须通过对应的 bound catalog 执行。

完整边界见 [`DESIGN.md`](DESIGN.md)。
