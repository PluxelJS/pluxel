---
title: 生命周期与资源清理
description: 使用 Context 的 effects 机制管理插件初始化、后台任务与确定性资源回收。
---

在长时间运行的宿主进程中，插件会经历启动、运行、配置更新、热重载与停止等不同阶段。Pluxel 提供了开箱即用的生命周期与副作用（Effects）管理机制，让插件作者能够轻松登记需要在插件退出时释放的资源。

## 生命周期各阶段

一个插件实例从诞生到销毁经历以下过程：

```text
实例化（Constructor 依赖注入）
       │
       ▼
配置注入与校验（this.configs.use）
       │
       ▼
初始化钩子（protected override init）
       │
       ▼
稳定运行阶段（对外提供业务方法与监听）
       │
       ▼
生命周期结束（触发 effects.defer 清理回调）
```

- **构造阶段（Constructor）**：由框架注入必需依赖的实例。
- **配置阶段**：读取校验后的配置快照。
- **初始化（`init`）**：建立外部网络连接、启动定时器、订阅事件、注册 HTTP 路由。
- **销毁阶段**：插件停止、热替换或启动中途失败时，框架会严格逆序触发已登记的清理回调。

## 副作用管理（Effects）

在 `init()` 阶段创建长期持有的外部资源时，应当就近注册对应的释放函数。

```ts no-twoslash
protected override async init(signal: AbortSignal) {
	const client = createDatabaseClient(this.config)

	// 1. 建立资源后立即登记清理
	this.ctx.effects.defer(() => client.close(), { tag: 'database-client' })

	// 2. 执行异步连接（支持 AbortSignal 取消）
	await client.connect({ signal })
}
```

### 常用清理原语

| API                                 | 用途                                                | 示例                                                     |
| ----------------------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| `effects.defer(fn)`                 | 登记一个清理函数                                    | `this.ctx.effects.defer(() => clearInterval(timer))`     |
| `effects.own(disposable)`           | 托管实现了 `[Symbol.dispose]` 或 `dispose()` 的对象 | `this.ctx.effects.own(fileWatcher)`                      |
| `effects.acquire(acquire, release)` | 声明配对的资源获取与释放逻辑                        | `this.ctx.effects.acquire(() => lock(), () => unlock())` |
| `effects.scope(meta)`               | 为辅助子逻辑创建独立的子作用域                      | 创建拥有局部清理范围的独立作用域                         |

### 支持直接返回清理函数

如果 `init()` 只初始化单一资源，也可以直接返回清理函数：

```ts no-twoslash
protected override init() {
	const timer = setInterval(() => this.heartbeat(), 10_000)
	return () => clearInterval(timer)
}
```

## 异步后台任务与优雅停止

对于后台长循环（如消息队列消费、定时轮询等），优雅退出通常需要完成两件事：

1. **停止派发新任务**：清除定时器或设置退出标志位；
2. **等待在途任务完成**：等待正在执行的异步操作结束，避免新旧实例在交替时产生数据并发冲突。

```ts no-twoslash
protected override async init(signal: AbortSignal) {
	let running = true
	const workerPromise = (async () => {
		while (running && !signal.aborted) {
			await this.processNextJob()
		}
	})()

	this.ctx.effects.defer(async () => {
		running = false
		await workerPromise // 等待当前处理中的批次退出
	}, { tag: 'queue-worker' })
}
```

## 局部失败与回滚

当插件在 `init()` 中需要依次初始化多项资源时（例如先创建临时目录，再建立数据库连接），即使后续步骤抛出异常，**前面已经通过 `effects.defer()` 登记的资源仍然会由框架自动执行清理**。这样可以确保失败的启动尝试不会在系统中留下悬挂的句柄或未关闭的连接。
