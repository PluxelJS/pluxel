# Portable Workbench Protocol

> 状态：proposal。本文定义第三方 Workbench host 与现有 Plugin 保持兼容所需的候选协议；在实现、测试与当前文档更新前，
> 不构成现行 public API。

## 问题

当前 Workbench 已经把 Plugin authoring 分成 browser-safe Contract、server-only Extension、owner-bound Binding，runtime 也已经
提供 layout、artifact、opaque grant、typed RPC、live query 和 events。但完整解释这些信息、加载 Remote View、维护 target
session 与宿主导航的实现仍主要位于官方 Workbench App 内；root management read model 还分散在 GraphQL、HTTP 与 Cap'n Web RPC。

结果是“Plugin 可以给官方 Workbench 扩展页面”已经成立，但“外部用户可以用另一套架构从零实现 Workbench，并继续运行相同
Plugin”还不是一个有版本、可验证的兼容承诺。Mantine 同时存在于官方 Shell、配置表单和 Module Federation shared list，容易让
实现细节被误认为 Plugin/Workbench 协议的一部分。

本提案要建立的关系是：

```text
Plugin business capability / config / commands
                 │ independent of Workbench
                 ▼
runtime control plane + Workbench protocol
  ├─ management snapshots and mutations
  ├─ layouts, artifacts and navigation metadata
  └─ grant-bound RPC / live query / events
                 ▼
host implementation
  ├─ official Mantine Workbench
  ├─ third-party Vue/Svelte/vanilla shell + React View adapter
  └─ management-only or future renderer adapters
```

## 目标

1. 第三方可以只依赖公开、browser-safe、版本化的协议与 SDK，实现不使用 Mantine 的 Workbench。
2. 同一个 Plugin package、Contract、Extension 和 Binding 不因 Workbench host 更换而重新编译或改写业务代码。
3. 官方 Workbench 成为协议的一个实现和 conformance fixture，而不是协议事实的唯一拥有者。
4. 普通配置、启停、依赖选择、日志与管理操作不要求 Plugin mount 自定义 View。
5. Plugin 只有在 schema、command 和通用 read model 无法表达领域交互时才发布 Remote View。
6. Workbench disabled/headless 时，Plugin 业务能力和配置事实仍然成立，不引入 browser backend 成本。
7. 同一套声明式 management surface 可以被官方 Workbench、第三方 Workbench、CLI 或其他 carrier 投影，不把表单和信息卡绑定到
   某个前端组件库。

## 非目标

- 不把 Workbench 变成 Plugin 的业务 API 或生命周期前提。
- 不建立 Context global event bus、任意 namespace RPC 或允许浏览器枚举未授权 Plugin resource。
- 不要求第三方 Workbench 复刻官方路由、Tab、分栏、分类或持久化布局。
- 第一阶段不承诺 Plugin 作者可以用任意 UI framework 发布 View；“Shell 可替换”与“View renderer 可替换”是两个不同问题。
- 不把 Valibot validation、数据库 schema、Context、Plugin instance 或 server object 传到浏览器。
- 不保证不同 Workbench 对同一 Contract 呈现相同视觉效果，只保证能力、身份、生命周期与交互语义兼容。

## 当前可复用事实

以下现有设计直接进入候选协议，不另造平行概念：

- `PluginNodeAddress` 是跨边界 owner/target identity；display name 只用于展示。
- `WorkbenchContract` 声明 resource、View、placement 和 Port，Contract fingerprint 用于 artifact/layout 校验。
- `WorkbenchLayout` 提供 target-scoped View、placement、resource grant 和 Port binding。
- `WorkbenchCatalog` 提供按 owner 发布的 Remote artifact 与 build state。
- resource 只有 `rpc`、`liveQuery`、`events` 三种；mutation 走 RPC，query/events 保持各自的 revision 与连接状态。
- opaque grant 绑定 resource、owner generation、target 和 graph revision；stop、replacement 或 graph change 会撤销旧 grant。
- host 注入 locale、color scheme、notify、confirm、受限 navigation 和 route params，不向 View 暴露宿主 store/router。
- owner effects 负责 mount、factory、stream、query 与 grant cleanup。

这些概念的 wire representation、版本协商和公开 host SDK 仍需由本提案补齐。

## 可标准化的兼容面

Workbench 兼容协议应标准化语义和生命周期，而不是标准化官方页面。候选边界如下：

