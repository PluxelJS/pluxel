# @pluxel 插件系仓库

```bash
pnpm install
pnpm build
pnpm hmr
```

文档入口（先看这些，避免被历史笔记误导）：

- `docs/README.md`
- `docs/CORE.md`
- `docs/RUNTIME.md`
- `docs/HMR.md`
- `docs/FRONTEND.md`
- `docs/CONFIG.md`
- `docs/proposals/README.md`

开发宿主走 `packages/plugins/host`，但建议直接从仓库根目录使用这些入口：

```bash
pnpm hmr
pnpm deploy
pnpm frozen
```

当前包边界：

- `@pluxel/core`：最小稳定内核（Context/DI/插件生命周期与基础 services 合约）
- `@pluxel/runtime`：生产 runtime kernel（services + 稳定协议/路由 + web SDK + frozen）
- `@pluxel/runtime-dynamic`：动态插件路线；`/hmr` 内置 Vite + watch + runner + HMR
- `@pluxel/runtime-static`：固定插件路线骨架；未来承载 fixed catalog / strict startup / drift check
- `@pluxel/cli`：命令行入口（build/scaffold/hmr）
- `@pluxel/test`：测试工具包（Vitest preset + Host/Context helpers；仅用于测试/工具链）
- `packages/plugins/*`：workspace 内置插件与宿主样例（internal；不属于发布包集合）

## Tests

```bash
pnpm test           # full (turbo)
pnpm test:affected  # affected since origin/main (turbo)
pnpm test:watch     # watch mode (vitest, workspace)
pnpm test:watch -- --project=@pluxel/runtime  # watch a single project

pnpm --filter @pluxel/runtime test            # run one package's tests (fast path, no turbo graph)
pnpm -w turbo run test --filter=@pluxel/runtime  # same, but through turbo (cache/graph)
```
