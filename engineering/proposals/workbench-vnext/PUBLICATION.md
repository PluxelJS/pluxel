# Plugin registration and publication

> 本文定义 browser-safe View/Attachment declaration 如何绑定到 running Plugin generation，并通过一次原子 publication 进入 layout。
> ViewApi authoring 见 [`AUTHORING.md`](AUTHORING.md)，session/capability 见 [`CONTROL_PLANE.md`](CONTROL_PLANE.md)，renderer artifact 见
> [`FEDERATION.md`](FEDERATION.md)。

## 不建立第二个 Plugin 或 resource registry

Workbench 不拥有 installation、auto-start/session lifecycle、dependency resolution、generation identity 或 API namespace。Plugin catalog/Core graph 仍是唯一
runtime owner authority。Workbench 只接受 running generation 在 `init()` 中提交的一份 immutable projection。

“注册 Workbench”只有三个阶段：

| 阶段               | 输入                                          | 输出                         | 是否打开 ViewApi |
| ------------------ | --------------------------------------------- | ---------------------------- | ---------------- |
| define/build       | Views/Attachments + API/producer contracts    | frozen definition/build plan | 否               |
| generation bind    | exact factories + required dependency handles | frozen binding graph         | 否               |
| atomic publication | definition + bindings + producer revision     | immutable `PublishedTarget`  | 否               |

没有 Model/Query/Channel/Collection registration。API factory 只在通过 `openView()` admission 后调用。

## 一次 publication

```ts
ctx.workbench?.publish(definition, bindings)
```

每个 Plugin node/generation 最多调用一次。`ctx.workbench` 从 immutable Context 推导 target owner；definition 不重复声明 Plugin address。
Definition key 已经携带 View/Attachment 的 exact contract，因此 binding value 直接是 factory 或 dependency record，不再包一层
`workbench.bind.view/provider/attachment()`。

```ts
ctx.workbench?.publish(ExampleWorkbench, {
	views: {
		settings: ({ principal, params, signal }) =>
			new SettingsTarget(service, { principal, params, signal }),
	},
	attachments: {
		fonts: {
			provider: this.fonts,
			target: ({ principal, params, signal }) =>
				new FontSelectionTarget(this, { principal, params, signal }),
		},
	},
})
```

Publication transaction：

1. flatten final local View 与 Attachment placement keys；普通 TypeScript builder 的中间结构在这里已经不存在；
2. 验证 placement/route collision、ViewApi contract、exact target factory、provider Attachment factory 与 required dependency handle；
3. 验证 MF producer revision 与 exact Bridge expose inventory；
4. 校验并冻结 factory descriptor，但不调用用户 factory、不创建 stub/observer/remote；
5. 构造 immutable `PublishedTarget` 与 candidate layout indexes；
6. 用一次同步 pointer/index commit 发布新 layout revision；
7. 把 publication cleanup 绑定 owner generation effects。

任一步失败都使 Plugin `init()` 失败并完整回滚，不留下 partial layout、ViewApi、opened-view lease、subscription 或 artifact publication。

## Exactness contract

Public type 提前诊断，runtime 仍独立验证：

- 每个 local View 恰有一个匹配其 `CapabilityContract` 的 target factory；
- binding 没有未声明 View/Attachment key，也不缺少 definition key；
- local View renderer expose 属于 target producer revision；
- provider publication 为每个 declared Attachment exact 绑定 provider API factory 与 provider-owned renderer expose；
- consumer placement binding 只接收 `{ provider: requiredDependency, target? }`；
- `openView()` 时 provider factory 看到的 validated caller 正是 publishing consumer target；
- Attachment provider API、optional target API 与 renderer expose exact match declaration；
- provider handle 不能携带 target factory；consumer 不能伪造 provider factory；
- structured Plugin address、definition hash、build revision 和 placement 通过 runtime schema；
- duplicate publication、stale generation、withdrawn provider 或 callable shape mismatch fail-fast。

TypeScript 不能替代这些检查，因为 dynamic Plugin、build inventory、Cap’n Web input 与 browser values 都跨越静态边界。

