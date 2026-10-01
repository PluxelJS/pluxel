# API

这份文档记录 Eventure 的公开接口。README 只保留快速上手和能力索引，具体签名和行为以这里为准。

## 事件类型

事件描述可以写成 tuple，也可以写成函数签名：

```ts
interface Events {
	message: [text: string]
	sum: (a: number, b: number) => number
}
```

tuple 适合无返回值事件；函数签名适合需要收集 listener 返回值的事件。

## Eventure

`Eventure<E>` 管理一组命名事件，所有方法都需要传事件名。

```ts
import { Eventure } from 'eventure'

const events = new Eventure<Events>()
```

### 构造参数

```ts
new Eventure<Events>({
	preallocateEvents: ['message'],
	captureRejections: true,
	captureReturnedPromises: false,
	errorPolicy: 'log',
})
```

- `preallocateEvents`：预先为事件名分配 listener 数组，适合固定事件集合。
- `captureRejections`：是否捕获 async listener 的 rejection，默认 `true`。
- `captureReturnedPromises`：是否检查非 async listener 返回的 Promise，默认 `false`，打开后注册侧会包裹更多 listener。
- `errorPolicy`：同步错误策略，取值为 `'silent'`、`'log'`、`'throw'`，默认 `'log'`。
- `logger`：自定义日志对象，需要符合导出的 `Logger` 类型。

### 注册和移除

```ts
const off = events.on('message', listener, { signal })
events.at('message', 'front').on(listener)
events.at('message', 2).once(listener)

events.off('message', listener)
events.clear('message')
events.clear()
```

- `on(event, listener, options?)`：尾部注册 listener，返回退订函数。
- `at(event, position)`：返回带位置的注册 scope，`position` 支持 `'front'`、`'back'`、数字和 `(ctx) => number`。
- `off(event, listener)`：移除一个 listener，返回是否真的移除。
- `clear(event?)`：清空指定事件；不传事件名时清空全部。
- 注册尾参统一称为 `options`，类型为 `SubscriptionOptions`，目前只承载 `signal` 这类订阅生命周期控制。
- 退订函数同时支持 `[Symbol.dispose]`，可配合 `using` 使用。

### 限次和条件监听

```ts
events.once('message', listener)
events.many('message', 3, listener)

events.when('message', (text) => text.startsWith('ok:')).once(listener)
events.at('message', 'front').when(Boolean).many(3, listener)
events.waitFor('message', { timeout: 1000, filter: Boolean })
```

- `once(event, listener, options?)`：命中一次后自动退订。
- `many(event, times, listener, options?)`：命中指定次数后自动退订，`times` 必须是正整数。
- `when(event, predicate)`：返回条件注册 scope，支持 `on`、`once`、`many`，也可以继续 `.at(...)` 组合。
- `waitFor(event, options?)`：返回带 `cancel()` 方法的 Promise，resolve 值是事件参数 tuple。
- `waitFor` 支持 `timeout`、`signal` 和 `filter`；`timeout` 必须是非负有限数，`filter` 抛错时会 reject 并清理监听器。

### 触发

```ts
events.emit('message', 'hello')

const values = await events.emitAll('sum', 1, 2)
const settled = await events.emitSettled('sum', 1, 2)
```

- `emit(event, ...args)`：同步触发所有 listener，返回触发数量。
- `emitAll(event, ...args)`：等待所有 listener 结果；listener throw 或 reject 时 reject。正常返回的 `Error` 对象会作为普通返回值保留。
- `emitSettled(event, ...args)`：始终 resolve，返回 `{ fn, status, value | reason }[]`。

`emit()` 读取触发开始时的监听器快照。listener 在触发过程中新增或移除，不会影响当前这次触发。

### 监听器上限

```ts
events.maxListeners = 20
events.maxListeners = 0 // 不限制
```

`maxListeners` 默认是 `10`。注册后超过上限时会通过 `logger.warn` 提示；设置为 `0` 或 `Infinity` 表示不限制。其他值必须是非负整数，否则会抛出 `RangeError`。

### 逐个消费

```ts
for (const record of events.fire('sum', 1, 2)) {
	if (record.type === 'error') break
}

for await (const record of events.fireAsync('sum', 1, 2)) {
	if (record.type === 'success') console.log(record.result)
}
```

- `fire(event, ...args)`：返回同步 generator，每次 yield 一个 listener 的执行结果。
- `fireAsync(event, ...args)`：返回 async generator，逐个等待 listener。
- 两者也支持显式 listener 快照：`fireFrom(listeners, ...args)` / `fireAsyncFrom(listeners, ...args)`。

`fire()` 的记录类型包括：

- `{ type: 'success', fn, result }`
- `{ type: 'error', fn, error }`
- `{ type: 'async', fn, promise }`

`fireAsync()` 的记录类型包括：

- `{ type: 'success', fn, result }`
- `{ type: 'error', fn, error }`

记录里的 `fn` 始终是用户注册时传入的原始 listener。
正常返回或 resolve 的 `Error` 对象是 `success` 结果；只有 throw/reject 会进入 `error` 结果。

### Waterfall

```ts
interface Pipeline {
	num: (value: number, next: (value: number) => number) => number
}

const pipeline = new Eventure<Pipeline>()
const result = pipeline.waterfall('num', 1)
```

`waterfall(event, ...args)` 让 listener 通过最后一个参数 `next` 串联执行。返回值形如 `{ ok, value }`：

- `ok: true`：所有 listener 都调用了 `next`。
- `ok: false`：某个 listener 没有调用 `next`，流水线被中断。

也可以在最后传入一个 inner callback，作为所有 listener 之后的收尾函数。
如果需要对指定 listener 快照执行流水线，使用 `waterfallFrom(listeners, ...args)`。

### 查询

```ts
events.count('message')
events.events()
events.listeners('message')
events.listenersUnsafe('message')
```

- `count(event)`：返回 listener 数量。
- `events()`：返回当前有 listener 的事件名。
- `listeners(event)`：返回 listener 数组副本。
- `listenersUnsafe(event)`：返回内部数组引用，零拷贝；不要 mutate。
- `queryListeners(event)`：`listenersUnsafe` 的兼容别名。

## EvtChannel

`EvtChannel<D>` 只管理一个事件，方法语义与 `Eventure` 基本相同，只是省略事件名。

```ts
import { EvtChannel } from 'eventure'

const channel = new EvtChannel<[text: string]>()

channel.on((text) => console.log(text))
channel.emit('hello')
```

常用方法：

- `on(listener, options?)`
- `at(position).on(listener, options?)`
- `off(listener)`
- `clear()`
- `emit(...args)`
- `emitAll(...args)`
- `emitSettled(...args)`
- `count()`
- `listeners()`
- `once(listener, options?)`
- `many(times, listener, options?)`
- `when(predicate)`
- `waitFor(options?)`
- `fire(...args)`
- `fireFrom(listeners, ...args)`
- `fireAsync(...args)`
- `fireAsyncFrom(listeners, ...args)`
- `waterfall(...args)`
- `waterfallFrom(listeners, ...args)`

`EvtChannel` 使用与 `Eventure` 相同的构造策略参数，但没有 `preallocateEvents` 预分配选项。
`maxListeners` 语义也相同：默认 `10`，`0` 或 `Infinity` 表示不限制。
