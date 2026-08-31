# Workbench Standard Pages

> 状态：research proposal，尚未采纳。本文不描述当前 API，也不能覆盖
> [`../WORKBENCH.md`](../WORKBENCH.md)、[`../FRONTEND.md`](../FRONTEND.md)、
> [`../CONFIG.md`](../CONFIG.md) 与用户文档中的现有事实。

## 结论摘要

Pluxel 应在自动配置页和完整 React View 之间增加一种 host-rendered **Standard Page**：Plugin 用固定、线性的
Markdown document 用封闭 slot 引用 Valibot 驱动的运行时 snapshots 和 bounded actions；第一版由 Workbench Shell 负责
渲染、订阅失效、刷新、标准表单与表格、确认、loading、失败反馈和 Cap’n Web target 包装。

候选作者面只有四个 builder：

```ts
workbench.page({ document: workbench.markdown(...), placement })
workbench.markdown(import.meta.url, './guide.md', slots?)
workbench.snapshot(ValibotSchema)
workbench.action({ label, input?, form?, danger? })
```

Standard Page 不是新的 Plugin、renderer SPI、通用 JSON UI、表单 schema、command carrier 或 MDX application。
它保留当前 publication、owner generation、principal、route params、invocation lease 和 abort 语义，但不要求作者：

- 创建 React/MF producer；
- 引入 `@mantine/core` 或安装 Provider；
- 声明 browser-facing `RpcTarget` interface；
- 手写 fresh target、snapshot loading、按钮 single-flight、confirm 和 notification；
- 复制已有 Config presentation 或 persistence 流程。

Config 不成为 Standard Page block。宿主继续从 `configs.use()` 的 root/PluginPart declarations 构建一个 owner-level composite
Config resource，并在 Plugin stopped 时仍可编辑。Standard Page action 始终作用于 Plugin 当前 framework-confirmed applied
state，而不隐式读取浏览器尚未保存的 config draft。

## 1. 问题与真实证据

当前 Workbench 有两个有效但距离较远的作者路径：

1. `configs.use(ObjectSchema)` 自动生成配置界面；
2. `workbench.view<Api>()` + `RpcTarget` + React renderer 表达任意领域界面。

完整 View 对复杂需求是正确成本。仓库中的现有用例可以证明这条边界：

- Auth setup 有 password/TOTP/OIDC 多步输入、credential admission 和领域失败码；
- Package Manager 有列表、安装/卸载、进度和 package state；
- Fonts manager 有上传、表格、选择器和删除；
- Wretch Attachment 编辑动态 header rows 和 per-consumer state。

这些都不应被压进 Standard Page。另一方面，现实 Plugin 经常只需要：

- 展示运行中的使用方法、状态解释或故障排查 Markdown；
- 展示连接状态、当前 endpoint、缓存数量、最近同步时间等少量事实；
- 执行“测试连接”“刷新索引”“清空缓存”“重新扫描”等无额外输入操作；
- 在已有自动配置页之外解释配置含义，并对已经保存和应用的配置执行一次验证。

为这些需求创建 browser API、fresh `RpcTarget`、React root、MF expose、Provider 和 UI state 会使作者成本远高于
领域逻辑，也让许多 Plugin 在第一次需要按钮时直接依赖完整 UI stack。缺口不是通用 UI framework，而是一个
有意受限的 host-rendered management page。

## 2. 目标

### 2.1 必须满足

- 文档-only Plugin 不生成自己的 JavaScript producer，也不解析 React/Mantine peer。
- snapshot + actions Plugin 不手写 `RpcTarget`，但仍保留 current owner、principal、params、signal 和 cleanup。
- snapshot 可以通过 invalidate-only watch 近实时收敛，不建立通用 event vocabulary 或 data push protocol。
- action input 复用 Valibot schema、`valibot-form` presentation plan 和 server-side validation，不建立第二套 form DSL。
- Markdown、embedded action form 和 read-only table 能按稳定 slot key 自然交错，而不是靠 TypeScript object order 排版。
- declaration 是固定、可构建、可验证的 semantic fact；运行期数据不改变 entry topology。
- config、业务状态和业务 API 仍不依赖 Workbench；Workbench disabled 时不产生 runtime backend。
- Shell 只解释一个小型封闭协议，不执行 Plugin 提供的 component、HTML、JavaScript、CSS 或 theme token。
- resource/runtime protocol不编码Workbench placement、React/Mantine或Cap’n Web；Workbench只是第一版唯一host adapter。
- Standard Page 与完整 View 有明确升级条件，不逐步长成第二套 React。
- static/dynamic、development/production、HMR、headless/workbench variant 使用同一 declaration 语义。
- browser 收到的 runtime snapshot、action result 和 Markdown artifact 都经过预算和运行时验证。

### 2.2 明确不做

- 任意 `component: string` + `props: unknown` 树；
- 第三方注册 Standard Page node renderer；
- JSX、MDX、自定义 React component、HTML/CSS 注入；
- 任意 nesting、responsive layout、editable domain table、tree、chart、file upload 或 rich editor；
- Page controller 读取/传递 Config draft、runtime-generated form schema 或 Plugin 自定义 input dialog；
- 通用 query/cache/event/data-push/polling model；
- 长任务 progress、background task ownership 或 resumable operation；
- Standard Attachment 或跨 Plugin component composition；
- 用 action 替代 commands、Management、HTTP 或 Plugin 业务 API；
- 自动从 README、commands、public methods 或 config schema 猜测页面和按钮。

这些需求继续使用完整 View/Attachment 或已有 runtime capability。只有真实 workspace 用例证明某个封闭 primitive
反复出现时，才单独扩展 Standard Page protocol。

## 3. 三层作者模型

| 需求                          | 默认入口                        | 升级信号                                              |
| ----------------------------- | ------------------------------- | ----------------------------------------------------- |
| 持久化配置                    | `configs.use(schema)`           | 需要编辑 Plugin 不拥有的领域对象                      |
| 文档、bounded snapshot/action | `workbench.page()`              | 需要无界 collection、自定义布局、多步流程或连续数据流 |
| 完整管理 application          | `workbench.view()` / Attachment | 无；这是通用 escape hatch                             |

Standard Page 不取代任何现有入口。它增加一种 `WorkbenchEntry`：

```ts
type WorkbenchEntry =
	| WorkbenchView<any>
	| WorkbenchAttachment<any, any>
	| WorkbenchAttachmentPlacement<any, any>
	| WorkbenchPage<any>
```

`page()` 只表示 owner-local openable；第一版不能被 `.place()`。跨 Plugin UI 的 ownership 继续只由 Attachment
表达，避免为了少量 host primitives 建立第二套 provider/consumer contract。

### 3.1 对当前架构事实的明确修改

这不是在现有规则下无需决策的 implementation detail。若提案被采纳，必须同步修改以下当前事实：

- Workbench 作者概念从 Definition/View/Attachment/Placement 增加 Standard Page；
- Definition 的固定 entry union 从 View/Attachment/placement 扩展为包含 Page；
- 当前“每个 openable 都加载 Bridge expose”的 activation 变成 federated View 与 host-rendered Page 的封闭联合；
- Toolchain 的 Workbench artifact 从只有 MF producer 扩展为 MF producer 与 immutable content artifact 两类。

以下不变量不变：Workbench-enabled host 仍固定安装 Cap’n Web、MF2 Runtime 和 React Bridge，完整 View/Attachment
仍只有这一条 renderer contract；Standard Page 不允许 host 选择另一种 renderer，也不使 MF/Bridge 变成可配置 adapter。
即使某个 Plugin 只有 Standard Page，Workbench Shell 本身仍是同一个固定产品，只是该 Plugin 不再产生自己的 remote producer。

因此，采纳后需要更新 `DESIGN_PRINCIPLES.md`、`PLUGIN_SYSTEM.md`、`WORKBENCH.md`、`FRONTEND.md` 和 `TOOLCHAIN.md`，
而不能让 proposal 与 current authority 长期矛盾。提案阶段保留冲突是为了让这项公共契约接受独立评审。

## 4. 候选作者 API

### 4.1 最小模型：Markdown document + typed slots

Markdown 是唯一页面内容流；TypeScript slot map 只声明动态节点的 schema/interaction contract。Markdown 中的
`:slot[key]` inline scalar directive或`::slot[key]` block directive决定节点位置，slot key是稳定declaration identity：

```ts
// src/workbench.ts
import { workbench } from '@pluxel/runtime/workbench'

export const RedisWorkbench = workbench.define({
	guide: workbench.page({
		document: workbench.markdown(import.meta.url, './workbench-guide.md'),
		placement: workbench.tab({
			label: '使用说明',
			icon: workbench.icons.TextRecognition,
			order: 20,
		}),
	}),
})
```

静态 page 没有运行期 binding，但仍由 running generation 显式 publish：

```ts
override init() {
	this.ctx.workbench?.publish(RedisWorkbench)
}
```

Publication 不能由 build artifact 自动推导。显式调用保留“这个 generation 选择发布什么”的单一 owner fact，
Workbench disabled 时 optional call 也不会构造 bindings。若 definition 同时包含需要 binding 的 entry，第二个参数仍是
exact bindings object。

Slot union 只有：

```ts
type WorkbenchPageSlot =
	WorkbenchSnapshotSlot<DisplaySchema> | WorkbenchActionSlot<ObjectLikeSchema | undefined>
```

