# Plugin System Architecture

本文定义当前插件系统边界。作者用法以 [`docs/getting-started/index.md`](../docs/getting-started/index.md)
为准。

```text
plugin source
	├─ Plugin / PluginPart constructor dependencies
	├─ optional Plugin refs and one object config declaration
	├─ statically owned PluginPart containment tree
	├─ separately-built Node module / worker task declarations
	└─ Workbench Contract / Extension declarations
          ↓
@pluxel/core: committed graph / DI / lifecycle / effects
          ↓
@pluxel/runtime: HTTP / persistence / config / commands / optional capabilities
          ↓
static or dynamic route: catalog / Vite / HMR / host policy
          ↓
optional Workbench Plane: target layout / artifacts / bound resources
```

## Context 与宿主能力

`@pluxel/context` 提供公开、host-neutral 的 immutable Context host kernel。standalone host 可以在创建 root 前用 opaque
descriptor 和 root/scope/owner-view installation 组合固定 shape；`overrides` 只允许替换基础集合中相同 descriptor，并保持
scope/property。host 编译完成后没有 install/mutate API，kernel 也不拥有 `prepare()`、`dispose()` 或资源生命周期。

Pluxel Runtime 使用同一 kernel 组合官方能力和当前 owner identity，但它的能力集合属于 launcher 与受信任 framework route，
而不是 Plugin extension point。route package 只能在 root 创建前通过 package-private authority 安装自身 descriptor；当前 dynamic
route 用它组合 Loader/Scan。业务 Plugin 不能在 module evaluation 或 `init()` 中追加、替换 Runtime capability；业务依赖始终
进入 Plugin graph。Context 也不暴露 host configuration。

Runtime 内建能力明确选择 root、scope 或 owner-view。Core 把 scope 映射为 Plugin generation：PluginPart 与 dependency caller
view 共享 generation backing；owner-view 共享 root backend，但 Plugin、Part 与每条 caller edge 各有严格惰性的 view/cache。
view 是带 immutable owner Context 的普通 class/object，不通过 `Proxy` 改写共享 service 的 `this.ctx`。这样
`ctx.commands`、`ctx.workers` 等保留调用者注册和 cleanup ownership，同时 registry/pool 等 backend 仍按 root 共享。
`ctx.elysia` 是 generation scope capability：root Plugin 与全部 Part 共享一个严格惰性的原生 Elysia application，Runtime 的
HTTP carrier 与 immutable directory 只存在于 root host authority。可选能力 disabled 时不进入 host shape，不能通过 null stateful
service 模拟启用。

### Generation-scoped Elysia application

`ctx.elysia` 是真实的 host-owned Elysia `2.0.0-beta.7` instance，不是 Plugin service view、Proxy 或 Pluxel HTTP facade。
Plugin/Part 在 construction 与 `init()` 中直接使用上游 API；route path 就是最终 product path，没有 Plugin
namespace、`publicPath`、mount id 或 route handle。可复用组合应写成普通 Elysia function plugin，而不是新的 Pluxel
HTTP extension point。

generation 是最小可撤回 application owner。Plugin 与其 Part 共享 app identity，但 Part 不获得独立 route owner、
publication 或 WebSocket lifecycle。Plugin/Part init 全部成功后，Runtime finalizer 等待 lazy modules、读 public route
inventory、attach owner Server view 并调用 Elysia native `compile()`/seal。Core 随后在同一 operation 中 settlement，构建完整
immutable directory，再与 running projection 同步交换 ready pointer。start failure 和 rollback 不发布部分 route/socket。

跨 owner route 冲突当前只拒绝 `kind + method + declared path` 完全相同的 inventory fact。canonical-equivalent
pattern 不在已证明 contract 中，因为 Runtime 不复制 Elysia matcher grammar。HTTP/stream/WS 请求取得 owner generation
lease；Node production 与 Node-backed Vite 已通过 srvx/crossws carrier 运行真实 WS，但 Bun/Deno 第二 carrier 与 portable
WS conformance 尚未完成。

