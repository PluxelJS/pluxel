# Workbench Plugin-owned Composition

> 状态：research proposal。本文讨论如何复用一组 Workbench 页面与资源声明，不是当前 API。
> 当前事实以 [`../WORKBENCH.md`](../WORKBENCH.md) 和 [`../FRONTEND.md`](../FRONTEND.md) 为准。

## 决策摘要

第一阶段不增加 `Feature` registry、通用 slot、第二种 mount 或多页面 Port。Workbench runtime 继续只认识：

- 一个 Plugin node target；
- 该 owner 唯一 mount 的最终 Contract、Binding 和 UI entry；
- Contract 中的 resources、Views、placements 与 Port outlets；
- 与 owner generation 一起签发和撤销的 artifact、resource lease 与 opaque grant。

“Feature”只作为分析和作者代码组织概念：普通 library function 可以生成一组 resources、Views 和 placements，consumer
最终调用一次 `workbenchContract.define()`。生成结果在 mount 前已经扁平化，不取得 runtime identity、独立 lifecycle、独立 grant
或第二个 bundle。

Port 继续解决一个更窄的问题：consumer 拥有 target、placement 和 resource authority，而另一个 Plugin owner 提供 renderer。
Wretch HTTP 设置符合这个模型；四个平台共享 Bot 管理工作流不符合，因为 renderer 是普通 library code，页面和资源仍由每个平台拥有。

只有 application-level builder 无法在至少两个无关领域中消除相同的手工合并，并且新增 core primitive 能净删除代码时，才研究
`workbenchContract.compose()`。即使届时增加，它也只能是 define-time 的严格扁平化工具，不能形成新的 runtime Feature 模型。

## 为什么现在重新判断

当前 Contract 以 `resources + views + outlets` 描述完整 contribution，Extension 再增加 server-only UI entry，Binding 把资源绑定到
owner Context。这个结构正确表达了安全和生命周期，但作者很容易把“一个 View”误当作主要复用单位。

`local-projects/chatbot` 暴露的是另一种重复：Telegram、KOOK、Milky、Discord 各自拥有 Plugin、Bot manager、资源 Binding 和
bundle，却重复声明同一工作流拓扑：

| 页面       | placement                                   | 用途                                  |
| ---------- | ------------------------------------------- | ------------------------------------- |
| `Overview` | plugin tab                                  | 当前平台 Bot 摘要                     |
| `Manager`  | `/settings` navigation route                | 平台 Bot 列表与操作入口               |
| `Account`  | `/accounts/:accountId` non-navigation route | 原生 document tab 中的单 Bot 工作对象 |
| `Create`   | `/create` non-navigation route              | 新建 Bot 流程                         |

四个平台还共享 `BotAdminAccount`、commands、snapshot event helper 和 React panels，但刻意不存在中心 `BotAdminPlugin`。
`package-boundaries.test.ts` 把“平台独立 owner、共享 primitive、没有中心 Plugin”作为架构约束。Telegram、KOOK 和 Milky 另外把
Wretch settings Port 挂到各自 target；Discord 不依赖 Wretch。

因此真实问题不是“如何让中心 Feature 动态接管四个平台”，而是：

1. library 如何复用一组页面拓扑和 UI primitive，同时不夺走 consumer 的 owner；
2. cross-plugin renderer delegation 与普通 library reuse 应如何区分；
3. 哪些 data primitive 是 Workbench 真正缺少的，哪些只是作者层重复；
4. 多个独立 target 如何安全聚合导航，而不合并它们的资源和生命周期。

## 已证实需求

- 一个 Plugin node 仍只 mount 一次；其全部资源、route、tab、outlet 和 bundle 原子发布、原子撤销。
- 共享 package 可以提供 DTO、RPC implementation、React components、route topology builder 和 navigation metadata value，但不必成为 Plugin。
- 每个平台保留自己的 resource Binding、diagnostics subtype、route namespace、title/icon/order 和 optional Wretch outlet。
- 同一 navigation group 中的 route 可以来自多个 owner；聚合不改变 target、grant、bundle 或 stop 行为。
- consumer 能把自己获授权的 resource 显式映射给 provider-owned renderer；renderer 看不到 consumer 的其他资源。
- current-value 数据必须在首次打开、断线重连和 renderer replacement 后得到确定 snapshot，而不是依赖偶然的 event 时序。
- Workbench disabled 时，builder 只是 inert Contract value，不创建 backend、subscription、artifact 或浏览器状态。

## 非目标

本提案不为以下推测性需求建立基础设施：

