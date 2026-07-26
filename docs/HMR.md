# HMR Architecture

Database handle 与 plugin generation 绑定，并固定引用一个 active database instance。replacement 撤销旧 handle 和
live-query lease；同 lineage 新 generation 复用 instance，`migrations` evolution 只应用缺失 migration，
`reset-on-schema-change` 的 schema-derived lineage 改变时则构建空 candidate、原子激活
并归档旧 instance。PGlite backend、PG pool、instance registry 和 durable rows 属于 root，不随 module replacement 重建；
candidate 失败保持原 active instance，但 core rollback 仍通过新 handle acquisition 验证 artifact 与 lineage。
owner teardown 先使 handle 拒绝新操作，再等待已经接受的运行中和排队操作排空；plugin stop 完成后才允许 replacement
generation 启动。因此不会产生预期取消的 unhandled rejection，也不会让旧 generation 的数据库操作跨越 replacement。

HMR replacement 必须保持 core lifecycle、Workbench resources 和 UI artifact 同步：

```text
module batch -> committed graph -> stop old owner/effects -> start new owner
             -> mount module/resources -> compile artifact -> Workbench revision
             -> Workbench refetch target layouts -> lazy load new remote
```

optional plugin candidate 的 canonical plugin ID 生成 synthetic module owner。consumer module replacement 会撤销旧 watcher
subscription；新 ref 重新解析后，同一 synthetic owner 通过正常 `replace()` transaction 更新 provider，running watcher
负责 callback cleanup/rebind。package/lockfile discovery invalidation 只重试 active requests，同一失败 generation 不循环重试。

`PluginArtifactCompiler` 位于 `packages/runtime-dev/src/workbench/`，dynamic/static route 只负责提供 Vite server、
plugin directory 和 host policy。attachment 始终安装 Node source provider，并只在 Workbench enabled 时安装 UI
source provider；两者共享 lazy compiler、target-keyed graph/watch queue、cache retention 和 atomic publication。
Workbench 与 Node builder 都保持 lazy import，因此 Node-only/Workbench-disabled 路径不加载 Federation builder。
旧 artifact 有界保留供 inflight import 完成。
artifact 编译状态只推进 catalog/layout revision，不撤销资源 grant；module、实例或依赖资源图变化会推进
独立的 grant revision，并让旧 layout binding 立即失效。这样 UI-only HMR 不会制造无效 binding 竞态，
也不会放宽资源图变化时的 capability 撤销语义。

测试至少覆盖 module replacement cleanup、compile error state、cached artifact、target layout refresh 和
disabled Workbench Plane，以及 Node module 的合并 rebuild、staged setup 和 last-known-good。

## Static Vite route

`staticRuntimeVitePlugin({ entry })` 通过 Vite SSR ModuleRunner 加载 canonical `defineStaticRuntime()` entry。普通 plugin
module 变化会失效精确 module/importer graph，并通过 core replacement lifecycle 更新 fixed catalog；entry 本身或
只改变 `configure()` 结果的依赖变化会重建 host。single-active logging root 要求重建时先停止旧 host；新 application
启动失败时 route 会用上一次成功的 application 重新创建 host，使后续 HMR 仍可重试。

Workbench UI 与 Node module declaration 都交给 runtime-dev compiler，因此 static route 在开发期具备与 dynamic route
相同的 artifact HMR contract。两者的差别是 catalog 来源：static 从 entry imports 得到，dynamic 从 workspace loader
得到。production frozen distribution 不携带 watcher、Vite server 或 HMR compiler。

## Workbench UI Federation 构建隔离

`buildWorkbenchUiRemote()` 把每个 remote 作为独立 staging transaction 构建、校验并原子发布。
相同 build key 的请求在进程内合并；同一输出目录的不同请求按整条 transaction 串行，避免较早构建在
较晚构建之后覆盖目标目录。

截至 `@module-federation/vite@1.16.16`，上游 builder 仍不是 reentrant：
`normalizeModuleFederationOptions()` 会覆盖 module-scoped `config`，VirtualModule registry、
`hostAutoInitModule` 和部分 shared caches 也属于模块级单例；manifest 和 bundle hooks 会在稍后重新读取这些
状态。因此同一 Node.js 进程内并发执行两个 `vite.build()` 会发生 remote name、virtual entry 或 shared
配置串扰。Pluxel 将实际 Federation builder 调用建模为 process-wide exclusive resource；源码 hash、缓存
检查和图准备等前置工作由内核 worker pool 并发，精确相同的构建仍会去重。并发和 shared package 集合不是
项目配置面，避免调用方意外串行化安全阶段或生成与宿主不一致的 remote。

static/dynamic Vite route 在确认 Workbench 启用后会预热浏览器 client graph，让 Vite 在首个页面请求前完成
依赖发现与 CJS interop。Workbench 关闭时不会扫描或预构建这套 UI 依赖；项目也不需要维护
`optimizeDeps.include`、`noDiscovery` 或包管理器路径 alias。

这项可选配置必须在 `configureServer` 阶段加入 client `optimizeDeps.entries/include` 与 `dev.warmup`，再由 Vite 的
environment `listen()` 顺序执行 optimizer init 和 warmup；不得在 optimizer 初始化前直接调用
`warmupRequest()`。route cache directory 随这项 optimizer contract 版本化，避免把旧 dependency graph metadata
带入新 contract 后触发 Vite 的增量比较缺陷。

升级上游后不要凭版本号删除该隔离。移除前必须同时确认：

1. normalized options 和所有 VirtualModule/cache registry 已改成 federation instance ownership；
2. 不同 package root 的并发 remote 回归用例允许 builder 临界区重叠后，连续运行仍得到各自正确的
   manifest name、entry 和 UI marker；
3. 同输出目录的 transaction queue 继续保留，它解决的是 Pluxel 自身的发布次序，与上游是否 reentrant
   无关。

Workbench 的 Federation host 和 `remoteName -> cache-busted entry` registry 保存在 `globalThis` 的
`Symbol.for('pluxel.workbench.federation-runtime')` 状态中，以跨越 Vite module HMR。相同 entry 的多个 view
load 是幂等的，不重复 `registerRemotes()`；只有 `sourceHash` 或 `compiledAt` 改变后才以 `force: true` 替换
remote。不要把该状态退回普通 module local，否则同一插件的多个 view 和 HMR 重载会反复清除 MF remote
cache 并产生 `already registered` 警告。

浏览器通过 Federation Runtime API 把 cache-busted `remoteEntry.js` 明确注册为 ESM remote，再调用
`loadRemote()`；`mf-manifest.json` 保留上游生成的完整 asset graph，只用于 artifact 校验和诊断。构建器不得
改写 MF virtual module 或清空 manifest preload 字段来修正初始化次序；remote container 的 `init -> get`
顺序由 runtime contract 负责。
