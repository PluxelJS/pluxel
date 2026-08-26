# Runtime Architecture

`@pluxel/runtime` 在 core 之上提供 HTTP、config、persistence、runtime state 和可选 Workbench/Vault 能力。
launcher 与受信任的 framework route 使用 `@pluxel/context` kernel 为每个 root 编译一份封闭 Context host；不存在
import-side-effect service registration、public capability append 或 post-root installation。standalone host 可以独立使用 Context
kernel，但 Plugin 不能修改 Runtime 拥有的 Context shape。

## Runtime Context host

Runtime 在一个集中 contract 中声明 Context 的 public property type，并由 `RuntimeHostConfig extends CoreHostConfig` 集中声明
host 创建输入；service constructor 参数不是 public config schema，也不用于反推配置类型。`resolveRuntimeRootInputs()` 在 root
创建前归一化并冻结输入，再由 capability factory closure 分发。host composition 安装固定能力：root scope
承载 persistence、runtime state、admin/agent control backing，kernel scope 承载 database，owner-view scope 承载 commands、
HTTP、Workbench gate、Node module、worker 与 internal validation。Core 为每次 Plugin generation 创建一个 scope；Part child 与
dependency caller view 共享 scope backing，owner-view 则为每个 Plugin/Part/caller edge 保留 owner identity，同时共享 root
backend。热 getter 只读取预编译 numeric slot，owner view 使用普通对象，不用 `Proxy` 动态替换共享 service receiver。

`RuntimeRootContextOptions.routeContextCapabilities` 是 package-private 的 pre-root host-authority seam，只允许受信任 route 安装自身
descriptor；当前 dynamic route 用它组合 Loader/Scan。它不是 Runtime public config、第三方 host SPI 或 Plugin capability
registration。route 必须在 root 创建前提供完整集合，不能在 Plugin 求值、启动或 HMR 后修改 shape。

Context 不暴露完整 host config。launcher 先解析配置，capability factory closure 再捕获各自的冻结输入，因此延迟创建
不会观察调用方之后的 mutation。Workbench disabled 时不创建 backend、registry、route 或 transport。Vault 只有在
`vault` 为配置对象时才进入 host shape；omitted/`false` 时 `ctx.vault` 与 `ctx.root.vaultAdmin` 均 absent，且不创建 mount/runtime。

`@pluxel/context` 保持 strict lazy：编译 host 和创建 Context 都不运行 factory，也没有通用 `prepare()`/`dispose()` hook。
Runtime 在 Plugin lifecycle 前显式调用 `prepareRuntimeRootContext(root)`，主动读取需要预热的 Runtime-owned lazy capability，并调用
Vault 等 leaf service 的领域 `prepare()`。同一成功 attempt 共享 task；失败会清除 task，下一次 host startup attempt 可重试。
资源关闭仍通过 root/generation effects 或 launcher `stop()`，不回流到 Context kernel。

HTTP 使用每个 root 一个 backend、每个 owner 一个普通 `HttpService` view。view 只保存 owner Context 与 backend reference；
route table、Elysia root、renderer 和 reload state 不复制。Plugin route registration 把 disposer 直接登记到 owner effects，
generation stop 会撤销后续 route lookup，已经进入的 fetch 按 HTTP capability 自己的 in-flight 语义完成。
所有 Runtime owner-view service 的 `ctx` 都是 non-writable、non-configurable 普通属性；view 自身需要维护的 cache/lease 可以继续
变化，但不能在取得后被重新绑定到另一个 cleanup owner。

## Commands capability

runtime 提供 owner-bound `ctx.commands` 和每个 root 唯一的 command registry。插件注册直接进入该 registry，
同时把 disposer 登记到插件自己的 effects；stop、replacement、启动回滚与 shutdown 因此使用同一套资源回收语义。
`register()` 返回同时保留精确 input/output 类型的 installed command 与幂等 disposer；调用方可直接执行该 handle，不需要再按
name 查回 command。`list()`、`snapshot()`、`subscribe()` 与 throwing `execute()` 都直接委托 `@pluxel/commands` registry，
runtime 不维护第二份索引、revision、snapshot cache 或 listener set。

