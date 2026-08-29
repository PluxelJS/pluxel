# Plugin registration and publication

> 本文定义 browser-safe View/Attachment declaration 如何绑定到 running Plugin generation，并通过一次原子 publication 进入 layout。
> ViewApi authoring 见 [`AUTHORING.md`](AUTHORING.md)，session/capability 见 [`CONTROL_PLANE.md`](CONTROL_PLANE.md)，renderer artifact 见
> [`FEDERATION.md`](FEDERATION.md)。

## 不建立第二个 Plugin 或 resource registry

Workbench 不拥有 installation、auto-start/session lifecycle、dependency resolution、generation identity 或 API namespace。Plugin catalog/Core graph 仍是唯一
runtime owner authority。Workbench 只接受 running generation 在 `init()` 中提交的一份 immutable projection。

“注册 Workbench”只有三个阶段：

| 阶段               | 输入                                                   | 输出                         | 是否打开 ViewApi |
| ------------------ | ------------------------------------------------------ | ---------------------------- | ---------------- |
| define/build       | Views/Attachments + phantom API types + producer facts | frozen definition/build plan | 否               |
| generation bind    | declared factories + required dependency handles       | frozen binding graph         | 否               |
| atomic publication | definition + bindings + producer revision              | immutable `PublishedTarget`  | 否               |

没有 Model/Query/Channel/Collection registration。API factory 只在通过 `openView()` admission 后调用。

## 一次 publication

```ts
ctx.workbench?.publish(definition, bindings)
```

每个 Plugin node/generation 最多调用一次。`ctx.workbench` 从 immutable Context 推导 target owner；definition 不重复声明 Plugin address。
Definition key 已经携带 View/Attachment declaration，TypeScript generic 已在作者代码中关联 API shape，因此 binding value 直接是 factory 或 dependency record，不再包一层
`workbench.bind.view/provider/attachment()`。

```ts
ctx.workbench?.publish(ExampleWorkbench, {
	settings: ({ principal, params, signal }) =>
		new SettingsTarget(service, { principal, params, signal }),
	fonts: {
		provider: this.fonts,
		consumer: ({ principal, params, signal }) =>
			new FontSelectionTarget(this, { principal, params, signal }),
	},
})
```

Definition 与 binding 使用同一个 flat key namespace。Descriptor 自身携带 kind，mapped type 直接从 `ExampleWorkbench.settings/fonts` 推导对应
factory shape；重复的 `views`/`attachments` 层既不增加 owner，也不增加校验信息，所以不进入 vNext。Definition value 对作者表现为 readonly record，
platform metadata 只放在 non-enumerable/internal symbol 上；key 必须满足固定 identifier grammar，并拒绝 `__proto__`、`prototype`、`constructor`、`then`
等会破坏普通 object/Promise 语义的名称。

Publication transaction：

1. 读取 flat exact record 中 final local View、provider Attachment 与 placed Attachment keys；普通 TypeScript builder 的中间结构在这里已经不存在；
2. 验证 placement/route collision、parameterized route ambiguity、navigation group metadata、declared key、target factory、provider Attachment
   factory 与 required dependency handle；
3. 验证 MF producer revision 与 exact Bridge expose inventory；
4. 校验并冻结 sync/async factory descriptor，但不调用用户 factory、不反射 method、不创建 stub/observer/remote；
5. 构造 immutable `PublishedTarget` 与 candidate layout indexes；
6. 用一次同步 pointer/index commit 发布新 layout revision；
7. 把 publication cleanup 绑定 owner generation effects。

任一步失败都使 Plugin `init()` 失败并完整回滚，不留下 partial layout、ViewApi、opened-view lease、subscription 或 artifact publication。

