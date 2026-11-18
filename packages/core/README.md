# @pluxel/core

Pluxel 的 Plugin 内核，拥有依赖图、Plugin/Part 组成、配置事实、generation 生命周期、effects，以及固定 FS/TinyBase/Vault 能力和所选日志运行时。HTTP、来源发现、Vite 与宿主退出策略由其他层负责。

## 按任务进入

| 任务                    | 入口                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| 编写 Plugin、依赖与清理 | [插件模型](../../docs/plugin-development/model.md)                                                           |
| 组合 Part 与配置        | [PluginPart](../../docs/plugin-development/parts.md)、[配置](../../docs/plugin-development/configuration.md) |
| 修改内核                | [Core 约束](../../engineering/CORE.md)、[实现索引](IMPLEMENTATION_INDEX.md)                                  |
| 验证行为                | [插件测试](../../docs/plugin-development/testing.md)、[框架测试边界](../../engineering/TESTING.md)           |

## 入口边界

- `@pluxel/core` 提供 Plugin 作者 API、Context、地址、生命周期和 `CoreFacilitiesConfig`、`CoreHostConfig`、`CoreExecutionConfig` 类型。
- `/host`：独立 Core 宿主与服务安装器；配置日志后须先等待 `prepareCoreContext(root)`，生产 Host 自动执行此准备。
- `/services`：effects 类型、错误与 guard、config helpers 和 `EvtChannel`；内建能力直接通过 `ctx` 使用。
- `/logger`：Context logger facade 与结构化 Plugin category。
- `/logging` 提供 `LogTapeConfig`、日志运行时类型、policy、store 与查询。已配置的运行时通过 `root.logging` 读取。`/logging/protocol` 提供浏览器安全的 DTO 和 filter，`/logging/internal` 供框架集成。
- `/logging/pretty`：按需使用的 console sink，保留插件身份与 Context 展示；文件输出直接使用 `@logtape/file`。
- `/fs`、`/fs/browser`：原生文件后端、借用类型与浏览器 IndexedDB 后端。
- `/vault` 提供内建凭据存储的配置、记录、管理状态类型与 `VaultError`。插件直接使用 `ctx.vault`，应用通过 `coreConfig.vault` 配置后端。
- `/internal/test`：Core 白盒测试；普通 Plugin 测试使用 `@pluxel/test`。

完整导出以 [package.json](package.json) 为准。Plugin facts 必须经过 Pluxel Vite/Rolldown semantic pass；不能用普通 TypeScript runner 或 constructor/class name 猜测依赖图。

Core 构建内联 `@pluxel/context` 的 JavaScript 和 declarations，消费者无需额外安装该 kernel。直接创建 standalone Context host 时才使用 [@pluxel/context](../context/README.md)；源码与发行依赖约束见 [Governance](../../engineering/GOVERNANCE.md)。
