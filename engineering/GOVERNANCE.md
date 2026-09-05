# Governance

## 依赖方向

```text
@pluxel/context <- @pluxel/core <- @pluxel/runtime <- @pluxel/runtime-dynamic
                                              └──── @pluxel/runtime-static

@pluxel/cli --optional--> @pluxel/rolldown
            --optional--> @pluxel/runtime-dynamic/hmr/diagnose
```

`@pluxel/rolldown` 是 build-time tooling，不进入 runtime graph。

必须保持：context 不依赖 Core/Runtime/IO/lifecycle、core host-free、runtime 不依赖 dynamic、route 不复制 lifecycle、config
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
- peer 表示必须与宿主共享的运行时身份，不是减少安装声明的手段。Plugin package 在源码中使用
  `workspace:^` 消费 Pluxel runtime 和 provider contract，发布后由 pnpm 转换为 `^1.0.0`；本地构建/测试
  副本同时以 `workspace:*` 放入 `devDependencies`，不得把 provider 放入普通 dependencies 形成第二份
  Plugin identity。

`@pluxel/core` 源码对 `@pluxel/context` 的复用是构建时源码边界：Core 将其声明为 `devDependencies: workspace:*`，并用
tsdown `alwaysBundle` 内联所有 JavaScript 与 declarations。发布 tarball 不得含外部 `@pluxel/context` import，也不得把它加入
Core 的 dependencies/peerDependencies/optionalDependencies；直接使用 standalone kernel 的应用才显式安装 `@pluxel/context`。

Workbench fixed singleton set 由 host 直接安装并由 MF build contract 精确锁定：React/ReactDOM 及其实际
subpaths、`@mantine/core`、`@mantine/hooks`、MF React Bridge、`@pluxel/runtime/workbench`、`/client`、`/react` 与
`@pluxel/runtime/internal/workbench-react`。插件 UI 把自己 import 的 React 和 Mantine 声明为 peer，并在需要独立开发时声明
dev 副本。`@tanstack/query-core` 只是 Workbench renderer owner 的内部实现依赖，不进入 platform shared set。导入 Drizzle schema/query API 的每个 package 都直接声明
`drizzle-orm`；它与 Pluxel 高度集成并不意味着能从根或 `@pluxel/runtime` 隐式继承。只有确实要求宿主
共享 Drizzle 运行时身份的公开边界才改用 peer。

`pnpm governance:check` 是 repository policy 的唯一检查入口，先验证共享 package inventory 的分类规则，
再固化 workspace 单一来源、catalog 使用、根依赖、具体插件目录边界、工具版本、公开包 metadata、
内部依赖范围和 Tegami 发布集合。治理检查与 Tegami 从 `scripts/repository-packages.mjs` 读取同一份 inventory；
`private`、目录类型和发布排除列表不再分别维护。该命令是 `pnpm verify` 的前置步骤。

生成的独立 workspace 先通过 `pluxel workspace doctor` 校验框架共同拥有的 pnpm major、workspace authority 与
source `.pnpmfile.cjs` bootstrap，再由仓库自己的 governance script 校验产品目录和依赖方向。通用 CLI 不推断产品领域规则。

workspace 单元测试统一由 Vitest 执行；package `test` script 不调用 `node --test`。需要验证纯 Node 边界时可以
保留独立 fixture 或 test directory，但仍由 Vitest 的 Node environment 编排，避免不同 runner 的 hook、过滤、
reporter 和 CI 语义漂移。Node `assert` 仍可作为断言库使用，它不构成第二套 test runner。

每个 root、package、plugin 和 project workspace 都必须声明自己的 `typecheck` script；Turbo 只负责编排，不能用
上游 declaration build 代替当前 package 的 `tsc --noEmit`。package 级 `tsconfig` 明确拥有其源码、测试和构建配置，
避免编辑器检查到 CI task graph 未覆盖的文件。

## 导出

- public export 必须对应稳定用户概念；
- internal/helper/debug 默认不导出；
- 优先明确 subpath，避免 broad barrel 隐藏依赖；
- 不为已删除设计保留兼容 alias；
- toolchain helper 只能从 toolchain/internal subpath 使用。

`@pluxel/context` 默认入口公开 host composition 所需的 opaque descriptor、scoped installation、`createContextHost()`、
projection types 与显式 resolve；raw plan/context construction 只从 `/internal` 提供给框架实现，不是稳定第三方入口。
`ContextHost` 编译后没有 capability mutator，公开 `overrides` 也只能在编译前替换相同 descriptor 且保持 scope/property。

`@pluxel/core` 与 `@pluxel/runtime` 默认入口使用逐项 allowlist；runtime 可以逐项转发同一 core 作者面，不能使用
`export * from '@pluxel/core'`。默认入口只承诺 Plugin 作者模型、逐项转发的公开 Context host API、结构化 address codec 与 host
确实消费的 lifecycle result。`PluginService`、slot registry、record reader、construction/lifecycle adapter、coordinator、lowering setter 和 test host
不得从默认入口可达；opaque slot 最多以 type-only contract 出现。Federation build contract 只从 `@pluxel/core/federation` 消费。

Core 可以逐项转发 `@pluxel/context` 的公开 host API，但不转发它的 `/internal` construction surface。Runtime 在一个集中 contract
中声明并安装固定内建属性；受信任 framework route 只可通过 package-private `routeContextCapabilities` 在 root 创建前安装自身
descriptor。该 authority 不进入 public config，route 与业务 Plugin 都不能向已创建的 Runtime Context 追加或替换 capability。
默认 root 不使用 star barrel 扩张 surface。

runtime route wiring、RuntimeState draft helper、resolver/cache/Vite helper 和 control-plane server DTO 统一从
`@pluxel/runtime/internal` 供 workspace runtime packages 使用，不创建 `shared`、`plugin-catalog`、`runtime-state`、
`protocol` 等 public-looking 作者入口。Browser Management 的公开入口是 `@pluxel/runtime/web`：document session client、
versioned DTO 和 borrowed Management capability facade；React provider 位于 `/web/react`。Plugin 作者只使用
`/capnweb`、`/workbench` 和 `/workbench/react`；conforming Shell 另外使用 `/workbench/client` 与
`/workbench/federation`。Generated Bridge ABI 固定在 `/internal/workbench-react`，raw server registry、wrapper props 和
MF Runtime 不进入作者 API。

Dynamic source producer 的唯一 low-level public boundary 是 `@pluxel/runtime-dynamic/source-producer` 的声明校验；它不得导入
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
