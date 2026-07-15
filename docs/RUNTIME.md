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

## Static application ownership

`@pluxel/runtime-static` 的公开源码入口是默认导出的 `defineStaticRuntime()` application：

```text
defineStaticRuntime entry
  ├─ name + fixed plugin constructors     build-time catalog
  ├─ configure(startup)                   bundled resolver, startup-time values
  └─ prepare({ host, startup })            host-owned startup policy
```

Vite 和 production freezer 必须加载同一个 entry。production bootstrap 由
`@pluxel/rolldown/build` 生成并内联 `runtime-static` production adapter；用户不维护第二个 server entry，部署端也不
解析 Pluxel packages。

fixed catalog 只限制可用插件代码集合，不移除运行时启停。ConfigService 与 RuntimeState 仍在每次启动时加载 plugin
config records、enabled state、dependency overrides 和 persistence state。`configure()` 的返回值同样在每次 host startup
重新解析，不是构建时序列化常量。

Workbench 有两个正交边界：build variant 决定 distribution 是否携带 shell/remotes，startup config 决定本次进程是否
安装 Workbench Plane。headless distribution 不能在启动时提升为 Workbench distribution。

Node adapter 拥有 listener、signal shutdown 和 deployment filesystem root。Node distribution 可以另外携带业务 SPA
`public/`：Workbench disabled 时它是 runtime 404 后的 HTML/static fallback，Workbench enabled 时根 navigation 仍由
Workbench shell 拥有。平台 adapter 不进入 `runtime-static` application definition。当前 production freezer 只支持
Node；Worker/Fetch target 必须等待 runtime services 具备真正 platform-neutral closure 后再开放。

## Logging

进程日志由 launcher-owned `RuntimeLogging` 统一安装。一个进程只有一个 active root；plugin identity 编码在
category，动态等级由 root-owned O(1) policy 控制。完整不变量、启动顺序和大插件基数预算见
[`LOGGING.md`](LOGGING.md)。
