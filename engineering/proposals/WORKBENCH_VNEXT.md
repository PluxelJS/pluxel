# Workbench vNext：以 Module Federation 2.0 为核心的插件微前端架构

> 状态：research proposal。本文从零设计一条不兼容的 Workbench vNext，不是当前 API。
> 当前事实仍以 [`../WORKBENCH.md`](../WORKBENCH.md) 和 [`../FRONTEND.md`](../FRONTEND.md) 为准。
> 若本提案被采纳，它将替代
> [`WORKBENCH_PLUGIN_COMPOSITION.md`](WORKBENCH_PLUGIN_COMPOSITION.md) 与
> [`PORTABLE_WORKBENCH_PROTOCOL.md`](PORTABLE_WORKBENCH_PROTOCOL.md)，而不是在现有 Contract/Port/MF 2.0
> 之上再增加一层兼容 API。

## 决策摘要

Workbench vNext 是 Pluxel 的插件微前端平台，不是一个可以任意替换 renderer delivery 的通用 UI 协议。它以 Module
Federation 2.0 为唯一前端装载与共享架构：Workbench Shell 是 federation host/consumer，拥有 UI 的 Plugin definition 是
producer/remote，View 是 remote expose，`mf-manifest.json`/Snapshot 是 artifact discovery 与资源预加载事实，MF Runtime、
Runtime Plugins、share scope 和 Bridge 共同负责加载、依赖复用、渲染与销毁。

Pluxel 不在 MF 2.0 外再定义 `ArtifactLoader`、plain ESM loader、share resolver 或 framework-neutral Level 2 host runtime。需要由
Pluxel 补充的是 MF 不负责的 Plugin owner、placement、业务 capability、授权与 generation withdrawal。作者层围绕四个概念重建：

- **Model**：一个有权威 snapshot、可选 invalidation subscription 和 typed actions 的有界管理模型；
- **Feature**：可复用、可命名空间化、在 define/build 阶段完全扁平化的一组 Model 与 View；
- **Attachment**：沿一条已提交的 required Plugin dependency edge，挂入 provider-owned renderer 与
  provider-bound Model 的显式能力；
- **View Session**：浏览器实际打开一个 View 时才创建的最小授权与资源租约。

最终 Plugin node 仍只做一次原子 `publish()`。Feature 没有 runtime identity、独立 lifecycle、grant 或 registry；
Attachment 也不靠字符串 Port 扫描和 renderer 竞选，而由 consumer 的 exact provider dependency 直接绑定。一个带 UI 的 Plugin
definition/revision 产生一个 MF producer；它可以暴露多个按需加载的 View。fork/node variant 共享同一 remote artifact，但拥有独立
server publication、Model session 和 withdrawal。

第一版以 React + MF Bridge 为官方 renderer 基线。React、ReactDOM、Workbench React runtime、Pane Kit 与经过测量后确认的 UI
foundation 进入 host-owned shared policy，使 Shell 和 remote 复用同一底层实例并减少重复打包；router、workspace store 与 Worksplit
继续只属于 Shell，不进入 remote shared contract。未来跨框架 renderer 也必须通过 MF 2.0/Bridge 接入，而不是绕开 federation 建立
第二套加载协议。

这不是对现有类型改名。vNext 有意删除：

- `WorkbenchContract.resources + rpc + events` 表达同一个 current-value 管理对象的分裂；
- consumer 为 Port 重复声明 resource、token mapping 和 binding 的三份事实；
- runtime 对全部 mounted extensions 扫描 Port renderer 的发现路径；
- layout 查询阶段为每个 View 预签发全部 resource grant；
- 当前 Vite Federation 集成的全进程串行 build critical section；
- custom artifact manifest、plain ESM loader 与 generic renderer adapter 方向；
- official App 私有代码重复解释 remote、manifest、session 与错误阶段。

## 真实样本给出的需求

本提案以当前源码为证据，不从通用微前端产品想象需求。

### Wretch：dependency-local settings attachment

`@pluxel/wretch` 的业务能力是 caller-bound HTTP base。Workbench 需求非常窄：

- consumer 显式启用自己的 managed settings；
- consumer 决定设置面板放在哪个 Plugin tab；
- provider 提供统一 renderer 和 caller-bound settings implementation；
- renderer 只能读写该 consumer 的 settings，不能取得 consumer 的 Bot、业务配置或其他资源；
- consumer 或 Wretch provider 任一 generation 撤销时，旧 UI、resource 和 cached client 都失效。

当前 Port 为这一个意图要求 consumer 再声明 `httpSettings` resource、把它映射回 Port 的 `settings`、注册 RPC binding；
provider 另有 Port contract、renderer contract、Extension 和自身空 binding mount。相同事实跨 package 与 lifecycle 被表达多次。

Wretch 需要的不是可发现 UI slot 或 renderer marketplace，而是：

```text
exact Wretch dependency + consumer placement + provider-bound settings attachment
```

### Fonts：owner-local manager 与 provider attachment 是两个不同产品面

`@pluxel/fonts` 同时证明两种需求不能混为 Port：

1. FontsPlugin 自己拥有上传、删除、持久化和 provider-wide default 的管理 View；
2. Canvas、ECharts、Takumi 等 consumer 只需要 provider 提供的字体选择器，并由 consumer 选择 placement 与
   `all | portable` projection。

两者可以复用同一 Fonts producer 中的 renderer代码与 snapshot schema，但 ownership 不同。前者是普通 owner-local Feature；后者是沿 Fonts
required edge 的 Attachment。consumer 不应重新导出 `FontsSelectionPort.resources.selection`，也不应参与 renderer discovery。

Fonts 与 Wretch 还共同显示：`snapshot()/get() + update/reset/install/remove` 是一个管理 Model，不是无结构 RPC
加 React 本地缓存的偶然组合。

### Chatbot BotManager：共享的是管理工作流，不是中心 Plugin

`local-projects/chatbot` 的 Telegram、KOOK、Milky、Discord 各自拥有独立 BotManager。Manager 负责账号 persistence、
Bot registry、per-account serialization、connection lifecycle、status subscription 和 dispose；Workbench 只是它的可选投影。

四个平台当前重复同一个 Workbench 拓扑：

| View     | Placement                    | 实际意图                         |
| -------- | ---------------------------- | -------------------------------- |
| Overview | plugin tab                   | 当前平台账号摘要                 |
| Manager  | `/settings` navigation route | 账号集合与操作入口               |
| Account  | `/accounts/:accountId`       | 原生 document tab 中的单账号任务 |
| Create   | `/create`                    | 新建账号流程                     |

每个平台还重复 `commands + events(snapshot)`、initial emit glue、四个 panel wrapper、UI export map、Extension 与 mount
binding。真正变化的只有：

