# Core DI kernel

本目录是 Plugin graph 使用的内部增量 DI 实现，不是公开通用容器。插件作者只声明 constructor dependency；框架约束见 [CORE.md](../../../../../engineering/CORE.md)。

## 数据与职责

| 实现                                               | 所有权                                                         |
| -------------------------------------------------- | -------------------------------------------------------------- |
| [graph.ts](./graph.ts) 的 `DraftGraph`             | staged provider 声明、dirty slots、编译和提交                  |
| `GraphSnapshot`                                    | 已验证声明、token owner、required/optional 正反向边与 revision |
| `Runtime`                                          | 对指定 snapshot 同步解析和激活 provider                        |
| [InstanceStore.ts](./InstanceStore.ts)             | 显式实例缓存及全局/逐 key revision                             |
| [errors.ts](./errors.ts)、[result.ts](./result.ts) | 图验证错误与 Result                                            |

`NodeKey` 是节点身份，`Token` 是查找入口；一个节点可提供多个 token，同一 token 不能有多个有效 provider。Plugin 层传入 interned slot，不能用 class name 或 displayName 替代身份。

Provider 明确声明 `deps`、`optionalDeps`、`cache` 与 class/factory/value。没有 reflection 或 autowiring；required 参数顺序保留。Optional edge 参与排序与重启关系，provider 缺失不使图验证或激活失败。

## 编译与提交

1. 修改 draft 声明，记录 touched slot 与 token ownership 变化。
2. 计算 affected closure，解析依赖并验证缺失、重复与循环；复用未变化的 snapshot 数据。
3. build 产生候选 `graph`、`delta`、`instances` 与 `runtime`，由上层协调生命周期后 `commit()`；`reset()` 撤回 staged 状态。

`delta` 区分 added、removed、replaced、affected 与 retargetedTokens。affected 表示需要重新评估的依赖闭包，不代表全部删除或立即重建。候选构建不提前改写 committed graph；不要跳过候选版本校验发布过时结果。

Snapshot 使用数字 slot、分块表与按需 activator/edge caches，规划缓存绑定 draft state 和 mutation version。优化须保留旧 snapshot 的可读性、token retargeting 与 rollback 边界。

## 缓存与生命周期

`retain` provider 复用 InstanceStore；`fresh` 按调用构造。Runtime 的快速缓存同时核对 store 与 key revision，外部删除或替换实例不得返回旧值。缓存值可能是 `undefined`，存在性不能通过 truthiness 判断。

Kernel 不启动或停止 Plugin，不 drain effects，不拥有 Vite/HMR、持久化、Host 运行意图或异步资源协议。这些工作由 Core lifecycle 与 Host coordinator 按 graph facts 执行。

## 验证与性能

修改需覆盖多 token、provider 冲突、缺失 required、optional provider 加入/撤回、循环、替换、stale commit、retain/fresh 与实例缓存失效。历史对照数据见 [DI benchmark](../../../benchmarks/di-kernel-vs-diod.md)，不能用单次微基准推导整体 Host 性能。