| 兼容面               | 标准化内容                                                                 | 不进入协议                           |
| -------------------- | -------------------------------------------------------------------------- | ------------------------------------ |
| Plugin identity      | definition/node address、owner/target、revision                            | class name、display name identity    |
| discovery            | protocol version、feature、renderer ABI、transport capability              | 官方 App/package version             |
| management surface   | settings、state、actions、collections 的 schema、revision、result 与权限   | Mantine component、页面排版          |
| config application   | desired/applied revision、validation、restart/live apply、失败与冲突       | Plugin 内部 client/resource 实现     |
| Workbench Contract   | resource、View、placement、Port、fingerprint                               | router/store/split 实例              |
| resource transport   | RPC、live query、events、grant、withdrawal                                 | 任意 namespace access                |
| Remote View artifact | renderer kind/ABI、entry、assets、contract fingerprint、shared requirement | 官方 MF loader 内部状态              |
| host capability      | locale、scheme、notify、confirm、navigation intent、view state             | Mantine theme、CSS class、DOM handle |

这张表也是 public compatibility 的上限：官方 Workbench 可以在协议之上增加产品布局和视觉设计，但 Plugin 不能依赖这些实现细节。

## 声明式 Management Surface

要让第三方 Workbench 在不理解 Plugin 业务实现的情况下提供有用界面，runtime 需要投影一组不包含 View code 的声明式 surface：

```text
settings     持久 desired state，schema validation，restart/live apply
state        当前 applied/runtime snapshot，只读、带 revision
actions      一次性 mutation/query，typed input/output，可由 schema 生成表单
collections  可分页/刷新/订阅的 typed rows；只在真实集合需求出现时使用
views        以上 primitive 无法表达时的 Remote View escape hatch
```

这里的 “surface” 是协议 read model，不是新的前端 extension point。宿主拥有 renderer：同一个 `settings` 可以被 Mantine、Vue、原生 HTML、
CLI prompt 或自动化 client 呈现；Plugin 只声明数据、行为、权限和生命周期语义。

### Settings 不是所有表单的统称

表单是输入呈现方式，不能决定业务语义：

- 需要跨重启保留、代表目标策略的输入属于 `settings/config`；
- `refresh`、`scan`、`send test message` 等一次性输入属于 typed action，Workbench 可以从 action input schema 生成表单；
- queue depth、connection state、last sync、applied revision 等信息属于只读 state；
- 需要浏览、过滤、分页或持续 patch 的数据才进入 collection/live query；
- 只有复杂编辑器、可视化、画布和连续领域工作流进入 Remote View。

这样可以扩展 config 的运行时能力，但不会把 config 变成第二套 command bus、read model 或 UI DSL。

### 复用现有作者事实

第一选择是投影已有声明，不要求 Plugin 为 Workbench 重复注册：

- `configs.use(ObjectSchema)` 自动产生 settings schema、defaults、presentation 和 apply status；
- owner-bound command descriptor 自动产生 action/query descriptor，已有 input/output schema 继续作为唯一 contract；
- runtime/Plugin lifecycle 自动产生 enabled/running/failed、generation 和 config applied status；
- 只有缺少可复用事实的只读领域状态，才评估最小 owner-bound read-model declaration。

新增 read-model author API 前必须用真实 Plugin 证明 command query、现有 live query 或 runtime status 不能诚实表达需求。不得仅为了让页面出现一张
信息卡就新增第二套注册系统。

### Presentation 与行为分离

surface descriptor 可以包含 label、description、group、order、sensitivity、format 和 control hint，但这些只是可忽略的 presentation hint。
字段 identity、schema、validation、action behavior、revision、权限和错误 code 才是兼容语义。第三方 Workbench 可以选择完全不同的布局或控件，
也可以只实现文本/CLI projection。

presentation metadata 必须 browser-safe、可序列化且有版本；不得包含 React component、render callback、Mantine props、CSS class 或宿主路由。

## 兼容层级

### Level 1：Management Host

替代 Workbench 可以不加载任何 Plugin UI artifact，只实现：

- runtime/application metadata；
- Plugin catalog、status 和 lifecycle mutation；
- schema-derived config editor、server validation 与 apply status；
- dependency/default-provider selection；
- commands、logs、安全状态及宿主明确发布的其他 root management capability。
- Plugin 声明式 state、actions 和 collections（若 runtime 宣布对应 feature）。

Level 1 必须足以管理没有自定义 View 的 Plugin。Plugin 不能为了获得配置表单、启停按钮或普通 command 按钮而 mount Workbench
Extension。

### Level 2：Compatible View Host

