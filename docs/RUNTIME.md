# Runtime Architecture

`@pluxel/runtime` 在 core 之上提供 HTTP、config、persistence、runtime state、Vault 和可选 Workbench
Plane。业务路由是常驻能力；Workbench由宿主 launcher 显式安装。

Workbench backend 由以下部分组成：

- `WorkbenchService`：每个 plugin Context 隔离的 optional gate；
- `WorkbenchRegistry`：module、关系、target layout、opaque grant 和统一 revision；
- `WorkbenchArtifactService`：dev/package artifact 与 build state；
- resource services：request-scoped API、collection sync、stream；
- HTTP：catalog、global layout、plugin layout、artifact、resource 和 revision event。

资源 namespace 只存在于服务端。浏览器收到 binding token，服务端在请求时解析 token、校验 kind，并在
revision 变化时撤销 grant。Workbench API 不暴露全局资源字典。

安装入口是 `@pluxel/runtime/internal`，只供 static/dynamic/frozen launcher 使用。插件不得
直接安装或 require backend。

## Logging

进程日志由 launcher-owned `RuntimeLogging` 统一安装。一个进程只有一个 active root；plugin identity 编码在
category，动态等级由 root-owned O(1) policy 控制。完整不变量、启动顺序和大插件基数预算见
[`LOGGING.md`](LOGGING.md)。
