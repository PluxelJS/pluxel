# @pluxel/async

两个独立、零运行时依赖的 ESM async 工具。这个包不依赖 Pluxel runtime；需要任务依赖图或有界并发迭代时可以单独安装。没有根入口，调用方只引入实际使用的子路径。

```sh
pnpm add @pluxel/async
```

| 导入路径             | 负责什么                                       |
| -------------------- | ---------------------------------------------- |
| `@pluxel/async/grfn` | 编译任务依赖图，按输出执行，单次调用共享依赖   |
| `@pluxel/async/iter` | 对元素做有界并发处理，按需消费，管理背压与收尾 |

## grfn：输入 → 任务 → 输出

```ts
import { grfn } from '@pluxel/async/grfn'

const g = grfn<{ amount: number; rate: number }>()
const net = g.task({ input: g.input }, ({ input }) => input.amount)
const tax = g.task({ input: g.input, net }, ({ input, net }) => net * input.rate)
const total = g.task({ net, tax }, ({ net, tax }) => net + tax)
const calculate = g.compile({ net, tax, total })

await calculate({ amount: 100, rate: 0.1 })
// { net: 100, tax: 10, total: 110 }
```

示例用简单运算说明 API；实际应在具有异步协作或输出复用价值的边界使用，不必把每个算术表达式拆成节点。

`g.input` 是本次输入引用；`g.task(dependencies, fn)` 返回 `Ref<Awaited<R>>`；`g.compile(ref | namedOutputs, options?)` 返回普通异步函数。命名依赖直接推导回调参数，依赖只能引用本图已有任务，不提供字符串 ID 或前向引用。

声明与编译不执行回调。编译只遍历选定输出及祖先，非递归生成拓扑计划；运行只接好 Promise slot。共享节点在一次运行里只执行一次，不同调用不共享缓存。同步返回、Promise、thenable 和同步抛错统一进入 Promise 语义。

默认失败策略 `early`：尽早返回错误，其他分支可能继续。`g.compile(output, { failure: 'drain' })` 则等已启动任务 settled 后再抛原错误；它不取消、不重试、不回滚。需要取消时，在普通输入里传递 `AbortSignal`，由业务操作配合处理。

只保存选定的编译计划。设可达节点、边、输出数分别为 V、E、K，编译与运行的结构处理均为 O(V + E + K)，不包含业务函数成本。不要改成逐次递归遍历、全图层级屏障或跨调用隐式缓存。

## iter：一个元素的依赖写在普通 async mapper 内

```ts
import { mapConcurrent, SKIP, batch, take, toArray } from '@pluxel/async/iter'

const values = mapConcurrent(
	[1, 2, 3, 4, 5],
	async (value, { index, signal }) => {
		signal.throwIfAborted()
		return value % 2 === 0 ? SKIP : { index, value: value * 2 }
	},
	{ concurrency: 4 },
)

await toArray(batch(take(values, 2), 2))
// [[{ index: 0, value: 2 }, { index: 2, value: 6 }]]
```

| API                                      | 参数与结果                                                   |
| ---------------------------------------- | ------------------------------------------------------------ |
| `mapConcurrent(source, mapper, options)` | `Iterable` / `AsyncIterable` → 惰性的 `AsyncIterable`        |
| `SKIP`                                   | 跳过一项输出；不吞掉合法的 `undefined`、`null`、`false`、`0` |
| `take(source, count)`                    | 最多消费 count 项，随后关闭上游；0 不打开源                  |
| `batch(source, size)`                    | 按顺序分批，保留最后不足一批的数据                           |
| `toArray(source)`                        | 显式收集全部输出；会占用与输出规模成正比的内存               |

Mapper 得到解析后的输入及 `{ index, signal }`。`index` 是输入下标；`signal` 在外部取消、失败、提前结束时通知已启动任务。

`options.concurrency` 必填且为有限正整数。它限制“进行中的源读取 + 未交付工作项”的总窗口，而非仅运行中的 mapper 数量。结果交付或 SKIP 被消费才释放槽位；已交给下游的批次不在窗口内。

`options.order` 默认 `input`，可选 `completion`。前者保序，慢首项可能阻塞后续交付；后者先完成先交付。两者都不保证副作用执行顺序。`options.signal` 是可选的外部取消信号。

提前退出或失败会停止接纳、通知取消、等待已启动任务及源读取，再关闭需要关闭的上游。不会响应取消的 Promise 仍可能拖住收尾；`take(n)` 也不保证只启动 n 项副作用。不要把预先启动的 Promise 大数组作为限流队列：真正需要限流的操作应在 mapper 内启动。

## 组合与使用边界

完整示例在 `examples/process-records.ts`：每个元素执行一个 `drain` 图，外层限制元素窗口，下游批量串行写入。图构建/编译放在工厂里，只做一次。

元素并发不等于服务请求并发：每项有两个请求，四个并发元素可能产生八个请求。服务配额交给客户端/连接池。图共享同一个迭代器对象不等于广播；多个消费者会争读单次源，需要时显式物化或创建独立源。

已有固定几步 `await` 就能清晰表达的逻辑不必改成图；集合计算应继续留在数据库或相应计算引擎。CPU 密集计算也不会因为这些 Promise 获得线程并行。

## 工程约定

```sh
pnpm install
pnpm test           # Vitest 5：公开子路径直接读取 TS + 类型检查，不需要 dist
pnpm build          # tsdown 构建；postbuild 检查无源码的发布映射消费
pnpm test:installed # 已有 dist 时单独重跑发布产物消费检查
pnpm bench          # 可选，只测编排开销，不作为功能验收门槛
pnpm pack          # prepack 构建；pnpm 应用 publishConfig.exports
```

使用仓库约定的 Node 24 开发环境。库使用标准 Promise、迭代器和 Abort API，没有 Node 内置模块运行时依赖。

`entry` 是导出入口的唯一配置来源；`exports: { devExports: '@pluxel/source' }` 交给 tsdown 生成仓库源码映射。发布映射只指向 `dist`，改入口后应重新构建并提交生成结果。不要手写导出生成器或 alias。

这个包不需要 Plugin semantic lowering，因此测试直接使用 Vitest，并只增加仓库的 `@pluxel/source` condition。默认只输出 ESM，不为没有明确需求的 CommonJS 再维护一套构建、声明和测试矩阵。源码行为、类型契约、产物消费各有一个职责，不维护平行测试基础设施。

开发约束见 `AGENTS.md`。

仓库用户文档见 [`docs/reference/async.md`](../../docs/reference/async.md)。