替代 Shell 可以使用任意前端架构，但通过 Pluxel 提供的 renderer adapter 承载现有 Plugin Remote View。第一阶段的标准 adapter
是 React ABI；Vue、Svelte 或 vanilla Shell 可以把 React View 作为隔离的 host island 挂载，Shell 本身不需要使用 Mantine。

Level 2 host 必须实现 target session、layout revision、artifact replacement、grant 撤销、route matching、locale 与 host capability
注入。它可以选择完全不同的导航、Tab 和页面布局，只要不改变 Contract 中 route/placement 的可观察语义。

### Level 3：Multiple View Renderers

未来只有在至少出现一个真实的非 React Plugin View 和一个外部 host 后，才研究多 renderer artifact。候选 artifact descriptor 至少需要：

```ts
type WorkbenchRendererDescriptor = {
	kind: 'pluxel.react' | string
	abiVersion: number
	entry: string
	requiredShared: readonly { packageName: string; version?: string }[]
}
```

renderer adapter 负责 module setup、View mount/unmount 和 host capability bridge；layout、grant、RPC、query、events 与 Plugin lifecycle
不因 renderer 改变。不得为每种 framework 复制一套 Workbench resource protocol。

Level 3 不是 Level 1/2 落地的前置条件。

## 协议分层

### 1. Discovery 与协商

runtime metadata 必须返回独立的 Workbench protocol version、支持的 resource kinds、renderer ABI、transport capability 和可选 feature。
host 必须在取得 catalog/layout 或发出 mutation 前完成协商。未知 required feature 必须 fail closed；未知 optional feature 可以忽略。

版本不能依赖官方 Workbench package version、Mantine version 或 build hash。协议 DTO 在网络边界从 `unknown` 做 runtime validation。

### 2. Root management plane

root management 使用 framework-neutral、公开的 `@pluxel/runtime/web` contract。最终只能保留一个规范 use case 和一种稳定结果类型；HTTP、
RPC 或未来 carrier 只是 transport projection，不能各自复制状态和 mutation 逻辑。

当前 GraphQL query 与 Runtime RPC 的拆分应被删除或收敛。实施前先审计是否存在独立 external GraphQL consumer；若存在，GraphQL 可以
保留为同一 use case 的可选 projection，但不能继续成为官方 Workbench 才能解释的状态来源。

所有可分支失败必须使用稳定 code，不依赖 message。mutation 至少返回被修改对象 identity、accepted revision、applied state 与冲突信息。

### 3. Workbench extension plane

layout、catalog、bundle event 和 resource ref 应成为版本化 transport DTO，不泄露 registry、compiler 或官方 App store。host SDK 负责：

- catalog/layout snapshot 与 SSE revision gap recovery；
- target 引用计数和 session cleanup；
- artifact load、contract fingerprint 校验与 last-known-good replacement；
- grant-bound RPC、live query、events client；
- owner/target identity、route params 和 Port resource 注入；
- owner withdrawal 后拒绝 cached client 越过旧 grant。

当前官方 App 内的通用 `WorkbenchClientRuntime` 逻辑应下沉为 browser-safe host SDK；React hooks、Mantine notification 和官方 workspace
controller 留在各自 adapter/App 中。SDK 不得 import React、Mantine、router 或官方 store。

### 4. Renderer ABI

Plugin artifact 必须显式声明 renderer kind 与 ABI，而不是由 remote module shape 或 shared dependency list 猜测。React adapter 可以继续复用
Module Federation，但 MF 是 artifact delivery mechanism，不是 root management 或 resource wire protocol。

MF2 是第一阶段 Remote View 的标准 delivery adapter。Pluxel 应稳定自己的 artifact descriptor、renderer ABI、exposed module、asset graph、
shared requirement 和 replacement 语义，而不是把某个 `@module-federation/*` runtime object 当成 public API。其他 delivery mechanism 若未来出现，
必须消费相同 Contract/layout/grant 协议，不能形成另一种 Plugin View 语义。

第一阶段从 mandatory shared contract 移除 Mantine。官方 Plugin 若选择使用 Mantine，可以声明 renderer dependency，由官方 host 提供，
或按 artifact policy 自带兼容副本；这不能影响不使用 Mantine 的 Plugin 和第三方 host。React 与
`@pluxel/runtime/workbench/ui` 是否继续作为 React ABI singleton，由实现实验决定。

CSS ownership 必须可验证：artifact 声明自己的 assets，host 保证装载/撤销顺序并避免把官方 Mantine reset 当成 Plugin 正确渲染的隐式前提。
Shadow DOM、iframe 或 scoped CSS 不是默认要求；若真实冲突证明普通 asset ownership 不足，再独立选择 isolation mechanism。

