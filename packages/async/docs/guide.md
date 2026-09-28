# Async 使用指南

安装与选型见 [README](../README.md)，完整可运行组合见 [examples](../examples/README.md)。本页拥有 API 默认值、失败与生命周期契约。

`@pluxel/async` 是独立的通用异步工具包，不依赖 Pluxel runtime。公开契约使用原生 Promise、Iterable / AsyncIterable 和 AbortSignal，没有全局调度器或私有任务协议。

```sh
pnpm add @pluxel/async
```

包没有根入口，按用途选择：

| 子路径          | 导出                                                                                              | 使用时机                         |
| --------------- | ------------------------------------------------------------------------------------------------- | -------------------------------- |
| `/grfn`         | `grfn`                                                                                            | 多个步骤需要共享依赖、选择输出   |
| `/iter`         | `mapConcurrent`, `SKIP`, `take`, `batch`, `toArray`, `forEach`, `find`, `some`, `every`, `reduce` | 惰性处理数据，限制未交付窗口     |
| `/limit`        | `limit`, `keyedLimit`, `LimiterClosedError`                                                       | 多个调用者共享并发额度           |
| `/retry`        | `retry`                                                                                           | 操作失败后，明确授权有限次数重试 |
| `/singleflight` | `singleflight`, `SingleflightClosedError`                                                         | 同 key 的重复调用共享在途工作    |
| `/wait`         | `sleep`, `waitFor`, `until`                                                                       | 延迟、放弃等待或轮询条件         |

固定几步 `await` 已足够时直接使用普通 async function。防抖、节流、时间窗口限速、响应式状态和持久任务调度不在本包范围。

## 与 TanStack Pacer 的边界

