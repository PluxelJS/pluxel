---
title: better-result 共享入口
description: 在本地插件之间共享完整的 better-result API，并处理错误与传输边界。
---

多个 Plugin 需要交换 `Result` 实例时，从 `@pluxel/core/better-result` 导入。Core 的这个子入口直接
`export * from 'better-result'`：上游的全部**命名**运行时导出和 TypeScript 类型都可用，作者不必为
`Result`、`Ok`、`Err` 或错误工具分别寻找入口。Core 选择上游版本，并在 ESM 与 Node 24+ CJS 发布包中
提供相同子路径；导入 Core 主入口不会加载 `better-result`。

## 选择与安装

| 操作                                           | 契约选择                                                     |
| ---------------------------------------------- | ------------------------------------------------------------ |
| 本地插件方法有调用方需要分支处理的预期失败     | 返回 `Result<T, E>`，错误类型由提供方公开                    |
| Plugin 启动、generation 撤回或代码不变量失败   | 遵循现有 lifecycle 与异常契约                                |
| Command、Workbench、Worker、HTTP 或 JSON 边界  | 按领域协议返回并校验普通 DTO；跨边界重建类型由协议拥有者决定 |
| 批量部分成功、已保存未应用或其他有状态操作回执 | 保留领域回执中的全部状态                                     |

发布提供 `Result` API 的插件时，声明包含此子入口的 `@pluxel/core` peer 下限，并在开发依赖中使用 Core。
这条共享路径由 Core 的正常 `better-result` 依赖提供；插件无需为这项本地契约另设 `better-result` peer。
具体包配置见[插件包指南](../development/plugin-package.md)。

## 完整导出范围

子入口源码就是：

```ts
export * from 'better-result'
```

当前 Core 选择的 `better-result` 3.0.1 提供以下命名导出。未来上游增删导出时，Core 对上游版本的升级
会连同本子入口的公开 API 一起评估。

| 运行时导出                                                        | 用途                           |
| ----------------------------------------------------------------- | ------------------------------ |
| `Result`、`Ok`、`Err`                                             | 创建、判断、转换和组合结果     |
| `TaggedError`、`isTaggedError`、`matchError`、`matchErrorPartial` | 定义并处理带稳定 `_tag` 的错误 |
| `Panic`、`isPanic`、`panic`、`UnhandledException`                 | 诊断未预期的异常与损坏的不变量 |
| `ResultSerializationError`、`ResultDeserializationError`          | `Result.codec` 的传输校验失败  |

`Result`、`Ok`、`Err` 和上述错误类也可在类型位置使用。额外的仅类型导出如下：

| 类型导出                                                                                                                                      | 用途                          |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `InferOk`、`InferErr`、`CallbackSuccess`、`CallbackError`                                                                                     | 推导结果与回调的成功/错误类型 |
| `AnyTaggedError`、`TaggedErrorClass`、`TaggedErrorInstance`                                                                                   | 带标签错误的类型契约          |
| `ResultCodec`、`ResultCodecConfig`、`ResultCodecIssue`、`SerializedOk`、`SerializedErr`、`SerializedResult`                                   | Result 编解码与 wire envelope |
| `StandardSchemaV1`、`StandardSchemaInput`、`StandardSchemaOutput`、`StandardSchemaIssue`、`StandardSchemaPathSegment`、`StandardSchemaResult` | Standard Schema 适配类型      |
| `TryContext`、`TryPromiseContext`                                                                                                             | 同步/异步尝试的上下文         |

以上名称是当前版本的导出清单；方法参数、重载及返回类型以
[上游完整 API 参考](https://better-result.dev/reference/result)和安装版本的 TypeScript 声明为准。

## 返回与处理预期失败

提供方用 `TaggedError` 给可恢复失败稳定标签和字段，并在方法签名中写出错误类型。调用方使用同一子入口的
`Result.isError()` 或实例的 `.isErr()` 缩窄结果，不依赖人类可读的 `message` 决定分支。

```ts twoslash
import { Result, TaggedError, type Result as SharedResult } from '@pluxel/core/better-result'

type Order = Readonly<{ id: string; total: number }>
const orders = new Map<string, Order>([['42', { id: '42', total: 100 }]])

export class MissingOrder extends TaggedError('MissingOrder')<{
	id: string
	message: string
}> {}

export function findOrder(id: string): SharedResult<Order, MissingOrder> {
	const order = orders.get(id)
	return order ? Result.ok(order) : Result.err(new MissingOrder({ id, message: 'Order not found' }))
}

const found = findOrder('42')
if (Result.isError(found)) {
	console.log(found.error._tag, found.error.id)
} else {
	console.log(found.value.total)
}
```

`Result` 也提供 `.match()`、`map()`、`mapError()`、`andThen()` 和 `tryRecover()`。使用 `.match()`
收束成功/失败两支；用 `map()` 转换成功值，用 `andThen()` 接续另一个返回 Result 的操作。
`.unwrap()` 在错误分支会抛出 `Panic`，适合已经证明必定成功的边界，不适合作为普通业务错误处理。

## 异步组合与外部异常

异步领域方法返回 `Promise<Result<T, E>>`。多步操作可用 `Result.gen()` 和 `Result.await()`，遇到第一个
`Err` 就停止后续步骤；短链也可用 `andThenAsync()`。并行操作按需求选 `Result.allAsync()`（全部成功）或
`Result.partitionAsync()`（分别收集成功与失败）。

```ts twoslash
import { Result, TaggedError, type Result as SharedResult } from '@pluxel/core/better-result'

type Order = Readonly<{ id: string; total: number }>
class MissingOrder extends TaggedError('MissingOrder')<{ message: string }> {}
class InvalidTotal extends TaggedError('InvalidTotal')<{ message: string }> {}

async function readOrder(id: string): Promise<SharedResult<Order, MissingOrder>> {
	return id === '42'
		? Result.ok({ id, total: 100 })
		: Result.err(new MissingOrder({ message: 'Order not found' }))
}

function checkTotal(order: Order): SharedResult<Order, InvalidTotal> {
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

上游回调（如 `map`、`match` 的回调）意外抛出时会抛 `Panic`。在日志或监督边界报告它；不要将
`Panic` 当作普通 `Err` 静默恢复。详见[上游错误契约](https://better-result.dev/errors/panic-and-defects)。

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