### 5. Host capabilities

host capability 使用小而稳定的语义接口，不暴露组件或 store：

- locale 与 formatting；
- light/dark color scheme，以及未来经验证需要的中立 design tokens；
- notification 与 confirmation intent；
- Contract route 内的 navigate/open intent；
- route params 与 host-owned view state。

Mantine component、theme object、router instance、Tab store、split handle 和 CSS class 都不得进入协议。第三方 host 可以不支持 optional
capability；Plugin View 必须能检测 capability absence，不能获得伪造成功的 null service。

## 配置与无自定义 UI 的交互

配置 declaration/validation 继续只有 Plugin object schema 一份。为了让任意 Workbench 渲染通用表单，runtime/toolchain 应提供一个版本化、
可序列化的 presentation plan，包含字段 path、类型、label、description、group、secret prohibition 和控件 hint。它不是第二套 validation
语言：browser 可以做基础输入反馈，server 仍使用原 schema 做权威 validation、default 与 transform。

当前 schema source string + `new Function()` 应由 presentation plan 或可复用现有 artifact pipeline 的 browser schema artifact 取代；选择标准是
CSP、HMR、复杂 schema fidelity、删除量和外部 host 实现成本。不能要求第三方 host 执行 Pluxel 官方 Mantine form renderer。

配置 mutation 还必须区分：

```text
desired revision -> validated snapshot -> apply policy -> applied revision
                                             ├─ restart (default)
                                             └─ explicit live apply
```

- endpoint、driver、数据库等资源配置默认走正常 Plugin restart/commit；
- Plugin 明确注册 live apply contract 后，简单运行策略才可以不重启更新；
- refresh、pause、scan 等瞬时操作使用 command/RPC，不伪装成 config；
- live apply 失败保留旧 applied snapshot，并返回稳定 code；owner stop/replacement 会取消 in-flight apply；
- alternative Workbench 与 official Workbench 必须调用同一个 config use case，不能拥有不同 apply 行为。

live config 的 Plugin author API、staging/rollback 与 dependent closure 属于独立实现设计；在这些语义完成前，control plane 不得只保存 raw record
却宣称 running Plugin 已经应用新值。

除完整 config submit 外，协议可以提供 field/section patch 作为 carrier convenience，但 server 必须重新校验完整 object snapshot。是否 debounce、
自动提交、显示 Apply 按钮或要求确认由 Workbench renderer 决定；这些 UX 选择不能改变 revision、validation 和 apply 结果。

只读 runtime state 与 config status 应能出现在同一 Plugin 管理页，但不能写回 config object。例如界面可以同时展示 desired endpoint、当前连接的
applied endpoint、连接状态和最后错误；其中只有 desired endpoint 是 config mutation target。

## Plugin 作者选择规则

```text
能由 object schema 表达？       -> config，无 Extension
能由 command 表达？             -> command，无 Extension
只需标准 snapshot/list？        -> 声明式 state/collection 或已有 resource primitive
需要领域布局、可视化或连续交互？ -> Contract + Extension + Remote View
```

Workbench mount 仍是 custom View/resource publication 的唯一入口，但不是 config、commands 或业务 capability 的注册入口。官方文档和模板不得
为了展示 Plugin 存在而默认生成空 View。

## 安全与生命周期

- root management authorization 与 grant authorization 分离；取得 catalog 不等于取得任意 Plugin RPC。
- grant 必须绑定 owner generation、target、resource kind 和 graph revision，并允许服务端立即撤销。
- cached RPC stub、query client 或 event subscription 在 grant 撤销后必须失败，不能自动按 namespace 取得新 grant。
- artifact URL、route path、DTO、query params 和 RPC input 都是不可信输入，需要校验和 size/budget policy。
- host 只消费序列化 DTO，不取得 Context、Plugin instance、database handle、schema object 或 secret。
- Workbench disabled 时不创建 layout/artifact/resource transport；root headless management 是否启用由独立 host policy 决定。

## Package 与依赖边界

候选边界如下，最终名称可在实现前调整，但职责不能重新混合：

- `@pluxel/runtime/web`：framework-neutral wire DTO、transport client、discovery 与 management use case projection；
- browser-safe Workbench host SDK subpath：layout/catalog/session/artifact/grant client，不依赖 UI framework；
- `@pluxel/runtime/workbench/contract`：Plugin browser-safe author contract；
- `@pluxel/runtime/workbench/ui`：当前 React Plugin View adapter；
- official Workbench App：Mantine Shell、router、workspace policy 和产品布局。

