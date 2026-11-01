# TinyBase 状态重构决策与验收索引

状态：Core 内建 FS/TinyBase 与 Host saved-layer 跨实例同步已实施；实际验证和剩余边界见[迁移记录](../TINYBASE_MIGRATION.md)。更新：2026-11-01。初次状态重构的源码基线：Pluxel `67f2082e`；本轮内建调整基于 `7b9b544d`。

本页只保留必要决策与未验证边界。当前契约由 [TinyBase](../TINYBASE.md)、[Database](../DATABASE.md) 和[插件状态用法](../../docs/plugin-development/tinybase.md)维护；逐包数据归属、实现覆盖与实际验证见[迁移记录](../TINYBASE_MIGRATION.md)。实施前的讨论和拟议 API 留在 Git 历史。

## 已实施版本的决策

本节记录当前实现。FS 与 TinyBase 已从可选 Service 改为 Core 固定能力；原生 Store、领域权威和保存确认语义保持原契约。

1. **统一保存底层，保留领域权威。** 官方插件的配置 saved layer、普通偏好和有界结构化状态使用 Host 托管的 TinyBase。部署配置仍通过 `configs.use()`，Core records/revision、完整 Valibot 校验、配置优先级与 validate → save → apply 不变，不要求纯配置插件再打开 Store。
2. **使用原生 Store。** 每个 Plugin node（含 fork）只有一份托管 Store，Part 共享所属 Plugin 的实例。作者直接使用 `tinybase` 及上游子路径，内建能力仅提供 `open(store?)`、`flush()` 等宿主接入契约，不引入 CRUD、schema 或事务包装。
3. **持久化由宿主管理。** Core 提供固定 FS/TinyBase、owner 隔离与关闭排空，应用通过 `config.storage` 选择一次后端，省略时使用 InMemory。Host 默认接入私有 config/state 文档，Plugin 不声明持久策略、不管理 Persister；Vault 保留自己的加密与 revision 契约。
4. **内存变化与保存确认分开。** 原生 mutation 同步更新内存，`flush()` 等待完整事务的保存进度。Wretch、Fonts 与 Host 文档继续在保存确认后发布领域状态，保存失败不会伪装成成功，也不通过补偿保存或关闭时重试悄悄提交候选。
5. **复用版本接纳与绑定。** TinyBase 与 Cap’n Web 共用内部版本事实和安装校验机制；TinyBase 的精确 runtime 依赖归 Core，Cap’n Web 仍归 Workbench。直接使用上游并与托管 Store 互操作的消费者声明对应 peer/dev；开发、静态构建和生产加载先校验再绑定原生模块。私有 TinyBase 保持原解析，不通过全局 override 或框架镜像入口统一。
6. **保留托管 SQL。** Database、PGlite/PostgreSQL 后端和 owner 生命周期继续归 `@pluxel/services/database`；Rolldown、Vite 与 CLI 保留 artifact 和迁移工具。查询与 schema 使用原生 Drizzle，不新增数据库发布包，Database 不加入默认服务组合。应用仍可自管 SQL 连接。
7. **按领域语义迁移。** 普通设置进入 TinyBase；凭据、二进制、文档源码、审计事件、缓存/限流算法与外部后端仍由原领域管理，不为了统一存储而削弱资源、事务或安全保证。
8. **转换必须显式。** TinyBase 包版本、Host 快照格式与插件业务结构分别演进；旧数据先备份、离线转换并校验重开。运行时不保留旧 JSON reader、双写或启动迁移，不用默认值覆盖损坏或未知格式。

## 已实施的覆盖

