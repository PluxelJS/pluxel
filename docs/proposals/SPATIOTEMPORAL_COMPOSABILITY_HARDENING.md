# 时空可组合性强化提案

> 状态：research proposal。本文记录受 [Cordis 论文](https://github.com/cordiverse/paper)启发的未来验证与强化方向，
> 不是当前 API、配置契约或实现承诺。当前事实仍以 [`../CORE.md`](../CORE.md)、
> [`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md) 和 `user-docs/` 为准。

## 背景

Pluxel 已经分别用 generation-owned effects 与 lowered Plugin graph 回答动态组成的两个核心问题：

- generation 结束时，已登记资源沿同一条 drain 路径撤销；
- required/optional dependency 变化形成 graph stop/start plan，并驱动 generation replacement。

[`../../user-docs/spatiotemporal-composability.md`](../../user-docs/spatiotemporal-composability.md) 已按 Cordis 论文的
revertible effect、reactive coeffect、Context/Fiber 与 system boundary 对照当前能力。对照同时暴露出一个维护问题：
Pluxel 的关键生命周期判断已经存在于实现、领域文档和场景测试中，但还没有被整理成一组独立于具体实现的可执行语义。

本提案不以补齐 Cordis 同名机制为目标。它研究如何让 Pluxel 当前的分层模型更容易推理、验证和诊断，并明确哪些结论仍然不能声称。

## 问题

### 生命周期不变量分散

Core 已覆盖 provider-first start、consumer-first stop、required failure propagation、optional restart、late `init()` cleanup、
owner invocation drain 与 effects at-most-once 等行为。不过，这些规则主要由具体实现和单项测试表达，缺少统一的状态词汇、
transition 前置条件与静止状态判定。

这会带来三个风险：

1. 新 transition 只满足局部测试，却破坏另一条不变量；
2. `commit` batching、异步 settlement 和 reentrant cleanup 的组合空间无法靠少量手写场景覆盖；
3. 文档只能描述“当前通常如何执行”，难以精确区分 safety、liveness 与外部系统假设。

### 身份约束不等于兼容性

Canonical package entry、root named export 与 constructor provenance 能避免纯字符串 key collision，但不能证明不同版本之间的
behavioral compatibility，也不能自动判断 replacement 是否跨越需要 migration 的 contract boundary。

### 可撤销边界仍依赖领域判断

Effects 可以托管进程内 registration、连接和可等待终止的任务；它不能撤销已经提交给外部系统的 emission。当前 database、
storage、worker 等领域分别说明了 transaction、outbox、幂等与 compensation，但缺少一份统一的 side-effect 分类和审计方法。

## 目标

1. 为 Core graph、generation、invocation 与 effects 建立一组实现无关的生命周期语义。
2. 用 model-based 或等价的生成式测试验证 transition 序列，而不只验证手写 happy path。
3. 审计 provider withdrawal 和 generation-bound handle 在各 runtime capability 中是否一致。
4. 统一描述进程内可撤销资源、可等待任务、事务状态与不可逆外部 emission 的边界。
5. 研究 dependency compatibility 的诊断事实，不引入隐式 provider negotiation。

## 非目标

- 不把业务 Plugin dependency 移回 runtime Context key。
- 不引入任意 key 的 reactive Context、通用 realm 或 metadata interception API。
- 不声称 cleanup 是 effect 的数学逆，也不声称已有 observational equivalence、preservation、progress 或 confluence 的形式证明。
- 不把 Core `commit()` 改写成覆盖数据库、对象存储、消息系统和 UI artifact 的全局事务。
- 不承诺普通 Plugin replacement 是零停机 rolling update。
- 不以 capability sandbox 约束同进程中的恶意 Plugin 代码。
- 不在本提案中创建新的 public lifecycle hook、dependency declaration 或作者 metadata。

## 工作流一：生命周期语义

第一阶段应先建立一份小型抽象模型，不绑定 `PluginService`、actor 或 scheduler 的具体 class 结构。

### 建议状态

抽象模型至少区分：

- **desired graph**：最新 draft/配置希望得到的组成；
- **committed graph**：已经验证并进入 lifecycle plan 的 graph；
- **node generation**：某个 node 当前 starting、running、draining 或 terminal 的 generation；
- **dependency availability**：required/optional provider 当前是否拥有可注入的 running generation；
- **owner admission**：generation 是否仍接受新 invocation；
- **effect ownership**：entry 是否处于 active、running cleanup 或 terminal。

这些名称是研究模型，不要求直接成为 public type 或替换当前内部状态机。

### 候选不变量

模型和测试至少检查：

1. running consumer 的每个 required dependency 都解析到 running provider generation；
2. 同一 Plugin node 最多有一个可对外使用的 generation；
3. generation 离开 running 后不再接受新 invocation；
4. consumer cleanup 完成前，其 graph provider 不进入最终撤销；
5. 已失效的 `init()` settlement 不得重新发布 generation；
6. 每个被 effects 拥有的 cleanup entry 至多执行一次；
7. drain 中 reentrant 登记的 cleanup 也在该 drain 的规定边界内到达 terminal；
8. required provider failure 只阻塞 dependent closure，不破坏无关 running branch；
9. optional absent -> absent 不产生 consumer restart，真实 availability transition 对同一 consumer 每个 plan 最多重启一次；
10. 系统静止后，running projection 与最新成功验证的 desired graph 及失败事实一致。

其中第 10 条只能在明确的 scheduler、timeout 和不可恢复 failure 假设下讨论，不能直接提升为一般 progress 或 confluence 结论。

### Transition trace

为了让测试失败和生产诊断共享因果信息，可以研究一份 bounded transition trace。它应回答：

- 哪个 desired change 导致本次 plan；
- node 因 add、remove、replacement、required cascade、optional availability 还是显式 restart 被纳入；
- generation 在 start、admission close、invocation drain、effects drain 的哪个阶段失败或超时；
- 后续 commit 是否已经覆盖该 desired revision。

trace 首先是 internal test/diagnostic artifact。只有证明 `CommitSummary` 的现有事实不足，才单独设计公开扩展；不得在本提案中预设新的错误 contract。

## 工作流二：Model-based transition 测试

现有 Core 测试继续作为明确回归用例；生成式测试增加序列覆盖，不取代具名场景。

### Action alphabet

最小 action 集合可以包括：

- add、remove、restart、replace；
- config/dependency override mutation；
- required/optional provider success、failure 与 recovery；
- `init()` resolve、reject、timeout 和 late settlement；
- invocation enter、abort、release；
- cleanup resolve、reject、reentrant register 和 nested scope disposal；
- commit request 在另一 commit 执行期间到达。

测试 harness 应使用可控 scheduler，不依赖真实时间和不可复现 race。失败必须输出 seed、action 序列、最终 draft、commit summaries 与 lifecycle trace。

### Oracle

Oracle 不复制 production scheduler。它只维护抽象 ownership 与 graph rules，并在每个稳定点检查上一节的不变量。需要特别验证：

```text
相同最终 desired state
  + 不同合法 batching / async settlement order
  -> 相同的静止 running projection
  + 没有旧 generation publication 或 effect leak
```

这是一条有边界的 convergence 假设。若某些外部 effect、timeout policy 或显式 failure retry 会使结果依赖历史，模型必须记录该事实，
不能通过忽略差异伪造 confluence。

### 初始范围

第一批模型只覆盖 `@pluxel/core` 的 graph、generation、invocation 和 effects，不加载 Vite、数据库、HTTP 或 Workbench。模型稳定后，
再用少量真实 dynamic route 测试验证 module batch 到 Core action 的映射。

不预先指定 property testing library。若一个小型确定性 exhaustive harness 已能覆盖目标状态空间，就不为工具本身引入长期依赖。

## 工作流三：Provider withdrawal 与 generation lease 审计

当前 graph ordering 要求 consumer-first stop，多个 runtime capability 也会把 handle 绑定 consumer owner 与 provider generation。
未来工作先建立 capability matrix，逐项验证：

| 问题                                       | 必须记录的事实                                           |
| ------------------------------------------ | -------------------------------------------------------- |
| consumer cleanup 能否使用旧 provider       | provider final drain 的实际顺序与调用结果                |
| consumer 停止后 cached handle 如何失败     | admission close 时点、错误类型与新调用行为               |
| provider 停止后 in-flight call 如何结束    | abort、等待、允许 settle 或领域 transaction 边界         |
| replacement 是否复用底层 root resource     | generation handle 与 root-owned resource 的分离方式      |
| 手动 dispose 是否改变 generation ownership | registration withdrawal 与 invocation ownership 是否分离 |

审计范围至少包括 commands、HTTP、database、cache、rates、worker task、Workbench resource/grant 和 caller-bound Plugin view。

只有当审计证明多个 capability 在重复实现同一个状态机，并且抽取能删除代码、统一错误和增加测试覆盖时，才研究 internal
`GenerationLease` 一类 primitive。否决抽取的条件包括：

- 不同领域对已提交操作的终止语义真实不同；
- primitive 需要进入 Plugin 作者 API；
- 为统一少量代码而引入新的 ambient current-owner protocol；
- root-owned durable resource 与 generation-owned handle 被错误合并。

## 工作流四：System boundary 分类

为 Plugin side effect 建立统一分类，供用户文档、review checklist 和测试选择使用：

| 类别                 | 例子                                    | 所有权与恢复方式                                             |
| -------------------- | --------------------------------------- | ------------------------------------------------------------ |
| 进程内可撤销资源     | route、listener、timer、registration    | generation effects；cleanup at-most-once                     |
| 可等待终止的异步任务 | worker、watcher、queue consumer         | 停止接纳、abort、等待退出，再完成 cleanup                    |
| 原子持久化状态       | 同一数据库 transaction 内的 rows/outbox | 由数据库 transaction commit/rollback                         |
| 外部 emission        | S3 PUT、邮件、第三方 API、已投递消息    | withholding、幂等 key、state machine、outbox 或 compensation |

交付物首先是现有用户文档的统一入口和 Plugin review checklist。只有存在可静态识别且误报率可控的 authoring pattern，才考虑 lint；
不得建立一个宣称自动回滚外部 emission 的通用 effects API。

## 工作流五：Dependency compatibility diagnostics

研究分三层推进：

1. **可观测**：诊断中同时显示 consumer/provider definition identity、解析到的 package version/range 与 replacement lineage；
2. **构建检查**：确认 semantic facts 生成的 peer dependency metadata 与实际 package manifest 一致；
3. **显式契约实验**：只在真实跨版本 Plugin use case 证明需要时，研究 schema/contract revision 或 compatibility fingerprint。

以下问题保持开放：

- package manager 已经完成的 semver resolution，Pluxel 还需要检查哪些额外事实；
- type assignability 与 runtime wire/schema compatibility 应由 toolchain、Plugin package 还是领域协议负责；
- replacement lineage 是否足以描述 migration boundary；
- fingerprint 如何避免把 private implementation detail 变成兼容承诺；
- static 与 dynamic source 如何产生一致诊断，而不建立第二套 identity。

不采用自动选择多个 provider 版本、运行时 structural duck typing 或静默 compatibility fallback。诊断不得改变 constructor required edge 和
optional ref 的作者模型。

## Effect independence 与并发边界

论文中的 effect independence 提醒我们：graph 无依赖不代表两个 Plugin 的任意外部 effect 可以安全交换。Pluxel scheduler 可以根据 graph
并行处理无依赖 node，但 Plugin 仍可能通过进程全局、文件、数据库或远端系统共享隐藏状态。

本提案只要求：

- Core 不把 graph independence 描述成任意业务 effect 的 commutativity；
- 并发测试验证 Pluxel 自己拥有的 graph publication、generation ownership 与 cleanup ordering；
- 领域共享资源继续由 database isolation、root registry、lock、幂等或明确 broker 负责；
- 未建立资源冲突模型前，不以“形式独立”为理由扩大 lifecycle 并发度。

若未来提出 effect conflict key 或 resource domain，必须以真实 scheduler 收益和领域 use case 另立 proposal。

## 分阶段计划

### Phase 0：词汇与基线

- 整理 lifecycle abstract state、transition 与候选不变量；
- 将现有具名测试映射到不变量矩阵；
- 标出尚无测试证据和只能由领域假设成立的条目；
- 不修改 public API。

### Phase 1：生成式验证

- 建立 deterministic scheduler 与最小 action alphabet；
- 覆盖 commit batching、late settlement、reentrant cleanup 和 optional availability；
- 固化可复现失败输出；
- 以发现的反例修正实现或收窄不变量。

### Phase 2：跨能力审计

- 完成 provider withdrawal/generation handle matrix；
- 建立 system boundary 用户文档入口；
- 补齐领域集成测试，不先抽象公共 primitive。

### Phase 3：选择性设计

- 仅在审计证据支持时，分别提出 internal lease primitive、transition diagnostics 或 compatibility metadata；
- 每项设计独立评估 package boundary、错误 contract、性能和迁移成本；
- 未证明净收益的方向留在 proposal，不进入当前架构文档。

## 验收条件

本提案完成不等于所有研究方向都实现。最低验收条件是：

1. 每条 lifecycle 不变量都有当前实现入口、测试证据或明确的未满足标记；
2. 生成式测试能稳定复现至少 commit batching、late `init()`、optional transition 和 reentrant drain 序列；
3. 相同 seed 在 CI 与本地得到相同行为，失败输出足以重放；
4. provider withdrawal matrix 覆盖所有 owner-bound runtime capability，并记录领域差异；
5. 用户文档能明确区分四类 system boundary，不暗示外部 emission 可自动回滚；
6. compatibility 研究给出可观测事实与否决条件，不引入隐式版本协商；
7. 没有因为本研究新增第二套 Plugin dependency declaration 或生命周期 hook。

## 停止与拆分条件

- 抽象模型若必须复制 production scheduler 才能判断正确性，应缩小模型状态，而不是维护第二套 runtime。
- 生成式测试若主要产生无法重放的时间 race，应改用显式 scheduler；不能用扩大 timeout 掩盖问题。
- generation lease 若不能统一至少两个真实 capability 并删除重复状态机，应停止抽取。
- compatibility metadata 若不能比 package manager、TypeScript 与 schema validation 提供更多可操作信息，应停止设计。
- 任一方向需要改变 public API、配置、错误 contract 或 package boundary 时，必须从本文拆成独立 proposal，并重新执行 library API review。

## 设计结论

这项研究要学习 Cordis 论文的推理纪律，而不是复制它的统一 Context/Fiber realization。Pluxel 当前的架构选择仍然成立：业务组成进入
Plugin graph，资源修改进入 generation effects，宿主能力进入稳定 Context，调用适配保留在局部边界。

未来精进的重点，是让这些边界从“实现中可以看出”升级为“语义上能够陈述、测试中能够反驳、诊断中能够解释”。如果研究最终只得到
更好的不变量、测试和边界文档，而没有产生任何新 API，也属于成功结果。
