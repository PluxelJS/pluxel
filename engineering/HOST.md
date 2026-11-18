# Host 与服务架构

Host 拥有服务安装、应用启动、catalog、运行意图和资源关闭，复用 Core 的 graph/lifecycle。应用用法见 [Host services](../docs/host/services.md)，整体分层见 [Plugin 系统](PLUGIN_SYSTEM.md)。

`defineHostApplication(factory)` 每次返回完整 `HostApplication`。`servicesPreset()` 和 `vitePreset()` 组合运行时服务及开发附件，`@pluxel/rolldown` 的 `pluxel()` 构建应用；这些入口共用一个 Host。

## 服务与资源

`createHost({ plugins, policy, config, services, runtime })` 的准备顺序：

1. 捕获输入，校验 root 创建前的固定安装计划。
2. 创建唯一 root，解析文档 factory，读取保存输入，组合八项 policy，一次绑定四项执行参数。
3. 创建 PluginService/coordinator，按 `requires` 顺序准备服务。

Core 直接装配时立即绑定执行配置；Host 的内部延迟绑定保持 Context shape 不变。同步 service factory 惰性构造 view，异步资源通常由 `prepare({ ctx, dependencies, effects })` 获取。内建 FS/TinyBase/Vault 首次操作共享各自准备任务，独立于服务顺序。准备失败沿同一个 root 清理路径，保留原错误和清理错误。

每项 service effects 在准备失败或 Host close 时释放；Plugin effects 随 generation 释放。关闭先停止 admission、排空协调操作和 Plugin，再按依赖逆序释放服务。所有清理都会执行，错误聚合。`close()` 和 `Symbol.asyncDispose` 共用幂等任务及失败结果。Host 在 Core shutdown transaction 中先撤销当前 provider-default bindings，再删除节点，保留持久 policy。

