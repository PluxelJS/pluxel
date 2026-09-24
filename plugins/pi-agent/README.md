# `@pluxel/pi-agent`

Pi embedded engine；复用 Agent Tools 的权限，提供内存会话、goal 与有界 subagent。

本包为 workspace 内部预览，不是仓库外项目的安装入口。

宿主 catalog 需要 PiAgentPlugin、AgentToolsPlugin；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../docs/plugins/pi-agent.md)
- [维护约束](DESIGN.md)
