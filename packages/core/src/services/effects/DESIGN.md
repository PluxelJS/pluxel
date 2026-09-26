# Effects 实现契约

实现位于 [EffectsService.ts](./EffectsService.ts)，用法见 [README](./README.md)。Core 为每个 Plugin generation 提供 effects，Part 使用归属明确的 child scope；图提交、调用准入与启动策略由上层生命周期管理。

## 注册与释放

| 操作                                 | 保证                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `defer` / `own`                      | 登记 cleanup / disposable，返回 `EffectGuard`                                    |
| `acquire`                            | 先检查准入，获取成功后再次检查；晚到资源等待 best-effort release，再抛出登记错误 |
| `scope`                              | 子 scope 自动由父级纳管，可提前释放                                              |
| `guard.dispose()` / `disposeAsync()` | 同一条目最多执行一次；异步释放共享进行中的工作                                   |
| `guard.cancel()`                     | 注销尚未运行的条目，不执行 cleanup；调用方接管释放责任                           |
| `effects.dispose()`                  | 并发、重复调用共享同一 Promise；完成后保留成功或失败结果                         |

Entry 使用 `ACTIVE → RUNNING → DONE`。Guard 保存 id 与 token，复用 id 不会让旧 Guard 操作新资源；结束后清空资源引用并回收 id。并行数组存 entry，三个栈保存带 token 的 handle。

Service 使用 `LIVE → DISPOSING → DISPOSED`。释放中允许登记，释放后登记抛 `EffectsDisposedError`。按 `shutdown → runtime → final` drain，各 phase 内 LIFO；cleanup 新登记的更早 phase 提升到当前 phase，确保同次 drain 处理。单项失败不阻断其余清理，最终抛 `AggregateError`；`critical` 只参与诊断。

## 事务

`transaction(fn)` 仅在 LIVE 状态接纳。活动事务冻结普通 view 的登记与同级事务（`EffectsFrozenError`）；嵌套必须从当前 tx 发起，子事务活动期间父 tx 同样冻结。每个事务按 phase 保存带 token 的登记 handle，子事务登记也归祖先所有；子事务失败只回收自己的资源，成功后仍可由祖先回滚。rollback 不再依赖共享栈长度，也不改写正常 dispose 的 drain phase。

callback resolve/reject 或 owner dispose 会撤回 tx view，之后操作抛 `EffectsDisposedError`。事务必须 await 子事务与 acquire；未等待的子事务不能提交到已结束的父事务。`tx.dispose()` 撤回并回收本事务，不关闭父 effects；callback 因 tx 已撤回而拒绝提交。rollback 完成前同级事务仍冻结；rollback 失败聚合原始错误与清理错误。

`acquire()` 在获取前后检查准入；晚到资源不会登记到后续事务，而是等待 release 后拒绝。effects dispose 不等待尚未登记的 acquire 或任意 callback，调用方仍须等待这些 Promise，release 失败写入日志并保留原始准入错误。

这是资源登记事务，不是 Plugin graph 或数据库事务。异步任务必须以可等待 cleanup 或 disposable 明确登记：abort 通知本身不表示任务已退出。

## ES 资源管理

Guard 的 `Symbol.dispose` 遇到异步 cleanup 会抛错，要求使用 `await using` 或显式 await；`Symbol.asyncDispose` 等待释放。Effects scope 支持 `await using`。

## 修改时验证

覆盖重复释放、id 复用、reentrant 登记、跨 phase 登记、嵌套 rollback、冻结登记失败、acquire 失败补偿与 cleanup 错误聚合。Plugin 生命周期测试还需验证 init 返回资源、Part scope 和 late init settle 都进入同一 generation drain。
