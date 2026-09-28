# @pluxel/async

轻量异步组合工具：任务依赖图、有界迭代、共享并发额度、显式重试、在途调用合并与可取消等待。零运行时依赖，使用原生 Promise、Iterable / AsyncIterable 和 AbortSignal；不需要 Pluxel Plugin 或 Host。

```sh
pnpm add @pluxel/async
```

没有根入口，按任务导入独立子路径：

| 子路径                       | 用途                                             |
| ---------------------------- | ------------------------------------------------ |
| `@pluxel/async/grfn`         | 编译任务依赖图，同一次执行共享依赖，显式选择输出 |
| `@pluxel/async/iter`         | 有界并发映射、过滤、分批、查找和聚合             |
| `@pluxel/async/limit`        | 跨调用共享并发额度，或按 key 独立串行/限并发     |
| `@pluxel/async/retry`        | 经调用方授权的有限重试、退避与 jitter            |
| `@pluxel/async/singleflight` | 同 key 共享在途操作，完成后不缓存                |
| `@pluxel/async/wait`         | 可取消延迟、独立等待和条件轮询                   |

```ts
import { limit } from '@pluxel/async/limit'
import { retry } from '@pluxel/async/retry'

const requests = limit({ concurrency: 4 })
const controller = new AbortController()
try {
	const text = await retry(
		({ signal }) =>
			requests.run(
				async () => {
					const response = await fetch('https://example.com/data', { signal })
					if (!response.ok) throw new Error(`HTTP ${response.status}`)
					return response.text()
				},
				{ signal },
			),
		{
			attempts: 3,
			// 示例只重试网络类 TypeError；业务应根据操作与原生错误制定策略。
			shouldRetry: (error) => error instanceof TypeError,
			signal: controller.signal,
		},
	)
	console.log(text)
} catch (error) {
	console.error('Request failed', error)
} finally {
	await requests.close()
}
```

每次尝试单独取得并发额度，退避期间不占额度。关闭 limiter 会拒绝新任务并等待已接纳任务（含排队任务），不会强行中止 IO。

完整 API、默认值、取消/失败/收尾边界及示例由 [Async 使用指南](https://github.com/PluxelJS/pluxel/blob/main/docs/reference/async.md) 维护；公开类型和 JSDoc 位于实现旁。完整组合示例见 [process-records.ts](https://github.com/PluxelJS/pluxel/blob/main/packages/async/examples/process-records.ts) 和 [shared-requests.ts](https://github.com/PluxelJS/pluxel/blob/main/packages/async/examples/shared-requests.ts)。

## 开发

```sh
pnpm test           # Vitest：源码行为 + 公开类型，不需要 dist
pnpm typecheck
pnpm build          # tsdown：ESM + declarations + 发布映射，随后消费无源码制品
pnpm bench          # 构建后对比精确版本同类库；不作为功能验收门槛
pnpm pack          # prepack 构建，再由 pnpm 应用 publishConfig.exports
```

仓库统一使用 oxlint / oxfmt；包不维护第二套 lint 或格式配置。tsdown 的 `entry` 拥有导出清单，`exports: { devExports: '@pluxel/source' }` 生成源码条件与发布映射，修改入口后构建并提交生成结果。测试直接从公开子路径加载源码，无 alias、预构建或 Plugin lowering。

开发环境为 Node 24+，发布 ESM 以 ES2022 为构建目标，使用 Abort API；运行实现不导入 Node 内置模块。设计来源包括 [grfn](https://github.com/TomerAberbach/grfn) 的依赖组合与 [lfi](https://github.com/TomerAberbach/lfi) 的惰性迭代思路；本包有自己的引用、背压和收尾契约，不承诺 API 兼容。

基准说明见 [bench/README.md](https://github.com/PluxelJS/pluxel/blob/main/packages/async/bench/README.md)，维护约束见 [AGENTS.md](https://github.com/PluxelJS/pluxel/blob/main/packages/async/AGENTS.md)。
