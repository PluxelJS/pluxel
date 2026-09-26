# Plugin 系统：执行路径与职责

本页解释一份 Plugin 声明如何成为运行能力。跨领域规则见 [工程不变量](DESIGN_PRINCIPLES.md)，具体修改任务只在 [工程导航](README.md) 分流。插件作者从[用户指南](../docs/getting-started/index.md)开始。

## 唯一执行路径

```text
Plugin / PluginPart 源码声明
  → Rolldown / Vite 共享语义分析，生成 definition、依赖、config 与 Part facts
  → Host 汇集 immutable catalog candidate，并结合持久策略与 session intent
  → Core prepare graph；接纳后停止旧 generation、确认 graph、启动新 generation
  → Host 与 Services 完成资源 settlement，发布完整运行事实
  → 可选 Workbench 发布业务能力的 UI 投影
```

| 所有者              | 持有的事实与责任                                          | 边界                                   |
| ------------------- | --------------------------------------------------------- | -------------------------------------- |
| Context             | 同步、严格惰性、固定 shape 的 capability kernel           | 不管理 IO 或 Plugin lifecycle          |
| Core                | identity、DI graph、generation、effects、配置事实         | 不决定来源、持久化、HTTP 或进程策略    |
| Host                | 服务准备/关闭、catalog、运行意图、配置持久策略、协调事务  | 使用 Core 唯一的 graph/lifecycle       |
| Services            | 显式安装 HTTP、Commands、存储、Logging、Management 等能力 | 每项能力拥有自己的资源与 owner view    |
| Host-dev / Rolldown | Vite 开发驱动、语义编译、源码查询与发行制品               | 构建工具不成为生产业务服务             |
| Workbench           | publication、layout、opened targets、Shell/renderer       | 投影业务能力，不持有业务状态或业务依赖 |

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

Host 在 root 创建前固定 Context 服务集合；Plugin 不安装 capability。Core 固定提供 logger、effects、events 和配置事实，其他服务由应用显式组合。`ctx.events` 是可经 module augmentation 扩展的 host 广播；沿 dependency edge 的固定协议使用具名 `EvtChannel` 属性。事件类型声明本身不建立 graph dependency。

Workbench 通过可选 `ctx.workbench?.publish()` 接入。业务 Plugin 不依赖 UI 是否安装；页面 API 使用 fresh Cap’n Web `RpcTarget`，Attachment 的 API/renderer 由 provider 拥有、placement 由 consumer 拥有。

## 从声明到运行：三个不同对象

| 对象       | 身份与寿命                                     | 变更时的处理                                     |
| ---------- | ---------------------------------------------- | ------------------------------------------------ |
| definition | canonical entry + 唯一 root named export       | replacement 覆盖该 definition 的全部已物化 nodes |
| node       | definition 的 default 或 fork 部署             | 拥有配置、依赖选择与运行意图                     |
| generation | node 的一次 instance、Context、gate 与 effects | restart/replacement/stop 结束整代资源            |

Address 用于持久化与 RPC，Slot 是进程内 interned key。class name、displayName、物理目录和 constructor object 都不是身份。具体 Plugin package 只有根入口 `"."` 可以承载 Plugin；重复 root 名称、plugin-bearing subpath 与跨包 re-export 均拒绝。完整 codec/source-space 规则见 [PLUGIN_IDENTITY](PLUGIN_IDENTITY.md)。

Toolchain 是 Plugin 源码入口。语义事实包含 root exports、required/optional edges、forkability 与 config/Part 声明；未 lowering 的 Plugin 必须 fail-fast。ABI 和源码规则由 [TOOLCHAIN](TOOLCHAIN.md) 拥有。

## 更新与失败如何结算

Host 分开持有 catalog availability、durable auto-start policy 和 session intent；Core 持有 committed graph 与 running generations。来源只提交 candidate，协调器统一计算 effective graph。

prepare 的结构拒绝保留旧事实。第一次关闭旧 generation admission 后，操作必须报告真实 stop/start outcome，不能复活旧 instance。Provider 先启动、consumer 先停止；required failure 只阻塞 dependent closure。`init()` 返回的 cleanup 与显式资源统一进入 generation effects，没有第二个 Plugin teardown hook。

Constructor dependency facade 固定 provider generation 和 caller Context。Part occurrence、缓存与并发调用不能串 owner；任一相关 generation 撤回后，旧 facade 不能继续调用。可调用 surface 与 Context 规则见 [CORE](CORE.md)，完整 commit/late-init/publication 语义及测试证据见 [生命周期矩阵](CORE_LIFECYCLE_SEMANTICS.md)。

## 服务、来源与宿主策略

`standardServices()` 组合 HTTP、Commands、NodeModules、Workers 和 Persistence；`servicesPreset()` 再选择 Vault、Logging、Management、管理命令及可选 Workbench。Database 由应用单独选择。安装顺序与 root/service/generation 资源边界见 [HOST](HOST.md)。

固定 imports 与动态来源共用应用声明、catalog 和运行意图。动态来源只发布/删除普通 ESM entry；Package Manager 是显式安装的普通 Plugin，自己拥有 acquisition、registry、安装状态和 UI。生产来源加载与开发 HMR 各有边界，不能从“支持动态来源”推断“支持生产热替换”。

宿主拥有进程退出、部署和健康策略；插件不声明这些策略。查源码使用 [inspect](../docs/development/inspection.md)，操作现有应用使用 [devconsole](../docs/development/dev-console.md)，隔离回归使用 [Plugin tests](../docs/development/testing.md)。
