---
title: Async 异步组合工具
description: 可独立使用的任务合并、有界迭代、并发控制与依赖图工具。
---

`@pluxel/async` 是零运行时依赖的 TypeScript / JavaScript 工具包。它可用于普通服务、脚本和数据处理，不需要 Pluxel Plugin、Context 或 Host。

## 可以做什么

| 场景                       | 工具               | 解决的问题                                     |
| -------------------------- | ------------------ | ---------------------------------------------- |
| 多个调用者同时读取同一资源 | singleflight       | 共享一次在途任务，各自可以放弃等待             |
| 流式读取、转换和批量保存   | iter               | 限制接纳窗口，以 AsyncIterable 串联处理        |
| 多处调用共享资源额度       | limit / keyedLimit | 控制同时执行的数量，或按资源 key 串行执行      |
| 可恢复的临时失败           | retry              | 显式授权有限重试，退避时可以取消               |
| 等待就绪或放弃一个结果     | wait               | 延迟、独立等待取消、串行轮询                   |
| 多个步骤共享依赖           | grfn               | 编译可复用的依赖图，明确选择输出与失败收尾方式 |

例如 Cache 已使用 singleflight 管理在途任务，同时自己保留容量限制、统计和写入屏障。其他领域也通过原生 Promise、Iterable / AsyncIterable 和 AbortSignal 组合，不需要 Pluxel 专用适配层。

## 从小组合开始

单一需求直接选择一个子路径；复杂场景再组合。比如 `limit + waitFor` 让调用者停止等待而真实 IO 继续持有额度，`singleflight + Pacer RateLimiter` 合并重复读取后再检查时间额度。

本包的并发限制不等于时间限速，在途合并也不等于防抖。需要防抖、节流、优先级队列或响应式状态时，可结合 [TanStack Pacer](https://github.com/TanStack/pacer)，不必在两边重复配置同一种调度策略。

## 安装与详细用法

```sh
npm install @pluxel/async
```

Node.js 24+、ESM；按子路径导入，例如 `@pluxel/async/singleflight`。

- [快速开始与工具选择](https://github.com/PluxelJS/pluxel/blob/main/packages/async/README.md)
- [完整 API 与取消、失败、收尾契约](https://github.com/PluxelJS/pluxel/blob/main/packages/async/docs/guide.md)
- [实用组合与第三方协作](https://github.com/PluxelJS/pluxel/blob/main/packages/async/docs/recipes.md)
- [可运行示例、预期输出与运行方法](https://github.com/PluxelJS/pluxel/blob/main/packages/async/examples/README.md)

本页概述用途；参数、默认值和组合细节由包内文档统一维护，并随 npm 制品发布。