service access 区分 `all`、真实 Plugin/Part `owner` 和真实 `root`。`ctx.service(Service)` 保留 missing/access/construction 错误。`ctx.root` 是受信任代码可持有的真实根引用；内部 graph/config/storage authority 留在 framework 入口，Core 固定能力通过 Context 属性提供，见 [Core](CORE.md#context-service-kernel)。

`servicesPreset(startup, options)` 是唯一官方应用组合，安装 HTTP、Commands、Node artifacts、Workers、Management、管理命令及可选 Workbench。`workbench: false` 保留管理能力；定制宿主与隔离测试直接组合单项安装器。Core 的 `coreConfig.logtape`、`coreConfig.zenfs` 和 `coreConfig.vault` 分别选择日志、文件与凭据配置。Database 单独安装，见 [Database](DATABASE.md)。未选择的服务不创建 backend、watcher、compiler、route 或状态。

部署清单决定 Node 制品 owner：standalone 使用应用固定目录；modules 保留已加载模块 owner，Node 服务按各 owner inventory 读取，不能用应用目录覆盖外部 worker。详见[官方默认组合](../docs/host/services.md#官方服务预设servicespreset)。

`@pluxel/host/browser` 从 `src/browser.ts` 导出同一 Host/服务实现，避免 Node application/source loader 求值；所选 Plugin 的平台依赖仍由应用负责，见[浏览器 Host](../docs/host/configuration.md#浏览器-host)。

## 应用、开发和部署

每次启动求值配置工厂，在异步 bindings 读取前捕获 name/plugins/sources/policy/config/services/runtime。服务声明复制能力和依赖集合，借用句柄保留 identity。执行入口向 `createHost()` 显式投影正式字段。`prepare` 在服务和开发附件准备后、Plugin 启动前执行。

生产入口 `application-start.ts` 统一执行：

```text
prepare → host.start / 服务结算 → acceptStartup → launch
```

默认要求 Host status 中全部 desiredState=running 的节点都已 running；应用可显式接受降级。拒绝保留 report/status，异常及清理异常保留 cause，失败调用原 `host.close()`。launch 只在判定通过后发布。Vite 拥有自己的 listener、更新和局部失败诊断，不执行 acceptStartup/launch。

固定 `plugins` 与声明式 `sources` 进入同一 catalog。policy/config/bindings 使用 canonical address，提前声明动态节点不会加载代码、创建 fork 或启动节点。Host 保持进程 cwd；入口和来源锚定 startup root，env 由 startup 显式传入。输入合并由 [Config](CONFIG.md#static-startup-config) 维护。

Vite 和生产 launcher 共用应用解析。工厂 identity 变化时重新求值并替换 Host，固定 import 更新也可使工厂失效；求值失败保留旧 Host。工厂未变的动态来源更新复用当前配置、提交 catalog。replacement 失败可用最后成功声明创建 fresh Host 补偿，旧 generation 保持退役。Host-vite 是唯一开发驱动；Services/Workbench 分别拥有自己的附件，database lowering 属于工具插件。

modules launcher 在全新 Node 进程、业务闭包首次求值前，调用 `runHostApplication(entry, { startup, sharedPackages })`：先建立共享绑定，再求值工厂和 imports。standalone bootstrap 已内联闭包，无需再次发现模块。两者完成 Host/附件接线后共用 `startHostApplication`。应用在自身闭包静态导入 HTTP 服务并在 launch 调用，保持 Host 与 服务声明身份 一致。构建 variant 只选择资源交付方式；原生启动的求值前提见[生产构建](../docs/host/configuration.md#生产构建)。

native loader 在本 scope 复用通过 owner/exports/ABI 检查的 namespace，新模块继续检查；失败或 owner 未确认时不缓存成功。共享包版本准入读取实际 manifest，不用跨 Host manifest cache。pending namespace 集合属于 loader；成功 entry 的累计闭包以本次 URL 顺序数组和前缀长度表示，后续加载不延长旧 entry 的范围，关闭后冻结数组供 Node cache 保留。

## 控制台 execution

控制台借用当前 Host/RootContext 执行普通 TypeScript export，不进入 Plugin graph，HMR 不重放操作。运行撤回、update barrier、取消和资源边界见 [Dev Console](DEV_CONSOLE.md)。

## HTTP 与管理页面

`ElysiaApp` 是 generation 拥有的真实 Elysia application，Plugin 与 Parts 共用。init 成功后 HTTP lifecycle 完成 finalize、settle、prepare、publish，再原子交换 directory；失败候选不发布路由。

公共 `/elysia` 提供 `ElysiaApp`、`elysia()`、`createElysiaHandler()`，`/elysia/node` 提供 srvx `listenElysia()`；`ElysiaRuntime` 是内部 root-only dispatcher。Node listener 登记到 root effects，公开 close 与 Host close 共用清理；Vite 自己拥有 listener。generation stop 只排空自身请求、stream、WebSocket lease。

内部 dispatch 保留 Response/undefined，传输边界将未处理请求变为 404。静态文件和 SPA fallback 只处理 undefined，不按 status 或二次路由判断所有权；公开 Fetch handler 始终返回 Response。跨 owner collision 只比较可证明的精确 route inventory。

carrier `url` 保存物理监听地址；显式 `publicOrigin` 用于管理会话同源校验和终端展示。Vite/native launcher 在环境边界用 `resolveHostEnv(input)` 解析 `PLUXEL_PUBLIC_ORIGIN` > `PITCHFORK_URL`、`PLUXEL_HOST_BIND/PORT` > `HOST/PORT`；listener 只接收显式选项。默认 origin 来自物理地址，Forwarded/X-Forwarded-* 不参与信任判断。

Node 客户端断线由 srvx 原生 `request.signal` 传播，owner lease 合成关闭取消。Host handler 接收 root lease signal，同时保留原 ingress 的地址和 upgrade identity。

Management 拥有认证、状态投影和 RPC session；Workbench 拥有 publication、Shell 和页面。`managementHttp()` 唯一安装管理 endpoint，`workbenchHttp()` 只安装 Shell fallback。preset 用既有 bindings 组合 session/artifact handler，并以 `requires: { workbench: WorkbenchHost }` 声明准备顺序。业务 HTTP 的认证由业务自己选择；`managementCommands()` 是独立 Commands 接入。

`pluginApplyReportOutcome()` 统一归约 Host 操作报告，保留持久化未知、生命周期/协调失败或完成结论及原报告。Script SDK 直接返回成功值，失败抛出携带领域信息的 `ScriptError`；Management 映射 DTO。生命周期失败仍返回操作后的 control 和 report，UI 据此刷新与展示诊断。配置、policy、fork 删除分别保留保存、采用和排空结果。Services `web/control-batch.ts` 共用于执行和 wire 校验；任一项 persistence unknown 使批量摘要为 unknown，逐项结果完整保留。

`status.ts` 分开枚举节点和投影单节点。列表包括已接纳 default、配置 forks，以及仍被 policy/运行状态引用的节点；精确查询和控制回执共用存在性/control 投影。运行状态、诊断和 recent update 每次读取当前 committed view。

生命周期操作的存在性检查、`session.update(pluginLifecycleUpdate(...))` 与回执投影位于同一次 `runExclusive`，避免后排操作污染回执。批量逐项排队，取消阻止下一项，已接纳项继续结算；auto-start 批量保留整批 CAS 边界。

Services label 缓存属于 root，按 catalog、state、sessionIntents、desiredControl、applied.nodes identity 失效。命中时按 address 查表，不扫描目录或分配比较数组。Core adjacency 每次创建新数组，不能作缓存证据；applied.nodes 与 Core membership 的同集关系由依赖图回归保护。fork 增删、改名 replacement、session 引用、有效图变化会失效；普通读取、配置保存和仅 restart 可复用 label。

### 状态投影测量

精确查询用稳定 `HostStateSnapshot` 的 WeakMap 索引。新 state 仍枚举 auto-start/forks 并创建集合；完整 SDK readCommitted 也读取 Core adjacency。热索引命中与完整调用成本分别测量。

Host 的 `bench/status.bench.mjs` 比较 overview/find 与精确投影；Services 的 `bench/management-status.bench.mjs` 测实际 Management DTO。构建所属包后用 `vp exec node <path>` 执行，历史数值与范围见[测量记录](records/host-deployment.md#状态投影测量2026-11-15)。

回归入口是 Host `status-projection.test.ts`、Services `management/management/plugin-status-read.test.ts` 与 `control-protocol.test.ts`，保护结果、缓存失效、冷热扫描及并发回执。

## 资源边界与验证入口

| 主题                                 | 实现与回归入口                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| service plan、prepare rollback、关闭 | `packages/host/src/{services,host}.ts`；services/host/application tests                         |
| config/state 文档与事务              | Host `config-store.ts`、`state-store.ts`；[Config](CONFIG.md)                                   |
| catalog、candidate、commit           | Host `coordinator.ts`；[HMR](HMR.md)                                                            |
| 应用/native loading                  | Host `application.ts`、`application-start.ts`、`source-discovery.ts`、`native-source-loader.ts` |
| HTTP lease、stream、WS               | `packages/services/src/elysia/`；[HTTP 用法](../docs/plugin-development/http.md)                |
| Node artifacts、Workers              | `packages/services/src/node/`、`workers/`；[Artifact Build](ARTIFACT_BUILD.md)                  |
| Management/Workbench                 | [Workbench](WORKBENCH.md)、[管理接入](../docs/host/management.md)                               |

Host 文档默认借用 Core FS，`config.document` 与 `policy.document` 分别选择 IO、写权限和同步 root storage factory。config v4、state v8 只保存稀疏原始输入；缺失文档不写种子，坏格式保留原文件并拒绝准备。关闭先取消观察、排空本域任务，再由 Core 关闭 backend，见 [Config](CONFIG.md#存储与创建边界)。

Worker caller result 与底层 execution settlement 分开；`settlement: 'execution'` 等到线程可复用或退出再发布结果，供调用方清理文件等资源。

Services 的可选 backend 和运行环境按叶入口隔离，`/internal` 只提供 framework owner/security helpers，`/internal/test` 提供白盒设施，driver 通过 package imports 私有加载。包内实现直接相对导入，不为单 consumer 增加 服务声明/resolve 转发层。

Node srvx/Vite 接线已有覆盖；Bun、Deno、Worker adapter、published Elysia peer admission 和工作区外下游迁移需各自验证。发行验证使用独立安装制品，在线状态从现有 [Dev Console](DEV_CONSOLE.md) 观察。

### 可移植 execution 协议

`@pluxel/host/internal/protocol` 组合浏览器/服务端共享 execution/update snapshots、操作报告及 parser。`report-protocol.ts` 校验 report、reconciliation、lifecycle summary、persistence 的字段与语义，地址沿用 Core codec。parser 带字段标签抛 TypeError；Management 在载体边界映射自己的协议错误、校验 envelope 与权限。

新增报告字段时，Host 的 producer、类型和 parser 同步更新；`report-protocol.test.ts` 维护对照。Management 客户端消费 portable protocol，不加载 source/IO/lifecycle 编排。

## Vault 记录与宿主输入

Vault 是 Core 固定能力，Plugin 通过 `ctx.vault` 取得 owner 存储视图；KV 是结构化记录，blobs 保留文件语义。`coreConfig.vault` 选择默认加密 backend 或只读 bindings backend。加密后端按需借用 Core FS，bindings 后端不准备密钥或磁盘。Host 在 Plugin admission 前通过 Core 内部边界安装已校验的 owner/key/value/source；凭据契约和存储实现归 Core，部署 Schema、环境与 JSON 文件解析归 Host，Core 不引用 Host 类型。

创建 Host、读取凭据能力、创建 KV/blob 句柄或管理 describe 不生成密钥；首次数据操作按需初始化新加密库，也可由管理员显式 unlock 初始化。已有库缺少匹配密钥或解密失败时保留错误，不阻止未使用凭据的 Host 启动。能力存在不代表密钥已配置、存储已解锁或记录存在，具体操作报告实际状态；管理面通过 `requireVaultHost(root).admin` 借用根管理接口，所有后端准备、观察和最终释放仍归 Core。

KV mutation 在本实例 backend lock 内 clone、检查 revision、加密、原子提交，再交换 snapshot 并通知。失败不推进 revision，删除保留 tombstone。watch/watchPrefix 在同一 lock 读取初值并注册，通知在锁外、owner invocation 内运行。env/file 整记录只读且不落盘，所有写路径检查 overlay。`vault.namespace` 的命名子空间与 default/fork owner 隔离，root 保留管理权限。

外部加密快照由 Vault 解密校验，在 lock 内交换有效 view、锁外通知；无效更新保留最后有效值和原文件。外部 revision 可重复或回退，本地检查不是跨实例 CAS。格式只接受 version 2 的 KV/revision；加密、轮换和恢复见 [Vault](../docs/plugin-development/vault.md)。后端与原子文件规则见 [FS](FS.md)。
