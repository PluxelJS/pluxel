# Events

Core 只提供具名 `EvtChannel` primitive，不向 Context 安装 global event facade。

Plugin 的固定公开事件集合以 typed `EvtChannel` 属性表达。订阅绑定 caller Context effects；producer 可按协议选择普通 emit
或隔离 listener failure 的 settled emit。事件名称确实由业务数据动态定义时，由该 capability 自己建立局部 registry。

Core commit、lifecycle diagnostics 和 route resolver invalidation 使用各自明确的 internal subscription；这些协议不进入
作者 event channel，也不通过开放字符串事件共享。
