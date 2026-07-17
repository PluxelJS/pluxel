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

文档入口（先看这些，避免被历史笔记误导）：

- 插件作者：`user-docs/README.md`
- 维护者文档：`docs/README.md`
- 插件系统总边界：`docs/PLUGIN_SYSTEM.md`
- 未实现研究：`docs/proposals/README.md`
- 新应用模板：`user-docs/starter-monorepo.md`
- 高级参考项目：`projects/README.md`

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
- `@pluxel/test`：测试工具包（Vitest preset + Host/Context helpers；仅用于测试/工具链）
- `packages/*`：框架库与其他非具体插件的可复用 package
- `plugins/*`：可独立装配的具体插件 package（当前根 workspace 没有此类包时可以为空）
- `projects/*`：可运行产品与宿主样例；项目内部同样用 `packages/*` 放通用库、`plugins/*` 放具体插件

## Tests

```bash
pnpm test           # full (turbo)
pnpm test:watch     # watch mode (vitest, workspace)
pnpm test:watch -- --project=@pluxel/runtime  # watch a single project

pnpm --filter @pluxel/runtime test            # run one package's tests (fast path, no turbo graph)
pnpm -w turbo run test --filter=@pluxel/runtime  # same, but through turbo (cache/graph)
```

公开包的版本与发布流程见 [`docs/RELEASING.md`](docs/RELEASING.md)。
