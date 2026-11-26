# Core Lifecycle Semantics

Core 的 commit、generation 和 effects 按下述状态转换与不变量运行。源码入口见 [Core](CORE.md)，本页集中维护 transition、publication 和对应测试。

## 抽象状态词汇

| 词汇                    | 当前实现中的事实                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| desired graph           | `PluginDefinitions` draft、runtime update draft、pending restart/start 意图共同描述下一次 `commit()` 需要达成的组成。                                                                    |
| committed graph         | `PluginDefinitions.lastGraph`，由 `definitions.build()` 验证后 `confirm()` 发布。                                                                                                        |
| node generation         | 一个 `PluginNodeSlot` 在 runtime cache 中对应的一次 `BasePlugin` instance 加 `PluginLifecycleActor`。replacement、restart、rollback cleanup 都结束旧 generation。                        |
| dependency availability | `PluginService.getRunningRuntimeInstance()` 与 graph resolution 共同决定 provider 是否可注入。required availability 影响 start scheduling；optional availability 影响 consumer restart。 |
| owner admission         | owner invocation gate 在 generation drain 开始时关闭；新 invocation 被拒绝，已接纳 invocation 收到 abort 并被等待。                                                                      |
| effect ownership        | `EffectsService` entry 从 registered/active 进入 running cleanup，随后 terminal；重复 dispose 共享 drain 结果，entry cleanup 至多被消费一次。                                            |

这些词汇用于内部测试与诊断；Plugin 作者使用[公开生命周期接口](../docs/plugin-development/lifecycle.md)。

## Transition 边界

Core commit 的当前顺序是：

```text
draft records/graph -> verify -> prepare stop/start plan -> stop old generations
                    -> confirm records/graph -> start new generations
                    -> host publication -> publish CommitSummary
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
- root 创建前固定的 package-private generation finalizer 在 Part 与 Plugin init 成功后、running transition 前执行；finalizer throw 仍是
  `start-failed`，并进入同一 rollback/drain 边界。init 已因 abort/timeout 失效时不再调用 finalizer；
- 独立 generation finalizer 可以并发，跨 generation validation 不在 completion-order-sensitive finalizer 中 first-wins。Core 在 start wave
  结束后以 provider-first、同 frontier canonical node address 顺序调用 async host settlement；settlement rejection 作为对应 generation
  `start-failed`，required closure 被 drain/block，optional ordering closure 重启，新 generation 继续在同一 operation 内 settlement；
- 同一 operation 的全部 start outcome 确定后，package-private async host preparation 先消费最终 frozen publication fact，再由同步
  publication callback 消费同一 object identity。两者都位于 `_lastCommit`、instance watcher、commit listener 与返回值可见前；
  publication 只允许 no-fail/no-return pointer exchange。任一 callback 违反契约会原样拒绝 commit、阻止 summary publication并把 root
  标记为不可继续提交，不回滚已经确认的 graph；
- reachable PluginPart 的 required provider 在 owner graph 上统一调度；Part constructor/init/cleanup 失败结束整个 owner generation，
  report 保留 definition-local `partPath`，但不产生 Part lifecycle 状态；
- Part occurrence attribution 由 Core internal state 与 effects metadata 持有；Context 不公开 attribution 或等价 identity accessor；
- `init()` abort 或 timeout 后的 late fulfillment 不会发布 running generation；late cleanup 会立即进入同一 drain/report 边界；
- `CommitSummary` 描述 Core 已观察到的 lifecycle facts；宿主负责把这些事实解释为退出、告警、降级或重试策略。

## 不变量矩阵

测试路径相对 `packages/core/tests/`。

| ID  | 不变量                                                                                                                      | 当前测试证据                                                                                                 | 边界                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| L1  | running consumer 的每个 required dependency 都解析到 running provider generation。                                          | `plugins/PluginRecovery.test.ts`                                                                             | 只覆盖 lowered graph dependency；任意 runtime lookup 不会被提升为 required edge。                    |
| L2  | 同一 Plugin node 在稳定点最多有一个可对外使用的 generation。                                                                | `plugins/PluginService.inflight-update.test.ts`, `plugins/CoreTestHost.test.ts`                              | 稳定点指 awaited commit 后；不声明 rolling update 零停机。                                           |
| L3  | generation 离开 running 后不再接受新的 owner invocation。                                                                   | `plugins/OwnerInvocations.test.ts`                                                                           | 只覆盖通过 owner invocation gate 接纳的调用。                                                        |
| L4  | consumer cleanup 完成前，其 graph provider 不进入最终 drain。                                                               | `plugins/PluginService.teardown.test.ts`, `plugins/PluginIntegration.test.ts`                                | graph ordering 不能证明隐藏外部 effect 可交换。                                                      |
| L5  | 已失效的 `init()` settlement 不得重新发布 generation。                                                                      | `plugins/PluginService.late-init.test.ts`, `plugins/PluginService.inflight-update.test.ts`                   | late returned cleanup 会被执行并进入 report；无法接管脱离 signal/effects 的后台任务。                |
| L6  | 每个 effects cleanup entry 至多执行一次。                                                                                   | `EffectsService.test.ts`, `EffectsService.scope.test.ts`                                                     | cleanup 是否真是原操作的逆由领域代码负责。                                                           |
| L7  | drain 中 reentrant 登记的 cleanup 也在该 drain 边界内到达 terminal。                                                        | `EffectsService.test.ts`, `EffectsService.scope.test.ts`                                                     | 仅限通过同一 effects scope 注册的 entry。                                                            |
| L8  | required provider failure 只阻塞 dependent closure，不破坏无关 running branch。                                             | `plugins/PluginRecovery.test.ts`                                                                             | 宿主进程级故障和外部系统故障不在 Core graph failure propagation 内。                                 |
| L9  | optional absent -> absent 不产生 consumer restart；真实 availability transition 对同一 consumer 每个 plan 最多重启一次。    | `plugins/PluginIntegration.test.ts`                                                                          | optional callback 必须是 lowered direct `plugins.use()`。                                            |
| L10 | 系统静止后，running projection 与最新成功验证的 desired graph 及 lifecycle failure facts 一致。                             | `plugins/PluginRecovery.test.ts`                                                                             | 这是 bounded convergence 断言；timeout、外部 emission 和显式宿主 retry policy 仍可能让历史影响结果。 |
| L11 | generation admission 的 primary failure 与 rollback drain failure 是独立事实；失败 instance 不留在 runtime cache。          | `plugins/PluginRecovery.test.ts`, `plugins/PluginService.late-init.test.ts`                                  | late settlement 在初次 summary 发布后通过 immutable successor 增补，不回写历史对象。                 |
| L12 | PluginPart dependency、construction、init 与 cleanup 共享 owning Plugin 的 graph/generation 边界。                          | `plugins/PluginAssembly.test.ts`, `plugins/PluginPartLifecycle.test.ts`, `plugins/PluginLoweringAbi.test.ts` | `partPath` 只用于 config/diagnostic attribution，不是可治理 identity。                               |
| L13 | host finalizer 位于 author init 与 running 之间；commit publication 位于全部 start outcome 与任何稳定 summary reader 之间。 | `plugins/PluginService.host-lifecycle.test.ts`                                                               | 两者只通过 pre-root package-private authority安装；publication callback 不允许异步工作或用户代码。   |

## 回归场景

每个生命周期用例围绕一次会改变运行结果的操作。在操作结算后核对当前 instance、回执或已释放的资源。用可控的异步屏障验证仍在进行的 init、invocation 和清理，并在操作完成后检查下一代是否可用。边界选择见[测试设施](TESTING.md#回归取舍与验证所有权)。