Plugin 不拥有物理 listener：`listen()` / `stop()` 与 Server view 的 physical controls 明确 fail-fast。beta.7 也没有
external application attach/detach public epoch，因此 `setup()` / `cleanup()` 当前在调用点 fail-fast；不读 `~ext` 私有
callback 来伪装支持。dynamic loader 已统一 Elysia runtime identity，但 published Plugin 的 Elysia peer-range admission 尚未
进入 static/dynamic 共享 catalog contract。

Core events 同样使用 owner-view：每个 root 只有一个 emitter backend，每个 Context owner 得到带固定 `ctx` 的普通
`EventsService` view，订阅进入该 owner effects。`ctx.events` 的 module augmentation 只是共享 ambient event vocabulary，适合
不需要 Plugin graph ordering 或 availability 保证的广播；具名 `EvtChannel` 才是依赖 provider 对 consumer 暴露的协议。

## 依赖与组成

| 意图              | API                                      | 生命周期含义                                    |
| ----------------- | ---------------------------------------- | ----------------------------------------------- |
| required plugin   | Plugin 或 reachable Part constructor     | 聚合为 owner edge；provider 失败阻塞整个 owner  |
| optional plugin   | `definePluginRef<T>()` + `plugins.use()` | provider 变化时重启 consumer                    |
| owned composition | `this.parts.use(PluginPartClass)`        | child Context/effects scope，随 generation 回收 |
| trivial helper    | 普通 class/function + owner effects      | 作者显式管理                                    |

constructor 是 required dependency 的唯一作者声明。required 使用目标 package 根入口的 value import；optional 使用
目标 Plugin 的 type-only root import 和 non-exported module-level ref。semantic pass 保留 root Plugin 与每个 Part constructor
各自有序的 direct requirements，再把完整 reachable Part tree 的 required/optional facts 提升、按 definition identity 去重到
owning Plugin node。static/dynamic route 必须读取同一 committed core graph；Workbench resolver 不依赖 loader 私有图。

owner graph requirements 的稳定顺序是 root direct requirements 在前，再按 Part containment tree 深度优先的 first-seen 顺序追加。
同一 provider 被 root、不同 Part、nested Part 或同一 Part class 的多个 field occurrence 请求时只形成一条 owner edge；任一来源为
required 时 graph 与 package metadata 的 effective mode 都是 required，但各 optional callback 与 cleanup facts 仍保留。

同一 constructor 中每个 required definition 最多出现一次。RuntimeState override 使用 stable requirement address，而不是把 parameter
index 持久化为 edge identity；因此同一个 Plugin 或 Part constructor 的两个参数若解析到同一 definition，会由 semantic pass 以
`plugin_dependency_requirement_duplicate` 拒绝。跨 root/Part constructor 的重复是合法共享，不表示同 token 多角色；参数名、位置和
`partPath` 都不是持久 identity。

宿主修改 runtime dependency override 时，只修改 owning Plugin node 上的 requirement，并同时作用于它的 root 与全部 Part
occurrence；没有 per-Part override。commit 必须重启被修改 Plugin 与其 dependent closure。只重建 provider 而保留 dependent 的旧
caller-bound view 会破坏 Context isolation，并让 Workbench 中的实现选择表面成功、实际继续调用旧 provider。

`PluginRef<T>` 是 opaque author declaration，只能由工具链从目标 root named export 的 type provenance lower。ref 不
import、安装、注册或默认启用 package。`plugins.use(Ref, callback)` 只允许作为 `init()` 中的直接语句，callback 必须
同步且返回的 cleanup/disposable 自动进入 consumer effects。provider absent、disabled 或 start-failed 时 callback 不执行，
但不阻塞 consumer；running generation 出现、消失或 replacement 时，core 把 consumer 及其 required dependent closure
合并进一次 restart plan。required/optional ordering edge 的合并图必须无环。

### Owner-bound PluginPart

`PluginPart` 用于有独立配置、资源 scope 或 capability registration、但不需要独立治理身份的内部组成：

```ts
class CachePart extends PluginPart<SearchPlugin> {
	constructor(private readonly redis: RedisPlugin) {
		super()
	}

	private readonly config = this.configs.use(CacheConfig)

	protected override async init() {
		await this.redis.warm()
		this.ctx.commands.register(createCacheCommand(this.config))
	}
}

@Plugin()
class SearchPlugin extends BasePlugin {
	private readonly cache = this.parts.use(CachePart)
}
```