- 任意第三方在运行时发现、安装或多实例化 Feature；
- renderer marketplace、renderer priority、override/fallback graph；
- header、status bar、dock 或任意命名 slot；
- 通用 settings/CRUD/form DSL；
- Bot、platform、account 等领域概念进入 Pluxel core；
- 一个 PluginPart 单独 mount Workbench contribution；
- 用 Workbench dependency graph 替代 Plugin constructor dependency；
- 让一个 Port 自动取得多个 owner 的数据或做跨插件 query join；
- 为复用 React components 而建立中心 Plugin 或独立 artifact。

## 最小心智模型

Workbench 扩展可以用四个相互独立的问题理解：

| 维度      | 当前最小答案                                             | 不应混入的职责                       |
| --------- | -------------------------------------------------------- | ------------------------------------ |
| Target    | 最终 mount 的 Plugin node                                | shared library、navigation group     |
| Feature   | 作者代码中的一组相关页面和资源                           | runtime identity、独立 lease         |
| Resources | target-owned Binding；Port 中由 outlet 显式映射          | renderer ownership、route ownership  |
| Renderer  | target Extension entry；Port 中可由 provider Plugin 提供 | resource authority、Plugin lifecycle |

关键约束是：Feature 不一定成为系统实体。只有某个东西需要独立寻址、协商、授权或撤销时，runtime identity 才有价值。
Bot 管理页面只需要源码复用；把它升级为 runtime Feature 会凭空增加地址、版本、registry、错误和 cleanup ordering。

### 普通 target-owned View

```text
platform library builder
        │ returns Contract input/value
        ▼
platform Plugin ── one mount ──► final Contract + bindings + entry
                                      │
                                      ▼ opaque target grant
                               platform-owned renderer
```

Contract 是 browser-safe schema。Binding 是 server-side authority。Registry 为 layout 中实际引用的 resource 建立 opaque ref；browser
只有打开 target 后才取得 grant并创建 RPC/live-query/events facade。UI entry 可以 import shared React package，这不会改变 renderer owner。

### Wretch Port View

```text
Wretch Plugin: Port contract + renderer
                         ▲ exact id/version match
                         │
platform Plugin: outlet + placement + explicit resource mapping
                         │
                         ▼ target-scoped opaque grant
                  Wretch renderer usePort(Port)
```

Wretch renderer 的可用期是 provider renderer generation 与 consumer target/outlet generation 的交集。任一方撤销，旧 grant 和 cached
facade 都必须失效。consumer 决定它出现在哪个 tab，并绑定 caller-owned Wretch settings RPC；Wretch renderer 不获得 platform 的
Bot commands/state。

这正是 Port 应保留的价值：它不是 UI slot，也不是共享页面模板，而是 typed resource delegation + foreign renderer selection。

## 第一阶段：只使用 application-level builder

`platform-kit` 应先用普通 TypeScript 函数生成最终 Bot admin Contract，而不是要求 runtime 认识 `BotAdminFeature`。候选作者形态：

```ts
export function defineBotAdminWorkbench<const Account extends BotAdminAccount<object>>(input: {
	descriptor: BotWorkbenchDescriptor
	extraResources?: WorkbenchResourceMap
	configureOutlets?: (resources: unknown) => unknown
}) {
	return workbenchContract.define({
		resources: {
			commands: workbenchContract.rpc<BotAdminCommands>(),
			state: workbenchContract.events<BotAdminEvents<Account>>(),
			...input.extraResources,
		},
		views: botAdminViews(input.descriptor),
		outlets: input.configureOutlets,
	})
}
```

示例只表达边界，不冻结具体泛型或 `extraResources` API。实验实现应优先让 builder 接收领域 descriptor，并在调用处用现有
`workbenchContract.define()` 能自然表达的对象组合；不要为了追求一个漂亮调用形式复制整套 core builder 类型。

每个平台仍然：

- 导出自己的 final Contract 和 Extension；
- 拥有一个本地 UI entry，显式导出 final Contract 要求的 View IDs；
- 一次性绑定自己 manager 的 commands/current snapshot；
- 需要 Wretch 时显式增加 resource 和 outlet；
- 在 stop/replacement 时随自己的 Context 撤销全部 contribution。

这个实验回答两个问题：重复究竟是 chatbot 领域 topology，还是 core 缺少通用组合；TypeScript 是否能在不增加 core API 的前提下保留
resource、binding 和 View export 的完整推导。

## 暂不增加通用 Contract fragment

看似自然的 API 是 `fragment()` + `compose()`，但目前它必须立即回答一组没有真实答案的问题：

- resource/View/outlet key 冲突是报错、覆盖还是自动 namespace；
- placement order、相对 route 和 navigation metadata 能否由 consumer 改写；
- fragment 能否携带 entry，若能，最终 artifact 是一个还是多个；
- fragment version 是否参与 compatibility、fingerprint 或持久化 identity；
- fragment 能否单独撤销，以及撤销时 target route/tab 如何收敛；
- Binding 是 nested record 还是继续 flat exact match。

