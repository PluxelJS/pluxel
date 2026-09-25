---
title: better-result 共享入口
description: 在本地插件之间共享完整的 better-result API，并处理错误与传输边界。
---

本地插件使用 Better Result 时，从 `@pluxel/core/better-result` 导入。这个子入口提供上游完整的命名 API，
由 Core 统一选择版本；导入 Core 主入口不会加载 Better Result。
Command 作者从 `@pluxel/commands` 导入同一版本的 `Result`；Commands 与 Core 没有相互依赖。

## 选择与安装

先写出调用方遇到失败后的动作：提示用户修正输入、使用缺省值、稍后重试，还是终止当前操作。
只有调用方需要稳定分支的预期业务失败才进入 `E`。普通本地领域方法可自行选择 Result。
Command 是明确的受校验执行边界，统一返回 `Promise<Result<T, CommandFailure>>`；类型本身不保证框架缺陷永不 reject。

| 操作                                            | 契约选择                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| 本地插件方法有调用方需要分支处理的预期失败      | 返回 `Result<T, E>`，错误类型由提供方公开                           |
| lookup 的正常空值、缓存 miss、限流 allow/deny   | 保留 `null` / `undefined` / 判定；业务层需要拒绝时再映射            |
| 原生 Wretch、node-redis、s3mini 或 renderer API | 保留上游值和异常契约；在 consumer 知道业务语义时转换                |
| Plugin 启动、generation 撤回或代码不变量失败    | 遵循现有 lifecycle 与异常契约                                       |
| Command 执行                                    | handler 显式返回 Result；执行、输入和授权失败用 CommandFailure 分支 |
| Workbench、Worker、HTTP 或 JSON 边界            | 按领域协议返回并校验普通 DTO；跨边界重建类型由协议拥有者决定        |
| 批量部分成功、已保存未应用或其他有状态操作回执  | 保留领域回执中的全部状态                                            |

发布提供 `Result` API 的插件时，声明包含此子入口的 `@pluxel/core` peer 下限，并在开发依赖中使用 Core。
这条共享路径由 Core 的正常 `better-result` 依赖提供；插件无需为这项本地契约另设 `better-result` peer。
具体包配置见[插件包指南](../development/plugin-package.md)。

### 提供方和调用方各做什么

1. 提供方在公开方法签名中写出 `Result<T, E>` 或 `Promise<Result<T, E>>`。错误用 `TaggedError` 或已有的
   稳定判别类型；已有 code 足够时不再制造一套错误层级。`message` 面向人，不能作为分支条件。
2. 只在最小失败边界转换已知的状态或错误。404 不等于所有网络异常，限流 deny 不等于 backend unavailable，
   用户输入不合法也不等于上游 schema 或代码损坏。`cause` 留作本地诊断，不投影原始密钥、输入或 stack。
3. 调用方用 `isErr()`、`match()` 或错误 union 的穷尽分支作出恢复决定。不要以 `unwrap()` 处理正常失败，
   也不要用 `unwrapOr()` 默默丢掉所有失败原因。无需恢复的操作可以继续使用普通返回值和 throw/reject。
4. 资源成功取得后立即落实原有清理责任。`Result.ok(handle)` 不会接管 handle，`Err` 不会回滚前面已完成的
   写入；`Result.gen()` 的短路也不等于事务。partial/unknown outcome 必须保留在领域回执中。

缓存或跨进程传递的是领域数据。`Err` 是 fulfilled value，`getOrLoad()` / `@Cached` 不会自动把它当成
rejection 排除；序列化也不会替你恢复 Result/Error prototype。先缓存数据或明确的负缓存 `null`，读取后再
构造 Result。需要自有 wire envelope 时，使用本页末尾的 codec，并验证两端 schema。

## Command 边界

`defineCommand()` 的 handler 返回 `Result.ok(value)` 或 `Result.err(CommandFailure)`，不能裸返回成功值。
预期业务拒绝使用 `REJECTED` 与稳定 `reason`；输入 schema 校验失败由 Command 返回带 issues 的
`INPUT_VALIDATION`。调用方先检查 `.isErr()` 再读取 `.value`。Command 内核保留 handler 已取得的
Result，包括取消发生在写入之后时的提交回执。未适配的 SDK rejection 变成 `INTERNAL`，原异常保留在本地
`cause`，载体只向外投影安全字段。

```ts no-twoslash
import { defineCommand, Result } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

const read = defineCommand({
	name: 'notes.read',
	description: 'Read a note.',
	input: obj({ id: Type.String() }),
	execute({ id }) {
		return id === 'known'
			? Result.ok({ id, text: 'Hello' })
			: Result.err({ code: 'REJECTED', reason: 'not_found', message: 'Note not found' })
	},
})

const result = await read.execute({ id: 'known' })
if (result.isErr()) console.error(result.error.code, result.error.message)
else console.log(result.value.text)
```

