# 删除 Plugin fork：以领域 collection 表达运行时多实例

> 状态：验证性 Plugin 迁移已完成，Core/Runtime 删除尚未开始。本文提出删除当前 fork 作者面、控制面、身份与持久化语义，
> 但完整删除决定尚未被采纳；
> 当前行为仍以 [`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md)、[`../PLUGIN_IDENTITY.md`](../PLUGIN_IDENTITY.md)
> 和 [`../RUNTIME.md`](../RUNTIME.md) 为准，不得依据本文修改用户代码或推断兼容性。

## 决策问题

Pluxel 是否仍需要把同一个 concrete Plugin definition 的多份运行实例建模为通用 Runtime feature？

当前 fork 能表达多实例，但“能够表达”不足以证明它应该成为公共契约。Pluxel 的设计目标是让每项能力以最小、清晰且
诚实的模型覆盖真实调用方；如果领域 collection、显式 concrete definition 或独立 host 能更直接地表达已知需求，就不应
为了假设性的动态依赖子图继续保留 fork。

本文建议把它作为一个二元决策，而不是渐进隐藏 feature：若采纳删除，就必须同时收回 fork 的作者面、独立 node identity、
Core definition family、控制面和全部持久化协议；若真实需求不允许这样收缩，就否决删除并保留当前 fork，不能只删除入口和 UI、
把 fork-ready 架构留在内部。

候选结论是：

1. 删除 fork 及其跨 Core、Runtime、toolchain、Workbench 和持久化的完整协议；
2. definition 是 Plugin 唯一 durable identity；abstract definition 不物化，concrete definition 最多对应一个内部 runtime record；
3. Redis connection、S3 store、bot account、font collection 等动态多实例由 producer Plugin 作为领域 collection 管理；
4. consumer 保存自己选择的稳定 item ID，并自行决定 missing、fallback、retry、degraded 和 rebind policy；
5. 固定的多份业务角色使用多个显式 concrete Plugin，共享普通内部实现；
6. 真正需要部署、故障、安全或资源隔离时使用独立 host/process/container；
7. 保留 optional integration 和 abstract provider selection，它们与 fork 是不同问题。

这不是最终删除决定。只有本文的验收条件全部通过，且没有真实 workspace 用例证明 fork 的不可替代性，才进入实现。一旦进入
实现，“删除 fork”就按上述完整边界验收，不接受保留第二套身份的半删除结果。

## 当前 fork 实际提供什么

fork 不是配置对象副本。当前模型把它提升为完整 Plugin node：

- `PluginNodeAddress` 在 definition 下区分 `default` 与 `{ variant: 'fork', forkId }`；
- default 与 forks 共享 constructor、schema、metadata、artifact input 和 HMR invalidation；
- 每个 fork 隔离 auto-start、session intent、running generation、config value/revision、dependency override、Context、effects、
  logging policy 和外部资源；
- Core 为 fork 建立 DI/lifecycle node，Runtime reconciliation 把 durable forks 展开进 effective graph；
- management RPC 可以创建、删除 fork，并在创建时把某个 consumer requirement 绑定到新 fork；
- Workbench、日志、引用、URL route、catalog layout、status projection 和 dependency graph 都必须识别 fork identity；
- fork removal 必须串行停止 node、清理其 outbound policy、Config record、logging policy，再删除 durable family entry。

因此 fork 的成本不在一个 `host.fork()` 方法，而在它要求所有 Plugin node consumer 永久支持 `default | fork` 两种身份和
多份持久状态的一致性。

## 为什么重新评估

### 当前真实采用面很窄

验证性迁移前，仓库内生产 Plugin 对 `forkable: true` 的实际使用集中在：

- `RedisPlugin`：同一 host 的多个 Redis connection；
- `S3Plugin`：同一 host 的多个 S3 bucket/backend。

两项官方 Plugin 现已迁移为各自拥有的 bounded config catalog，仓库内生产 Plugin 不再声明 `forkable: true`。其他命中主要是
demo、synthetic test、toolchain conformance 和 cost benchmark。测试证明了实现自洽，但测试便利或 synthetic 拓扑不能反向证明
公共 feature 的必要性。

Redis connection 和 S3 store 都天然是 provider 拥有的动态领域对象。它们有自己的名称、credentials、health、revision、连接或
client lifecycle；把每一项升级成 Plugin node，会让宿主承担本可由领域 API 明确表达的多实例政策。

### fork 不是独立部署或故障隔离

fork 仍与 sibling/default：

- 运行在同一进程和 host；
- 使用同一 constructor implementation；
- 接受同一次 definition-wide HMR replacement；
- 共享进程级 crash、CPU、memory 和 trust boundary；
- 不能运行同一 definition 的不同版本。

所以 fork 只能提供独立 runtime generation 和 graph binding，不能提供通常由“独立部署单元”暗示的扩缩容、安全、版本或
故障隔离。若需求真正属于这些边界，应使用独立 host/process/container，而不是在进程内模拟部署。

### fork 也没有完整表达一个 consumer 的多角色需求

当前 dependency override 以 `consumer node + requirement definition` 为 key。同一 constructor 不允许两次声明相同 definition，
一个 owner 的 root 与全部 Part occurrences 也共享同一 requirement override。

因此 fork 能表达的是：

> 不同 consumer 各自透明取得同一 definition 的一个实例。

它不能直接表达：

> 同一个 consumer 同时使用同一 provider 管理的两个 Redis connections 或两个 S3 stores。

后者仍要拆分 adapter Plugin，或者让 provider API 接受稳定领域引用。既然多角色场景最终需要领域模型，fork 并没有形成一套
完整且更简单的多实例解法。

## 价值判断：清晰度是主收益，性能只是附带收益

删除 fork 不应被立项为性能优化。普通 host 中 `F` 通常为零或很小，Plugin 初始化、外部 IO、artifact load 和 lifecycle work
才是启动与更新的主要成本。Runtime full reconciliation 的理论成本会从：

```text
O(C + F + B + S + E)
```

收缩为：

```text
O(C + B + S + E)
```

同时省去 fork projection、family index、每个 definition 的 materialized-node 集合、family-wide HMR 枚举，以及一部分 Map、address
wrapper 和 serialized bytes。这些会降低控制面的固定成本和高基数风险，但在缺少实测前，不宣称明显改善启动延迟或 Plugin
业务吞吐量。

主要收益是让系统恢复一个可直接推导的不变量：

```text
one definition identity
  = config owner
  = runtime owner
  = logging owner
  = RPC / URL target
  = Workbench owner
  = persistence owner
```

调用方不再需要判断一个值属于 definition 还是 node，也不再需要在 catalog、配置、日志、状态和 dependency graph 之间追踪
`default | fork` 投影。静态类型、持久化 schema、诊断文本和实现索引因此描述同一身份；清晰度收益来自删除整条平行身份轴，
不是来自少一个管理按钮或少几行配置。

因此本提案的能效判断是：**若能完整恢复单一身份不变量，清晰度和长期维护收益值得承担一次 breaking migration；若只能移除
表层 fork，而底层仍保留双 identity 和 definition family，性能与清晰度收益都不足以支持变更。**

## fork 必要性的五项联合检验

只有一个真实用例同时满足以下条件，才构成保留 fork 的有效证据：

1. **必须成为 Core graph node**：普通领域 record、resource handle 或 PluginPart 无法诚实表达其生命周期和失败传播；
2. **创建权属于宿主**：实例不是 producer Plugin 自己拥有和管理的领域对象；
3. **每个实例拥有不同上游 Plugin graph**：差异不只是 endpoint、credential、bucket、database index 或其他领域配置；
4. **数量小、持久且有界**：不是 tenant、account、connection、document 等可能动态增长的 collection；
5. **接受共享代码与进程**：需求不包含独立版本、扩缩容、安全边界或进程故障隔离。

这个交集非常窄。候选示例是“宿主动态创建多个同构 Plugin dependency subtree，每棵子树选择不同上游 provider，并要求
Core 分别启动、阻塞和停止 dependent closure”。当前 workspace 没有生产用例证明这种拓扑是产品需求。

以下常见需求都不能作为 fork 的保留理由：

| 需求                                    | 优先模型                              |
| --------------------------------------- | ------------------------------------- |
| 多个 Redis/S3/database connection       | producer-owned collection             |
| tenant、bot account、external account   | producer-owned collection             |
| item 独立 connect、pause、retry、health | producer 管理 item resource lifecycle |
| 选择不同 concrete implementation        | abstract provider selection           |
| 可选集成存在或缺席                      | `PluginRef` optional integration      |
| 使用不同代码版本                        | 不同 definition 或独立 host           |
| 固定的少量业务角色                      | 显式 concrete Plugin，共享普通 helper |
| 安全、资源、故障或扩缩容隔离            | 独立 host/process/container           |

## 候选目标模型

### 一个 definition 对应一个 runtime owner

删除 fork 后，一个 host catalog 中的 abstract definition 永远不物化；每个 concrete definition 可以因为不在 effective desired graph
中而没有 runtime record，也可以最多拥有一个 runtime record 和当前 generation：

```text
PluginDefinitionRecord
  -> RuntimeNodeRecord?       // internal，keyed by PluginDefinitionSlot
       -> current Generation?
```

这里仍然需要运行时记录。它承载 instance、lifecycle、Context、effects、owner admission、provider binding、config binding 和当前
generation；删除的是它作为第二个 durable identity 的资格。catalog availability 与 runtime materialization 是同一 identity 的不同
状态，不需要分别发明 definition/node 地址。

因此 config、auto-start、session intent、dependency override、logging、Workbench publication、lifecycle status、RPC、URL 与
persistence 都直接使用 definition identity。public/persisted `PluginNodeAddress`、`PluginNodeSlot`、node reference/route 和对应 codec
必须删除；Core 内部 runtime record 直接由 `PluginDefinitionSlot` 定位，不能拥有可序列化地址、variant、family membership 或未来
fork 的预留 discriminant。

当前 `node` 的其他职责都是 runtime state/ownership 职责，并不构成独立身份的理由。若 inventory 发现 fork 之外确实存在必须独立
寻址和持久化的 node 语义，应据此否决或修改整个删除决定，而不是保留一对一的 node identity 作为“以后可能重新支持多实例”的
扩展点。

### 完整删除的完成定义

本提案只有同时满足以下两项，才算删除 fork：

1. public、RPC、URL 和 persisted contract 不再出现 `PluginNodeAddress`、`PluginNodeSlot`、`forkId`、`variant` 或等价的 fork-ready identity；
2. Core 不再维护 `definition -> Set<node>` family，definition replacement/HMR 只定位该 definition 唯一的可选 runtime record。

内部类型可以因代码组织继续名为 `RuntimeNodeRecord`，但它只能是 definition-keyed transient state。若实现只删除 `forks[]`、创建接口
和 Workbench 控件，却保留 fork-ready address、slot、family 或 codec，验收必须失败；此时应继续保留当前 fork 或重新讨论阻碍完整
收缩的真实语义，不能把半删除计作架构简化。

### 动态多实例属于 producer 的领域 collection

框架不新增通用 `Profile`、`PluginCollection` 或 named-instance SPI。每个 producer 使用自己的领域词汇和 API：

- Fonts 管理 font collections；
- Redis 管理 connections；
- S3 管理 stores、backends 或该插件最终选择的领域对象；
- Bot manager 管理 accounts。

一个 collection item 通常具有：

- stable opaque ID，rename 不改变引用；
- detached snapshot 和显式 revision；
- provider-owned config、credential reference、health 与资源状态；
- create/update/remove/list/watch 等按领域需要设计的 API；
- provider-owned resource handle，其 caller attribution、withdrawal 和 cleanup 与 Plugin lifecycle 一致。

这些是设计方向，不是新的统一 interface。不同资源不必伪装成相同 CRUD、状态机或错误集合。

### consumer 拥有选择和失败政策

consumer 通过正常 constructor dependency 取得 producer，在自己的 domain state 中保存所选 item ID。选择可以来自普通业务 API、
command、Workbench View，或 provider-owned picker + consumer-owned selection Attachment；不要求用户在 host config 中预先声明
`cache`、`queue` 等框架猜测的角色。

producer 创建、改名或删除 item 时，不跨 Plugin 扫描并重写 consumers。consumer 读取已保存 ID 后，由双方公开协议明确处理：

- `missing` 时保留选择、清空、fallback、拒绝启动或运行期降级；
- `unhealthy` 时失败、重试、切换或继续使用 last-known-good handle；
- update 时透明替换、版本冲突、撤销旧 handle 或要求重新 acquire；
- remove 时是否允许已有 lease drain，或立即 revoke；
- provider replacement/stop 时所有旧 handle 如何 fail-fast 和清理。

Core 不规定这些领域政策，也不把 item availability 投影成 synthetic Plugin status。契约必须诚实、可观察，不能静默选择第一个
item、吞掉 missing，或留下无法撤销的 client。

### 可观察性不依赖通用 graph identity

删除 fork 不等于隐藏关系。诊断应出现在真正拥有语义的位置：

- producer manager 展示 item snapshot、health、revision 和安全的错误摘要；
- consumer 页面展示当前选择、missing/degraded 状态和自己的 fallback policy；
- picker Attachment 同时读取 provider catalog 与 consumer selection；
- 领域日志记录 consumer Plugin identity 与经过预算、去敏的 item ID/label；
- provider 可在自己的 API 中提供有界引用或 lease read model，但不要求 Runtime 建立通用 reverse-reference registry。

Runtime dependency graph 只保留 `consumer definition -> provider definition`。collection item reference 是业务状态，不进入 Plugin
identity、RuntimeState、provider selection 或 Core lifecycle graph。

### 固定多份与真正隔离使用现有边界

若产品源码明确需要固定的两套角色，声明两个 concrete Plugin definition，并把共同逻辑放入普通 class/function 或适当的
PluginPart。显式 definition 带来少量重复声明，但也让 graph、配置、日志和失败边界直接可见；罕见静态拓扑不值得通用动态 fork。

若需求包含独立部署、版本、扩缩容、安全或进程故障边界，则运行多个 host/process/container，通过明确的网络或持久化协议组合。
不继续扩大进程内 Plugin identity 来模拟这些能力。

## 保留且与 fork 解耦的能力

### Optional integration

`definePluginRef<T>()` 与 `plugins.use()` 继续表达 provider 存在或缺席，以及 provider generation 变化时 consumer restart。它不创建、
安装或选择 collection item，也不需要 fork。

### Abstract provider selection

abstract capability 仍可有多个 concrete definitions。provider default 和 consumer-specific override 只在 concrete definitions 之间
选择，不再允许 target 为同一 definition 的某个 fork。

移除 fork 后，selection state 可简化为：

```text
provider default: abstract definition -> concrete definition
consumer override: consumer definition + requirement definition -> concrete definition
```

该机制解决“由哪个 Plugin implementation 提供能力”，领域 collection 解决“这个 provider 内使用哪个动态对象”，两者不合并。

## 为什么不以通用 profiles 替代 fork

框架级 profiles 若逐步加入 stable identity、配置、状态、依赖选择、独立启停、错误传播、持久化、日志和管理 UI，最终只会以新名称
重建 fork。若不加入这些语义，它又只是一个无法覆盖不同领域的弱 CRUD interface。

因此本提案不提供：

- `@Plugin({ profiles: ... })`；
- 通用 `ProfileAddress` 或 `ProfileRef`；
- Runtime-owned profile persistence；
- profile 到 Plugin graph edge 的通用 binding；
- 为每个 collection item 自动生成 Workbench entry、route 或 logging owner。

框架只提供现有的 persistence、Context/effects、Workbench View/Attachment 和 caller-bound capability 基础，具体 collection contract
由 producer 与 consumer 共同设计。

## Redis 与 S3 的验证性迁移结果

Redis/S3 已在删除框架 fork 前完成真实迁移。结果没有引入通用 profile SPI，也没有在插件内部复制动态 control plane；两者都采用
配置驱动、有界、原子 generation 的领域 catalog。

### Redis

`RedisPlugin` 的当前结论：

- config 声明 1–64 个唯一 connection ID，启动时并行 connect，运行时 `Map` O(1) lookup；
- `redis.connection(id)` 返回按 consumer Context 缓存、同时受 consumer effects 与 provider generation 约束的 handle；
- handle 暴露原生 client 与 per-handle `RedisScripts`，一个 consumer 可以同时选择多个连接；
- 任一 initial connect 失败会取消 sibling、等待全部 settle 并回滚整个 catalog，不形成“Plugin running 但声明连接部分不可用”的半启动状态；
- Cache/Rates adapter 各自在 config 中保存 `connectionId`，不预设框架角色，也不使用 dependency override 绑定 item；
- 一张固定 Workbench Content 以 bounded rows 投影连接状态，并按 ID 执行 PING；连接数量不改变 entry/root/socket。

没有实现 runtime create/remove。当前已知 connection 是部署配置而不是用户动态内容；动态 CRUD 会要求第二份持久化、config merge、
独立 item lifecycle、失败恢复和管理授权，已经接近在 Plugin 内重建 fork。配置 replacement 继续使用正常 Plugin generation transaction。

### S3

`S3Plugin` 的当前结论：

- config 声明 1–64 个唯一 bucket ID，每项独立选择 local 或 remote/anonymous/vault backend；
- `s3.bucket(id)` 返回 owner-bound handle，再从 handle 取得完整 s3mini-compatible client，不把 ID 加到每个对象方法；
- 多个 bucket 并行初始化并作为一个 generation 原子提交；local client、remote fetch abort 与 owner withdrawal 都沿现有 effects 清理；
- Vault reference 和默认 key 属于 bucket record，Workbench rotation 按 ID 选择且不传输 credential snapshot；
- 一张固定 Workbench Content 以 bounded rows 投影全部 bucket，数量不改变 definition、entry/root/socket；
- config replacement 表达 backend 更新和删除，不新增动态 store registry 或 synthetic Plugin lifecycle。

两项迁移证明已知用例可以脱离 fork，同时保留显式选择、并发安全、撤销、诊断和 Workbench 能力。它们也明确了领域 catalog 的边界：
item 不进入 Core graph；需要独立故障域或扩缩容时仍升级为独立 host/process，而不是继续扩展 catalog lifecycle。

## 若采纳，删除的公共与持久化契约

以下是候选删除清单；实现前需要以 exports 和调用点再次生成精确 inventory。

### Core 与作者面

- `@Plugin(..., { forkable: true })` 及 lowering metadata/ABI 中的 forkability fact；
- Core/Runtime test host 的 `fork()` 与 `PluginNodeHandle` fork 用法；
- `PluginNodeAddress` 的 `default | fork` discriminated union、`forkId` grammar 和 fork-specific parse/format/route；
- definition family、definition-to-many-nodes index 和 family-wide fork replacement 路径；
- duplicate address、lifecycle report、Context owner 与 logger 中只为 fork variant 存在的分支。

### Runtime 与控制面

- `RuntimeForkState`、`RuntimeStateSnapshot.forks`、`ensure-fork` / `remove-fork` patch operation；
- `ensurePluginFork()`、`removePluginFork()`、`EnsureForkResult`、`RemoveForkResult`；
- `invalid_fork_id`、`not_forkable`、`fork_referenced`、`fork_not_allowed`、`fork_default_forbidden` 等 fork-only result/issue；
- fork create/remove coordinator transaction、fork projection/index 和 inactive durable fork status；
- Workbench fork controls、provider option 中的 fork entries，以及 catalog family grouping 规则；
- per-fork Config record、logging policy、auto-start、session intent 与 cleanup sequencing。

### Toolchain、路由与文档

- decorator semantic pass、generated declaration 和 artifact facts 中的 forkability；
- node reference/route 的 `#fork=` 和 `/fork/<id>/` codec；
- fork-aware static/dynamic/HMR conformance、benchmarks 与 synthetic fixtures；
- Redis/S3 fork 用户文档、testing host 示例和 demo。

删除不保留 compatibility alias、隐藏 legacy fork 或平行 identity contract。若需要迁移工具，它必须是有终止日期的显式离线迁移，
不能让 Runtime 永久接受两套状态。

## 持久化与升级策略

当前 fork facts 分散在 RuntimeState、Config、logging policy 和可能的 Plugin-owned resource state 中，不能只删除
`RuntimeStateSnapshot.forks` 就宣称迁移完成。

候选升级策略：

1. default-only state 可以机械地把 node owner identity 收缩为 definition identity；
2. 任何存在 fork 的持久化 profile 必须在升级前得到可枚举报告，列出 fork、config、auto-start、dependency references 和 logging policy；
3. Redis/S3 fork 由各自一次性迁移逻辑转换为 collection records，并把已知 consumer selection 转为 consumer-owned 领域引用；
4. 无法证明等价转换的第三方 fork 不自动猜测，升级工具 fail closed 并要求插件提供迁移或用户显式决策；
5. 新 RuntimeState/Config/logging snapshot 使用新版本，只接受目标 schema；
6. migration 完成后删除 legacy reader、fork codec 和中间 state，Git 与 release note 保存历史。

在设计出可验证的 Redis/S3 迁移与第三方拒绝路径之前，不实施 destructive state rewrite。

## 考虑过但不采用的替代方向

### 把 fork 保留为高级 escape hatch

只要 public identity、persistence 和 RPC 仍允许 fork，Core、Runtime、Workbench、toolchain 和所有 node consumer 就必须继续维护
两种基数。把按钮藏到 advanced UI 不会回收主要复杂度。没有真实不可替代用例时，escape hatch 只有成本，没有能效收益。

### 只允许基础设施 provider fork

`infrastructure` 不是稳定的 Plugin type system boundary。Redis/S3 正是最适合用 collection/manager 表达的动态资源；为它们保留
特殊 fork 会把领域政策继续放在宿主，并产生难以解释的白名单。

### 让 Runtime 管理通用 named instances，但不称为 fork

改名不改变 identity、binding、lifecycle 和持久化成本。如果 named instance 是 graph node，它就是 fork；如果不是，就应留在
producer domain，不建立中间抽象。

### 只删除作者 API，内部继续保留 fork-ready identity

一对一的 definition/node public protocol 会继续要求 codec、address、slot、DTO 和 persistence conversion，却没有调用方收益。
内部实现可以为代码组织保留 record，但不应保留可持久或可扩展的 fork-ready contract。

## 验收与否决条件

### 采纳删除前必须证明

1. workspace inventory 中没有生产用例通过“五项联合检验”；
2. Redis 与 S3 spike 覆盖现有多实例需求，且没有在插件内部重建通用 graph/runtime；
3. collection handle 在并发、cached handle、update/remove、replacement、abort 和 cleanup 下保持 owner/lifecycle 正确；
4. 同一 consumer 使用多个 item 的路径比当前 fork 更直接；
5. abstract provider selection 与 optional integration 在无 fork 后仍覆盖 static、dynamic、Vite/HMR 和 test host；
6. definition/node identity collapse 已检查所有 public exports、RPC、URL、config、logging、Workbench、database/persistence owner 和 artifact，
   且完整删除 public/persisted node identity；
7. default-only 和 Redis/S3 持久状态具有确定迁移，未知 third-party fork 有安全、可操作的拒绝结果；
8. 删除后的实现和文档没有通用 profiles、legacy alias、definition family 或隐藏第二套多实例协议。

### 出现以下证据时否决或修改提案

- 一个真实 workspace/product 用例同时通过五项联合检验；
- collection 只能通过复制 Plugin dependency resolution、blocked closure 或 lifecycle coordinator 才能正确工作；
- 独立 definition/host 对该真实用例产生不可接受且可测量的成本；
- Redis/S3 item failure 无法在领域 API 中诚实隔离，必须由 Core 对每个 item 建立 graph node；
- identity collapse 会删除 fork 之外仍被真实调用方需要的 definition/node 区分。

synthetic fixture、对称性偏好、“未来也许需要”和 test helper 少写几行不构成否决证据。

## 开放问题

1. fork 之外是否存在必须独立寻址和持久化的 node 语义？若存在，是否足以否决删除，而不是保留一对一 node identity 半删？
2. Redis/S3 collection 的选择应保存在 consumer config、consumer domain persistence，还是由各 consumer 自己决定并公开优先级？
3. item 从 missing/unhealthy 恢复时，consumer 应使用 live/revocable handle、领域通知还是显式 restart？哪些模式已被真实插件需要？
4. provider 是否需要有界、授权后的 reverse-reference read model，还是 picker 中的 provider/consumer 双 API 已足够诊断？
5. collection item 的 credential rotation 与 in-flight drain 能否复用现有 owner effects/handle withdrawal，而不新增 framework SPI？
6. 第三方 fork 的一次性迁移由 CLI、host migration hook 还是插件包工具承担，如何避免形成永久扩展点？
7. 移除 fork 后，RuntimeState 是否还需要独立保存 consumer override，还是部分固定选择应回到 product host source？

## 若采纳的实施顺序

1. 先完成 Redis/S3 collection spike、失败矩阵和迁移设计，不修改当前 fork contract；
2. 冻结精确 public/state/code inventory，验证能完整 collapse definition/node identity；不能 collapse 则停止并重新决策；
3. 在一个明确 breaking release 中删除 decorator/toolchain/Core fork 语义，并让内部 runtime record 直接由 definition slot 定位；
4. 删除 RuntimeState、coordinator、management RPC、Workbench 和 logging/config fork 分支；
5. 迁移 Redis/S3、demo、test host、benchmarks 和全部当前文档；
6. 搜索并拒绝 legacy `forkable`、`forkId`、fork route/reference 和 persisted version；
7. 把稳定结论写回 `engineering/` 领域文档与 `docs/`，随后删除或缩减本 proposal。

实现属于 public breaking change，届时必须按 Tegami 规则为受影响的 public packages 添加明确 bump；本 draft 本身只记录研究，
不添加空 changelog。

## 非目标

- 本文不设计 Redis/S3 最终 public collection API；
- 不把所有 plugin-owned runtime state 标准化为 collection；
- 不让 Workbench 成为业务 collection 或 selection 的 authority；
- 不把 item availability 自动变成 Plugin graph edge；
- 不改变 optional integration 的 presence 语义；
- 不删除 abstract capability 或 concrete provider selection；
- 不承诺无停机迁移未知第三方 fork；
- 不以减少代码行数代替 lifecycle、ownership、失败与迁移验证。
