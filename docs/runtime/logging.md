---
title: 结构化日志
description: 使用 Context logger 和稳定属性记录结构化日志，由宿主统一管理输出与等级。
---

Plugin 只需要使用 `ctx.logger` 记录事件。宿主为整个进程统一配置控制台、文件、存储或 OpenTelemetry 输出，并负责路由、动态日志等级和关闭时的刷新。

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

`servicesPreset()` 安装默认日志方案。自定义时通过它的 `logging` 选项传入完整 plan；自行组合的 Host 使用下文 `logging(plan)` 服务：

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

Workbench 使用同一份有界日志存储，通过已认证的 Management 会话查询与 follow，不增加 HTTP/SSE 日志 API。
日志携带 node address、reference 和可读标签；range 按传输预算分页，超大单条记录明确标记 payload 截断。
需要进程外归档时配置 file 或 OpenTelemetry sink；Plugin 的业务 HTTP 不负责暴露宿主日志。

## 测试与 review

记录一条带原始 `error` 的失败日志，在实际使用的输出中确认可以查看 cause/stack 和插件身份。再关闭、开启对应 debug topic，确认高频诊断按预期过滤。message 用于稳定描述事件，变量放入有界属性；凭据和完整用户数据不进入日志。

## 独立 Host

```ts
import { createHost } from '@pluxel/host'
import { logging } from '@pluxel/services/logging'

const host = await createHost({
	plugins: [],
	services: [
		logging({
			root: { profile: 'application' },
			sinks: { memory: { kind: 'store', caller: false } },
			routes: {
				runtime: [{ sink: 'memory', minLevel: 'info' }],
				plugins: [{ sink: 'memory', minLevel: 'trace' }],
				debug: [],
				meta: [],
			},
		}),
	],
})

host.ctx.logger.info('Host ready')
host.ctx.logging.flushStores()
const recent = host.ctx.logging.stores.getOrCreate('default').tailWindow(100)
await host.close()
```

日志查询和 policy 都属于所选 Host 的 `host.ctx.logging`，不依赖 Management。
需要持久化 policy 时，把 `createPluginLogPolicyStore(namespace)` 作为 `logging(plan, { policyStore })`
的选项传入；namespace 是借用资源，关闭由应用或其存储服务负责。
删除 fork 会在同一 Host 队列内清理日志 policy；写入失败时保留 fork，恢复存储后可重试。
同一进程仍只允许一个活动日志 Host，第二个安装失败不会影响第一个。

## 有界操作日志与等待

`markLogs(logging, streamId?)` 标记已 flush 的末尾；`readLogs(logging, cursor, { limit: 100, filter })` 返回有界记录和下一 cursor。`waitForLogs(logging, cursor, { signal, limit: 100, filter })` 等待首批匹配记录或 cursor 失效，signal 必填，取消与完成都会释放订阅。三者均从 `@pluxel/services/logging` 导入，使用同一 store，不创建控制台专用日志通道。

cursor 是普通 JSON，包含 rootId、streamId、bootId、epoch、nextSeq；不可把不同 Host 或重建 stream 的序号相接。读取保留 `root_mismatch`、`stream_replaced`、`store_unavailable`、`epoch_mismatch`、`from_too_old` 与 `invalid` 的失败分支。mark 可为已配置但尚无记录的 stream 创建空存储，未配置且不存在时抛错。调用示例见 [开发控制台](../development/dev-console.md)。

## 宿主安装与访问

自行组合 Host 时，从 `@pluxel/services/logging` 导入 `logging(plan, options)` 并加入 `services`。Host 负责安装、绑定和关闭唯一的进程日志 owner；运行后通过 `host.ctx.logging` 或在开发控制台用 `dev.ctx.require(Logging)` 访问当前 manager。不要手动创建或绑定另一个 manager。
