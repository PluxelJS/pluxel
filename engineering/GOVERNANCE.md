# Governance

## 依赖方向

```text
Core <- Host <- Services <- Management <- Workbench <- Preset
          ^         ^            ^                       |
          |         +------------+-----------------------+
          +-- Host Dynamic
          +-- Host Dev <- 服务开发附件、Preset /vite
Commands <- Services、Management
Logging <- Management、Preset
```

箭头从消费者指向提供者；图只画主要层次，不重复每层对 Core/Host 的直接依赖。
`@pluxel/preset` 拥有官方组合策略；Services 只提供可组合能力，不反向导入 Management、Workbench 或 Preset。
Management 拥有管理用例和协议，Workbench 在其上提供展示、会话和 UI；Management 不反向依赖 Workbench。
Host Dev 只拥有 Vite 环境与开发协议，不选择官方服务。

`@pluxel/rolldown` 是 build-time tooling，消费 Core 的 lowering ABI 和 federation contract；
CLI 按命令可选消费它，Host Dev 消费其编译实现。Core 不通过发布依赖反向引入构建工具。
`@pluxel/context` 的源码复用和下文的测试依赖是开发图，不是上述发布图的一层。

必须保持：context 不依赖 Core/Host/IO/lifecycle、core host-free、Host 通过来源契约接入 dynamic、来源接入不复制 lifecycle、config
persistence 不进入 core。CLI 是按命令加载的编排层，不作为 runtime 或 toolchain library API 的转发门面。

## Workspace 与目录

`pnpm-workspace.yaml` 是唯一 workspace 成员和外部版本政策来源；根 `package.json` 不重复
`workspaces`。目录表达 package 的角色，而不是团队或功能名称：

```text
packages/*              框架库、contract、adapter 与其他非具体插件的可复用 package
plugins/*               可独立装配的具体插件 package
plugins/<domain>/*      共享明确能力链的具体插件 package
projects/*              必须随框架一起演进的可运行维护者宿主
vendor/*                明确纳入的上游源码；不套用第一方目录语义
```

判断依据是所有权而不是“是否导入 Pluxel”：contract 或 adapter 即使依赖 runtime 类型，只要不声明
具体 `@Plugin`，仍可位于 `packages/*`；声明具体插件生命周期的 package 位于 `plugins/*` 或
`plugins/<domain>/*`。领域目录只表达仓库分类，不创建隐式依赖、聚合插件或新的公开入口。Pluxel
仓库内可运行 host 位于 `projects/*`，当前只保留维护者宿主。产品项目使用独立 workspace；其中可按
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
- peer 表示必须与应用共享的身份或平台兼容边界，不是减少安装声明的手段。公开集成包对 Core、Host、
  Commands、Services、Logging、Management、Workbench 的引用使用 peer；即使当前只引用它们的公开类型，
  发布声明仍需要调用方提供兼容版本。编译器对 Core 的 lowering ABI 同样使用 peer，避免静默编译到另一版本协议。
  包自身拥有的解析器、文件监视器、查询缓存等实现继续使用 dependencies；不要求所有第一方库都成为 peer。
- Plugin package 在源码中使用
  `workspace:^` 消费 Core、服务和 provider contract，发布后由 pnpm 转换为各包对应的 semver 范围；本地构建/测试
  副本同时以 `workspace:*` 放入 `devDependencies`，不得把 provider 放入普通 dependencies 形成第二份
  Plugin identity。
- 真正隔离在可选入口或条件加载后的集成可以标记 optional peer。optional 只影响安装要求，既不消除架构边，
  也不允许无条件入口加载缺失的包。`devDependencies` 只承载开发工具、测试夹具和已明确内联的源码；
  不能用它隐藏发布 JavaScript 或 declarations 仍引用的包。

发布依赖图包含 `dependencies`、`optionalDependencies` 和所有 `peerDependencies`，必须无环；
`governance:check` 对完整 workspace 图做检查，并保护 Context、Core、Commands、Host 与来源/开发驱动的向下边界。
同时扫描包源码的实际 import（包含类型和动态 import），要求跨 workspace 引用有发布依赖声明，不能只删除 manifest
边来通过检查；测试和类型探针不算发布源，Core 内联 Context 是明确例外。
测试夹具可能依赖被测框架，Core 的构建也使用官方 toolchain，因此开发依赖图可以有环；这不表示运行时循环，
但 Turbo 任务必须保持可执行的顺序，不能用发布依赖调整来掩盖任务编排问题。

`@pluxel/core` 源码对 `@pluxel/context` 的复用是构建时源码边界：Core 将其声明为 `devDependencies: workspace:*`，并用
tsdown `alwaysBundle` 内联所有 JavaScript 与 declarations。发布 tarball 不得含外部 `@pluxel/context` import，也不得把它加入
Core 的 dependencies/peerDependencies/optionalDependencies；直接使用 standalone kernel 的应用才显式安装 `@pluxel/context`。