`PluginPart` 与 shared library 只参与源码组合，不获得 Workbench owner。它们可以用普通 TypeScript
function/record 提供静态 entry 或 generation binding 片段；owning Plugin 必须先聚合成一个 final
definition 和一个 exact binding record，再由自己的 `ctx.workbench.publish()` 提交一次。Reachable Part
entry 的 descriptor owner、producer 与 withdrawal 都归 owning Plugin definition/generation；同一个 Part
被不同 Plugin definition 复用时分别 lowering，不共享 runtime identity。Part 不得自行 publish、延迟
contribute、拥有 MF producer/opened-view lease，冲突也不能按 Part 或调用顺序决定。

## Declaration exactness

TypeScript 与 runtime 各自检查自己真正拥有的边界。TypeScript 提前检查：

- 每个 local View 恰有一个 placement 和一个返回相应 API generic 的 target factory；
- provider publication 为每个 declared Attachment 绑定 provider API factory；
- consumer placement binding 的 consumer factory 与 optional consumer API generic 一致；
- descriptor-bound React hook 只得到相应 local API；provider-only Attachment 精确省略 `consumer` property，provider+consumer Attachment 才返回它。

Renderer 侧的具体投影直接使用上游 `RpcStub<Api>`；方法调用沿用上游 RpcPromise/result projection。Workbench 不生成第二套 Server/Client type，也不把
stub runtime reflection 伪装成 method inventory。

Plugin React component 是零 props component，通过 `useWorkbench(Definition.entry)` 取得投影。MF Bridge 的 generated wrapper props、opened handle 与
Context provider 属于 `runtime/workbench/federation` internal ABI，不是 public Plugin component signature。Stable descriptor identity 会在 wrapper/hook
边界检查，但它只标识 definition entry，不是 API contract hash，也不尝试反射 erased method shape。

## Descriptor identity

Descriptor identity 由 toolchain 生成，作者不能填写或拼接。语义是 canonical tuple，跨 boundary 的
closed record shape 固定为：

```ts
type ViewDescriptorIdentity = Readonly<{
	kind: 'view'
	owner: PluginDefinitionAddress
	key: string
}>

type AttachmentDescriptorIdentity = Readonly<{
	kind: 'attachment'
	owner: PluginDefinitionAddress
	key: string
}>

type AttachmentPlacementIdentity = Readonly<{
	kind: 'attachment-placement'
	consumer: PluginDefinitionAddress
	key: string
	provider: AttachmentDescriptorIdentity
}>

type OpenableDescriptorIdentity = ViewDescriptorIdentity | AttachmentPlacementIdentity
```

Canonical equality 逐字段比较 parsed address/kind/key，不依赖 property order 或 `JSON.stringify()`。
Provider Attachment declaration 自身不是 openable placement；它只作为 placed identity 的 exact
`provider` 字段和 producer expose identity。

Plugin fork/node/generation 不进入 descriptor identity；它们在 publication/open 时与 descriptor 分别组成
runtime owner。`definitionRevision` 与 `producerBuildRevision` 也不进入 descriptor identity：前者验证同一
definition record 的内容，后者 pin artifact。三个维度不能互相替代。

Server lowering、producer build 和 generated Bridge wrapper 必须从同一 lowered facts 重建相同的
View/Attachment declaration identity。Consumer lowering 另外构造完整 placement identity，并嵌入 exact
provider Attachment identity；provider producer 不需要也不可能预知 consumers。任何一层都不得使用
JavaScript object identity、class/function name、运行时 `import.meta.url`、绝对 source path、chunk name
或 bundler hash。`workbench.entry()` 的 URL/path 只提供 build provenance。

Entry key rename 会改变 descriptor、route restoration 与 opened-view identity，是 breaking definition
change；vNext 不提供 alias。`.place()` 保存 provider descriptor 的 canonical identity，而不是 provider
string。Host client 比较 selected layout、open input 与 constructed handle 的完整
`OpenableDescriptorIdentity`。Generated wrapper/expose 对 local View 比较完整 View identity；对
Attachment 比较 opened placement 的 `provider` identity。Plugin `useWorkbench()` 执行相同的
declaration-level check 后再投影 API。所有校验都必须在第一次 Plugin API 调用前拒绝 wrong
renderer/expose/descriptor。

