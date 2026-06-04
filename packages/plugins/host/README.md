# Plugins Host Samples

> Status: internal workspace app (examples + smoke). Not part of the 5 published packages.

`packages/plugins/host` 的定位不是“权威架构文档”，而是把当前 runtime/HMR/front-end 设计落成可运行样例和 smoke host。

它现在提供三种最小入口：

- `dev`：`@pluxel/hmr` 驱动的开发宿主，负责 workspace diagnose / source execution / watch / HMR。
- `deploy`：直接建立在 `@pluxel/runtime` 之上的管理式宿主。
- `frozen`：先生成 frozen host，再直接启动它。

如果你在看插件前端链路，建议同时看：

- `docs/RUNTIME.md`
- `docs/HMR.md`
- `docs/FRONTEND.md`
- `packages/plugins/host/src/demo/README.md`

## Run

开发版：

```sh
pnpm dev
pnpm --filter @pluxel/plugins-host dev
```

管理式部署版：

```sh
pnpm deploy
pnpm --filter @pluxel/plugins-host deploy
```

冻结部署版：

```sh
pnpm frozen
pnpm --filter @pluxel/plugins-host frozen
```

## HMR Tools

```sh
pnpm --filter @pluxel/plugins-host prompt
pnpm --filter @pluxel/plugins-host doctor
```

这里不再维护 `prepare` / `smoke` / `managed:start` / `frozen:start` 这一类中间脚本。宿主入口只保留真正有语义的三个动作：`dev`、`deploy`、`frozen`。

## Boundary

- `scripts/host.mjs dev` 走 `planHmrHostFromConfig()` + `bootPlannedHmrHost()`。
- `scripts/host.mjs managed` 直接 `new Context()` 启动 runtime 宿主。
- `scripts/host.mjs frozen` 先 `buildFrozenHost()`，再启动 frozen 产物。

对前端来说，这里最重要的边界是：

- `dev`
  由 `@pluxel/hmr` 消费 `ui(...).bind(ctx)` 这类 authoring bridge
- `deploy:*`
  只消费 build 后的 runtime 语义，例如 `ctx.ext.ui.remote.packaged()`

也就是说，这个 host 包的价值主要有两点：

- 证明同一套插件 API 可以同时跑在 dev 与 deploy 语义下
- 提供 demo 与 smoke，让文档里的架构判断有真实可运行样本