- Account DTO 与 diagnostics；
- upsert input 和少量平台校验；
- BotManager operations 与 snapshot projector；
- label、icon、route order、说明文字和 diagnostics renderer；
- Telegram/KOOK/Milky 额外安装 Wretch settings，Discord 不安装。

`BotAdminEvents` 只有一个 `snapshot` event，subscription attach 时必须先手工 emit current value；browser 还要把 event
connection state、自建空数组和首次 snapshot 拼成一个伪 store。这不是事件流，而是缺少 authoritative snapshot Model 的直接证据。

共享 `platform-kit` 必须继续是普通 library，不获得 Plugin identity、Context 或中心 producer。每个平台仍是唯一 runtime owner，
但 library 应能定义一个可配置 Feature，并让平台只提供 schema、projection、operations 和 renderer descriptor。

### 三个样本的共同最小集合

| 需求                         | Wretch | Fonts manager | Fonts selector | Bot admin |
| ---------------------------- | :----: | :-----------: | :------------: | :-------: |
| 首次打开必须有 current value |   是   |      是       |       是       |    是     |
| 后台变化需要主动刷新         |   否   |     可选      |      可选      |    是     |
| typed mutation/action        |   是   |      是       |       是       |    是     |
| 多页面源码复用               |   否   |      否       |       否       |    是     |
| foreign renderer             |   是   |      否       |       是       |    否     |
| consumer 决定 placement      |   是   |      否       |       是       |    否     |
| provider/consumer 联合撤销   |   是   |      否       |       是       |    否     |

这张表支持 Model、Feature、Attachment 三个正交概念；它不支持通用 slot、动态 Feature registry 或中心 Bot hub。

## 对现有两个提案的判断

### Plugin-owned Composition 保留了正确 ownership，但停得太早

[`WORKBENCH_PLUGIN_COMPOSITION.md`](WORKBENCH_PLUGIN_COMPOSITION.md) 正确判断了：

- Bot 页面复用不应制造中心 `BotAdminPlugin`；
- Feature 不应成为 runtime identity；
- Port 的价值只在 foreign renderer + explicit resource delegation；
- current-value snapshot 是独立于页面组合的缺口。

但其第一阶段只建议 application builder，仍保留当前 Contract、resource map、events convention、Extension、entry、Port mapping
和 mount binding。它最多减少四份 route object，无法删除真正昂贵的重复，也没有给 Wretch/Fonts 一条更短的 attachment 路径。

把 snapshot Model 视为“相邻实验”也过于保守。Wretch、Fonts、Bot admin、Access catalog 和 Sandbox catalog 都已经出现
`read current value + subscribe/invalidate + mutate` 的同一模式；它已经是 authoring 与 transport 的中心问题。

### Portable Protocol 找到了 host 边界，但抽象错了基础设施

[`PORTABLE_WORKBENCH_PROTOCOL.md`](PORTABLE_WORKBENCH_PROTOCOL.md) 正确要求显式 renderer lifecycle、最小 shared policy、asset ownership
和非 official Shell 可消费的契约；错误在于把 MF 降为可选 delivery implementation，并准备在其外再建立 framework-neutral artifact/
renderer protocol。MF 2.0 已经提供 remote/expose、Manifest/Snapshot、Runtime、Runtime Plugins、share scope、动态类型和 Bridge。再做一层
通用 loader 不会获得更完整的微前端能力，只会让 Pluxel 同时维护两套 discovery、shared resolution、preload、错误恢复与 DevTools 语义。

当前真正没有解决的是 Pluxel control plane：

- layout 查询即生成所有 View resource grants；
- Contract 把 layout、resource schema、renderer export 与 artifact revision 耦合；
- Port discovery 没有利用已提交的 Plugin dependency edge；
- 当前 `@module-federation/vite` 的 module-scoped non-reentrant state 迫使构建全局串行；
- mandatory shared 集合没有区分 React singleton、Workbench platform 与可选 UI dependency。

这些是 Workbench 对 MF 2.0 的集成和业务授权模型问题，不是删除 MF 的证据。Host portability 的边界应是“任何 Shell 都加入同一
Federation Runtime 并消费同一 MF manifest/Bridge expose”，而不是“任何 Shell 都自己实现一份 Pluxel remote loader”。

### 新提案保留什么、推翻什么

保留：

- MF 2.0 是唯一 remote、manifest、shared 与 renderer lifecycle 基础；
- Workbench optional、host-owned、业务能力独立；
- 一个 Plugin node 一次原子 publication；
- owner/target 使用 structured Plugin node address；
- opaque grant、generation withdrawal、last-known-good；
- consumer 拥有 placement，provider 不占据任意宿主 UI；
- Feature 不成为 runtime entity；
- Shell framework 与 Plugin renderer framework 可以不同，但通过 MF Bridge 协作。

推翻：

- flat `resources` 是 Workbench authoring 的中心；
- `events` 可以承载 current state；
- Port 需要字符串 ID/version、provider mount 和 runtime discovery；
- 一个 Plugin remote 只能暴露单一 Plugin-wide `setup()` module；
- target layout snapshot 应携带可调用 resource grant；
- React Component 必须直接进入 Shell 的 React tree，而不能使用 MF Bridge lifecycle；
- MF 只是可替换 adapter，Pluxel 需要自建 artifact manifest 与 loader。

## 目标与非目标

### 目标

- 让三个真实样本的调用点只表达领域差异，不重复 transport wiring；
- 让 external input/output 在 schema boundary 运行时验证，不只依赖 TypeScript interface；
- 首次读取、断线重连、background invalidation、action refresh、last-known-good 和 cleanup 具有统一语义；
- layout discovery 不创建 resource/session，也不注册 remote或请求 manifest；
- 打开一个 View 只授权它声明使用的 Model；
- shared library Feature 可复用多页面拓扑与 React implementation，而不取得 runtime ownership；
- dependency Attachment 无扫描、无竞选、无 namespace lookup；
- Shell 统一使用 MF Runtime、Manifest/Snapshot、share scope 和 Bridge，不复制 remote loader；
- Plugin UI 作为 MF producer 独立构建/部署，View 作为 expose 按需加载；
- Shell 与 remotes 通过受控 shared policy 复用 React/UI foundation，并能由 MF DevTools 验证；
- Federation build 使用隔离 worker/process 实现 bounded concurrency，不让具体 Vite 插件的全局状态塑造架构；
- Workbench disabled 时保持零 backend、零 producer、零 compiler/watcher/transport。

### 非目标

- 不把业务 Plugin 变成浏览器不可信代码的 security sandbox；
- 不在第一版交付 Vue/Svelte producer；未来实现必须使用 MF Bridge；
- 不建立 header/status bar/dock 等任意 slot；
- 不建立 Feature marketplace、dynamic install、priority 或 fallback graph；
- 不让 PluginPart 单独 publish Workbench；
- 不用 Workbench Model 取代 Plugin dependency、database 或 command registry；
- 不维护 server-side form draft、wizard session 或业务 transaction；
- 不为 plain ESM、其他 remote runtime 或自定义 renderer 建立 adapter abstraction；
- 不提供旧 Contract/Port manifest 的双栈长期兼容层。

