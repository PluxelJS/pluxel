# Core Lifecycle Semantics

本文记录 `@pluxel/core` 当前已实现、可测试的 lifecycle 语义。它是维护者语义索引，不是 Plugin 作者 API，也不引入新的 public hook、错误 contract 或配置字段。

权威实现入口仍是 [`CORE.md`](CORE.md) 中列出的 Core runtime 文件；本文只把分散在实现、领域文档和测试中的规则整理成稳定词汇、transition 边界和测试矩阵。

## 抽象状态词汇

| 词汇                    | 当前实现中的事实                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| desired graph           | `PluginDefinitions` draft、runtime update draft、pending restart/start 意图共同描述下一次 `commit()` 需要达成的组成。                                                                    |
| committed graph         | `PluginDefinitions.lastGraph`，由 `definitions.build()` 验证后 `confirm()` 发布。                                                                                                        |
| node generation         | 一个 `PluginNodeSlot` 在 runtime cache 中对应的一次 `BasePlugin` instance 加 `PluginLifecycleActor`。replacement、restart、rollback cleanup 都结束旧 generation。                        |
| dependency availability | `PluginService.getRunningRuntimeInstance()` 与 graph resolution 共同决定 provider 是否可注入。required availability 影响 start scheduling；optional availability 影响 consumer restart。 |
| owner admission         | owner invocation gate 在 generation drain 开始时关闭；新 invocation 被拒绝，已接纳 invocation 收到 abort 并被等待。                                                                      |
| effect ownership        | `EffectsService` entry 从 registered/active 进入 running cleanup，随后 terminal；重复 dispose 共享 drain 结果，entry cleanup 至多被消费一次。                                            |

这些词汇用于测试和诊断讨论。不要把它们直接暴露为 public enum，也不要要求 Plugin 作者声明这些状态。

## Transition 边界

Core commit 的当前顺序是：

```text
draft records/graph -> verify -> prepare stop/start plan -> stop old generations
                    -> confirm records/graph -> start new generations -> publish CommitSummary
```

关键边界：

- verify/prepare 失败会丢弃全部 pending definition、node、binding 和 restart overlay，不替换 committed graph，也不停止当前 generations；
- lifecycle transition 开始即越过 point of no return；之后的 config/start/drain failure 进入 report，不把已关闭 admission 的旧 generation
  伪装成可恢复 snapshot；
- stop 使用 required + optional ordering 的 consumer-first 顺序；
- start 使用 provider-first 顺序，required provider failure 只阻塞 dependent closure；
- optional absent -> absent retry 不重启 consumer；absent -> running、running -> absent 和 running generation replacement 会重启 consumer 及其 required dependent closure；
- generation stop 先关闭 owner admission，再 abort generation，再 drain effects；
- construction/finalize/config injection/init 失败会淘汰该 generation 的 runtime cache；rollback cleanup 失败不会覆盖 primary cause，
  而是作为独立 `drain-failed` fact 进入同一 report；
- reachable PluginPart 的 required provider 在 owner graph 上统一调度；Part constructor/init/cleanup 失败结束整个 owner generation，
  report 保留 definition-local `partPath`，但不产生 Part lifecycle 状态；
- Part occurrence attribution 由 Core internal state 与 effects metadata 持有；Context 不公开 attribution 或等价 identity accessor；
- `init()` abort 或 timeout 后的 late fulfillment 不会发布 running generation；late cleanup 会立即进入同一 drain/report 边界；
- `CommitSummary` 描述 Core 已观察到的 lifecycle facts；宿主负责把这些事实解释为退出、告警、降级或重试策略。

## 不变量矩阵

