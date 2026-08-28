# Plugin dependency observability 与 Workbench graph

> 状态：research proposal。本文只定义尚未实现的 Management read model 与官方 Workbench 消费方式；
> 当前 API 仍以 [`../WORKBENCH.md`](../WORKBENCH.md)、[`../RUNTIME.md`](../RUNTIME.md) 和
> [`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md) 为准。

## 要解决的问题

当前 Plugin 详情页调用 `management.dependencies.list(owner)`，只得到当前 Core 已解析的 dependency node，随后又把它们投影成
没有 required/optional 区别的通用列表。`dependencies.inspect(owner)` 面向 required provider 选择，能够展示 requirement、default、
override 和候选 provider，但不包含 optional integration，也不适合全图逐节点调用。

因此官方 Workbench 目前不能一次回答这些常见问题：

- 这个 Plugin 的 required dependency 与 optional integration 分别是什么；
- 一个 provider 被哪些 consumer 使用，停用它会影响哪里；
- 当前真正参与 lifecycle ordering 的有效图是什么；
- disabled、blocked 或 absent provider 在声明关系中处于什么位置；
- provider 是 direct、provider default 还是 consumer override 选中的。

这不是新的 Plugin 作者能力，也不是第二个 lifecycle engine。目标只是把 Runtime 已经拥有的 catalog、RuntimeState、reconciler、
Core graph 和 status facts 投影成一个 browser-safe、只读且可缓存的 Management snapshot。

## 最小设计原则

1. **只新增一个 read model。** 不新增 graph service、registry、subscription protocol、mutation DSL 或 Core public graph。
2. **只公开稳定语义。** DTO 描述 consumer、requirement、provider、required/optional 和 effective membership，不描述 constructor
   parameter、import syntax、Part occurrence、callback、slot、generation 或 radix table。
3. **声明关系与有效图共用一份 snapshot。** Workbench 用筛选生成不同视图，不让 Runtime 维护两张近似的公共图。
4. **查询零物化。** disabled、absent、orphan 和非法引用不能因 graph read 创建 Core slot/record、Context、artifact 或 effects。
5. **mutation 继续走现有 use case。** provider selection、fork 和 enable/disable 不进入 graph DTO；需要候选项时仍惰性调用
   `dependencies.inspect()`。
6. **先服务现有 UI。** 不为尚未出现的多 runtime graph、跨 host federation、历史时序分析或通用 graph SDK 增加字段。

## 统一概念

### Requirement、provider 与 edge

- **requirement** 是 consumer declaration 中的 Plugin definition address；它可以指向 concrete Plugin definition，也可以是 abstract
  provider token。
- **provider** 是当前 policy 能确定的 Plugin node address；它可能尚未 enabled、available 或 running。
- **edge** 按 `consumer node + requirement definition` 聚合。root、多个 Part 和 nested Part 的来源不进入公共 identity。
- 同一 requirement 同时以 required 与 optional 出现时，公开 mode 为 `required`。Optional setup callback 仍由 Core 执行，但它不是
  Workbench 需要单独寻址或治理的第二条 dependency edge。

这种聚合遵循当前 owning Plugin graph，而不是把源码结构固化进管理协议。未来 Plugin/Part 作者模型变化时，只要仍能产出相同的
consumer/requirement/provider 语义，Workbench 不需要跟随重写。

### 声明关系与有效图

一份 snapshot 同时支持两种投影：

| 投影     | 包含内容                                                | DAG 保证 | 主要用途               |
| -------- | ------------------------------------------------------- | -------- | ---------------------- |
| 有效图   | `effective: true` 的 required 与 resolved optional edge | 是       | 启动顺序、当前影响范围 |
| 声明关系 | 全部 edge，包括 disabled、blocked、unresolved           | 否       | 理解架构意图与缺失集成 |

Core 在每次 commit 前对 required 与 resolved optional edge 的合并图做 cycle validation，所以成功提交的有效图是 DAG。Catalog union、
disabled relation 或尚未选择 provider 的关系只是潜在组合，可能形成 latent cycle；它们不能被标成当前运行错误。真正 enable 或改变
binding 时，mutation 仍必须重新经过 prepare/verify，并在产生有效 cycle 时保持旧状态不变。

### 能发现什么

- Plugin 在 host catalog 中但未 enabled：Runtime 已拥有 lowered declaration，可以显示它的关系，但不能 materialize 它。
- Optional provider 在 catalog 中但 disabled：显示已知 provider 与 inactive edge。
- Optional provider 不在 catalog：consumer declaration 仍可显示 requirement placeholder，但没有 provider metadata。
- Plugin package/source 根本没有进入 catalog：Management 不扫描磁盘、下载 package 或执行 import 来发现它；无法展示其自身的
  outgoing declaration 是预期边界。
- Provider start failed：edge 是否 effective 与 provider 是否 running 是两个事实；UI 从 node status 展示 lifecycle failure，不能把
  failed 错写成 dependency 不存在。

Optional ref 继续只观察 host catalog，不安装、不加载、也不默认 enable implementation package。

## 最小 Management contract

第一版在现有 dependency domain 增加一个无参数 query：

```ts
management.dependencies.graph(): Promise<PluginDependencyGraphSnapshot>
```

它比 `management.plugins.graph()` 更贴近现有 `dependencies.list/inspect/setTarget` domain，也不需要为单个方法新增顶层 client
namespace。该 query 没有用户输入和业务 absent 分支；transport/programming failure 继续 reject，不包装成 `internal_error`。

候选 DTO 只包含以下字段：

```ts
type PluginDependencyGraphSnapshot = Readonly<{
	catalogRevision: number
	runtimeStateRevision: number
	nodes: readonly PluginStatusSnapshot[]
	edges: readonly PluginDependencyGraphEdge[]
}>

type PluginDependencyGraphEdge = Readonly<{
	consumer: PluginNodeAddress
	requirement: PluginDefinitionAddress
	mode: 'required' | 'optional'
	resolution:
		| Readonly<{
				state: 'resolved'
				provider: PluginNodeAddress
				via: 'direct' | 'provider-default' | 'dependency-override'
		  }>
		| Readonly<{ state: 'unresolved' }>
	effective: boolean
}>
```

这里的 `resolved` 只表示 policy 已能确定 provider address，不表示该 node available、enabled、materialized 或 running；这些状态来自
`nodes` 中复用的 `PluginStatusSnapshot`。显式 binding 指向 unavailable provider 时仍可以保留 address 和 `via`，对应稳定问题由
consumer/provider status issue 展示。`effective: true` 精确表示这条 consumer/provider relation 已进入当前 committed Core graph。

`catalogRevision + runtimeStateRevision` 只作为 topology cache key 和诊断事实，不是 mutation 的 optimistic concurrency token；纯 restart
可以改变 node lifecycle status 而不改变这两个 revision。

### 刻意不加入的字段

- 不给现有 `PluginDependencyRef` 增加 `optional?: boolean`。它当前表示 resolved dependency list，扩展后仍无法表示 absent optional、
  incoming dependent 或全图一致性。
- 不公开 `PluginGraphSnapshot`、slot、constructor identity、parameter index、`partPath` 或 definition record。
- 不公开 optional callback 数量、声明文件位置和 root/Part provenance；它们是 compiler diagnostic，不是管理 identity。
- 不给 edge 分配公共字符串 ID。Workbench 可以从 canonical consumer/requirement key 构建本地 React/renderer key。
- 不把 provider candidate `options` 复制到每条 edge。用户打开 required selection control 时再调用现有 `inspect()`。
- 不为 absent provider 伪造 `PluginStatusSnapshot`。Workbench 可以从 requirement/provider address 创建只读 placeholder view model。
- 不加入 `reason` message。Required policy/lifecycle 原因已经是 node status 的稳定 issue；optional absent 使用固定 UI 文案即可。

如果实现时发现 UI 必须根据某个新增字段作稳定分支，先用一个真实页面和测试证明调用点；否则保持上述契约。

## Runtime projector

Runtime 增加一个无副作用的 presenter/use case。Management query 先排在 coordinator 当前 graph transaction 之后，再从同一个
committed 时点读取：

```text
coordinator.readCommitted()
          │
          └─ committed catalog + RuntimeState + applied state + Core effective adjacency
                                               │
                                               ▼
                               projectPluginDependencyGraph(ctx)
                                               │
                                               ▼
                              PluginDependencyGraphSnapshot
```

实现约束：

- node 直接复用当前 `pluginsList()` 的 status projection，不能维护第二份 status 规则；
- declaration edge 来自 committed catalog candidate 的 owning Plugin aggregate requirement；orphan node 没有 candidate 时不猜测
  outgoing edge；
- provider target 来自现有 direct/default/override authority，不能在 projector 内重写 reconciler selection；
- `effective` 必须从 committed Core required/optional adjacency 判定，不能用 `isRunning`、enabled state 或 browser 推断；
- coordinator read callback 是 package-private 的短同步读边界；它只等待已经在进行的 mutation，不取得跨请求 lease，也不建立
  Management session。这样 query 不会读到已持久化的新 RuntimeState 与尚未 publish 的旧 Core graph；
- 如果现有 Core internal reader 无法读取 optional effective adjacency，只在 `PluginService` 附近增加一个窄的 package-private reader，
  不导出 raw `GraphSnapshot`；
- 进入 committed read callback 后，projection 不 `await`、不运行 reconciler、不写 RuntimeState，并对固定 snapshot 引用完成 O(N + E)
  遍历；
- node 与 edge 使用 canonical identity 稳定排序，结果 clone、deep-freeze，并在 browser boundary 做现有严格结构/预算校验；
- 第一版不增加 server cache。Management query 本来就是按需操作，只有测量证明重复 projection 成为瓶颈后才在 Runtime 内做 revision cache。

这里单独使用 projector 不是为了预想第二个实现，而是为了阻止 Workbench、RPC server 和 Core representation 互相渗透。它是当前已经存在的
process-to-browser trust boundary。

## Workbench data layer

Graph 数据保持 lazy，不扩张当前 App 根部使用的 `PluginOverviewResource`。App Providers 只需要轻量 running status；如果把完整 edge 和
layout computation 放进去，每个页面都会承担无关成本。

新增 graph resource 只在 Plugin detail 或 graph page 首次出现时加载，并沿用现有成熟模式：

- 以 `WeakMap<RuntimeManagementClient, Resource>` 共享；
- 单一 in-flight request、30 秒 TTL、last-known-good 和显式刷新；
- snapshot 成功后一次建立 `byNode`、`outgoing`、`incoming` 三个 index；没有调用点前不增加其他 index；
- graph-affecting mutation 成功后标记 overview 与 graph resource stale；persistence `unknown` 也强制重读；
- topology layout 只依赖 revisions、edge identity 和当前 filter，单纯 running/stopped 样式变化不重新布局。

这不是第二个 writable store。Mutation 仍调用 Management Client，resource 只保存 server snapshot 和派生 index。

## Plugin 详情页

详情页用 graph selectors 替换当前无类型的 dependency list，保留三个直接有用的区块：

1. **Required dependencies**：provider 状态、direct/default/override、requirement address，以及需要时的 provider/fork selection control。
2. **Optional integrations**：provider 为 available、disabled、absent 或 failed 的状态；固定说明它不阻塞 consumer startup，但 provider
   availability/replacement 会重启 consumer generation。
3. **Dependents**：从 `incoming` index 展示 required/optional consumer，帮助判断 disable/restart 的 blast radius。

每个条目提供普通 Plugin detail link 和“在依赖图中定位”。Optional integration 第一版只读，不增加 provider selector、自动 enable 或
package install button；这些行为都不是 optional ref 的当前 contract。

`DependencyOverridesCard` 继续只服务 required selection，并在卡片实际显示时惰性调用 `dependencies.inspect()` 取得 options。Graph
snapshot 不为 action UI 预取所有候选 fork/provider。

## Plugin graph 页面

新增独立内置 route `/plugin-graph`。它不放在 `/plugins/*` 下，避免与 versioned Plugin detail route/parser 混淆；导航上仍紧邻 Plugin
catalog。

第一版只提供这些交互：

- 默认“有效图”，可切换“声明关系”；
- 搜索并聚焦 Plugin；
- required/optional filter；
- 聚焦节点后查看 upstream/downstream；
- 点击 node/edge 打开 inspector，并可跳转 Plugin detail。

边在 DTO 中保持 `consumer -> requirement` 的领域命名；画布统一绘制为 `provider -> consumer`，这样从左到右同时表达 provider-first
startup 和 downstream impact。Resolved 但不在 `nodes` 中的 provider，以及 unresolved requirement，才由 UI 临时生成 hollow placeholder；
placeholder 不进入 protocol、catalog 或持久状态。

视觉不只依赖颜色：required 使用实线，optional 使用虚线，inactive 降低透明度，unresolved 使用空心端点和文字状态，failure/blocked
增加 icon 与 outline。声明关系中的 latent cycle 只是潜在组合，不用红色冒充当前 graph error。

正常 Plugin catalog 规模下，第一版使用 lazy-loaded `@xyflow/react` 提供 pan/zoom/focus/inspector，使用 `@dagrejs/dagre` 做有向分层
layout。两者只进入 `/plugin-graph` chunk；detail 列表不加载 graph renderer。先在真实 workspace catalog 上测量，再决定是否需要 ELK、
Web Worker、cluster、virtualization 或大图 server layout，不能为了假设规模提前引入这些基础设施。

## Cycle failure 暂不扩张

第一版不增加 `previewGraphMutation()`。Preview 必须复制 admission 输入、处理 revision race，实际 mutation 仍必须重新 verify；在 UI 尚未证明
需要交互式 enable planning 前，它只会增加一条可能过期的协议。

当前 mutation 遇到有效 cycle 继续返回稳定 `graph_rejected` 并保持 state unchanged。若真实使用证明用户无法靠当前 report 定位 cycle，下一步
只给实际 rejection 增加结构化 cycle path；不解析 message，也不因此把整个 catalog declaration union 改成 hard-reject graph。

## 分阶段落地

### 1. Read model

- 实现 Runtime projector、RPC、Management Client method、strict browser validator 和 public protocol types；
- 为 `@pluxel/runtime` 添加 Tegami pending change；
- 不改 Workbench UI，先证明 contract 能诚实覆盖当前事实。

### 2. Plugin detail

- 新增 lazy graph resource 与 selectors；
- 将详情页拆成 required、optional、dependents；
- selection mutation 继续使用现有 API；
- 删除官方 App 对 `dependencies.list()` 的无类型投影，不建立第二条 detail read path。

### 3. Graph page

- 添加 lazy route、renderer、filter、inspector 与 detail deep link；
- 只在这一阶段引入 graph visualization dependencies；
- 用真实 catalog 做 desktop/narrow screenshot 和 interaction 验证。

每一阶段都应能独立合并、测试和回退。Workbench vNext 即使之后重构 Remote View/Module Federation，仍应消费同一个 Level 1 Management
read model；本提案不依赖当前 Remote View Contract、Port 或 artifact loader。

## 精简验证矩阵

测试以边界为单位，不追求 fixture 数量：

| 风险             | 最小证据                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| edge 语义错误    | 一个组合 fixture 覆盖 direct required、abstract override、present/disabled/absent optional 和 required-wins aggregation |
| DAG 声明过度     | 一个 inactive latent cycle 留在声明关系，effective subset 仍由 Core cycle test 保证 DAG                                 |
| read 产生副作用  | disabled、absent、orphan graph query 前后 Core slot/record、artifact/effects 数量不变                                   |
| transport 不诚实 | validator 拒绝非法 address、unknown union/tag、duplicate consumer+requirement edge、超预算数组和危险 key                |
| UI 方向/分类错误 | selector test 覆盖 outgoing/incoming、required/optional、placeholder 和 provider-to-consumer projection                 |
| cache 产生旧写入 | resource test 覆盖 in-flight dedupe、last-known-good、force refresh 和 mutation invalidation                            |
| 页面不可用       | route smoke + 一组 desktop/narrow screenshot；不测试 Dagre 内部坐标或每个像素                                           |

## 否决条件

出现以下任一情况时应停止实现并回到本提案，而不是继续加兼容层：

- 必须公开 Core `GraphSnapshot`、slot 或 Part occurrence 才能让 UI 工作；
- graph query 会 materialize disabled/absent Plugin 或触发 package import/install；
- Workbench 仍需对每个 node 发一个 dependency RPC；
- declaration view 被宣传为保证 DAG，或 latent cycle 被当成当前错误；
- optional integration 控件会隐式 enable、fallback 或安装 provider；
- graph route、layout worker 或完整 snapshot 被 eager 放进 App Providers；
- 新字段没有当前 detail/graph 页面调用点，只以“未来可能需要”为理由存在。

本提案的价值不在于建立一套通用 graph 平台，而在于用一个小而诚实的 read model，让现有 Plugin 管理页面看见 Runtime 已经拥有的关系，
同时把未来 Plugin 作者模型重构的影响限制在 Runtime projector 内。