`parts.use()` 只能是 concrete `@Plugin` 或 direct `PluginPart` subclass 的普通 class field initializer。concrete direct Part
可以用 constructor 参数声明 required Plugin；参数采用与 Plugin 相同的 package-root value-import provenance 和重复检查。Part 不使用
`@Plugin`，也没有 node address、catalog、fork、独立 enable/restart、RuntimeState 或 Workbench owner。同一 Part class 的每个 field
occurrence 都产生独立实例；Part 可以递归拥有 Part，local containment cycle 在 build 时拒绝，跨模块防线由 runtime 在 generation
构造阶段 fail-fast。

`PluginPart.ctx/host/parts/plugins/configs` 与 `BasePlugin.parts/plugins/configs` 是 protected author DSL；只有 `BasePlugin.ctx` 保持 public。
Part 没有 root Plugin getter，外部取得 Part instance 时只能看到 subclass 有意声明的 public 业务 surface。Part occurrence Context 不 pin
attribution path/identity，Core/Runtime root 也不导出 Part Context/info/owner/parts helper types。nested Part 的 `host` 泛型始终表示 immediate parent；
framework 内部以 occurrence state 保存 Context 与 `partPath`，不得用新的 public path/id/locator 代替。

全部 aggregated required provider running 后，Core 才构造 owner generation。root Plugin 按自己的 direct requirements 注入 root-scoped
facade；每个 Part occurrence 创建 child Context 后，按该 Part definition 的 direct requirements 注入 occurrence-scoped facade。随后 Core
注入 Plugin/Part composite config，再按 children-before-owner 深度优先启动 Part，最后调用 Plugin `init()`。constructor dependency
不保证能被其他 field initializer 提前读取；资源访问继续留在 `init()` 或普通 method。

每个 Part 得到结构化 child Context、由父 effects 持有的 child scope、`partPath` logger 和惰性 owner-bound capability view；Elysia
application 共享 owning generation，commands、worker、Node module 等共享 root/backend 状态，但 registration 与 cleanup 绑定
Part scope。Part constructor 或 `init()`
失败都会让 owning Plugin start 失败，lifecycle error 携带 `partPath`，rollback 仍只 drain Plugin generation effects。child Context
不是新的 root；未声明 owner binding 的 capability 继续使用 owning Plugin view，database definition、migration 与 handle ownership
也保持 Plugin 级。Part 只隔离资源所有权，不作为 trust boundary 或 service-instance sandbox。

Part 可以在自己的 `init()` 中使用 `plugins.use()`；semantic pass 把 reachable Part optional refs 合并到 owning Plugin node，
provider availability 变化重启整个 owner。同一 Part occurrence 对同一 provider 同时 required 与 optional 时复用同一 caller facade，
optional setup 仍保留自己的 callback 与 cleanup。Part 不直接 mount Workbench Extension；唯一 owning Plugin 负责聚合贡献。
需要独立启停、失败状态、provider selection、配置 revision、HMR identity 或跨 owner 共享状态时，应升级为真正 Plugin。

## Identity 与入口

Plugin 只有 definition 与 node 两个身份作用域。definition 由 canonical entry + root named export 构成；node 在 definition
下区分 `variant: 'default'` 或 `{ variant: 'fork', forkId }`。跨界使用 `PluginDefinitionAddress` / `PluginNodeAddress`，Core
intern 后使用对应 `PluginDefinitionSlot` / `PluginNodeSlot`；Address 与 Slot 是同一身份的值表示和进程内引用，不是四层协议。

fork 是同一 definition 的运行时多态：共享源码、schema、metadata、artifact input 和 HMR，隔离 lifecycle、config、dependency
override、Context/effects 和资源。class name、constructor object、package display name 和 `@Plugin({ displayName })` 不参与
graph、state、config、logging、Workbench 或 HMR identity。Workbench/日志使用 node label 展示，URL 使用可逆 node route，
CLI/诊断使用 node reference，不暴露 digest ID。完整 schema、source `realpath`、codec、作用域和持久化边界见
[`PLUGIN_IDENTITY.md`](PLUGIN_IDENTITY.md)。

