# `@pluxel/agent-tools`

Agent command allowlist；以 Toolset 和 assignment 投影统一 command catalog。

在直接导入它的包目录安装（catalog 工作区见下方指南）：

```sh
pnpm add @pluxel/agent-tools
```

宿主 catalog 需要 AgentToolsPlugin；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../docs/plugins/agent-tools.md)
- [维护约束](DESIGN.md)