`CommandsService` 只在 registration 的执行入口增加不可变 owner Context 与 owner invocation lease。插件 generation 离开
running 时，Core 统一关闭 generation gate、拒绝新调用、abort 已接纳调用的 call/owner 合成 signal，并等待 lease 释放，
之后才 drain generation effects；CommandsService 不注册第二条 shutdown effect，也不单独 close/drain gate。此前缓存的
registration handle 同样不能越过已关闭 gate。单独调用 registration disposer 只撤销 catalog publication，不会取消已经
开始的调用或关闭同 owner 的其他 command admission。

基础 `plugin.list`、`plugin.status.get`、`plugin.enable`、`plugin.disable`、`plugin.restart` 由 root Commands
服务固定提供。查询委托 `pluginsList` / `pluginStatus`，mutation 委托 `applyStatusActions`，生命周期与一次 commit
规则仍只有 runtime use case 一个事实源。CLI、Agent、HTTP 和 Workbench 是宿主 carrier；它们负责授权、确认、过滤与
principal 映射，不拥有 command 定义或插件生命周期。

`ctx.root.agentTools` 在唯一 command registry 之上维护持久化 Toolset 与 Agent assignment。Toolset 只保存稳定
command name，不复制 descriptor 或 handler；插件停止时命令从投影消失，同名命令恢复时自动重新进入。Agent carrier
必须用 `await ctx.root.agentTools.catalog(agentId)` 得到的 bound catalog 同时完成工具发布与执行，因为该 catalog 会在
调用时再次检查 assignment。bound catalog 只提供过滤后的 `list()`/`snapshot()`/`subscribe()` 与单一 throwing
`execute()`；它不暴露 command lookup，也不缓存可执行 handle，避免 policy 撤销后通过旧引用继续调用。Workbench 的
`/agent-tools` 只是该宿主策略的管理面，Workbench disabled 不影响已经保存的 Agent catalog。

argv/message carrier 用 `createArgvRouter()` 显式绑定自己允许暴露的 command 与 route grammar。router 的 `resolve()` 只返回
command、route 和未信任 candidate；carrier 随后完成授权、构造 invocation Context，并调用返回 command 的 throwing
`execute()`。router 不镜像 runtime catalog，也不拥有 policy、结果呈现或进程退出码。`@pluxel/cli` 本身是工作区构建/开发
工具，不持有运行中的 runtime。

`PersistenceService.preflight()` 先统一校验 backend 声明的 durable/readonly capability，再调用 backend 可选的
preflight hook 做写入探针等实现检查。custom backend 即使省略 hook，也不能让不满足的 durable/writable 要求静默成功。

## Database capability

`DatabaseService` 是每个 plugin Context 隔离的 owner view，底层 coordinator 按 root lazy 创建。它统一管理 PGlite/PG、
fair admission、immutable database instance registry、lineage promotion、physical schema/role、migration、operation timeout 和
transactional outbox；Workbench 只是可选消费者。
完整约束见 [`DATABASE.md`](DATABASE.md)。

## Plugin identity 与 optional integration

runtime capability、HTTP/config/logging/database/Vault owner、commands、Workbench 和 route protocol 全部携带
`PluginNodeAddress`。address 由 route/toolchain 生成并由 Core intern；`displayName` 与 root export name 只用于展示，
class/constructor name 不作为 lookup、storage key 或 fallback。definition/node scope 与 reference/route/label 规则见
[`PLUGIN_IDENTITY.md`](PLUGIN_IDENTITY.md)。

Optional implementation 是否存在只由 host catalog 决定。作者的 lowered `PluginRef` 不触发 runtime loader、安装、注册、
retry 或默认 enable；provider generation 的出现、消失和 replacement 由 Core combined graph 触发 consumer restart。dynamic
source batch 只提交正常 catalog transaction，不维护 optional request 或 synthetic module owner。

Runtime reconciliation 只消费 candidate 上已经聚合的 owning Plugin requirements。root constructor、reachable Part constructor 与
Part optional ref 的来源差异属于 lowering/diagnostic facts，不会创建 Part catalog entry、RuntimeState record 或持久 address。一个
dependency override 继续以 consumer node + requirement definition 为 key，同时作用于 root 和全部 Part occurrence；provider selection、
blocked closure、cycle ordering 与 restart 都只面对 owning Plugin node。Part dependency facade 传播 child Context 的 registration/
cleanup scope，但 owner admission、abort 和 generation replacement 仍由同一个 Plugin lifecycle 统一治理。