这里有意不再提供 `fact()`。单独的 fact DSL 会与 Valibot 的类型、label、description、picklist label 和 number format
产生第二份 field vocabulary。少量 facts 是 `snapshot(v.object({...}))` 的一种标准投影，表格则是同一 primitive 对扁平 row
array 的另一种标准投影。Markdown 本身不是 slot；它是承载这些 slots 的 document。

### 4.2 Markdown、状态、表格和表单交错

配置继续只有一份 schema：

```ts
// src/index.ts
private readonly config = this.configs.use(RedisConfig)
```

Standard Page 不复制或放置 `RedisConfig`。动态数据各自带一个只读显示 schema：

```ts
// src/workbench.ts
import * as v from 'valibot'
import { arrayMeta, formMeta, numberMeta, stringMeta } from 'valibot-form'
import { workbench } from '@pluxel/runtime/workbench'

const Status = v.pipe(
	v.object({
		connection: v.pipe(v.picklist(['connected', 'unavailable']), formMeta({ title: '连接状态' })),
		endpoint: v.pipe(v.string(), formMeta({ title: '当前端点' }), stringMeta({ control: 'code' })),
		keys: v.pipe(v.number(), v.integer(), v.minValue(0), formMeta({ title: '键数量' })),
		lastCheckedAt: v.pipe(v.string(), v.isoTimestamp(), formMeta({ title: '最近检查' })),
	}),
	formMeta({ title: '运行状态' }),
)

const Peers = v.pipe(
	v.array(
		v.object({
			name: v.pipe(v.string(), formMeta({ title: '节点' })),
			latencyMs: v.pipe(
				v.number(),
				v.minValue(0),
				formMeta({ title: '延迟' }),
				numberMeta({ format: { maximumFractionDigits: 1 } }),
			),
			role: v.pipe(v.picklist(['primary', 'replica']), formMeta({ title: '角色' })),
		}),
	),
	formMeta({ title: '集群节点' }),
	arrayMeta({ emptyHint: '尚未发现节点' }),
)

export const RedisWorkbench = workbench.define({
	overview: workbench.page({
		document: workbench.markdown(import.meta.url, './redis.md', {
			status: workbench.snapshot(Status),
			test: workbench.action({ label: '测试连接' }),
			clear: workbench.action({
				label: '清空缓存',
				danger: '删除当前 namespace 中的全部缓存项，且不能撤销。',
			}),
			peers: workbench.snapshot(Peers),
		}),
		placement: workbench.tab({ label: '概览', order: 10 }),
	}),
})
```

```md
# Redis

这里说明配置与应用后状态的区别。

::slot[status]

## 连接测试

测试使用当前已经应用的配置。

::slot[test]

::slot[clear]

## 集群节点

::slot[peers]

如果连接不可用，请先检查宿主 Config resource 中的 endpoint。
```

Plugin binding 返回普通 controller；framework 创建 fresh internal target：

```ts
override init() {
	this.ctx.workbench?.publish(RedisWorkbench, {
		overview: ({ principal, params, signal }) => ({
			watch: (invalidate) => this.redis.subscribeStatus(invalidate),
			read: async ({ signal: callSignal }) => {
				const snapshot = await this.redis.inspect({ signal: callSignal })
				return {
					status: {
						connection: snapshot.connected ? 'connected' : 'unavailable',
						endpoint: this.config.endpoint,
						keys: snapshot.keys,
						lastCheckedAt: snapshot.checkedAt.toISOString(),
					},
					peers: snapshot.peers,
				}
			},
			actions: {
				test: async ({ signal: callSignal }) => {
					await this.redis.test({ signal: callSignal })
					return { ok: true, message: '连接成功' }
				},
				clear: async ({ signal: callSignal }) => {
					if (!this.canManage(principal)) {
						return { ok: false, message: '当前用户不能清空缓存' }
					}
					await this.redis.clear({ signal: callSignal })
					return { ok: true, message: '缓存已清空' }
				},
			},
		}),
	})
}
```

示例中的 `signal` 是 page lifetime signal，`callSignal` 是当前 read/action invocation signal；后者至少组合前者、
client call cancellation 与 owner withdrawal。普通 handler 可以忽略不需要的 context。

这正是目标中的混排能力：作者在一个 Markdown 文件里完成叙事和布局；TypeScript 只声明 `status/test/clear/peers` 的类型、
安全与runtime binding。它得到MDX最有价值的“内容中放交互”，但不执行MDX module。

### 4.3 参数化 route

Standard Page 可以使用现有 route placement，且 params 继续由 server 重新匹配：

```ts
job: workbench.page({
	document: workbench.markdown(import.meta.url, './job.md', {
		status: workbench.snapshot(JobStatus),
		retry: workbench.action({ label: '重试' }),
	}),
	placement: workbench.route('/jobs/:jobId', {
		title: 'Job',
		frame: 'shell',
	}),
})
```

这适合一个 bounded resource 的概览和一次性操作，但不适合 job 列表、日志流或 progress。一个 manager 打开不同
`jobId` 时仍只有一个 declaration 和 artifact。

### 4.4 带 Valibot input 的一次性操作

需要一两个输入字段不应立即升级成完整 View。Action 可以引用一个静态 Valibot object schema：

```ts
import * as v from 'valibot'
import { formMeta, numberMeta } from 'valibot-form'

export const ProbeInput = v.object({
	timeoutMs: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(100),
			v.maxValue(30_000),
			formMeta({ title: '超时', description: '只影响这次测试，不修改持久化配置。' }),
			numberMeta({ step: 100 }),
		),
		3_000,
	),
})

export const RedisWorkbench = workbench.define({
	overview: workbench.page({
		document: workbench.markdown(import.meta.url, './probe.md', {
			probe: workbench.action({
				label: '高级连接测试',
				input: ProbeInput,
				form: 'embedded',
			}),
		}),
		placement: workbench.tab({ label: '诊断' }),
	}),
})
```

Binding handler 取得 server 验证和 transform 后的 output：

```ts
this.ctx.workbench?.publish(RedisWorkbench, {
	overview: () => ({
		actions: {
			probe: async ({ input, signal }) => {
				const latencyMs = await this.redis.probe({ timeoutMs: input.timeoutMs, signal })
				return { ok: true, message: `连接延迟 ${latencyMs} ms` }
			},
		},
	}),
})
```

`form` 只有一个显式值 `'embedded'`；省略时就是 dialog，不保留无意义的 `form: 'dialog'` 写法。无 input action 不能声明它。
Shell 用 schema 的 browser-safe presentation plan 渲染同一个 `valibot-form`；embedded 只改变表单是否直接展开在 action 的 block
slot 中，不改变 draft、validation 或提交语义。它也不会使 action 可以放进 Markdown inline directive；action 始终只能使用
`::slot[key]`。Browser plan 只改善输入体验，不执行或替代 authoritative schema；提交值以 `unknown` 进入 server，按同一个
schema 验证、应用 default/transform，
成功后才调用 handler。Validation failure 只返回 bounded path/message，不回显 raw input、secret、schema closure 或 arbitrary issue。

Action input 是一次 browser-local invocation draft，不持久化，也不等于 Plugin config draft。成功后重置；用户 cancel、page close
或session epoch失效时丢弃；client/server validation failure、预期领域失败和unexpected failure时保留，允许修正后重试。Password
等敏感字段只留在当前page内存，不进入URL、artifact、日志、result或snapshot。动态 collection、跨步骤状态、文件、stream 或依赖
运行时生成 schema 的输入仍使用完整 View。

### 4.5 Markdown 中间放 Valibot editable table

`valibot-form` 已有 array/record 的 table renderer，所以 bounded editable rows 不需要新增 `table()` API。它可以出现在 Config
schema 中，也可以作为 embedded action input 的一个字段：

```ts
import { formMeta, recordMeta } from 'valibot-form'

const ProbeHeaders = v.object({
	headers: v.pipe(
		v.record(v.string(), v.string()),
		formMeta({ title: '本次请求 Headers' }),
		recordMeta({
			layout: 'table',
			key: { label: 'Header' },
			value: { label: 'Value' },
			addLabel: '添加 Header',
		}),
	),
})

workbench.page({
	document: workbench.markdown(import.meta.url, './request-test.md', {
		probe: workbench.action({ label: '发送测试请求', input: ProbeHeaders, form: 'embedded' }),
	}),
	placement: workbench.tab({ label: '请求测试' }),
})
```

`request-test.md` 只需在前后说明之间放一行 `::slot[probe]`。

这个 table 编辑的是一次 action draft；如果相同 shape 位于 `configs.use()` schema，宿主 Config resource 也可以复用相同
renderer 和 schema metadata，但它不会嵌进 Standard Page。两者提交目标分别是 action handler 与 Config coordinator。需要服务端
分页、row-level mutation、selection 或长生命周期 domain collection 时仍使用完整 View。

## 5. Declaration contract

以下类型展示期望语义，不承诺实现文件中的 exact generic 写法：

```ts
type WorkbenchPage<Slots extends WorkbenchPageSlotMap | undefined> = Readonly<{
	kind: 'page'
	document: WorkbenchMarkdownDocument<Slots>
	placement: WorkbenchPlacement
}>

type WorkbenchPageSlotMap = Readonly<Record<string, WorkbenchPageSlot>>

function markdown(baseUrl: string, source: string): WorkbenchMarkdownDocument<undefined>

function markdown<Slots extends WorkbenchPageSlotMap>(
	baseUrl: string,
	source: string,
	slots: Slots,
): WorkbenchMarkdownDocument<Slots>
```

