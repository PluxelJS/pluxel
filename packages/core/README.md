# @pluxel/core

Pluxel 的 Plugin 内核，拥有依赖图、Plugin/Part 组成、配置事实、generation 生命周期和 effects。HTTP、持久化、来源发现、Vite 与宿主退出策略由其他层负责。

## 按任务进入

| 任务                    | 入口                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| 编写 Plugin、依赖与清理 | [插件模型](../../docs/getting-started/plugin-model.md)                                                        |
| 组合 Part 与配置        | [PluginPart](../../docs/getting-started/plugin-parts.md)、[配置](../../docs/getting-started/configuration.md) |
| 修改内核                | [Core 约束](../../engineering/CORE.md)、[实现索引](IMPLEMENTATION_INDEX.md)                                   |
| 验证行为                | [插件测试](../../docs/development/testing.md)、[框架测试边界](../../engineering/TESTING.md)                   |

## 入口边界

- `@pluxel/core`：Plugin 作者 API、Context 与 address/lifecycle 等只读公共契约。
- `/host`：Host 服务作者使用的 token 与 capability descriptor。
- `/services`：effects、config helpers、`EventsService` 与 `EvtChannel`。
- `/logger`：Context logger facade 与结构化 Plugin category。
- `/internal/test`：Core 白盒测试；普通 Plugin 测试使用 `@pluxel/test`。

完整导出以 [package.json](package.json) 为准。Plugin facts 必须经过 Pluxel Vite/Rolldown semantic pass；不能用普通 TypeScript runner 或 constructor/class name 猜测依赖图。

Core 构建内联 `@pluxel/context` 的 JavaScript 和 declarations，消费者无需额外安装该 kernel。直接创建 standalone Context host 时才使用 [@pluxel/context](../context/README.md)；源码与发行依赖约束见 [Governance](../../engineering/GOVERNANCE.md)。
