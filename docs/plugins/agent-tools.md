---
title: Agent tools
description: 用可选官方 Plugin 把统一 command catalog 安全投影给外部 Agent adapter。
---

`@pluxel/agent-tools` 用于需要把一部分 Pluxel commands 暴露给外部 Agent 的应用。它是普通、可停用的
官方 Plugin，不是 Runtime capability：只有把它加入 host catalog 并启动后，才会存在 Toolset、assignment 和受限 catalog。

```sh package-install
npx nypm add @pluxel/agent-tools @pluxel/commands @pluxel/runtime
```

## 配置 Toolset 与 Agent

Toolset 保存稳定 command name，Agent 得到所分配 Toolset 的并集。没有 assignment 的 Agent 默认没有任何命令：

```ts no-twoslash
import { AgentToolsPlugin } from '@pluxel/agent-tools'

host.cfg(AgentToolsPlugin).set({
	toolsets: [
		{ id: 'notes-read', label: 'Notes read', commandNames: ['notes.read'] },
		{ id: 'notes-write', label: 'Notes write', commandNames: ['notes.create'] },
	],
	agents: [{ agentId: 'assistant', label: 'Assistant', toolsetIds: ['notes-read'] }],
})
```

这是测试 host 的配置写法；production host 通过 ConfigService 管理同一个 Plugin record。配置使用标准
Plugin schema，所以会自动得到持久化、服务端校验、运行中更新和通用 Plugin 配置页面。

Workbench 启用时，插件还会发布只读 Agent tools 页面，分组展示当前 commands、Toolsets、缺失 command、
Agent assignments 与未分组 command。该页面不保存第二份策略，修改仍进入通用 Config 页面；headless host 的行为不变。

暂时没有注册的 command name 会保留在 Toolset；以后有 Plugin 发布同名 command 时，受限 catalog 自动更新。

## 编写外部 Agent adapter

MCP、OpenAI、Claude 或其他 provider adapter 应建模为普通 Plugin，并把 `AgentToolsPlugin` 写成 constructor required dependency：

```ts no-twoslash
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
		return this.catalog.subscribe((snapshot) => {
			// available=false 时从 provider 撤销全部 tools。
			publishProviderTools(snapshot.descriptors)
		})
	}

	executeTool(name: string, input: unknown) {
		return this.catalog.execute(name, input)
	}
}
```

发布工具和执行 tool call 必须使用同一个 bound catalog。`execute()` 会在 dispatch 前重新检查当前 assignment；
`AgentToolsPlugin` stop/replacement 后，旧 catalog 投影为空并以 `ABORTED` 拒绝执行。已经通过检查并进入目标
command owner admission 的调用不会被配置更新追溯取消。

adapter 自己负责 provider schema 与 annotations、tool name 映射、principal、授权、确认、rate limit、审计和输出呈现。
这些概念不会进入 `@pluxel/commands` 或 Runtime。

provider 需要构建 tool setup 选择器时，可以读取 `agentTools.snapshot()`。返回值是 detached 的诊断投影，包含
policy/catalog revision、Toolsets、assignments 和命令摘要；选择之后仍应创建 `catalog(agentId)`，并让发现与执行都走该 catalog。
