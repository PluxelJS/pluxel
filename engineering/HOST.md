# Host 与服务架构

Host 拥有服务安装、应用启动、catalog、运行意图和资源关闭，复用 Core 的 graph/lifecycle。应用用法见 [Host services](../docs/host/services.md)，整体分层见 [Plugin 系统](PLUGIN_SYSTEM.md)。

`defineHostApplication(factory)` 返回工厂本身，由驱动在启动时求值。Node 应用可用 `servicesPreset()` 和 `vitePreset()` 组合运行时服务及开发附件，使用 `@pluxel/rolldown` 的 `pluxel()` 构建交付。

嵌入式应用拥有 JS 引擎和插件文件，Host 拥有一次启动的 catalog、服务与根。宿主先排空并关闭根，再释放引擎；下一次冷启动从已安装制品重建 catalog。示例同时验收内建能力和通过服务借用的原生能力。 [示例索引](../projects/README.md#cross-platform-host-examples)

## 应用工厂与运行寿命

`@pluxel/host/application` 提供三端共享的 `defineHostApplication(({ env }) => …)` 和服务安装函数。工厂为每个根返回插件、服务与完整的 `coreConfig`。直接启动的输入是部署变量与已解析的 Vault 记录。每个根用冻结的部署变量选择插件和服务，完成 catalog、fork 和服务依赖校验。`@pluxel/host` 的 Node 入口导出同一个函数对象，工厂参数推断为 `HostStartupContext`，可直接读取启动路径、模式和部署信息。Node 托管加载器另外解析动态来源、文件与环境绑定。Node 与嵌入式入口的 `startHost(application, inputs?)` 返回已验收的根，调用方持有并关闭它。三端共用准备、启动验收和发布钩子。默认验收只在失败时投影完整状态，自定义 `acceptStartup` 始终收到完整快照。 [应用工厂](../packages/host/src/application.ts) · [直接启动](../packages/host/src/embedded-application.ts) · [启动判定](../packages/host/src/application-start.ts)

Cloudflare 在模块作用域创建 `createWorkerHost(application)`。首个事件进入 `worker.run({ env, ctx }, callback)` 时启动根，当前事件通过 `ctx.waitUntil` 持有冷启动任务。相同部署变量的并发事件等待同一次启动，后续事件复用已启动的根、服务和插件。部署变量按字符串键值比较。新快照启动成功后接替原根，已接纳的旧事件结算后再关闭原根。新快照启动失败会使等待它的事件失败，下次同配置事件可以重试。平台回收 isolate 后由下一实例重新启动。 [Worker 驱动](../packages/host/src/cloudflare.ts) · [workerd 回归](../packages/host/tests/cloudflare/runtime.test.ts)

每次 `run` 建立独立的 SDK scope，持有本次取消信号、插件借用和 effects。原生 Request、事件 bindings 和请求产生的流由 handler 显式传入业务方法。默认在回调结束时释放 scope。依赖插件的响应体以 `responseBody: 'scope'` 和请求 signal 把借用延长到读完、取消或异常。其他事件继续使用常驻根。HTTP 响应完成或客户端断连后，平台为同次事件的全部 `waitUntil` 工作合计最多保留 30 秒。 [Market HTTP 与 Cron](../projects/plugin-market/src/worker.ts) · [Workers 执行上下文](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)

## 服务与资源

`createHost({ plugins, policy, config, services, coreConfig })` 的准备顺序：

1. 捕获输入，校验 root 创建前的固定安装计划。
2. 创建唯一 root，解析文档 factory，读取保存输入，组合八项 policy，一次绑定四项执行参数。
3. 创建 PluginService/coordinator，按 `requires` 顺序准备服务。

Core 直接装配时立即绑定执行配置；Host 的内部延迟绑定保持 Context shape 不变。同步 service factory 惰性构造 view，异步资源通常由 `prepare({ ctx, dependencies, effects })` 获取。内建 FS/TinyBase/Vault 首次操作共享各自准备任务，独立于服务顺序。准备失败沿同一个 root 清理路径，保留原错误和清理错误。

每项 service effects 在准备失败或 Host close 时释放；Plugin effects 随 generation 释放。关闭先停止 admission、排空协调操作和 Plugin，再按依赖逆序释放服务。所有清理都会执行，错误聚合。`close()` 和 `Symbol.asyncDispose` 共用幂等任务及失败结果。Host 在 Core shutdown transaction 中先撤销当前 provider-default bindings，再删除节点，保留持久 policy。

service access 区分 `all`、真实 Plugin/Part `owner` 和真实 `root`。`ctx.service(Service)` 保留 missing/access/construction 错误。`ctx.root` 是受信任代码可持有的真实根引用；内部 graph/config/storage authority 留在 framework 入口，Core 固定能力通过 Context 属性提供，见 [Core](CORE.md#context-service-kernel)。

`servicesPreset(startup, options)` 是唯一官方应用组合，安装 HTTP、Commands、Node artifacts、Workers、Management、管理命令及可选 Workbench。`workbench: false` 保留管理能力；定制宿主与隔离测试直接组合单项安装器。Core 的 `coreConfig.logtape`、`coreConfig.zenfs` 和 `coreConfig.vault` 分别选择日志、文件与凭据配置。Pg 单独安装，见 [Pg](DATABASE.md)。未选择的服务不创建 backend、watcher、compiler、route 或状态。

部署清单决定 Node 制品 owner：standalone 使用应用固定目录；modules 保留已加载模块 owner，Node 服务按各 owner inventory 读取，不能用应用目录覆盖外部 worker。详见[官方默认组合](../docs/host/services.md#官方服务预设servicespreset)。

Node 与嵌入式入口共享 ZenFS 装配，Node 入口额外接入 Undici 代理工厂。Cloudflare 使用根所有的会话文档和只读 Vault bindings。文档、TinyBase 会话数据和 logger 根标识在同一根的各次调用间保留。请求日志可显式用 `ctx.logger.with({ requestId })` 关联到单次事件。所选 Plugin 和 Services 的依赖闭包由应用构建验证。 [嵌入式 Host](../docs/host/configuration.md#嵌入式-host) · [Worker 设施](../packages/core/src/context/core-facilities.ts)

## 应用、开发和部署

每次启动求值应用工厂，捕获插件、策略、配置、服务、Core 设施和生命周期函数。Node 托管加载器还捕获来源声明，再异步解析 bindings。服务声明复制能力和依赖集合，借用句柄保留 identity。各入口将解析后的声明交给 `createResolvedHost()` 建根。`prepare` 在服务和开发附件准备后、Plugin 启动前执行。

生产入口 `application-start.ts` 统一执行：

```text
prepare → host.start / 服务结算 → acceptStartup → launch
```

默认要求 Host status 中全部 desiredState=running 的节点都已 running；应用可显式接受降级。拒绝保留 report/status，异常及清理异常保留 cause，失败调用原 `host.close()`。launch 只在判定通过后发布。Node 的 Vite 托管入口执行 `prepare`，由开发服务器持有 listener、报告启动状态并管理更新。浏览器与 Cloudflare 的 Vite 示例直接使用各自的启动入口，照常执行启动验收和 `launch`。

固定 `plugins` 与声明式 `sources` 进入同一 catalog。policy/config/bindings 使用 canonical address，提前声明动态节点不会加载代码、创建 fork 或启动节点。Host 保持进程 cwd；入口和来源锚定 startup root，env 由 startup 显式传入。输入合并由 [Config](CONFIG.md#static-startup-config) 维护。

Native 与 Vite 将每个动态入口的物理路径登记在提交的 catalog provenance 中，同一个 constructor 可以由多个入口提供。`readPluginSourceImpact` 从协调器同步读取 catalog、策略、节点和 Core 的直接依赖边。已排队或正在执行的图变更返回 `HOST_GRAPH_BUSY`，以免等待一个正在排空调用者的事务。来源路径用于识别发布者，Plugin identity 仍取自声明地址。携带候选声明时，预检与运行接纳共同使用声明级的策略求解；运行接纳单独为选中的节点附加真实实现并生成 Core 操作。[动态来源](../docs/host/configuration.md#动态来源) · [安装预览](https://github.com/PluxelJS/plugins/blob/main/package-manager/DESIGN.md#准备与确认)

Vite 和生产 launcher 共用应用解析。工厂 identity 变化时重新求值并替换 Host，固定 import 更新也可使工厂失效；求值失败保留旧 Host。工厂未变的动态来源更新复用当前配置、提交 catalog。replacement 失败可用最后成功声明创建 fresh Host 补偿，旧 generation 保持退役。Host-vite 驱动 Node 应用开发；Services/Workbench 分别拥有自己的附件，database lowering 属于工具插件。

modules launcher 在全新 Node 进程、业务闭包首次求值前，调用 `runHostApplication(entry, { startup, sharedPackages })`：先建立共享绑定，再求值工厂和 imports。standalone bootstrap 已内联闭包，无需再次发现模块。两者完成 Host/附件接线后共用 `startHostApplication`。应用在自身闭包静态导入 HTTP 服务并在 launch 调用，保持 Host 与 服务声明身份 一致。构建 variant 只选择资源交付方式；原生启动的求值前提见[生产构建](../docs/host/configuration.md#生产构建)。

native loader 在本 scope 复用通过 owner/exports/ABI 检查的 namespace，新模块继续检查；失败或 owner 未确认时不缓存成功。共享包版本准入读取实际 manifest，不用跨 Host manifest cache。pending namespace 集合属于 loader；成功 entry 的累计闭包以本次 URL 顺序数组和前缀长度表示，后续加载不延长旧 entry 的范围，关闭后冻结数组供 Node cache 保留。

## 控制台 execution

控制台借用当前 Host/RootContext 执行普通 TypeScript export，不进入 Plugin graph，HMR 不重放操作。运行撤回、update barrier、取消和资源边界见 [Dev Console](DEV_CONSOLE.md)。

## HTTP 与管理页面

`ElysiaApp` 是 generation 拥有的真实 Elysia application，Plugin 与 Parts 共用。init 成功后 HTTP lifecycle 完成 finalize、settle、prepare、publish，再原子交换 directory；失败候选不发布路由。

公共 `/elysia` 提供 `ElysiaApp`、`elysia()` 和 `createElysiaHandler()`。Fetch 入口从 `@pluxel/host/application` 取得服务安装能力，`/elysia/node` 单独提供 srvx `listenElysia()`。`ElysiaRuntime` 是内部 root-only dispatcher。Node listener 登记到 root effects，公开 close 与 Host close 共用清理。Vite 自己拥有 listener。generation stop 只排空自身请求、stream、WebSocket lease。

每个提交快照用一个原生 Elysia HTTP 匹配器按声明的 method 和路径选出 owner，再交给该代插件的 `app.fetch` 执行 hooks、schema 和业务处理器。WebSocket 升级独立匹配。根服务 `ElysiaDirectory.matchesHttpRoute(pathname, method?)` 查询同一快照，省略 method 时检查已发布的方法。跨 owner 发布冲突按种类、method 和原始声明路径比较。

内部 dispatch 保留 Response/undefined，传输边界将未处理请求变为 404。静态文件和 SPA fallback 只接手 undefined，业务处理器返回的 404 保留原响应。公开 Fetch handler 始终返回 Response。

carrier `url` 保存物理监听地址；显式 `publicOrigin` 用于管理会话同源校验和终端展示。Vite/native launcher 在环境边界用 `resolveHostEnv(input)` 解析 `PLUXEL_PUBLIC_ORIGIN` > `PITCHFORK_URL`、`PLUXEL_HOST_BIND/PORT` > `HOST/PORT`；listener 只接收显式选项。默认 origin 来自物理地址，Forwarded/X-Forwarded-* 不参与信任判断。

Node 客户端断线由 srvx 原生 `request.signal` 传播，owner lease 合成关闭取消。Host handler 接收 root lease signal，同时保留原 ingress 的地址和 upgrade identity。

Management 拥有认证、状态投影和 RPC session；Workbench 拥有 publication、Shell 和页面。`managementHttp()` 唯一安装管理 endpoint，`workbenchHttp()` 只安装 Shell fallback。preset 用既有 bindings 组合 session/artifact handler，并以 `requires: { workbench: WorkbenchHost }` 声明准备顺序。业务 HTTP 的认证由业务自己选择；`managementCommands()` 是独立 Commands 接入。

`pluginApplyReportOutcome()` 统一归约 Host 操作报告，保留持久化未知、生命周期/协调失败或完成结论及原报告。Script SDK 直接返回成功值，失败抛出携带领域信息的 `ScriptError`；Management 映射 DTO。生命周期失败仍返回操作后的 control 和 report，UI 据此刷新与展示诊断。配置、policy、fork 删除分别保留保存、采用和排空结果。Services `web/control-batch.ts` 共用于执行和 wire 校验；任一项 persistence unknown 使批量摘要为 unknown，逐项结果完整保留。

`status.ts` 分开枚举节点和投影单节点。列表包括已接纳 default、配置 forks，以及仍被 policy/运行状态引用的节点；精确查询和控制回执共用存在性/control 投影。运行状态、诊断和 recent update 每次读取当前 committed view。

实例和 Context 借用、脚本修订号通过 `readCommittedState()` 读取 catalog 与运行策略状态。该读取与 `readCommitted()` 共用协调器队列和同步回调约束。状态和依赖诊断通过 `readCommitted()` 投影 Core 邻接表和运行节点。

构造 Host 时接纳初始 catalog 声明，启动时在同一份声明上捕获准备阶段提交的 provenance。Core 按已提交图的身份复用节点地址，依赖边在首次读取时投影。每次读取重新判定运行节点，生命周期诊断通过相关地址确认运行状态。

生命周期操作的存在性检查、`session.update(pluginLifecycleUpdate(...))` 与回执投影位于同一次 `runExclusive`，避免后排操作污染回执。批量逐项排队，取消阻止下一项，已接纳项继续结算；auto-start 批量保留整批 CAS 边界。

Services label 缓存属于 root，按 catalog、state、sessionIntents、desiredControl、applied.nodes identity 失效。命中时按 address 查表。applied.nodes 与 Core membership 的同集关系由依赖图回归保护。fork 增删、改名 replacement、session 引用、有效图变化会失效。普通读取、配置保存和仅 restart 可复用 label。

### 状态投影测量

精确查询用稳定 `HostStateSnapshot` 的 WeakMap 索引。新 state 枚举 auto-start/forks 并创建集合。完整 SDK readCommitted 还读取所提交图的节点和当前运行状态。热索引命中与完整调用成本分别测量。

Host 的 `bench/status.bench.mjs` 比较 overview/find 与精确投影；Services 的 `bench/management-status.bench.mjs` 测实际 Management DTO。构建所属包后用 `vp exec node <path>` 执行，历史数值与范围见[测量记录](records/host-deployment.md#状态投影测量2026-11-15)。

回归入口是 Host `graph/status.test.ts`、Services `management/catalog-navigation.test.ts` 与 `management/control-receipts.test.ts`。它们分别验证状态投影、精确节点读取和并发操作回执。

## 资源边界与验证入口

| 主题                                 | 实现与回归入口                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| service plan、prepare rollback、关闭 | `packages/host/src/{services,host}.ts`；services/host/application tests                                                         |
| config/state 文档与事务              | Host [配置操作](../packages/host/tests/config/operations.test.ts)、[部署策略](../packages/host/tests/policy/deployment.test.ts) |
| catalog、candidate、commit           | Host `coordinator.ts`；[HMR](HMR.md)                                                                                            |
| 应用/native loading                  | Host `application.ts`、`application-start.ts`、`source-discovery.ts`、`native-source-loader.ts`                                 |
| HTTP lease、stream、WS               | `packages/services/src/elysia/`；[HTTP 用法](../docs/plugin-development/http.md)                                                |
| Node artifacts、Workers              | `packages/services/src/node/`、`workers/`；[Artifact Build](ARTIFACT_BUILD.md)                                                  |
| Management/Workbench                 | [Workbench](WORKBENCH.md)、[管理接入](../docs/host/management.md)                                                               |

Host 文档默认借用 Core 提供的存储，Node 和嵌入式入口使用 ZenFS，Cloudflare 使用根内会话文档。`config.document` 与 `policy.document` 分别选择 IO、写权限和同步 root storage factory。config v4、state v8 只保存稀疏原始输入；缺失文档不写种子，坏格式保留原文件并拒绝准备。关闭先取消观察、排空本域任务，再由 Core 关闭 backend，见 [Config](CONFIG.md#存储与创建边界)。

Worker caller result 与底层 execution settlement 分开；`settlement: 'execution'` 等到线程可复用或退出再发布结果，供调用方清理文件等资源。

Services 的可选 backend 和运行环境按叶入口隔离，`/internal` 只提供 framework owner/security helpers，`/internal/test` 提供白盒设施，driver 通过 package imports 私有加载。包内实现直接相对导入，不为单 consumer 增加 服务声明/resolve 转发层。

Node srvx/Vite 接线已有覆盖；Bun、Deno、Worker adapter、published Elysia peer admission 和工作区外下游迁移需各自验证。发行验证使用独立安装制品，在线状态从现有 [Dev Console](DEV_CONSOLE.md) 观察。

### 可移植 execution 协议

`@pluxel/host/internal/protocol` 组合浏览器/服务端共享 execution/update snapshots、操作报告及 parser。`report-protocol.ts` 校验 report、reconciliation、lifecycle summary、persistence 的字段与语义，地址沿用 Core codec。parser 带字段标签抛 TypeError；Management 在载体边界映射自己的协议错误、校验 envelope 与权限。

新增报告字段时，Host 的 producer、类型和 parser 同步更新；`graph/report-protocol.test.ts` 维护对照。Management 客户端消费 portable protocol，不加载 source/IO/lifecycle 编排。

## Vault 记录与宿主输入

Vault 是 Core 固定能力，Plugin 通过 `ctx.vault` 取得 owner 存储视图；KV 是结构化记录，blobs 保留文件语义。`coreConfig.vault` 选择默认加密 backend 或只读 bindings backend。加密后端按需借用 Core FS，bindings 后端不准备密钥或磁盘。Host 在 Plugin admission 前通过 Core 内部边界安装已校验的 owner/key/value/source；凭据契约和存储实现归 Core，部署 Schema 与 env 解码由三个 Host 的应用启动入口共用。托管 Node 负责相对部署根解析 JSON 文件。Worker 以入口显式传入的部署变量投影选择根，从同一份 env 快照解析绑定；替换成功后旧事件仍使用原根。见[部署输入与启动](../docs/host/configuration.md#绑定部署环境与-json-文件)。

创建 Host、读取凭据能力、创建 KV/blob 句柄或管理 describe 不生成密钥；首次数据操作按需初始化新加密库，也可由管理员显式 unlock 初始化。已有库缺少匹配密钥或解密失败时保留错误，不阻止未使用凭据的 Host 启动。能力存在不代表密钥已配置、存储已解锁或记录存在，具体操作报告实际状态；管理面通过 `requireVaultHost(root).admin` 借用根管理接口，所有后端准备、观察和最终释放仍归 Core。

KV mutation 在本实例 backend lock 内 clone、检查 revision、加密、原子提交，再交换 snapshot 并通知。失败不推进 revision，删除保留 tombstone。watch/watchPrefix 在同一 lock 读取初值并注册，通知在锁外、owner invocation 内运行。env/file 整记录只读且不落盘，所有写路径检查 overlay。`vault.namespace` 的命名子空间与 default/fork owner 隔离，root 保留管理权限。

同一 owner 复用默认 KV 句柄，显式 namespace 句柄复用自己的后端视图。watch 的 `dispose()` 释放 owner 登记、脚本借用登记和通知快照，已经接纳的回调仍按运行代协议结算。

外部加密快照由 Vault 解密校验，在 lock 内交换有效 view、锁外通知；无效更新保留最后有效值和原文件。外部 revision 可重复或回退，本地检查不是跨实例 CAS。格式只接受 version 2 的 KV/revision；加密、轮换和恢复见 [Vault](../docs/plugin-development/vault.md)。后端与原子文件规则见 [FS](FS.md)。
