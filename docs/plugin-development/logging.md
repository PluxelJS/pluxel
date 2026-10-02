---
title: 插件日志：LogTape 用法与最佳实践
description: 使用 Context logger 和稳定属性记录结构化日志，由宿主统一管理输出与等级。
---

Plugin 使用 Core 自带的 `ctx.logger` 记录事件；Host 管理输出、路由、等级和关闭时的刷新。

Plugin 作者从[写法选择](#写法选择)和[延迟计算](#延迟计算)开始；宿主输出见[Host 日志配置](../host/configuration.md#host-logging-plan)，在线读取见[开发控制台](../development/dev-console.md#有界操作日志与等待)。`ctx.logger` 是 Core 基础能力，输出和存储由宿主另外配置。

## 写法选择

在 Plugin 方法中使用 `const logger = this.ctx.logger`。等级方法保留 LogTape 的原生调用形式；按值的用途选择，不要求每条诊断都建立字段。

| 需要                             | 写法                                                             |
| -------------------------------- | ---------------------------------------------------------------- |
| 固定事件，没有变量               | `logger.info('worker started')`                                  |
| 人读的轻量诊断，插值无需单独查询 | ``logger.debug`Loaded ${count} records` ``                       |
| 查询、关联、分析需要的字段       | `logger.info('batch completed', { batchId, count, durationMs })` |
| 同时需要可读行和结构化字段       | `logger.info('Batch {batchId} completed', { batchId, count })`   |
| 计算诊断值代价较高               | structured property 使用 `lazy()`；整条诊断使用 message 回调     |

Tagged template 保留文本片段与插值的边界，让 sink 决定如何渲染值；普通字符串插值 ``logger.info(`...${value}`)`` 在调用前已经拼成字符串。**Tagged template 的插值不会自动生成具名 properties**；从 `with()` 继承的属性仍然存在。

`requestId`、`jobId`、`status`、`durationMs`、错误码等有机器语义的值放入 properties。无需把所有属性重复写进 message；message 保持稳定，必要时用 `{field}` 占位符让终端也容易读。不要预先 `JSON.stringify()` 整个属性对象，否则后端只能拿到字符串。字段名、类型和单位保持一致，例如耗时统一用数字 `durationMs`。

原生语义见 [LogTape structured logging](https://logtape.org/manual/struct)。属性是否能在某个后端查询，还取决于宿主选择的 sink 与后端字段映射。

## 基本写法

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin({ displayName: 'Worker' })
export class WorkerPlugin extends BasePlugin {
	start(endpoint: string, concurrency: number): void {
		this.ctx.logger.info('worker started', {
			endpoint,
			concurrency,
		})
	}
}
```

调用 `start()` 后，在开发终端或 Workbench 日志页查找 `worker started`，并展开 `endpoint`、`concurrency` 属性。宿主自动关联插件身份，无需在每条日志重复写插件名称。

发生错误时把原始 error 放入结构化属性：

```ts no-twoslash
try {
	await this.syncOnce()
} catch (error: unknown) {
	this.ctx.logger.error('catalog sync failed', {
		error,
		catalogId,
	})
	throw error
}
```

不要把 error 预先拼成字符串；sink 需要原始 cause/stack 才能正确渲染和导出。错误码、操作和重试次数另放 properties。日志不代替失败契约：无法继续时仍按领域约定抛出或返回失败；避免每层都记录同一个异常，让决定恢复或终止的边界记录一次。

## 延迟计算

Tagged template **不等于 lazy**：``logger.debug`State ${buildSummary()}` `` 仍会先执行 `buildSummary()`。已经拿到的数字、字符串直接传；只有额外计算值得延迟时才使用以下形式。

```ts no-twoslash
import { lazy } from '@logtape/logtape'

// 保留可查询字段，按需计算其中一个值。
logger.debug('queue snapshot', {
	queueSize: queue.length,
	summary: lazy(() => summarizeQueue(queue)),
})

// 整条人读诊断延迟构造；回调必须返回给定 tag 的结果。
logger.debug((message) => message`Queue summary: ${summarizeQueue(queue)}`)
```

`lazy()` 是原生工具，可直接导入；不要因此改用独立 `getLogger()`。回调应同步、无副作用、结果有界；不能把业务写入、计数或清理放进日志回调。它读取的是求值时的数据，不是深拷贝快照，需要记录发生时的状态就提前保存必要的标量。

整个 properties 对象也可用工厂：`logger.debug('queue snapshot', () => ({ size: queue.length }))`。它与 `lazy()` 的求值阶段不同：不要依赖“最终没有输出”来保证工厂绝不执行；插件 policy、topic 和 route 都可能继续过滤。对于昂贵字段，优先字段级 `lazy()`。

原生异步 properties 工厂返回 Promise，必须等待并处理可能的失败：

```ts no-twoslash
await logger.debug('diagnostic snapshot', async () => ({
	summary: await readDiagnosticSummary(),
}))
```

仅在确需异步诊断时使用，不为普通日志额外查数据库或调用网络。这里的 `await` 等待 properties 计算与日志调用，不代表远程 sink 已送达。不要在 tagged template 中放 async 回调，也不要把 `lazy(async () => ...)` 当作异步工厂的替代。

`ctx.logger` 不是完整 LogTape Logger：目前没有公开 `isEnabledFor()`，也不应绕过封装访问内部 logger 判断插件开关；使用以上 lazy 形式，由宿主统一过滤。上游能力细节见 [Lazy evaluation](https://logtape.org/manual/lazy)，实际支持范围以当前 Pluxel 类型为准。

## 派生稳定上下文

为资源或组件增加有界属性时使用 `with()`：

```ts no-twoslash
const logger = this.ctx.logger.with({
	component: 'refresh-loop',
	provider: 'catalog',
})

logger.info('refresh started')
logger.warn('refresh delayed', { delayMs })
```

请求/任务关联使用局部 `logger.with({ requestId })`，传给本次操作；不要在共享变量里存放“当前 requestId”，并发请求会串号。`with({ phase: lazy(() => phase) })` 适合单个 owner 的动态状态，不适合共享的当前请求身份。

派生 logger 适合在 owner generation 内长期复用。不要每条日志重复创建相同属性，也不要在 module top level 缓存脱离 Context 的 logger。

## Debug topic

高频诊断使用显式 topic：

```ts no-twoslash
private readonly cacheDebug = this.ctx.logger.getDebugChannel('cache:lookup')

lookup(key: string) {
	this.cacheDebug.debug('cache miss', { key })
}
```

host 可以通过 `debugTopics` 精确开启 `hmr:*`、`cache:lookup` 等 topic，而不把全部 Plugin 日志调到 trace。长期使用的 channel 由调用方保存；logger 不维护无限 topic cache。

Debug log 仍必须有界。不要为每个 user ID、URL、request ID 动态创建 topic；这些值放进 properties。

## 日志等级

| 等级    | 用途                                                     |
| ------- | -------------------------------------------------------- |
| `trace` | 极细、通常默认关闭的内部步骤                             |
| `debug` | 排障所需但不属于正常运维流的事实                         |
| `info`  | 启动完成、显著状态变化和业务里程碑                       |
| `warn`  | 已降级或可恢复，但需要关注                               |
| `error` | 当前操作失败或后台能力受损                               |
| `fatal` | 宿主级无法继续的严重事实；Plugin 不自行 `process.exit()` |

不要把每次正常请求都写成 `warn`，也不要把真正失败降成 `debug` 来消除噪音。等级应该表达事实严重度，sink/filter 决定展示量。循环和重试优先记录阶段变化、汇总和最终结果；日志中的 count/duration 适合排障，长期趋势与告警统计使用 metrics。

## 不要记录什么

日志、错误和 status snapshot 都不得包含：

- token、password、cookie、authorization header；
- 私钥、Vault identity、数据库 DSN credential；
- 完整 request/response body 中的用户数据；
- Context、Plugin instance、SDK client 或其他大对象；
- 无界数组、递归对象和高基数 topic/category。

需要关联请求时使用 request ID、owner-safe resource ID 或经过明确脱敏的字段。

## Identity 与 policy

runtime 根据结构化 Plugin node address 生成 logger identity。class name 和 `displayName` 只是展示信息；同名 Plugin export、fork 和 replacement generation 不会因为名称相同而混用 policy。

Workbench 修改的是 root-owned plugin log policy，不为每个 Plugin 安装第二个 LogTape 配置。Plugin 不直接 import `getLogger()`，也不配置 sink。

## 测试与 review

记录一条带原始 `error` 的失败日志，在实际使用的输出中确认可以查看 cause/stack 和插件身份。再关闭、开启对应 debug topic，确认高频诊断按预期过滤。检查 tagged template 保留可读值、需要查询的字段位于 properties、关闭诊断时昂贵 lazy 字段不求值。凭据和完整用户数据不进入任何 message 或属性。
