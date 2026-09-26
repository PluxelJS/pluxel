# HMR：候选、提交与失败恢复

HMR 是 Plugin definition replacement，不是对运行中 instance 的字段修补。Module、Core graph、owner effects、
Workbench publication 和构建产物必须按一个确定边界切换。

按问题选读：[replacement 与提交边界](#definition-replacement)、[Vite namespace](#canonical-vite-module-graph)、[固定/动态来源](#固定-catalog-与可选动态来源)、[制品候选](#workbench-candidate-inputs)、[producer 构建](#workbench-producer-build)、[来源失败恢复](#来源观察失败)。[验证](#验证)区分 graph、真实 Vite、browser 与 Node 资源边界。

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
  -> commit Workbench topology/Content and any reusable producer
  -> start new generations
  -> publish new Workbench Definitions
  -> background build/validate missing MF producer candidate
  -> commit producer inventory when ready
  -> close browser socket epoch
  -> full document reload
```

共享开发驱动对新 module namespace 只消费一个 immutable candidate，并把整批 catalog snapshot 交给 Host。
Host 的控制协调器把持久策略接入同一操作序列；Host 在旧 generation 仍开放时完成 role/collision、forkability、binding 和 combined graph prepare；
catalog/Host state revision race 会丢弃 prepared overlay 并重新 plan。

Structural reject 保留旧 catalog revision。第一次关闭旧 generation admission 是 point of no return；之后的 drain/init
failure 形成新 revision 的 lifecycle facts，不尝试复活旧 implementation。Optional provider 出现、消失或 replacement
也走同一个 consumer closure stop/start plan。

运行意图与运行事实分离：post-commit start/config failure 不写入 session stop，也不删除 autoStart policy。下一次有效
definition replacement 通过同一 coordinator/Core plan 自动启动仍在 desired graph 中的失败节点及 required consumer，
不依赖 Workbench 的 Start command。显式 Stop 则从 desired graph 移除节点，后续源码修复不能覆盖它。纯 catalog no-op
不强制创建 Core transaction，也不增加 timer retry loop；只有实际更新或明确 lifecycle command 才触发对应执行。

### 更新报告：批次与节点事实

Host-dev 与服务开发附件为受影响 definition 记录进程内 `recentUpdate`，由 Host internal 的 `PluginRecentUpdateTracker` 统一保存。
Host root 绑定路由拥有的 reader，Host status 与 Management 默认读取这份记录；替换宿主继续使用同一路由历史。
快照分成 `batch` 与 `lifecycle`：前者含 `scope`（application / definitions）、outcome、phase、sequence、durationMs；后者只含
当前 node 的生命周期 issue，未观察到该节点的完整报告时为 null。空 issues 表示该批执行没有报告此节点的生命周期错误，不代表当前一定运行。

`batch.retained-previous` 只用于 point of no return 之前的 evaluate、artifacts、inject 或 commit rejection。Catalog 已成为 authority 后的
rejection 记录 `applied-with-issues / commit`，提交返回但生命周期有 issue 则记录 `applied-with-issues / lifecycle`；这些是整批事实，
不能广播成每个节点的失败。实际生命周期归因只消费该请求的 exact CommitSummary，按 node address（包括 fork）投影 phase、kind、message、blockedBy，
不读取全局“最后一次 commit”。未知节点或新 fork 不继承同 definition 其他节点的 lifecycle。成功补偿宿主使用 `restored-previous / application-reload`，
仍附带补偿启动的逐节点事实。

开发驱动在接纳更新时分配 attempt sequence，区分正在 evaluate / artifacts / commit / application-reload 与已结算结果；
失败候选即使没有任何已提交 Plugin，也保留独立的 latest attempt。来源更新与 Content refresh 使用同一记录器序列。
Management `updates.snapshot()` / `updates.follow()` 沿现有会话提供这份状态；订阅首帧包含当前值，慢消费者合并到最新快照，dispose 撤回观察者。
批次错误包含有界 message、可用的相对文件和已观察导入链；原始异常写入本地 runtime log，不把绝对路径或 stack 传入页面。
无法确认影响范围时只发布应用批次，不把所有旧插件标为根因。Plugin 的 `batch.error` 保留其历史批次原因，不能用最新批次覆盖历史。

### 失败候选的恢复输入

Host-dev 分离已提交应用图与失败候选的恢复依赖。候选解析委托 Vite，观察可达 importer/specifier 关系，
失败后监听已解析新文件、缺失导入候选和相关 package manifest。Vite 忽略的安装目录及根外缺失文件由限于失败候选的 watcher 补充；
修正新文件或完成安装进入原串行更新队列，提交后释放恢复依赖及补充 watcher，关闭后禁止重新接纳。
补充 watcher 合并相互包含的扫描根，避免重复祖先扫描撤销仍有效的目录监听；精确候选路径过滤保持不变。

记录器限制 definition 与 node 保留数量，先验证整条记录再发布；同批次后续诊断可替换记录，但不得靠相同 sequence 复用旧节点错误。
后续插件重试或运行状态变化不篡改更新历史。Workbench 的红色生命周期提示只来自节点 issue；批次异常和当前运行问题有独立展示位置。

Database replacement 必须同时满足 generation 撤回与 active instance 切换；同 lineage 复用和新 lineage 原子激活规则由 [DATABASE](DATABASE.md#schema-evolution) 拥有。

## Workbench candidate inputs

Host-dev 给开发附件传递本次 `HostDevelopmentCatalog`：确切求值模块闭包与所选 definition addresses。
附件不能用仍属于上一代的 `host.catalog()` 推测候选。Workbench 同时接纳源码 lowering 与预编译模块的正向 ABI facts；
仅加载候选明确选中的 definition，不为只是被 import 的其他 export 发布产物。

预编译包通过确切模块的 owning package 读取 `dist/workbench` inventory，校验 package identity 与已有生产 artifact contract；
不扫描零散制品目录，不重编译发布包。候选先统一 prepare；graph 接纳时同步 commit，结构拒绝保留旧 tuple，移除时统一撤回。
未选中的 export 不要求其 artifact 目录存在。物理 `node_modules` 的 ABI facts 可被读取，但第三方原始源码不会因此启用 Plugin lowering。

Host replacement 补偿先退出并回滚失败的 semantic generation。已接纳的 catalog 对象是稳定快照 identity；Workbench 缓存它已提交的
source/package artifact inputs，以便补偿 Host 复用旧计划，而不是读取已被新版本覆盖的 inventory。缓存不复制包的磁盘 bytes：旧 revision
被删除或覆盖时仍执行正常 artifact 校验；不能恢复则报告补偿失败，不能给旧 constructor 配上新 artifact 冒充恢复。

## Canonical Vite module graph

每个 `ViteDevServer` 的专用 `pluxel` environment 只有一个 Host ModuleRunner 和 evaluated module namespace。
应用声明、fixed plugins、mutable source anchors、开发控制台和普通 ESM dependencies 都通过该实例求值；HMR layer
只增加分类、invalidation、source anchor 和诊断，不创建第二个 Host cache。默认 `ssr` 与第三方 `ssrLoadModule`
使用独立的 Vite 环境、执行缓存与生命周期，不接受 Host 的 source conditions、singleton 或语义 collector。

Core、Host 是通用开发驱动的 singleton identity 边界；官方 `serviceSingletons()` 另外固定 Services（含 Management、Logging）与 Workbench，并保持 Cap’n Web 的 native ESM identity。相应 public、internal 和 workspace source path 都必须解析到
host 安装的 ESM entry；解析使用 import conditions，不能通过 CJS path 冒充 ESM singleton。Standalone
`@pluxel/context` 只有 host 直接安装时才进入 bridge。

Host-dev classifier 固定优先级：

1. host bridge singleton；
2. CommonJS/native package 保留在 Node host；
3. workspace ESM source 进入 Vite transform/HMR graph。

Bare specifier 与 `/@fs/` 边界使用同一 classifier，workspace alias 不能绕过分类。Project 不注入第二份 Vite
`InlineConfig` 或自定义 bridge policy。
通用 source pipeline 默认启用 Vite `resolve.tsconfigPaths`，但保留显式 `false`；alias 的解析仍由 Vite 拥有，
Host-dev 只分类其物理结果。浏览器 Node builtin guard 使用 Vite 的 browser external 结果报错，允许显式浏览器实现，
不在 server environment 运行。开发诊断的公共事实是应用 recent update 与逐插件 lifecycle reports，不另设无生产者的日志 schema。

### Source/built 分类的接纳与撤销

Artifact classifier 也只消费三态正向证据：raw source lowering 对 exact definition 的事实才能产生 `source-module`；active
module closure 中 toolchain setter 的 exact literal definition 事实才能产生 `built-module`。文件扩展名、package 路径、未命中
source transform 或其他 negative match 都不是 built/source 证据；事实缺失或冲突必须是 `unreported`。每次开发更新 把这些
事实放进一个 artifact generation，candidate 接纳后才 commit；evaluate、inject 或 host replacement 失败必须 rollback generation，
不能让失败 candidate 污染下一次 active classification。候选 transform、evaluation 与 classification 必须运行在该
generation 的异步 scope 内；不在该 scope 内的并发 ambient transform 仍是独立 authority。Commit 按 module 校验
generation 开始时的 ambient version，已有更新 ambient 事实的 module 不被旧 candidate 覆盖；rollback 也不撤销这些并发事实。

React transform/refresh 由应用 Vite 配置显式安装一次，Host-dev 开发入口不因是否存在动态来源改变 React 所有权。
Starter 的统一 Vite smoke 验证 browser graph 与 `/@react-refresh`，避免重复或缺失 React plugin。

Portless 只把稳定的外部 `*.localhost` origin 路由到这一个 `ViteDevServer` 注入的物理 listener；它不创建第二个 HMR graph。
业务 SPA、Workbench、Cap'n Web WebSocket、MF assets 与 Vite HMR 保持同源，分别由既有 path/upgrade 仲裁。Workbench 与业务前端
因此可以同时显示两个 URL，但不能据此拆成两个 server port。

## 固定 catalog 与可选动态来源

`host({ entry })` 通过 ModuleRunner 加载 canonical `HostApplicationFactory` entry。开发驱动使用 Vite 的
`hotUpdate` 将 create/update/delete 事件送入同一个更新队列；同一次文件事件只执行一次 runtime 更新，避免 client/SSR
两套环境重复提交或在提交后再次失效已加载的 constructor。普通 Plugin
dependency 变化精确失效 importer graph；application factory identity 变化重建 host。Single-active logging root
在候选工厂成功求值后，要求先停止旧 host；候选服务准备、prepare 或 start 抛出错误时先停止并清理失败的新 host，再从上一次成功工厂及 startup 快照创建一个
fresh host。只有补偿 host 成功启动才记录 `restored-previous / application-reload`。这是 full-host replacement 的 compensation，
不是保留或复活旧 running generation，也不把同一进程内的普通 definition transaction 改成可回滚；补偿本身失败时不得报告
`restored`；Host-dev 在首次启动或补偿失败、没有 active Host 时记录 `failed / application-reload`。Start 正常返回的部分节点 lifecycle issue 保留新 host 并逐节点报告，不触发宿主补偿。

Management status 将当前 committed definition 的执行方式投影为 Host 提供的 `execution` fact，而不是从文件扩展名、
`displayName` 或 package label 猜测。production freezer 产物固定为 `static-bundle / application-bundle / deployment`；
Vite catalog 仅根据上述 source/built 正向 semantic fact 报告 `source-module` 或 `built-module`，无法证明时使用
`unreported`。固定 catalog 的更新方式为 `host-reload`；工厂 identity 变化（包含固定插件 import 失效）会重新求值并重建 Host。
动态来源的更新方式为 `definition-hmr`；来源更新且 factory identity 不变时，复用已解析配置，在当前 Host 内提交 live catalog transaction。
工厂求值失败发生在关闭旧 Host 前，旧 Host 保持运行。不经过 Vite 的通用显式 catalog 使用 `manual`。
Artifact 与更新机制是正交事实：不能用 `source-module` 推断 HMR，也不能因 artifact 未报告而隐藏宿主已知的更新方式。
这些值不提供把 running definition 在线切换到另一种来源或加载机制 的控制 API。

### 来源发现与资源所有权

启动时先完成固定 imports 与所有显式来源的初始发现、求值，再向 Host 提交同一份初始 catalog，避免固定插件
先启动时看不到来源提供的 required dependency。Source 只接受精确文件或不能逃逸 directory 的正向 include glob，
结果最多 10,000 entries。来源更新与源码依赖失效都进入共同候选求值和图提交路径。

每个来源描述负责自己的 watcher 与关闭，不以 Vite 是否忽略 `.pluxel` 决定 watcher 所有权。Vite 主 watcher
继续忽略 persistence、安装目录和 artifact cache；来源 watcher 只接纳声明覆盖的 entry 事件，不扩大 source 集合。
已接纳的来源更新在同一开发序列中结算，关闭先停止接纳，再等待已接纳工作排空，迟到结果不能发布。

固定 imports 和动态 entries 共用候选处理与 Host 提交路径。来源发现负责精确 entry anchors，执行分类只消费
已证明的 source/built semantic facts；包入口变化不意味着工具链可以跟踪该包内部全部源码。

来源扫描与 module resolution 显式锚定 resolved application `root`。启动和 replacement 不得调用
`process.chdir()`；同进程 Vite 持有自己的 config/root 解析上下文，Plugin 中明确声明为“相对当前工作目录”的路径则继续以
launcher cwd 为准。两者不同时，宿主配置应传绝对 Plugin 数据路径。

Source producer 只原子发布普通 ESM entry；package acquisition、lockfile、registry、安装状态、RPC 和 UI 都属于 producer
Plugin。来源层保存发现与待更新事实，commit 后唯一 authority 是 Host 的 immutable catalog snapshot。
不保留第二份 committed registry 或 post-commit 目录副本。

### 关闭与生产边界

Shutdown 顺序是：停止 watcher/batch/direct-call admission → 等待已接纳的 startup → 丢弃未开始 debounce → 排空 active batch、
direct execute/warmup 与 Workbench Content refresh 的共享 execution lane → Core lifecycle/effects cleanup → Vite hooks →
ModuleRunner close。关闭开始后，已接纳的 Content refresh 可以完成原子发布，但不能再发送 browser full reload；跨越关闭边界才取得
execution lane 的 direct call 必须以 `HmrClosedError` 失败，不能触碰 baseline、semantic source 或 executor。

生产 Dynamic 使用原生 ESM，只支持初始加载、新 entry path 与删除。已经求值入口被修改或重新加入时以
`PLUGIN_SOURCE_RESTART_REQUIRED` 明确要求重启；query cache bust 不能保证安装包的传递依赖更新，因此不承诺生产 HMR。

## Workbench producer build

`PluginArtifactCompiler` 位于 `packages/workbench/src/development/`。服务开发附件可以安装 Node source provider，
只在 Workbench enabled 时安装 UI source provider；Workbench-disabled 路径不加载 MF builder。

Semantic lowering 在 TypeScript 擦除前读取 `workbench.define()` 和 literal `workbench.entry()`，一次生成 owning Plugin
definition 的完整 producer plan。Compiler 不重新发现 declarations 或计算第二个 build revision。

Workbench 的模块事实与 publication 按模块一起替换；每次 transform 在异步解析前取得更新身份，迟到结果不能覆盖
较新的 transform、失效或删除。watcher 失效先记录待更新模块，candidate 接管这些失效并在独立快照中重新解析。
成功编译读取的导入事实也属于这一代，提交时与 source/built facts 共用 ambient version 冲突检查；失败 candidate
丢弃后仍使用已提交事实，不从失败源码重建旧定义。解析 Promise 只活在本次编译中，失败不会阻塞下一次有效更新。
删除模块或将它改成普通模块会撤销原 publication。生成 Bridge 和 renderer projection 的目录包含 build revision，
后续 candidate 不覆盖已返回 plan 引用的生成文件。

### 构建并发与发布权限

同一 producer task 去重；同一 definition 的新 plan supersede 旧 in-flight build。`@module-federation/vite` 1.22.1 的
producer build 直接在当前进程运行；真实双 producer 并发回归必须验证 expose、Manifest 和 JavaScript 不串线。统一 artifact
compiler 不再为 Workbench 叠加通用 build queue；MF builder 自己拥有两个 build slot。上游 export detector 仍有
process-global application root：同一 application root 最多并发两个 producer；不同 root 按到达顺序形成 cohort，切换前必须等
当前 cohort 排空，后到的同 root task 不能越过已经等待的其他 root。这个精确约束不能扩大为全局单线程。Node artifact 继续使用
独立的两个 build slot。同一 output 的 transaction ordering 始终保留，保证 immutable candidate 的 validation/publication 不交错。
Workbench artifact 接入先准备并验证候选 topology/Content，准备过程不改变 current tuple，也不取消已接受代的后台构建。
服务开发附件在 Core graph 接受点同步激活候选：正常替换中此时旧代已排空，新代尚未启动；被拒绝候选只丢弃准备结果。
只有激活才推进 publication epoch 并启动缺失 producer 的后台构建；后台验证完成后再次检查 epoch，拒绝迟到的过期结果。
已存在的 producer artifact 可在准备路径快速复用。初启和已接受定义的纯 Content 更新使用相同 prepare/commit 实现。producer 进入构建时记录 name/revision，完成时记录 `built` 或磁盘 `reused` 及端到端耗时；内存 candidate 复用保持
静默，失败日志保留同一归因和原始错误。开发 producer 使用持久 Vite cache，默认不生成 dynamic types；production 或显式
required type policy 仍严格生成和校验类型资产。

Candidate 的 Manifest/Snapshot、exposes、assets、shared 与 Bridge 验证统一遵守 [Workbench](WORKBENCH.md#mf2-与-react-bridge)。开发失败保留 placement 并显示 failed；生产另外要求 dynamic types。验证成功才进入 immutable artifact inventory，runtime 不从源码重新编译。

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

Node module declaration 保持独立 artifact lifecycle。`ctx.require(NodeModules).use()` 对每个 consumer 串行 staged setup：新 setup
成功后才 cleanup previous；失败保留 last-known-good。Owner stop 使 pending generation 失效，迟到 setup cleanup 立即执行。
Worker task 的新 dispatch 读取 content-addressed 新 module URL，已运行 task 继续使用原 module；取消/stop 仍等待真实 worker
退出。

## 验证

围绕更新边界验证：structural reject 保留旧 catalog；PONR 后仅报告新 lifecycle facts；definition-wide replacement 与 required/optional closure 一致；显式 Stop 不被源码恢复覆盖；失败候选不污染 semantic/artifact authority；迟到 producer 不提交；full-host compensation 只在 fresh host 启动成功后报告 restored。

使用真实 Vite 验证单一 Host namespace、来源恢复、execution provenance、watcher 关闭与队列排空。Management DTO 不泄漏绝对路径/Vite ID，批次错误不伪装成所有节点失败。Workbench/browser 与 Node staged setup 分别在各自真实资源边界验证。

## Development console execution

显式启用的 dev console 使用同一个 `pluxel` environment runner，执行根不是 Plugin catalog entry。脚本等待真实 watcher 接纳已知依赖修改，再等待开发驱动已接纳的有限更新序列；执行期间不锁住整个 HMR coordinator。full-host replacement 撤回旧 run scope，后续提交获取新 epoch。源码观察、finite barrier 与资源边界见 [`DEV_CONSOLE.md`](DEV_CONSOLE.md)。

## 来源观察失败

Host-dev 将来源 watcher、恢复 watcher 和进入更新前的 `watchChange` 失败提交到同一个开发执行队列，
再发布应用级 recent update；不能在正在执行的 candidate 中途覆写其 sequence 或 settlement。
这些错误不归因到任意 Plugin definition，也不修改它们的 lifecycle 历史。
已接纳的 watcher 错误随队列排空；关闭后的通知不再接纳。候选执行自身已经发布的失败只记录日志，不额外创建重复 attempt。
最近一次更新成功会替换这一记录；它不是持续 watcher 健康状态，也不承诺重建已经失效的 watcher。

动态 entry 的求值根必须在 import 前加入候选恢复集合，即使它不出现在应用入口的 import graph 中。
失败候选关闭临时来源 watcher 后，修改该 entry 或补齐它的缺失依赖仍能触发下一次候选。
恢复接纳集合与缺失解析输入集合不同：语法修复只失效受影响模块，不能因为它属于恢复集合就重载全部服务。
Host-dev 在候选语义作用域中计算 execution provenance，Host 只在 catalog snapshot 中发布事实。
内部 provenance binding 仅保存下一次 catalog 的输入；拒绝时 committed snapshot 不变，整应用补偿使用上次成功的事实。

物理 `node_modules` 中的模块只采集正向已编译 ABI definition facts，不将普通第三方代码作为 Plugin 源码 lowering。
整应用失败补偿在候选语义作用域之外、rollback 后进行；已结束 generation 的异步 continuation 也只能读取 committed Workbench facts。
补偿沿用已接受 catalog 对应的制品输入；同路径新 inventory 不得替换旧 plan。旧制品字节已删除时仍须诚实报告补偿失败。

Shell 源码开发通过 `@pluxel/workbench/dev` 的 `workbenchSourceShell({ entry })` 显式附加到当前 Vite 图；入口与 React/CSS 配置由应用提供，不自动探测 workspace 或创建新 watcher/server。与 renderer 制品附件相互独立，见 [Workbench Host HTTP](WORKBENCH.md#host-http-与-shell-开发)。

## 实现边界

每个 `dynamicSource()` 只观察自己的一项声明。Host 的 `openPluginSources()` 统一合并多个来源和重复 entry；
动态 watcher 不再维护第二个来源集合或聚合协议。声明在创建时校验并冻结，打开观察会话只负责 IO 和资源生命周期。

候选生成、失效策略、来源求值和失败恢复属于 `host()` 内部编排，不是 Vite 包入口的独立扩展点。
服务附件通过 `HostDevelopmentPluginApi` 参与现有生命周期，不绕过 Host 自行推动候选提交。

Workbench renderer 的 semantic candidate 被拒绝时，应用更新报告 `retained-previous` / `artifacts`，保留已接受的 renderer；已接受计划的后台构建失败才投影 producer `failed`。两条失败路径都记录原始错误，Host hot-update 诊断经当前 Host logger 后继续交给 Vite。

动态入口的集中集成覆盖见 `packages/services/tests/installed-plugin.smoke.mjs`：真实 Vite 启动后新增 `.ts` wrapper，按 `@pluxel/hmr` 选择 TypeScript 源码，修改其传递依赖完成 replacement，删除 wrapper 撤回能力；同一进程还验证已编译 `.mjs` 包安装、升级、失败保留与卸载。入口被发现不等于自动启动：仍服从 Host 的 auto-start/session intent，撤回后保留配置意图而非伪装成正在运行。
