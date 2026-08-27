# 时空可组合性思考记录

本文是维护者思考文档，不是当前 API、配置契约、错误契约或 roadmap 承诺。当前事实以
[`CORE.md`](CORE.md)、[`PLUGIN_SYSTEM.md`](PLUGIN_SYSTEM.md)、各领域文档和 `docs/` 为准。

这份记录来自对 [Cordis 论文](https://github.com/cordiverse/paper)中 revertible effect、reactive coeffect、Context/Fiber
和 system boundary 的对照。它不要求 Pluxel 复制 Cordis 的统一 realization；它的作用是持续约束我们如何描述、测试和诊断
Pluxel 已经拥有的动态组成模型。

## 已固化的事实

- Core lifecycle 词汇、不变量和测试矩阵已经整理到
  [`CORE_LIFECYCLE_SEMANTICS.md`](CORE_LIFECYCLE_SEMANTICS.md)。
- Core model-style transition 测试入口已经落地到
  `packages/core/tests/PluginService.lifecycle-model.test.ts`，覆盖 batching、queued commit、late `init()` settlement、
  reentrant cleanup、optional availability 和 required failure locality。
- owner-bound runtime capability 的 provider withdrawal、cached handle 与 in-flight 边界已经整理到
  [`PROVIDER_WITHDRAWAL_AUDIT.md`](PROVIDER_WITHDRAWAL_AUDIT.md)。
- commands manual dispose、Elysia contribution withdrawal/in-flight lease、database cached handle、Node module pending update、Workbench
  RPC/events lifecycle 和 rates cached limiter lifecycle 都已有回归证据。
- 当前没有足够证据抽取统一 `GenerationLease`。capability 之间的 owner/admission/cleanup 语义仍然有真实差异。

## 核心判断

Pluxel 的动态组成仍然由三条边界共同承担：

- business dependency 进入 Plugin graph，由 lowered constructor dependency 和 optional ref 表达；
- generation-owned resource 进入 effects，由 owner stop/replacement/rollback/shutdown 统一 drain；
- runtime capability 进入稳定 Context service，由各领域定义 publication、admission、in-flight 和 root resource 语义。

这三条边界不能互相偷换。特别是：

- graph ordering 能说明 provider/consumer generation 的 stop/start 顺序，不能证明任意外部 effect 可交换；
- effects cleanup 是进程内资源归属和 at-most-once 机制，不是已提交外部 emission 的数学逆；
- opaque grant、route、command、database handle、worker lease、cache bucket 和 rates limiter 都可能绑定 owner generation，
  但它们对已接纳工作的处理不同；
- root-owned durable resource 和 generation-owned handle 必须分开描述，不能为了统一 API 把它们合并。

## Lifecycle 语义

维护者讨论 lifecycle 时优先使用以下抽象词汇：

| 词汇                    | 当前含义                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| desired graph           | draft、runtime update draft、pending restart/start 意图共同描述下一次 `commit()` 希望达成的组成。 |
| committed graph         | 已验证并进入 lifecycle plan 的 graph。                                                            |
| node generation         | 某个 Plugin node 的一次 instance + lifecycle actor。                                              |
| dependency availability | required/optional provider 当前是否有可注入 running generation。                                  |
| owner admission         | generation 是否仍接受新 owner-bound invocation 或 capability operation。                          |
| effect ownership        | cleanup/disposable/release entry 是否仍 active，是否正在 cleanup，是否已 terminal。               |
| running projection      | awaited commit 后，host 对外可观察到的 running node 集合和 dependency resolution。                |

这些词汇是测试和诊断语言，不应被直接提升为 public enum 或 Plugin 作者 hook。

当前需要持续锁住的不变量：

1. running consumer 的 required dependency 必须解析到 running provider generation；
2. 稳定点上同一 Plugin node 最多有一个可对外使用的 generation；
3. generation 离开 running 后不再接受新的 owner invocation；
4. consumer cleanup 完成前，graph provider 不进入最终 drain；
5. 失效 `init()` 的 late settlement 不得重新发布 generation；
6. effects cleanup entry 至多执行一次；
7. drain 中 reentrant 登记的 cleanup 仍在同一 drain 边界内 terminal；
8. required provider failure 只阻塞 dependent closure，不破坏无关 running branch；
9. optional absent -> absent 不产生 consumer restart，真实 availability transition 对同一 consumer 每个 plan 最多重启一次；
10. 稳定点的 running projection 与最新成功验证的 desired graph 及 failure facts 一致。

第 10 条是 bounded convergence 断言。timeout、宿主 retry policy、外部系统状态和不可逆 emission 都可能让历史影响结果。

## Capability withdrawal

每个 owner-bound capability 都必须回答同一组问题，但答案不必相同：

| 问题                                       | 必须记录的事实                                           |
| ------------------------------------------ | -------------------------------------------------------- |
| consumer cleanup 能否使用旧 provider       | provider final drain 的实际顺序与调用结果                |
| consumer 停止后 cached handle 如何失败     | admission close 时点、错误类型与新调用行为               |
| provider 停止后 in-flight call 如何结束    | abort、等待、允许 settle 或领域 transaction 边界         |
| replacement 是否复用底层 root resource     | generation handle 与 root-owned resource 的分离方式      |
| 手动 dispose 是否改变 generation ownership | registration withdrawal 与 invocation ownership 是否分离 |

目前的结论是保留领域差异：

- commands stop 会关闭 owner invocation gate，abort 已接纳调用，并等待 invocation release；manual registration dispose
  只撤销 publication，让缓存 wrapper 后续返回 `COMMAND_NOT_FOUND`。
- Elysia contribution withdrawal 撤销未来 directory lookup、关闭 owner admission 并 abort 已接纳 request 的合成
  `request.signal`；Runtime 等待 handler 与 streaming response body settle，但不声称能强制终止忽略 signal 的任意 JavaScript。
- database stop 拒绝新 operation，并等待已经接纳的运行中和排队 operation 排空；transaction 不被 runtime 强行 abort。
- worker task 可以用 owner signal 取消 resolving/queued/running task，并等待已接纳 promise settle。
- Workbench grant revocation 是 publication/authorization 失效；它不取消已经进入的业务 RPC method。events channel 在 owner
  detach 或 browser disconnect 后进入 closed，迟到 push 被丢弃。
- cache 和 rates 都绑定 caller/provider generation，但 in-flight 语义不同：cache 迟到 continuation 会在 active check 处失败，
  rates 已提交给 backend 的判定允许 settle。

只有当多个 capability 真正重复同一个状态机，并且抽取能删除代码、统一错误、增加测试覆盖时，才重新考虑 internal primitive。
primitive 不应进入 Plugin 作者 API，也不应引入 ambient current-owner protocol。

## System boundary

Plugin side effect 需要按可撤销性分类，而不是统一叫 effect：

| 类别                 | 例子                                    | 所有权与恢复方式                                             |
| -------------------- | --------------------------------------- | ------------------------------------------------------------ |
| 进程内可撤销资源     | route、listener、timer、registration    | generation effects；cleanup at-most-once                     |
| 可等待终止的异步任务 | worker、watcher、queue consumer         | 停止接纳、abort、等待退出，再完成 cleanup                    |
| 原子持久化状态       | 同一数据库 transaction 内的 rows/outbox | 由数据库 transaction commit/rollback                         |
| 外部 emission        | S3 PUT、邮件、第三方 API、已投递消息    | withholding、幂等 key、state machine、outbox 或 compensation |

这张表是 review 和文档选择的入口。不要建立一个宣称可以自动回滚外部 emission 的通用 effects API。若某个 pattern 未来适合
lint，必须先证明它能静态识别且误报率可控。

## Dependency compatibility

Canonical package entry、root named export 和 constructor provenance 能避免纯字符串 key collision，但不能证明跨版本行为兼容。
兼容性诊断最多应先增加可观测事实：

- consumer/provider definition identity；
- package version/range；
- replacement lineage；
- semantic facts 与 package manifest 的一致性；
- browser/server schema 或 wire contract 的显式 revision。

不要做运行时 structural duck typing、自动选择多个 provider 版本或静默 compatibility fallback。若真实跨版本 Plugin use case
证明需要 schema/contract fingerprint，必须把 private implementation detail 与 public compatibility promise 清楚分开。

## 继续思考的方向

- transition diagnostics：现有 `CommitSummary` 是否足以解释 add/remove/replacement/required cascade/optional availability 的因果。
- model-style tests：继续扩大 action alphabet，但 oracle 只能检查抽象 ownership 和 graph rules，不能复制 production scheduler。
- dynamic route 映射：用少量真实 dynamic route 测试验证 module batch 如何映射到 Core action。
- Workbench liveQuery：补 variant 回收、owner stop、stream detach 和 database drain 的交错 trace。
- Redis adapter lifecycle：补 cache/rates adapter-level stale handle 与 in-flight integration trace。
- compatibility diagnostics：确认 package manager、TypeScript、schema validation 已提供哪些事实，再决定 Pluxel 是否需要额外输出。

任何方向一旦需要改变 public API、配置、错误 contract、package boundary 或 Plugin 作者模型，应拆成独立设计并重新执行
library API review。

## 设计结论

Pluxel 要学习的是 Cordis 的推理纪律，而不是把业务组成、资源回收、运行时 capability 和外部系统状态塞进一个统一抽象。

好的后续改进应当满足三点：语义能陈述、测试能反驳、诊断能解释。若最终只得到更好的不变量、回归测试和边界文档，没有产生任何新
API，也仍然是正确结果。