约束：

- `document` 必须是一个 direct `markdown()` call；`document`、`placement` 是全部允许的 page keys；
- Markdown source 必须包含实际内容；完全空白 page build fail；
- 第三个 `slots` 参数若存在必须是 direct object literal，每个value是direct `snapshot()`/`action()` call；
- slot key 使用与 entry key 相同的安全子集，并拒绝 reserved/prototype keys；
- slot key 是 declaration identity 的一部分；Markdown directive position只影响展示顺序，不参与 identity；
- 每个declared slot在Markdown中必须由`:slot[key]`或`::slot[key]`恰好引用一次；unknown、missing或duplicate均build fail；
- inline directive只能是paragraph的direct inline child，且只能引用one-leaf snapshot；不能引用object/collection/action；
- block directive只能是root-level leaf；两种directive都不能出现在heading、link、table、list、blockquote或code span/fence中；
- 一页最多 12 个 snapshot slots 和 8 个 action slots；
- `danger` 是危险操作的确认正文；存在时 Shell 必须使用 destructive presentation 并在调用 server 前确认；
- label、danger 和 action result message 都有明确 UTF-8/字符长度上限；
- slots第一版不接受spread、computed key、循环、
  runtime branch 或 imported fragment factory。
- action `input` 必须是可静态定位的 Valibot object/intersect schema；schema identity、field plan 和 output type 都进入
  declaration fact，不接受 factory、lazy root 或按 principal/state 生成的 schema。
- 每个 `snapshot()` schema 必须属于封闭 display subset，并可在 build time 产生 portable output plan。

最后一条不是认为 UI 不能复用，而是保证 Vite source、production build 和 HMR 使用相同静态事实。第一版的复用单位是
Workbench 内建 primitive，而不是作者定义的可执行 component。真实重复出现后可以研究 toolchain-safe declaration helper，
但不能回退到 module evaluation 猜 metadata。

### 5.1 API 已压缩到语义边界，不继续做语法缩写

以下写法表面更短，但会删除必要信息或混淆 authority，因此不进入候选 API：

| 更短写法                           | 不采用的原因                                                       |
| ---------------------------------- | ------------------------------------------------------------------ |
| `page(placement, document)`        | 两个同层概念用位置参数降低可读性，也阻碍未来兼容演进               |
| `markdown('./guide.md')`           | 丢失与 declaration module 绑定的静态 provenance                    |
| `config()` / `config(RedisConfig)` | owner可能聚合多段config，且Config与Page生命周期不同                |
| `snapshot(schema, { layout })`     | schema shape 已能唯一决定 text/summary/table，不需要布局旋钮       |
| `action({ handler })`              | 把 runtime closure 塞进 build-time declaration，破坏 artifact 边界 |
| `action('清空', handler)`          | 把 runtime closure 混入 declaration，且位置参数无法容纳 input      |
| `component('button', props)`       | 重新引入开放 renderer registry 与 arbitrary props                  |

反过来，也不为同一语义增加 alias：没有 `document()`、`section()`、`facts()`、`data()`、`table()`、`form()`、`button()` 或
`config()`。`snapshot()` 的 schema shape 决定只读 projection；`action()` 的 input schema 决定是否出现 form；Config 继续由宿主
owner resource 呈现。

### 5.2 作者 facade 单一，协议保持宿主中性

低认知成本优先于提前拆包。第一版作者只学习 `workbench.page/markdown/snapshot/action` 这一条 canonical path，不同时暴露
`@pluxel/page`、`@pluxel/document` 或 renderer adapter API。但 semantic lowering 必须把一个作者 declaration 拆成三个正交事实：

```ts
type StandardPageResourcePlanV1 = Readonly<{
	kind: 'standard-page-resource'
	document: PageDocumentPlan
	slots: readonly PageSlotPlan[]
}>

type StandardPageRuntimeBinding<Page> = Readonly<{
	read?: StandardPageRead<Page>
	watch?: StandardPageWatch
	actions?: ExactActionHandlers<Page>
}>

type WorkbenchPageMountPlan = Readonly<{
	kind: 'workbench-page-mount'
	resource: Readonly<{ key: string; revision: string }>
	placement: WorkbenchPlacement
}>
```

`workbench.page({ document, placement })` 只是把 resource declaration 与当前 Workbench mount 一次写完的 author convenience；resource
artifact 的 identity/digest 不包含 tab、route、icon、order 或 Shell chrome。placement 改变只更新 Workbench layout/mount，Markdown、
slot schema 或 action declaration 改变才更新 resource revision。Runtime binding 绑定当前 owner generation，但不进入 immutable
document artifact。

中性指的是 **protocol semantics**，不是提供可替换 renderer SPI：resource 只描述 portable document nodes、typed snapshot slots、typed
action slots、form plan、budgets 和 feedback/confirmation semantics，不出现 React component、Mantine props、CSS、toast、modal、Cap’n Web
stub 或 Workbench route。Workbench 是第一版唯一 mount/renderer/transport adapter，可以选择 toast还是inline feedback、modal还是其他
accessible transient surface；它不能改变 validation、danger confirmation、single-flight、draft 和 action result 语义。

Markdown 因此使用`:slot[key]`/`::slot[key]`，而不是把当前宿主名字编码进文档。若未来出现第二个真实 host consumer，应先复用同一
versioned resource/runtime protocol，再决定是否把 builders 提升到中性 package；现有 `workbench.*` facade 可以继续 re-export/lower，
不要求 Plugin 迁移。没有第二个 consumer 前不公开 renderer registry、host adapter 或第二套 builder alias。

### 5.3 面向 Coding Agent 的可发现性约束

API 是否低认知成本不能只靠示例短。Public types、JSDoc、diagnostics 和文档必须让 agent 从局部代码推出完整合法写法：

- 每个概念一个 builder、一个 canonical property name、一个默认行为；不提供 positional overload、boolean/string shorthand 与 alias；
- page 固定写成 `{ document, placement }`，Markdown 动态内容固定写在第三个 exact slot map；
- declaration key 与 runtime binding key一一对应，TypeScript 缺失/多余 key直接报错，不要求泛型、brand cast或辅助类型；
- `snapshot(schema)` 只读，`action({ input: schema })` 可写；schema 的 input/output方向在类型与诊断中明确；
- 省略 `form` 固定为 transient form，`form: 'embedded'` 固定为文档内表单；省略 `danger` 固定为无确认普通操作；
- build diagnostic 必须给文件、source range、slot key、期望kind和单一修复建议，例如“action slot只能使用root-level `::slot[key]`”；
- generated `.d.ts` 与 JSDoc 以最小button、带input action、snapshot/watch三个recipe开头，内部target/artifact类型不从author entry导出；
- 文档先解释“声明什么、handler做什么”，再解释RPC、安全和lifecycle；不能要求agent先读transport protocol才能生成按钮。

Agent fixture 是 Phase 0 gate：给一个只知道现有 Plugin/Config API 的 coding agent 三个任务——静态指南、状态+刷新、带两字段输入的
危险操作——生成结果必须无需类型断言通过build，并且不引入React/Mantine、`RpcTarget`、`provide()`或自定义browser code。若频繁产生
同一种错误，应优先改名、类型或diagnostic，而不是只补prompt/documentation。

## 6. Snapshot model：动态文本、summary 与 bounded read-only table

`workbench.snapshot(schema)` 只接受四种 top-level display shape：

| schema output                 | Protocol projection                         |
| ----------------------------- | ------------------------------------------- |
| one display leaf              | escaped text/code/number/status readout     |
| flat object of display leaves | description list / responsive facts summary |
| array of flat object rows     | read-only table                             |
| record of display leaves      | key/value table                             |

Display leaf 只允许 `string | finite number | boolean | null` 以及可安全投影的 literal/picklist。字段 title、description、number
format、picklist label、empty hint 等复用 `valibot-form` metadata；host adapter负责 locale、空值、窄屏、复制和语义 badge 的最终表现。
第一版拒绝 nested object/array cell、union row、tuple matrix、binary、Date、class instance、arbitrary rich cell 和 row action。

`snapshot()` 不接受完整 form presentation vocabulary。Output-plan compiler只读取 display-relevant subset：标准 title/description、
number format、picklist labels、string `code` hint 和 collection empty hint；`addable`、`removable`、placeholder、password control、
field grid、default item 等 edit-only metadata 在 snapshot schema 上 build fail，而不是被静默忽略。这样复用的是 schema metadata
基础设施，不是让 read-only data 假装成 disabled form。

Display schema 是 **output contract**，不是 browser input form。Toolchain 从静态 schema 产生 portable output plan；server 对每次
`read()` 的 raw return 执行该 schema，再验证 normalized output 仍是与 plan 相符的 portable JSON tree。会改变显示 shape 或产生
非 JSON output 的 transform build fail；无法静态证明的 custom transform 不进入第一版。这样类型、运行时 validation 与 browser
presentation 才是同一个契约，而不是拿 input form plan 猜 transform 后的形状。