如果 fragment 在 define-time 完全展开，application builder 已能完成相同工作；如果不完全展开，它就引入第二层 runtime model。
在只有 Bot admin 一个多页面复用证据时，两者都没有足够收益。

未来只有满足全部条件才研究 `compose()`：

1. 至少两个无关 workspace domain 都重复实现相同的严格 merge/collision/fingerprint 逻辑；
2. application builder 无法保持 final Contract、Binding 和 UI export 的类型推导；
3. 候选 API 不允许覆盖，key/path/Port collision 一律 fail-fast；
4. compose 后 runtime model、layout protocol、grant 和 lifecycle 与手写单 Contract 完全相同；
5. 它净删除 public concepts 或调用代码，而不是只把 object spread 改名。

## 相邻但独立的真实缺口

### 1. Authoritative snapshot resource

chatbot 的 `BotAdminEvents` 只有 `{ snapshot }`，每次 browser subscription 都先 emit 一份 current value。Access/Sandbox catalog
也有类似的“事件流承载当前事实”模式。这表明 Workbench 可能缺少 process-local、只读的 snapshot resource，但它不是页面组合问题。

应另做一个小型实验，比较现有 events 与候选：

```ts
state: workbenchContract.snapshot({ value: BotAdminSnapshotSchema })

state: workbench.bind.snapshot({
	getSnapshot: () => manager.snapshot(),
	subscribe: (invalidate) => manager.subscribe(invalidate),
})
```

候选语义必须包括初始 snapshot、单调 revision、schema validation、reconnect recovery、last-known-good、subscribe cleanup 和 owner withdrawal；
它是 readonly resource，mutation 仍走 RPC。没有实现并测量这些语义前，不在本提案中把 `snapshot()` 承诺为 public API，也不把
`events` 改名伪装成 state。

独立提案的成立门槛是：至少两个真实 owner 能删除自制 initial emit/reconnect glue，且 transport 状态机比 events convention 更少，
而不是仅让 hook 名称更好看。

### 2. Navigation group consistency

多个 owner 使用相同 group ID 是当前受支持的 host projection，但相同 ID 的 label/icon 若不一致，不能由注册顺序决定“第一个获胜”。
这是确定性和诊断问题，不需要 Feature registry。

最小修正应是：同一 global layout snapshot 内，group ID 对应的 non-empty label/icon 必须一致；冲突 contribution 以稳定诊断拒绝，旧的
last-known-good layout 保持可用。chatbot 可以从 `platform-kit` 导出一个普通冻结的 `BotsNavigationGroup` value，四个平台复用它。
现有 inline group object 已能接受这个 value，因此没有证据需要新增 navigation-group token API。

## Port 是否应该扩展成多页面 Feature Port

当前答案是不应该。

让 Port 描述多组 Views/routes 看似可以复用 Bot admin，但会把以下职责错误交给 provider：consumer 的 route namespace、导航文案、
document identity、页面集合、artifact delivery 和 renderer lifecycle。对于纯 `platform-kit`，甚至没有 provider Plugin generation 可以成为
foreign renderer owner，只能再制造一个中心 Plugin，这与真实 package boundary 相反。

只有出现真实 capability provider，同时满足以下条件，才重新研究多-View Port：

- provider 必须拥有 renderer 实现与独立 artifact；
- 多个 consumer 只拥有数据和 placement policy；
- 整组页面必须随 provider generation 原子升级/撤销；
- 单 View Port + consumer-owned routes 会造成已测量的错误或不可维护重复。

在此之前，Port 保持 tab-only 是有意的窄边界。新的 cross-plugin route outlet 会扩大 shell navigation authority，不能作为便利语法加入。

## Ownership、生命周期与安全不变量

无论 application builder 将多少页面称为一个 Feature，最终实现必须保持：

- owner address 仍是 Plugin node address，不从 feature/library/view label 推导；
- 一个 node 一个 mount lease，全部 registration 要么成功发布，要么完整回滚；
- resource Binding 与 Contract resource keys exact match，不允许 runtime fallback 或隐式查找 provider；
- View 只取得 target snapshot 明确列出的 owner resources 和 Port grants；
- shared source package 不自动获得 owner Context、resource namespace 或 host navigation；
- owner stop/replacement 撤销 route、tab、artifact、RPC/query/event subscription 和 Port outlet；
- Port renderer stop/replacement 不能让 consumer 使用旧 renderer 或用 namespace 重新取得 grant；
- navigation grouping 只合并显示，不合并 target session、bundle、resource cache 或 error boundary；
- disabled Workbench 不执行 builder 之外的任何运行时工作，而 builder 产物本身不得捕获 Context/service。

## 被拒绝的替代方案

### 中心 `BotAdminPlugin`