route catalog availability、RuntimeState desired policy、Core committed graph 与 running generation projection 是四个独立平面。
static/dynamic route 只生产 immutable catalog candidate snapshot；runtime-common coordinator 统一展开 durable forks、校验 provider/default/
override、计算 blocked closure 并提交一个 prepared Core update。disabled durable node 不进入 Core，route 不复制 reconciliation，Core
也不吸收 module/source/artifact provenance。

一个具体插件包只有一个 plugin-bearing entry：package root `"."`。根入口可以唯一 named-export 多个 Plugin；同一
constructor 的多个根名称、plugin-bearing subpath 与跨包 Plugin re-export 都由 build 拒绝。Workbench、worker、contract
等 plugin-free subpath 只在确有独立消费边界时保留。

## 生命周期与资源

core commit 顺序为 `draft graph -> verify -> stop plan -> start plan -> CommitSummary`。provider 先启动、
consumer 先停止；失败插件不进入 running，required dependents 被阻塞。generation 停止时先关闭 owner invocation
gate、abort generation，再 drain effects。正常停止、init rollback、replacement、optional restart 与 root shutdown
没有第二条 Plugin teardown hook。

Workbench mount 从 Context 推导 owner 并绑定 owner effects。contribution 只有在 owner 真正 running 后才进入
layout；init 失败不会留下可见 View 或 resource。HMR replacement 会撤销旧 layout binding、factory、stream、
live query 和 grant；rollback 通过重新 mount 获得新 lease。

constructor 注入的 dependency 是覆盖 `ctx.caller` 的 generation-bound facade。同一 scoped consumer Context/provider generation pair
复用一个 facade；root Plugin 与每个 Part occurrence 是不同 scoped consumer，同一 Part class 的多个 occurrence 也不共享 facade，
但都委托同一个 provider generation。不同 consumer 或 replacement 后的新 generation 不共享。Core 在 provider construction 完成后把普通 field 和
prototype surface 一次编译成 non-extensible property-descriptor facade；每个 accepted method/getter invocation 使用一个独立普通
receiver，因此并发异步调用保持各自 `ctx.caller`，不依赖 `Proxy` 或 mutable current caller。普通作者字段读写委托被 pin 的 raw
provider instance，不在 facade 上形成 shadow state。stale method invocation 与字段写入都受 provider generation admission gate
拒绝；未在 construction-time shape 中出现的动态字段不能通过 dependency surface 新增，reflection mutation 由 non-extensible、
non-configurable descriptor 拒绝。
caller-owned state 继续以 `Context` 为 key，不依赖可变全局 current caller。Part facade 调用时 provider 观察到的
`ctx.caller` 是该 Part child Context；owner generation 停止会统一关闭 root 与所有已构造 Part 的 admission，再 drain 一棵 effects tree，
不产生可单独治理的 Part lifecycle。

Plugin inheritance chain 不允许 ECMAScript instance `#private` field/method/accessor，因为 caller facade 无法通过 private brand check；
semantic pass 对此发出 `plugin_caller_view_private_brand_unsupported`。需要强封装时使用 closure 或由 capability 返回具有自身 withdrawal
语义的 handle。TypeScript `private` 普通 property 不受该限制，`PluginPart` 也不会成为 dependency facade。

跨节点可调用的 Plugin surface 只使用 prototype method；accessor只返回普通数据或具有独立receiver/withdrawal契约的对象handle。
arrow、function expression 或 `.bind()` 产生的 function-valued instance field 会捕获 raw provider receiver，无法诚实投影 consumer caller；semantic pass 以
`plugin_caller_view_callable_field_unsupported` 拒绝，Core caller facade 对动态产生的 callable field/accessor result 同样 fail-fast。
type-only `declare` instance field 不产生 construction-time shape，以 `plugin_caller_view_declared_field_unsupported` 拒绝；需要跨节点
暴露的 data field 必须是实际 class field，行为继续使用 prototype method。
需要返回 callable handle 时，返回具有独立 receiver 与 withdrawal 契约的 capability object，不把裸 function 暴露为 Plugin field。

