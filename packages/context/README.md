# @pluxel/context

> Status: internal/private. `@pluxel/context` 会被 `@pluxel/core` 内联打包，外部用户不应直接依赖/导入它；请从 `@pluxel/core` 或 `@pluxel/runtime` 使用 `Context`。

`Context` 是一个轻量的 service registry：服务通过 `Context.registerService()` 注册后，会以 getter 的形式挂到 `Context.prototype` 上（惰性实例化）。

## 关键语义：共享实例 + ctx 回灌

默认情况下，同一个 `root` 下的 `Context` 共享同一份 service 实例缓存。为了让同一实例能在不同 `Context` 上工作，每次访问 `ctx.someService` 时都会把该实例的 `inst.ctx` “回灌”为当前 `ctx`。

这带来一个重要约束：

- **不要长期保存 service 实例或方法引用并在之后（尤其是 `await` 之后）再使用**，否则你可能读到“被别的 Context 回灌后的 ctx”。

## 推荐写法（让下游自己正确处理）

### 1) 在 service 方法里先快照 ctx

```ts
class MyService {
	constructor(public ctx: Context) {}

	async doWork() {
		const ctx = this.ctx // snapshot
		await something()
		ctx.logger.info('...') // use snapshot, not this.ctx
	}
}
```

### 2) 业务侧避免缓存 `ctx.service` / `ctx.service.method`

```ts
// ❌ 不建议
const log = ctx.logger.info
await something()
log('...') // 可能对应别的 ctx

// ✅ 建议：即时访问 / 显式传参
await something()
ctx.logger.info('...')
```

### 3) 需要独立实例时用 isolate()

如果某个服务确实需要在某个子树里拥有独立实例（避免与其它 Context 共享），可以用：

```ts
// ✅ 推荐：按 ctor（更严格；能更早暴露 HMR/重复加载导致的 ctor 身份不一致）
const child = ctx.isolate([SomeService], { name: 'child' })

// ✅ 可选：按 service key（更方便；但可能“看不出你导入的是哪份 ctor”）
const child2 = ctx.isolateKeys(['someService'], { name: 'child2' })
```

`isolate()` 创建的是一个新的“实例空间”，并且**对该 Context 的 `extend()` 后代同样生效**（除非后代再次对同一服务调用 `isolate()` 生成新的实例空间）。

注意：`isolate()` 解决的是“实例隔离”，不是“跨 await 自动绑定 ctx”。异步场景仍建议按上面的方式做 ctx 快照。
另外：root scope 服务（通过 `ctx.root.<key>` 访问）不允许 isolate；它们永远绑定 root ctx。

## Service key（属性名）注意事项

服务的访问名（`ServiceClass.key` 或类名去掉 `Service` 后缀）会被定义到 `Context.prototype` 上，因此：

- 不要使用会与 `Context` 内建字段/方法冲突的 key（例如：`extend`、`isolate`、`name`、`config`、`parent`、`root` 等）。
- 不要使用危险/特殊 key（例如：`__proto__`、`prototype`、`constructor`）。

实现上，`registerService()` 会在注册阶段拒绝与 `Context.prototype` 冲突的 key，以避免把核心方法“覆盖掉”造成难排查问题。

## Root services（root scope）

如果某个服务天然应该“只绑定 root ctx”（例如：HMR runtime、文件系统、全局缓存），推荐把它声明为 root service：

- 装饰器：用 `@RootService()`（或 `@Injectable({ scope: "root" })`）
- 类型层：把它放到 `Context.RootServices`，并通过 `ctx.root.<key>` 访问

这样可以在类型上避免误用（例如把 root service 当作普通 service 存在 `ctx.<key>` 上），并且表达上更清晰：你在显式使用“root 级别的能力”。

## mapping（内部实现细节）

`Context.mapping` 是内部的“实例空间映射”（serviceKey → instKey），用于 `isolate()`。`extend()` 不会创建新的 mapping：它会复用父 Context 的 mapping，以减少对象分配和原型链深度。

因此，下游不应读取/修改 `mapping`；把它当作内部实现细节即可。

## 重复 key

重复 key 直接抛错是预期行为；如果要替换实现，使用 `Context.overrideService()`。

### override 的生效时机

`overrideService()` 会替换 `Context.prototype` 上的 getter（后续实例化会使用新 ctor），但**不会自动“热替换”已经创建并缓存的旧实例**。

如果某个服务实例已经被访问/创建过：

- 后续在同一个 `root` 下再次访问，仍可能拿到旧实例（因为缓存命中）。
- 想强制使用新实现：推荐在 override 发生前完成（启动期），或通过 `isolate()` 进入新实例空间，或重启进程。