Runtime 不声称从擦除后的 TypeScript 恢复 API method inventory。它只独立验证平台事实：

- binding 没有未声明 View/Attachment key，也不缺少 definition key；
- local View renderer expose 属于 target producer revision；
- provider publication 为每个 declared Attachment 绑定 callable provider factory 与 provider-owned renderer expose；
- consumer placement binding 根据 descriptor 精确接收 `{ provider: requiredDependency }` 或
  `{ provider: requiredDependency, consumer: factory }`；
- `openView()` 时 provider factory 看到 platform-issued 的 consumer node 正是 publishing consumer owner，并且其有效期绑定 consumer generation；
- provider handle 不能携带 consumer factory；consumer 不能伪造 provider factory；
- structured Plugin address、definition/build revision、placement、owner 和 generation 通过 runtime parser；
- sync/async factory resolved result 是 fresh、尚未作为 Workbench root export 的 `RpcTarget`，并绑定正确 owner、opened-view lease 与 withdrawal gate；
- duplicate publication、stale generation、withdrawn provider、非法 factory 或非 `RpcTarget` result fail-fast。

Workbench 不校验 Plugin 方法名、参数、返回值、domain error 或 child target shape；这些由 Plugin 自己的 target/service 实现负责。Dynamic Plugin、build
inventory 与 browser control input 跨越静态边界，所以 TypeScript 也不能替代上面的平台检查。

## Publication indexes 只索引静态 UI topology

Definition record 和 publication topology 在 generation 内不可变。Runtime 不接受条件 entry、
`visibleWhen`/`enabledWhen`、per-principal predicate、append/remove 或重新 publish。Principal 对整个
target 的 access 可在 layout projection 时过滤；页面内部 availability 继续由 domain API 表达。

Backend 只维护：

- target address -> `PublishedTarget`；
- global navigation -> ordered View descriptions；
- target -> exact tab/route/Attachment placement entries；
- producer definition/build revision -> trusted manifest reference；
- target/provider generation -> affected publications and active opened-view leases。

Navigation group 不进入独立 index/registry。它只是 route description 上的 frozen value；同 group ID 的 label/icon 在整个 candidate layout 中必须
一致，否则 publication 失败。Exact route 优先于 parameterized route；两个能匹配同一 canonical path 的 parameterized patterns 在 candidate 可见前
拒绝，不能按 publication 顺序选 winner。

API method、domain row、task、observer、child capability 和 browser cache 都不进入 publication index。Plugin 不能 enumerate 后注入
contribution，Attachment 不扫描 provider，browser 也不能用 string key 换 capability。

复杂度：

- publication/index 为 `O(V + A)`；
- target layout 为 `O(target views + attachments)`；
- Attachment resolution 为 exact direct edge `O(1)`；
- domain rows/tasks 与 layout complexity 无关。

## Layout 是 description，不是授权

Layout snapshot 只包含：

- monotonic revision；
- canonical target/renderer owner address；
- canonical descriptor identity、placement、route/tab/navigation metadata；
- definition revision 与 producer build revision；
- `FederatedViewRef`。

Layout 不包含 callable stub、method inventory、grant ID、subscription、task、domain data 或 resolved module。Enumerate/search/restore tabs 不调用 API
factory、不注册 remote、不请求 manifest，也不预签发 authority。

## `openView()` 是唯一 lazy admission

```ts
import type { RpcStub, RpcTarget } from '@pluxel/runtime/capnweb'

type OpenViewFailureCode =
	'layout_changed' | 'target_unavailable' | 'factory_failed' | 'factory_timeout' | 'quota_exceeded'

type OpenViewResult<Opened> =
	Readonly<{ ok: true; value: Opened }> | Readonly<{ ok: false; code: OpenViewFailureCode }>

type LocalOpenedView<Api extends RpcTarget> = Readonly<{
	kind: 'local'
	api: RpcStub<Api>
	params: Readonly<Record<string, string>>
	federatedViewRef: FederatedViewRef
}>

type ProviderOpenedView<ProviderApi extends RpcTarget> = Readonly<{
	kind: 'attachment'
	provider: RpcStub<ProviderApi>
	params: Readonly<Record<string, string>>
	federatedViewRef: FederatedViewRef
}>

type JointOpenedView<ProviderApi extends RpcTarget, ConsumerApi extends RpcTarget> = Readonly<{
	kind: 'attachment'
	provider: RpcStub<ProviderApi>
	consumer: RpcStub<ConsumerApi>
	params: Readonly<Record<string, string>>
	federatedViewRef: FederatedViewRef
}>
```

