# Plugins Host Samples

> Status: internal workspace app (examples + smoke). Not part of the 5 published packages.

`packages/plugins/host` 的定位不是“权威架构文档”，而是把当前 runtime/HMR/front-end 设计落成可运行样例和 smoke host。

它现在提供两套明确的宿主样例：

- `dev`：`@pluxel/hmr` 驱动的开发宿主，负责 workspace diagnose / source execution / watch / HMR。
- `deploy:*`：直接建立在 `@pluxel/runtime` 之上的部署宿主，runtime 侧不包含任何 Vite/HMR 逻辑。

如果你在看插件前端链路，建议同时看：

- `docs/architecture/frontend.md`
- `packages/plugins/host/src/demo/README.md`

## Run

开发版：

```sh
pnpm dev
pnpm --filter @pluxel/plugins-host dev
```

管理式部署版：

```sh
pnpm deploy:managed
pnpm --filter @pluxel/plugins-host deploy:managed
```

冻结部署版：

```sh
pnpm deploy:frozen
pnpm --filter @pluxel/plugins-host deploy:frozen
```

如果你只想分开执行 frozen build / start：

```sh
pnpm --filter @pluxel/plugins-host deploy:frozen:build
pnpm --filter @pluxel/plugins-host deploy:frozen:start
```

## Smoke

```sh
pnpm dev:smoke
pnpm --filter @pluxel/plugins-host dev:smoke
pnpm deploy:managed:smoke
pnpm --filter @pluxel/plugins-host deploy:managed:smoke
pnpm deploy:frozen:smoke
pnpm --filter @pluxel/plugins-host deploy:frozen:smoke
```

这些脚本会先执行 `workspace:links`，自动把本地 workspace 的 `@pluxel/runtime` / `@pluxel/hmr` 链接校正到当前包拓扑，避免改名后还依赖手动重新安装。

构建预热现在走 Turbo：
- `dev:prepare` 会调用 `turbo run build:lib --filter=@pluxel/runtime --filter=@pluxel/hmr --filter=@pluxel/snapshot --filter=pluxel-plugin-market-ui`
- `deploy:prepare` 会调用 `turbo run build --filter=@pluxel/runtime --filter=@pluxel/snapshot --filter=pluxel-plugin-market-ui`
- `dev` 不再强制跑 runtime 的 `vite build`；只构建 library/dist 产物
- prepare 结束后还会快速检查 builtin plugin 的 dist 入口是否真实落盘；若本地缓存命中但产物缺失，只补构建缺的 builtin 包
- 首次冷启动会正常构建；后续重复启动默认复用 `.turbo` 本地缓存，不再逐包硬跑 `pnpm --filter <pkg> build`

## Boundary

- `scripts/hmr-start.mjs` 走 `startHmrHostFromConfig()`，这是开发样例。
- `scripts/managed-start.mjs` 走 `new Context()` + `ctx.loader.preloadPlugins()`，runtime 直接拥有 storage / config / control plane / builtin baseline。
- `scripts/frozen-build.mjs` + `scripts/frozen-start.mjs` 走 `buildFrozenHost()` 产物，冻结版不再模拟 HMR。
- 真实 HTTP 暴露统一复用 `scripts/_serve-fetch-host.mjs`，因此 managed / frozen 共用同一条 runtime fetch -> Node server 桥接。

对前端来说，这里最重要的边界是：

- `dev`
  由 `@pluxel/hmr` 消费 `ui(...).bind(ctx)` 这类 authoring bridge
- `deploy:*`
  只消费 build 后的 runtime 语义，例如 `ctx.ext.ui.remote.packaged()`

也就是说，这个 host 包的价值主要有两点：

- 证明同一套插件 API 可以同时跑在 dev 与 deploy 语义下
- 提供 demo 与 smoke，让文档里的架构判断有真实可运行样本
