---
title: Async 任务图与有界迭代
description: 在不依赖 Pluxel runtime 的代码中复用异步依赖，并限制惰性迭代的并发与背压。
---

`@pluxel/async` 提供两个彼此独立、零运行时依赖的 ESM 子路径。它适合普通 TypeScript 服务、脚本和 Plugin 内部逻辑，不需要创建 Plugin 或接入 Host。

如果固定几步 `await` 已经足够清楚，继续使用普通 async function。只有多个输出需要共享异步依赖时使用 `grfn`；只有数据源需要惰性读取、限制未交付工作量并正确关闭上游时使用 `iter`。

```sh
pnpm add @pluxel/async
```

包没有根入口，请从 `@pluxel/async/grfn` 或 `@pluxel/async/iter` 导入。

## 复用任务依赖

```ts
import { grfn } from '@pluxel/async/grfn'

const graph = grfn<{ amount: number; rate: number }>()
const net = graph.task({ input: graph.input }, ({ input }) => input.amount)
const tax = graph.task({ input: graph.input, net }, ({ input, net }) => net * input.rate)
const calculate = graph.compile({ net, tax })

await calculate({ amount: 100, rate: 0.1 })
// { net: 100, tax: 10 }
```

`task()` 返回图内引用，不返回 Promise。`compile()` 只编译所选输出及其祖先；同一次调用中的共享节点只执行一次，不同调用之间不缓存结果。

失败策略默认为 `early`，会尽早把原错误返回给调用方，但不会取消其他已启动分支。需要等已启动分支全部 settled 后再返回错误时，使用 `{ failure: 'drain' }`。取消仍由业务输入中的 `AbortSignal` 和具体异步操作协作完成。

## 限制异步迭代窗口

```ts
import { mapConcurrent, SKIP, take, toArray } from '@pluxel/async/iter'

const values = mapConcurrent(
	[1, 2, 3, 4],
	async (value, { signal }) => {
		signal.throwIfAborted()
		return value % 2 === 0 ? SKIP : value * 2
	},
	{ concurrency: 2 },
)

await toArray(take(values, 2))
// [2, 6]
```

`concurrency` 是必填的有限正整数。它限制“正在读取或已接纳但尚未交付”的完整窗口，不只是当前仍在执行的 mapper 数量；因此下游暂停消费时不会形成无界结果队列。

默认 `order: 'input'` 保持输入顺序，慢首项可能阻塞后续交付；`order: 'completion'` 按完成顺序交付。两种模式都不保证副作用执行顺序。提前退出、失败或外部取消会停止接纳新项、通知 mapper、等待已启动工作和源读取，再关闭支持 `return()` 的上游。

`take()`、`batch()` 和 `toArray()` 都消费标准 `Iterable` / `AsyncIterable`。`toArray()` 会按输出规模占用内存；无限或大型数据流应保持流式消费。

## 组合边界

对每个元素有多个互相依赖的异步操作时，可以先编译一个 `drain` 图，再在 `mapConcurrent()` mapper 中执行它。元素并发不等于外部服务请求并发：一个元素发起多个请求时，服务配额仍应由客户端或连接池单独限制。

`mapConcurrent()` 会预先接纳窗口内的工作，因此 `take(n)` 不保证只启动 n 次副作用。真正需要限流的操作必须在 mapper 内启动，不要把已经创建的 Promise 数组作为输入。