Array table 必须同时受 row、column、cell text 和 serialized byte budget 限制；候选默认是 200 rows、16 columns、64 KiB/slot，
最终数值由 fixture measurement 决定。超限以 `page_snapshot_invalid` 拒绝整次 snapshot，不静默截断。排序、过滤、分页、选择、
editable cell、row action、virtualization 或持续追加一旦成为需求，就升级完整 View。

因此“表格”必须区分：

1. Markdown 中的 GFM table：静态说明内容；
2. Config/action Valibot form 中的 array/record renderer：bounded editable invocation/config input；
3. `snapshot(arraySchema)`：可实时刷新的 bounded read-only runtime table；
4. paginated/editable domain table：完整 View。

这四种语义不能因为视觉上都像 Table 就合并成一个万能 `table()` builder。

### 6.1 Markdown 与 snapshot 都是展示内容，但 provenance 不同

二者在页面角色上确实同属 content；分成两个 builder 不是因为一个“负责展示”、另一个“不负责展示”，而是因为它们跨越不同
信任与更新边界：

- `markdown()` 引用 build-time file，toolchain 一次编译成 immutable document plan；
- `snapshot()` 声明 runtime output schema，每次 `read()` 都把 Plugin 返回值当 `unknown` 校验后渲染；
- Markdown 中的 exact slot directive 负责把二者在inline scalar或block boundary交错。

动态说明文字不需要 runtime Markdown。单 leaf `snapshot()` 可以由`:slot[key]`嵌进普通paragraph，值始终按schema format
转义为text/code/number/status leaf；object/array/record由block slot显示summary/table。第一版不支持`{{value}}`模板、runtime Markdown
string、schema cell内Markdown、slot参数/nesting，因为那会引入模板作用域、runtime parser和另一套内容预算。需要动态rich text时
使用完整View，不能把scalar slot逐步升级成完整MDX。

```ts
document: workbench.markdown(import.meta.url, './connection.md', {
	current: workbench.snapshot(CurrentConnectionText),
	peers: workbench.snapshot(Peers),
})
```

```md
# 当前连接

当前连接：:slot[current]

如果连接不可用，请检查网络和已经应用的配置。

## 节点

::slot[peers]
```

### 6.2 实时更新使用 invalidate-only watch

Page controller 可以提供一个可选的 local watch：

```ts
type WorkbenchPageWatch = (
	invalidate: () => void,
	context: Readonly<{ signal: AbortSignal }>,
) => void | (() => void) | Disposable
```

它只表示“当前 snapshot 可能过期”，不携带 event name、payload、revision authority 或 mutation capability。Framework 在每次
open 建立一个 subscription，内部 target负责把普通local callback桥接成Cap’n Web observer，并复用`createRemoteValue()`已经
验证的顺序：先subscribe，再首次read；reading期间的多个invalidation合并成一个pending reread；late read不能覆盖更新sequence。

Subscription cleanup由framework持有：page close、socket loss、owner withdrawal、replacement和initial setup failure都会调用一次
幂等cleanup并abort signal。Plugin不处理`RpcStub.dup()`或transport result disposal，只返回普通unsubscribe/disposable。

Invalidation是edge-triggered hint，不保证一对一交付。Shell/runtime必须合并burst并施加bounded rate；Plugin若需要每个event、
有序payload、cursor replay或lossless delivery，就必须使用自己的领域`RpcTarget`。这使连接状态、计数和 bounded table 可以近实时
更新，又不会把Standard Page升级成通用event bus。

## 7. Action model

作者心智模型只有两件事：Markdown slot 所引用的 `action()` 声明一个宿主按钮/表单；publication 中同名的 `actions[key]` 是点击后
执行的 Plugin handler。最小按钮不需要理解 RPC protocol：

```ts
// declaration
refresh: workbench.action({ label: '刷新索引' })

// current generation binding
actions: {
	refresh: async ({ signal }) => {
		await this.index.refresh({ signal })
		return { ok: true, message: '索引已刷新' }
	},
}
```

key 出现两次是有意的静态/运行期边界：declaration 必须在 build time 生成 artifact，handler 必须在 runtime 捕获当前 Plugin instance。
把 handler closure 塞回 `action()`、自动调用同名 Plugin method 或用字符串 command bridge，都会隐藏 owner、authorization 和 HMR
边界。TypeScript/toolchain 应对两侧 key 做 exact 推导和校验，作者不写 RPC 类型或泛型。

Action 是无输入或由一个静态Valibot schema描述输入的bounded unary operation。Declaration：

```ts
type WorkbenchPageAction<InputSchema extends ObjectLikeSchema | undefined = undefined> = Readonly<{
	label: string
	input?: InputSchema
	form?: InputSchema extends undefined ? never : 'embedded'
	danger?: string
}>
```

这四个字段已经覆盖第一版真正不同的语义：`label` 是按钮名称，`input` 决定是否有 Valibot form，`form: 'embedded'` 只改变
dialog/文档内展开方式，`danger` 是危险操作的确认正文。普通说明写在 action 前后的 Markdown 中，不在 declaration 再复制一份
`description`；Shell 自己决定普通/主按钮层级，不让 Plugin 用 `intent: 'primary'` 编排视觉强调；第一版也不提供与危险操作无关的
通用 confirm 定制。

Binding handler：

```ts
type WorkbenchPageActionResult =
	void | Readonly<{ ok: true; message: string }> | Readonly<{ ok: false; message: string }>

type WorkbenchPageActionHandler<Action> = (
	context: Readonly<
		{ signal: AbortSignal } & (ActionHasInput<Action> extends true
			? { input: InferOutput<ActionInputSchema<Action>> }
			: {})
	>,
) => WorkbenchPageActionResult | Promise<WorkbenchPageActionResult>
```

规则：

- `void` 表示成功且不请求额外用户反馈；
- `{ ok: true, message }` 表示成功并显示运行期摘要，`message` 必填，避免与 `void` 重复；
- `{ ok: false, message }` 是可以直接向当前用户说明的预期领域失败；Standard Page 没有可编程 consumer，因此不要求作者再发明
  一个只供 presentation feedback 使用的 domain code；
- unexpected throw/reject 由 server 记录 owner-aware diagnostics，browser 只得到封闭 `action_failed`，不直接暴露任意
  stack、cause 或 secret-bearing message；
- 无 input action 的 browser request 不能携带额外args；有 input action 只能携带对应form的raw JSON value。Browser永远不能提交
  arbitrary method、schema、principal、config authority或handler option；
- server把raw input当`unknown`，使用declaration绑定的同一个schema做budget、validation、default和transform；只有成功的
  normalized output进入handler。Browser-side field constraints只是UX；
- validation failure使用封闭`action_input_invalid`并返回sanitized path/message issues，不返回raw value、Valibot issue object、
  function/cause或secret；
- 一个 opened page 同时最多执行一个 action。Shell 在 action settle 前禁用整组按钮；server 也以 `action_busy` 拒绝
  同 handle 的并发调用，不能只依赖 UI；
- 不同 page、session 或 principal 之间的领域互斥仍由 Plugin 自己实现，Workbench 不创建全局 lock；
- 成功或预期失败 settle 后，若 controller 有 `read()`，Shell 都重新读取 snapshot，使展示值收敛；
- action 没有 progress、stream、retry policy 或 platform timeout promise。需要这些语义时升级为直接 `RpcTarget`。

`danger` 是 host-neutral interaction semantic：adapter 必须在 invocation 前以 action `label` 和 `danger` 正文取得明确确认，并使用
destructive presentation；具体是modal还是其他accessible transient surface不进入resource protocol。Server无论是否显示确认都重新验证
action key并执行 Plugin自己的领域授权；确认不能替代 authorization、幂等或并发控制。

### 7.1 表单提交如何到达 Plugin

Action form 是一次有请求/结果语义的 RPC invocation，不是无确认的“通知事件”。完整链路固定为：

```text
static Valibot input schema
  -> build-time browser-safe form plan
  -> host-owned valibot-form renderer and local draft
  -> internal target invoke(exact action key, raw unknown input)
  -> server budget check + authoritative schema validation/default/transform
  -> current opened page controller action handler({ input: normalized output, signal })
  -> bounded ActionResult
  -> host feedback + optional snapshot reread
```

Plugin 作者不声明 `RpcTarget`、method name、transport DTO 或 `provide()`；framework 为当前 owner generation 的每次 page open 创建一个
fresh internal target，并把 exact action key 分派到 declaration 推导出的 handler。一个 page 共用一个 target，不为每个字段或按钮创建
RPC object。Schema implementation 留在 server graph；browser 只收到 portable form plan，不能发送 schema、handler option 或任意 method。

这与 Config form 的提交链不同：

```text
Config form -> Management mutation RPC -> validate -> persist -> configs.onUpdate() -> applied field replacement
Action form -> opened page internal RPC -> validate -> action handler -> result
```

前者修改持久化 desired state，允许 Plugin stopped 时提交；后者执行当前 generation 上的一次 operation，page/owner withdrawal 后不可调用。
因此二者应共享底层 `FormPresentationPlanV1` 和 host renderer，而不共享 endpoint、revision、draft 或 commit result。Config-specific
defaults/sections 与 Action-specific label/danger 应分别包在共享 field plan 外，避免为了复用 UI 把 Config DTO 直接冒充 Action DTO。