`location` 只是 canonical target-relative path，静态 tab 省略。Server 先重新匹配 declared route，再校验 structured target、descriptor
identity、layout revision、authenticated principal lease 与 quotas。Browser 不直接传入 params record。Revision mismatch 返回
`layout_changed`，不创建 target。Target 已撤销或不再对 principal 可见统一返回 `target_unavailable`，避免用错误码枚举隐藏 target。

上述 code 是完整的 platform admission mapping：revision mismatch 是 `layout_changed`；target 不存在、
无权访问或 admission 期间 withdrawal 是 `target_unavailable`；quota admission 是
`quota_exceeded`；factory boundary 捕获的 throw/rejection/non-`RpcTarget` 是 `factory_failed`；共同
deadline 是 `factory_timeout`。具体 factory cause 只进入受保护 diagnostics。

Malformed input/result envelope、Workbench/Cap’n Web 自身在 factory boundary 外的 programming error
与 broken connection 保持 rejection，不转换成 catch-all result。Plugin domain failure 不进入这组
code：缺失对象等状态应由成功打开的窄 root 以自己的 closed result 表达。

Factory 只获得 frozen `principal`、server-derived `params` 和 opened-view `signal`。Attachment provider factory 额外获得 exact
`consumer: { node: PluginNodeAddress }`。Consumer reference 是 server-only identity/ownership reference，不是 capability：不含 consumer Context、instance、
dependency facade 或 service locator，也不进入 renderer Context。Factories 都不获得 raw request、cookie、socket、session root 或 auth provider target。

Factory 可以返回 `Api` 或 `Promise<Api>`，其中 `Api extends RpcTarget`。Admission 在调用前建立一个共同的 opened-view signal/deadline；Attachment 的
provider/optional consumer 都取得 owner lease 后可以并行准备，但必须全部成功才一次返回。任一 factory reject、deadline、owner withdrawal 或 resolved
non-`RpcTarget` 都会 abort signal，dispose 已完成及随后迟到的 target，并返回零 root 的稳定 open failure。失败不能把一个 Attachment root、observer、
Bridge 或 partial handle 暴露给 browser。

`openView()` 一次 transfer 上述 capability 与 by-value facts；不会先返回 `ViewSessionTarget` 再调用
`api()`。Await 后的顶层 object result 自带 Cap’n Web disposer。Concrete browser client 验证 envelope：
failure branch 不含 stub 并立即 dispose raw result；malformed envelope 在 reject 前也先 dispose；success
branch 把整个 raw result 的唯一 ownership 转入本地 opened handle。Plugin renderer 只借用 nested
roots，不能 dispose handle 或分别释放 root。
Server 只保留 internal lease，Plugin API payload 对 Workbench 是 opaque Cap’n Web value。

Opened View rules：

- local View 只有一个 API root；Attachment 只有 provider + optional consumer 两个 API root；
- 每个 accepted factory call 返回 fresh root wrapper；同一 `RpcTarget` instance 不跨 open 或 provider/consumer owner 重复 export；
- 同一 parameterized View 可以在不同 document 中多次打开，每次都有独立 params/signal/target；
- renderer 不能取得 page session root、其他 View API、socket 或 capability lookup；
- API method 可以按 Plugin 自己的 TypeScript API 返回任意 Cap’n Web child target；Workbench 不声明、登记或解析 child method shape；普通 row/value 不自动成为 target；
- target/provider 任一 withdrawal 都使 retained Attachment stub 稳定失败；
- active opened-view lease、child target、observer、in-flight call、callback queue 与 bytes 全部有界；
- async factory pending 数与 deadline 有界；abort 后的 late resolve target 立即 dispose，不能复活已失败的 open；
- Bridge destroy 后 browser handle 只调用一次顶层 result disposer，由它释放直接返回的全部 roots；socket close 是 server cleanup 最终边界。