## vNext 心智模型

```text
Plugin package build
  Feature + local View + Attachment ──> MF producer
                                       ├─ mf-manifest.json / Snapshot facts
                                       ├─ ./views/<view-key> Bridge exposes
                                       └─ shared dependency declarations

server Plugin generation
  Model bindings + placement ----------> atomic PublishedTarget
                                                │ layout references remote/expose
                                                ▼
Workbench Shell / MF host
  one Federation Runtime -------------> register manifest on demand
                                        -> open ViewSession
                                        -> loadRemote(expose)
                                        -> Bridge render/update/destroy
                                        -> release grant on owner withdrawal
```

`MF producer/remote` 是前端部署与模块生命周期实体；`PublishedTarget` 和 `ViewSession` 是 Pluxel server capability 生命周期实体。
Feature 是 define/build-time grouping；Model 是 typed authority declaration；Attachment 是 publication plan 中的一条 exact dependency
binding。两组 lifecycle 通过 remote revision、expose key 与 owner generation 对齐，但不互相冒充。

## Plugin graph 如何投影成微前端 graph

Workbench 不在 Plugin 系统旁边维护第二个任意微前端 catalog。Plugin definition、build revision、dependency 和 generation直接投影成
MF producer graph与 browser capability graph：

| Plugin/Workbench fact                    | MF 2.0 / browser projection                                     |
| ---------------------------------------- | --------------------------------------------------------------- |
| 带 UI 的 Plugin definition               | 一个 producer/remote family                                     |
| UI build revision                        | immutable Manifest/Snapshot revision                            |
| local View                               | producer 内一个 Bridge expose                                   |
| required dependency Attachment           | target placement引用 provider producer 的 exact expose          |
| Plugin node/fork                         | 共享 producer代码，独立 PublishedTarget/ViewSession/Model grant |
| Plugin generation stop/replacement       | 撤销 publication/session；新 generation重新关联 remote revision |
| Feature、PluginPart、普通 shared library | build-time/source composition，不自动获得 remote identity       |

因此一个没有 Workbench UI 的 Plugin 不产生 MF producer；Workbench disabled/headless host不创建 browser federation graph。动态 Plugin
安装后仍先进入正常 Plugin catalog/graph，只有 running generation成功 `publish()` 才让对应 View进入 Workbench layout；Shell实际打开 View时才
注册 remote并加载 expose。Plugin dependency也不会自动投影 provider全部 UI，只有 consumer显式 placement的 Attachment建立跨 remote组合。

这是一套直接围绕微前端概念的 Plugin UI architecture：MF producer是前端部署单元，expose是渲染单元，shared是公共底层，Bridge是 UI
lifecycle，Manifest/Snapshot是发现与预加载协议；Pluxel Plugin graph则提供它们缺少的业务 owner、启停顺序和 capability withdrawal。

## 1. Model：把 current state 与 actions 放回同一个契约

### Author contract

概念 API：

```ts
export const WretchSettingsModel = workbench.model({
	snapshot: WretchManagedSettingsSnapshotSchema,
	actions: {
		update: workbench.action({
			input: WretchManagedSettingsSchema,
			result: MutationAckSchema,
			refresh: 'after-success',
		}),
		reset: workbench.action({
			input: EmptySchema,
			result: MutationAckSchema,
			refresh: 'after-success',
		}),
	},
})
```

`snapshot`、每个 action input 和 result 都必须是 Standard Schema。预期业务失败由 result 的 discriminated union 或声明的
稳定 error code 表达；programming/transport exception 继续 reject，不把 message 变成协议。

`refresh` 第一版只有两个封闭值：

- `'after-success'`：handler 成功后 invalidates 本 Model；有 active reader 时 coalesced re-read，没有 reader 时不做无用工作；
- `'manual'`：action 不暗示 Model 变化，例如 Bot 鉴权探针。

不提供任意 invalidation graph。一个 action 若需要更新另一个 Model，应由领域 service 的 subscription 传播，或把两个事实建模为
同一个 snapshot；真实跨 Model transaction 出现后再设计。

### Server binding

```ts
const binding = workbench.bind.model(WretchSettingsModel, {
	read: () => http.readManagedSettings(),
	actions: {
		update: (input, { signal }) => http.updateManagedSettings(input, { signal }),
		reset: (_input, { signal }) => http.resetManagedSettings({ signal }),
	},
})
```

带 background state 的 BotManager 另外提供 invalidation subscription：

```ts
const binding = workbench.bind.model(BotAdminModel, {
	read: () => ({ accounts: projectAccounts(manager) }),
	subscribe: (invalidate) => manager.subscribe(invalidate),
	actions: bindBotOperations(manager),
})
```

`subscribe()` 只报告“事实可能变化”，不携带 snapshot payload。runtime 负责读取、schema validation、revision、并发 invalidation
coalescing、last-known-good 和 cleanup；因此不再需要 `attachBotAdminState()` 的 initial emit/AbortSignal glue。

### Browser state

```ts
const bots = useWorkbenchModel(TelegramBots.models.admin)
const snapshot = bots.useSnapshot()
// loading | ready | stale | error；ready/stale 携带 value 与 revision

await bots.actions.upsert(input, { signal })
```

Model 必须保证：

- 每个 binding generation 第一次订阅必定执行 authoritative read；
- revision 只在 validated snapshot 成功发布后单调增加；
- read 期间发生 invalidation 时至少再读一次，不丢最后一次变化；
- reconnect 总是重新读取，不把 events replay 伪装成 current state；
- read 失败保留 last-known-good 并进入 `stale`；没有旧值时进入 `error`；
- action input/result 与 snapshot 都在 server/browser trust boundary 校验；
- action 接受 `AbortSignal`，owner withdrawal abort 已接纳 handler 并等待其退出；
- snapshot bytes、action payload、pending invalidation 和 active client 数量都有 server 上限；
- 最后一个 ViewSession 释放后取消 subscription，idle cache 按有界 LRU 回收。

### 与 query/channel 的边界

vNext 保留三个明确 primitive：

| Primitive | 用途                                           | 不应用于                          |
| --------- | ---------------------------------------------- | --------------------------------- |
| Model     | bounded current snapshot + typed actions       | 大型参数化数据库集合、瞬时日志    |
| Query     | 参数化 database-backed rows + stable-key patch | 任意 service callback 或 mutation |
| Channel   | transient event/progress/log stream            | authoritative current value       |

不把 object-shaped raw RPC 放在主要作者 API。出现无法诚实放入 Model action 的第二个真实用例后，再考虑独立 low-level entry；
不能为了保留现有 `RpcTarget` 形状而让所有 action 绕过 schema declaration。