## Publication indexes 只索引静态 UI topology

Backend 只维护：

- target address -> `PublishedTarget`；
- global navigation -> ordered View descriptions；
- target -> tab/route/Attachment placements；
- producer definition/build revision -> trusted manifest reference；
- target/provider generation -> affected publications and active opened-view leases。

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
- stable View key、placement、route/tab/navigation metadata；
- definition/API contract hash；
- `FederatedViewRef`。

Layout 不包含 callable stub、method inventory、grant ID、subscription、task、domain data 或 resolved module。Enumerate/search/restore tabs 不调用 API
factory、不注册 remote、不请求 manifest，也不预签发 authority。

## `openView()` 是唯一 lazy admission

```text
openView({ target, view, location, expectedLayoutRevision })
  -> local OpenedView {
       api: exact ViewApi stub
       params: server-derived route params
       federatedViewRef
     }

  -> Attachment OpenedView {
       provider: exact provider ViewApi stub
       target?: exact consumer ViewApi stub
       params: server-derived route params
       federatedViewRef
     }
```

`location` 只是 canonical target-relative path，静态 tab 省略。Server 先重新匹配 declared route，再校验 structured target、View
key、layout revision、principal policy 与 quotas。Browser 不直接传入 params record。Revision mismatch 返回 `layout_changed`，不创建 target。

Factory 只获得 frozen `principal`、server-derived `params` 和 opened-view `signal`。Attachment provider factory 额外获得 exact
consumer `caller`。它们都不获得 raw request、cookie、socket、session root 或 auth provider target。

`openView()` 一次 transfer 上述 capability 与 by-value facts；不会先返回 `ViewSessionTarget` 再调用 `api()`。Concrete browser client 从 result
建立本地 disposable handle 和 host facade，server 只保留 internal lease。

Opened View rules：

- local View 只有一个 API root；Attachment 只有 provider + optional target 两个 API root；
- 同一 parameterized View 可以在不同 document 中多次打开，每次都有独立 params/signal/target；
- renderer 不能取得 page session root、其他 View API、socket 或 capability lookup；
- API method 可以返回 declaration 允许的 child capability；普通 row/value 不自动成为 target；
- target/provider 任一 withdrawal 都使 retained Attachment stub 稳定失败；
- active opened-view lease、child target、observer、in-flight call、callback queue 与 bytes 全部有界；
- Bridge destroy 后 browser handle 显式 dispose 直接返回的 roots；socket close 是 server cleanup 最终边界。

同一 domain service 可以在 factory 内共享 immutable cache/backend，但 Workbench 不通过 method name/schema/returned bytes 猜测 API target 可合并。
需要共享时由 provider implementation 返回同一 owner-safe backing 或 declared child capability；可变 consumer authority 不跨 owner 合并。

## Ownership

| 来源                   | placement owner | API owner                  | renderer owner | withdrawal boundary    |
| ---------------------- | --------------- | -------------------------- | -------------- | ---------------------- |
| local View             | target Plugin   | target                     | target package | target generation      |
| TypeScript-built Views | target Plugin   | target                     | target package | target generation      |
| provider Attachment    | target Plugin   | provider + optional target | provider       | target/provider 的交集 |
| builtin host document  | host            | host/none                  | host           | host/layout revision   |

普通 shared library 不获得 runtime owner。MF producer 是 artifact owner，不代替 Plugin generation owner。Browser View handle 只管理一次
open 的本地资源；server internal lease 只管理该次 capability lifetime，二者都不反向拥有 publication。

## Withdrawal 与 replacement

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

Producer-only HMR 且 API/definition hash 不变时，可以先 render new Bridge 再 destroy old Bridge，并由实现决定是否复用仍有效的 API backing。
API contract、owner、dependency 或 generation 改变时必须重新 `openView()`，不猜测兼容。

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
- publication 先可见再异步验证 factory/expose；
- retained old generation handle 越过 owner/provider withdrawal；
- rollback、replacement 或 StrictMode replay 泄漏 target/session/observer/asset。
