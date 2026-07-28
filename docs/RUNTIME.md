# Runtime Architecture

`@pluxel/runtime` 在 core 之上提供 HTTP、config、persistence、runtime state 和可选 Workbench
Plane。主入口注册全部常驻服务；Vault 只由 `@pluxel/runtime/services/vault` 显式启用，Workbench由宿主
launcher 显式安装。

## Commands capability

runtime 提供 owner-bound `ctx.commands` 和每个 root 唯一的 command registry。插件注册直接进入该 registry，
同时把 disposer 登记到插件自己的 effects；stop、replacement、启动回滚与 shutdown 因此使用同一套资源回收语义。
registry 的 lookup 和 revision-cached catalog 仍由 `@pluxel/commands` 实现，runtime 不维护第二份索引。

runtime registration 会用插件 Context 对执行入口做 owner binding。插件 generation 离开 running 时，core 先关闭
该 owner 的内部 invocation gate：拒绝新调用、abort 已接纳调用的 call/owner 合成 signal，并等待 lease 释放；之后才
进入插件 `stop()` 和 effects drain。这个 gate 按首次执行惰性创建，不是插件 API 或新的 lifecycle hook。单独调用
registration disposer 只撤销 catalog publication，不会取消已经开始的调用。

基础 `plugin.list`、`plugin.status.get`、`plugin.start`、`plugin.stop`、`plugin.restart` 由 root Commands
服务固定提供。查询委托 `pluginsList` / `pluginStatus`，mutation 委托 `applyStatusActions`，生命周期与一次 commit
规则仍只有 runtime use case 一个事实源。CLI、Agent、HTTP 和 Workbench 是宿主 carrier；它们负责授权、确认、过滤与
principal 映射，不拥有 command 定义或插件生命周期。

宿主需要常规 CLI 时可用 `createCommandArgv(ctx.root.commands)` 惰性投影当前 catalog；插件无需逐项 `bind()`。
该默认投影使用精确 command name、生成的标量 options 与 field-level JSON。`@pluxel/cli` 本身是工作区构建/开发工具，
不持有运行中的 runtime；进程接入、授权、确认、输出与退出码仍由安装 carrier 的宿主负责。

`PersistenceService.preflight()` 先统一校验 backend 声明的 durable/readonly capability，再调用 backend 可选的
preflight hook 做写入探针等实现检查。custom backend 即使省略 hook，也不能让不满足的 durable/writable 要求静默成功。

## Database capability

`DatabaseService` 是每个 plugin Context 隔离的 owner view，底层 coordinator 按 root lazy 创建。它统一管理 PGlite/PG、
fair admission、immutable database instance registry、lineage promotion、physical schema/role、migration、operation timeout 和
transactional outbox；Workbench 只是可选消费者。
完整约束见 [`DATABASE.md`](DATABASE.md)。

## Optional plugin availability

`OptionalPluginAvailabilityService` 是 root-scoped 常驻协调器。它在 consumer commit 后解析 opaque
`OptionalPluginRef`，去重相同 ref 的 loader，串行提交正常 graph update，并把实例发布交给 core running watcher。
服务不复制 lifecycle 或 availability read model；失败进入结构化日志，synthetic runtime module 以 canonical plugin ID
管理 replacement ownership，并随正常 root graph 一起释放。

工具链为独立插件包标注 direct optional package：目标 package 本身缺失记录为 debug-level absent；目标存在但 transitive
dependency、evaluation、metadata 或 start 失败记录为 broken error。static/Vite absent virtual module 携带同一 package fact，
不会把真实 provider 故障静默当成缺包。

首次发现的 candidate 写入 RuntimeState `optionalKnown` 并默认启用；之后显式 disable 不会被 descriptor 请求覆盖。
dynamic package install/invalidation 会触发 availability retry。resolver 只解析已经进入 workspace、安装集合或 static
distribution closure 的代码，optional request 不授权自动安装包。

## Node module service

`NodeModuleService` 是常驻 root service，`ctx.nodeModules` 是保留 owner Context 的隔离视图。作者只通过
`ctx.nodeModules.use(declaration, setup)` 使用 module；service 不暴露任意路径 compiler、revision、lease handle
或 worker facade。

开发 route 安装一个 lazy source provider；无 declaration 时不创建 compiler、watcher 或 cache。没有 source provider
时，service 只接受 toolchain lowering 后带 stable artifact key 的 declaration，并从 plugin package
`dist/artifacts/node/` 或 deployment `artifacts/node/` 解析。缺失 artifact 会使 `use()` 失败，不回退 inline execution。

每个 consumer 串行 staged setup：新 setup 成功后才清理上一消费者；rebuild/setup 失败保留 last-known-good。
owner stop/replacement 使 pending generation 失效，迟到 setup 返回的 cleanup 会立即执行。

Workbench backend 由以下部分组成：

- `WorkbenchService`：每个 plugin Context 隔离的 optional gate；
- `WorkbenchRegistry`：module、关系、target layout、opaque grant 和统一 revision；
- `WorkbenchArtifactService`：dev/package artifact 与 build state；
- resource services：request-scoped API、live-query snapshot/patch、stream；
- HTTP：catalog、global layout、plugin layout、artifact、resource 和 revision event。

资源 namespace 只存在于服务端。浏览器收到 binding token，服务端在请求时解析 token、校验 kind，并在
revision 变化时撤销 grant。Workbench API 不暴露全局资源字典。

安装入口是 `@pluxel/runtime/internal`，只供 static、dynamic 和 production static launcher 使用。插件不得
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

static build 可解析的 optional candidate 进入固定 code-split closure；不可解析 candidate 被 lowering 成明确 absent
module，产物不留下目标 external import。目标机安装新包不能改变该 closure。

Workbench 有两个正交边界：build variant 决定 distribution 是否携带 shell/remotes，startup config 决定本次进程是否
安装 Workbench Plane。headless distribution 不能在启动时提升为 Workbench distribution。

Node adapter 拥有 listener、signal shutdown 和 deployment filesystem root。它把客户端中止请求或提前关闭响应传播到
Fetch `Request.signal`，并取消尚未完成的 Web response body；长请求和流式 handler 可以据此及时释放 owner resource。
Node distribution 可以另外携带业务 SPA
`public/`：Workbench disabled 时它是 runtime 404 后的 HTML/static fallback，Workbench enabled 时根 navigation 仍由
Workbench shell 拥有。平台 adapter 不进入 `runtime-static` application definition。当前 production freezer 只支持
Node；Worker/Fetch target 必须等待 runtime services 具备真正 platform-neutral closure 后再开放。

## Logging

进程日志由 launcher-owned `RuntimeLogging` 统一安装。一个进程只有一个 active root；plugin identity 编码在
category，动态等级由 root-owned O(1) policy 控制。完整不变量、启动顺序和大插件基数预算见
[`LOGGING.md`](LOGGING.md)。