静态 schema 可以表达 `valibot-form` 已支持的 object、array、record、union 和依赖字段展示；array/record 可投影为 bounded editable
table。运行时只能改变 snapshot values，不能通过 RPC 更换 form schema、字段集合或远端动态 choices。后者需要
runtime form protocol、cache/revision 与兼容规则，第一版应升级完整 View，而不是让 `input` 偷偷从 static schema 变成 callback。

### 7.2 Vault secret 表单的能力与启动边界

“给运行中的 Plugin 填一个 Redis password并写入自己的Vault”落在Standard Page边界内，不需要完整View。Password是action的一次性
input，不是Config或snapshot：

```ts
const RedisPasswordInput = v.object({
	password: v.pipe(
		v.string(),
		v.minLength(1),
		v.maxLength(1_024),
		formMeta({ title: 'Redis 密码' }),
		stringMeta({ control: 'password' }),
	),
})

password: workbench.action({
	label: '保存 Redis 密码',
	input: RedisPasswordInput,
	form: 'embedded',
	danger: '这会覆盖当前保存的 Redis 密码。',
})
```

Runtime binding直接使用当前owner的Vault namespace：

```ts
overview: ({ principal }) => ({
	actions: {
		password: async ({ input }) => {
			if (!this.canManage(principal)) {
				return { ok: false, message: '当前用户不能修改 Redis 凭据' }
			}

			const vault = this.ctx.vault
			if (!vault) return { ok: false, message: '宿主没有启用 Vault' }

			await vault.kv().set('redis.password', input.password)
			await vault.flush()
			return { ok: true, message: 'Redis 密码已安全保存' }
		},
	},
})
```

这条路径必须满足：password control不回显；draft只存在当前page memory；raw input、validation issue、diagnostic、result、snapshot和日志均不
包含secret；server重新做principal authorization；Vault写入和关键`flush()`完成后才返回成功；页面最多只显示`configured: boolean`之类
状态，绝不读取secret回browser。JavaScript string无法承诺主动清零，因此协议只能缩短引用生命周期、禁止复制/记录并在settle/close后
丢弃draft，不能宣称secure memory zeroization。

但这不解决 **首次启动引导**：Standard Page属于running generation publication。如果Redis provider因缺少password或连接失败而init失败，
它自己的Page和action handler都不存在。把provider伪装成running-but-unready只为显示表单，会污染capability readiness和dependent startup；
保留withdrawn page又会破坏owner lifecycle。此时只能选择一个诚实authority：

1. 部署/host在Plugin启动前预置同一Vault credential；
2. 一个独立、可运行的credential owner通过明确shared namespace contract写入，再启动Redis provider；
3. 未来单独设计host-owned Credential resource，像Config一样在Plugin stopped/failed时可用；browser只获得write/status surface，Plugin
   generation只获得server-side secret accessor，不注入长期plaintext field。

第三种若成为高频需求，应独立评审`credentials.use()`一类declaration、owner/path identity、Vault absence、create/rotate/delete、configured
status、authorization、audit、flush和generation apply/restart语义；不能用`workbench.secret()`或特殊action绕过这些authority问题。

Vault保存成功也不等于Redis连接已经采用新密码。当前默认`RedisPlugin`明确只支持credential-free standalone URL，且不读取Vault；要使用
上述form，必须由另一个Redis implementation定义Vault key contract和apply策略。Handler可以在领域实现支持时显式重连，也可以只保存并
要求restart，但必须返回真实状态，不能把“saved”误报成“connected”。

## 8. Page controller 与 publication typing

Framework 从 declaration 推导 exact controller：

```ts
type PageReadBinding<Page> =
	PageHasSnapshots<Page> extends true
		? { read: WorkbenchPageRead<Page>; watch?: WorkbenchPageWatch }
		: { read?: never; watch?: never }

type PageActionBinding<Page> =
	PageHasActions<Page> extends true ? { actions: ExactActionHandlers<Page> } : { actions?: never }

type WorkbenchPageController<Page> = Readonly<PageReadBinding<Page> & PageActionBinding<Page>>
```

实际类型应使用 conditional mapped properties 达到以下作者体验：

- 声明 snapshot 时 `read` 必须存在，且 snapshot slot keys/schema output types exact；
- 没有 snapshot 时不允许多余 `read`/`watch`；
- `watch` 始终可选，但只有存在 `read` 时才合法；framework不允许一个永远无法重建snapshot的invalidation source；
- 声明 actions 时 `actions` 必须存在，handler keys exact；
- input schema决定对应handler是否有exact typed `input`，不能用一个`unknown`万能handler绕开validation；
- 没有 actions 时不允许多余 `actions`；
- 没有任何slot的纯Markdown page不需要binding；
- slot 的任意合法组合只保留所需 controller 成员。

`read()` 直接返回 exact snapshot key map，不再包一层无意义的 `{ values }`：

```ts
type WorkbenchPageSnapshot<Page> = Readonly<ExactSnapshotValues<Page>>
```

第一版不把动态 action availability 塞进 `read()`。它既不是 authorization，又会引入易过期的 disabled/TOCTOU 状态和第二种
snapshot payload。按钮保持可调用，handler重新检查真正不变量，并以 `{ ok: false, message }` 说明当前为何不能执行；Markdown 或相邻
snapshot 可以提前解释条件。只有真实用例证明“频繁点击后失败”明显损害体验时，再单独评审一个只影响表现的 availability contract。
Runtime 对 JavaScript caller 仍执行 snapshot exact-key validation。

`WorkbenchBindings<Definition>` 从 bindings object 中排除没有任何slot的纯Markdown page key。于是：

```ts
ctx.workbench?.publish(StaticOnlyDefinition)
ctx.workbench?.publish(MixedDefinition, {
	customView: () => new CustomTarget(),
	statusPage: () => ({ ... }),
	// staticGuide 不出现在 bindings 中
})
```

只有 required binding key 集合为空时，`publish(definition)` overload 才合法。Runtime 仍检查 definition 与 bindings exact，
避免 TypeScript bypass、JavaScript caller 或伪造对象造成部分 publication。

## 9. 固定渲染与配置边界

Standard Page 的布局不是作者可编排 component tree。Shell 顺序渲染 compiler 已验证的 document plan：

```text
page scroll container
  Markdown nodes
  snapshot slot → text / summary / read-only table
  action slot → button / embedded form
  Markdown nodes
dialog action form（非 embedded action 被点击时临时出现）
```

窄屏、spacing、cards、button grouping、summary columns、focus、keyboard、loading skeleton、confirm modal、toast、dark mode、
locale 和 accessibility 全部由 Shell 拥有。作者不能指定栅格、颜色、CSS class、Mantine props、responsive breakpoint 或
任意 nesting。

有 `read()` 的 page 在 activation 时读取一次；Shell 提供统一的 manual refresh，action settle 后再读取一次。Controller声明
`watch`时，每次invalidation也触发coalesced reread。切换tab、窗口focus、固定interval或网络恢复都不会隐式poll。一次open
只保留最新read sequence，late result不能覆盖更新snapshot。需要payload stream、lossless events或自定义poll policy时使用完整View。

### 9.1 为什么没有 `config()` block

“一个 Plugin 有很多 configs”需要区分 declaration 与 persistence owner：具体 Plugin root 和每个 direct `PluginPart` subclass
都可以各自声明一次 `configs.use(ObjectSchema)`，因此作者看到的是多个 config sections；Core/Runtime 会把它们组合成同一个
Plugin node owner 的 composite record、revision、validation、persistence 和 apply transaction。Standard Page 的 slot key 无法
诚实表示“全部 composite config”“某个 Part declaration”还是“某个 occurrence path”，加入 selector 只会复制 Config domain identity。

生命周期也不相同：Config resource 属于 host control plane，Plugin stopped、启动失败或尚未 publication 时仍必须可编辑；Standard
Page 只在 running generation publication 存在时可打开。把前者嵌进后者会额外制造移动 draft、隐藏/恢复 Config tab、重复
placement 和 route page 多实例规则，却没有增加新的业务能力。

因此 Config 保持 Shell workspace 中独立、常驻的 owner resource，Standard Page 不声明它的位置。Shell 可以把 Config 与 Page
显示为同一 Plugin detail 下的 sibling section/tab，但这属于固定 host composition，不是 Plugin API。配置字段附近的短说明继续写在
schema `title`、`description`、`help`、section metadata 中；需要任意 Markdown 穿插配置字段或读取未保存 draft 的产品，使用完整 View
或未来单独评审一个 Config-specific composition contract。

Standard Page action 只使用 framework-confirmed applied config。若需要测试临时 endpoint/timeout，应把它们显式声明为 action
`input`；这份 invocation draft 不读取、覆盖或保存 Config draft，并遵循成功重置、失败保留、关闭丢弃的统一规则。

### 9.2 为什么不使用 `configs.use(ValibotSchema | WorkbenchPage)`

这个union会把两个不同authority放进同一个Core facade：

- Valibot config schema定义持久化输入、default、validation、revision和generation apply；
- Workbench Page定义可选host上的placement、browser presentation、read/watch和principal-bound RPC operation。

`configs.use()`当前返回注入到Plugin field的deep-frozen config snapshot；传入Page后无法诚实定义它应该返回config、controller、
publication handle还是UI state。它还会迫使`@pluxel/core`依赖Runtime Workbench类型，使PluginPart config、headless host和optional
capability边界一起承担UI contract。

应统一的是schema presentation pipeline，而不是authority入口。Config form与action input可以共同复用一个从Valibot schema投影
browser-safe field plan的internal compiler：

