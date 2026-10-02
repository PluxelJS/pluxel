---
title: 生命周期与资源清理
description: 使用 Core 自带的 effects 管理初始化、失败回滚、停止与后台任务。
---

`ctx.effects` 随 Context 提供，不需要安装 Host 服务。插件声明“资源由谁持有、什么时候释放”，框架按依赖顺序启动，并在失败、停止或替换时清理。

新增连接/订阅先读[资源边界](#generation-是资源所有权边界)；选择 cleanup API 看[effects](#选择-effects-primitive)；排查失败看[init 职责](#init-的职责)与[失败范围](#调用失败和生命周期失败)。

## Generation 是资源所有权边界

一次插件运行称为一个 generation，表示这一次运行中的实例和资源。停止、重启、热替换或可选依赖变化都会结束旧的一次运行。

创建资源后立即登记清理。这样后续初始化失败或插件停止时，框架仍能释放已创建的部分：

```ts no-twoslash
protected override async init(signal: AbortSignal) {
	const client = createClient(this.config)
	this.ctx.effects.defer(() => client.close(), { tag: 'client' })

	await client.connect({ signal })
}
```

### 选择 effects primitive

| 需求                           | API                                 |
| ------------------------------ | ----------------------------------- |
| 登记一个 cleanup function      | `effects.defer(cleanup)`            |
| 持有带 `dispose()` 的对象      | `effects.own(disposable)`           |
| 成对 acquire/release           | `effects.acquire(acquire, release)` |
| 给简单 helper 单独建立子作用域 | `effects.scope(meta)`               |
| 自动派生 Context/config/scope  | `this.parts.use(CachePart)`         |
| 一组登记要么全部提交、要么回滚 | `effects.transaction()`             |

```ts no-twoslash
protected override init() {
	const scope = this.ctx.effects.scope({ tag: 'sync-loop' })
	const loop = new SyncLoop(this.ctx.logger.with({ component: 'sync-loop' }))
	scope.own(loop)
	loop.start()
}
```

`effects.transaction(async tx => ...)` 只回滚本事务登记的资源。事务中通过 `tx` 登记并 await acquire；嵌套使用 `tx.transaction()`，同级并发会拒绝。callback 结束后 tx 不再可用；`tx.dispose()` 只撤回本事务，不关闭父 scope。未等待的 acquire 若晚到，会释放资源并 reject；父 scope 的 dispose 不代表这些未登记 Promise 已退出。

cleanup 必须幂等，并在 Promise resolve 前真正停止底层工作。只调用 `abort()` 却不等待 worker、watcher 或 queue consumer 退出，会让旧 generation 与新 generation 重叠。

## `init()` 的职责

校验必要上游与凭据，注册能力，启动长期资源。无法提供能力时直接抛错，不捕获后只写日志继续运行。
`init()` 可以返回 cleanup/disposable；有多步资源获取时，在每次获取成功后立即登记，确保部分初始化失败也能清理。

## 调用失败和生命周期失败

两者影响范围不同：

- 插件无法提供能力：让 `init()` 失败，或由宿主执行 restart/replacement；
- 单个 HTTP/command 调用参数错误或上游超时：返回请求级错误，不改变 Plugin 状态；
- timer、watcher、queue consumer 的单次失败：记录结构化错误，按领域规则重试、暂停或触发明确 shutdown。

后台循环需要同时处理“停止调度”和“等待在途任务退出”。`clearInterval()` 只阻止后续 tick，不能取消或等待已经开始的异步调用；会重叠的任务应明确并发策略，清理时发出取消信号并等待任务结束。具体组合见[异步任务契约](./async.md#实现前确定任务契约)。

事件订阅已有 owner cleanup，见[事件](./events.md)。只有需要 Context、局部配置和作用域时才拆 [Part](./parts.md)；普通 helper 不必成为 Part。

验证初始化中途失败和正常停止两条路径，确认已获取资源释放、后台工作真正退出。具体测试接线见[隔离测试](./testing.md)。
