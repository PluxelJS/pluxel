# @pluxel/core

Pluxel 的 Plugin 内核，拥有依赖图、Plugin/Part 组成、配置事实、generation 生命周期、effects，以及固定 FS/TinyBase 能力和所选日志运行时。HTTP、来源发现、Vite 与宿主退出策略由其他层负责。

## 按任务进入

| 任务                    | 入口                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| 编写 Plugin、依赖与清理 | [插件模型](../../docs/plugin-development/model.md)                                                           |
| 组合 Part 与配置        | [PluginPart](../../docs/plugin-development/parts.md)、[配置](../../docs/plugin-development/configuration.md) |
| 修改内核                | [Core 约束](../../engineering/CORE.md)、[实现索引](IMPLEMENTATION_INDEX.md)                                  |
| 验证行为                | [插件测试](../../docs/plugin-development/testing.md)、[框架测试边界](../../engineering/TESTING.md)           |

## 入口边界

- `@pluxel/core`：Plugin 作者 API、Context 与 address/lifecycle 等只读公共契约。
- `/host`：独立 Core 宿主与 capability descriptor；配置日志后须先等待 `prepareCoreContext(root)`，生产 Host 自动执行此准备。
- `/services`：effects、config helpers、`EventsService` 与 `EvtChannel`。
- `/logger`：Context logger facade 与结构化 Plugin category。
- `/config`：`logtape()` 与 `zenfs()`，分别用于应用的 `runtime.logtape` 与 `runtime.zenfs`；helper 不获取资源。
- `/logging`：已配置 root 的 `Logging` token、日志 policy、store 与查询；`/logging/protocol` 提供浏览器安全的 DTO/filter，`/logging/internal` 仅供框架集成。
- `/logging/pretty`：按需使用的 console sink，保留插件身份与 Context 展示；文件输出直接使用 `@logtape/file`。
- `/fs`、`/fs/browser`：原生文件后端、借用类型与浏览器 IndexedDB 后端。
- `/internal/test`：Core 白盒测试；普通 Plugin 测试使用 `@pluxel/test`。

完整导出以 [package.json](package.json) 为准。Plugin facts 必须经过 Pluxel Vite/Rolldown semantic pass；不能用普通 TypeScript runner 或 constructor/class name 猜测依赖图。

Core 构建内联 `@pluxel/context` 的 JavaScript 和 declarations，消费者无需额外安装该 kernel。直接创建 standalone Context host 时才使用 [@pluxel/context](../context/README.md)；源码与发行依赖约束见 [Governance](../../engineering/GOVERNANCE.md)。
