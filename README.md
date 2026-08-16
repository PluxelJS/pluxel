# @pluxel 插件系仓库

```bash
mise trust
mise install
pnpm install --frozen-lockfile
pnpm verify
pnpm plugin-host:dynamic
```

`mise.toml` 统一跟踪 Node.js LTS 与最新 pnpm；不使用 mise 时也必须满足根 `package.json` 的
engines 约束。

## 本地协同项目

需要与 Pluxel 源码同步演进、但拥有独立 Git、pnpm workspace 和发布生命周期的项目放在
`local-projects/<name>`。该目录被 Pluxel 永久忽略，也不属于 Pluxel 根 workspace；下游项目提交
`pluxel.sources.jsonc` 中的仓库身份，并通过 `pluxel source register/install/build` 使用当前 checkout。
机器路径只保存在用户 registry 与被忽略的 `.pluxel/` 代理中，不得提交手写跨仓库 `link:` override。

`projects/*` 只保留必须随 Pluxel 一起演进的维护者宿主。产品项目不要嵌入该目录，避免一个 package
同时属于父、子两个 workspace；各仓库分别维护 lockfile、验证命令和提交历史。完整流程见
[`user-docs/development/source-workspaces.md`](user-docs/development/source-workspaces.md)。

文档入口（先看这些，避免被历史笔记误导）：

- 插件作者：`user-docs/README.md`
- 维护者文档：`docs/README.md`
- 插件系统总边界：`docs/PLUGIN_SYSTEM.md`
- 未实现研究：`docs/proposals/README.md`
- 新应用模板：`user-docs/development/starter-monorepo.md`
- 维护者宿主：`projects/README.md`

开发宿主走 `projects/plugin-host`，但建议直接从仓库根目录使用这些入口：

```bash
pnpm plugin-host:dynamic
pnpm plugin-host:static
```

当前包边界：

- `@pluxel/core`：最小稳定内核（Context/DI/插件生命周期与基础 services 合约）
- `@pluxel/runtime`：生产 runtime kernel（services + 稳定协议/路由 + web SDK + frozen）
- `@pluxel/runtime-dynamic`：动态插件路线；`/vite` 提供 host-owned Vite route，`/hmr` 保留内部 workspace/HMR primitives
- `@pluxel/runtime-static`：固定插件路线；`/vite` 提供 static route，承载 fixed catalog startup、startup/change report 与轻量 static HMR
- `@pluxel/cli`：命令行入口（build/scaffold/hmr）
- `@pluxel/commands`：可投影为 Agent tool、CLI 或消息指令的 schema-first command kernel
- `@pluxel/test`：测试工具包（Vitest preset + Host/Context helpers；仅用于测试/工具链）
- `packages/*`：框架库与其他非具体插件的可复用 package
- `plugins/*`、`plugins/<domain>/*`：可独立装配的具体插件 package；领域目录只做仓库分类
- `projects/*`：必须随框架一起演进的可运行维护者宿主；产品级应用使用独立源码工作区

## Tests

```bash
pnpm test           # full (turbo)
pnpm test:watch     # watch mode (vitest, workspace)
pnpm test:watch -- --project=@pluxel/runtime  # watch a single project

pnpm --filter @pluxel/runtime test            # run one package's tests (fast path, no turbo graph)
pnpm -w turbo run test --filter=@pluxel/runtime  # same, but through turbo (cache/graph)
```

Turbo uses all logical CPUs for pure build/typecheck runs and caches build outputs plus successful
test/typecheck results. Test and combined verify runs reserve half of the Turbo slots because each
Vitest process has its own worker pool; this avoids slower nested over-parallelization.
`pnpm test:full` and `pnpm build:full` force a fresh run. Tests normally resolve workspace source
and do not wait for unrelated production builds; packaging invariant tests keep explicit dist build
prerequisites.

公开包的版本与发布流程见 [`docs/RELEASING.md`](docs/RELEASING.md)。
