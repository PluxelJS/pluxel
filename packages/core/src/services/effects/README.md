# EffectsService（Core）设计说明

`effects` 服务负责在 **单个 Context 内**管理副作用/资源生命周期：

- 注册 cleanup / Disposable
- 支持事务回滚（init 失败自动释放已登记资源）
- 插件卸载时统一 `dispose()`（drain：清理过程中新增条目也会被清理）
- 等待显式登记的异步 cleanup，直到资源确实释放完成

## 最小原语

- `ctx.effects.defer(cleanup, meta?) -> Guard`
  - 登记一个 cleanup（函数可返回 Promise）
- `ctx.effects.own(disposable, meta?) -> Guard`
  - 登记一个 `dispose()` 资源对象（可返回 Promise）
- `await ctx.effects.acquire(acquire, release, meta?) -> T`
  - 获取资源并自动登记 release；若登记失败会 best-effort 立刻 release 后 rethrow

## 结构化能力

- `ctx.effects.scope(meta?) -> EffectsScope`
  - 创建子作用域（默认自动被父作用域纳管）
- `await ctx.effects.transaction(async (tx) => ...)`
  - 事务：成功 commit=no-op；失败 rollback（checkpoint unwind）

## 托管异步工作

EffectsService 不发布全局 lifetime signal。后台任务应返回一个拥有完整停止语义的 handle，其 `dispose()` 负责
停止接单、取消底层工作并等待退出：

```ts
const worker = startWorker()
ctx.effects.own(worker, { tag: 'worker' })
```

如果现有对象使用 `cancel()`，直接登记可等待 cleanup：

```ts
ctx.effects.defer(() => task.cancel(), { tag: 'task' })
```

底层 API 只有 `AbortSignal` 时，由资源实现持有局部 `AbortController`，在自己的 `dispose()` 中 `abort()` 后等待
task。不要只把 signal 往下传却不登记 task；那只能通知取消，不能让 effects drain 它。request、command 和
timeout signal 仍属于各自调用边界，不属于 EffectsService。

## Guard

Guard 是唯一关键句柄：

- `await guard.dispose()`：立即执行并注销（at-most-once）
- `guard.cancel()`：只注销不执行

> 详细语义与实现 checklist：`packages/core/src/services/effects/DESIGN.md`。