Runtime root 只转导 `PluginPart` 与 lowering 所需的 `PluginPartClass`，不恢复 Core 已移除的 Part Context/info/owner/parts helper types。
Workbench 等 owner-only capability 通过 Core internal occurrence membership 判断拒绝 Part 调用；该判定只返回 boolean，不把 `partPath`
重新放入 public Context shape，也不建立 Runtime 自己的 Part identity registry。

## Catalog、RuntimeState 与 reconciliation

runtime 保持四个平面：route catalog 保存 candidate 与 module/source provenance，RuntimeState 保存 durable desired policy，Core
保存已验证的 materialized graph，running projection 保存 generation 与 lifecycle facts。catalog presence 不等于 enabled；disabled
default/fork 只参与 read model，不创建 Core record、Context、effects 或 artifact lease。

static 与 dynamic route 都只向每个 host 唯一的 `RuntimePluginGraphCoordinator` 提交带 monotonic revision 的 immutable catalog
snapshot。coordinator 是 committed catalog 的唯一 authority；snapshot 同时保存 candidate 与 route provenance。static route 不保留平行的
committed catalog，dynamic loader/registry 只在一次 batch 内拥有 unpublished mutable draft，commit 后的 resolve、source、module 与 anchor
查询都从 coordinator snapshot 派生。route 没有 post-commit publication callback，也不能让 reader 看到 draft。

coordinator 串行化 catalog replacement、RuntimeState patch、config notification 与 HMR restart。前两类 policy/catalog mutation 调用同一个 pure
reconciler；不改变 catalog/state 的 addressed restart 走同一队列内的 fast path：

```text
catalog revision + RuntimeState revision
  -> validate roles/collisions/forkability/bindings
  -> expand enabled nodes + infer deterministic provider defaults + blocked closure
  -> Core prepare/verify
  -> persist inferred/explicit RuntimeState patch
  -> recheck both revisions
  -> lifecycle transition + Core confirm
```

catalog ingestion 使用封闭 structural code：`plugin_definition_collision`、`plugin_definition_role_conflict` 与
`plugin_optional_abstract_forbidden`。coordinator 另保留 host-lifetime 的 address-to-role 小型 tombstone：同一 address 一旦作为 concrete
definition 或 abstract token 出现，在该 host 内即使经过 absent revision 也不能切换角色。role history 在 proposed catalog prepare 时复制，只有 catalog
commit 才交换；失败 proposal 不污染 history。它不持久化到 cold boot，也不保存 candidate 或创建 Core slot/record。desired policy 导致的 blocked
facts 使用 `PluginReconciliationIssue`；不安全 live replacement 使用稳定 `graph_rejected`，不能靠 message 或 provenance 分支。

prepare 失败时不写盘、不关闭旧 generation admission；persistence 失败时丢弃 prepared overlay，Core graph 不变。持久化成功后的
revision race 会重新 plan。所有 structural validation、route draft 构建、role-history prepare 与 durable write 都必须发生在 point of no return
之前。Core 第一次关闭旧 generation admission 后不得再执行可能拒绝 transaction 的 route/user callback；graph-confirmation callback 本身只做
runtime-owned、no-fail 的 coordinator catalog/applied/reconciliation field exchange。进入该阶段后的 config/init/drain failure 只进入结构化 apply report，不回退旧
implementation。

显式 provider default/dependency override 永不自动删除、fallback 或 auto-enable；fork 不能成为 global provider default。ConfigService 仍先保存
独立 desired config record，再在同一 coordinator operation 中通知 addressed running generation，不把 config 并入 RuntimeState，也不隐式 restart。

catalog 或 RuntimeState policy mutation 允许 bounded full reconciliation，但必须为 `O(C + F + B + E)`：`C` 是 catalog definitions，`F` 是
durable forks，`B` 是 enabled/default/override records，`E` 是 requirement edges。blocked propagation 使用 reverse-edge queue，不得反复扫描全部
candidate。RuntimeState mutation admission 对 pinned snapshot 一次建 enabled/fork/binding index，再顺序应用 patch，复杂度为
`O(S + P + affected references)`，不能对每个 patch operation clone/scan 全 state；最终 canonical serialization 可以排序。RuntimeStateStore 每个
revision 只构建一个 deep-frozen snapshot/versioned snapshot，read 复用同一 identity。

Runtime reconciliation 与 state-index 趋势探针使用：

```sh
pnpm --filter @pluxel/runtime bench:runtime-state
```

该 probe 同时覆盖 1/10/100/1000 个 disabled durable fork 的 projection，并断言不会产生 Core operation/applied node；延迟结果只用于
观察复杂度趋势，不作为跨机器百分比 SLA。

