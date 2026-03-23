# @pluxel/hmr

`@pluxel/hmr` 是 Pluxel 的 dev host wrapper。它负责把开发期能力接到 `@pluxel/runtime` 上。

职责很简单：

- 读取配置并诊断 workspace
- 创建或 attach 一个 `@pluxel/runtime` `Context`
- 启动 Vite dev server、runner、watchers
- 消费 `ui(...).bind(ctx)` 这类 authoring bridge，并把源码编译成可运行的 MF2 remote

## 推荐入口

```ts
import { startHmrHostFromConfig } from '@pluxel/hmr/host'

const { ctx } = await startHmrHostFromConfig({
	root: process.cwd(),
	configPath: 'pluxel.hmr.jsonc',
	profile: process.env.PLUXEL_HMR_PROFILE ?? 'dev',
	logging: true,
})
```

如果你已经有自己的 `Context`，再用 `attachHmrRuntime(...)` 做低级 attach。

## 核心设计

- `runtime` 不理解 authoring 源码入口
- `hmr` 才理解 `ui(...).bind(ctx)` 这种 bridge declaration
- build 产物会把这层 bridge 重写成 `ctx.ext.ui.packaged()`
- 因此 dev 语义和 runtime 语义始终分离

runtime 里保留的少量挂点只有：

- `ui(...).bind(ctx)` 对应的 dev bridge 注入点
- module runtime adapter 注入点
- root-scoped dev handles
- 给 extension compiler 使用的最小 module store bridge

## 推荐约束

- 推荐只用 `@pluxel/hmr/host` 作为高层入口
- `attachHmrRuntime(...)` 只作为已有 `Context` 的 escape hatch
- 宿主渲染 doc 默认只消费 `ctx.ext.signaldb`
- 服务端代码避免从 `@pluxel/runtime/web` 或 `@pluxel/runtime/web/ui` 做 value import

## Profiling

HMR attribution 日志是可选的：

- 开：`PLUXEL_HMR_ATTRIBUTION=info`
- 关：`PLUXEL_HMR_ATTRIBUTION=0`

## 维护文档

- `docs/ARCHITECTURE.md`
- `docs/PACKAGING.md`
- `docs/AGENT_RULES.md`
- `docs/SERVICES.md`
