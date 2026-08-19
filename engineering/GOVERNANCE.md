# Governance

## 依赖方向

```text
@pluxel/core <- @pluxel/runtime <- @pluxel/runtime-dynamic
                           └──── @pluxel/runtime-static

@pluxel/cli --optional--> @pluxel/rolldown
            --optional--> @pluxel/runtime-dynamic/hmr/diagnose
```

`@pluxel/rolldown` 是 build-time tooling，不进入 runtime graph。

必须保持：core host-free、runtime 不依赖 dynamic、route 不复制 lifecycle、config persistence 不进入 core。CLI 是按命令加载的编排层，不作为 runtime 或 toolchain library API 的转发门面。

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

- 第一方 workspace 依赖使用 `workspace:*`，确保开发时链接当前源码，发布时由 pnpm 转换版本。
- catalog 管理的外部依赖使用 `catalog:`；只在 `pnpm-workspace.yaml` 修改兼容范围。
- CLI 生成的独立应用把发布版 `@pluxel/*`、React、工具链等范围放进自己的 catalog；生成的
  workspace 之间仍逐包声明直接依赖。
- standalone plugin 模板使用最小单 package pnpm workspace，让 catalog 与 `allowBuilds` 安全政策有明确
  所有者；发布时 pnpm 把 catalog 引用转换为正常 semver 范围。
- 独立仓库共同开发未发布源码时使用 `pluxel source`；项目提交 repository identity 和正常
  catalog/semver，机器 checkout 路径只进入用户 registry 与 `.pluxel/` 代理。不得手写跨仓库 `link:`
  override 或链接另一个 checkout 的 `node_modules`。
- peer 表示必须与宿主共享的运行时身份，不是减少安装声明的手段。peer 的本地构建/测试副本同时放
  `devDependencies`。

Mantine/React 等 Workbench singleton 由 host 直接安装；插件 UI 把自己 import 的 singleton 声明为
peer，并在需要独立开发时声明 dev 副本。导入 Drizzle schema/query API 的每个 package 都直接声明
`drizzle-orm`；它与 Pluxel 高度集成并不意味着能从根或 `@pluxel/runtime` 隐式继承。只有确实要求宿主
共享 Drizzle 运行时身份的公开边界才改用 peer。

`pnpm governance:check` 固化 workspace 单一来源、catalog 使用、根依赖和具体插件目录边界；它是
`pnpm verify` 的前置步骤。

## 导出

- public export 必须对应稳定用户概念；
- internal/helper/debug 默认不导出；
- 优先明确 subpath，避免 broad barrel 隐藏依赖；
- 不为已删除设计保留兼容 alias；
- toolchain helper 只能从 toolchain/internal subpath 使用。

runtime route wiring、RuntimeState draft helper、resolver/cache/Vite helper 和 control-plane server DTO 统一从
`@pluxel/runtime/internal` 供 workspace runtime packages 使用，不创建 `shared`、`plugin-catalog`、`runtime-state`、
`protocol` 等 public-looking 作者入口。browser contract 的公开权威入口是 `@pluxel/runtime/web`。

Dynamic source producer 的唯一 low-level public boundary 是 `@pluxel/runtime-dynamic/source-producer` 的声明校验；它不得导入
Vite、watcher、workspace scanner 或 package manager。固定 catalog 只从 dynamic config 的 `plugins` 进入，不提供 package、
module、export key 或首次启用 author options。

## 变更流程

1. 先读 [`DESIGN_PRINCIPLES.md`](DESIGN_PRINCIPLES.md) 和相关领域文档。
2. 修改实现与测试。
3. 更新当前事实的唯一权威文档。
4. 审计 public exports、workspace 插件、示例和链接。
5. 如果 proposal 已实现，删除已落地部分。

公开包发生用户可见变化时，同一 PR 必须添加 Changeset。版本提交、发布前验证和 npm trusted
publishing 的维护流程见 [`RELEASING.md`](RELEASING.md)。

## 文档

- `docs/` 不讲内部类名、迁移历史或 toolchain helper。
- `engineering/` 不复制用户教程，只解释边界和实现入口。
- package README 不重新定义仓库级插件模型。
- 当前文档不列旧 API；需要追溯时查看 Git history。
