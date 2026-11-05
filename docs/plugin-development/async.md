---
title: Async 异步组合工具
description: 轻量、零运行时依赖的并发控制、请求合并（Singleflight）与异步流式工具包。
---

在构建后台任务与高并发接口时，常常需要精细控制异步流程。`@pluxel/async` 是一个独立的现代化 TypeScript 异步工具包，无需依赖 Pluxel 框架内核，即可在任意 Node.js 服务、脚本或第三方库中直接使用。

## 工具能力一览

| 工具模块                   | 核心能力         | 典型应用场景                                                   |
| -------------------------- | ---------------- | -------------------------------------------------------------- |
| **`singleflight`**         | 请求并发合并     | 多处同时读取相同缓存或接口时，只执行一次真实查询，共享返回结果 |
| **`limit` / `keyedLimit`** | 并发度限制       | 限制对外部接口的最大同时连接数，或按业务 ID 实现分片串行排队   |
| **`iter`**                 | 流式数据管道     | 支持带窗口缓冲、批量聚合（Batch）的 AsyncIterable 处理管道     |
| **`retry`**                | 指数退避重试     | 网络瞬态波动时自动按步长或抖动重试，支持 AbortSignal 取消      |
| **`wait`**                 | 可取消等待与轮询 | 优雅实现延时等待、条件轮询与信号超时监听                       |
| **`grfn`**                 | 有向无环图执行器 | 将多个包含先后依赖的异步任务编译为高性能并发执行流             |

## 实现前确定任务契约

在涉及并发控制与重试逻辑时，建议在编码前梳理以下机制：

1. **生命周期归属**：明确任务是随单次 HTTP 请求结束，还是作为插件全局长期运行的后台任务。长期任务应当支持传入 `AbortSignal` 并在插件卸载时及时退出。
2. **取消与资源释放**：取消操作是仅让调用方提前放弃等待，还是需要向底层网络连接发送中断信号；并发槽位应当在真实 IO 结束后归还。
3. **幂等性与重试范围**：只对具备幂等性的读取或安全操作配置自动重试，避免对包含资金变更或不可逆副作用的操作盲目重放。

## 典型示例：请求合并（Singleflight）

当多个请求并发访问同一项资源时，`singleflight` 能有效防止缓存击穿：

```ts no-twoslash
import { singleflight } from '@pluxel/async/singleflight'

const sf = singleflight()

async function getArticle(id: string) {
	// 若同一文章正在拉取中，后续调用会直接等待已有 Promise 完成并共享其结果
	return sf.do(id, async () => {
		return fetchRemoteArticle(id)
	})
}
```

## 与第三方生态结合

`@pluxel/async` 聚焦于纯函数式的并发控制与在途合并。如果你的业务需要更复杂的时间窗口限流（Rate Limiting）、优先级队列或防抖节流，可以将其与 [TanStack Pacer](https://github.com/TanStack/pacer) 配合使用。

## 安装与文档

```sh
npm install @pluxel/async
```

更多高级参数与组合模式，可查阅包内的详细使用指南：

- [完整 API 与取消机制](https://github.com/PluxelJS/pluxel/blob/main/packages/async/docs/guide.md)
- [常用异步组合模式与配方](https://github.com/PluxelJS/pluxel/blob/main/packages/async/docs/recipes.md)