纯 addressed restart 不运行 reconciler 或扫描 catalog；它以 applied-node key 做 `O(k)` admission，再由 Core 扩展真实 dependent closure。
running config patch 直接查找 addressed generation config binding 并通知变化 declaration，不进入 restart path。definition replacement 通过
`definition -> materialized nodes` index 完成
`O(k + affected edges)`。每次 status overview 对 pinned catalog/RuntimeState revision 只构建一次 enabled/fork/issue shared index，HTTP、RPC 与 Workbench
复用同一投影路径；单 node restart 直接使用 coordinator applied lookup 和 Core running lookup，不构建 overview。

control plane 的 enable/disable、fork、provider selection 与 dependency override 只能提交 coordinator state patch。route 不拥有第二套
fork/provider/binding policy，Core 也不保存 module/source/artifact provenance。

新 enable、fork create、binding 与 provider selection 必须在 coordinator queue 内针对 pinned catalog/state admission；disable、删除或完全相同的
既有 intent 允许清理/保留暂时 absent 的 address。所有 plugin RPC 参数在 transport boundary 先视为 `unknown`，再验证 action、structured
address、object shape、index、field path 与 forkId。malformed input 返回封闭的 `invalid_input`/领域 result 且 `state: 'unchanged'`，query union
必须区分 invalid input、业务 absent 与合法 empty；不得因 TypeScript 声明把旧 action 变成成功 no-op。预期 domain/persistence failure 使用稳定 literal
code 与明确 state，未知编程或 transport exception 继续 reject，不归入 catch-all `internal_error`。status mutation 只接受
`enable | disable | restart`；well-formed 但未 materialize 的 restart 返回 `restart_unavailable` 与 `state: 'unchanged'`。

所有成功的 graph-affecting control mutation（status、config apply、dependency/provider selection、fork ensure/remove）都保留同一个
`PluginApplyReport`。进程内 Core summary 的 slot identity 只在唯一 presenter 中转换成 canonical definition/node address；browser DTO
不包含 slot、graph 或 mutable nested value，并保留 catalog/RuntimeState revision、reconciliation、plugin changes 与全部 lifecycle issue。
`core: unchanged` 只表示没有 materialized graph delta，不能据此推断 durable state 没有保存。

fork removal 是 coordinator `runExclusive` 内不可穿插的多资源序列：先 admission inbound override，durable disable 并停止 node/dependent closure，
再删除该 node 作为 consumer 的 outbound override、Config record 和 logging policy 并各自 flush，最后 durable remove fork family entry。metadata 失败时
fork 保持 addressable 且 disabled；final persistence 结果不确定时返回 `unknown` 并由调用者重读/幂等重试。drain issue 可以得到
`removed-with-lifecycle-issues`，但不会回滚已关闭 generation。generic removal 不删除 database/Vault/object store 等业务 durable data，也不隐式改选
provider。

## Dynamic fixed catalog

Dynamic config 使用 `plugins` 声明宿主显式 import 的固定 catalog，使用 `sources` 声明运行时可增删的文件 catalog。
`plugins` 只提供 availability；启停、fork、dependency override 和 config validation 全部读取统一 RuntimeState。固定 constructor
即使 disabled 也可由 catalog resolve，但不会因首次出现而自动启用。RuntimeState 写盘格式是 version 4，以结构化 node/definition
address 保存 enabled、fork family、provider default 和 stable requirement-address dependency override。reader/writer 只接受 version 4；
其他版本 fail-fast。runtime 不从 Plugin name、constructor 或 display title 猜测 identity。

程序化 dynamic launcher 只接受 config module path，让 config、固定插件和 mutable source 都经由 launcher 所有的 canonical
Vite SSR runner 求值。object config 不跨 module realm 传递 constructor。

## Node module service

`NodeModuleService` 是常驻 root service，`ctx.nodeModules` 是保留 owner Context 的隔离视图。作者只通过
`ctx.nodeModules.use(declaration, setup)` 使用 module；service 不暴露任意路径 compiler、revision、lease handle
或 worker facade。

开发 route 安装一个 lazy source provider；无 declaration 时不创建 compiler、watcher 或 cache。没有 source provider
时，service 只接受 toolchain lowering 后带 stable artifact key 的 declaration，并从 plugin package
`dist/artifacts/node/` 或 deployment `artifacts/node/` 解析。缺失 artifact 会使 `use()` 失败，不回退 inline execution。

