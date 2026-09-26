# Host 与服务架构

本页拥有服务安装、应用启动与 Host 资源边界。整体分层见 [Plugin 系统](PLUGIN_SYSTEM.md)；应用组合用法见 [Host services](../docs/reference/runtime-services.md)。

应用以 `defineHostApplication(factory)` 声明 `HostApplicationFactory`，每次返回一个完整 `HostApplication`。官方默认值归 `servicesPreset()`、`vitePreset()`、`buildPreset()`；这些函数返回普通服务或工具插件，不能拥有第二套 Host。

## 服务与资源

`createHost({ plugins, services })` 在 root 创建前验证固定安装计划。服务用 `requires` 声明准备依赖；同步 capability factory 保持惰性，异步资源在 `prepare({ ctx, dependencies, effects })` 获取。
每项服务的 effects scope 随服务准备失败或 Host 关闭释放。Plugin generation 的 effects 随该代停止释放，两者都使用 Core effects 契约，但 owner 与生命周期必须在调用位置清楚可见。
关闭先停止接纳、排空协调操作和插件，再按依赖逆序释放服务；清理失败聚合，不能跳过其余清理。
Host 从协调队列末尾取得已应用 provider-default bindings，在同一 Core shutdown transaction 中先撤销绑定再删除节点；
持久化的 provider 选择和 auto-start 意图不因进程关闭而改变。

能力 token 的 access 表达调用 Context 的所有权：`all` 通用，`owner` 需要真实插件/Part owner，`root` 需要真实 RootContext。宿主代码使用 `ctx.require(Token)`，缺失、访问越界和构造失败保留各自错误。
`ctx.root` 返回真实根引用，持有它的受信任代码可访问 root 能力；这不是不可信代码沙箱。Core 内部图 authority 的 token 不进入普通作者入口。

`@pluxel/services` 的 `standardServices()` 安装 HTTP、Commands、Node artifacts、Workers、Persistence。同包的 `@pluxel/services/preset` 入口的 `servicesPreset()` 增加 Vault、Logging、Management、管理命令及可选 Workbench。Database 显式选择 backend。
未选择服务不创建对应 backend、watcher、编译器、route 或状态。关闭 Workbench 不关闭业务服务或管理 HTTP/WebSocket 接入；preset 始终显式安装 `managementHttp()`。

## 应用、开发和部署

应用每次启动执行配置工厂，取得完整 plugins/sources/services/config/state/configRecords；`prepare` 在服务与开发附件准备好后、插件启动前执行。
Host 不改变进程 cwd。入口与来源锚定 startup root，环境通过 startup 显式传递。`envBindings`/`fileBindings`显式选择输入；config按基础对象/文件 < 管理保存值 < env合并，env控制路径只读且不落盘。

Vite、生产 launcher 共用 Host 应用解析。工厂 identity 变化时重新求值完整配置并替换 Host，固定插件 import 更新也可能使工厂失效。工厂求值失败保留旧 Host。动态来源更新若工厂未变，则复用本次配置并提交 catalog。替换失败可用最后成功声明创建 fresh Host 补偿，但不能复活旧 generation。
Host-dev 是唯一开发驱动；官方服务附件分别由 Services、Workbench 拥有。数据库 lowering 属于官方 Vite preset 的工具插件，不是运行时服务。
生产 bootstrap 调用 `runHostApplication`；Fetch handler 和 Node listener 属于 HTTP 服务。构建资源 variant 不替应用安装服务。

## 控制台 execution

控制台借用当前 Host/RootContext 执行普通 TypeScript export，不进入 Plugin graph；HMR 不重放操作。运行撤回、有限更新 barrier、协作取消与脚本资源边界由 [DEV_CONSOLE](DEV_CONSOLE.md)统一定义。

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

Services 包含基础服务、Logging、Management 与官方 preset；子入口按能力、可选 backend 和运行环境划分，不各自发布。基础入口不加载未选择的后端。HTTP handler 与 `/http` 同属可移植请求边界，listener 与 `/http/node` 同属 Node carrier。框架跨包共享的 owner-view/security helpers 收敛到不加载 backend 的 `/internal`；白盒测试另用 `/internal/test`。仅包内测试使用的实现通过相对源码导入，数据库 driver 通过 package `imports` 私有加载，不成为导出子路径。

### 可移植 execution 协议

`@pluxel/host/internal/protocol` 是浏览器和服务端共享 execution/update snapshots 与验证函数的唯一内部跨包入口，直接构建无外部依赖的 `src/execution.ts`。服务端框架集成仍使用 `/internal`，该入口不再转发 execution 协议。Management 客户端直接消费 protocol，不经过包含来源加载、IO 和生命周期编排的服务端 barrel；此拆分表达真实的运行环境边界，不能因减少路径而合并。

服务内部不为单个 consumer 建立 token/resolve 转发层：HTTP directory token 与安装器同属 `http.ts`，开发附件直接读取 Node backend token。Vite 子入口直接映射开发模块；只有需要限制导出集合或组合多个实现的入口才保留 facade。数据库 adapter 实现与调用方共享 `DatabaseAdapter` 和 backend options 类型，资源策略仍由原有 coordinator 统一拥有。

## Vault 记录与宿主输入

Vault 只用结构化 KV 表达记录，blobs 保留独立文件语义。默认加密后端依赖 Persistence；bindings 后端只安装读取能力，
不准备密钥、磁盘或 Persistence。Host 在服务准备后、插件启动前，通过 root-only `HostVaultBindings` 安装 schema 已验证的
owner/key/value/source 记录；缺少安装能力属于装配错误。Services 不反向拥有 Host 的环境解析。

KV mutation 在唯一 backend lock 内 clone、检查 revision、加密并原子提交，然后才交换 snapshot 与发布通知；失败不推进
revision。删除保留 tombstone。watch/watchPrefix 在同一 lock 内读取初始 snapshot 并注册，通知在锁外、owner invocation 内运行。
部署 env/file 整记录只读且不落盘；任何KV写入路径都检查overlay。owner namespace和其命名子空间隔离，root保持受信任管理权限。

持久 snapshot 只接受 version 2 的结构化 KV 与 revision。完整加密格式、操作与恢复边界见 [Vault](../docs/runtime/vault.md)。