另一个 Command 的 Result 可以直接从 handler 返回。`Err` 是 fulfilled value；`Promise.all` 不会因为其中一个
Err 停止其他调用。协议载体先处理 Err，再将成功值转换为自己的普通 DTO 或原生工具结果，不序列化 Result 实例。

## 完整导出范围

子入口直接再导出上游全部命名运行时 API 和类型：

```ts
export * from 'better-result'
```

`Result`、`TaggedError`、错误匹配、组合器和 codec 都从这个入口导入；无需另建包装或逐项转发。
当前版本为 3.0.1，完整签名见[上游 API 参考](https://better-result.dev/reference/result)和安装版本的类型声明。

## 返回与处理预期失败

提供方用 `TaggedError` 定义错误标签和字段，调用方用 `.isErr()` 判断失败。
`Result` 同时可用于值和类型，直接导入即可；只有类型用法时使用 `import type`。

```ts twoslash
import { Result, TaggedError } from '@pluxel/core/better-result'

type Order = Readonly<{ id: string; total: number }>
const orders = new Map<string, Order>([['42', { id: '42', total: 100 }]])

export class MissingOrder extends TaggedError('MissingOrder')<{
	id: string
	message: string
}> {}

export function findOrder(id: string): Result<Order, MissingOrder> {
	const order = orders.get(id)
	return order ? Result.ok(order) : Result.err(new MissingOrder({ id, message: 'Order not found' }))
}

const found = findOrder('42')
if (found.isErr()) {
	console.log(found.error._tag, found.error.id)
} else {
	console.log(found.value.total)
}
```

`Result` 也提供 `.match()`、`map()`、`mapError()`、`andThen()` 和 `tryRecover()`。使用 `.match()`
收束成功/失败两支；用 `map()` 转换成功值，用 `andThen()` 接续另一个返回 Result 的操作。
`.unwrap()` 在错误分支会抛出 `Panic`，适合已经证明必定成功的边界，不适合作为普通业务错误处理。

## 异步组合与外部异常

简单校验直接用 `if` 和 `return Result.err(...)`。已有 Result 步骤需要组合时，再使用组合器。
异步领域方法返回 `Promise<Result<T, E>>`。多步操作可用 `Result.gen()` 和 `Result.await()`，遇到第一个
`Err` 就停止后续步骤；短链也可用 `andThenAsync()`。并行操作按需求选 `Result.allAsync()`（全部成功）或
`Result.partitionAsync()`（分别收集成功与失败）。

```ts twoslash
import { Result, TaggedError } from '@pluxel/core/better-result'

type Order = Readonly<{ id: string; total: number }>
class MissingOrder extends TaggedError('MissingOrder')<{ message: string }> {}
class InvalidTotal extends TaggedError('InvalidTotal')<{ message: string }> {}

async function readOrder(id: string): Promise<Result<Order, MissingOrder>> {
	return id === '42'
		? Result.ok({ id, total: 100 })
		: Result.err(new MissingOrder({ message: 'Order not found' }))
}

function checkTotal(order: Order): Result<Order, InvalidTotal> {
	return order.total >= 0
		? Result.ok(order)
		: Result.err(new InvalidTotal({ message: 'Total must be non-negative' }))
}

const priced = await Result.gen(async function* () {
	const order = yield* Result.await(readOrder('42'))
	const checked = yield* checkTotal(order)
	return Result.ok(checked.total)
})
```

`Result.try()` 和 `Result.tryPromise()` 可以把抛出/拒绝转换成 Result。公开 API 若要让调用方按故障类型
恢复，应使用其对象形式的 `catch` 映射成稳定领域错误；只传函数的形式将未知异常包装为
`UnhandledException`。`tryPromise()` 的重试和取消遵循上游选项；实际 I/O 仍须接收它提供的 signal。
对于 HTTP 非 2xx 等未抛异常的状态，应按协议显式判断并映射，不能把所有失败猜成同一个业务错误。

需要**只捕获部分异常、其余保持原样 reject** 时，使用普通 `try/catch`，并把范围缩小到那一次调用：

```ts twoslash
import { Result, TaggedError } from '@pluxel/core/better-result'

class SourceBusy extends Error {}
class RetryLater extends TaggedError('RetryLater')<{ message: string }> {}
declare function readSource(signal: AbortSignal): Promise<string>

async function readReport(signal: AbortSignal): Promise<Result<string, RetryLater>> {
	try {
		return Result.ok(await readSource(signal))
	} catch (error) {
		if (error instanceof SourceBusy) {
			return Result.err(new RetryLater({ message: 'Please try again later' }))
		}
		throw error
	}
}
```

不要在 `Result.tryPromise({ catch })` 中重抛未知错误来模仿这个行为：3.0.1 会把 catch handler 抛出的异常
变成 `Panic`。`andThenAsync()`、`gen()`、`allAsync()` 和 `partitionAsync()` 中未适配的 Promise rejection
同样会变成 `Panic`。只有已经完成错误建模、接受这种 defect 契约的步骤才放入这些组合器；要保留原异常，
先在普通 `async` 函数中 `await`，判断 Err 后再接续。也不要用函数形式的 `tryPromise()` 将 `Panic` 或取消
再包成可恢复的 `UnhandledException`。

只有幂等、确实可恢复的操作才配置重试，并用 `shouldRetry` 限定错误。`signal` 交给实际 IO；重试策略应排除
用户输入错误、取消、generation 撤回或无法确定是否已提交的写入。Result 不改变底层取消能力。

上游回调（如 `map`、`match` 的回调）意外抛出时会抛 `Panic`。在日志或监督边界报告它；不要将
`Panic` 当作普通 `Err` 静默恢复。详见[上游错误契约](https://better-result.dev/errors/panic-and-defects)。

## 官方插件示例

官方 capability 保留各自成熟的值、错误和资源契约；下表的示例在拥有业务恢复策略的层完成适配。

| 插件                                                                                                                                       | 演示与保留的边界                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [Wretch](../plugins/wretch.md#将可预期失败返回给调用方)                                                                                    | 404 → `CustomerNotFound`；503、网络故障、响应 schema 错误继续 reject，HTTP consumer 投影普通响应 |
| [Cache](../plugins/cache.md#在缓存之外构造-result)                                                                                         | 缓存数据 / `null`，读取后转换缺失；不缓存 Result/Error 实例                                      |
| [Rates](../plugins/rates.md#第一个-limiter)                                                                                                | deny → 业务 `MessageRateLimited`；保留 retry 信息，backend failure 仍拒绝                        |
| [Redis](../plugins/redis.md#将缺失映射为业务-result)                                                                                       | 原生 GET 的 `null` → 业务缺失；空字符串是成功，连接与命令故障不伪装成缺失                        |
| [S3](../plugins/storage.md#将对象缺失返回给调用方)                                                                                         | 对象不存在 → 业务缺失；bucket 配置、权限和 IO 故障继续拒绝                                       |
| [Canvas](../plugins/rendering/canvas.md#将可恢复失败交给业务调用方)、[Fonts](../plugins/rendering/fonts.md#将可恢复失败交给业务调用方)     | 用户图片 / 字体内容被拒绝 → 明确的 Err；成功的 native object / registration 保留所有权           |
| [ECharts](../plugins/rendering/echarts.md#将可恢复失败交给业务调用方)、[Takumi](../plugins/rendering/takumi.md#将可恢复失败交给业务调用方) | consumer 选择处理 render busy；未知 render failure、取消和停止不混为“稍后重试”                   |
| [Markdown / Typst](../plugins/rendering/takumi-markdown.md#将可恢复失败交给业务调用方)                                                     | 文档超限或受限公式不合法 → 可修正输入；extension defect、Worker 故障继续拒绝                     |
| [Auth](../plugins/auth.md#本地-result-与设置回执)                                                                                          | 内部校验直接返回 Result；Setup API 保持经过校验的普通 DTO                                        |
| [Pi Agent](../plugins/pi-agent.md#直接处理会话结果)                                                                                        | 直接消费 `prompt()` 的 outcome 和 aborted / model_error；不再套一层 Result                       |
| [Package Manager](../plugins/package-manager.md)、[OTel](../plugins/otel.md)、Vault Admin                                                  | 安装回执、原生 telemetry 和管理 action 已有协议；不增加无业务恢复需求的 Result 包装              |

各指南链接到包内可执行示例。验证时至少检查成功、预期 Err 和非预期 rejection；涉及数据缓存、DTO 或资源时，
再验证序列化边界、失败后的副作用和清理。只断言 `.isErr()` 不足以证明错误没有被错误分类。

## 传输与版本边界

`Result`、`Ok`、`Err` 和 `TaggedError` 是运行时对象。本地插件之间可以直接共享；Workbench portable
数据、Worker 消息、HTTP 与 JSON 必须交付符合各自协议的普通数据。生产者可以按领域投影 DTO，
如 [Wretch consumer 示例](../plugins/wretch.md#将可预期失败返回给调用方)中将 `CustomerNotFound` 映射
成 HTTP 404。

完整再导出也包含上游 `Result.codec()`，可用 Standard Schema 验证自有的序列化 envelope。
使用 codec 时仍要明确定义成功值、错误和 wire schema；Workbench 还须遵守其 portable DTO 校验与
资源所有权规则。`Result.codec()` 的具体同步/异步返回类型见
[上游编解码文档](https://better-result.dev/serialization/result-codecs)，Workbench 规则见
[契约、数据与资源](./contracts.md)。