Workbench fixed singleton set 由 host 直接安装并由 MF build contract 精确锁定：React/ReactDOM 及其实际
subpaths、`@mantine/core`、`@mantine/hooks`、MF React Bridge、`@pluxel/workbench`、`/client`、`/react` 与
`@pluxel/workbench/internal/react`。插件 UI 把自己 import 的 React 和 Mantine 声明为 peer，并在需要独立开发时声明
dev 副本。`@tanstack/query-core` 只是 Workbench renderer owner 的内部实现依赖，不进入 platform shared set。导入 Drizzle schema/query API 的每个 package 都直接声明
`drizzle-orm`；它与 Pluxel 高度集成并不意味着能从工作区根或其他 framework 包 隐式继承。只有确实要求宿主
共享 Drizzle 运行时身份的公开边界才改用 peer。

`pnpm governance:check` 是 repository policy 的唯一检查入口，先验证共享 package inventory 的分类规则，
再固化 workspace 单一来源、catalog 使用、根依赖、具体插件目录边界、工具版本、公开包 metadata、
内部依赖范围和 Tegami 发布集合。治理检查与 Tegami 从 `scripts/repository-packages.mjs` 读取同一份 inventory；
`private`、目录类型和发布排除列表不再分别维护。该命令是 `pnpm verify` 的前置步骤。

本地与 CI 统一执行 `scripts/verify.mjs`：governance、lint、format、Turbo typecheck/build/test，
最后再次检查源码声明，避免构建过程生成未被前置检查发现的污染。CI 只传入 Turbo 的并发数、
affected filter 和 summary 选项，不维护另一份验证步骤。产物配置不依赖未纳入 Turbo hash 的环境开关；
CI 和 Release 使用同一套生产构建语义。
两者只共享 `.turbo/cache` 任务产物；`.turbo/runs` 属于本次运行报告，不进入跨运行缓存。

外部环境类型（例如 `vite/client`）由各 package 的 `tsconfig.compilerOptions.types` 加载。确有必要的
本地手写 ambient 声明在 `scripts/check-source-declarations.mjs` 显式登记；生成声明和 declaration maps
只能输出到 `dist` 或可清理缓存，不能混入源码目录。

生成的独立 workspace 先通过 `pluxel workspace doctor` 校验框架共同拥有的 pnpm major、workspace authority 与
已激活时的 machine-local source `.pnpmfile.cjs`，再由仓库自己的 governance script 校验产品目录和依赖方向。通用 CLI 不推断产品领域规则。

workspace 单元测试统一由 Vitest 执行；package `test` script 不调用 `node --test`。需要验证纯 Node 边界时可以
保留独立 fixture 或 test directory，但仍由 Vitest 的 Node environment 编排，避免不同 runner 的 hook、过滤、
reporter 和 CI 语义漂移。Node `assert` 仍可作为断言库使用，它不构成第二套 test runner。

每个 root、package、plugin 和 project workspace 都必须声明自己的 `typecheck` script；Turbo 只负责编排，不能用
上游 declaration build 代替当前 package 的 `tsc --noEmit`。package 级 `tsconfig` 明确拥有其源码、测试和构建配置，
避免编辑器检查到 CI task graph 未覆盖的文件。

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
Browser Management 使用 `@pluxel/management/client`；Plugin 直接使用 capnweb 与 `@pluxel/workbench`，React 接入位于 Workbench 子入口。
Generated Bridge ABI 属于 Workbench internal，raw server registry 和 MF Runtime 不进入默认作者 API。

Dynamic source producer 的唯一 low-level public boundary 是 `@pluxel/host-dynamic/source-producer` 的声明校验；它不得导入
Vite、watcher、workspace scanner 或 package manager。固定 catalog 只从 dynamic config 的 `plugins` 进入，不提供 package、
module、export key 或首次启用 author options。

## 变更流程

1. 先读 [`DESIGN_PRINCIPLES.md`](DESIGN_PRINCIPLES.md) 和相关领域文档。
2. 修改实现与测试。
3. 更新当前事实的唯一权威文档。
4. 审计 public exports、workspace 插件、示例和链接。
5. 如果 proposal 已实现，删除已落地部分。

公开包发生用户可见变化时，同一 PR 必须添加 Tegami changelog。Version Packages PR、发布前验证和 npm trusted
publishing 的维护流程见 [`RELEASING.md`](RELEASING.md)。

## 文档

- `docs/` 不讲内部类名、迁移历史或 toolchain helper。
- `engineering/` 不复制用户教程，只解释边界和实现入口。
- package README 不重新定义仓库级插件模型。
- 当前文档不列旧 API；需要追溯时查看 Git history。
