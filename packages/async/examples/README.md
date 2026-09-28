# 可运行示例

这些示例只使用公开子路径，不需要 Pluxel runtime。组合函数与运行入口分开，便于复制到自己的项目并替换 IO adapter。

## 运行

在本仓库的 `packages/async` 目录，Node 24+：

```sh
pnpm examples
```

命令先构建包，再运行 [run.ts](./run.ts)。示例完全本地运行，不访问外部服务。正常结束码为 0；错误会打印并以非零结束码退出。

在自己的项目安装 `@pluxel/async` 后，将本目录的四个 `.ts` 文件复制到项目的 `examples/`，再执行 `node examples/run.ts`。Node 原生 TypeScript 执行不代替类型检查；本仓库把所有示例纳入包级 typecheck。

## 按场景选择

| 场景                                           | 示例                                           | 观察结果                                                        |
| ---------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| 每条记录并行读取两份依赖，再有界处理、批量写入 | [process-records.ts](./process-records.ts)     | 三条记录汇入一个 batch；图只编译一次，mapper 失败时先排空子任务 |
| 重复 ID 合并回源，每次重试共享请求额度         | [shared-requests.ts](./shared-requests.ts)     | a 读取一次、b 读取两次；仍按输入次数保存 A、A、B                |
| 一个订阅者离开，另一个继续等待同一读取         | [cancel-subscriber.ts](./cancel-subscriber.ts) | 底层任务执行一次；第一个 rejected，第二个 fulfilled 为 Ada      |

`process-records` 使用完成顺序，业务不能依赖输出顺序；已写入的 batch 不会因后续失败自动回滚。

`shared-requests` 的去重只覆盖在途区间，不是整个输入的去重或结果缓存。真实 IO 用 run.ts 中的 adapter 替换点接入；只有可以安全重试的操作才能被 shouldRetry 授权。先关闭 shared reads，再关闭它们仍可能使用的 limiter，避免收尾时阻断重试。

`cancel-subscriber` 用手动 Promise 控制完成时机，不依赖定时器制造竞态。共享操作的取消权属于创建者，不能将某个订阅者的 signal 直接传给共享 IO。

需要单个 API 的最短用法、默认值和边界，见 [使用指南](../docs/guide.md)。示例不是额外 API，也不提供分布式锁、事务或持久缓存。