每个 consumer 串行 staged setup：新 setup 成功后才清理上一消费者；rebuild/setup 失败保留 last-known-good。
owner stop/replacement 使 pending generation 失效，迟到 setup 返回的 cleanup 会立即执行。

## Shared worker task capability

`ctx.workers` 是 Node module artifact 之上的 root-owned CPU/native task coordinator。作者用 module-level
`defineWorkerTask(import.meta.url, literal)` 声明默认导出 handler，再用 `workers.run(declaration, input, { signal })`
提交 structured-clone-compatible 数据；Tinypool 是 runtime implementation detail，插件不创建自己的线程预算。

`run()` 同步 snapshot 输入，保证任务等待 artifact 或排队期间不读取 caller 的后续 mutation。`transfer` 可列出 input 中
caller 愿意移交的 `ArrayBuffer`：runtime 先把 ownership 转入内部 snapshot，再在 dispatch 时零拷贝移交 worker；接纳后
caller buffer 立即 detach，即使 artifact 或任务稍后失败也不会恢复。未列出的数据继续使用 structured clone copy。

root pool lazy 创建，`minThreads = 0`，默认最多使用 `min(4, available CPUs - 1)` 个 worker thread，空闲 30 秒后回收。
runtime 在 Tinypool 之前维护 bounded global/per-owner queue，并在 ready owner 间 round-robin；每个 worker 同时只执行一个
task。等待首次 artifact route 的 job 也进入同一 admission 上界；ready owner/task 使用 O(1) insertion-ordered queue，取消不扫描或
滞留大队列。插件 Context stop 会拒绝 queued task、abort running task 并等待已接纳 promise，root shutdown 最后销毁 pool。
取消 running task 会终止承载它的 worker，因此该 capability 只适合独立、CPU-bound、可重试的计算或 thread-safe native
调用，不用于普通 HTTP/数据库 I/O，也不是自动包装所有 N-API 调用的透明代理。

Worker task 只接受 structured clone 边界；Canvas、Image、数据库 handle、函数和闭包不能跨线程。worker thread 也不是
security boundary，native crash 仍可能终止进程。开发 HMR 让新任务读取 content-addressed 新 URL，已运行任务继续使用旧
module；idle retirement 有界清除 worker 内的旧 ESM cache。

Node declaration、artifact consumer、worker specialization 与共享 pool 实现共同位于
`packages/runtime/src/node-artifact/`。这是一个 runtime 领域目录，不包含 Vite/Rolldown compiler；build-time lowering 继续属于
`@pluxel/rolldown`，避免 runtime graph 反向依赖工具链。

## Optional management plane

launcher 在 Context plan 编译前一次解析 Management/Workbench plane。顶层 `management` object 的存在显式安装 headless
management；`management.access` 省略时使用 private policy，public exposure 必须同时提供有效 OIDC。`workbench: { enabled: true }`
在 `management` 省略时隐式安装 private management；两者都省略时不安装 access gate、runtime discovery、internal validation、
Plugin catalog layout 或 management HTTP/RPC route。

公开 browser authority 是 `@pluxel/runtime/web`：version 1 discovery、严格验证的 management DTO 和 stateless domain client。
client 不暴露 raw Cap'n Web stub、server class、React/Mantine 或 Workbench session。official View-host 尚未标准化的 layout/catalog/grant/SSE
transport 只位于 `@pluxel/runtime/web/internal`；React Context adapter 位于 `/web/react`。server 上每个 carrier 都委托同一个 runtime use case，
不维护 official-App-only read model。

Management Plane 通过 `PluginCatalogLayoutService` 解析宿主/package 分类并持有用户偏好；该 service 不进入 Workbench backend。

Workbench backend 由以下部分组成：

- `WorkbenchService`：每个 plugin Context 隔离的 optional gate；
- `WorkbenchRegistry`：module、关系、target layout、opaque grant 和统一 revision；
- `WorkbenchArtifactService`：dev/package artifact 与 build state；
- resource services：request-scoped API、live-query snapshot/patch、stream；
- HTTP：catalog、global layout、plugin layout、artifact、resource 和 revision event。

资源 namespace 只存在于服务端。浏览器收到 binding token，服务端在请求时解析 token、校验 kind，并在
revision 变化时撤销 grant。Workbench API 不暴露全局资源字典。