第三方库只有不可撤销的进程级 registration/platform callback 时，全局部分只保存稳定且在无 active scope 时 inert 的
路由实现；caller registration、mutable resource 与 cleanup 继续保存在以 `Context` 为 key 的 registry。并发异步调用
使用平台原生 async context 传递 invocation scope，不使用可变 module-level current owner。若第三方 API 接受对象而非
全局名称，优先直接传 caller-owned snapshot，避免把无法 unregister 的外部表伪装成可回收 Pluxel resource。

`ctx.database.use()` 保留 immutable plugin owner，并在返回 handle 前解析 active database instance、完成 migration prepare。
handle 只允许短生命周期 `read()` 与完整 `transaction()` callback；stop/replacement 撤销旧 generation handle。默认
`migrations` evolution 用 checked immutable history；显式 `reset-on-schema-change` 由 compiler 从 schema snapshot 派生 lineage，
不要求作者维护 history。同 lineage 复用 active instance，新 lineage 原子激活 candidate 并归档旧 instance，不删除旧数据。

`ctx.commands.register()` 共享一个 root command catalog，但注册所有权属于调用插件的 Context。registration 会进入
owner effects，因此 generation stop、replacement、start rollback 和 shutdown 都会撤销对应命令。runtime registration
同时保留 owner invocation lease；generation 停止时先拒绝新调用、abort call/owner 合成 signal，并等待已接纳调用退出，
再 drain generation effects。此前取得的 command wrapper 也不能越过已关闭的 owner gate。手动 dispose 单个 registration 只撤销
publication，不取消已经开始的调用。runtime 自身固定注册基础插件查询与生命周期命令，这些 handler 只调用既有
runtime use case，不复制 graph 或 commit 逻辑。

## Optional Workbench Plane

插件只通过 `ctx.workbench?.mount()` 发布可选 Extension。宿主通过顶层 `workbench` 配置安装
capability 与 backend；disabled 时 Context 没有 `workbench` property，也不创建 registry、compiler、watcher、route 或
transport。optional chaining 同时避免构造 bindings，不需要 null facade 或 `enabled` 分支。

browser-safe `WorkbenchContract` 声明 resource、View、placement 和 Port；server-only `WorkbenchExtension`
只绑定 Contract 与 UI entry。`workbench?.mount(extension, bindings)` 是唯一发布动作，owner 不在 Extension 重复
声明。registry
生成 target-specific layout，并把每个 resource 转成 resource-graph-revision-scoped opaque grant。
artifact 状态更新可以复用相同 grant；module、实例或依赖图变化会立即撤销旧 grant。浏览器不能按插件
namespace 任意访问未授予资源。

跨插件 UI 只使用 typed Port：consumer 选择 placement 并绑定自己的 resource，provider 提供 renderer。
Workbench 不根据 dependency graph 隐式投影 provider View。

不维护服务端 UI session/draft。交互状态属于 consumer resource、浏览器局部状态或明确的业务 API。

## Node module capability

插件用 module-level `defineNodeModule(import.meta.url, literal)` 声明单独构建的 Node ESM entry，并在
`init()` 中通过 `ctx.nodeModules.use(declaration, setup)` 消费。`NodeModuleService` 是常驻 runtime 能力；
首次 artifact build/load 或 setup 失败会让插件启动失败。开发期更新先完成新 setup，再清理上一成功消费者；
更新失败保留 last-known-good。owner stop/replacement 通过 effects 自动释放 source lease 和 active cleanup。

declaration key、build revision 和 owner node address 是三个独立身份。相同 declaration 的多个 owner/consumer 共用
build 与 watcher，但各自拥有 setup/cleanup。Node module 只输出自包含单文件 ESM，不定义 worker、线程或任务协议。

`defineWorkerTask()` 是同一 artifact primitive 上的 typed specialization。`ctx.workers` 把不同插件的 cloneable CPU/native
任务提交到 root 共享线程预算，执行 owner-aware bounded admission、round-robin、公用 cancellation 和 shutdown drain。
插件不依赖具体 pool implementation，也不各自按 CPU 数创建 pool。该能力不替代异步 I/O：网络、数据库和已经真正异步的
native API 继续使用原 capability；只有会长时间占用 JS event loop 且能用纯数据描述的工作才进入 worker task。取消 running
task 会终止对应 worker，runtime 只在 worker 真正退出后归还线程 slot，避免 replacement work 与尚未释放的 native work 重叠。