它会集中四个平台的资源发现、route ownership 和 lifecycle，重新引入已被 package boundary 明确删除的 Hub。shared UI/DTO 不等于 shared
runtime owner。

### 通用 Feature registry

当前没有动态 discovery、独立 enable/disable、多实例或跨 target 安装需求。registry 只会增加 identity、version negotiation、ordering、
withdrawal 和错误面。

### 所有共享 UI 都使用 Port

普通 library import 不跨 authority boundary。强制 Port 会把源码复用转成 runtime provider dependency，并让 consumer 为自己的页面经过
foreign renderer negotiation。

### 一个 View 一个 Extension/mount

这会拆散 owner 的原子 layout revision和cleanup，并让 PluginPart/React effect 参与资源生命周期。唯一 owner mount 是应保留的简化。

### 自动按 resource 名称注入

名称不是 authority。Port 必须继续用 typed contract 和显式 mapping；普通 View 只取得 final target Contract 的 grant。

### 任意 slot system

当前只有 `plugin.tabs` 和 `plugin.routes` 两种已证明的产品语义。把 placement 抽象成字符串 slot 会把 host ownership、权限和 fallback
隐藏在非结构化名称中。

## 分阶段验证

### 阶段 A：chatbot-only experiment

在 `platform-kit` 中实现普通 builder，四个平台仍各自生成 final Contract、entry 和 single mount。先不改 Pluxel public API。

记录：

- 删除的重复 route/resource declaration 行数；
- 每个平台仍需提供的 descriptor、diagnostics、bindings 和 optional outlet；
- TypeScript 是否仍能检查 binding exactness 与 View exports；
- UI artifact 数量、resource 数量和 browser session 数是否完全不变。

### 阶段 B：core correctness hardening

独立修复 navigation group metadata 冲突，使结果与 mount/registration 顺序无关。它不依赖 builder 是否成功。

### 阶段 C：snapshot resource experiment

用 Bot admin 加另一个非 chatbot fixture 对比 events convention。只有满足前述删除和状态机门槛才形成独立 proposal/public API change。

### 阶段 D：是否需要 compose

等待第二个无关多页面复用用例。若 builder 都遇到相同、无法安全封装的 merge 问题，再提出仅 define-time 的 compose API；否则维持
普通 TypeScript composition。

## 验收条件

- Telegram、KOOK、Milky、Discord 不再手写四份相同 route topology，但仍各自只有一个 Plugin owner、Extension、entry 和 mount；
- 删除或停止任一平台只移除该平台的导航项、target sessions、resources 和 bundle；其他平台继续工作；
- Telegram/KOOK/Milky 的 Wretch tab 仍由 consumer placement + explicit resource mapping + Wretch renderer 组成；Discord 不承担 Wretch dependency；
- `platform-kit` 不包含 `@Plugin`、Context capture、mount、runtime registry 或中心 artifact；
- 同 navigation group metadata 冲突得到确定诊断，不再由 registration order 选择展示文案；
- final Contract fingerprint、Binding exactness、route collision 和 View export validation 不因 builder 放宽；
- Workbench disabled fixture 不创建 resource producer、session 或 artifact；
- 第一阶段不增加 runtime registry、protocol identity、grant kind、bundle、network request或持久化 schema。

## 否决条件

- 为了共享页面而新增中心 Plugin、Feature address、Feature lifecycle 或第二次 mount；
- builder 接受任意 override/merge，导致 resource、View、route 或 outlet collision 静默覆盖；
- shared package 开始依赖 official router、workspace store、Workbench internal transport 或 Plugin Context；
- Port renderer能读取未在 outlet 中显式映射的 target resource；
- 所谓 compose 只是包装 object spread，却引入新的 public type family；
- snapshot resource 只是 events 的别名，仍没有初始值、revision、reconnect 和 cleanup 的明确语义；
- navigation group 修复通过建立 group lifecycle/registry，而简单 snapshot validation 已足够。

## 尚待实验回答

1. `platform-kit` builder 是否能在不复制 `workbenchContract.define()` 泛型表面的前提下推导 platform-specific Account diagnostics？
2. optional Wretch resource/outlet 最清楚的 application-level 组合位置是在 builder input，还是由每个平台保留一次 final `define()`？
3. shared panels 是否需要四个轻薄 local View wrappers，还是一个 descriptor factory 能减少代码且不产生 render-time component identity？
4. current Bot state 在 reconnect、late subscription 和 artifact replacement 下，现有 events convention 的实际状态机有多少重复？
5. navigation group 冲突应在 owner mount 时拒绝新 contribution，还是在 atomic layout publication 时保留 last-known-good；哪种能给出更稳定的 Plugin start 语义？

这些问题可以由小型 application experiment 回答；在得到结果前，不扩大 core public contract。
