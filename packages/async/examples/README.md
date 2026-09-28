# 可运行示例

这些示例只使用公开子路径，不需要 Pluxel runtime。组合函数与运行入口分开，便于复制到自己的项目并替换 IO adapter。

## 运行

在本仓库的 `packages/async` 目录，Node 24+：

```sh
pnpm examples
```

命令先构建包，再运行 [run.ts](./run.ts)。示例完全本地运行，不访问外部服务。正常结束码为 0；错误会打印并以非零结束码退出。

在自己的项目安装 `@pluxel/async` 后，将 `run.ts`、`process-records.ts`、`shared-requests.ts`、`cancel-subscriber.ts` 和 `cancel-wait.ts` 复制到项目的 `examples/`，再执行 `node examples/run.ts`。Node 原生 TypeScript 执行不代替类型检查；本仓库把所有示例纳入包级 typecheck。

## 可选 Pacer 组合

在本仓库的包目录运行 `pnpm examples:pacer`。外部项目需另外安装 `@tanstack/pacer@0.22.0`，复制 `pacer-run.ts` 与 `pacer-shared-reads.ts` 后运行 `node examples/pacer-run.ts`。这是当前验证的版本，不承诺其他版本契约相同。

Pacer 仅作为本仓库开发依赖，不是 async 的运行依赖。普通 examples 命令不加载它。示例没有远程 IO：同 key 的两次读取共享一次工作，另一 key 显式返回 rate-limited；一个订阅者取消后另一个得到 A，最终关闭会清理窗口计时器。

## 按场景选择

| 场景                                           | 示例                                           | 观察结果                                                        |
| ---------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| 每条记录并行读取两份依赖，再有界处理、批量写入 | [process-records.ts](./process-records.ts)     | 三条记录汇入一个 batch；图只编译一次，mapper 失败时先排空子任务 |
| 重复 ID 合并回源，每次重试共享请求额度         | [shared-requests.ts](./shared-requests.ts)     | a 读取一次、b 读取两次；仍按输入次数保存 A、A、B                |
| 一个订阅者离开，另一个继续等待同一读取         | [cancel-subscriber.ts](./cancel-subscriber.ts) | 底层任务执行一次；第一个 rejected，第二个 fulfilled 为 Ada      |

`process-records` 使用完成顺序，业务不能依赖输出顺序；已写入的 batch 不会因后续失败自动回滚。

`shared-requests` 的去重只覆盖在途区间，不是整个输入的去重或结果缓存。真实 IO 用 run.ts 中的 adapter 替换点接入；只有可以安全重试的操作才能被 shouldRetry 授权。先关闭 shared reads，再关闭它们仍可能使用的 limiter，避免收尾时阻断重试。

`cancel-subscriber` 用手动 Promise 控制完成时机，不依赖定时器制造竞态。共享操作的取消权属于创建者，不能将某个订阅者的 signal 直接传给共享 IO。

从简单组合开始：

- [cancel-wait.ts](./cancel-wait.ts)：limit + waitFor。取消后 activeCount 和 pendingCount 都为 1，第二项未开始；底层读取完成后得到 [1, 2]。
- [pacer-shared-reads.ts](./pacer-shared-reads.ts)：singleflight + Pacer 同步 RateLimiter。它返回显式业务结果，区分限速拒绝与包括 undefined 在内的成功值；实际 IO 错误原样传播。

完整组合顺序、错误边界和反例见 [实用组合](../docs/recipes.md)。防抖并不保证每次调用都得到对应参数的结果，限流的接纳回执也不是 IO 完成；不能仅因为返回 Promise 就互相替换。

需要单个 API 的最短用法、默认值和边界，见 [使用指南](../docs/guide.md)。示例不是额外 API，也不提供分布式锁、事务或持久缓存。
