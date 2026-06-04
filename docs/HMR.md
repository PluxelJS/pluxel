# HMR

`@pluxel/hmr` 是开发期适配层。它把 Vite、源码执行、watch、moduleGraph 和插件 UI 编译接到 runtime 上。

## 设计边界

HMR 拥有：

- HMR config diagnose
- Vite dev server
- SSR runner
- watcher 和 moduleGraph traversal
- runner singleton bridge
- HMR batch orchestration
- 通过 `ctx.loader.beginBatch()` 做 runtime module replacement
- dev 期插件 UI 源码编译

HMR 不拥有：

- 生产 runtime 服务
- runtime 协议定义
- core 生命周期算法
- 正式运行时 UI 注册语义

一句话边界：HMR 负责“源码如何变成可运行模块/remote”，runtime 负责“可运行 artifact 如何注册和消费”。

## 当前 HMR 流程

```text
file change
-> Vite moduleGraph affected ids
-> runner import
-> loader batch replaceModule
-> runtime affected module sync
-> core registry commit
```

HMR summary 需要解释：

- changed/target modules
- runtime affected modules
- synced modules
- auto-disabled missing dependencies
- enabled-but-stopped plugins
- commit failures

## 插件 UI HMR

作者侧可以写：

```ts
ui('./ui/index.tsx').bind(ctx)
```

开发期由 HMR bridge 消费源码入口并编译 remote；build 期由 build plugin 改写；runtime 最终只消费：

```ts
ctx.ext.ui.remote.packaged()
```

runtime 永远不应该回头理解 source `entryPath`。

## MF2 在 HMR 的角色

HMR 不把 MF2 当 authoring API。MF2 只定义 remote artifact format 和宿主加载协议；HMR 负责从源码构建 remote，并处理 dev watch/rebuild/submit。

当前 `@pluxel/hmr/plugin-build` 的实用策略：

- 同一插件包根目录共享 root-scoped build scheduler。
- 同 root 多个 UI remote 串行构建。
- 每次真实 MF2/Vite build 放到新子进程。
- 每次只清理本次专属临时 cache，避免误删 root federation 临时目录。

## 实现入口

- `packages/hmr/src/host.ts`：`planHmrHostFromConfig` / `bootPlannedHmrHost`。
- `packages/hmr/src/dev/attach-runtime.ts`：把 HMR attach 到已有 runtime `Context`。
- `packages/hmr/src/dev/hmr/HMRService.ts`：dev server、runner、watch pipeline。
- `packages/hmr/src/dev/hmr/config.ts`：HMR Vite config、bridge modules、dedupe、optimizeDeps。
- `packages/hmr/src/dev/hmr/pipeline.ts`：graph processing、executor、commit scheduler。
- `packages/hmr/src/dev/hmr/runner.ts`：SSR runner 和 bridge handling。
- `packages/hmr/src/plugin.ts`：`ui(...)` / `worker(...)` authoring bridge。
- `packages/hmr/src/dev/extensions/ExtensionCompilerService.ts`：dev 期消费 bridge、编译 UI、提交 compiled module。
- `packages/hmr/src/plugin-build.ts`：构建插件 UI remote。
- `packages/hmr/src/diagnose/**`：HMR config 和 workspace diagnose。
- `packages/hmr/src/snapshot.ts`：`HmrWorkspaceSnapshot`。

## 静态插件目录的 HMR 方向

当前没有实现 static-suite HMR route。未来如果支持固定插件总量，HMR 仍应复用 Vite runner/watch/moduleGraph，但提交到 known-plugin adapter，并默认拒绝插件集合漂移，除非配置显式允许。
