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

这里不再维护 `prepare` / `smoke` / `managed:start` / `frozen:start` / `deploy` / `frozen` 这一类中间脚本。宿主入口只保留当前用于对比 runtime route 的两个动作：`dynamic`、`static`。

## Boundary

- `src/dynamic.ts` 走 `createLoaderHmrHost()`。
- `src/static.ts` 走 `createStaticRuntimeHost()`，catalog 来自 `src/pluxel.static.ts`。

对前端来说，这里最重要的边界是：

- `hmr`
  由 `@pluxel/runtime-dynamic/hmr` 消费 `ui(...).bind(ctx)` 这类 authoring bridge
- `static`
  由 `@pluxel/runtime-static` 消费固定 `plugins: [...]` catalog；示例默认启用一组不依赖 config-source transform 的插件，worker/UI-HMR 能力走 fallback

也就是说，这个 host 包的价值主要有两点：

- 证明同一套插件 API 可以同时跑在 dynamic HMR 与 static fixed catalog 语义下
- 提供 demo 与 smoke，让文档里的架构判断有真实可运行样本

历史上的 `deploy`/`frozen` 入口只是旧的 smoke 设计：`deploy` 直接 new 一个裸 `Context`，`frozen` 生成一个空 frozen host。它们没有体现当前 dynamic/static route 边界，也没有作为插件目录示例提供额外价值，因此不再放在这个 sample host 里。