## 2. Feature：正式支持 define-time composition，但不增加 runtime 层

`workbench.feature()` 生成 browser-safe、immutable fragment。它可以声明 Model、View、feature-local route 和默认 navigation metadata，
不能包含 Context、binding、React component、Node API 或 mutable state。

```ts
export const BotAdminFeature = workbench.feature({
	models: {
		admin: BotAdminModel,
	},
	views: {
		overview: workbench.view({
			uses: ['admin'],
			placements: [workbench.tab()],
		}),
		manager: workbench.view({
			uses: ['admin'],
			placements: [workbench.route('/settings', { navigation: true })],
		}),
		account: workbench.view({
			uses: ['admin'],
			placements: [workbench.route('/accounts/:accountId', { navigation: false })],
		}),
		create: workbench.view({
			uses: ['admin'],
			placements: [workbench.route('/create', { navigation: false })],
		}),
	},
})
```

consumer 必须用稳定 local namespace 安装 Feature：

```ts
export const TelegramBots = BotAdminFeature.install('bots', {
	account: TelegramAdminAccountSchema,
	upsertInput: TelegramBotConfigInputSchema,
	navigation: TelegramNavigation,
})

export const TelegramWorkbench = workbench.define({
	features: { bots: TelegramBots },
	producer: workbench.federation.react(import.meta.url, './workbench/ui/index.tsx'),
})
```

定义阶段把 key 变成 `bots/admin`、`bots/overview` 等 final local key，并在同一次校验中拒绝：

- Model/View key collision；
- concrete route collision 或 ambiguous parameterized route；
- 同一 View 重复 placement；
- 未声明或多余的 `uses`；
- 同 navigation group ID 的 label/icon 不一致；
- MF producer 没有对应的 exact expose，或多出未声明 View。

Feature 的 install options 只能覆盖 Feature 明确开放的 metadata/schema slot，不能任意 deep merge。Feature flatten 后 protocol、grant、
layout、session 和手写 final definition 完全相同；runtime 不知道 `bots` 曾来自 shared library。

`platform-kit` 可以另外提供 renderer factory：

```tsx
export default BotAdminReact.render(TelegramWorkbench.features.bots, telegramDescriptor)
```

它直接生成四个 exact Bridge View exposes，平台不再维护四个 wrapper component 和手写 export map。descriptor 与 diagnostics renderer
留在 platform producer 内，不进入 browser-safe Contract 或 server protocol。

## 3. Attachment：用 exact dependency binding 取代 Port discovery

Attachment 是 provider package 定义的窄 UI capability：

```ts
export const WretchSettings = workbench.attachment({
	model: WretchSettingsModel,
	view: workbench.view({ uses: ['model'] }),
	renderer: workbench.federation.react(import.meta.url, './ui/settings.tsx'),
})
```

Attachment 本身不含 placement。consumer 在自己的 final definition 中选择 placement：

```ts
export const TelegramWorkbench = workbench.define({
	features: { bots: TelegramBots },
	attachments: {
		http: WretchSettings.place(
			workbench.tab({ order: 49, label: 'HTTP', icon: workbench.icons.Settings }),
		),
	},
	producer: workbench.federation.react(import.meta.url, './workbench/ui/index.tsx'),
})
```

server publication 绑定 exact provider facade：

```ts
const plane = this.ctx.workbench
if (plane) {
	await this.http.enableManagedSettings()
	plane.publish(TelegramWorkbench, {
		features: {
			bots: workbench.bind.feature(TelegramBots, bindTelegramBotAdmin(manager)),
		},
		attachments: {
			http: this.http.bindSettingsAttachment(),
		},
	})
}
```

Fonts consumer 同样只表达 placement 与 projection：

```ts
attachments: {
	fonts: FontsSelection.place(workbench.tab({ label: 'Fonts' })),
}

// server binding
fonts: this.fonts.bindSelectionAttachment({ scope: 'portable' })
```

不再存在 consumer resource alias、`provide` token map、字符串 Port ID/version 或 provider candidate scan。

`workbench.federation.react()` 不是 loader adapter。它是唯一 MF 2.0 producer declaration：toolchain 把同一 Plugin definition
可达的 local View 与 Attachment renderer 合并为一个 producer config，生成稳定 expose key、Bridge wrapper、shared 声明、动态类型与
`mf-manifest.json`。作者不能另选 plain ESM mode，也不手写 remote name、public path 或 share scope；这些由 host product policy、Plugin
definition identity 与 build revision确定，避免多个插件各自形成不兼容的 federation universe。

第一版 Attachment 只接受 committed required dependency，原因是 Wretch/Fonts 的真实 owner ordering 已由 constructor edge 保证。
bind handle 内含 exact provider node/generation 与当前 caller target，runtime 必须验证：

- binder 的 caller 就是正在 publish 的 target；
- provider 是 target 当前 committed direct required dependency；
- Attachment declaration 与 provider producer/expose definition exact match；
- Model factory 属于 provider generation，placement 属于 target；
- ViewSession 同时持有 target 与 provider admission lease。

consumer stop/replacement 撤销 placement 与 session；provider stop/replacement 撤销 renderer、Model 和 session。旧 session 不自动按
Attachment key 或 Plugin type寻找新 provider。Plugin graph replacement 重启 consumer 后，由新 generation 重新 publish。

这条 API 是 controlled context capability，不允许普通对象伪造 BoundAttachment。它也不是跨任意 Plugin 的 UI injection：没有 consumer
显式 placement 和 exact dependency bind，就没有 contribution。

## 4. 最终 publication 与 ownership

每个 Plugin node 最多一次：

```ts
ctx.workbench?.publish(definition, exactBindings)
```

`publish()` 的定义：

- 从 immutable Context 推导 target owner，不在 definition 重复写 address；
- 校验 final definition、exact bindings、attachment dependency 和 federation producer/expose declarations；
- 在对外 revision 可见前校验并冻结全部 Model/Query/Channel binding descriptor，但不调用 producer 或建立 subscription；
- 任一准备失败完整回滚，Plugin `init()` 失败；
- 成功 publication 与 owner generation effects 绑定，重复 dispose 幂等；
- owner stop 先关闭 ViewSession admission，再 abort action/query/channel，等待已接纳调用，最后撤销 publication；
- 不允许 React effect、PluginPart 或 browser session 追加 server contribution。

Ownership matrix：

| 来源                   | placement owner | Model owner | renderer owner | runtime withdrawal      |
| ---------------------- | --------------- | ----------- | -------------- | ----------------------- |
| Plugin local View      | target Plugin   | target      | target package | target generation       |
| shared library Feature | target Plugin   | target      | target package | target generation       |
| dependency Attachment  | target Plugin   | provider    | provider       | target 与 provider 交集 |
| builtin host document  | host            | 无或 host   | host           | host/layout revision    |

