# HMR Architecture

Database handle 与 plugin generation 绑定，并固定引用一个 active database instance。replacement 撤销旧 handle 和
live-query lease；同 lineage 新 generation 复用 instance，`migrations` evolution 只应用缺失 migration，
`reset-on-schema-change` 的 schema-derived lineage 改变时则构建空 candidate、原子激活
并归档旧 instance。PGlite backend、PG pool、instance registry 和 durable rows 属于 root，不随 module replacement 重建；
candidate 失败保持原 active instance，但 core rollback 仍通过新 handle acquisition 验证 artifact 与 lineage。
owner teardown 先使 handle 拒绝新操作，再等待已经接受的运行中和排队操作排空；generation effects drain 完成后才允许 replacement
generation 启动。因此不会产生预期取消的 unhandled rejection，也不会让旧 generation 的数据库操作跨越 replacement。

HMR replacement 必须保持 core lifecycle、Workbench resources 和 UI artifact 同步：

```text
module batch -> committed graph -> stop old owner/effects -> start new owner
             -> mount module/resources -> compile artifact -> Workbench revision
             -> Workbench refetch target layouts -> lazy load new remote
```

source/module 变化以 `PluginDefinitionSlot` 为 invalidation unit。一个 definition 的 default 与已创建 forks 在同一 graph commit plan
中 replacement，保留各自 node address/slot 和 config；不能逐 fork 发布而留下 mixed constructor generation。artifact build input 按
definition/declaration 共享，不含 `forkId`；node binding 与 generation lease 仍隔离。身份作用域见
[`PLUGIN_IDENTITY.md`](PLUGIN_IDENTITY.md#各领域作用域)。

route 对新 module namespace 只消费一个 immutable definition candidate，并把整批 catalog snapshot 交给 runtime-common coordinator。
coordinator 在旧 generation 仍开放时完成 role/collision、forkability、binding 与 combined graph prepare；catalog/RuntimeState revision race
会丢弃 prepared overlay 并重新 plan。只有 revision 稳定后才进入 definition-wide stop/start 与 Core confirm。新 candidate 造成 structural
reject 时保留旧 revision；进入 transition 后的 config/init/drain failure 属于新 revision 的 lifecycle facts，不回退旧 implementation。

同一 address 的 concrete/abstract role 在 host lifetime 内稳定；coordinator 的小型 role tombstone 会跨 absent catalog revision 检查
`plugin_definition_role_conflict`，但不跨 cold boot 持久化，也不创建 Core slot。collision、role conflict、optional-abstract violation 与 invalid live
graph 都在 Core prepare 和持久化前以稳定 structural code 拒绝。第一次关闭旧 generation admission 是 PONR；graph-confirmation callback 本身只交换
coordinator 自身 immutable snapshot/applied fields，不调用 route callback、loader method 或任何可能 throw 的用户代码。PONR 后的 Plugin
teardown/init failure 只形成 lifecycle report，不再拒绝或回滚已确认的结构变化。

optional ref 已被 lower 成 definition slot edge，不拥有 loader、watcher subscription 或 synthetic module owner。catalog/source
transaction 让 provider running generation 出现、消失或 replacement 时，core 在同一 plan 中先停止 optional consumer closure、
drain effects，再更新 provider并重启 consumer；absent 状态下重复失败不会制造 restart。

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
启动失败时 route 会用上一次成功的 application 重新创建 host，使后续 HMR 仍可重试。Vite plugin teardown 会等待
active static host 完整停止；host lifecycle 与 ModuleRunner 都关闭后 `ViteDevServer.close()` 才完成。

Workbench UI 与 Node module declaration 都交给 runtime-dev compiler，因此 static route 在开发期具备与 dynamic route
相同的 artifact HMR contract。两者的差别是 catalog policy：static 只有 application import 的 fixed catalog；dynamic 先提交
config import 的 fixed baseline，再处理 workspace profile 和显式 `sources` 得到的 mutable entries。production frozen distribution
不携带 watcher、Vite server 或 HMR compiler。

每个 `ViteDevServer` 只有一个 Pluxel SSR ModuleRunner 与 evaluated module namespace。dynamic config、它 import 的 fixed plugins、
mutable source anchors 和普通 ESM dependencies 都经由该实例求值；HMR runner 只增加 path、bridge、host-module classification、
invalidation 与诊断，不创建第二个 cache。config import graph 变化重建 dynamic host，mutable dependency 变化沿 importer graph
精确回到 source anchor。

dynamic loader 的 bridge modules/providers、SSR、dedupe、optimizer 和 Vite cache 都是运行时不变量，不接受宿主覆盖，
也不合并第二份 `InlineConfig`。模块执行边界按固定优先级处理：bridge 首先保持 host singleton identity；随后由
runtime-dev 共享 classifier 将 CommonJS/native package 留在 Node host；其余 workspace ESM source 才进入 Vite transform
和 HMR graph。dynamic runner 在 bare specifier 与 Vite 已解析的 `/@fs/` 边界调用同一个 classifier，因此 workspace alias
不会绕过分类，也不需要 package 名单。

dynamic source 只接受精确文件和带显式、相对、正向 include glob 的目录；glob 不允许越过 source directory，解析结果有
10,000 entry 的内核上限。启动 discovery 与 watcher add/change/unlink 共用同一入口语义；暂时不存在的目录仍保留为 watch root。
初始 entries 必须完成 graph commit 后 host 才报告 ready，不存在可跳过正确性的 optional warmup。source entry 已进入 module graph
后，目录外的普通 import dependency 变化会沿 importer graph 回到 source anchor；没有任何
source-owned importer 的过期事件作为 debug-level no-op，不制造失败告警。source producer 负责在目标目录原子发布普通 ESM entry，dynamic route
负责解析、执行、生成 catalog batch 并交给 common coordinator；卸载和 optional availability invalidation 也走同一路径。registry client、lockfile、market、安装状态、
RPC 与 UI 都必须位于 source producer 插件，不得进入 HMR pipeline。

Dynamic batch 只拥有一次更新期间的 unpublished catalog draft；commit 后唯一 authority 是 common coordinator 的 immutable
catalog snapshot。loader registry、resolver、module provenance 与 mutable-source anchor 查询都从该 snapshot 派生；fixed
config module provenance 不进入 source anchor set。anchor set 按 snapshot identity 至多构建一次并在同一 revision 内提供
O(1) membership lookup。draft/snapshot publication 允许 O(C) 构建成本，
不为追求假设的增量复杂度保留第二份 committed registry、persistent overlay 或 post-PONR route publication。

catalog/source batch 可以触发 `O(C + F + B + E)` 的 bounded reconciliation；blocked closure 必须通过 reverse-edge queue 线性传播。
definition replacement 继续由 Core 的 definition-to-materialized-node index 枚举 `k` 个 variants，复杂度为 `O(k + affected edges)`，不能扫描完整
Core graph。纯 addressed restart 与 running config apply 不属于 catalog HMR，不得进入 full reconciler。static route 同样只读取 coordinator
committed snapshot，不能为 fixed catalog 保留例外 authority。

source watcher 和 resolved source declaration reader 在 fixed baseline commit 前安装。producer 可通过隔离的
`@pluxel/runtime-dynamic/source-producer` 校验目标 file/directory；该入口不创建 watcher 或 publication lease，也不加载 Vite、
workspace scanner 或 package manager。

Workspace profile 的 `enabled` 是 mutable package entry selection：CLI 选择的 package entry 会进入初始加载列表，其 workspace
dependency closure 会成为 watch roots。它不直接启用插件 lifecycle；module 求值后，插件是否启动仍只读取 RuntimeState。config
的 `plugins` 是 fixed availability，不进入 CLI discovery；同一 definition address 同时由 fixed 与 mutable catalog 提供时启动失败。
generation shutdown 先停止 watcher/batch admission，丢弃尚未开始的 debounce queue，等待正在执行的 batch 完成，再进入 core
lifecycle/effects cleanup；Vite/plugin close hooks 完成后才关闭 canonical ModuleRunner。

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

static/dynamic Vite route 在 `config` hook 声明同一个 Workbench client entry 与必要的 CJS interop include，配置会进入
Vite 的首轮 optimizer plan 和 config hash；项目不需要维护 `optimizeDeps.include`、`noDiscovery` 或包管理器路径
alias。不得在 `configureServer` 后修改 resolved client config，也不额外并发 client warmup。

artifact compiler 收集插件 UI watch graph 时只使用 SSR environment 的 transform/module graph；这属于服务端编译
元数据，不得调用 host client `transformRequest()` 污染 browser optimizer。否则插件 UI 的部分依赖会与全局
Workbench entry scan 形成两个 metadata 集合，触发 Vite 增量比较缺陷。route cache directory 随 optimizer contract
版本化，避免旧 dependency graph metadata 跨 contract 复用。

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