同一 domain service 可以在 factory 内共享 immutable cache/backend，但 Workbench 不通过 method name/schema/returned bytes 猜测 API target 可合并。
需要共享时由 fresh wrappers 引用同一 owner-safe backing，或由 Plugin API 定义 child capability；可变 consumer authority 不跨 owner 合并。

## Ownership

| 来源                   | placement owner | API owner                    | renderer owner | withdrawal boundary    |
| ---------------------- | --------------- | ---------------------------- | -------------- | ---------------------- |
| local View             | target Plugin   | target                       | target package | target generation      |
| TypeScript-built Views | target Plugin   | target                       | target package | target generation      |
| provider Attachment    | target Plugin   | provider + optional consumer | provider       | target/provider 的交集 |
| builtin host document  | host            | host/none                    | host           | host/layout revision   |

普通 shared library 不获得 runtime owner。MF producer 是 artifact owner，不代替 Plugin generation owner。Browser View handle 只管理一次
open 的本地资源；server internal lease 只管理该次 capability lifetime，二者都不反向拥有 publication。

## Withdrawal、replacement 与 dev update

Owner stop 顺序：

1. 关闭受影响 publication 的新 `openView()` admission；
2. 通知 Shell destroy affected Bridge；
3. withdraw ViewApi/child targets，使 retained stubs fail；
4. abort/drain 已接纳 call、task、observer 与 stream；
5. dispose opened View handles/leases；
6. 撤销 publication/index revision；
7. 完成 owner generation cleanup。

Provider Attachment withdrawal 不关闭 target 的无关 local View。Consumer replacement 不按 Attachment key 自动领养 provider；新 generation 必须沿
新 committed dependency edge 重新 publish。

Profile 1 不做页内 renderer hot swap，也不让新 build 复用已经打开的 roots。Dev toolchain 先构建并
验证 immutable artifact candidate；失败 candidate 不进入 inventory，当前完整 tuple 原样继续运行。
Candidate commit 后只触发 full-document reload，新 document 重新读取 layout、加载 exact expose 并
`openView()`。因此 dev 与 production 都不需要猜测 API compatibility，也没有 old/new Bridge 与 roots
并存或换接。

## Optional planes

- `management + workbench`：安装 session endpoint、publication/layout/federation backend；
- headless `management`：安装 management-only root，不创建 Workbench Context、publication、opened-view lease 或 producer graph；
- 两者都未安装：不创建 endpoint、authentication/control backend 或 browser artifacts。

## Publication 否决条件

- 第二个 Workbench Plugin/resource/Feature/Collection registry；
- 一个 generation 多次追加、局部 commit 或由 browser/React effect 注册；
- layout read 创建 API target、subscription、remote registration 或 artifact request；
- View 通过 string namespace/method lookup 获得未声明 capability；
- browser 直接传 factory params/principal，或 factory 获得 raw request/session root；
- `openView()` 增加中间 session/resource target 或第二次 API lookup round trip；
- Attachment 通过 scan、priority、fallback、optional dependency 猜测 provider，或接受 arbitrary resource map；
- collection/account row 被发布为 View/Attachment/capability entity；
- publication 先可见再异步验证 binding descriptor/expose；
- async factory failure/timeout 后返回 partial root，或 late resolve target 越过 aborted opened-view lease；
- Workbench 为 Plugin API 强制 schema、method descriptor、contract hash 或 generated validator；
- retained old generation handle 越过 owner/provider withdrawal；
- rollback、replacement 或 StrictMode replay 泄漏 target/session/observer/asset。
