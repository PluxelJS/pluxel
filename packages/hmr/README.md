# @pluxel/hmr

`@pluxel/hmr` 是开发期适配层。它把 Vite、源码执行、watch、HMR 和插件 UI 编译接到 `@pluxel/runtime` 上。

如果你要理解整条插件前端链路，直接看：

- [`docs/architecture/frontend.md`](../../docs/architecture/frontend.md)

## 负责什么

- 读取 HMR 配置并诊断 workspace
- 创建或 attach 一个 runtime `Context`
- 启动 Vite dev server、runner、watchers
- 消费 `ui(...).bind(ctx)` 这类 authoring bridge
- 把插件 UI 源码编译成可运行的 MF2 remote

## 不负责什么

- 正式运行时 UI 注册
- 生产环境宿主服务
- runtime 协议定义

这些属于 `@pluxel/runtime`。

如果只记一句边界判断，就是：

- HMR 负责“源码如何变成可运行 remote”
- runtime 负责“可运行 remote 如何被注册和消费”

## 推荐入口

```ts
import { bootPlannedHmrHost, planHmrHostFromConfig } from '@pluxel/hmr/host'

const plan = await planHmrHostFromConfig({
	root: process.cwd(),
	configPath: 'pluxel.hmr.jsonc',
	profile: process.env.PLUXEL_HMR_PROFILE ?? 'dev',
})
const { ctx, hmr } = await bootPlannedHmrHost(plan)
await hmr.start()
```

已有 `Context` 时，再用 `attachHmrRuntime(...)`。

## 前端边界

- dev：`ui(...).bind(ctx)` 由 HMR bridge 消费源码入口
- build：authoring bridge 会被重写成 `ctx.ext.ui.remote.packaged()`
- runtime：只消费编译后的 MF remote

这三层故意分开，避免把 HMR 语义塞进 runtime 元数据。

这里最关键的点不是“有没有 HMR”，而是“谁拥有源码语义”：

- `ui(...).bind(ctx)` 只属于 authoring / HMR / build 识别点
- `ctx.ext.ui.remote.packaged()` 才是最终 runtime 语义
- runtime 永远不应该回头理解 `entryPath`

## MF2 在 HMR 里的角色

HMR 对 MF2 的使用也很克制：

- HMR 不把 MF2 当 authoring API
- HMR 只把插件 UI 源码编译成 MF2 remote
- dev host 自己负责源码监听、重编译和 compiled module 提交

也就是说，HMR 负责“如何从源码得到 remote”，MF2 负责“remote 长什么样、宿主怎么加载它”。

## 插件 UI 构建模型

`@pluxel/hmr/plugin-build` 现在固定采用一个很刻意的模型：

- 同一个插件包根目录共享一个 root-scoped build scheduler
- 同 root 的多个 UI remote 构建请求会串行执行
- 每一次真正的 MF2/Vite build 都在一个全新的子进程里完成
- 每次 build 只清理这次专属的临时 cache，不主动触碰 root 下的 federation 临时目录

这不是保守实现，而是当前最实用的实现。

设计原因很直接：

- `@module-federation/vite` 当前在同进程重复构建时会残留进程内状态
- `1.14.1` 仍然需要在测试环境里显式关闭它自己的 test-env skip，但这已经收口在 child build 边界
- 所以“常驻 worker 里反复 build”虽然看起来更快，实际会更脆

因此这里故意只复用调度，不复用 federation build 进程状态。

最终收益是：

- 同 root 请求仍然能做去重和排队
- 跨 root 仍然可以并行
- 本地补丁面继续收缩在子进程边界和专属 cacheDir 上
- HMR/runtime 不需要额外理解上游插件的内部状态机

如果未来上游彻底修好同进程可重入性，这里唯一值得升级的方向，才是回到“每个 package root 一个常驻 build worker”。

## Paraglide

插件 UI 的 i18n 目标库现在锁定为 `@inlang/paraglide-js`。

当前约定：

- 插件包根目录必须提供 `project.inlang`
- 消息源目录固定为 `messages/`
- 生成目录固定为 `src/paraglide/`

在这个约定下：

- dev：`ExtensionCompilerService` 会自动把 `paraglideVitePlugin(...)` 注入插件 UI 的子编译
- build：`buildPluginUiRemote(...)` 也会自动注入同一个 Vite 插件
- watch/hash：会跟踪 `project.inlang` / `messages`，但不会把 `src/paraglide` 生成产物当成输入再次触发重编

也就是说，Paraglide 属于插件 UI 编译链能力，而不是 runtime 自己维护的一套翻译运行时。

这套约定的设计意图是：

- 插件作者只关心消息源和桥接 locale
- HMR/build 统一负责把 Paraglide 接到子编译里
- runtime 不再维护插件侧自定义字典注册接口

## 和 build/CLI 的协作

HMR 并不单独定义最终发布语义。正式构建时还会配合：

- `@pluxel/build`
  用 `hmrUiBridgePlugin()` 把 `ui(...).bind(ctx)` 降成 `ctx.ext.ui.remote.packaged()`
- `@pluxel/build/cli`
  把这类 rewrite 纳入默认 overlay
- `@pluxel/hmr/plugin-build`
  负责插件 UI remote 的 MF2 构建

也就是说，HMR 和 build 共享同一套 authoring 入口，但最后由 build 把 dev 语义清掉，只留下 runtime 需要的结果。

## 当前固定约定

如果你在维护这条链路，不要把下面几件事重新做成可选项：

- `ui(...).bind(ctx)` 继续作为唯一的插件 UI authoring bridge
- `ctx.ext.ui.remote.packaged()` 继续作为唯一的 runtime packaged 注册语义
- Paraglide 继续使用 `project.inlang` + `messages/` -> `src/paraglide/`
- 插件 UI 浏览器 contract 继续收口到 `@pluxel/runtime/web/ui`

## 公开面

- `@pluxel/hmr`
  low-level attach、Vite config helper、`HMRService`
- `@pluxel/hmr/host`
  标准 host 入口
- `@pluxel/hmr/plugin`
  作者侧 `ui(...)` / `worker(...)` bridge
- `@pluxel/hmr/plugin-build`
  插件 UI remote 的 MF build helper
- `@pluxel/hmr/diagnose`
  HMR 配置诊断
- `@pluxel/hmr/snapshot`
  `HmrWorkspaceSnapshot`

## 约束

- runtime 不理解源码 UI 入口
- host 和 runner 之间的单例桥接必须保持稳定
- dev handles 是 root-scoped，插件 ctx 只消费，不自己创建
- 宿主渲染 doc 仍走 runtime `ctx.ext.signaldb` / `ctx.ext.ui.*`