| ID  | 不变量                                                                                                                   | 当前测试证据                                                                                                        | 边界                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| L1  | running consumer 的每个 required dependency 都解析到 running provider generation。                                       | `PluginService.lifecycle-model.test.ts`, `PluginService.failures.test.ts`, `PluginService.cascade.test.ts`          | 只覆盖 lowered graph dependency；任意 runtime lookup 不会被提升为 required edge。                    |
| L2  | 同一 Plugin node 在稳定点最多有一个可对外使用的 generation。                                                             | `PluginService.lifecycle-model.test.ts`, `PluginService.inflight-update.test.ts`                                    | 稳定点指 awaited commit 后；不声明 rolling update 零停机。                                           |
| L3  | generation 离开 running 后不再接受新的 owner invocation。                                                                | `OwnerInvocations.test.ts`                                                                                          | 只覆盖通过 owner invocation gate 接纳的调用。                                                        |
| L4  | consumer cleanup 完成前，其 graph provider 不进入最终 drain。                                                            | `PluginService.teardown.test.ts`, `PluginService.optional.test.ts`, `PluginService.lifecycle-model.test.ts`         | graph ordering 不能证明隐藏外部 effect 可交换。                                                      |
| L5  | 已失效的 `init()` settlement 不得重新发布 generation。                                                                   | `PluginService.late-init.test.ts`, `PluginService.inflight-update.test.ts`, `PluginService.lifecycle-model.test.ts` | late returned cleanup 会被执行并进入 report；无法接管脱离 signal/effects 的后台任务。                |
| L6  | 每个 effects cleanup entry 至多执行一次。                                                                                | `EffectsService.test.ts`, `EffectsService.scope.test.ts`, `PluginService.lifecycle-model.test.ts`                   | cleanup 是否真是原操作的逆由领域代码负责。                                                           |
| L7  | drain 中 reentrant 登记的 cleanup 也在该 drain 边界内到达 terminal。                                                     | `EffectsService.test.ts`, `EffectsService.scope.test.ts`, `PluginService.lifecycle-model.test.ts`                   | 仅限通过同一 effects service 注册的 entry。                                                          |
| L8  | required provider failure 只阻塞 dependent closure，不破坏无关 running branch。                                          | `PluginService.failures.test.ts`, `PluginService.lifecycle-model.test.ts`                                           | 宿主进程级故障和外部系统故障不在 Core graph failure propagation 内。                                 |
| L9  | optional absent -> absent 不产生 consumer restart；真实 availability transition 对同一 consumer 每个 plan 最多重启一次。 | `PluginService.optional.test.ts`, `PluginService.lifecycle-model.test.ts`                                           | optional callback 必须是 lowered direct `plugins.use()`。                                            |
| L10 | 系统静止后，running projection 与最新成功验证的 desired graph 及 lifecycle failure facts 一致。                          | `PluginService.lifecycle-model.test.ts`, `PluginService.registration.test.ts`, `PluginService.failures.test.ts`     | 这是 bounded convergence 断言；timeout、外部 emission 和显式宿主 retry policy 仍可能让历史影响结果。 |
| L11 | generation admission 的 primary failure 与 rollback drain failure 是独立事实；失败 instance 不留在 runtime cache。       | `PluginService.failures.test.ts`, `PluginService.late-init.test.ts`                                                 | late settlement 在初次 summary 发布后通过 immutable successor 增补，不回写历史对象。                 |
| L12 | PluginPart dependency、construction、init 与 cleanup 共享 owning Plugin 的 graph/generation 边界。                       | `PluginPart.test.ts`, `PluginLoweringAbi.test.ts`                                                                   | `partPath` 只用于 config/diagnostic attribution，不是可治理 identity。                               |

## Model-Style 测试要求

新增 lifecycle model-style 测试遵循这些约束：

- action trace 使用确定性 seed/name 输出，失败时带上已经执行的 action 序列；
- oracle 只检查抽象 ownership、running projection 和 dependency availability，不复制 `PluginService` 的 scheduler；
- 每个 awaited commit 后才检查稳定点不变量；
- 测试覆盖多种 batching 顺序、queued commit、late settlement、reentrant cleanup、optional absent/recovery、required failure blocking 和 effect active count；
- 后续扩展 action alphabet 时，优先复用同一 trace runner，避免把每个 race 重新写成互不关联的单项测试。

第一批范围只覆盖 Core graph、generation、invocation 和 effects。Vite、database、HTTP、Workbench 或 worker capability 需要各自的领域审计后再接入。
