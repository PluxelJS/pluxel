---
title: better-result 共享入口
description: 掌握 Better Result 在本地插件方法、Command 指令与多步可恢复操作中的使用规范。
---

在 TypeScript 开发中，对于预期内可能发生并需要调用方分支处理的业务失败（例如资源不存在、额度不足、权限不匹配等），使用 `Result<T, E>` 类型通常比直接抛出异常更具类型安全性。

Pluxel 核心在 `@pluxel/core/better-result` 子路径下直接导出了 [Better Result](https://better-result.dev/) 的完整运行时 API 与类型，供插件直接使用。

跨插件公开 Result 实例时，提供方和调用方使用同一子入口，通过 `@pluxel/core` peer 共享所选版本，无需额外声明 `better-result` peer。Core peer 范围应包含所用子入口和 API 的最低版本；只导入 Core 主入口不会加载 Better Result。独立安装的双包 ESM/CJS 消费与对象身份检查见 [Core 发行回归](https://github.com/PluxelJS/pluxel/blob/main/packages/core/tests/installed-result.smoke.mjs)。

本地业务方法按恢复需要选择 Result；SDK 原生返回值、部分成功回执及配置的保存/采用状态继续使用各自协议。Host 的[脚本 SDK](../development/scripts.md)在其控制边界统一返回 Better Result，并通过 `sdk.Result` 注入同一 namespace，保留原报告与持久化、采用信息。`Plugin.init()` 无法提供能力时仍按生命周期约定失败。

## 场景选型：何时使用 Result

- **常规成功与单一空值**：如果只是查询可能找不到（如缓存未命中），直接返回 `null` 或 `undefined` 最为简洁直观。
- **不可恢复的系统级故障**：例如配置文件格式损坏、依赖服务未安装、底层网络断连，直接抛出常规 `Error`，交由框架生命周期或全局错误处理器接管。
- **预期的业务分支失败**：当调用方需要根据明确的错误类型做出差异化动作（例如提示用户重试、走备用分支），建议使用 `Result<T, E>` 返回类型。
- **Command 指令执行**：Pluxel 的指令系统（Commands）统一规范要求 `execute()` 返回 `Result` 类型，区分业务拒绝与参数异常。

## 基础用法：返回与处理错误

提供方可使用 `TaggedError` 定义具备唯一标签（Tag）的强类型业务错误，消费方通过 `.isErr()` 或 `.match()` 进行分支处理：

```ts twoslash
import { Result, TaggedError } from '@pluxel/core/better-result'

// 1. 定义业务错误类型
export class NotFoundError extends TaggedError('NotFoundError')<{ id: string }> {}
export class LimitExceededError extends TaggedError('LimitExceededError')<{ limit: number }> {}

export type FetchUserError = NotFoundError | LimitExceededError

// 2. 方法签名中明确标出 Result 返回类型
export function fetchUser(id: string): Result<{ name: string }, FetchUserError> {
	if (id === 'anonymous') {
		return Result.err(new NotFoundError({ id }))
	}
	return Result.ok({ name: 'Alice' })
}

// 3. 调用方进行模式匹配或条件分支
const result = fetchUser('anonymous')

if (result.isErr()) {
	if (result.error instanceof NotFoundError) {
		console.warn(`User ${result.error.id} not found`)
	}
} else {
	console.log(`Hello, ${result.value.name}`)
}
```

## 组合多个可能失败的步骤（Result.gen）

当多个操作需要串联执行，且任何一步出错都立即中断流程时，可以使用生成器语法 `Result.gen`，免去层层嵌套的 `if (res.isErr())`：

```ts no-twoslash
import { Result } from '@pluxel/core/better-result'

async function registerAccount(input: AccountInput) {
	return Result.gen(async function* () {
		// 校验输入
		const validated = yield* Result.await(validateInput(input))

		// 检查重复账号
		yield* Result.await(ensureNotRegistered(validated.email))

		// 创建数据库记录
		const account = yield* Result.await(createDbRecord(validated))

		return Result.ok(account)
	})
}
```

异步生成器通过 `yield* Result.await(promise)` 解包成功值；若某一步返回 `Result.err`，整个流程提前短路并返回该错误。生成器正常结束时返回 `Result.ok(value)`。同步 Result 可以直接 `yield*`；生成器中的未知异常遵循上游 `Panic` 规则。

## Command 指令中的使用

Pluxel 的 `@pluxel/commands` 模块与 Better Result 深度集成。定义指令时，`execute` 方法直接返回 `Result`：

```ts no-twoslash
import { defineCommand, Result } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

export const readNoteCommand = defineCommand({
	name: 'notes.read',
	description: '读取指定笔记的内容',
	input: obj({ id: Type.String() }),
	execute({ id }) {
		if (id === 'demo') {
			return Result.ok({ id, title: 'Demo Note' })
		}
		return Result.err({
			code: 'REJECTED',
			reason: 'not_found',
			message: `Note ${id} does not exist`,
		})
	},
})
```

## 官方插件示例

现有调用方展示了两种边界：

- [Wretch consumer](https://github.com/PluxelJS/pluxel/blob/main/plugins/wretch/tests/fixtures/wretch-example.ts) 将查询的 404 转为 `CustomerNotFound`，由另一个 Plugin 的 HTTP route 转为普通 JSON 与 404 响应；其他 HTTP、网络及生命周期错误保留原语义。
- [Auth credential preparation](https://github.com/PluxelJS/pluxel/blob/main/plugins/auth/src/credential-provisioning.ts) 在内部组合输入、账户与凭据校验，公开方法继续返回领域 DTO，Workbench 不接收 Result 实例。

## 跨进程与 RPC 边界

`Result` 实例主要用于同一进程内的强类型插件调用。当需要将结果传输给前端界面（Workbench）或外部 HTTP 请求时，应当在边界处将其转化为标准的数据结构（DTO）或标准的 HTTP 错误码响应，无需直接传输 Result 类原型。
