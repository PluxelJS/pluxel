# @pluxel 插件系仓库

```bash
pnpm install
pnpm build
cd packages/runtime
pnpm dev
```

## Tests

```bash
pnpm test           # full (turbo)
pnpm test:affected  # affected since origin/main (turbo)
pnpm test:watch     # watch mode (vitest, workspace)
pnpm test:watch -- --project=@pluxel/hmr  # watch a single project

pnpm --filter @pluxel/hmr test            # run one package's tests (fast path, no turbo graph)
pnpm -w turbo run test --filter=@pluxel/hmr  # same, but through turbo (cache/graph)
```
