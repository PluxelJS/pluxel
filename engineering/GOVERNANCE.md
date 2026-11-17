# 仓库治理：依赖、导出与验证

本页维护 workspace、依赖和公开入口规则；执行入口是 `vp run governance:check` 与 `vp run verify`。任务编排见[工作区工具链](../docs/development/workspace-toolchain.md)，发布见 [Releasing](RELEASING.md)。

## 依赖方向

```text
Core <- Host <- Services（能力、管理、官方组合）
          ^         ^
          |         +-- Workbench（展示、会话、UI）
          +-- Host-vite <- Services /vite
Commands <- Services
```

箭头从消费者指向提供者，描述具体模块职责。Services 的 `/preset`、`/vite` 选择官方组合与可选 Workbench；Workbench 消费 Services 的管理、HTTP 等叶子入口。Services 叶子与 Workbench 都不反向加载组合入口。Host-vite 拥有 Vite 执行和更新协议，服务选择归应用。

包级 Services ↔ Workbench 引用需按入口求值、可选依赖加载和资源所有权检查。发布包之间允许不同方向的叶子引用；拆包应有独立职责。必须保持 Context 无 Core/Host/IO/lifecycle、Core host-free、config persistence 归 Host。Host `/sources` 是纯声明，Native 与 Host-vite 消费同一来源契约和 Core lifecycle。

Rolldown 是 build-time tooling，消费 Core lowering ABI 与 federation contract；Host-vite 使用其编译实现，CLI 按命令加载。CLI 负责编排，库 API 由原领域包直接提供。

## Workspace 与目录

`pnpm-workspace.yaml` 是 workspace 成员与外部版本政策的唯一来源，根 manifest 不重复 `workspaces`。

| 目录                              | 角色                                                                |
| --------------------------------- | ------------------------------------------------------------------- |
| `packages/*`                      | 框架库、contract、adapter、服务包；服务可有显式 `/plugins` 配套入口 |
| `plugins/*`、`plugins/<domain>/*` | 可独立装配的具体 Plugin package；领域目录只负责分类                 |
| `projects/*`                      | 必须随框架演进的维护者宿主                                          |
| `vendor/*`                        | 显式接入的上游源码，遵循其自身目录语义                              |