```text
Valibot object schema
  -> shared form presentation plan
  -> Shell-owned valibot-form renderer
  -> raw unknown submitted to the owning server authority
       config: coordinator validate -> persist -> notify/apply
       action: action schema validate -> normalized input -> handler
```

Shell可以把Config resource、Standard Page和action form呈现为同一workspace中的一致产品，但RPC提交目标和
commit语义保持分开。这样得到统一体验，不需要一个`Schema | Page`联合类型。

Config **value**本来就可以在runtime由Management mutation更新：保存后通过`configs.onUpdate(this.config, listener)`通知当前
generation，全部listener确认后framework替换config field snapshot。Config **schema**必须保持build-time/static candidate fact；
让Plugin按运行状态更换schema会破坏persisted record validation、defaults、presentation revision、HMR identity和旧值兼容。

如果Plugin自己观察到会频繁变化的effective state，例如连接是否可用、实际endpoint、远端capability或当前队列长度，那是snapshot，
应通过`read + watch(invalidate)`投影；若它需要成为持久化desired config，则必须走Config coordinator mutation，而不能原地修改
`this.config`或借Workbench绕过flush/apply链。

## 10. Markdown 与内容安全

### 10.1 Source declaration

```ts
workbench.markdown(import.meta.url, './guide.md', {
	status: workbench.snapshot(Status),
})
```

和 `workbench.entry()` 一样，路径必须是相对当前 declaration module 的 literal。第一版：

- 每页恰好一个 Markdown document source；无动态slot时第三个参数省略；
- 不接受 inline source、absolute path、URL、runtime string 或 filesystem lookup；
- 不解析 frontmatter 作为 placement/title/config；这些事实已有唯一 declaration authority；
- 只额外识别`:slot[key]` inline scalar和standalone `::slot[key]` block directive；不允许其他directive、参数、nesting或
  Plugin-provided AST transform；
- 不允许 MDX、ESM、JS expression、import/export、JSX component 或 `{expression}`；
- raw HTML 无条件 build fail，而不是原样输出或在 browser 再猜测安全性。

Directive不是parse前的字符串替换。Compiler使用带position的封闭Markdown extension产生inline/block slot node，再核对AST parent、
slot kind和exact map；因此code fence/span中的示例不会执行，link/list/quote/table中的directive也不能绕过位置限制。Parser候选若不能
保真支持这两个node，就不能被采用，不能用全局regex替换补洞。需要展示字面directive时使用inline/fenced code。Slot不接收Markdown
attributes、children或runtime value。

正文、schema field label、action 文案和领域 result message 沿用当前 Plugin-owned label 策略，第一版不新增 locale resource、
translation key 或 content negotiation。Shell 只负责其自有 chrome 和 number/time/boolean 格式的本地化。需要多语言 Plugin
正文时，应先形成统一的 Workbench locale resource contract，而不是让 `markdown()` 临时接受一组路径或从文件名猜 locale。

### 10.2 Portable document plan

Builder 不把 HTML 交给 browser。Build-time compiler 产生 versioned、deep-validated portable document plan，候选 node 集合：

- paragraph、heading、text、emphasis、strong、delete；
- ordered/unordered list 与 list item；
- blockquote、thematic break；
- inline code、fenced code；
- safe link；
- bounded table；
- module-relative raster image；
- exact inline-snapshot/block-snapshot/action slot leaf。

不包含 raw HTML、style、class、id override、iframe、video、audio、form、script、SVG、data URI 或 event handler。Heading id
由 compiler 确定性生成并处理重复；Shell 用这些 heading facts 构建 outline，不执行 Plugin JavaScript。

External link 只允许明确 scheme（第一版 `https:`、`mailto:`），Shell 添加安全的 target/rel policy。Fragment link 只能指向
当前 document heading。第一版拒绝其他相对 Markdown document link，避免隐式建立第二套路由和多页内容 graph。

相对 raster image 由 toolchain 收集进同一 immutable content artifact，校验 MIME、扩展名、尺寸、单文件和总字节预算；
第一版拒绝 SVG，因为其脚本、外部引用与 active content policy需要独立审计。Alt text 必须存在。Remote image URL 不进入
第一版，避免隐私泄漏、mixed content、CSP 和不确定 availability。

### 10.3 Satteri 的位置