backend factory 由 static、dynamic 和 production static launcher 在 immutable Runtime Context host 构造时提供。插件不得
直接安装或 require backend，也不存在 post-root installer。

## Host application metadata

Static application entry 与 dynamic config module 都可以提供同一个可选 named export `product`。公共作者入口
`@pluxel/runtime/product` 只包含 browser-safe `ProductDescriptor` 与 `defineProduct()`；helper 和 route boundary 复用同一个
结构 validator，复制并深度冻结 snapshot。Named export 缺失得到 `null`，显式但非法的值使 module load 失败。

Product 是 route-neutral host metadata，不进入 static/dynamic config、Context、ConfigService、RuntimeState、Plugin API 或
package metadata。Runtime definition `name` 继续只承担 diagnostics identity。两条 Vite route 已经监听 canonical module
import graph，因此产品变化复用正常 host replacement，并在 Workbench 可见内容变化时触发 browser full reload，不建立独立 watcher
或 HMR protocol。

Workbench backend 安装时接收 nullable snapshot，并通过既有 runtime meta read model 暴露
`application.product`。Workbench disabled/headless 不安装 backend，也不创建 product service、route、registry 或持久状态。

## Static application ownership

`@pluxel/runtime-static` 的公开源码入口是默认导出的 `defineStaticRuntime()` application：

```text
defineStaticRuntime entry
  ├─ name + fixed plugin constructors     build-time catalog
	├─ configEnvironmentBootstrap            typed Plugin config bootstrap bindings
  ├─ configure(startup)                   bundled resolver, startup-time values
  └─ prepare({ host, startup })            host-owned startup policy
```

Vite 和 production freezer 必须加载同一个 entry。production bootstrap 由
`@pluxel/rolldown/build` 生成，以标准 ESM namespace 分别读取 default application 与 route-neutral product，再内联
`runtime-static` production adapter；用户不维护第二个 server entry，部署端也不解析 Pluxel packages。Freezer 只静态检查
default export 的 application authoring boundary，不求值 product，也不把产品字段复制进 deployment manifest。

fixed catalog 只限制可用插件代码集合，不移除运行时启停。ConfigService 与 RuntimeState 仍在每次启动时加载 plugin
config records、enabled state、dependency overrides 和 persistence state。`configure()` 的返回值同样在每次 host startup
重新解析，不是构建时序列化常量。

`configEnvironmentBootstrap` 只把当前 startup environment 解码成 ConfigService initial snapshot。Binding 必须指向同一 fixed
catalog 中 implementation 的 default node，并与该 Plugin 实际 root config schema 做 object identity 断言；同一 implementation
最多一个 binding，同一 environment 可以 fan-out 到 transport 相同的多个 target。它不改变 file-backed config authority，
也不建立 env provenance、readonly field 或第二个 config service。Host-only environment 继续由 `configure()` 直接读取。

static build 可解析的 optional candidate 进入固定 code-split closure；不可解析 candidate 被 lowering 成明确 absent
module，产物不留下目标 external import。目标机安装新包不能改变该 closure。

Workbench 有两个正交边界：build variant 决定 distribution 是否携带 shell/remotes，startup config 决定本次进程是否
安装 Workbench Plane。headless distribution 不能在启动时提升为 Workbench distribution。

Node adapter 拥有 listener、signal shutdown 和 deployment filesystem root。它把客户端中止请求或提前关闭响应传播到
Fetch `Request.signal`，并取消尚未完成的 Web response body；长请求和流式 handler 可以据此及时释放 owner resource。
Node distribution 可以另外携带业务 SPA
`public/`：Workbench disabled 或配置了非根 `workbench.uiBasePath` 时，它是 runtime 404 后的 HTML/static fallback；
Workbench 默认根路径时，根 navigation 由 shell 拥有。dynamic/static Vite route 使用同一个路径边界，只把 Workbench
navigation 与其 packaged `/dist/public/` asset 交给 runtime，其余请求继续交给宿主。平台 adapter 不进入
`runtime-static` application definition。当前 production freezer 只支持
Node；Worker/Fetch target 必须等待 runtime services 具备真正 platform-neutral closure 后再开放。

## Logging

进程日志由 launcher-owned `RuntimeLogging` 统一安装。一个进程只有一个 active root；plugin identity 编码在
category，动态等级由 root-owned O(1) policy 控制。完整不变量、启动顺序和大插件基数预算见
[`LOGGING.md`](LOGGING.md)。
