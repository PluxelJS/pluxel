# Host 与服务架构

## 唯一职责分层

| 层                                          | 所有权                                                                | 不承担                            |
| ------------------------------------------- | --------------------------------------------------------------------- | --------------------------------- |
| Context                                     | 同步、不可变的能力 shape 与 root/scope/owner-view 解析                | IO、异步 prepare、插件图          |
| Core                                        | 插件 metadata、依赖图、generation、logger/events/effects/config facts | 网络、数据库、开发工具、部署策略  |
| Host                                        | catalog、运行策略、服务准备关闭、应用启动与配置存储                   | 默认服务选择、物理 listener、Vite |
| Host-dev                                    | Vite ModuleRunner、候选更新队列、开发附件、控制台 execution           | 官方服务选择、第二套插件生命周期  |
| Host-dynamic                                | 声明范围内的入口发现与 watcher                                        | 包安装、独立 committed catalog    |
| Services / Logging / Management / Workbench | 对应领域的能力、资源和适配                                            | 修改 Core 图所有权                |

应用只有 `HostApplication` 一个声明模型。官方默认值归 `servicesPreset()`、`vitePreset()`、`buildPreset()`；这些函数返回普通服务或工具插件，不能拥有第二套 Host。

## 服务与资源

`createHost({ plugins, services })` 在 root 创建前验证固定安装计划。服务用 `requires` 声明准备依赖；同步 capability factory 保持惰性，异步资源在 `prepare({ ctx, dependencies, effects })` 获取。
每项服务的 effects scope 随服务准备失败或 Host 关闭释放。Plugin generation 的 effects 随该代停止释放，两者都使用 Core effects 契约，但 owner 与生命周期必须在调用位置清楚可见。
关闭先停止接纳、排空协调操作和插件，再按依赖逆序释放服务；清理失败聚合，不能跳过其余清理。

能力 token 的 access 表达调用 Context 的所有权：`all` 通用，`owner` 需要真实插件/Part owner，`root` 需要真实 RootContext。宿主代码使用 `ctx.require(Token)`，缺失、访问越界和构造失败保留各自错误。
`ctx.root` 返回真实根引用，持有它的受信任代码可访问 root 能力；这不是不可信代码沙箱。Core 内部图 authority 的 token 不进入普通作者入口。

`standardServices()` 安装 HTTP、Commands、Node artifacts、Workers、Persistence。`servicesPreset()` 增加 Vault、Logging、Management、管理命令及可选 Workbench。Database 显式选择 backend。
未选择服务不创建对应 backend、watcher、编译器、route 或状态。关闭 Workbench 不关闭业务服务或管理 HTTP/WebSocket 接入；preset 始终显式安装 `managementHttp()`。

## 应用、开发和部署

应用静态声明 `plugins`、`sources`，每次启动执行 `configure(startup)` 取得 services/config/state/configRecords；`prepare` 在服务与开发附件准备好后、插件启动前执行。
Host 不改变进程 cwd。入口与来源锚定 startup root，环境通过 startup 显式传递。`PLUXEL_CONFIG` 与 schema 环境绑定只生成启动 seed，持久文档继续拥有配置 authority。

Vite、生产 launcher 共用 Host 应用解析。普通插件变化提交 catalog；配置/服务变化替换 Host。替换失败可用最后成功声明创建 fresh Host 补偿，但不能复活旧 generation。
Host-dev 是唯一开发驱动；官方服务附件分别由 Services、Workbench 拥有。数据库 lowering 属于官方 Vite preset 的工具插件，不是运行时服务。
生产 bootstrap 调用 `runHostApplication`；Fetch handler 和 Node listener 属于 HTTP 服务。构建资源 variant 不替应用安装服务。

## 控制台 execution

一次显式提交创建一个 Dev console execution。它通过 Vite 加载普通导出函数，借用当前 Host 和 RootContext，不注册 Plugin definition、不进入依赖图，HMR 不自动重放操作。
`defineDevConsole(dev => ...)` 自动推导类型，dev 带 input/id/signal、插件与配置操作和更新查询。跨进程 input 保持 unknown。
控制台没有 effects 资源 API；脚本自己创建的资源使用 using/await using 或 try/finally。取消是协作式，已经提交的写入不回滚；已接纳 Host 操作排空后才能释放旧 root。
详见 [DEV_CONSOLE.md](DEV_CONSOLE.md)。

## HTTP 与管理页面

`Http` 是 Plugin generation 所有的真实 Elysia application，Plugin 与 Parts 共享同一 app。init 成功后 Host HTTP lifecycle 完成 finalize、settle、prepare、publish，原子交换完整 directory。初始化失败不发布半成品路由。
`HttpServer` 是 root-only 分发和 carrier 接入，不属于 Plugin owner。物理 listener 由 Node launcher 或 Vite 持有；generation 停止不能关闭共享 listener。
请求、stream 和 WebSocket 持有 generation lease；停止先拒绝新操作，排空已接纳操作后再清理。跨 owner route collision 只检查已证明的精确 route inventory，不模拟 Elysia matcher grammar。

Management 安装认证、状态投影和 RPC session；Workbench 安装内容/publication、页面和交互能力。它们共享 Host coordinator，不保存第二份插件运行状态。业务 HTTP 不自动继承 Management 认证。`managementHttp()` 唯一持有管理 endpoint；`workbenchHttp()` 只拥有 Shell fallback。preset 通过既有 bindings 组合 Workbench session/artifact handler，并用 `requires: { workbench: WorkbenchHost }` 声明准备顺序。
`managementCommands()` 把插件查询和 lifecycle 命令发布到显式安装的 Commands catalog；它是独立接入，不能让通用 Commands 服务隐式安装管理面。

## 资源边界与验证入口

- Host plan、prepare rollback、关闭顺序：`packages/host/src/services.ts`、`host.ts`，对应 services/host/application 测试。
- 配置与运行策略存储：Host `config-store.ts`、`state-store.ts`。持久化服务只提供借用的 document storage，不拥有运行事实。
- 动态 catalog、failed candidate 和 committed authority：Host `source-session.ts`、`coordinator.ts`，Host-dev `host-vite.ts`。细节见 [HMR](HMR.md)。
- HTTP owner lease、stream、WS 与 carrier：[HTTP 用法](../docs/runtime/http.md)、`packages/services/src/http/`。
- 数据库的 generation handle、迁移和 backend：[DATABASE.md](DATABASE.md)。
- 日志 root、策略与有界 store：[LOGGING.md](LOGGING.md)。
- Node artifacts、Workers：`packages/services/src/node/`、`workers/`；compiler 属于 Rolldown 与服务开发附件。
- Management 与 Workbench：[WORKBENCH.md](WORKBENCH.md)、[管理接入](../docs/runtime/management.md)。
- 隔离测试宿主：[TESTING.md](TESTING.md)；在线应用检查：[DEV_CONSOLE.md](DEV_CONSOLE.md)。

代码、公开类型、文档必须描述同一所有权。不允许用测试宿主证明在线应用当前状态，或以 source-mode 测试代替独立安装和搬离工作区后的发行验证。
Node carrier 与 Node-backed Vite 已有覆盖；Bun/Deno/Worker、published Elysia peer admission 和真实外部下游迁移需要各自独立验证，不由本分层自动保证。
