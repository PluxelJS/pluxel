# Plugin 系统：执行路径与职责

本页解释一份 Plugin 声明如何成为运行能力。跨领域规则见 [工程不变量](DESIGN_PRINCIPLES.md)，具体修改任务只在 [工程导航](README.md) 分流。插件作者从[用户指南](../docs/getting-started/index.md)开始。

编译器从源码提取依赖声明，Core 根据已加载的插件定义构建运行图。Vite 的模块图负责开发期源码失效与重新求值。设备或 Worker 的新 JS 执行环境可以直接用已编译定义启动；插件文件何时安装、采用哪个版本、何时销毁引擎，都由应用所有者决定。 [跨平台契约](../docs/host/runtime-portability.md#开发与交付)

## 唯一执行路径

```text
Plugin / PluginPart 源码声明
  → Rolldown / Vite 共享语义分析，生成 definition、依赖、config 与 Part facts
  → Host 汇集 immutable catalog candidate，并结合持久策略与 session intent
  → Core prepare graph；接纳后停止旧 generation、确认 graph、启动新 generation
  → Host 与 Services 完成资源 settlement，发布完整运行事实
  → 可选 Workbench 发布业务能力的 UI 投影
```

| 所有者               | 持有的事实与责任                                                     | 边界                                              |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| Context              | 同步、严格惰性、固定 shape 的 capability kernel                      | 不管理 IO 或 Plugin lifecycle                     |
| Core                 | identity、DI graph、generation、effects、配置事实与固定 Context 能力 | 宿主选择来源、领域保存与进程策略                  |
| Host                 | 服务准备/关闭、catalog、运行意图、配置持久策略、协调事务             | 使用 Core 唯一的 graph/lifecycle                  |
| Services             | 显式安装入站 HTTP、Commands、Pg、Management 等能力                   | 每项能力拥有自己的资源与 owner view               |
| Host-vite / Rolldown | Vite 执行与更新、语义编译、源码查询与发行制品                        | native 不加载编译工具；生产 Vite 显式持有执行工具 |
| Workbench            | publication、layout、opened targets、Shell/renderer                  | 投影业务能力，不持有业务状态或业务依赖            |

Services 组合入口可选择 Workbench，Workbench 消费 Services 叶子入口；实际模块依赖和导出约束由 [GOVERNANCE](GOVERNANCE.md) 维护。

## Plugin 作者模型

required dependency 只写 constructor，工具链从 root import provenance 生成 edge。optional integration 使用 non-exported module-level `definePluginRef<T>()`，并在 `init()` 中直接调用 `plugins.use(Ref, callback)`；它只观察 host catalog，不加载或安装 provider。

内部组成按所需所有权选择：

| 需要                                     | 使用                                    | 生命周期                                       |
| ---------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| 普通业务拆分                             | 对象或函数                              | 调用方拥有                                     |
| 只需一组 cleanup                         | owner effects scope                     | 随 owner 释放                                  |
| 派生 config、Context、effects 或嵌套组成 | `PluginPart`，subclass 内 protected DSL | 共享 owning Plugin 的 graph、generation 与事务 |
| 独立启停、失败传播、replacement 或治理   | Plugin                                  | 独立 node/generation                           |

Part occurrence 有 config/diagnostic path，没有独立 node、override 或 lifecycle。Part 对外只暴露业务 API，不暴露 root owner、Context attribution path 或 service locator。每个具体 Plugin/Part 最多一个 `configs.use(ObjectSchema)` field；Part schema 按 occurrence path 聚合为同一 Plugin record。

Host 在 root 创建前固定 Context 服务集合，应用显式组合扩展服务。Core 提供 logger、effects、events、配置事实、TinyBase、Vault 和受管出站 HTTP。文件能力由 Host 装配提供，`ctx.events` 是可经 module augmentation 扩展的 host 广播。沿 dependency edge 的固定协议使用具名 `EvtChannel` 属性，类型声明本身不建立 graph dependency。 [Host 装配](HOST.md#服务与资源) · [出站 HTTP](OUTBOUND_HTTP.md)

Workbench 通过可选 `ctx.service(WorkbenchRef)?.publish()` 接入。业务 Plugin 不依赖 UI 是否安装；页面 API 使用 fresh Cap’n Web `RpcTarget`，Attachment 的 API/renderer 由 provider 拥有、placement 由 consumer 拥有。

## 从声明到运行：三个不同对象

| 对象       | 身份与寿命                                     | 变更时的处理                                     |
| ---------- | ---------------------------------------------- | ------------------------------------------------ |
| definition | canonical entry + 唯一 root named export       | replacement 覆盖该 definition 的全部已物化 nodes |
| node       | definition 的 default 或 fork 部署             | 拥有配置、依赖选择与运行意图                     |
| generation | node 的一次 instance、Context、gate 与 effects | restart/replacement/stop 结束整代资源            |

Address 用于持久化与 RPC，Slot 是进程内 interned key。class name、displayName、物理目录和 constructor object 都不是身份。具体 Plugin 可以由显式公开的包根或子路径承载；一个 constructor 必须只有一个权威入口和具名导出，重复导出与跨包 re-export 均拒绝。完整 codec/source-space 规则见 [PLUGIN_IDENTITY](PLUGIN_IDENTITY.md)。

Toolchain 是 Plugin 源码入口。语义事实包含 root exports、required/optional edges、forkability 与 config/Part 声明；未 lowering 的 Plugin 必须 fail-fast。ABI 和源码规则由 [TOOLCHAIN](TOOLCHAIN.md) 拥有。

## 更新与失败如何结算

Host 分开持有 catalog availability、durable auto-start policy 和 session intent；Core 持有 committed graph 与 running generations。来源只提交 candidate，协调器统一计算 effective graph。

prepare 的结构拒绝保留旧事实。第一次关闭旧 generation admission 后，操作必须报告真实 stop/start outcome，不能复活旧 instance。Provider 先启动、consumer 先停止；required failure 只阻塞 dependent closure。`init()` 返回的 cleanup 与显式资源统一进入 generation effects，没有第二个 Plugin teardown hook。

Constructor dependency facade 固定 provider generation 和 caller Context。Part occurrence、缓存与并发调用不能串 owner；任一相关 generation 撤回后，旧 facade 不能继续调用。可调用 surface 与 Context 规则见 [CORE](CORE.md)，完整 commit/late-init/publication 语义及测试证据见 [生命周期矩阵](CORE_LIFECYCLE_SEMANTICS.md)。

## 能力归属边界

消费者侧的 `ctx.service(Service)` / `defineServiceRef<Service>()` 与 `constructor(dep: Plugin)` / `definePluginRef<Plugin>()` 外形接近，但它们属于不同的所有权与生命周期层级。规划新能力时按运行期事实分层，不以调用写法相近为由混用：

| 维度           | Core 内建设施                                                                 | Host Service（非内置服务）                                                                    | Plugin                                                                                         |
| -------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 拓扑与寿命     | 挂在 Context 上，随 Core root 建立与排空                                      | 在 DI 图外；创建 root 前固定集合，先于全部 Plugin `prepare()`、后于全部 Plugin 释放           | 在 DI 图内；有 `definition → node → generation`，支持独立启停、重启、动态加载与 HMR            |
| 变更与故障半径 | 部署期 `coreConfig` 决定，改配置须重建 Host                                   | 准备失败阻塞整个 Host 启动；替换实现或改配置须重建 Host                                       | 启动失败仅阻塞依赖它的下游闭包；热更与重启只级联影响下游                                       |
| 平台绑定与特权 | 由 Core/Host 装配注入基础后端，面向全部宿主                                   | 可注入平台原生载体/绑定（如 D1、Node listener、Worker 池、原生宿主 API）并访问真实 `ctx.root` | 消费宿主提供的服务与设施，保持跨平台可移植性，不持有 `ctx.root`                                |
| 插件生态能力   | 自身即为底座能力                                                              | 无 `configs.use()`、无 plugin-owned 数据库句柄、无独立 Workbench 发布节点                     | 直接使用 `configs.use()`、`envBindings`、托管 `Sqlite`/`Pg`、`WorkbenchRef` 发布管理页         |
| 多实例与多态   | 单一 Core 设施                                                                | 同一个 Service token 在一个 Host root 内全局唯一（重复安装报 `DUPLICATE_SERVICE`）            | 支持 `forkable` 多节点隔离，以及 `abstract class` + `providerDefaults` / `dependencyOverrides` |
| 典型代表       | `ctx.logger`、`ctx.fs`、`ctx.tinybase`、`ctx.vault`、`ctx.wretch`/`ctx.fetch` | `Elysia`、`Pg`、`Sqlite`、`Commands`、`NodeModules`、`Workers`、`Management`、`Workbench`     | `Cache`、`Rates`、`Redis`、`Storage`、`Auth`、`Permissions`、`Fonts`、`PackageManager`         |

选择归属遵循以下判断规则：

- **归入 Core 内建设施**：几乎所有宿主与插件都会直接碰到的基础原语，或需要部署层统一收口的全局边界控制（例如原 `Wretch` 插件因属于全宿主出站网络策略与平台 Fetch 接入边界，已迁入 `coreConfig.http` 与 `ctx.wretch`/`ctx.fetch`）。
- **优先设计为 Host Service**：需要按运行平台在启动边界注入原生驱动、绑定或物理载体；必须在任何插件启动前就绪且不因业务插件故障而不可用（如入站路由、命令根目录、管理面与 Workbench）；需要访问 `ctx.root` 治理全宿主；并且自身不需要 Valibot 受管配置表单、独立 Workbench 页面、多实例 fork 或动态热替换。
- **优先设计为 Plugin**：领域语义存在多种流派或可替换策略（如缓存/限流后端、权限模型、认证实现）；自身依赖托管服务并形成「配置 schema + 持久化 + 管理 UI」闭环；需要 `forkable` 多节点隔离、抽象令牌覆写、动态来源安装或开发期独立 HMR；或希望缺失与故障通过 DI 图显式阻断下游（fail-closed）而不拖垮整个 Host。
- **灰区模式——薄 Service 插槽 + 重 Plugin 实现**：当宿主入口或管线需要感知某项能力，而具体策略、配置、凭据/存储与 UI 应保留在插件生态内时，在 Host Service 只留极薄的协议插槽，由普通 Plugin 在 `init()` 中接入并随 generation effects 自动撤回。典型先例是 `ManagementAccess` 服务插槽与 `@pluxel/plugin-auth`（`AuthPlugin`）；需要为底层设施附加独立管理界面时，也采用配套 Plugin（如 `@pluxel/services/plugins` 中的 `VaultAdminPlugin`），不让 Service 反向承担插件 UI 职责。
- **应用私有服务例外**：垂直产品在自己的专属 Host 中，若某能力是整个应用的不可关闭启动前提（例如应用私有数据库或强绑定宿主入口管线的原生能力），可在应用 `prepare()` 中准备并作为自定义 `HostService` 暴露；此选择明确放弃插件配置、fork、HMR 与 DI 图可见性。面向多应用复用的生态能力默认优先设计为 Plugin。

## 服务、来源与宿主策略

Node 的 `servicesPreset()` 组合入站 HTTP、Commands、NodeModules、Workers、Management、管理命令及可选 Workbench。`workbench: false` 保留管理能力，定制宿主和隔离测试直接组合单项安装器。Pg 由应用单独选择。安装顺序与 root/service/generation 资源边界见 [HOST](HOST.md)。

固定 imports 与动态来源共用应用声明、catalog 和运行意图。动态来源只发布/删除普通 ESM entry；Package Manager 是显式安装的普通 Plugin，自己拥有 acquisition、registry、安装状态和 UI。生产来源加载与开发 HMR 各有边界，不能从“支持动态来源”推断“支持生产热替换”。

宿主拥有进程退出、部署和健康策略；插件不声明这些策略。查源码使用 [inspect](../docs/development/inspection.md)，操作现有应用使用 [devconsole](../docs/development/dev-console.md)，隔离回归使用 [Plugin tests](../docs/plugin-development/testing.md)。
