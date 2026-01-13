# EventsService（Core）设计说明

## 目标

`EventsService` 提供一个事件总线（Eventure）并把它无缝挂到 `Context` 上：

- `ctx.on / ctx.onFront / ctx.emit / ctx.emitWithContext`
- 监听器的生命周期自动绑定到插件作用域（EffectScope），避免泄漏

## 关键语义

- 注册监听器时会把当前 `ctx` 写入 `listener[symbols.ATTACH]`，用于后续 `emitWithContext` 的过滤。
- `ctx.on*()` 返回的 `unsubscribe` 会被自动 `collectEffect()`，插件卸载时会被清理。
- `emitWithContext(thisArg, event, ...)` 支持通过 `thisArg[symbols.FILTER]` 对“被 attach 的 ctx”做过滤。

## 典型用法

- Core 生命周期：`afterCommit / afterStart / startError ...`
- 插件间松耦合通信：避免直接依赖（但要注意事件命名的稳定性）

## 测试策略

用 `withTestHost()`：

- 在插件 `onStart`（或构造后）注册监听器
- `host.unregister(Plugin)` + `commit()` 后确保监听器不会再收到事件

