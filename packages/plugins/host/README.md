# Plugins Host Samples

> Status: internal workspace app (examples + smoke). Not part of the 5 published packages.

`packages/plugins/host` 的定位不是“权威架构文档”，而是把当前 dynamic/static runtime 设计落成可运行样例和 smoke host。

它现在只保留两条推荐入口：

- `dynamic`：`@pluxel/runtime-dynamic/hmr` 驱动的开发宿主，负责 workspace diagnose / source execution / watch / loader replacement。
- `static`：`@pluxel/runtime-static` 驱动的固定目录宿主，直接消费 `defineStaticRuntime(...)` 的 known catalog。

如果你在看插件前端链路，建议同时看：

- `docs/RUNTIME.md`
- `docs/HMR.md`
- `docs/FRONTEND.md`
- `packages/plugins/host/src/demo/README.md`

## Run

dynamic HMR：

```sh
pnpm plugin-host:dynamic
pnpm --filter @pluxel/plugins-host dynamic
```

static fixed catalog：

```sh
pnpm plugin-host:static
pnpm --filter @pluxel/plugins-host static
```

## Loader HMR Tools

```sh
pnpm --filter @pluxel/plugins-host dynamic:prompt
pnpm --filter @pluxel/plugins-host dynamic:doctor
```

## Boundary

- `src/dynamic.ts` 走 `createLoaderHmrHost()`。
- `src/static.ts` 走 `createStaticRuntimeHost()`，catalog 来自 `src/pluxel.static.ts`。

对前端来说，这里最重要的边界是：

- `hmr`
  由 `@pluxel/runtime-dynamic/hmr` 安装 dev handles，接管 `@pluxel/runtime/plugin` 的 `ui(...).bind(ctx)` / worker authoring bridge
- `static`
  由 `@pluxel/runtime-static` 消费固定 `plugins: [...]` catalog；没有 dev handles 时同一套 authoring bridge 走 packaged UI / worker fallback

也就是说，这个 host 包的价值主要有两点：

- 证明同一套插件 API 可以同时跑在 dynamic HMR 与 static fixed catalog 语义下
- 提供 demo 与 smoke，让文档里的架构判断有真实可运行样本