两者有功能交集，不应描述成互不重复。我们提供可直接 await 的小型异步组合原语；需要时间调度、可管理队列或响应式状态时，优先评估 [TanStack Pacer](https://github.com/TanStack/pacer)。Pacer 也有 Vanilla API，不要求使用 React。

| 需求                       | 本包的边界                                                               | Pacer 的对应能力                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 限制同时执行的任务         | limit 提供 FIFO 额度与每次调用的结果 Promise；不限制单位时间内的启动次数 | [AsyncQueuer](https://tanstack.com/pacer/latest/docs/framework/vanilla/guides/async-queuing) 也控制并发，并提供容量、优先级、过期与启停管理   |
| 重试                       | retry 是独立函数，必须指定总尝试次数和失败判定                           | [Async Retrying](https://tanstack.com/pacer/latest/docs/framework/vanilla/guides/async-retrying) 提供重试工具，也与异步队列等工具集成         |
| 批量处理                   | iter.batch 按数量分组拉取的数据，源结束时交付余量；不按时间自动 flush    | [Async Batching](https://tanstack.com/pacer/latest/docs/framework/vanilla/guides/async-batching) 面向收集调用后批量执行，可结合时间和数量触发 |
| 防抖、节流、时间窗口限速   | 不提供；singleflight 合并在途结果，不是防抖，limit 限并发也不是限速      | Pacer 提供对应的同步／异步工具，见[官方功能说明](https://github.com/TanStack/pacer#readme)                                                    |
| 响应式调度状态、框架 hooks | 不提供 UI 状态层                                                         | Pacer 提供状态管理与框架适配，见[官方功能说明](https://github.com/TanStack/pacer#readme)                                                      |

这些是职责选择，不是性能排名。Pacer 的队列接纳、结果通知和启停契约与本包不同，不能只替换函数名；尤其不能把暂停调度当作 close 排空。我们不为覆盖上述功能增加另一套调度系统，也不把 Pacer 的本地队列描述成分布式、崩溃恢复的持久任务服务。

组合两者时，为同一种并发或重试策略保留一个明确所有者，避免重复排队或嵌套重试放大请求次数。选用完整调度器时，不必再套同职责的 limit/retry。

## 复用任务依赖

```ts
import { grfn } from '@pluxel/async/grfn'

const graph = grfn<{ amount: number; rate: number }>()
const net = graph.task({ input: graph.input }, ({ input }) => input.amount)
const tax = graph.task({ input: graph.input, net }, ({ input, net }) => net * input.rate)
const calculate = graph.compile({ net, tax })
await calculate({ amount: 100, rate: 0.1 }) // { net: 100, tax: 10 }
```

`task(dependencies, callback)` 返回不可变的图内 `Ref<T>`，不是 Promise。依赖必须来自同一图的已有引用，不支持字符串 ID 或前向引用。声明与编译不执行回调；`compile(ref | namedOutputs, options?)` 只编译选定输出及其祖先，同一次调用共享节点只执行一次，不同调用不共享结果。命名输出保留属性类型，`then` 是保留的输出键。

编译与单次运行的结构开销均为 O(V + E + K)，V、E、K 分别是可达节点、边和输出数；不包含业务函数成本。编译计划不保留不相关节点，构建/编译应在工厂内只做一次。

失败策略默认 `early`：尽早返回原错误，其他分支可能继续。`{ failure: 'drain' }` 等所有已启动任务 settled 后再返回错误。图不取消、不重试、不回滚；协作取消由输入里的 AbortSignal 与业务操作负责。同步结果、thenable 和同步抛错均进入 Promise 语义。

## 有界迭代与消费

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
await toArray(take(values, 2)) // [2, 6]
```

`concurrency` 必须是正安全整数，限制“进行中的源读取 + 已接纳但未交付工作项”的总窗口。mapper 完成不释放槽位；结果交付或 SKIP 被消费才释放。源的 `next()` 串行调用，因此下游暂停时不会形成无界结果队列。mapper 得到解析后的值及 `{ index, signal }`；index 是输入位置。

`order` 默认为 `input`，也可选择 `completion`；它只控制交付顺序，不保证副作用顺序。外部 `signal`、失败或提前结束会停止接纳、通知 mapper 取消，等待已启动工作及源读取，再关闭支持 `return()` 的上游。不响应取消的任务仍可能拖住收尾。主错误不会被上游关闭错误替换；没有主错误时关闭错误正常传播。

手动消费迭代器时，原生 async generator 的 `return()` 会排在尚未完成的 `next()` 之后，不能单靠它通知正在等待的 mapper 取消。需要停止一个待完成的读取时，先取消传给 `mapConcurrent` 的外部 signal，再处理该次 `next()` 的拒绝并等待关闭。普通 `for await` 的 `break` 发生在一次读取完成后，会正常进入取消与排空流程。

| 函数                               | 契约                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `take(source, count)`              | 最多消费 count 项；0 不打开源；提前结束关闭上游                           |
| `batch(source, size)`              | 按数量连续分组，包含最后不足一批的结果，不复用数组                        |
| `toArray(source)`                  | 收集所有输出，内存随输出数量增长                                          |
| `forEach(source, visit)`           | 按交付顺序等待每次 visit，不收集结果                                      |
| `find(source, predicate)`          | 第一项匹配值，无匹配为 undefined；匹配值本身为 undefined 时相同           |
| `some(source, predicate)`          | 第一项匹配即 true；空源为 false，可正确处理 undefined 匹配                |
| `every(source, predicate)`         | 第一项不匹配即 false；空源为 true                                         |
| `reduce(source, reducer, initial)` | 显式初值，先 await 初值再打开源；按交付顺序串行聚合，空源返回解析后的初值 |

消费回调得到 `(value, index)`，reduce 回调为 `(accumulator, value, index)`。这里的 index 是当前输入的交付位置；过滤或重排后与原 mapper 的输入 index 不同。回调可以异步，但消费端不另建并发池。短路消费也会等待上游关闭和在途任务排空。

一个元素内的多个依赖步骤可以执行 `drain` 图。元素并发不等于服务请求并发；跨元素请求额度用 `/limit`。`take(n)` 不保证只启动 n 次副作用，真正需要控制的操作应在 mapper 内启动，不要预先创建大量 Promise。

## 共享并发额度

```ts
import { limit, keyedLimit } from '@pluxel/async/limit'

const requests = limit({ concurrency: 4 })
const writes = keyedLimit<string>({ concurrency: 1 })
try {
	await requests.run(({ signal }) => fetch('https://example.com', { signal }))
	await writes.run('settings', async () => {
		/* 写入 settings */
	})
} finally {
	await Promise.all([requests.close(), writes.close()])
}
```

`run(task, { signal }?)` 接纳惰性函数，空闲额度立即保留，回调在微任务中启动。`activeCount`、`pendingCount` 是 limiter 的只读实时计数；active 包含已取得额度、尚未进入回调的任务。`concurrency` 为正安全整数，排队按 FIFO。

取消在启动前拒绝当前任务；启动后把同一 signal 交给回调，等待其真实结果后才释放额度。已经完成的结果或实际错误不会因为同时取消而被改写。排队数量不设上限，大型/无限数据源请使用 `/iter` 提供背压。

`keyedLimit<K>()` 的 `run(key, task, options?)` 按 Map 的 key 相等规则隔离 FIFO 与额度，空闲 key 自动释放，没有全局并发上限。相同 key 的每次调用都会执行，适合资源写入串行化；去重用 singleflight。

`close()` 幂等，返回同一个 Promise：立即拒绝新调用，等待全部已接纳工作（含排队工作）settled，不自动取消，也不汇总任务错误。每个 run 的 Promise 仍由调用者处理，关闭后的 run 拒绝为 `LimiterClosedError`。任务内部等待同一个已饱和 limiter 的任务，或等待拥有自己的 limiter.close()，会造成自等待。

## 有限重试

```ts
import { retry } from '@pluxel/async/retry'

await retry(
	async ({ attempt, signal }) => {
		const response = await fetch(`https://example.com/data?attempt=${attempt}`, { signal })
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		return response.text()
	},
	{
		attempts: 3,
		shouldRetry: (error) => error instanceof TypeError,
		delayMs: 100,
		jitter: true,
	},
)
```

`attempts` 必填，是包含首次调用的总次数，必须是正安全整数；回调与 `shouldRetry(error, context)` 得到从 1 开始的 attempt 和 signal。shouldRetry 必填，只有它返回 true 才重试；用业务协议与原生错误判断，库不会推测 HTTP 状态或操作幂等性。

退避默认 `delayMs: 100`、`factor: 2`、`maxDelayMs: 30000`、`jitter: false`。factor 有限且至少为 1，maxDelayMs 不小于 delayMs。时间参数为 0..2147483647 的整数毫秒；内部乘法退避在上限处截断，实际延迟取整。`jitter: true` 在 0 到当前延迟间均匀抽取整数。0 延迟也经过定时器，让出事件循环。

任务与判定串行执行，耗尽或拒绝重试时抛出本次任务的原始失败；判定函数自身失败则传播判定错误。signal 取消可打断退避并阻止新尝试；正在执行的任务/判定会被等待。已执行任务成功仍成功，任务失败或判定返回时已取消则不再重试，保留任务错误（判定本身抛错仍传播）。总期限通过 `AbortSignal.timeout()` 传入；不响应 signal 的任务不会被强制终止。

把 `limit.run()` 放在 retry 回调内，每次尝试单独取得额度，退避时释放；将整个 retry 放进 limit.run() 则全程占额度。选择对应实际资源成本的组合。

## 在途调用合并

```ts
import { singleflight } from '@pluxel/async/singleflight'

const loads = singleflight<string, string>()
async function load(id: string) {
	const response = await fetch(`https://example.com/items/${encodeURIComponent(id)}`)
	if (!response.ok) throw new Error(`HTTP ${response.status}`)
	return response.text()
}
try {
	const first = loads.run('a', () => load('a'))
	const second = loads.run('a', () => load('a'))
	console.log(loads.size, loads.get('a') === first) // 1, true；观察不会启动工作
	console.log(await Promise.all([first, second])) // 共享同一次操作
	await loads.drain()
} finally {
	await loads.close()
}
```

`singleflight<Key, Value>()` 固定实例的 key 与结果类型；每次 `run(key, task, options?)` 提供惰性任务。同 key 在途期间由首个任务负责执行，后续任务回调不会调用，但仍校验它是函数。调用方必须让同 key 表达可共享的同一种结果；不同结果域使用不同实例。key 使用 Map 相等规则；任务在微任务启动，成功或失败后移除记录，下一次重新执行，没有 TTL 或结果缓存。

`get(key)` 返回当前共享 Promise 或 undefined，只观察、不启动工作，也不会加入一个可取消等待者。`size` 是当前在途 key 数，包含已接纳但尚未执行的任务。关闭过程中仍可观察尚未完成的工作。

`run(key, task, { signal })` 的 signal 只控制当前调用者等待，不传给共享任务；已取消的调用不会启动新工作。即使全部等待者离开，共享工作也会继续，它的晚到拒绝仍被观察。任务创建者通过闭包拥有底层取消权限，不能让第一个等待者的取消信号意外成为共享任务所有者。

`drain()` 等待调用时已接纳任务的快照，之后加入的新工作不在等待范围内，也不停止接纳。它观察任务失败并正常完成；具体结果与原始错误通过 run/get 获取。

`close()` 幂等，先拒绝新 run，再等待当前任务排空；任务错误同样不使 close 拒绝。关闭后 run 拒绝为 `SingleflightClosedError`。任务内递归等待自己同 key 的工作，或等待本实例的 drain/close，会造成自等待；库不做依赖环检测。drain/close 都不会强制取消任务，不结束的任务会一直阻塞等待。

## 可取消等待

```ts
import { sleep, until, waitFor } from '@pluxel/async/wait'

await sleep(20, { signal: AbortSignal.timeout(1000) })
// 以下轮询示例运行于浏览器页面：
await until(() => document.readyState === 'complete', {
	intervalMs: 50,
	signal: AbortSignal.timeout(5000),
})
// 对一个已存在的 Promise 放弃等待，不宣称停止底层操作：
await waitFor(Promise.resolve('ready'), { signal: AbortSignal.timeout(1000) })
```

`sleep(ms, { signal }?)` 结束或取消时清理 timer 和监听器。`waitFor(promise, { signal }?)` 只取消等待，源 Promise 的晚到错误仍被观察；传入已取消的 signal 时，即使源已成功也拒绝。

`until(check, { intervalMs, signal })` 的 options 和 intervalMs **必填**；立即检查，返回 false 后延迟再检查，true 完成，抛错失败，检查不重叠。check 得到 `{ signal }`。取消打断间隔并阻止新检查；正在执行的检查会被等待：true 仍成功，错误保持原样，false 则报告取消。轮询正常未就绪不必伪造为 retry 的异常。

sleep 的 ms 与 until 的 intervalMs 均为 0..2147483647 的整数毫秒，非法值直接拒绝，不依赖宿主定时器的隐式截断。取消使用原始 `signal.reason`，不包裹成另一类错误。
