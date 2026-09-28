# 实用组合

先从一个工具开始。需要组合时，明确每一层负责什么、Promise 何时完成、谁可以取消底层操作。API 参数见 [guide](./guide.md)，可运行入口见 [examples](../examples/README.md)。

## 调用者不等了，真实 IO 仍占额度

适合无法取消的 SDK 调用、必须完成的写入等场景：

```ts
const work = requests.run(() => sdkOperation())
const result = await waitFor(work, { signal: subscriberSignal })
```

这里 requests 是 `limit({ concurrency })` 创建的资源所有者，waitFor 来自 `/wait`；最短完整演示见 [cancel-wait.ts](../examples/cancel-wait.ts)，包含创建、失败处理和 close。

不要把 waitFor 放进 requests.run 的回调：那样 limiter 看到的只是“等待结束”，会在实际 IO 仍执行时释放额度。同理，不能让回调只返回队列接纳回执、后台启动回执或提前完成的包装 Promise。

若排队阶段也应取消，将 signal 传给 run 的 options；任务开始后是否终止仍由 IO 自身决定。信号不代表撤销已发生的写入，重试必须遵守业务幂等性。

## 合并读取后再检查时间额度

[可选 Pacer 示例](../examples/pacer-shared-reads.ts) 组合两个职责：

```text
read(id) → singleflight 按 id 合并 → Pacer 同步时间额度检查 → 实际 IO
```

使用 Pacer 的同步 `RateLimiter` 作为接纳检查，读取与每个 key 的结果 Promise 仍由 singleflight 管理。`maybeExecute()` 原子地执行接纳检查并记录额度，不能以“查询剩余额度，再启动”的分离步骤替代。其 boolean 表示接纳，不是读取结果。参见 [Pacer Rate Limiting](https://tanstack.com/pacer/latest/docs/framework/vanilla/guides/rate-limiting)。

示例显式返回 `{ kind: 'value', value }` 或 `{ kind: 'rate-limited' }`，合法的 undefined 值不会与限速拒绝混淆；真实读取失败仍以原错误 reject。这是示例业务的结果模型，不是库新增的通用 envelope。

- 实例应绑定同一数据源与权限域；若跨租户共享实例，key 必须包含影响结果的租户等输入，不能只使用裸资源 ID。
- 同 key 的在途加入者不额外消耗额度，不同 key 各自检查。
- 计费单位是一次实际读取的接纳，失败也已经消费额度；不自动排队或重试。
- 订阅者 signal 只取消等待；read 闭包可以持有应用级 signal，不能捕获第一个订阅者的 signal 当作共享 IO 的取消权。
- close 先停止 singleflight 接纳并等待真实读取完成，再 reset 时间额度对象以清除计时器。reset 只用于实例寿命结束，不在每次读取后重置配额。
- 这是进程内客户端策略，不是服务端鉴权、分布式配额或持久任务服务。

Pacer 只作为示例与测试的开发依赖；安装 async 不会带入 Pacer。不增加 `pacerAdapter`，也不复制 Pacer 的窗口算法。

## 防抖和任务合并各自放在哪里

通常每个输入控件拥有自己的 debouncer，实际执行查询时才调用共享的 singleflight：

```text
控件 A 的防抖 ─┐
               ├→ 共享的 read(queryKey) → singleflight → IO
控件 B 的防抖 ─┘
```

不要把一个全局 debouncer 塞进不同 key 的 singleflight 任务：后来的参数可能替换前面的参数，而前者 Promise 返回旧结果或 undefined，破坏“结果属于这个 key”的假设。[Pacer 异步防抖的结果契约](https://tanstack.com/pacer/latest/docs/framework/vanilla/guides/async-debouncing) 明确区分被替换调用与实际执行调用。

即使同一个输入控件，也需要由 UI 自己决定旧查询结果能否发布；任务去重不保证“最新输入获胜”。

## 重试和并发额度

`retry(() => requests.run(task), options)` 每次尝试取得额度，退避时不占用；`requests.run(() => retry(task, options))` 则让整个重试流程占用额度。选取实际需要限制的资源，不是按函数名机械嵌套。

[shared-requests.ts](../examples/shared-requests.ts) 在共享读取内部重试，每次尝试再取得额度。所有等待者共享一个重试过程；每个输入位置仍交付一次结果。save 失败后仍排空已接纳的共享工作，因此关闭时可能等待其他读取完成重试；这是显式的收尾选择。

第三方 SDK 或 Pacer 已负责重试时通常不再套 retry，否则尝试次数会相乘。按真实操作制定 shouldRetry，不能因为错误看起来像网络失败就重放不具备幂等性的写入。

## 流式输入与处理图

mapConcurrent 直接接收 Iterable / AsyncIterable。支持该协议的 Node Readable、SDK 分页器可以直接传入，无需专用适配器。消费结束与错误会触发上游 return；如果 SDK 的 pending next 无法取消，仍需要它支持并使用外部 signal。

[process-records.ts](../examples/process-records.ts) 将一条记录的关联读取放在同一个 mapper 内，通过 grfn 共享依赖；外部窗口限制同时接纳的记录数。图使用 failure: drain，避免 mapper 已失败但它的子任务还在消耗资源。

单纯独立的几个请求用 Promise.all 即可。按数量 batch 不提供时间 flush，也不会回滚此前已保存的批次。使用 toArray 会最终收集全部数据，大输入应逐项或逐批消费。

## 组合前的四个检查

1. 返回的是实际结果、接纳回执，还是可被替换的旧结果？
2. 控制的是输入窗口、执行并发、时间额度，还是重复任务？
3. signal 属于一个等待者、一次操作，还是整个资源所有者？
4. 关闭先阻止谁创建新工作，再等待谁完成？

若回答这些问题需要额外维护第二份任务表或制造另一套任务协议，先重新选择组合边界，而不是继续加 wrapper。
