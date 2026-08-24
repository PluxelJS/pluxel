# Events

Core 提供两条语义不同的事件路径：

- `ctx.events` 是每 root 共享的 ambient bus，事件表通过 `@pluxel/core` module augmentation 扩展；每个 Context owner
  持有普通 service view，订阅绑定自己的 effects。
- `EvtChannel` 是 Plugin 公开属性上的具名 capability，适合 dependency edge 上的显式协议；consumer 订阅绑定 caller effects。

两条路径都不使用 Proxy 或动态 Context provider。ambient 类型增强不会建立 Plugin graph dependency；需要 provider ordering、
availability 或 replacement 传播时必须使用真实 Plugin dependency。事件名称确实由业务数据动态定义时，由所属 capability
自己建立局部 registry，不把任意运行时字符串加入 ambient bus。

Core commit、lifecycle diagnostics 和 route resolver invalidation 使用各自明确的 internal subscription；这些协议不进入
作者 event channel，也不通过开放字符串事件共享。