shared library 从不因提供 Feature source 获得 runtime owner。

## 5. View 与 placement

vNext 第一版只保留已证实的产品语义：

- `plugin.tabs`：目标 Plugin 详情中的管理 panel；
- `plugin.routes`：Workbench workspace 的导航页或非导航 document route。

View 必须显式列出 `uses` 的 Model/Query/Channel。Server layout 只投影 View identity、placement、navigation、MF
producer/manifest/expose reference 和所需 model keys，不携带 grant。Attachment v1 只允许 `plugin.tabs`，不让 provider renderer
取得 route namespace。

Parameterized route、`navigate()`、`openTab()`、route params、native document tab 和 Pane Kit 的宿主所有权继续保留当前有用语义。
Feature route 在 flatten 时变成 target-relative final path；Remote View 不能传任意宿主 URL，也不 import Shell router、Tab store 或 split
implementation。

Navigation group 使用可复用 frozen descriptor value。相同 group ID 的 non-empty label/icon 必须 canonical equal；冲突 publication
得到稳定 code，旧 layout 保持 last-known-good。group 只影响 Shell projection，不产生 registry/lifecycle。

## 6. Workbench control plane：运行在 MF 2.0 Host 之上

### Layout snapshot

Workbench Shell 读取的 global/target layout 只包含：

- monotonic layout revision；
- canonical target/renderer owner address；
- stable View key 与 placement；
- route/tab/navigation metadata；
- definition hash 与 `FederatedViewRef`；
- View 需要的 Model kind/key 列表，不含 grant ID。

`FederatedViewRef` 只引用 MF producer name、immutable `mf-manifest.json` URL、expose key、build revision 与 Bridge kind。它不是另一份
artifact manifest，也不复制 asset/shared/type file 列表；这些事实只由 MF Manifest/Snapshot 提供。因此列目录、恢复 Tab 或搜索 route
不会签发 grant、订阅 Model、注册 remote、请求 manifest 或创建 Core slot。Shell 可以使用 MF prefetch 能力预取明确的导航目标，但这不
创建 ViewSession。

### Open View

只有 Shell 决定实际渲染一个 View 时才调用：

```text
openView(target address, view key, expected layout revision)
  -> ViewSession {
       session grant,
       exact Model grants,
       FederatedViewRef,
       Bridge props + allowed host capabilities,
       owner/provider generation facts
     }
```

Server 针对 pinned layout revision 做 admission；revision 不匹配返回稳定 `layout_changed`，Shell refresh 后重试。ViewSession：

- 只签发 `uses` 声明的 grant；
- target/provider 任一 withdrawal 立即失效；
- browser close 显式释放，断线/异常依靠有界 idle TTL 回收；
- 同 browser runtime 的相同 target/model binding 可以 ref-count 共享 validated snapshot transport；
- 不能用 model key、Plugin namespace 或旧 grant重新获取 capability；
- active sessions、models、snapshot bytes、actions 和 stream 都受 quota 限制。

浏览器执行顺序固定为：

1. 按 layout revision 打开 ViewSession，取得最小 Model grants 与 pinned `FederatedViewRef`；
2. 在页面唯一的 `ModuleFederation` instance 上按需注册 manifest remote；
3. 由 MF Runtime 请求 Manifest、生成/消费 Snapshot、协商 shared 并 `loadRemote()` 对应 expose；
4. 由 MF Bridge render/update/destroy View；
5. target/provider withdrawal 或 Tab 关闭时先 destroy Bridge，再释放 ViewSession。

这段编排不包装成 generic `loadArtifact()`。MF Runtime 是唯一模块加载器；Workbench client 只管理 layout、ViewSession、Model clients 与
owner withdrawal。producer-only HMR 且 definition hash 不变时，Shell 先通过新 manifest revision加载 expose并完成 Bridge render，再替换旧
View，Model session保持；definition、Model schema、Attachment provider 或 route变化时关闭旧 session并按新 layout重开，不猜测兼容。

### 页面唯一的 Federation Runtime

每个 Workbench browser page 只创建一个 MF Runtime instance。官方 Shell 直接拥有该实例、route index、ViewSession cache 与 workspace state；
不再发布 framework-neutral Level 2 host runtime。其他 Shell 若要承载 Pluxel Plugin View，必须同样成为 MF 2.0 host，使用相同 manifest、
shared policy、Pluxel Runtime Plugin 和 Bridge contract，而不是替换 loader。

Pluxel Runtime Plugin 只使用 MF 2.0 已有 hooks 完成 host policy：

- `fetch`/manifest hooks 注入认证、校验 distribution revision并记录 Manifest/Snapshot 诊断；
- `afterResolve`/script hooks 把逻辑 remote location 投影到当前 CDN/distribution URL；
- `resolveShare` 与 share lifecycle hooks 验证 singleton/version policy并报告重复依赖；
- `errorLoadRemote` 提供明确的 offline/last-known-good恢复边界；
- Bridge hooks把 render/destroy trace 与 ViewSession、Plugin owner generation关联。

业务 Plugin 不注册 host-wide Runtime Plugin，也不能修改 global Snapshot 或 share scope。Runtime Plugin 是受信任 Shell/toolchain extension，
不是 Workbench Plugin 的第二套插件系统。

## 7. MF 2.0 producer、shared 与 Bridge

### 为什么以 MF 2.0 为架构核心

MF 2.0 不只是 `remoteEntry` loader。它把独立 producer/consumer、remote expose、依赖共享、Manifest/Snapshot、Federation Runtime、
Runtime Plugins、动态类型、DevTools 与 Bridge lifecycle 组合成一套微前端架构。Workbench 的需求正是让 independently built Plugin UI
进入同一个 Shell、复用底层依赖、按需加载、独立更新并可诊断；另做 plain ESM protocol 会重新实现这些能力，却失去社区工具链。

因此 vNext 不承诺 delivery neutrality。MF 2.0 的 manifest、runtime 与 share semantics 是 Workbench 架构约束；Pluxel 只在其上增加
Plugin graph、server capability 与 placement 语义。

设计与术语直接以 MF 2.0 社区文档为基线：

