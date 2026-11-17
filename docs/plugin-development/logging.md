---
title: 插件日志：结构化输出与最佳实践
description: 使用 Context 的 logger 记录带属性的结构化日志，由宿主统一管理日志级别与输出汇聚。
---

在插件中，推荐通过 Core 提供的 `this.ctx.logger` 记录日志。框架会自动为日志附加当前插件的身份（名称、实例分叉等），并配合 LogTape 实现高性能的结构化输出与按需过滤。

## 基础写法

在插件方法中直接调用 `this.ctx.logger` 的级别方法：

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin({ displayName: 'Worker' })
export class WorkerPlugin extends BasePlugin {
	start(endpoint: string, concurrency: number): void {
		// 输出日志：稳定消息文本 + 结构化属性对象
		this.ctx.logger.info('Worker started', {
			endpoint,
			concurrency,
		})
	}
}
```

在终端或 Workbench 日志面板中，该条日志会自动标记插件来源，无需手工在消息文本中拼接插件前缀。

### 记录异常与堆栈

捕获错误并打日志时，建议将原始 `Error` 对象作为结构化字段传入：

```ts no-twoslash
try {
	await this.syncCatalog()
} catch (error: unknown) {
	this.ctx.logger.error('Catalog sync failed', {
		error,
		catalogId,
	})
	throw error
}
```

传递原始 `Error` 对象能让底层输出端完整保留堆栈跟踪（Stack Trace）与关联原因（`cause`），有助于后续故障定位。

## 写法选择

LogTape 支持多种调用风格，可根据场景灵活选用：

| 场景                 | 推荐写法                           | 示例                                                                 |
| -------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| 常规文本输出         | `logger.info(message)`             | `logger.info('Service ready')`                                       |
| 携带查询属性         | `logger.info(message, properties)` | `logger.info('Job done', { jobId, durationMs: 120 })`                |
| 带有插值的直观展示   | 模板字符串占位符                   | `logger.info('Processed {count} items for {user}', { count, user })` |
| 需昂贵计算生成的字段 | `lazy()` 延迟求值                  | `logger.debug('Snapshot', { stats: lazy(() => calc()) })`            |

### 延迟计算（Lazy Evaluation）

如果某些调试日志包含高开销的计算（如遍历大对象生成摘要），而该级别的日志在生产环境中通常被关闭，可以使用 `@logtape/logtape` 的 `lazy()` 包装函数：

```ts no-twoslash
import { lazy } from '@logtape/logtape'

// 仅在 debug 日志实际开启并输出时，才会执行包装函数
this.ctx.logger.debug('Queue snapshot', {
	queueSize: queue.length,
	summary: lazy(() => summarizeLargeQueue(queue)),
})
```

`lazy()` 内部函数应当保持无副作用与只读操作，避免在计算中产生业务状态变更。

## 派生上下文（Logger with）

为特定操作或子模块附加固定属性时，可使用 `.with()` 派生新的 Logger 实例：

```ts no-twoslash
const jobLogger = this.ctx.logger.with({
	jobId: 'job_456',
	module: 'extractor',
})

jobLogger.info('Task started')
jobLogger.info('Task finished', { exitCode: 0 })
```

派生出的 `jobLogger` 会在后续每一条输出中自动携带 `jobId` 和 `module` 属性，便于日志检索与链路关联。

## 细粒度调试通道（Debug Channel）

如果插件有高频的底层探针日志（如缓存命中排查、HMR 链路跟踪），但平时不想污染普通的 debug 输出，可以创建专用的 Debug Channel：

```ts no-twoslash
export class CachePlugin extends BasePlugin {
	private readonly cacheDebug = this.ctx.logger.getDebugChannel('cache:lookup')

	get(key: string) {
		this.cacheDebug.debug('Cache query', { key })
		// ...
	}
}
```

宿主可以通过配置项精确启用特定通道（如 `debugTopics: ['cache:*']`），在保持其他组件整洁的同时聚焦排查特定模块。

## 日志级别规范

- **`trace`**：极其详细的底层执行过程，仅在本地深入诊断时启用。
- **`debug`**：排障辅助信息，通常在开发环境或排错时开启。
- **`info`**：系统关键生命周期事件、初始化完成或重大业务动作。
- **`warn`**：出现可恢复的异常、降级分支或非致命配置提示。
- **`error`**：当前请求或后台任务执行失败，需要关注排查。
- **`fatal`**：宿主或插件核心出现严重损坏，无法继续服务。

## 安全与隐私建议

为了防止敏感数据泄漏到日志存储中，请注意：

- 避免记录密码、API Key、Bearer Token 或数据库凭证；
- 避免直接将整个未经清洗的请求 Payload 或大型用户隐私对象打入属性中；
- 优先记录请求 ID（`requestId`）或业务主键，避免输出难以索引的高基数长文本。