[Sätteri](https://github.com/bruits/satteri) 可以作为 build-time Markdown parser 候选，因为它提供 Markdown → MDAST/HAST、
Rust implementation 和 Vite integration。但它不是 Standard Page protocol，也不能成为 Plugin runtime dependency：

- Satteri 的 HTML output 不是 Pluxel 的安全 authority；其 raw HTML 路径可以重新输出 source HTML；
- 完整MDX是可执行module，直接违反Standard Page的host-rendered边界；slot directives是Pluxel document-plan node，
  不依赖MDX component机制；
- browser WASM、N-API binary 与 parser plugin API都不应进入 Standard Page browser/runtime contract；
- 小型 Plugin 文档的主要收益是统一作者体验和零 producer，不是 parse benchmark。

采纳前应以同一 fixture suite 比较 Satteri 与其他 parser。选择条件是 CommonMark/GFM correctness、position diagnostics、
raw HTML detection、AST fidelity、license、支持平台和 toolchain integration；性能只有在可重复 build benchmark 中才是决定因素。
Parser 必须被封装在 Rolldown/toolchain private compiler seam 后面，公开 API不导出 Satteri AST 或 option。

## 11. Runtime protocol

### 11.1 Metadata

Semantic lowering 分别产生宿主中性的 resource metadata 和 Workbench mount metadata：

```ts
type StandardPageResourceMetadataV1 = Readonly<{
	version: 1
	kind: 'standard-page-resource'
	key: string
	document: PageDocumentPlan
	slots: readonly PageSlotPlan[]
}>

type WorkbenchPageMountMetadataV1 = Readonly<{
	version: 1
	kind: 'standard-page-mount'
	key: string
	placement: WorkbenchPlacement
	resource: Readonly<{ key: string; revision: string }>
}>
```

两者都是 internal versioned protocol，不作为 Plugin author export。Content artifact承载resource metadata；Workbench layout只承载mount
和pinned resource reference。Unknown version/kind 在build、server load或host activation阶段fail-fast，不能忽略部分node后继续显示一个
语义残缺的页面。其他host未来可以定义自己的mount metadata，但不能改写resource plan或复用Workbench placement。

### 11.2 Layout 与 activation

Layout 继续是 capability-free snapshot。Openable presentation 变成封闭联合：

```ts
type WorkbenchOpenablePresentation =
	| { kind: 'federated-view' /* existing pinned MF facts */ }
	| { kind: 'standard-page'; artifact: PageArtifactReference }
```

不新建平行 `openPage()` session API；现有 `openView()` 继续打开 layout 中的一个 openable。Standard Page activation：

```text
current layout entry
  -> openView(expected layout revision)
  -> fresh owner lease + optional internal page target
  -> load/validate pinned page/document/form plans
  -> create Shell-owned page instance
  -> subscribe first when controller exposes watch()
  -> initial read when controller exposes read()
  -> render in existing Shell React tree
```

Standard Page 没有 MF registration、Bridge expose、remote React root 或 Plugin Provider。关闭顺序是 Shell page instance
cleanup → opened handle dispose；owner withdrawal、session epoch invalidation 和 route mismatch 继续使用当前语义。

没有任何slot的纯Markdown page仍调用`openView()`取得owner generation lease。这样页面不会在publication withdrawal后作为无owner的陈旧
内容继续存活，也不为静态文档创建特殊 lifecycle。

### 11.3 Internal target

Framework 为 controller 创建 fresh internal `RpcTarget`，只暴露固定方法：

```ts
interface StandardPageTarget extends RpcTarget {
	read(): Promise<unknown>
	watch(invalidate: () => void): RpcTarget
	invoke(actionKey: string, rawInput?: unknown): Promise<unknown>
}
```

这不是作者 API。没有 `watch` 的 controller 调用该方法返回稳定 unsupported failure，而不是安装空 subscription。Server 在调用
controller 前后验证 key、input、result、quota、generation gate 和 signal；browser client 再验证 DTO，不能信任 transport 已经
保证 shape。只有无slot的纯Markdown page可以没有target root，但opened handle和owner lease仍存在。

## 12. 构建、产物与 HMR

### 12.1 Content artifact

Page plan 与 Markdown assets进入独立 immutable Workbench content artifact，而不是伪造 MF producer。Artifact 至少包含：

- versioned page plan JSON；
- portable Markdown node plan；
- Valibot snapshot schema 的 browser-safe output presentation plans；
- action input 的 browser-safe form presentation plans；
- relative raster assets；
- 每个 regular file 的 digest inventory；
- declaration/content/compiler revision。

Layout 只携带 pinned artifact reference 和 digest，不内嵌可能较大的文档 tree。Shell 通过现有 Workbench HTTP static path加载
artifact；server 只服务冻结 inventory 中的文件。路径、命名和 compiler revision是 internal build contract，不进入作者 identity。

只有 Standard Pages 的 Plugin：

- 不产生 `mf-manifest.json`、remote entry、Bridge expose 或 dynamic types；
- 不需要从 Plugin root 解析 React、ReactDOM、Mantine 或 Bridge shared；
- 仍可在 `variant: 'workbench'` distribution 中得到 content artifact；
- headless variant 不生成或加载 browser content closure。

Mixed definition 只为真实 View/Attachment renderers构建现有 MF producer；Standard Page artifact 不进入 producer JS graph。
Semantic lowering必须把snapshot/action schema投影成portable plan，producer/client graph不能执行Valibot schema或因为Standard Page
而保留schema implementation。若mixed definition无法做到这一点，schema-backed action阶段必须延后，不能接受隐藏bundle成本。

### 12.2 Development

Markdown、slot directive位置、slot declaration 或 relative asset 改变时，compiler 先构建并验证完整 resource candidate。移动 directive
只改变document plan中的展示位置，不改变slot identity，但仍产生新的resource revision。缺失、重复、未知或kind不匹配的slot candidate
失败并保留当前committed resource artifact；成功后提交新revision，并沿现有Workbench inventory/session invalidation触发完整document
reload。第一版不做页内 Markdown hot swap，以保持 producer update 与 page update 同一种 epoch 语义。

只有`placement`改变时不重建resource artifact；toolchain验证并提交新的Workbench mount/layout candidate，resource reference保持原revision。
若同一source edit同时改变resource和placement，两个candidate必须作为一次definition update共同成功或共同保留last committed state，不能让
layout指向尚未提交的resource。

Server-only handler实现改变继续走 Plugin HMR replacement和 generation publication。Page plan没变也不能把新 generation target接到
旧 opened handle；owner withdrawal使旧 handle失效。

### 12.3 Budgets

具体数值应由 fixture 和 distribution measurement确认，第一版至少必须有以下独立上界：

- Markdown source bytes、portable nodes、tree depth；
- heading/table row/table cell数量；
- code block和单 text node长度；
- raster image count、decoded dimensions、单文件和总文件 bytes；
- document node/slot/snapshot row/snapshot column/action/form field count和snapshot/input/result serialized bytes；
- opened page count继续计入现有每 session openable quota。

Budget violation在 build或RPC边界使用稳定诊断，不截断内容后假装成功。

## 13. Lifecycle、权限与失败

- `publish()` 仍从 current Plugin Context取得 owner，注册进入 generation effects。
- PluginPart 仍不能 publish；owning Plugin聚合 Standard Page。
- Page factory只在 open时运行，每次 open返回新的普通 controller，framework每次创建新的 internal target。
- Factory获得 current authenticated principal、server-matched params和page lifetime signal。
- Read/watch setup/action都进入 owner invocation admission；withdrawal关闭新调用、abort signal并等待已接纳调用退出。
- Framework持有watch cleanup和observer transport；Plugin controller不取得raw `RpcStub`。
- Handler必须自己做领域 authorization；declaration中的按钮可见性不是权限边界。
- Static Markdown不能包含 secret；snapshot values和result同样是browser-visible DTO。
- `read()`失败显示page-local retry state，不使Plugin停止，也不自动 reconnect或创建global cache。
- Action expected failure保持page可用；unexpected failure显示generic error并允许用户显式重试。
- Session epoch失效仍要求full reload，不为Standard Page增加局部 reconnect。

第一版 Page 仍是 generation publication，不是 package-level 离线文档：Plugin stopped、启动失败或 publication withdrawn 后，静态
Markdown 也不继续出现在 layout。保留旧 artifact 会让撤回语义、owner visibility 与页面 topology 分裂；自动从已安装 package 暴露
文档又需要独立的 package inventory、权限和升级生命周期。若真实需求是“Plugin 未运行时仍可查看安装/恢复文档”，应单独设计
host-owned package documentation resource，而不能让 Standard Page 暗中跨越 generation lifetime。

候选稳定 framework failure codes：

- `page_artifact_unavailable`
- `page_plan_invalid`
- `page_snapshot_invalid`
- `page_subscription_failed`
- `page_action_unknown`
- `page_action_input_invalid`
- `page_action_busy`
- `page_action_failed`
- 复用现有 target/layout/generation changed与quota codes

是否把这些 codes暴露到 public client contract应在实现时与现有 Workbench result union统一，不能创建只靠 Error message分类的
平行失败协议。

## 14. Package 与依赖边界

- `@pluxel/runtime/workbench`：新增唯一author facade、brands和author types；builder lowering产出中性resource plan，不依赖React、Mantine或
  Markdown parser。
- `@pluxel/runtime` server：page controller binding、input validation、internal target和registry/open logic。
- `@pluxel/core`：不新增能力；config、generation、effects和owner语义不变。
- `@pluxel/rolldown`：semantic lowering、Markdown private compiler和content artifact builder。
- `@pluxel/workbench-app`：唯一Standard Page renderer，复用Shell theme、valibot-form plan renderer、config state提示、outline和feedback。
- Markdown parser若采用Satteri，只属于build-time implementation dependency，不出现在Plugin package/runtime/browser exports。

不新建`@pluxel/workbench-components` package。当前没有第二个renderer consumer，也没有证据需要独立versioned component library；
过早拆包只会把Shell private presentation误升格为public styling API。

中性resource/runtime DTO应位于runtime/toolchain共享的private versioned protocol seam，而不是`workbench-app` component目录。第二个host
出现前它保持internal；出现后是否提升为public transport package必须单独评审versioning、conformance和security，不因“中性”二字自动
承诺第三方renderer兼容性。

## 15. 与现有设计原则的核对

### 15.1 Plugin作者模型

- required dependency仍只在constructor；Standard Page不建立业务依赖。
- 同一语义只有`page()`一个新入口，不同时提供`document()`、`panel()`等alias。
- Page builder是固定declaration，不是runtime service locator或raw Context helper。

### 15.2 能力所有权

- Plugin拥有snapshot source、watch source、actions、schema和领域授权；Shell拥有表现与interaction chrome。
- Config authority仍是Core/Runtime Management链，Standard Page不保存config。
- Workbench仍只通过`ctx.workbench?.publish()`发布，未增加Plugin可安装capability。

### 15.3 Disabled成本

- Workbench disabled时Context没有property，不创建registry/session/content route。
- `?.publish()`短路binding object构造。
- headless build不进入content artifact branch；workbench build包含artifact不等于startup安装capability。

### 15.4 Context与生命周期

- Controller由owner Context publication创建，internal target不通过mutable current Context识别caller。
- read/watch/action使用current generation gate和effects；replacement不复用旧controller。
- 没有第二套cleanup lifecycle，page lifetime signal与opened handle沿现有withdrawal路径清理。

### 15.5 工具链

- declaration在TypeScript擦除前lower；raw runtime不反射源码或fallback猜metadata。
- Vite/production共用semantic pass和diagnostics。
- UI内容不会进入server bundle，server implementation不会进入content/browser graph。

## 16. 现实用例审查

| 用例                                 | Standard Page是否足够    | 原因                                                   |
| ------------------------------------ | ------------------------ | ------------------------------------------------------ |
| 运行中Plugin的使用说明/故障排查      | 是，Markdown-only        | 零binding、零producer；仍随generation publication存在  |
| Plugin停止或启动失败时的离线文档     | 否                       | 需要package-level host文档资源，不应保留撤回后的Page   |
| Redis config + endpoint + 测试连接   | 是                       | Config由宿主独立呈现；Page读取applied data并执行action |
| Cache数量 + 清空/重建                | 是                       | live snapshot、bounded actions、`danger`确认           |
| 小型节点状态表                       | 是，若有明确row budget   | `snapshot(arraySchema)` + invalidate/reread            |
| Scanner最后运行时间 + 重新扫描       | 是，若扫描短且无progress | watch只触发重读；长扫描应升级task/full View            |
| 单个参数化job状态 + retry            | 是                       | server-matched params + bounded snapshot/action        |
| 一次probe需要timeout/namespace       | 是                       | 静态Valibot input + host-owned action form             |
| 运行中Plugin写入/轮换自己的Vault密码 | 是                       | password action input；server授权、Vault写入和flush    |
| 缺少密码导致Plugin启动失败后的引导   | 否                       | Page尚未publication；需预置或host-owned Credential资源 |
| Auth password/TOTP setup             | 否                       | 多步secret input和enrollment state                     |
| Wretch持久化per-consumer headers     | 否                       | 长生命周期rows和跨Plugin Attachment                    |
| Fonts上传/分页表格/选择              | 否                       | binary input、collection和复杂mutation                 |
| Package manager                      | 否                       | list、progress、并发mutation和丰富状态                 |
| 实时日志、metrics chart              | 否                       | payload stream和自定义visualization                    |
| 直接读取Config tab未保存draft测试    | 否                       | action可有自己的input，但不取得另一表单的隐式draft     |
| 跨Plugin复用provider UI              | 否                       | 继续使用Attachment，不能把page变成隐式dependency       |

这个矩阵是第一版的scope test。若实现需要为了后六类用例增加runtime schema、unbounded collection、payload stream、progress、renderer
registry或consumer root，说明设计已经越界，应停止扩张并保留完整View。

## 17. 被否决的替代方案

### 17.1 “简单组件也是Pluxel Plugin”

Button、Card、Markdown renderer没有独立配置、lifecycle、dependency governance或failure boundary，不应成为Plugin node。
这样做会污染catalog、启动顺序、HMR replacement和package identity，同时让UI primitive错误获得server capability地位。

### 17.2 第三方component registry

`registerRenderer('button', ...)`需要解决version negotiation、theme、SSR/browser code、ownership、CSP、cleanup、unknown props和
artifact delivery。它等价于重新发明Module Federation，却缺少现有Bridge的清晰边界。第一版采用Shell-owned closed union。

### 17.3 任意JSON UI tree

任意nesting、conditions、binding expressions和props最终会形成低质量模板语言；复杂交互仍需要escape hatch，而简单交互反而承担
schema/version成本。Markdown document + exact leaf slots 已经是保持写作体验、accessibility、responsive和兼容性的最大必要自由度。

### 17.4 MDX作为简单页面

完整MDX能import/export、执行expression并实例化任意component，本质是Plugin frontend application。它不会消除
React/MF/Provider/runtime API，只是把边界隐藏在文档语法中，并扩大trusted code与build graph。Standard Page只借用“文档中有
插槽”的写作体验：Markdown只能写scalar `:slot[key]`或block `::slot[key]`，key必须exact匹配TypeScript slot map；
没有props、children、expression、condition、loop或component import。需要这些能力时完整View是更诚实的入口。

### 17.5 Action直接调用command name

Commands是独立runtime capability和carrier-neutral catalog。用字符串把browser按钮连到command会绕开direct owner API、输入/输出
契约和authorization，并让命令重命名变成UI runtime failure。Standard Page handler可以在server内部调用普通领域函数；不新增
command bridge。

### 17.6 自动从public methods生成按钮

Method signature不包含安全展示、principal authorization、危险确认、stable failure、budget和是否适合browser的信息。显式action declaration
是必要的兼容与安全承诺。

### 17.7 把config fields复制进page schema

这会产生第二份default、validation、draft、persistence和apply authority。即使只放置宿主resource，也会混合Config与Page生命周期；
因此Standard Page完全不提供config block。

## 18. 实施阶段与验收gate

### Phase 0：fixture与协议验证

在创建public export前，用internal fixtures证明：

- 无slots document、snapshot-only slots、action-only slots和任意slot组合都能使用一个controller模型；
- 一个Markdown中的snapshot summary → embedded form → read-only table fixture不需要Plugin renderer；
- 三个coding-agent fixture无需泛型、类型断言或自定义browser/RPC代码即可一次通过declaration与binding exact检查；
- resource artifact不包含Workbench placement/route/Shell/Mantine/Cap’n Web facts，单独改变placement不改变resource digest；
- static/dynamic Vite与production lowering产生相同metadata；
- page-only Plugin确实不生成MF producer或解析React/Mantine peer；
- resource或mount candidate失败保留last committed definition state；
- config dirty/applied/saved-not-applied提示不会改变config authority。

若page-only build仍必须走完整MF producer，核心收益未成立，提案应暂停。

### Phase 1：Markdown-only

- 实现`page()` + `markdown()`、content artifact与Shell renderer；
- 保持显式`publish(definition)`和owner lease；
- 完成raw HTML/MDX/URL/image/budget安全测试；
- 覆盖headless和Workbench disabled。

这个阶段可以独立交付，并验证文档能力是否真的被Plugin采用。

### Phase 2：snapshot text、summary 与只读表格

- 实现`snapshot()`、portable output plan、conditional binding typing、internal target read/watch和runtime validation；
- Shell提供loading/error/retry/manual refresh，并复用subscribe-first/invalidation coalescing；
- 覆盖summary、record、array table、principal/params、watch cleanup、burst invalidation、withdrawal、stale result和snapshot budget。

### Phase 3：无input actions

- 实现`action()`、exact handlers、`danger`确认、single-flight、result union和post-action refresh；
- 覆盖authorization、预期领域失败、unexpected throw、close/withdrawal和concurrent invocation；
- 至少迁移一个真实“状态 + 按钮”workspace Plugin fixture验证删除的代码量。

### Phase 4：Valibot input actions

- 抽取Config与action共用的schema → browser-safe form presentation compiler，不复制field DTO语义；
- 实现action input plan、Shell dialog/embedded form、server authoritative validation/default/transform和typed handler；
- 验证password/secret不进入日志、issue/result，raw input与normalized output都有独立budget；
- 用运行中Plugin的password action → owner Vault → flush fixture验证write-only行为，并证明启动失败时Page不会被错误保留作credential入口；
- 证明page-only和mixed definition都不会把Valibot schema implementation带进Plugin browser producer。

每一阶段都是新增user-visible public package行为，实际实施时必须更新`docs/`、相关工程文档、public exports和测试，并添加
pending `.tegami/*.md`；本research proposal本身不需要changelog。

## 19. 验证矩阵

### Declaration/toolchain

- exact page keys、entry/slot/snapshot/action key和reserved names；
- direct literal限制、slot map spread/computed/alias diagnostics；
- page恰好一个document；slot exact matching/count与`danger`正文budget；
- snapshot schema provenance、portable output subset、row/column/cell/byte budgets；
- action input schema provenance、static identity、supported object shape与field budget；
- UI source反向依赖边界；Markdown path/package root escape；
- Vite/prod metadata与artifact revision一致。

### Markdown/security

- raw inline/block HTML、MDX expression/ESM、javascript/data URL；
- unknown/missing/duplicate slot，inline/block slot kind mismatch，directive参数/nesting，以及heading/link/list/table/quote/code中的非法directive；
- inline snapshot directive只能引用one-leaf schema，action只能使用root-level block directive；
- parser extension产生保真的source position和稳定diagnostic range；code span/fence中的字面directive不被regex预处理误识别；
- malformed links、duplicate headings、deep lists、oversized table/code/image；
- symlink/path traversal、MIME spoof、SVG/polyglot image；
- plan JSON prototype keys、unknown version/node和browser double validation。

### Runtime/lifecycle

- Markdown-only page open也持有owner lease；
- factory per-open fresh，principal/params/signal正确；
- read/watch/action进入invocation admission；
- watch setup failure、observer failure和returned cleanup只settle一次；
- close、socket loss、replacement、rollback、shutdown abort并drain；
- publication变化使epoch失效，不把新controller接给旧page。

### Interaction

- subscribe-first、initial read、invalidation coalescing、retry、manual refresh、stale read guard；
- exact snapshot keys、schema output、text/summary/table projection和budget validation；
- handler重新检查真实执行条件、预期领域失败与unknown action；
- `danger`确认cancel不调用server，确认文案与destructive presentation固定；
- one-action single-flight在client/server同时成立；
- expected result与unexpected rejection不泄漏secret；
- action form plan与server schema一致，unknown input先budget再validation，sanitized issues不含raw value；
- password draft不进入artifact、snapshot、result、URL或日志；Vault flush失败不得返回成功，browser永不读取secret；
- action成功重置draft，validation/domain/unexpected failure保留draft，cancel/close/epoch change丢弃；
- action settle后read刷新，late result不覆盖closed/new page。

### Delivery

- page-only distribution没有Plugin MF producer；
- mixed definition只构建真实renderer exposes；
- artifact inventory/digest/path不可绕过；
- 移动slot directive产生新content revision但不改变slot identity；dev exact-match失败保留current，成功full reload；
- placement-only change更新mount/layout但保持resource digest；resource+mount同次修改原子提交；
- headless graph不解析page compiler/backend/browser renderer。

## 20. 采纳与否决条件

同时满足以下条件才应采纳：

1. 至少三个真实Plugin需求落在Markdown document/typed slots/snapshot/watch/actions边界，且动态表格保持bounded、read-only；
2. 一个状态+按钮页面相对完整View显著减少author files、dependencies和lifecycle代码；
3. page-only Plugin不产生Plugin-owned browser JS producer；
4. config draft/applied语义在UX测试中无歧义；
5. Markdown plan有完整security/budget测试，browser不接收raw HTML；
6. static/dynamic、dev/prod、replacement/withdrawal和disabled测试全部通过；
7. public类型可以对snapshot/actions/schema output/bindings保持exact而不要求作者写泛型或类型断言；
8. resource artifact与runtime semantics不包含Workbench placement、React/Mantine、Cap’n Web或具体feedback surface；

出现以下任一情况应否决或缩回Markdown-only：

- 为现实第一批用例必须加入nested layout、runtime schema、arbitrary component、payload query/stream或progress；
- page-only仍依赖Plugin MF producer、React/Mantine peer或browser parser；
- bindings无法保持fresh owner target和principal/abort语义；
- config action必须读取未保存draft才能显得可用；
- content pipeline的native/WASM交付复杂度进入Plugin runtime或browser；
- Standard Page实现/协议成本接近现有完整View，而没有删除足够author complexity。

## 21. 实施前仍需回答的问题

这些问题不改变总体边界，但必须在Phase 0形成单一决策：

1. Markdown-only page的internal opened handle是否使用`null` root还是空的framework target；默认倾向`null`，但需验证Cap’n Web
   opened-handle disposal和client union是否更清晰。
2. Content artifact是否复用现有producer static server inventory primitive还是独立目录类型；应复用digest/serving primitive，
   但不能伪装成MF producer。
3. Markdown parser选择；Satteri只是候选，必须通过相同conformance/security fixtures后再决定。
4. 初始budget数值；必须来自仓库真实README、截图asset和RPC snapshot measurement，而不是任意放大上限。

除此之外，runtime-generated schema、payload stream、Standard Attachment、隐式Config draft action和custom node registry不作为
未决问题；它们明确不在第一版。