不得让第三方 host import `@pluxel/runtime/internal`、runtime-dev compiler、官方 App source 或 private registry 才能达到 Level 1/2。

## 实施阶段

### Phase A：冻结并验证现状

1. 列出现有 meta、management、layout、catalog、artifact、grant 和 event DTO，标注 public/internal 与 runtime validation。
2. 用同一 use case 收敛重复的 GraphQL/RPC mutation/query。
3. 为 protocol discovery、revision、error code 和 feature negotiation 建立版本。
4. 修正 config 保存与实际 apply/restart 不一致，并区分 desired/applied。
5. 盘点 config、commands 和 lifecycle 已能自动生成的 management surface，避免新增重复 Plugin author API。

### Phase B：可替代 Management Host

1. 提供 framework-neutral client 与 serializable config presentation。
2. 做一个不依赖 React/Mantine 的最小管理 host fixture，覆盖 catalog、settings、state、action、启停和错误恢复。
3. official Workbench 改为消费同一公开 client，删除 private parallel interpretation。

### Phase C：可替代 View Host

1. 提取 framework-neutral session/artifact/grant runtime。
2. 给现有 React Remote View 定义显式 ABI 与 adapter。
3. 用一个非 Mantine Shell（可为 Vue、Svelte 或 vanilla）承载真实 workspace Plugin View。
4. 验证 HMR replacement、grant withdrawal、Port、route、dirty state 和 cleanup。

### Phase D：评估多 renderer

只有真实非 React Plugin 与 host 存在后才启动。若 React island 已满足外部 host 且多 renderer 会复制大量 lifecycle/SDK，则保留单 React View ABI。

## 验收条件

- 同一个构建后的 Plugin package 可同时用于 official Workbench 和至少一个非 Mantine reference host。
- reference host 不 import official Workbench App、Mantine 或 runtime internal entry。
- Level 1 host 能管理没有 Extension 的 Plugin，并能根据同一 presentation plan 自行渲染配置表单。
- 同一 typed action 可以由 official Workbench、reference host 与非浏览器 carrier 调用，且不要求 Plugin 注册 View。
- reference host 能同时展示 desired config、applied revision 与只读 runtime state，不把 state 写进 config record。
- Level 2 host 能运行 package-manager 之外至少一个包含 RPC、query/events 或 Port 的真实 Plugin View。
- official 与 reference host 对 identity、revision conflict、validation failure、grant expiry 和 owner replacement 得到相同稳定结果。
- Plugin stop/replacement 后，两个 host 中 cached resource 都不能继续调用旧 generation。
- config mutation 的返回值能够区分 saved/desired 与 applied；live apply 失败不会伪报成功。
- Workbench disabled 测试证明 Plugin 核心生命周期、commands、config validation 与业务 API 不依赖 host SDK。
- production build、Vite source、HMR、static/dynamic host 和 test host 都覆盖同一 protocol version。

## 否决条件

- 第三方 host 仍需复制官方 App store、读取 internal endpoint 或依赖 Mantine 才能解释 Plugin。
- 为 external host 新增第二套 Plugin RPC/config API，而 official host 继续使用旧路径。
- presentation plan 复制 Valibot transform/validation，形成第二种 schema authority。
- 为支持多 framework 复制 layout、grant、resource 或 lifecycle protocol。
- config 字段变成 live Proxy，但已按旧配置建立的资源没有原子 reconfigure/restart 语义。
- renderer abstraction 在没有真实第二实现时扩大 Plugin 作者 API 或迫使所有 Plugin 打包多个前端版本。

## 未决问题

1. Level 2 React adapter 应由 `@pluxel/runtime/workbench/ui` 扩展，还是拆成独立 host-renderer package？
2. React ABI 的 mandatory singleton 最小集合是否只有 React、React DOM 和 Workbench UI adapter？
3. CSS asset cleanup 是否足以隔离不同 UI library，还是需要 opt-in Shadow DOM/iframe renderer？
4. config presentation 选择 serializable plan、browser schema artifact，还是按 schema complexity 分级？
5. root management 最终使用 typed RPC、versioned HTTP resource，还是两者共享同一 use case 的等价 projection？
6. management-only host 在 Workbench Plane disabled 时是否属于独立 control-plane capability，如何保持零成本语义？
7. renderer required feature 与 optional host capability 的版本协商采用整数 ABI、feature set，还是二者组合？
