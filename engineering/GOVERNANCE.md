# 仓库治理：依赖、导出与验证

修改模块依赖先读[依赖方向](#依赖方向)；移动 package 读 [Workspace 与目录](#workspace-与目录)；修改 manifest 读[依赖与版本](#依赖与版本)；增加入口读[导出](#导出)。仓库验证由 `pnpm governance:check` 与 `pnpm verify` 拥有，发布流程见 [RELEASING](RELEASING.md)。

## 依赖方向

```text
Core <- Host <- Services（基础能力、管理、日志、官方组合）
          ^         ^
          |         +-- Workbench（展示、会话、UI）
          +-- Host Dev <- Services /vite
Commands <- Services
```

箭头从消费者指向提供者；图只画模块职责，不把 npm 包视作严格的分层单位。
Services 的 `/preset`、`/vite`、`/build` 拥有官方组合，可以选择 Workbench；
Workbench 只消费 Services 的管理、HTTP 等领域叶子入口，不能反向导入这三个组合入口。
Services 的管理、日志和基础模块也不能依赖组合入口。Host Dev 只拥有 Vite 环境与开发协议，不选择官方服务。

包级 `Services ↔ Workbench` 引用表示两个发布单元之间存在不同方向的模块引用，不等于模块初始化循环，
更不等于生命周期互相拥有。判断时分别检查：具体入口是否读取尚未初始化的值、可选入口是否被无条件加载、
资源是否由唯一 Host/owner 创建和释放。不能为消除包图中的箭头而创建没有独立职责的新包。

`@pluxel/rolldown` 是 build-time tooling，消费 Core 的 lowering ABI 和 federation contract；
CLI 按命令可选消费它，Host Dev 消费其编译实现。Core 不通过发布依赖反向引入构建工具。
`@pluxel/context` 的源码复用和下文的测试依赖是开发图，不是上述发布图的一层。

必须保持：context 不依赖 Core/Host/IO/lifecycle、core host-free、Host 的 `/dynamic` 实现来源契约、来源接入不复制 lifecycle、config
persistence 不进入 core。CLI 是按命令加载的编排层，不作为 runtime 或 toolchain library API 的转发门面。

## Workspace 与目录

`pnpm-workspace.yaml` 是唯一 workspace 成员和外部版本政策来源；根 `package.json` 不重复
`workspaces`。目录表达 package 的角色，而不是团队或功能名称：

```text
packages/*              框架库、contract、adapter 与可含配套 /plugins 的服务 package
plugins/*               可独立装配的具体插件 package
plugins/<domain>/*      共享明确能力链的具体插件 package
projects/*              必须随框架一起演进的可运行维护者宿主
vendor/*                明确纳入的上游源码；不套用第一方目录语义
```

判断依据是所有权而不是“是否导入 Pluxel”：contract 或 adapter 即使依赖 runtime 类型，只要不声明
具体 `@Plugin`，仍可位于 `packages/*`；服务包可通过显式 `./plugins` 入口提供配套插件，基础服务入口不反向加载该入口。独立分发的具体插件 package 位于 `plugins/*` 或
`plugins/<domain>/*`。领域目录只表达仓库分类，不创建隐式依赖、聚合插件或新的公开入口。Pluxel
仓库内可运行 host 位于 `projects/*`，当前只保留维护者宿主。
官方浏览器 Shell 属于 `packages/workbench/shell/`，拥有独立 TypeScript 与 Vitest 配置；它随 Workbench 编译成静态资源，
不另建 workspace 包。仅用于 Shell 构建的依赖放在 Workbench devDependencies，不扩大 SDK 的安装依赖。产品项目使用独立 workspace；其中可按
领域需要使用 `platforms/*` 隔离外部平台 capability 与直接 bridge。

## 依赖与版本

根 package 只负责编排和共享质量工具，不声明 `dependencies`。pnpm catalog 统一重复外部依赖的版本
政策；每个 workspace 仍必须在自己的 `dependencies`、`devDependencies` 或 `peerDependencies` 中声明
实际使用的包。hoist 只用于工具兼容和实例去重，不构成依赖声明。

- semver-compatible 的第一方实现依赖使用 `workspace:^`，确保开发时链接当前源码，发布后允许同 major
  的修复和功能版本；只有必须锁定同版本的 wrapper 使用 `workspace:*`。
- catalog 管理的外部依赖使用 `catalog:` 或 `catalog:<name>`。仓库已有 `pncat.config.ts` 时，pncat 是新增、
  迁移、重新分组和清理 catalog 的唯一修改入口；不得分别手改 workspace catalog 与 package 引用。
- CLI 生成的独立应用把发布版 `@pluxel/*`、React、工具链等范围放进自己的 catalog；生成的
  workspace 之间仍逐包声明直接依赖。
- standalone plugin 模板使用最小单 package pnpm workspace，让 catalog 与 `allowBuilds` 安全政策有明确
  所有者；发布时 pnpm 把 catalog 引用转换为正常 semver 范围。
- 独立仓库共同开发未发布源码时使用 `pluxel source`；项目提交 repository identity 和正常
  catalog/semver，机器 checkout 路径只进入用户 registry 与 `.pluxel/` 代理。不得手写跨仓库 `link:`
  override 或链接另一个 checkout 的 `node_modules`。
- peer 表示必须与应用共享的运行时身份或平台兼容边界，例如 Core Context、Host 服务 token、Plugin constructor、
  React Context 与编译器 lowering ABI。包自身拥有的解析器、文件监视器、查询缓存等实现使用 dependencies。
  只有类型引用不构成必须使用 peer 的理由；发布声明仍需引用的包可以是 dependencies 或 peer，依据实际兼容与所有权选择，
  不能直接降为 dev-only。不要按 `@pluxel/` 前缀机械迁移整个依赖表。
- Plugin package 在源码中使用
  `workspace:^` 消费 Core、服务和 provider contract，发布后由 pnpm 转换为各包对应的 semver 范围；本地构建/测试
  副本同时以 `workspace:*` 放入 `devDependencies`，不得把 provider 放入普通 dependencies 形成第二份
  Plugin identity。
- 真正隔离在可选入口或条件加载后的集成可以标记 optional peer。optional 只影响安装要求，既不消除架构边，
  也不允许无条件入口加载缺失的包。`devDependencies` 只承载开发工具、测试夹具和已明确内联的源码；
  不能用它隐藏发布 JavaScript 或 declarations 仍引用的包。

### 发布图、构建图与共享身份

发布依赖声明包含 `dependencies`、`optionalDependencies` 和 `peerDependencies`，不要求整个包图无环。
`governance:check` 保留 Context、Core、Commands、Host 与来源/开发驱动的基础边界，扫描 `packages/`、`plugins/` 和
`projects/` 源码的实际内部 workspace import（含类型和动态 import）：发布包必须有发布依赖声明，私有项目必须在本包
声明依赖；缺失时定位到导入文件和清单。它也检查 Workbench、Services 叶子不反向导入 Services 组合入口。
组合实现只位于 `src/preset.ts`、`src/vite.ts`、`src/build.ts` 与 `src/development/service-development.ts`；
测试组合位于 `src/testing/` 及两个测试入口。测试和类型探针不算发布源，Core 内联 Context 是明确例外。
这些规则保护可核对的模块职责，不维护一个第二模块解析器或通用架构分层框架。

构建任务图是另一个问题：测试夹具可能依赖被测框架，Core 的构建也使用官方 toolchain。
Turbo 任务必须有可执行的顺序，不能把所有 package dependency 都机械转换成构建前置任务，
也不能调整发布依赖类型来掩盖任务编排问题。

`@pluxel/core` 源码对 `@pluxel/context` 的复用是构建时源码边界：Core 将其声明为 `devDependencies: workspace:*`，并用
tsdown `alwaysBundle` 内联所有 JavaScript 与 declarations。发布 tarball 不得含外部 `@pluxel/context` import，也不得把它加入
Core 的 dependencies/peerDependencies/optionalDependencies；直接使用 standalone kernel 的应用才显式安装 `@pluxel/context`。

Workbench fixed singleton set 由 host 直接安装并由 MF build contract 精确锁定：React/ReactDOM 及其实际
subpaths、`@mantine/core`、`@mantine/hooks`、MF React Bridge、`@pluxel/workbench`、`/client`、`/react` 与
`@pluxel/workbench/internal/react`。插件 UI 把自己 import 的 React 和 Mantine 声明为 peer，并在需要独立开发时声明
dev 副本。`@tanstack/query-core` 只是 Workbench renderer owner 的内部实现依赖，不进入 platform shared set。导入 Drizzle schema/query API 的每个 package 都直接声明
`drizzle-orm`；它与 Pluxel 高度集成并不意味着能从工作区根或其他 framework 包 隐式继承。只有确实要求宿主
共享 Drizzle 运行时身份的公开边界才改用 peer。

### 治理与验证

`pnpm verify` 是本地与 CI 的共同入口，顺序执行治理、lint、format、Turbo typecheck/build/test，再检查构建是否把声明写入源码。CI 只提供并发数、affected filter 与 summary；构建配置不依赖未计入 Turbo hash 的环境开关。只缓存 `.turbo/cache`，本次报告 `.turbo/runs` 不跨运行复用。

| 检查所有者                                | 负责的事实                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `scripts/repository-packages.mjs`         | workspace inventory、目录分类、公开包与 Tegami 发布集合                     |
| `scripts/check-repository-governance.mjs` | workspace/catalog、工具版本、metadata、依赖范围、实际内部 import 与模块边界 |
| package `typecheck`                       | 本包源码、测试、配置及公开类型；上游 declaration build 不替代本包检查       |
| package `test`                            | Vitest 行为回归；边界选择见 [TESTING](TESTING.md)                           |
| `scripts/check-source-declarations.mjs`   | 显式登记的 ambient declarations；生成声明只进入 dist 或可清理缓存           |

治理与 Tegami 消费同一份 inventory。迁移完成后移除一次性扫描器；不要把历史 API 黑名单、源码片段或旧提案名称变成永久架构概念。当前契约由 exports、编译器和所属边界的行为测试维护。

各 workspace 必须声明自己的 `typecheck`，`tsconfig` 覆盖本包源码、测试和构建配置。外部环境类型由 `compilerOptions.types` 加载。测试统一由 Vitest 编排；纯 Node fixture 可以使用 Node assert，不另设 `node --test` runner。

生成的 workspace 由 `pluxel workspace doctor` 检查 pnpm major、workspace authority 与已激活的 source hook；产品目录和依赖方向由其自身治理脚本拥有。通用 CLI 不推断产品领域规则。

## 导出

- public export 必须对应稳定用户概念；
- internal/helper/debug 默认不导出；
- 入口按稳定领域、运行环境和可选依赖划分，不按实现目录或文件逐项导出；同一依赖边界的重复入口应合并；
- 包内测试直接使用相对源码路径，不为测试便利增加 package exports；跨包白盒测试使用窄的 `/internal/test`；
- 框架间协作集中在显式 allowlist 的 `/internal`；只有浏览器 ABI、HTTP 适配等真实依赖边界才拆分 internal 子入口，不使用 wildcard 暴露实现树；
- 合并入口前核对传递依赖，不能让 browser 入口引入 Node、基础服务引入可选 backend，或生产入口引入开发工具；
- 不为已删除设计保留兼容 alias；
- toolchain helper 只能从 toolchain/internal subpath 使用。

`@pluxel/context` 默认入口公开 host composition 所需的 opaque descriptor、scoped installation、`createContextHost()`、
projection types 与显式 resolve；raw plan/context construction 只从 `/internal` 提供给框架实现，不是稳定第三方入口。
`ContextHost` 编译后没有 capability mutator，公开 `overrides` 也只能在编译前替换相同 descriptor 且保持 scope/property。

`@pluxel/core` 默认入口使用逐项 allowlist；Host 与服务包不重新导出 Core 作者面。默认入口只承诺 Plugin 作者模型、服务 token 类型与读取错误、结构化 address codec 与 host
确实消费的 lifecycle result。`PluginService`、slot registry、record reader、construction/lifecycle adapter、coordinator、lowering setter 和 test host
不得从默认入口可达；opaque slot 最多以 type-only contract 出现。Federation build contract 只从 `@pluxel/core/federation` 消费。

Core 的服务作者组合入口为 `@pluxel/core/host`；Host 在 root 创建前安装固定 descriptor，插件不能追加或替换能力。
RootContext 的 require 可以读取 root token；owner Context 不能直接读取 root token。持有真实 root 引用代表宿主访问权，这不是代码沙箱。
默认入口不使用 star barrel 扩张 surface。内部 graph/state helpers 属于 `@pluxel/host/internal`；服务内部实现由各领域包拥有。
Browser Management 使用 `@pluxel/services/management/client`；Plugin 直接使用 capnweb 与 `@pluxel/workbench`，React 接入位于 Workbench 子入口。
Generated Bridge ABI 属于 Workbench internal，raw server registry 和 MF Runtime 不进入默认作者 API。

Dynamic source producer 的唯一 low-level public boundary 是 `@pluxel/host/dynamic/source-producer` 的声明校验；它不得导入
Vite、watcher、workspace scanner 或 package manager。固定 catalog 从统一应用声明的 `plugins` 进入，不提供 package、
module、export key 或首次启用 author options。

## 变更与文档

实现、公开 exports、已知调用方与测试应表达同一契约。公开行为更新 `docs/`，内部边界更新所属工程文档；通用方法留在 `.agents/rules/`。package README 只提供入口和最短示例，不另定义插件模型或测试规则。当前文档不维护旧 API 教程，历史由 Git 保存；已落地 proposal 删除对应部分。

合并前运行 `pnpm verify` 并检查旧符号与链接。公开包的用户可见变化添加 Tegami changelog，不手改版本与 publish lock；版本 PR 和发布流程见 [RELEASING](RELEASING.md)。
