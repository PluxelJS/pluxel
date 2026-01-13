# EffectScopeService（Core）设计说明

## 目标

`EffectScopeService` 负责把“资源清理/订阅取消”绑定到插件生命周期：

- 插件内注册的清理函数进入 `disposables`
- 插件卸载/重启时统一 `disposeAll()`
- 插件主动关闭：`ctx.shutdown()`

## 关键语义

- `collectEffect(fn)` 返回取消函数（从 set 里移除）
- `disposeAll()` 使用 swap-set：
  - 本轮只处理调用前已注册的 effect
  - dispose 过程中新增的 effect 留给下一轮，避免误清理
- `shutdown()` 只允许在插件 Context 中调用；它会触发对当前插件（及依赖链）的卸载

## 测试策略

用 `withTestHost()`：

- 插件里 `collectEffect()` 注册标记函数
- 卸载插件后断言清理函数被调用、事件订阅被取消等（EventsService 也依赖这个机制）