`workers.run()` 默认在返回前同步取得输入 snapshot，因此 caller 随后的 mutation 不会影响排队任务。调用方已有明确
borrow-until-settle contract 时可选择 `inputOwnership: 'borrowed'`，省略 admission clone，只保留 transport clone；它不能
与 transfer 组合。大二进制可以通过
`{ transfer: [arrayBuffer] }` 显式转移 ownership；成功接纳后原 buffer 立即 detach，后续 artifact/execution 失败也不回滚
ownership。artifact 首次解析中的任务与 ready queue 使用同一 global/per-owner admission 上界，不能绕过队列预算。
需要在 dispatch 前做 cooperative domain preparation 时使用 `workers.runPrepared()`；callback 只有在 fair admission 取得
execution slot 后才执行，因此 queue rejection 不会先消耗 walk/copy CPU。它不是 inline renderer：prepare 返回的仍必须是
cloneable worker input，真正 handler 继续只在 worker artifact 中运行。

## 包边界

- `@pluxel/context`：公开、同步、严格惰性的 standalone Context host kernel；
- `@pluxel/core`：Plugin Context 投影、graph、DI、lifecycle、effects；源码复用并在发布产物中内联 Context kernel；
- `@pluxel/runtime`：原样转发 core 作者面，并增加常驻 runtime 能力；
- `@pluxel/runtime/product`：browser-safe host product descriptor 与无副作用 `defineProduct()`；
- `@pluxel/commands`：独立的 command 定义、validation、registry 与 carrier projection 内核；
- `@pluxel/runtime/database`：server-only database definition 与 owner-bound handle；
- `@pluxel/runtime` 的 `NodeModuleService`：Node module owner lease、staged consumer 与 packaged resolver；
- `@pluxel/runtime` 的 `WorkerTaskService`：root shared pool、fair bounded admission 与 owner cancellation；
- `@pluxel/runtime/workbench/contract`：browser-safe Workbench Contract；
- `@pluxel/runtime/workbench`：服务端 Extension、entry 和 Binding；
- `@pluxel/runtime/workbench/ui`：浏览器 resource client；
- `@pluxel/core/federation`：Workbench bundle build contract；
- `@pluxel/runtime-static` / `runtime-dynamic`：route policy；
- `valibot-form`：Config schema 的 portable presentation 与 raw-input transport projector；
- `@pluxel/runtime-dev`：共享 UI/Node source graph、watch、cache 与 publication lifecycle 的 artifact compiler；
- `@pluxel/rolldown/vite/workbench-ui`：remote build primitive。
- `@pluxel/package-manager`：官方可选 source producer，拥有 pnpm、安装命令、owner-bound RPC 和 Workbench 页面。

dynamic route 与 package manager 之间只有文件协议：producer 在宿主声明的 `sources` 目录原子发布/删除 ESM entry，
route 观察文件并执行正常 graph transaction。runtime 不提供 package-manager capability、RPC DTO、内置页面或 market
抽象；其他 registry、离线 bundle 或本地开发工具也可以实现同一文件协议，不需要进入核心。

两条 route 的 catalog 语义是 `static = fixed plugins`、`dynamic = fixed plugins + mutable file sources`。Dynamic fixed catalog
使用普通 `plugins`，不拥有单独的 enablement、fork 或持久状态；fixed 与 mutable constructor 在同一个 Vite evaluated namespace
中求值。Package Manager 是宿主显式 import、RuntimeState 显式启用的 dynamic-only fixed plugin。

## 不变量

- 业务 capability 不依赖 Workbench Plane；
- disabled 表示零 backend 初始化；
- host 拥有 placement，provider 不能任意占据 consumer UI；
- static/dynamic 的作者 API 和 graph 语义一致；
- static/dynamic canonical module 共用可选 `product` named export，不把 host metadata 塞入 route config；
- active docs 只描述当前 API，历史由 Git 保存。
