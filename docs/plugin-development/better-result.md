---
title: better-result 共享入口
description: 掌握 Better Result 在本地插件方法、Command 指令与多步可恢复操作中的使用规范。
---

在 TypeScript 开发中，对于预期内可能发生并需要调用方分支处理的业务失败（例如资源不存在、额度不足、权限不匹配等），使用 `Result<T, E>` 类型通常比直接抛出异常更具类型安全性。

Pluxel 核心在 `@pluxel/core/better-result` 子路径下直接导出了 [Better Result](https://better-result.dev/) 的完整运行时 API 与类型，供插件直接使用。

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
		const validated = yield* validateInput(input)

		// 检查重复账号
		yield* ensureNotRegistered(validated.email)

		// 创建数据库记录
		const account = yield* createDbRecord(validated)

		return account
	})
}
```

在生成器内部，`yield*` 会自动解包 `Result.ok` 的值；若某一步返回 `Result.err`，整个流程将提前短路并返回该错误。

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

在官方插件包中，Better Result 主要应用于复杂的业务交互场景：

- **`@pluxel/plugin-wretch`**：HTTP 请求在遇到特定状态码（如 404 或 429）时，将状态码映射为类型化的请求错误；
- **`@pluxel/plugin-redis`**：分布式锁获取失败或 Lua 脚本返回业务拒绝时，返回明确的 Result；
- **`@pluxel/plugin-invoice`**：发票识别与验真流程中，区分 OCR 识别错误、票面金额不一致与税务局接口超时的不同失败分支。

## 跨进程与 RPC 边界

`Result` 实例主要用于同一进程内的强类型插件调用。当需要将结果传输给前端界面（Workbench）或外部 HTTP 请求时，应当在边界处将其转化为标准的数据结构（DTO）或标准的 HTTP 错误码响应，无需直接传输 Result 类原型。
