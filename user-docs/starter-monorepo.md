# 从纯净 monorepo 开始

新产品优先从 canonical starter 开始，不要复制仓库内的复杂业务项目：

```bash
pluxel new --template app-monorepo --name @acme/my-app
cd my-app
pnpm install
pnpm verify
pnpm dev
```

该模板固定使用 pnpm 11；CLI 会拒绝对内置模板传入 npm/yarn，根 `devEngines.packageManager`
也会阻止误用另一套包管理器生成第二份 lockfile。生成的 `.github/workflows/ci.yml` 使用 frozen
install 并执行同一个 `pnpm verify` 门禁。

生成结构只包含三个所有权边界：

```text
web             独立 workspace；Vite、static host、React HMR 与 GQLens
plugins/example 插件生命周期、配置和业务 HTTP
packages/domain web 与 plugin 共用、不依赖 Pluxel 的中性领域逻辑
docs             当前模板的插件作者与 Oxlint 就地指南
AGENTS.md        指示 coding agent 先读取就地指南和验证要求
```

根目录只负责编排 workspace、pnpm catalog 和共享质量工具，不声明业务 `dependencies`。唯一部署
单元 `web` 直接拥有前端与 static runtime 依赖；`packages/*` 只用于真正跨边界复用的中性库，
`plugins/*` 只用于具体插件 package。出现第二个独立部署目标时，再将 `web` 迁入 `apps/*` 层级。

根脚本由 Turborepo 编排。`turbo.json` 根据 workspace 依赖图先构建依赖；纯 build/typecheck 使用全部
逻辑 CPU，test/verify 为 Vitest 自身的 worker pool 保留一半 Turbo 槽位，避免双层过度并行。`dist/**`、
成功的测试结果和类型检查结果都会进入本地 `.turbo` 缓存。`pnpm verify` 用同一次 Turbo 调度运行
`typecheck test build`，所以同一轮不会重复执行任务，第二次
运行或切换分支后输入未变的任务会直接命中缓存。需要排除缓存诊断时使用 `pnpm test:full` 或
`pnpm build:full`；机器资源受限时可继续降低 `--concurrency`。
`build` 同时依赖上游 workspace 的 `typecheck` task，因此 source-only 的 domain/plugin 变化也会进入
`web` 生产构建 hash，不会恢复旧的部署产物。

生产构建和本地启动使用：

```sh
pnpm build
PLUXEL_WORKBENCH=false pnpm start
```

`pnpm start` 运行 `web/dist/app.mjs`；整个 `web/dist` 仍是唯一需要搬运的部署目录。

## 为什么默认关闭 Workbench Plane

模板用 `workbench: false` 验证业务能力不依赖可选Workbench。开启Workbench时，只修改
`web/src/pluxel.static.ts` 的宿主配置；业务 HTTP、领域状态和持久化不能迁入
`ctx.workbench.mount()`。关闭时 mount 返回 `undefined`，不会注册资源或启动 UI 工具链。

## 依赖规则

- Pluxel 发布包的正常 semver 范围集中在 `pnpm-workspace.yaml`，各 workspace 使用 `catalog:` 引用。
- 只有当前应用自己拥有的 package 使用 `workspace:*`。
- catalog 只统一版本，不提供隐式依赖；每个 package 必须声明自己实际 import 的依赖。
- React、React DOM、GQLens client 和 Vite 是 `web` 的直接依赖，不进入根、插件或中性 package。
- 插件新增 Mantine/React UI 时将 singleton 声明为 peer 并提供开发期副本；使用 Drizzle 的 package
  自己直接声明 `drizzle-orm`，不能依赖根目录 hoist。
- Vite、Vitest 和插件源码只使用公开 package subpath，不引用 Pluxel 仓库相对路径。
- 同一个 Vite pipeline 依次组合 static runtime、GQLens schema codegen 和 React HMR；GraphQL
  业务 endpoint 仍由插件拥有。
- Vault、Workbench Plane 和部署路线由根 host 安装；插件只消费稳定 capability。

根目录生成 `turbo.json`、`oxlint.config.ts`、`.oxfmtrc.json` 和 workspace governance 检查。Oxlint 配置加载
`@pluxel/rolldown/oxlint` 的 Pluxel 增补规则；`pnpm verify` 同时检查目录/依赖治理、格式、未使用的
lint 抑制、类型、测试和生产构建。

## 模板内文档

生成仓库的 README 先说明插件开发，再说明 host composition。CLI 发行包携带当前
`user-docs/`，`pluxel new` 会把它们原样复制到 `docs/pluxel/`。入口
`docs/pluxel/README.md` 包含：

- 标准 plugin shape 与目录所有权；
- 独立插件 package 的 `package.json`、`tsconfig.json`、`tsdown.config.ts` 和发布检查；
- required/optional、plugin/feature、业务/Workbench的选择表；
- `@pluxel/test/vitest`、`withRuntimeHost()` 和必须覆盖的插件测试边界；
- config、lifecycle、cleanup 和 disabled Workbench Plane 的实践；
- 模板启用的每一条 Pluxel Oxlint rule 及修复方向；
- `lint:fix` 到 `verify` 的完成标准。

根 `AGENTS.md` 要求 coding agent 在修改 `plugins/`、contract、host config 或 lint config 前从
这份入口开始。生成项目离开 Pluxel 源码仓库后仍拥有完整设计上下文，同时没有需要人工同步的
模板文档副本；权威说明就是当前目录中的 [`plugin-package.md`](plugin-package.md)、
[`plugin-authoring.md`](plugin-authoring.md)、[`testing.md`](testing.md)、
[`plugin-best-practices.md`](plugin-best-practices.md) 和
[`oxlint.md`](oxlint.md)。

## 何时参考 projects

基础结构稳定后，再按需求阅读：

- `projects/chatbots`：复杂 capability、optional integration、长连接和多插件领域模型。
- `projects/external-api-gateway`：外部 API、provider、计费、Vault 和公开 gateway 协议。

这些是高级参考应用，不是生成模板的权威源；标准作者模型仍以
[`plugin-authoring.md`](plugin-authoring.md) 为准。
