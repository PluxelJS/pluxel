# Testing Architecture

测试应验证最小仍承载风险的产品边界，而不是复制实现调用。Plugin 作者的选择和示例由
[`docs/development/testing.md`](../docs/development/testing.md) 定义；本文只记录维护测试内核时需要保持的边界。

## Boundary selection

- 普通对象和纯领域规则不创建 host。
- Core graph、config、lifecycle 和 effects 使用 `@pluxel/core/test`。
- 使用宿主服务的 Plugin 使用 `@pluxel/services/test`；public host 不暴露 root Context、transaction 或 backend。
- static application 只验证 application wiring；dynamic source、Vite/HMR、physical HTTP/WebSocket 使用 production launcher 或项目 Vite command。

同一个 Plugin behavior 只在它最小的 owning boundary 断言一次。删除外层 route、artifact 或 carrier 后仍成立的断言必须回到更小的 host；真实
carrier、browser 和 deployment 行为仍要在各自真实边界验证。

## Service test host

`@pluxel/services/test` 的 `createServiceTestHost()` 直接组合 `createHost()`；Core 作者符号从 `@pluxel/core/test` 导入，不通过服务入口转发。
省略 `services` 时安装 HTTP、commands、Node artifacts、workers 与内存 persistence；显式列表完整替代默认值，不按名称合并。
`management` 是显式测试交互平面选择；HTTP 默认组合需要消费项目安装 Elysia。`services: []` 的基础入口不加载 HTTP 或 UI 包。
Workbench 作者使用 `@pluxel/workbench/test` 的 `createWorkbenchTestHost()`；它复用同一个服务 host 的事务和生命周期，独立持有 Workbench 会话并报告未释放 lease。
Vault、数据库和管理命令使用真实服务工厂显式安装。
`config`、`state`、`configRecords` 分别使用 Core 和 Host 原有契约，不再解释另一套产品配置。

事务 draft 只负责测试断言、目标校验与同步回调作用域；catalog、状态修改、配置应用与 graph commit 仍由 Host 唯一 authority 执行。
测试 HTTP 与 Workbench driver 拥有本次测试打开的响应 body、RPC handle 和 lease；泄漏会在关闭时报告，所有清理仍然执行。
Service host 关闭时同步拒收所有操作，等待 owner invocation drain，再通过内部 `beforeClose` 接缝释放 Workbench lease，最后清理 body、graph 与服务。Workbench 组合直接复用这一关闭流程。
framework 白盒 fixture 从 `@pluxel/services/internal/test` 导入，不能成为普通 Plugin 的业务依赖或在线运行状态的替代。

## Vitest preset and bootstrap

`@pluxel/test/vitest` 是唯一的 Pluxel Vitest preset entry。`definePluxelVitestConfig()` 接受一个 Vite-compatible object：原生
Vite/Vitest fields 保持顶层，Pluxel source lowering/extraction options 位于会被 preset 消费的 `pluxel` namespace。不要保留第二个
options 参数、root entry alias 或相对 source preset import。

Vitest/Vite 在 preset 能返回 `resolve.conditions` 之前先求值 `vitest.config.ts`。因此 source overlay 的 workspace test task 必须先运行
`pluxel source build --package @pluxel/test`，再通过已发布 package export 载入 preset；不能用相对 `src` import 或 process-wide
condition 绕过这一步。该命令只交给 `@pluxel/test` 自己的 build graph 处理 bootstrap artifact 与其真实前置，不预构建整个 source
closure 或业务服务。config 已加载后，preset 为 test module graph 设置 `@pluxel/source` / `@pluxel/hmr` conditions。

## Verification ownership

`scripts/check-testing-v2-migration.mjs` 保护已删除 API、Vitest 5 baseline、public test boundaries、official package/template migration 和
relative preset bootstrap。它是防回归门禁，不替代 product behavior tests。

## CI scheduling and cache

根目录只声明外部编排工具；workspace 工具依赖由实际消费包声明。Turbo 会把根目录 workspace 依赖的传递源码计入所有任务的全局
hash，把 CLI 或 test helper 放回根依赖会让一次 core 测试修改清空整个仓库的缓存。仓库根 CLI 入口使用 `pnpm pluxel`。

CI 按整个 PR 相对目标分支的变化选择包，在双核 runner 上并行两个 package task。保留真实 Redis、Vite 和子进程集成覆盖；每次运行上传
Turbo task summary，分别观察缓存命中、任务耗时和冷构建成本。小改动应复用无关任务的结果，首次运行和公共运行时变更仍可能需要广泛验证。
Core benchmark 跟踪 core、Context、基准场景与构建依赖变化；仅修改测试或 Markdown 文档不触发完整的同 runner 对比。

在改变 shared test surface、package export、runner config 或 test host lifecycle 后，先运行直接 owner test，再运行
`pnpm testing-v2:check`；稳定合并边界运行 `pnpm verify`。测试数量不是目标：每个 case 都应保护一个当前 public contract、资源所有权或
已观察的失败模式。