contract/adapter 即使引用 runtime 类型仍可位于 packages；独立具体 Plugin 位于 plugins。服务基础入口保持独立，配套插件从 `/plugins` 选择。框架回归夹具归各包，跨运行环境的应用实验归独立 [Pluxel Lab](https://github.com/PluxelJS/lab)，由其拥有 lockfile、CI 和验收。产品仓库可按需用 `platforms/*` 隔离平台能力与 bridge。

官方 Shell 位于 `packages/workbench/shell/`，拥有 TypeScript 与 Vitest 配置，随 Workbench 编成静态资源。Shell 专用依赖放在 Workbench devDependencies。

## 依赖与版本

根 package 只负责编排和共享质量工具，不声明 dependencies，也不直接链接 workspace 包或 vendor。每包声明自身直接依赖，catalog 管版本政策，hoist 只处理工具兼容与实例去重。

| 依赖语义                                | 源码声明                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| semver-compatible 第一方实现            | `workspace:^`；确需同版本的 wrapper 才用 `workspace:*`                             |
| 外部实现                                | `catalog:` / `catalog:<name>`，普通稳定版本优先 `^`，实际解析由 lockfile 固定      |
| Plugin 的 Core、服务、required provider | 可发布 provider 使用 `workspace:^` peer，并配 `workspace:*` dev 副本               |
| workspace-only provider                 | `*` optional peer，加指向实际包目录的相对 `link:` dev 副本；发行 JS/声明不可引用它 |
| 可选集成                                | 仅在独立可选入口或条件加载后声明 optional peer                                     |

peer 表示需要共享的运行时身份或平台兼容边界，如 Context、服务 token、Plugin constructor、React Context 和 lowering ABI。自有解析器、watcher、缓存等实现使用 dependencies；声明文件仍引用的包也须有发布依赖。dev-only 适用于工具、夹具和明确内联的源码。

pncat 拥有 catalog 与引用的新增、更新、分组和清理，避免分别手写 YAML 与 manifest。Peer 范围表达兼容承诺，不能随实现版本统一收窄。npm alias 的目标范围使用 `^`；预发布、供应链 pin 与确有约束的 selector override 可保留精确值。

精确版本的边界包括 Workbench Profile 的 MF Vite/runtime/SDK/React bridge、Mantine core/hooks 和 Cap’n Web peer/dev；矩阵由 `packages/core/src/federation.ts` 与 transport admission 维护，升级时一起更新并重建 producer。`@platformatic/vfs` 当前保留 `^0.4.0`，因为 0.5.0 被 no-downgrade 发布信任检查拒绝。

生成的应用和独立 Plugin 拥有各自最小 pnpm workspace、catalog 与 `allowBuilds` 政策，并逐包声明直接依赖。包发布时 catalog/workspace 引用转换为 semver。未发布源码协作使用 [pluxel source](CLI_WORKSPACES.md)，机器路径由 registry 和 `.pluxel/` 代理管理。

公开包不可要求 workspace-only provider 的 registry 版本，也不可为 pack 虚构版本或发布私有包。Vite Task 不从 `link:` 推导 workspace 构建关系，consumer 须在自己的任务配置声明开发 provider 的 `compile` 前置。

### pncat 的版本维护边界

[vendored pncat](../vendor/pncat/UPSTREAM.md)负责解析和写入。根 `vp run pncat` 运行其源码 CLI；私有包名为 `@pluxel-internal/pncat`，避免 source 按名称覆盖外部 npm pncat。`vp run catalog:check` 是无 registry IO 的只读计划，漂移时非零退出；`vp run pncat migrate` 显式迁移裸版本。批量同步使用 `/sync` plan/apply API，复用同一 writer。

核心 workspace YAML 拥有共享外部政策。CLI Git 模式读取所属 checkout，发行版携带构建快照；消费仓库继续拥有成员、lockfile 和直接依赖，只同步已有 catalog，不新增依赖或写 package.json。未迁移的裸版本先执行 migrate。多个普通 catalog 对同包冲突时要求显式选择；peer-only catalog 保留范围，共享更新会改变 peer 时报告冲突。核心维护者显式升级自己的兼容承诺时可关闭 peer 保护。

workspace/file/link 不转换为 registry 范围。catalog 只统一声明，nominal/private 类型需要物理同实例时由 source singleton 管理。只读检查不安装、不写文件；apply 前核对输入与成员变化，只写目标 YAML。原生迁移等多文件操作没有 workspace 事务，安装是后续步骤。消费端操作见[源码工作区指南](../docs/development/source-workspaces.md)。

### 发布图、构建图与共享身份

发布图包括 dependencies、optionalDependencies 和 peerDependencies。治理扫描 packages、plugins、projects 的实际内部 import（含 type/dynamic）：公开包须有发布声明，私有项目须有本包声明。Services 组合限于 `src/preset.ts`、`src/vite.ts`、`src/development/service-development.ts`，测试组合归 `src/testing/` 与两个测试入口。测试和类型探针不属于发布源。

构建图显式决定可执行顺序。测试夹具可依赖被测框架，Core 构建也用官方工具链；不将整个 package 图机械转换成 task 前置。

Core 对 Context 与 [Eventure](../vendor/eventure/UPSTREAM.md)的复用是构建源码边界：两者以 devDependency 链接，用 tsdown `alwaysBundle` 内联 JS 与声明。Core tarball 中不可留下外部 import 或发布依赖。直接使用 standalone kernel 才安装 `@pluxel/context`；修改 Eventure 同时核对 vendor 回归和 Core 打包消费。

Workbench fixed singleton set 由 host 安装并由 MF build contract 精确锁定：React/ReactDOM 及实际 subpath、Mantine core/hooks、MF React Bridge、Workbench 根、`/client`、`/react`、`/internal/react`。Plugin UI 把自己 import 的 React/Mantine 声明为 peer，独立开发时配 dev 副本。query-core 仅为 renderer owner 内部实现。每个使用 Drizzle 的包直接声明 drizzle-orm；只在确需共享身份的公开边界使用 peer。

Host 互操作按具体能力接纳：Workbench target/基础库使用精确 capnweb peer；交换原生 Store 的 TinyBase 消费者使用精确 tinybase peer，开发均配同版 dev 副本。Core 拥有 TinyBase 的精确普通 dependency；只调用 `ctx.tinybase.open()` 无需另装。升级 TinyBase 时同步 Core、共享消费者和制品事实。

`@pluxel/host/internal/shared-runtime` 是 Node metadata 叶子，拥有 manifest、catalog、版本和接纳检查，不加载 Core/Services/Workbench runtime。构建生成 `pluxel.workbenchCapnweb` / `pluxel.tinybase`；Vite、静态应用与 native 动态来源先核验声明及实际安装，再绑定同版解析。TinyBase 子路径按原名解析；应用私有副本与无关依赖保持隔离，普通 import 本身不构成互操作声明。

### 治理与验证

`vp run verify` 委托 `workspace:verify`，本地与 CI 使用同一任务图。各包 scripts 委托 compile/check-types/check-tests 等任务，具体命令与依赖由本包 `vite.config.ts` 拥有，共享默认由 `scripts/vite-tasks.ts` 提供。`workspace:build` 完成后检查源码声明污染，verify 复用该结果。

CI 以原生聚合任务和显式并发数执行，记录实际任务、缓存命中和日志；缓存位于当前 checkout 的 `node_modules/.vite/task-cache`，输入须涵盖影响产物的配置和环境。命令及工具 pin 见[工作区工具链](../docs/development/workspace-toolchain.md#统一命令入口)。Vite+ 按 `packageManager` 选择包管理器；CI 使用 `PNPM_CONFIG_PM_ON_FAIL=ignore`，任务透传已有 pnpm 上下文，跨仓库 source 将 `PNPM_CONFIG_WORKSPACE_DIR` 绑定当前 checkout。

| 所有者                                    | 检查内容                                                      |
| ----------------------------------------- | ------------------------------------------------------------- |
| `scripts/repository-packages.mjs`         | 实际 workspace inventory、目录角色、公开包与 Tegami 集合      |
| `scripts/check-repository-governance.mjs` | catalog、工具 pin、metadata、依赖范围、实际 import 与模块边界 |
| 包内 `typecheck`                          | 本包源码、测试、benchmark、构建配置与公开类型                 |
| 包内 `test`                               | Vitest 行为回归，选择方法见 [Testing](TESTING.md)             |
| `scripts/check-source-declarations.mjs`   | ambient declaration allowlist 与源码污染                      |

每包声明 typecheck，默认一份 tsconfig 覆盖本包输入。环境或声明构建确需隔离时再拆配置；共享工具由 `scripts/tsconfig.json` 和根 workspace:typecheck 检查。外部环境类型从 `compilerOptions.types` 加载。纯 Node fixture 可以用 Node assert，测试统一由 Vitest 编排。

生成声明只进入 dist 或可清理缓存；ambient declaration 逐文件登记。源码检查只排除明确的原生依赖 checkout（Typst `native/.build/`、Embedded Launcher `native/vendor/`）。生成项目的 workspace doctor 检查 pnpm major、workspace authority 与 source hook，产品领域规则由消费仓库维护。

Tegami 与治理共用 inventory。已有 Markdown 的目标必须是公开包；有待发布计划时检查统一版本与新包的初次 major intent。没有发布计划时，日常治理不要求新增发布说明。一次性迁移扫描器在完成后删除，当前边界由 exports 和领域测试维护。

## 导出

入口按稳定用户概念、环境与可选依赖划分，同一依赖边界的重复入口合并。合并前核对传递加载，保持 browser、基础服务、生产入口各自的环境边界。默认入口使用 allowlist；内部协作使用窄的显式 `/internal`，测试优先相对源码，跨包白盒使用 `/internal/test`。旧设计不留兼容 alias。

- Context 默认入口提供 descriptor、scoped installation、`createContextHost()`、projection types 与显式 resolve；raw plan/context construction 归 `/internal`。编译后无 capability mutator；编译前 overrides 只能替换同 descriptor 并保持 scope/property。
- Core 默认入口提供 Plugin 作者模型、服务 token 类型/读取错误、address codec 和 Host 使用的 lifecycle result。slot 最多作为 opaque type；registry、record reader、construction/lifecycle adapter、lowering setter、test host 与 PluginService 归内部。Federation contract 归 `/federation`，服务组合归 `/host`。
- Host/Services 不重导出 Core 作者面。RootContext 读取 root token，owner Context 不直接读取；持有真实 root 代表宿主访问权，不能当作沙箱。graph/state helper 归 Host internal。
- Browser Management 归 `@pluxel/services/management/client`。Plugin 直接使用 capnweb/Workbench，React 由 Workbench 子入口提供。Bridge ABI 归 internal，raw registry 与 MF Runtime 不进入作者默认入口。
- Dynamic source 的 low-level public boundary 是 Host `/sources` 声明校验，保持无 Vite、watcher、scanner 和 package manager。固定 Plugin 从应用 `plugins` 声明进入。

## 变更与文档

实现、exports、调用方、测试和示例保持一致。文档归属与写作见 [Documentation](DOCUMENTATION.md)，贡献接纳见 [Contribution Review](CONTRIBUTION_REVIEW.md)。代码集成使用 `vp run verify`；文档整理检查内容、链接与格式。版本 PR 和发布操作见 [Releasing](RELEASING.md)。