- [Introduction](https://module-federation.io/guide/start/index)：producer/consumer、code sharing 与 dependency reuse；
- [Manifest and Snapshot](https://module-federation.io/guide/basic/manifest-snapshot)：remote entry、exposes、assets、shared、types 与 preload；
- [Runtime Plugins](https://module-federation.io/guide/runtime/runtime-plugins)：manifest fetch、URL rewrite、shared resolution、recovery与 Bridge hooks；
- [shared](https://module-federation.io/configure/shared) 与
  [shareStrategy](https://module-federation.io/configure/shareStrategy)：singleton、版本协商及 `loaded-first`；
- [Bridge Overview](https://module-federation.io/guide/bridge/overview)：application-level render/update/destroy与跨框架集成。

Pluxel proposal 只在这些概念没有覆盖的地方新增契约，并优先通过 MF Runtime Plugin/Bridge extension point集成。

### Producer、remote 与 expose identity

一个带 UI 的 Plugin definition/build revision 产生一个 MF producer。producer 可以包含多个 local View 和 provider Attachment renderer，
每个 View 对应稳定 expose，例如 `./views/bots/manager`；异步依赖与 CSS 继续由 MF build plugin拆分。一个 Plugin node 的 fork、默认 variant
和同 definition 的多个运行实例复用 producer artifact，但各自拥有 PublishedTarget、ViewSession 与 Model grant。

概念上的 Workbench reference 只有：

```ts
type FederatedViewRef = Readonly<{
	producer: string
	manifest: string
	buildRevision: string
	expose: `./views/${string}`
	bridge: 'react'
}>
```

`producer`/`expose` 是 MF runtime identity，不能被 Plugin node address替代；Plugin address又是 server owner identity，不能从 remote name
反推。toolchain 根据 canonical Plugin definition、producer entry 与 build revision生成合法且无冲突的 producer name，作者不手拼名称。
外部 manifest、Snapshot 和 expose 都在 browser trust boundary验证；MF 动态类型改善开发体验，但不代替 runtime schema validation。

`mf-manifest.json` 是唯一 consumer runtime manifest，描述 remote entry、exposes、assets、shared 与类型文件；`mf-stats.json` 只用于 build
分析和诊断。Workbench server/distribution 只维护“哪个 Plugin definition revision 对应哪个 manifest URL/hash”的可信 inventory，不复制
Manifest 字段，也不发明 `WorkbenchArtifactV2`。

### Shared platform policy

减少 frontend 重复打包是 vNext 的明确目标，而不是偶然优化。shared policy 由 Shell product 与
`@pluxel/core/federation` 统一生成，producer 不能局部覆盖：

- React、ReactDOM 及必要 subpath 是 singleton，Shell 提供并由 remotes 复用；
- MF Bridge、Workbench React runtime、Model client 与 Pane Kit 属于版本锁定的 platform shared；
- 经 bundle measurement 证实能显著复用且需要同一 Context 的 Mantine foundation 可以进入 platform scope；
- router、workspace store、Worksplit 和仅 Shell 使用的组件不 shared 给 remotes；
- 普通领域 library 默认由 producer bundle/tree-shake；至少两个 producer真实复用且版本策略明确后才加入 shared。

动态 Plugin 场景默认评估 `shareStrategy: 'loaded-first'`，优先复用 Shell 已加载依赖并保持 remote 按需注册；严格版本要求通过
`requiredVersion`/singleton fail-fast，而不是静默装载第二份 React。需要 React 主版本迁移或领域隔离时使用 MF 2.0 multiple share scopes，
不建立 Pluxel 自定义 scope resolver。shared 过大时优先使用 MF shared tree shaking并以实际 bundle/DevTools 数据调整集合。

### Bridge 是 View lifecycle

第一版每个 React View expose 都返回 MF React Bridge application contract，Shell 使用 Bridge 完成 lazy load、render、update、error boundary
和 destroy，不直接把未知 remote Component 当作普通 local Component 塞进 Shell tree。locale、scheme、notify、confirm、relative navigation、
route params、View state、Model clients 与 Pane Kit root通过 Bridge props/context注入；remote 不能取得 Shell router、workspace store 或 raw
transport。

React/ReactDOM 与 UI package代码通过 shared复用，不表示 remote 可以隐式读取 Shell private Context。主题等稳定语义通过 Bridge传递，
remote 在自己的 application boundary建立 provider。CSS、portal root、focus 与 cleanup沿 Bridge lifecycle管理。未来 Vue/Svelte producer
只有在采用对应 MF Bridge 或社区兼容 Bridge contract时进入 Workbench；不会为它们新增 Pluxel renderer adapter registry。

### Build、distribution 与开发期更新

当前 `@module-federation/vite@1.16.16` 的 module-scoped non-reentrant state 是具体集成缺陷。vNext 先把每个 producer build隔离到有界
worker/subprocess，使进程级状态不跨 producer build；若 Vite integration仍无法满足并发、HMR或 Manifest正确性，则把 Workbench producer compiler
统一切到 MF 2.0 社区更成熟的 Rspack/Rsbuild 路径。这里不会公开 bundler adapter或允许每个 Plugin 自选 compiler，避免同一 host出现多套
不一致的 federation contract。

production 按 producer revision 发布完整 MF 输出，使用 immutable manifest/remote/assets URL并纳入 distribution inventory、hash 与签名。
content-addressed cache仍可减少相同构建产物的存储和传输，但它只是 deployment optimization，不代替 shared negotiation或 MF Manifest。
Manifest/Snapshot提供 expose assets预加载，`mf-stats.json` 与 MF DevTools用于检查重复依赖、加载链和 shared winner。

开发期 producer更新先生成并验证新的 Manifest/exposes，再让 Shell注册新 revision并完成 Bridge render；失败保留 last-known-good remote。
同一 output revision只允许一次原子 publication，不同 producer可以 bounded parallel build。Plugin generation withdrawal撤销 server
publication/session；remote module cache按 MF Runtime语义保留或回收，不能让旧 expose借旧 grant重新取得业务能力。

## 8. Browser-safe 与 server package 边界

建议的逻辑 entry，不要求立即拆成多个 npm package：

| Entry                          | 内容                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| `runtime/workbench/contract`   | schema、Model、Feature、Attachment token、View/placement         |
| `runtime/workbench`            | server binding、BoundAttachment、`publish()`                     |
| `runtime/workbench/client`     | browser Model/Query/Channel client，不加载 remote                |
| `runtime/workbench/react`      | React producer authoring、hooks、Pane Kit、Bridge expose wrapper |
| `runtime/workbench/federation` | MF host instance、Pluxel Runtime Plugin、ViewSession/Bridge 编排 |
| `@pluxel/core/federation`      | producer/host shared policy、manifest/build facts 的唯一内核契约 |

`contract` 不 import Plugin、Context、Node builtin、React 或 MF Runtime；`client` 不 import React，也不成为 remote loader。`react` 可以直接依赖
MF React Bridge，但不 import official router/store/split。`federation` 是唯一具体 MF 2.0 host integration，直接依赖社区 Runtime/Bridge API，
不定义可替换 adapter interface。Management Level 1 仍属于现有 `runtime/web`，不被 Workbench control plane复制。

## 9. 性能与复杂度预算

vNext 不先承诺未经测量的百分比，但必须达到以下结构上界：

- publish validation/index：`O(V + M + A)`，其中 `V` 是 final Views、`M` 是 Models、`A` 是 Attachments；
- target layout projection：`O(target views + target attachments)`，不得扫描全部 mounted Plugin寻找 renderer；
- global navigation projection：`O(navigation views)`，复用 publication-time index；
- `openView` admission：`O(view used models)`，MF expose asset resolution 交给 Manifest/Snapshot；
- Model invalidation：每个 active binding 同时最多一个 read 和一个 coalesced rerun；
- browser：每页一个 Federation Runtime instance；remote/Snapshot 由 MF cache，Model client按 grant refcount；
- shared：React/ReactDOM singleton，平台 shared 的额外副本数必须为 0；
- build：不同 producer在隔离 worker/process中 bounded concurrency；只对相同 output revision串行；
- disabled Workbench：不安装 Context property，不创建 publication backend、compiler、watcher、route、artifact或 client runtime。

需要新增趋势 probe：

1. 1/10/100/1000 target，每个 1/4/16 View；只读 layout 时 grant/session/resource 数始终为 0；
2. 打开一个只用一个 Model 的 View，server active Model 与 browser client 都只增加一个；
3. 100 个 Attachment resolution 不扫描 unrelated Plugin；
4. N 个独立 producer build 能观察到 bounded parallelism，失败 producer不阻塞已排队的无关 output；
5. 同一 Bot target 同时打开 Overview/Manager/Account 时只保留一个共享 snapshot subscription，最后一个 View 关闭后 cleanup；
6. producer HMR replacement 不重复建立 Model subscription，definition replacement 必须撤销旧 session；
7. Shell 与三个 remotes 同时加载时只有一个 React/ReactDOM winner，MF DevTools 能显示 shared reuse；
8. 未打开 View 不请求其 manifest/expose；Manifest、remote entry、expose 和 Bridge阶段失败可以分别诊断并保留 last-known-good。

## 10. 三个样本在 vNext 中应变成什么

### Wretch

Provider package 保留：

- 一个 settings Model schema；
- 一个 settings Attachment declaration；
- Wretch MF producer 中的一个 settings Bridge expose；
- provider-side bound attachment factory。

consumer 只保留：

- `enableManagedSettings()`；
- final definition 中的一次 placement；
- publication 中的 exact `bindSettingsAttachment()`。

删除 consumer resource alias、Port mapping、Port version、provider renderer mount 与 registry candidate scan。

### Fonts

FontsPlugin 的 local definition 包含 manager Model + Fonts View。Fonts selection 是同包另一个 Attachment，由同一个 Fonts MF producer
暴露独立 selection View。Canvas/ECharts/Takumi 只选择 placement，并绑定 `scope`；上传/删除 authority 永远不进入 Attachment。

manager 与 selector UI 都直接订阅 Model snapshot，不维护 request ID、manual refresh 后的本地 authoritative copy。显式“刷新”按钮可以调用
Model `refresh()`，但不是首次读取或 action consistency 的必要条件。

### BotManager

`platform-kit` 导出：

- generic BotAdmin Model/Feature factory；
- server bind helper 的结构要求；
- React Bridge expose factory与共享 panels；满足真实复用条件时由 MF shared复用 `platform-kit`。

每个平台只提供：

- Account/upsert runtime schema；
- BotManager projector、subscribe 和 actions；
- navigation/labels；
- Bridge View descriptor 与 diagnostics component；
- 是否安装 Wretch Attachment。

不再有 `BotAdminEvents`、`attachBotAdminState()`、四份 route topology、四个 trivial panel wrapper 或四份手写 UI export map。
仍然有四个独立 Plugin owner、BotManager、publication、MF producer 和 lifecycle；没有中心 BotAdminPlugin。

## 11. Lifecycle、失败与安全

### Stable failures

可恢复边界使用封闭 code：

- definition/publication：`invalid_definition | invalid_binding | dependency_mismatch | producer_unavailable`；
- open View：`layout_changed | view_unavailable | bridge_unsupported | quota_exceeded`；
- Model grant：`grant_expired | model_unavailable | invalid_input | invalid_result`；
- federation：`manifest_unavailable`、`manifest_invalid`、`remote_entry_failed`、`expose_missing`、`shared_unsatisfied`、
  `bridge_render_failed`。

这些 code 的 state effect 必须明确；例如 publication 失败不产生可见 revision，`layout_changed` 不创建 session，producer replacement
失败保留 last-known-good。底层 MF 错误需要按 Manifest、remote entry、expose、shared 和 Bridge阶段归类，同时保留原始 cause/trace；未知
programming/transport exception reject 并进入 diagnostics，不归入 catch-all public `internal_error`。

### Trust boundary

- server 接收的 address、revision、View key、grant、action input 都先是 `unknown`；
- schema validation 后复制并冻结 snapshot/action result；
- Attachment bind handle 是 framework opaque capability，不能由普通 JSON/对象伪造；
- grant 只按 ViewSession 签发，不接受 Plugin/model namespace；
- action principal/access policy 由 Management Plane/host carrier注入，Plugin UI 不能自称管理员；
- secrets 不进入 snapshot、logs、MF Manifest/Stats 或 distribution metadata；Wretch proxy credential 等限制继续由领域 schema 执行。

Remote View JS 仍是宿主选择安装的可信代码，不是安全沙箱。同源恶意代码的隔离需要独立 origin + iframe/CSP/permission protocol，不能把
opaque grant 描述成对恶意 renderer 的完整防线。

## 12. 实施顺序：先立 MF 2.0 主干，再迁移 Workbench 语义

### Slice A：MF 2.0 foundation proof

先用 Wretch、Fonts 和 Telegram BotAdmin 建立一条不经过 custom loader 的纵向链路：

- 一个 Workbench Shell、一个 MF Runtime instance；
- 每个 Plugin definition 一个 producer，View 对应 Bridge expose；
- 标准 `mf-manifest.json`/Snapshot、动态类型与 DevTools；
- React/ReactDOM/Workbench platform shared singleton 和 `loaded-first` 按需 remote；
- Pluxel Runtime Plugin 的 manifest validation、trace、failure recovery 与 Bridge destroy；
- 隔离 worker/process 的 parallel producer build，并据实决定继续 Vite 还是统一 Rspack/Rsbuild。

只有这条链路能证明 shared reuse、按需 expose、HMR replacement 和 last-known-good 后，才冻结 vNext federation contract。

### Slice B：Model + Feature authoring proof

在 experimental internal entry 实现 Model state machine 与 define-time Feature flatten。迁移 chatbot BotAdmin，验证 runtime schema inference、
initial read/reconnect/coalesced invalidation、四平台 wrapper/route/events glue 的净删除，以及 Feature flatten 后没有额外 runtime record。

### Slice C：Attachment proof

迁移 Wretch 与 Fonts selector，先只支持 required dependency + tab placement。验证 consumer placement可以引用 provider remote expose、exact
dependency edge、joint withdrawal、no scan 和无 Port alias/mapping。

### Slice D：ViewSession 与 MF host orchestration

实现 grant-free layout、`openView()`、Model refcount，以及 ViewSession 与 manifest revision/Bridge lifecycle 的联合撤销。official Workbench
直接使用 MF host integration；不实现 plain ESM fixture、generic host runtime 或 renderer adapter。

### Slice E：一次性切换

全部 workspace Workbench producer迁移后：

- 删除旧 Contract/Extension/Port 和 ad-hoc Federation wrapper，切换到标准 MF Runtime/Manifest/Bridge path；
- 删除两个被替代 proposal；
- 将稳定事实写回 `WORKBENCH.md`、`FRONTEND.md`、`TOOLCHAIN.md`、用户 docs；
- 为所有受影响 public package添加 Tegami pending changelog；
- 不保留 alias、automatic adapter、custom manifest reader 或双 protocol negotiation。

## 13. 验收条件

### Author ergonomics

- Telegram/KOOK/Milky/Discord 不再手写相同的四页 topology、initial snapshot events、panel wrappers 和 UI export map；
- Wretch/Fonts consumer 不再声明 provider resource alias、Port map 或 renderer version；
- final publication 的 binding exactness 与 MF expose exactness仍由类型和 runtime validation共同保证；
- domain-specific validation、diagnostics 与 lifecycle没有被塞进 Pluxel core。

### Runtime correctness

- layout-only read 创建 0 grant、0 ViewSession、0 Model subscription、0 remote registration/manifest request；
- View 只能取得 `uses` 声明的 Model，普通 property reflection 对未授权 key 返回 `undefined`；
- target/provider stop、replacement、rollback、browser disconnect 与 StrictMode-like mount replay都不泄漏 session/subscription/asset；
- action cancellation、late result、read invalidation race、reconnect 和 last-known-good有确定测试；
- Attachment 不扫描或自动选择 renderer，不跨 required dependency edge；
- Workbench disabled/headless management fixture不构造任何 vNext backend。

### Federation delivery

- Workbench Shell 只使用一个 MF Runtime instance，Plugin UI 只通过标准 Manifest/Snapshot + remote expose加载；
- 不同 Plugin producer可 bounded parallel build；
- 打开一个 View 不下载同 producer 的未使用 View expose chunks；
- Shell 与全部 remotes 只加载一个满足策略的 React/ReactDOM实例，MF DevTools可验证 shared winner；
- platform shared 命中率、重复依赖、manifest/remote/expose/Bridge load trace可观测；
- 不使用 optional UI foundation 的 producer不下载对应 Mantine/Tabler/TanStack Virtual代码，Workbench remotes永不依赖 Worksplit；
- Manifest或新 remote revision失败时保留 last-known-good，且不会让旧 Bridge View越过已撤销的 Model grant；
- React Bridge producer不 import official router/store/split，Shell private Context不成为 shared contract。

## 14. 否决条件

- vNext 只是给现有 Contract/Extension/Port 改名并保留相同 wiring；
- Feature 获得 runtime address、enable/disable、grant 或独立 lifecycle；
- Attachment 退回字符串 registry、候选扫描、priority 或 fallback；
- Model 只是 events alias，仍需 author initial emit 或 browser自建 authoritative cache；
- action 只靠 TypeScript method interface，没有 runtime input/result validation；
- layout snapshot继续携带所有 resource grant；
- 在 MF Manifest外再建立可替换的 Workbench artifact manifest、plain ESM loader或 renderer adapter；
- 把 MF 2.0 降为可选 delivery，或者让业务 Plugin自行实现 remote loading/share resolution；
- 每个 remote各自打包 React/ReactDOM，或 shared version不满足时静默接受第二份 React；
- remote直接依赖 Shell router、workspace store或 Worksplit；
- 为 migration 建立长期双栈、silent fallback 或自动旧 manifest adapter；
- 新 public abstraction没有删除三个样本中的重复文件、状态 owner 或 runtime scan。

## 15. 仍需原型回答的窄问题

1. Feature generic schema slot 在 TypeScript declarations 中能否保持 platform-specific diagnostics 与 action input 的 exact inference，
   而不复制 `workbench.feature()` 的整个泛型表面？
2. Model action 成功后的 refresh 应等待新 revision publication再 resolve，还是 action resolve 与 snapshot更新分开；哪一种在 Bot reconnect
   与 Fonts upload 的延迟/错误语义上更诚实？
3. 同一 provider Attachment 被一个 target放置两次时，是复用一个 Model session还是 define-time拒绝；当前样本只需要一次 placement。
4. 一个 Plugin definition 一个 producer、每个 View 一个 expose是否能同时满足 Attachment renderer与 BotAdmin多页面按需加载，还是需要
   producer内稳定的 application descriptor expose？
5. React/ReactDOM之外哪些 Workbench/Mantine package应进入 platform shared；以 bundle、singleton Context需求和 MF DevTools reuse事实决定，
   不由直觉扩大集合。
6. `loaded-first` 是否适合全部 dynamic Plugin；哪些严格版本场景必须使用 `version-first` 或独立 share scope？
7. 每个 View使用独立 React Bridge application，还是每个 Plugin remote一个 Bridge application并在内部切 route；以 mount成本、ViewSession
   cleanup和按需 chunk结果决定。
8. 隔离 Vite MF build与统一 Rspack/Rsbuild的吞吐、HMR、shared tree shaking和 Manifest一致性差异是否足以确定唯一 compiler？
9. immutable manifest revision、distribution签名与 MF Runtime last-known-good remote registration如何组合，才能既不修改 global Snapshot，
   又保证失败更新不会污染当前 View？

这些问题都可以用 Wretch、Fonts、BotAdmin 三条纵向 fixture 回答，不需要先引入更多 renderer、slot 或 Feature runtime。

## 最终判断

现有两个提案的 ownership判断大多正确，但一个停在旧 Contract/Port组合，另一个试图抽象掉 MF。后者不符合 Workbench 的产品本质：
Workbench 与插件 UI 构成的就是微前端系统，而 MF 2.0 是目前社区中覆盖 remote、shared、manifest、runtime、types、DevTools 和 Bridge
最完整的一套架构。Pluxel 没有足够理由建立平行协议。

vNext 的核心应明确写成：

```text
MF 2.0 host/consumer + Plugin producers/remotes/exposes
  + Manifest/Snapshot + Runtime Plugins
  + shared platform + Bridge lifecycle
  + authoritative Model + define-time Feature
  + exact dependency Attachment + least-authority ViewSession
```

MF 2.0 负责微前端模块系统，Pluxel 负责 Plugin graph与 capability control plane。它让 BotManager继续只是业务 owner，让 Wretch/Fonts的
共享 UI沿真实 dependency edge工作，让 Shell/remotes复用同一 React与 UI foundation，并把网络和运行时成本收敛到用户实际打开的 expose，
同时保留社区现成的 preload、shared negotiation、类型、诊断和演进路径。
