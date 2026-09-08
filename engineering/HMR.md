# HMR Architecture

HMR 是 Plugin definition replacement，不是对运行中 instance 的字段修补。Module、Core graph、owner effects、
Workbench publication 和构建产物必须按一个确定边界切换。

## Definition replacement

Source/module 变化以 `PluginDefinitionSlot` 为 invalidation unit。同一 definition 的 default 与已创建 forks 在同一个
graph commit plan 中 replacement，保留各自 node address/slot 和 config；不能逐 fork 发布而留下 mixed constructor
generation。UI producer build input 按 definition/declaration 共享，不含 `forkId`；node publication 与 generation lease
仍隔离。身份作用域见 [`PLUGIN_IDENTITY.md`](PLUGIN_IDENTITY.md#各领域作用域)。

```text
module batch
  -> immutable catalog candidate
  -> coordinator prepare/commit
  -> stop old consumer/provider closure
  -> drain effects
  -> start new generations
  -> publish new Workbench Definitions
  -> commit Workbench topology/Content and any reusable producer
  -> background build/validate missing MF producer candidate
  -> commit producer inventory when ready
  -> close browser socket epoch
  -> full document reload
```

Route 对新 module namespace 只消费一个 immutable candidate，并把整批 catalog snapshot 交给 runtime-common
coordinator。Coordinator 在旧 generation 仍开放时完成 role/collision、forkability、binding 和 combined graph prepare；
catalog/RuntimeState revision race 会丢弃 prepared overlay 并重新 plan。

Structural reject 保留旧 catalog revision。第一次关闭旧 generation admission 是 point of no return；之后的 drain/init
failure 形成新 revision 的 lifecycle facts，不尝试复活旧 implementation。Optional provider 出现、消失或 replacement
也走同一个 consumer closure stop/start plan。

运行意图与运行事实分离：post-commit start/config failure 不写入 session stop，也不删除 autoStart policy。下一次有效
definition replacement 通过同一 coordinator/Core plan 自动启动仍在 desired graph 中的失败节点及 required consumer，
不依赖 Workbench 的 Start command。显式 Stop 则从 desired graph 移除节点，后续源码修复不能覆盖它。纯 catalog no-op
不强制创建 Core transaction，也不增加 timer retry loop；只有实际更新或明确 lifecycle command 才触发对应执行。

Route 为受影响 definition 记录进程内 `recentUpdate`，由 Runtime internal 的 `PluginRecentUpdateTracker` 统一保存。
快照分成 `batch` 与 `lifecycle`：前者含 `scope`（application / definitions）、outcome、phase、sequence、durationMs；后者只含
当前 node 的生命周期 issue，未观察到该节点的完整报告时为 null。空 issues 表示该批执行没有报告此节点的生命周期错误，不代表当前一定运行。

`batch.retained-previous` 只用于 point of no return 之前的 evaluate、artifacts、inject 或 commit rejection。Catalog 已成为 authority 后的
rejection 记录 `applied-with-issues / commit`，提交返回但生命周期有 issue 则记录 `applied-with-issues / lifecycle`；这些是整批事实，
不能广播成每个节点的失败。实际生命周期归因只消费该请求的 exact CommitSummary，按 node address（包括 fork）投影 phase、kind、message、blockedBy，
不读取全局“最后一次 commit”。未知节点或新 fork 不继承同 definition 其他节点的 lifecycle。成功补偿宿主使用 `restored-previous / application-reload`，
仍附带补偿启动的逐节点事实。

Static Vite 在接纳更新时分配 attempt sequence，区分正在 evaluate / artifacts / commit / application-reload 与已结算结果；
失败候选即使没有任何已提交 Plugin，也保留独立的 latest attempt。Dynamic module batch 与 Content refresh 使用同一记录器序列。
Management `updates.snapshot()` / `updates.follow()` 沿现有会话提供这份状态；订阅首帧包含当前值，慢消费者合并到最新快照，dispose 撤回观察者。
批次错误包含有界 message、可用的相对文件和已观察导入链；原始异常写入本地 runtime log，不把绝对路径或 stack 传入页面。
无法确认影响范围时只发布应用批次，不把所有旧插件标为根因。Plugin 的 `batch.error` 保留其历史批次原因，不能用最新批次覆盖历史。

Static Vite 分离已提交应用图与失败候选的恢复依赖。候选解析委托 Vite，观察可达 importer/specifier 关系，
失败后监听已解析新文件、缺失导入候选和相关 package manifest。Vite 忽略的安装目录及根外缺失文件由限于失败候选的 watcher 补充；
修正新文件或完成安装进入原串行更新队列，提交后释放恢复依赖及补充 watcher，关闭后禁止重新接纳。
补充 watcher 合并相互包含的扫描根，避免重复祖先扫描撤销仍有效的目录监听；精确候选路径过滤保持不变。

记录器限制 definition 与 node 保留数量，先验证整条记录再发布；同批次后续诊断可替换记录，但不得靠相同 sequence 复用旧节点错误。
后续插件重试或运行状态变化不篡改更新历史。Workbench 的红色生命周期提示只来自节点 issue；批次异常和当前运行问题有独立展示位置。

Database handle 固定引用一个 active instance。Replacement 先拒绝旧 handle 的新操作并等待已接纳操作排空；同 lineage
新 generation 复用 instance，schema-derived lineage 改变时构建空 candidate 并原子激活。Database backend、pool、instance
registry 和 durable rows 属于 root。

## Canonical Vite module graph

每个 `ViteDevServer` 只有一个 Pluxel SSR ModuleRunner 和 evaluated module namespace。Static application、dynamic
config、fixed plugins、mutable source anchors 和普通 ESM dependencies 都通过该实例求值；HMR layer 只增加分类、
invalidation、source anchor 和诊断，不创建第二个 cache。

Core、Runtime 与 Elysia host bridge 是 singleton identity 边界。Public、internal 和 workspace source path 都必须解析到
host 安装的 ESM entry；解析使用 import conditions，不能通过 CJS path 冒充 ESM singleton。Standalone
`@pluxel/context` 只有 host 直接安装时才进入 bridge。

Runtime-dev classifier 固定优先级：

1. host bridge singleton；
2. CommonJS/native package 保留在 Node host；
3. workspace ESM source 进入 Vite transform/HMR graph。

Bare specifier 与 `/@fs/` 边界使用同一 classifier，workspace alias 不能绕过分类。Project 不注入第二份 Vite
`InlineConfig` 或自定义 bridge policy。

Artifact classifier 也只消费三态正向证据：raw source lowering 对 exact definition 的事实才能产生 `source-module`；active
module closure 中 toolchain setter 的 exact literal definition 事实才能产生 `built-module`。文件扩展名、package 路径、未命中
source transform 或其他 negative match 都不是 built/source 证据；事实缺失或冲突必须是 `unreported`。每次 route update 把这些
事实放进一个 artifact generation，candidate 接纳后才 commit；evaluate、inject 或 host replacement 失败必须 rollback generation，
不能让失败 candidate 污染下一次 active classification。候选 transform、evaluation 与 classification 必须运行在该
generation 的异步 scope 内；不在该 scope 内的并发 ambient transform 仍是独立 authority。Commit 按 module 校验
generation 开始时的 ambient version，已有更新 ambient 事实的 module 不被旧 candidate 覆盖；rollback 也不撤销这些并发事实。

React transform/refresh 也只有一个 owner：dynamic development 的 `dynamicRuntimeVitePlugin()` 自带
`@vitejs/plugin-react`，starter 不再重复安装；static host 由应用配置安装；distribution mode 不安装；独立 HMR server
仅在存在 browser client entry 时安装。Starter smoke 必须同时验证静态、动态入口图和 `/@react-refresh` 的 JavaScript
响应，避免 plugin stack 重复或缺失形成空 MIME/404。

Portless 只把稳定的外部 `*.localhost` origin 路由到这一个 `ViteDevServer` 注入的物理 listener；它不创建第二个 HMR graph。
业务 SPA、Workbench、Cap'n Web WebSocket、MF assets 与 Vite HMR 保持同源，分别由既有 path/upgrade 仲裁。Workbench 与业务前端
因此可以同时显示两个 URL，但不能据此拆成两个 server port。

## Static 与 dynamic route

`staticRuntimeVitePlugin({ entry })` 通过 ModuleRunner 加载 canonical `defineStaticRuntime()` entry。Static route 使用 Vite 的
`hotUpdate` 将 create/update/delete 事件送入同一个更新队列；同一次文件事件只执行一次 runtime 更新，避免 client/SSR
两套环境重复提交或在提交后再次失效已加载的 constructor。普通 Plugin
dependency 变化精确失效 importer graph；application entry/configure graph 变化重建 host。Single-active logging root
要求先停止旧 host；新 application 创建或 start 抛出错误时先停止并清理失败的新 host，再从上一次成功 application definition 创建一个
fresh host。只有补偿 host 成功启动才记录 `restored-previous / application-reload`。这是 full-host replacement 的 compensation，
不是保留或复活旧 running generation，也不把同一进程内的普通 definition transaction 改成可回滚；补偿本身失败时不得报告
restored。Start 正常返回的部分节点 lifecycle issue 保留新 host 并逐节点报告，不触发宿主补偿。

Management status 将当前 committed definition 的执行方式投影为 route-owned `execution` fact，而不是从文件扩展名、
`displayName` 或 package label 猜测。production static freezer 产物固定为 `static-bundle / application-bundle / deployment`；
Vite static catalog 仅根据上述 source/built 正向 semantic fact 报告 `source-module` 或 `built-module`，无法证明时使用
`unreported`，三者的更新方式都是 `catalog-hmr`。它表示 application module closure 变化会在当前 host 内提交 live catalog
transaction；canonical entry、应用 metadata 或只影响 `configure()` 的依赖变化仍会重建 host。不经过 Vite 的通用 static catalog
使用 `manual`。Artifact 与更新机制是正交事实：不能用 `source-module` 推断 HMR，也不能因 artifact 未报告而隐藏 route 已知的
catalog HMR。这些值不提供把 running definition 在线切换到另一种 route/mode 的控制 API。

Dynamic route 先提交 fixed baseline，再处理显式 mutable sources。Source 只接受精确文件或不能逃逸 source directory 的
正向 include glob，结果最多 10,000 entries。Initial discovery 与 watcher add/change/unlink 共用同一 batch 路径；
普通 import dependency 变化沿 importer graph 回到 source anchor。

Vite 主 watcher 继续全局忽略 `.pluxel`，避免 persistence、安装目录和 artifact cache 进入通用 module watcher。Dynamic route
仅为配置已声明且位于 `.pluxel` 下的 source watch root 建立 route-owned supplemental watcher；它不扩大 source 集合，事件仍须通过
精确 file 或正向 include glob 才进入同一 batch。补充 watcher 在 route shutdown 的 admission barrier 中同步停收并随后关闭。

Dynamic fixed plugin 报告 `dynamic-fixed / host-reload`。Mutable entry 若 semantic collector 以正向事实证明 definition 来自当前 Vite
source graph，则报告 `dynamic-entry / source-module / definition-hmr:source-graph`；这表示 entry 及其被跟踪的源码依赖都属于
definition HMR invalidation scope。只有 active closure 中存在 exact built semantic fact 才报告 `built-module`；否则 route 报告
`unreported`，两者的更新边界都是 `dynamic-entry / definition-hmr:entry-only`。Route 仍监听 producer 原子发布或替换的 entry，
但不承诺监听 package 内部源码。开发模式安装的外部 package 因此通常是 `entry-only`，并不会仅因 `.mjs` 扩展名、package
路径或 host 运行在 HMR 模式就获得 built/source 分类或 package source-graph HMR。

Dynamic host 的扫描、存储、module resolution 与日志路径都显式锚定 resolved `root`。启动和 replacement 不得调用
`process.chdir()`；同进程 Vite 持有自己的 config/root 解析上下文，Plugin 中明确声明为“相对当前工作目录”的路径则继续以
launcher cwd 为准。两者不同时，宿主配置应传绝对 Plugin 数据路径。

Source producer 只原子发布普通 ESM entry；package acquisition、lockfile、registry、安装状态、RPC 和 UI 都属于 producer
Plugin。Dynamic batch 拥有一次 update 内的 unpublished draft，commit 后唯一 authority 是 coordinator immutable snapshot。
不保留第二份 committed registry 或 post-commit route callback。

Shutdown 顺序是：停止 watcher/batch/direct-call admission → 等待已接纳的 startup → 丢弃未开始 debounce → 排空 active batch、
direct execute/warmup 与 Workbench Content refresh 的共享 execution lane → Core lifecycle/effects cleanup → Vite hooks →
ModuleRunner close。关闭开始后，已接纳的 Content refresh 可以完成原子发布，但不能再发送 browser full reload；跨越关闭边界才取得
execution lane 的 direct call 必须以 `HmrClosedError` 失败，不能触碰 baseline、semantic source 或 executor。

## Workbench producer build

`PluginArtifactCompiler` 位于 `packages/runtime-dev/src/workbench/`。Route attachment 总是可以安装 Node source provider，
只在 Workbench enabled 时安装 UI source provider；Workbench-disabled 路径不加载 MF builder。

Semantic lowering 在 TypeScript 擦除前读取 `workbench.define()` 和 literal `workbench.entry()`，一次生成 owning Plugin
definition 的完整 producer plan。Compiler 不重新发现 declarations 或计算第二个 build revision。

Workbench 的模块事实与 publication 按模块一起替换；每次 transform 在异步解析前取得更新身份，迟到结果不能覆盖
较新的 transform、失效或删除。watcher 失效先记录待更新模块，candidate 接管这些失效并在独立快照中重新解析。
成功编译读取的导入事实也属于这一代，提交时与 source/built facts 共用 ambient version 冲突检查；失败 candidate
丢弃后仍使用已提交事实，不从失败源码重建旧定义。解析 Promise 只活在本次编译中，失败不会阻塞下一次有效更新。
删除模块或将它改成普通模块会撤销原 publication。生成 Bridge 和 renderer projection 的目录包含 build revision，
后续 candidate 不覆盖已返回 plan 引用的生成文件。

同一 producer task 去重；同一 definition 的新 plan supersede 旧 in-flight build。`@module-federation/vite` 1.21.1 的
producer build 直接在当前进程运行；真实双 producer 并发回归必须验证 expose、Manifest 和 JavaScript 不串线。统一 artifact
compiler 不再为 Workbench 叠加通用 build queue；MF builder 自己拥有两个 build slot。上游 export detector 仍有
process-global application root：同一 application root 最多并发两个 producer；不同 root 按到达顺序形成 cohort，切换前必须等
当前 cohort 排空，后到的同 root task 不能越过已经等待的其他 root。这个精确约束不能扩大为全局单线程。Node artifact 继续使用
独立的两个 build slot。同一 output 的 transaction ordering 始终保留，保证 immutable candidate 的 validation/publication 不交错。
Runtime-dev 先准备并验证候选 topology/Content，准备过程不改变 current tuple，也不取消已接受代的后台构建。
Route 在 Core graph 接受点同步激活候选：正常替换中此时旧代已排空，新代尚未启动；被拒绝候选只丢弃准备结果。
只有激活才推进 publication epoch 并启动缺失 producer 的后台构建；后台验证完成后再次检查 epoch，拒绝迟到的过期结果。
已存在的 producer artifact 可在准备路径快速复用。初启和已接受定义的纯 Content 更新使用相同 prepare/commit 实现。producer 进入构建时记录 name/revision，完成时记录 `built` 或磁盘 `reused` 及端到端耗时；内存 candidate 复用保持
静默，失败日志保留同一归因和原始错误。开发 producer 使用持久 Vite cache，默认不生成 dynamic types；production 或显式
required type policy 仍严格生成和校验类型资产。

每个 candidate 必须验证：

- producer name 和 build revision；
- `mf-manifest.json` 与标准 Snapshot；
- exact `./views/<key>` expose inventory；
- `remoteEntry.js`、全部 JS/CSS runtime assets 均存在；
- fixed singleton shared 包和 exact versions；
- generated React Bridge declaration identity。

验证失败不提交 producer inventory；开发期对应 layout entry 保留原位置并显示 failed 状态，等待下一次重试。成功 candidate 原子进入
`WorkbenchArtifactService` 的 immutable producer inventory；production freezer 写入同构的
`pluxel-workbench-producers.json`，runtime 不从 source 重新编译。Production candidate 额外要求 dynamic type files 存在。

## Browser update policy

Workbench 不实现页内 remote HMR。Producer inventory commit 或 Plugin publication epoch 改变后：

1. Server invalidates current Cap’n Web session；
2. Shell destroy active Bridges 并 dispose opened handles；
3. 当前 document 显示更新提示并自动完整刷新；连续刷新使用递增等待，10 秒内达到 3 次后暂停并保留手动入口；
4. 新 document 创建一条新 socket、重新认证/bootstrap、读取 layout；
5. MF Runtime 加载 pinned new manifest/expose 并创建 fresh roots/Bridge。

认证撤销与 broken 状态不自动刷新。自动刷新保留 URL 与已持久化工作区布局，不承诺保留未保存的表单草稿。

Shell 源码更新若传播到 document entry，必须在 Vite 重新执行入口前释放 React root 与 session 并整页导航，避免同一 document 创建第二条连接；普通组件热更新保持原路径。

旧 document 不注册新 remote，不把新 roots 接到旧 renderer，不保存 old remote fallback。Candidate build failure 不会
推进 producer inventory；开发期 topology publication 可以先让未就绪 View 以 building 状态出现，失败后用 registry
revision 更新为 failed 状态。Vite HMR socket 可以作为 toolchain update signal carrier，但 Workbench 产品动作仍是
producer 成功后的 full reload。

## Node module update

Node module declaration 保持独立 artifact lifecycle。`ctx.nodeModules.use()` 对每个 consumer 串行 staged setup：新 setup
成功后才 cleanup previous；失败保留 last-known-good。Owner stop 使 pending generation 失效，迟到 setup cleanup 立即执行。
Worker task 的新 dispatch 读取 content-addressed 新 module URL，已运行 task 继续使用原 module；取消/stop 仍等待真实 worker
退出。

## 验证

- definition-wide default/fork replacement 不出现 mixed constructor generation；
- structural reject 保留旧 catalog，PONR 后 failure 只报告 lifecycle facts；
- 连续失败的源码求值保留旧 HTTP/WebSocket generation，修复后自动替换；
- config/init 失败后的有效 replacement 自动恢复 required closure，未修改的 consumer 也能重新启动；
- 显式 Stop 保持停止，前一次更新 rejection 不堵住排队的修复更新；
- execution snapshot 只允许 route/artifact/update 的合法组合，`entry-only` 不误报 package source graph；
- source/built 只来自 exact positive semantic facts，失败 artifact generation rollback 后不污染 active facts；
- recent update 区分 retained previous、commit/lifecycle applied-with-issues 与 application-reload restored previous；
- 同一批次的 node/fork 历史不串线，批次异常不等于每个节点异常；
- full-host replacement 只在 fresh compensation host 成功启动后报告 restored previous；
- Management DTO 不包含 absolute path、`file:` URL、`/@fs/` 或 Vite module ID；
- optional provider replacement 正确重启 consumer closure；
- database accepted operations 在 replacement 前 drain；
- static/dynamic 共享一个 ModuleRunner 与 source classifier；
- dynamic host generation 不改变 Vite 进程 cwd；
- Workbench candidate failure 不推进 producer inventory；
- stale/superseded producer 不能 commit；
- successful producer commit 关闭 socket epoch 并触发 full reload；
- 新 document 不复用旧 roots、Bridge、host facade 或 MF registration；
- Workbench-disabled host 不加载 MF builder；
- Node module staged setup 保持 last-known-good。

## Development console execution

显式启用的 dev console 使用同一个 SSR runner，执行根不是 Plugin catalog entry。脚本等待真实 watcher 接纳已知依赖修改，再等待 route 的有限更新序列；执行期间不锁住整个 HMR coordinator。full-host replacement 撤回旧 run scope，后续提交获取新 epoch。源码观察、finite barrier 与资源边界见 [`DEV_CONSOLE.md`](DEV_CONSOLE.md)。
