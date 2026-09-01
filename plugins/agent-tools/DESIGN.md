# Agent tools 插件设计

`@pluxel/agent-tools` 只在 `@pluxel/commands` 的唯一 catalog 上建立 Agent allowlist 投影。它不定义
command、不复制 descriptor 或 handler，也不把 Agent、Toolset、provider annotation 或模型连接变成
Runtime capability。

## 所有权

- Toolset 与 Agent assignment 是普通 Plugin config，由 Pluxel ConfigService 统一校验、持久化和更新；
- Toolset 只保存稳定 command name，暂时缺失的命令仍留在 config，命令重新发布后自动进入投影；
- bound catalog 的发现与执行都读取同一份当前投影，执行在 dispatch 前再次检查 assignment；
- config update 原子替换完整投影，不取消已通过检查并进入 command owner admission 的调用；
- Plugin stop/replacement 后旧 catalog 立即投影为空并以 `ABORTED` 拒绝执行。

Agent provider Plugin 通过 constructor required dependency 消费 `AgentToolsPlugin`。它负责模型连接、principal
映射、确认、审计、provider tool schema/annotation、工具名映射和结果呈现。provider 必须同时使用 bound
catalog 的 `list()/subscribe()` 与 `execute()`，不能在 tool call 时改走裸 `ctx.commands.execute()`。

Workbench Content 和 `snapshot()` 都只读取这份 policy/catalog 投影。宿主渲染的 Content 通过现有 Workbench
session 接收 policy 与 command catalog 的更新，不保存编辑状态，也不需要 Plugin 自有 React renderer；Pi 等
provider 可以用 snapshot 列出可选 assignment，但发现和执行命令仍绑定到 `catalog(agentId)`。

## 有意不包含

- Runtime Context capability、Management RPC 或 Workbench 专用配置写入协议；
- 第二份 command registry、持久化 policy store 或独立 revision authority；
- MCP、OpenAI、Claude 等 provider contract；
- 自动发现全部 commands、按名称前缀隐式授权或默认 assignment；
- 对已经进入目标 command owner gate 的调用做追溯撤销。
