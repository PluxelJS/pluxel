# @pluxel/async

独立的 TypeScript / JavaScript 异步工具包：有界并发、任务合并、有限重试、流式处理和依赖图。零运行时依赖，直接使用 Promise、Iterable / AsyncIterable 和 AbortSignal，不需要 Pluxel Plugin、Context 或 Host。

## 安装与运行环境

```sh
npm install @pluxel/async
```

包声明 Node.js 24+，仅提供 ESM，内置类型声明。运行实现不导入 Node 内置模块，构建目标为 ES2022；浏览器或其他运行时仍需自行验证 Abort API 等能力，当前不承诺已测试的兼容矩阵。

没有根入口，直接导入所需子路径。

## 从一个工具开始

处理一批输入并限制在途数量：

```ts
import { mapConcurrent, toArray } from '@pluxel/async/iter'

const urls = ['https://example.com/a', 'https://example.com/b']
try {
	const pages = await toArray(
		mapConcurrent(
			urls,
			async (url, { signal }) => {
				const response = await fetch(url, { signal })
				if (!response.ok) throw new Error(`HTTP ${response.status}`)
				return response.text()
			},
			{ concurrency: 4, signal: AbortSignal.timeout(5000) },
		),
	)
	console.log(pages)
} catch (error) {
	console.error('Reading pages failed', error)
}
```

默认按输入顺序交付，限制已接纳但尚未交付的窗口；`toArray` 会收集全部结果，大输入应使用 `for await` 或 `forEach` 逐项消费。超时协作取消底层读取，不会强制终止不响应 signal 的操作。

## 如何选择

| 你的需求                      | 子路径          | 关键区别                                                     |
| ----------------------------- | --------------- | ------------------------------------------------------------ |
| 从一份输入流有界地启动任务    | `/iter`         | 惰性拉取和背压；支持过滤、分批、查找及聚合                   |
| 多处调用共享同一并发额度      | `/limit`        | 每个任务都执行；keyedLimit 按 key 独立限并发，不限制全局总量 |
| 同 key 的并发调用共享一次工作 | `/singleflight` | 首个任务执行；完成后不保留结果                               |
| 明确允许某类失败再尝试        | `/retry`        | 必填 attempts 与 shouldRetry，退避等待也能取消               |
| 延迟、放弃等待或检查就绪条件  | `/wait`         | sleep / waitFor / until，不接管底层资源                      |
| 多个步骤共享依赖、选择输出    | `/grfn`         | 编译一次复用；同次运行只执行一次共享依赖                     |

例如 `import { singleflight } from '@pluxel/async/singleflight'`。普通几步 `await` 或 `Promise.all` 已足够时直接使用它们；防抖、节流、时间窗口限速和持久调度不在本包范围。

需要防抖、节流、时间窗口限速、带优先级／过期／启停的队列，或响应式状态与框架 hooks 时，可使用 [TanStack Pacer](https://github.com/TanStack/pacer)。它也有 Vanilla API。双方在并发控制、重试和批处理上有交集，具体选择见[与 Pacer 的边界](https://github.com/PluxelJS/pluxel/blob/main/packages/async/docs/guide.md#与-tanstack-pacer-的边界)；本包不追求补齐完整调度器功能。

## 组合与资源所有权

- `retry(() => limiter.run(task), options)` 每次尝试取额度，退避期间释放；反过来组合则整个重试过程占用额度。
- singleflight 的同 key 必须表示可共享的结果，signal 只取消当前订阅者等待；底层取消权由任务创建者持有。
- limit 和 singleflight 的 `close()` 停止接纳、等待任务完成，不强行中止 IO。按依赖顺序收尾：先排空仍会创建请求的共享任务，再关闭 limiter。
- mapConcurrent 早退会协作取消并排空工作；异步生成器的 return 仍需等待 pending next，要中断等待须传入并取消外部 signal。

完整签名、默认值、失败与生命周期语义只维护在 [使用指南](https://github.com/PluxelJS/pluxel/blob/main/packages/async/docs/guide.md)，也随包安装于 `docs/guide.md`。

## 示例

[示例索引与运行说明](https://github.com/PluxelJS/pluxel/blob/main/packages/async/examples/README.md) 提供三个不依赖网络或框架的场景：

- `process-records.ts`：复用依赖图，流式处理，批量写入。
- `shared-requests.ts`：在途请求合并、有限重试、共享并发额度。
- `cancel-subscriber.ts`：取消一个等待者，另一个继续取得共享结果。

示例和本地运行入口随包发布；复制到自己的项目后可直接替换 IO adapter。

## 维护与性能

在仓库的 `packages/async` 目录：

```sh
pnpm examples      # 构建后运行全部本地示例
pnpm test          # 源码行为与公开类型
pnpm typecheck     # 包括示例与基准
pnpm build         # ESM、类型声明及无源码消费检查
pnpm bench         # 与锁定版本的同类库比较
```

工具链使用 tsdown、Vitest，以及仓库统一的 oxlint / oxfmt。维护规则见 [AGENTS.md](https://github.com/PluxelJS/pluxel/blob/main/packages/async/AGENTS.md)。

设计参考 grfn 的依赖组合与 lfi 的惰性迭代思路，有独立的引用、背压和收尾契约，不承诺 API 兼容或全面更快。[基准报告](https://github.com/PluxelJS/pluxel/blob/main/packages/async/bench/README.md) 包含对照条件、测量数据与局限。
