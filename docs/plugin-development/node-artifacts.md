---
title: Node 模块与 Worker 任务
description: 将特定逻辑编译为独立的 Node ESM 产物，或将 CPU 密集型任务分派给后台 Worker 线程池。
---

在某些场景下，插件可能需要执行繁重的计算（如排版渲染、图像处理、压缩等），或者需要隔离运行特定的 Node.js 模块。Pluxel 提供了两项专门的服务：
- **`defineNodeModule()`**：将指定入口单独打包为纯净的 Node ESM 并在主线程按需动态加载；
- **`defineWorkerTask()`**：将计算任务提交到宿主维护的 Worker 线程池中并发执行，避免阻塞主事件循环。

## 选择安装能力

在宿主配置中，`standardServices()` 与 `servicesPreset()` 默认已包含 Node 模块与 Worker 服务。如果手动装配宿主，请显式挂载 `nodeModules()` 与 `workers()`：

```ts
import { nodeModules } from '@pluxel/services/node'
import { workers } from '@pluxel/services/workers'

export default defineHostApplication(() => ({
	services: [nodeModules(), workers()],
}))
```

## 独立 Node 模块（defineNodeModule）

使用 `defineNodeModule()` 将辅助代码编译为自包含的单文件 Node ESM：

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import { NodeModules, defineNodeModule } from '@pluxel/services/node'

// 1. 声明独立模块入口（相对于当前文件）
const rulesModule = defineNodeModule(import.meta.url, './rules-entry.ts')

@Plugin({ displayName: 'Rules' })
export class RulesPlugin extends BasePlugin {
	protected override async init() {
		// 2. 加载模块并在当前插件作用域中执行初始化
		await this.ctx.require(NodeModules).use(rulesModule, async (url) => {
			const mod = await import(url.href)
			return mod.setup({ logger: this.ctx.logger })
		})
	}
}
```

在 `rules-entry.ts` 中编写标准导出的模块逻辑：

```ts no-twoslash
export function setup({ logger }: { logger: { info(msg: string): void } }) {
	logger.info('Rules engine ready')
	// 返回清理回调
	return () => logger.info('Rules engine disposed')
}
```

<span id="取消与-plugin-stop"></span>
## 共享后台 Worker 任务（defineWorkerTask）

对于可能阻塞事件循环的 CPU 密集型任务，推荐将其打包为 Worker 任务：

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import { Workers, defineWorkerTask } from '@pluxel/services/workers'

type SumInput = { values: number[] }
type SumOutput = { total: number }

// 1. 声明 Worker 任务类型与入口
const sumTask = defineWorkerTask<SumInput, SumOutput>(import.meta.url, './sum-worker.ts')

@Plugin({ displayName: 'Reports' })
export class ReportsPlugin extends BasePlugin {
	calculate(values: number[], signal?: AbortSignal) {
		// 2. 将任务分派给线程池执行，支持 AbortSignal 取消
		return this.ctx.require(Workers).run(sumTask, { values }, { signal })
	}
}
```

在同目录创建 `sum-worker.ts`，导出默认的处理函数：

```ts twoslash
import type { WorkerTaskHandler } from '@pluxel/services/workers'

type SumInput = { values: number[] }
type SumOutput = { total: number }

const run: WorkerTaskHandler<SumInput, SumOutput> = ({ values }) => ({
	total: values.reduce((sum, item) => sum + item, 0),
})

export default run
```

当调用 `calculate([1, 2, 3])` 时，计算将在 Worker 独立线程中执行，返回最终的 `{ total: 6 }`，确保主线程的 HTTP 响应与 UI 交互始终流畅。
