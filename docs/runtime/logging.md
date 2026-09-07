---
title: 结构化日志
description: 使用 Context logger 和稳定属性记录结构化日志，由宿主统一管理输出与等级。
---

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

部署与 Workbench store 选项见 [配置插件宿主](../getting-started/host-setup.md)，仓库内部的遥测集成见 [OpenTelemetry 预览](../plugins/otel.md)，该包目前不供外部项目安装。

## 在 Workbench 查看与归档

Workbench 日志流使用同一份有容量上限的存储。传输中的日志行是普通 JSON-like DTO：缺失的可选字段会省略，嵌套对象不会保留
`undefined`，Plugin 日志同时携带结构化 node address、稳定 reference 与可读 label，便于界面查询和诊断。Range 响应还会按
Runtime session 的物理 WebSocket ceiling 所派生的 payload 预算分页；单条超预算记录保留 identity、message 与精简 error，并
明确标记 structured payload 已截断。Store、`@pluxel/runtime/logger` 和 `@pluxel/runtime/web` 共用同一份日志 DTO 类型定义，避免
producer、校验器与 Workbench 字段漂移。

Workbench 的交互式 range 与 live follow 复用页面唯一、已认证的 Cap’n Web Runtime session；当前没有平行的 HTTP/SSE
日志 API。`ctx.elysia` 属于某个 Plugin generation 的业务 HTTP application，不拥有 Runtime logging store、Management
鉴权或 control-plane 生命周期，因此不能用来暴露宿主日志。需要进程外归档时配置 file 或 OpenTelemetry sink；这与浏览器
交互日志的 transport 是两个职责。

## 测试与 review

记录一条带原始 `error` 的失败日志，在实际使用的输出中确认可以查看 cause/stack 和插件身份。再关闭、开启对应 debug topic，确认高频诊断按预期过滤。message 用于稳定描述事件，变量放入有界属性；凭据和完整用户数据不进入日志。
