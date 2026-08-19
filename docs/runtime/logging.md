---
title: 结构化日志
description: 使用 Context logger 和稳定属性记录结构化日志，由宿主统一管理输出与等级。
---

# 结构化日志

Plugin 只需要使用 `ctx.logger` 记录事件。宿主为整个进程统一配置控制台、文件、存储或 OpenTelemetry 输出，并负责路由、动态日志等级和关闭时的刷新。

## 基本写法

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/runtime'

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

发生错误时把原始 error 放入结构化属性：

```ts no-twoslash
try {
	await this.syncOnce()
} catch (error: unknown) {
	this.ctx.logger.error('catalog sync failed', {
		error,
		catalogId,
	})
}
```

不要把 error 预先拼成字符串；sink 需要原始 cause/stack 才能正确渲染和导出。

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

不要把每次正常请求都写成 `warn`，也不要把真正失败降成 `debug` 来消除噪音。等级应该表达事实严重度，sink/filter 决定展示量。

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

## Host logging plan

static/dynamic launcher 提供合理默认值。需要自定义时，host 传入完整 logging plan：

```ts no-twoslash
logging: {
	root: {
		profile: 'production',
		debugTopics: ['cache:lookup'],
	},
	sinks: {
		console: {
			kind: 'console',
			format: 'json',
			timezone: 'utc',
		},
	},
	routes: {
		runtime: [{ sink: 'console', minLevel: 'info' }],
		plugins: [{ sink: 'console', minLevel: 'trace' }],
		debug: [{ sink: 'console', minLevel: 'trace' }],
		meta: [{ sink: 'console', minLevel: 'warning' }],
	},
}
```

`plugins` route 可以保持较低门槛，再由 O(1) Plugin policy 决定实际等级。`logging: false` 表示安装一个没有 sinks/routes 的 silent root，仍保留 Context identity 和管理所有权。

部署与 Workbench store 选项见 [配置插件宿主](../getting-started/host-setup.md)，标准 OpenTelemetry signals 见 [OpenTelemetry](./otel.md)。

## 测试与 review

- 失败路径记录原始 `error` property。
- message 是稳定事实，不把变量全部插进 message。
- properties 有界、可序列化且不含 credential。
- debug topic 数量由代码设计决定，不由用户输入决定。
- Plugin 不安装 logger root、sink 或全局 LogTape config。