| 范围               | 实施结果与权威入口                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全部 16 个官方插件 | 已逐包盘点；统一配置底层，Wretch 和 Fonts 的额外偏好迁入原生 Store，其余数据按真实领域职责保留。见[逐包清单](../TINYBASE_MIGRATION.md#16-个官方插件包)。  |
| Host 与 Services   | 配置、运行策略、Logging policy、Management 布局使用 Host 私有文档；保存确认、并发、故障与撤回由 [TinyBase](../TINYBASE.md)维护。                          |
| 模板与演示应用     | Todo 与 Bot source 状态迁入原生表；应用依赖、共享 peer/dev、测试服务与生成项目 AGENTS 同步。见[模板与应用](../TINYBASE_MIGRATION.md#services模板与应用)。 |
| 构建与发行         | 原生子路径、同版多安装路径、共享异版拒绝、私有异版隔离与工作区外安装均有回归。见[版本治理](../GOVERNANCE.md)及[验证记录](../TINYBASE_MIGRATION.md)。      |
| SQL 服务           | 原 Services 入口、原生 Drizzle、迁移 CLI、开发转换和生命周期保留；本次未删除或转换 SQL 数据。见[SQL 验证](../TINYBASE_MIGRATION.md)。                     |

公开用法、工程边界、包导出、真实调用方、模板与 Tegami 已同步。目标回归、独立安装、生成项目 smoke 和文档生产构建的实际结果统一维护在迁移记录，不在本页重复测试计数或 API 示例。

## 剩余验收边界

- **外部旧数据转换。** 已核对的本地数据根没有待转换的旧设置，不能据此声称外部部署已经转换。外部数据仍需按 owner 备份、转换与恢复验收，见[本地盘点](../TINYBASE_MIGRATION.md)。
- **跨格式升级与降级。** 本次首次引入 `pluxel.tinybase` format 1；同格式恢复及未知格式拒绝已验证，没有前代真实快照可用于跨格式转换和匹配备份恢复。
- **在线与真实后端。** 未执行的 live HMR、真实 PostgreSQL 和依赖浏览器服务的交互验收由[迁移记录](../TINYBASE_MIGRATION.md)明确列出；隔离测试和文档示例编译不能替代这些证据。
- **独立消费者的上游声明。** 较大 Services installed suite 的运行阶段通过，严格声明检查仍被 Elysia/TypeBox 的上游类型错误阻断；没有增加白名单或放宽 `skipLibCheck`，最小复现与版本见[独立安装记录](../TINYBASE_MIGRATION.md)。

当前业务 Store 仍是一份 Host 内的单 writer 有界快照；配置复制采用部署固定的唯一写入节点。范围不包含 fsync/断电保证、跨 Store 事务、多进程共享物理 writer、离线管理写入、自动接管或 SQL 自动镜像。[Worksplit 资源生命周期提案](https://github.com/PluxelJS/split-like-vscode/blob/bd6ddfa3e5a9c866a412597e9001b530526e4250/refactor/API_REFINEMENT_PROPOSAL.md)独立推进，不构成本次状态重构的前置条件。

## 内建 FS 与 TinyBase

FS 与 TinyBase 定位为固定的插件状态基础能力，插件直接使用必有的 `this.ctx.fs` 和 `this.ctx.tinybase`。插件运行时数据文件、业务状态和配置 saved layer 复用一套内建存储，应用选择后端即可，无需安装 `fs()`、`tinybase()` 或手工连接配置文档；插件无需导入 token、`require(TinyBase)` 或判断是否存在。源码、包安装与构建制品沿用原生文件系统，不在这份统一存储的范围内。

当前依赖事实是 **Host 将配置持久化接到 TinyBase**，Core 的 ConfigService 尚不依赖 TinyBase。内建的依据是平台决定固定提供这项能力；不能仅因某个服务被另一个模块使用，就将所有依赖都移进 Core。这里的“宿主拥有资源”指创建本次运行实例的一方，不等于实现必须放在 `@pluxel/host` 包，也不等于只能运行在 Node。

### 当前 Host 与跨平台边界

当前 Host 已同时包含通用应用运行时与 Node 启动接入；`@pluxel/host/browser` 直接导出同一个 `createHost`，不另建浏览器版协调器。

| 当前职责                                                                    | 主要实现                                                                | 平台边界                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| catalog、启停/restart、fork、运行策略、配置管理、协调提交及状态报告         | Host `host.ts`、`coordinator.ts`、`config-store.ts`、`state-store.ts`   | 通用运行时，浏览器入口复用                  |
| 服务计划、准备失败清理、publication hooks、关闭排空                         | Host `services.ts`                                                      | 通用资源编排，不要求 Node                   |
| 应用入口求值、文件来源发现、原生 ESM 加载与共享依赖绑定、部署 env/file 读取 | Host `application.ts`、`source-discovery.ts`、`native-source-loader.ts` | Node 接入；不能进入通用运行时的模块求值闭包 |
| 固定数据 FS、TinyBase writer、快照与私有文档                                | Core `fs/`、`tinybase/`、`storage/`                                     | 可移植机制；具体后端按入口选择              |
| HTTP、Workers、Vault、Logging、Management、Workbench                        | Services / Workbench                                                    | 由应用另行选择，保留各自资源所有权          |

FS 已有 InMemory、Passthrough、IndexedDB 后端；Node 原生 `fs` 由应用提供给 Passthrough，浏览器后端独立导入。文件能力和原子保存并非天然属于 Node。上游 [ZenFS](https://zenfs.dev/core/) 区分通用文件接口与后端，[IndexedDB 标准](https://www.w3.org/TR/IndexedDB/#dom-windoworworkerglobalscope-indexeddb)同时覆盖 Window 与 Web Worker；“Worker”运行环境仍须实际具备所选后端，不能据此推断所有边缘运行时都支持 IndexedDB。

目标是在 Core 内集成可移植的文件与状态机制，Host 继续拥有应用级配置和运行策略的协调。Node 来源加载和具体平台后端按入口隔离；不为这次内建另建一层 runtime 包，也不因代码可跨平台就搬动 catalog、fork 或配置提交权威。

### 运行时数据与源码、安装目录分开

内建 FS 是构建后业务代码使用的可移植数据文件系统。稳定的是接口、owner 与数据命名空间；数据仍可修改，也可跨 HMR 保留。它不提供代码发现、模块解析、安装环境或开发文件系统。

| 对象                                                                                      | 所有者与文件接口                                                             | 约束                                                                                   |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 插件源码目录、入口发现、`realpath`、ESM 解析、开发 watcher 与 HMR 输入                    | Host、Host-vite 与构建工具使用 `node:fs` / `node:fs/promises` 和原生工具接口 | 不经过内建 FS，不把虚拟文件通知接成源码 HMR                                            |
| 包下载与安装、manifest/lockfile、`node_modules`、安装 revisions/slots、发布入口和构建制品 | 原安装器、Package Manager、CLI 与制品工具使用原生文件系统                    | 保留原安装和发布事务，不改用 `ctx.fs()` 或 TinyBase                                    |
| 插件数据目录、Vault 加密记录/blob、TinyBase 快照、Host 私有保存文档                       | 内建 FS / TinyBase，由各领域拥有格式与提交语义                               | 数据地址不依赖源码目录、包安装路径或当前 generation                                    |
| 部署配置文件与 env 输入                                                                   | Host 平台接入读取原生文件与环境，向配置领域提交解析后的记录                  | 输入不因 saved layer 使用内建存储而搬入内建 FS；Vault 的部署输入与加密保存文件同样分开 |

“Host 侧”表示部署与代码装配职责，不要求把所有实现搬进 `@pluxel/host`：Package Manager 仍是拥有 acquisition、安装清单与发布事务的普通 Node 插件，Host 只消费其发布的 ESM 入口。安装清单即使是 JSON，也与物理制品和安装锁构成同一协议，不能因“小型结构化数据”就迁入 TinyBase。具体契约沿用 [Package Manager](../../plugins/package-manager/DESIGN.md)、[来源与 HMR](../HMR.md)。

边界必须在装配和调用处保持明确：

- `ctx.fs()` 中的 `plugins/<physicalKey>` 是**插件数据目录**，不是插件源码或安装目录。虚拟相对路径不能作为 Node import、pnpm、原生 watcher 或 driver 的磁盘路径，不增加从 `ctx.fs()` 反推 native path 的接口。
- Passthrough 只是内建数据文件系统的一个后端。应用为它指定数据根；不能把整个 workspace、源码来源根或包安装根当作插件数据根。即使数据放在同一 workspace 下，代码目录与数据目录也使用独立子树，来源扫描和 HMR 不把数据写入当作代码变化。
- 更换 InMemory/IndexedDB/Passthrough 只改变运行时数据保存，不改变源码来源、安装位置、模块解析或 HMR 行为。原生日志 sink、SQL driver、Typst CAS 等既有原生资源继续按领域契约使用原生接口，不能为统一 FS 将它们一并虚拟化，见 [FS 边界](../FS.md#完整提交与发布边界)。
- HMR 沿现有生命周期关闭旧 writer、接纳新 generation；只在 canonical Plugin node 地址不变时重用原数据。它不复制安装目录到数据目录，也不因停止、替换或卸载插件自动删除持久数据。源码包更名或入口改变造成的身份变更按显式迁移处理。

### 作者接口与包边界

- **Core 保证能力存在。** `PluginContext` 直接声明必有的 `fs`、`tinybase`，Part 和依赖视图继续绑定 owning Plugin generation；不再靠可选的 `ContextServices` augmentation。Core 普通宿主、官方 Host 与隔离 test host 都走同一固定安装和生命周期，不能只改类型或只在 preset 补装。无 Plugin owner 的 root 不获得插件数据目录或 Store，内部文档与诊断仍走宿主专用入口。
- **FS 保留上游文件接口。** `await this.ctx.fs()` 返回已有 owner 数据目录下的 ZenFS promises API；不增加文件 CRUD facade。目录由稳定 Plugin node 地址确定，插件只选择目录内的业务相对路径。插件数据文件、TinyBase 快照及 Host 私有保存文档共享本实例的一份数据后端，namespace 仍各自隔离。
- **保留两个接入方法。** `await this.ctx.tinybase.open()` 返回恢复完成的原生 Store；需要原生 schema 或初值时使用 `open(store)`，返回同一实例。`await this.ctx.tinybase.flush()` 确认保存。每个 Plugin node 一份 Store，表名只出现在原生 TinyBase API 中，不增加 Store 名、目录、persistence 声明或 CRUD 包装。未 open 不创建业务 Store 或启动其保存任务。
- **上游能力从上游导入。** `createStore`、Queries、schema 类型与 Valibot schematizer 继续从 `tinybase` 及其子路径导入，Valibot 继续从 `valibot` 导入。Core 只导出宿主桥接需要的类型和错误，不镜像上游模块。`configs.use()` 的完整 schema 校验、配置合成与领域提交保持独立，配置仍整份序列化保存。
- **通用机制一起内建。** Core 持有 FS owner view、原子文件保存、TinyBase writer、快照编解码、confirmed 文档 adapter 和统一资源关闭。沿用已有原子文档契约，供宿主集成使用；不再要求 Host 手工把 FS 转成 TinyBase backend，也不另造通用存储注册框架。Core 不反向导入 Host/Services，不静态导入 `node:fs` 或浏览器专用后端；底层 `@pluxel/context` 仍只管理同步 capability。
- **配置权威留在原领域。** HostConfigStore/coordinator 继续拥有 saved layer、SuperJSON 配置文档格式、部署覆盖、校验及 validate → save → apply；实际保存直接使用内建 TinyBase 文档。这部分依赖 Host 的理由是应用级提交与管理语义，而非 IO 或平台限制。不能让 Plugin 自行写一张 config 表绕过协调，也不为下沉序列化再增加无独立契约的 helper。

内部仍可使用现有 capability 安装机制表达 owner 和生命周期；对使用者不再存在 FS/TinyBase 的安装、卸载或缺失状态。资源管理继续沿用现有 effects 与 drain。

### Host 装配与版本

- **数据后端只配置一次。** Core 构造输入提供运行时数据的文件后端选择，省略时固定为 InMemory；官方 Host 通过已有 Core 配置透传，不再并列增加一个 service 配置。Node 选择 Passthrough 并提供物理数据根，浏览器/Web Worker 可选择 IndexedDB 并提供稳定的存储名称。该配置不替代 Host 的源码来源、安装根或构建输出配置。内存模式只确认内存保存，不能自动探测一个目录或用随机名称冒充重启恢复。
- **恢复与关闭统一接线。** 内建层准备文件后端后，Host 恢复私有配置/运行策略，再启动 Plugin；关闭先结算领域提交与 TinyBase writer，最后关闭文件后端。配置与运行策略默认使用内建文档，不要求应用重复写 `TinyBaseHost.documents('config'/'state')`。已有嵌入式宿主的显式文档 adapter 保留其借用语义，不成为插件 API。准备或恢复失败明确报错，不能降级成内存成功。
- **内建不触发数据搬迁。** 仅改变包与安装归属时保留现有 owner 地址、快照格式和物理 key；目录中的历史 `services/tinybase` 名字不是运行时 service 依赖。确需改变持久格式或位置时另做显式转换，不让一次 API 调整造成数据丢失或默认重置。
- **版本事实归 Core。** Core 声明精确 TinyBase runtime 依赖，Host 与构建工具以该版本为共享基准，复用现有版本接纳和原生模块绑定。与托管 Store 互操作且直接导入上游的插件声明同版 peer/dev；只使用 `configs.use()` 或内建 `open()` 的包不因内建增加直接 TinyBase 依赖。独立计算的私有副本保持隔离，不用于创建托管 Store。

Cap’n Web 的可复用原则是“作者使用上游 API，框架拥有跨边界互操作契约与版本事实”。当前 Cap’n Web 的所有者仍是 Workbench，并非 Core 内建能力；本次不据此把网络连接、Workbench 或 Vault 一起提升为必装组件。

### 实施与验收

先将可移植的 FS/TinyBase 实现与固定能力安装移入 Core，隔离具体平台后端入口；Host 复用内建私有文档并保留配置协调。再删除 Services 中 FS/TinyBase 的 service factory、公开 token 和可选 augmentation，改用固定能力。同步修改所有已知调用方，包含 Vault 的 FS 接入、Wretch/Fonts 的缺失服务分支、Logging/Management 的文档依赖、模板、演示与测试；保留真实失败处理。旧入口不保留兼容 alias。

共享版本所有者与消费者识别同步调整：不能再依赖 `@pluxel/services/tinybase` import 判断互操作，也不能把任意 `@pluxel/core` import 误判为插件直接依赖 TinyBase。发布入口、开发绑定、静态制品和独立安装必须消费同一版本事实。

迁移只处理运行时数据接入，不机械替换仓库中的 `node:fs`。审查 Host/Host-vite 的来源读取与 watcher、CLI/Package Manager 的安装事务、构建和原生制品加载，确认它们没有新增内建 FS 依赖。验收应证明：内建 FS 换后端不改变代码加载/安装；数据写入不触发源码 replacement；真实源码 HMR 仍走现有协调器并保留同 node 数据；安装完成与插件应用仍报告各自阶段，不因数据保存成功而伪称代码已生效。

验收覆盖：无 Services 的 Core/test host 可用；Plugin/Part/fork 与 caller view 归属正确；未使用不创建业务 Store；Node 文件及真实浏览器、Web Worker 的 IndexedDB 重开恢复；配置恢复不依赖 Plugin 启动；失败、撤回、显式恢复及关闭顺序不变；共享异版拒绝与私有副本隔离。浏览器/Worker 构建不得加载 Node 接入或依赖 Node polyfill；平台特定后端仅在所选入口加载。真实页面和 Worker 的完整配置、Store、FS 链路另有回归，不以无 Node globals 的 VM 用例或单独 FS 浏览器用例替代。公开用法、工程边界、导航、生成项目 AGENTS 与 Tegami 已同步，执行证据见迁移记录。

## Host saved-layer 跨实例配置同步

首版解决同一应用多个实例共享配置：一个固定写入节点发布已经保存的完整快照，各副本独立校验、保存和应用。保留 SuperJSON、现有 Plugin node 配置记录与一份 Host 配置文档，`configs.use()` 不变。以下是待实施设计，不是当前运行时保证。

### 最小范围与所有者

- **应用显式装配。** Host 部署输入固定同步范围、写入节点及连接身份；普通单实例不创建连接。副本只接受已授权写入节点的快照，不接纳任意 peer 自报的角色或 namespace。首版由部署保证唯一写入节点，不选主、不自动接管、不接受离线管理写入。
- **只复制 saved layer。** 本地 initial/file/env 继续参与配置合成，不复制 normalized output 或 effective 配置。Plugin 业务 Store、Vault、运行策略、Logging policy 和 Management 布局保持原有归属；同步配置不创建 fork、不启动插件，也不安排任务。
- **沿用稳定地址。** 数据 owner 使用现有 [PluginNodeAddress](../PLUGIN_IDENTITY.md#address-schema)，实例身份只用于连接与应用回报。首版限定同一应用发行制品的多个部署，按现有制品事实核对适用范围，不新增通用 schema 指纹或兼容协商框架；地址相同不能代替兼容检查，异版滚动升级另行设计。
- **Host 保留配置权威。** 角色检查覆盖所有 saved-layer 写入路径，包括 Host、Management、控制台、低层配置 mutation 和 fork 配置清理。副本遇到会修改配置的复合操作，须在停止插件或删除元数据之前拒绝。副本的本地持久化仍需可写，不能用 `storage.mode: 'readonly'` 表示“禁止管理写入”。

### 一份快照、一份持久版本

复制单元包含协议格式、应用同步范围、配置历史标识、单调序号和完整 saved 文档。历史标识由 Host 在初始化该份权威数据时生成并保存，正常重启不变；它用于区分备份恢复或权威数据重建后的不同历史，不是插件 ID、进程 ID 或选举任期。

版本元数据与配置正文必须在同一次原子文档提交中保存，不另写 sidecar，不拿 Core 本地 revision 或 TinyBase writer revision 代替。启用复制时涉及的持久格式变更按本页已有的显式转换规则处理，运行时不猜测旧文档的历史和版本。

写入节点在现有 coordinator 队列内检查调用方的预期历史与序号，构造并校验候选，再统一提交完整文档；保存确认后才发布版本，配置没有变化不空增序号。参与写入的 Management 和控制台同步消费版本信息，不另建配置业务 API。不同插件的并发编辑也可能产生整份快照版本冲突，这是首版保留简单存储的明确取舍。

所有 saved-layer 变更都通过同一个 Host 提交点推进版本。管理回执保留本地保存与应用结果，远端进度另报；保存成功不表示任一副本已经确认。回执丢失后可以查询当前权威状态，但没有持久请求日志就不能保证辨认已经被后续修改覆盖的原请求结果；此时明确为未知，不承诺 exactly-once 或自动重放。

### 副本接纳与配置应用

同步接入由 Host 组合拥有连接和鉴权，配置语义继续由 HostConfigStore/coordinator 拥有；Core 的内建 TinyBase 不拥有网络、复制角色或配置发布权。复用现有传输与资源释放能力，不强制安装 Workbench 或交出交互式 Management 管理权限；原子文档读写契约不扩张为同步框架。

副本通过 Host 内部的完整 saved-layer 接纳入口处理候选，不能循环调用管理 patch：

1. 在同一协调器边界核对来源、范围、历史、版本、格式、地址及预算。同一历史的旧版本丢弃；同版本同正文不重新校验或通知，同版本不同正文报错；不同历史拒绝自动切换。正文沿用源端确认的序列化文本，不从本地合成配置重新生成。
2. 以整份 saved 文档替换候选层，缺失记录或字段表示删除，确保 reset 不被误作 merge。保留本地 initial/file/env；复制更新的是它们下面的 saved layer，不走禁止管理用户修改 env 路径的检查，也不改变 env 的实际权威。内部接纳入口不暴露为通用绕过权限的方法。
3. 根据同一份声明事实，验证所有受影响且已知 schema 的 effective 候选，每份候选只执行一次完整 Valibot 校验并保留 normalized output。任一失败则整份拒收，旧文档与配置权威不变，不报告部分记录已同步。未安装或未创建 fork 的 owner 记录保留原文并报告目标不可用；以后 admission 时校验，不因此创建节点或伪称通过业务校验。
4. 将版本与完整正文一次持久化，确认后才发布已暂存的配置快照，再按现有通知规则应用变化的插件。已知但未运行的节点为 deferred；listener 失败沿用 `saved-not-applied`，不回滚 desired 配置，也不靠重复收到同一快照重放副作用。显式重启或后续真实配置更新沿用现有恢复流程。

整份文档接纳是一个本地提交，但多个插件、多个实例的应用不原子完成。一个插件校验失败会阻止该副本接纳整份新快照；若未来实际出现隔离更新需求，再评估按节点拆文档，不预设第二套存储模式。保存失败仍保留后端可能已经写入的不确定性，并遵守现有 Host 文档故障恢复规则，重连不得暗中重试失败写入。

观测只增加必要事实：最后观察到的源端版本、本机已保存的复制版本、当前连接状态；各节点继续报告本地 desired/applied revision 和错误，不把两类 revision 混用。实例重启后重新建立应用进度，断线后的旧报告不能当作当前已同步的证明。

### 启动、重连与历史切换

- **先有 Host，再启动插件。** 连接地址、身份和角色来自部署输入，不读取待同步插件的配置。副本先恢复本地缓存并准备 Host 服务；无有效缓存时，在首次 Plugin admission 前拉取并接纳快照。该过程使用固定候选声明校验，不调用会先触发 `host.start()` 的管理入口，也不等待依赖这些配置的 Plugin 提供传输。缺失缓存不自动写出带权威含义的默认空快照。
- **缓存必须有确认来源。** 只有范围、历史、版本、正文均有效且通过本地校验的已保存快照可用于离线启动；无有效缓存时首次同步失败，启动明确失败并清理资源。已有缓存时允许离线运行并报告状态，副本持续拒绝管理写入。
- **连接后追上最新状态。** 读取当前版本与登记更新订阅须消除遗漏窗口，不能先读后订阅却假设中间不会提交。通知只提示有更新，重连拉取完整最新快照；不用增量日志。每个副本至多一个在途接纳和一个待处理的最新快照，可跳过中间版本，不积压无界队列。
- **关闭沿用现有生命周期。** 断开或关闭取消读取、订阅与未接纳候选；已接纳的持久化按现有 drain 结算，取消不撤销已确认提交。连接、等待和更新回调均归 Host 释放，不额外公开 Plugin 同步 handle。
- **历史变更需要显式维护。** 迁移写入节点但完整保留当前数据时可延续历史；恢复旧备份或重建权威数据时创建新历史，副本显式重新绑定。任何切换都须先确认旧写入方停止，历史标识不能替代隔离旧写入方。首版不保证写入节点失联时可修改配置，也不保证其持久化存储丢失后已确认写入仍可恢复。

### 实施顺序与验收门槛

先在 Host 内完成“版本与正文一起提交、完整候选校验、保存后发布”和副本写入权限，再接入连接与首次启动路径，最后进行真实双进程验收。现有启动顺序是 config/state ready → service prepare → Plugin start，不能靠存储 getter 监听或替换文件绕过协调器。仅增加网络传输或通过现有单 Host 测试不足以完成此功能。

以下为验收门槛；已执行场景和仍未验证的故障窗口分别记在[迁移记录](../TINYBASE_MIGRATION.md)，不将隔离故障注入扩大为断电保证：

| 场景                                                | 必须观察到的结果                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| 修改、reset、删除 owner 记录及不同 env 覆盖         | saved 文档完整替换，本地覆盖保留；不复制默认值或 normalized output |
| 无缓存首次连接、已有缓存离线启动、写入节点离线      | 没有启动依赖环或默认空快照；按缓存策略启动或明确失败，副本不能写   |
| 建立订阅时提交、重复、乱序、慢副本与断线重连        | 不漏最后一次提交、不回退、不重复通知；在途与待处理候选数量有界     |
| 两个旧版本管理修改、管理回执丢失                    | 冲突拒绝；可以查询当前状态，无法辨认原操作时保留未知结果           |
| 主节点保存前后、广播前后及副本保存后应用前退出      | 未确认候选不发布；已保存的正文与版本一起恢复；重启重建应用进度     |
| 任一已知配置校验失败、目标未安装、listener 失败     | 分别为整份拒收、保留待用记录、已保存未应用；不混淆阶段或虚构回滚   |
| 副本后台保存失败、管理写入或 fork 删除              | 故障保持可观察且不暗中重试；越权操作在产生领域副作用前拒绝         |
| 错误范围/来源/制品/格式、同版本不同正文、旧备份恢复 | 不覆盖既有配置；历史变更需要显式重新绑定，旧连接不能恢复旧权威     |

配置复制首版不要求 MergeableStore，也不改变 `flush()` 的本地后端确认含义。确有允许多方写入、接受最后写入胜出的业务状态时，再单独接入上游 [MergeableStore](https://tinybase.org/guides/synchronization/using-a-mergeablestore/) 与 [Synchronizer](https://tinybase.org/guides/synchronization/using-a-synchronizer/)，保存其合并元数据并定义领域冲突规则。任务分工、消费归属和自动故障接管需要各自的实际用例，不随配置复制一并承诺。
