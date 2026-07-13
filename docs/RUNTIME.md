# Runtime Architecture

`@pluxel/runtime` 在 core 之上提供 HTTP、config、persistence、runtime state、Vault 和可选 Management
Plane。业务路由是常驻能力；管理面由宿主 launcher 显式安装。

Management backend 由以下部分组成：

- `ManagementService`：每个 plugin Context 隔离的 optional gate；
- `ManagementRegistry`：module、关系、target layout、opaque grant 和统一 revision；
- `ManagementArtifactService`：dev/package artifact 与 build state；
- resource services：request-scoped API、collection sync、stream；
- HTTP：catalog、global layout、plugin layout、artifact、resource 和 revision event。

资源 namespace 只存在于服务端。浏览器收到 binding token，服务端在请求时解析 token、校验 kind，并在
revision 变化时撤销 grant。Management API 不暴露全局资源字典。

安装入口是 `@pluxel/runtime/services/management`，只供 static/dynamic/frozen launcher 使用。插件不得
直接安装或 require backend。
