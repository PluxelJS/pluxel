# Plugin 系统边界

修改框架前阅读本页与 [工程原则](DESIGN_PRINCIPLES.md)，再按改动读取一个领域文档。插件作者从[用户指南](../docs/getting-started/index.md)进入；查源码用 [inspect](../docs/development/inspection.md)，操作现有应用用 [devconsole](../docs/development/dev-console.md)。

## 唯一执行路径

```text
Plugin / PluginPart 源码声明
  → Rolldown / Vite 共享语义事实
  → Host catalog candidate 与运行意图
  → Core 验证 graph、停止旧 generation、启动新 generation
  → Host 发布运行事实与所选 Services
  → 可选 Workbench 投影
```

| 所有者              | 负责                                                     | 不负责                            |
| ------------------- | -------------------------------------------------------- | --------------------------------- |
| Context             | 同步、严格惰性、固定 shape 的 capability kernel          | IO、prepare/dispose、Plugin graph |
| Core                | definition/node、DI、generation、effects、配置事实       | 来源发现、持久化、HTTP、进程策略  |
| Host                | 服务准备/关闭、catalog、运行意图、配置持久策略、协调事务 | 第二套 graph 或 lifecycle         |
| Services            | 显式安装 HTTP、Commands、存储等领域能力                  | 隐式修改 Plugin 作者模型          |
| Host-dev / Rolldown | 开发驱动、编译、源码查询、发行制品                       | 生产运行期业务服务                |
| Workbench           | publication、layout、opened targets、Shell/renderer      | 业务状态与业务依赖                |

依赖约束针对实际模块入口；Services 组合入口可选择 Workbench，Workbench 只消费 Services 叶子入口。完整依赖与导出规则见 [GOVERNANCE](GOVERNANCE.md)。

## Plugin 作者模型

- required dependency 只在 constructor 声明；工具链从 root import provenance 生成 edge。
- optional integration 使用 non-exported module-level `definePluginRef<T>()` 与 `init()` 中直接的 `plugins.use(Ref, callback)`。它观察 catalog，不加载或安装 provider。
- 普通内部逻辑用对象/函数；cleanup 分组用 effects scope；需要派生 config、Context、effects 或嵌套组合时用 `PluginPart`；独立治理单元才成为 Plugin。
- Part 只通过 protected DSL 组合，共享 owning Plugin 的 graph、generation 与事务。Part occurrence 有 config/diagnostic path，没有独立 node、override 或 lifecycle。
- 每个具体 Plugin/Part 最多声明一个 `configs.use(ObjectSchema)` field；Part schema 按 occurrence path 聚合成同一 Plugin record。
- Plugin 不在 module evaluation 或 `init()` 中安装 Context capability。Host 在 root 创建前固定服务集合；缺失可选服务不安装 property 或空成功 facade。
- Plugin 业务能力不依赖 Workbench；UI 只通过可选 `ctx.workbench?.publish()` 发布。

Toolchain 是源码入口。未 lowering 的 Plugin 必须 fail-fast，不能从 class name、reflection 或 constructor identity 恢复事实。声明规则、ABI 和构建/查询共享边界见 [TOOLCHAIN](TOOLCHAIN.md)。

## 身份、图与生命周期

一个 definition 由 canonical entry + 唯一 root named export 标识；node 是该 definition 的 default 或 fork 部署。Address 用于持久化/RPC，Slot 是进程内 interned key，generation 是一次运行。class name、displayName、物理目录和 constructor object 都不是身份。

具体 Plugin package 只有根入口 `"."` 可以承载 Plugin；同一 constructor 的多个根名称、plugin-bearing subpath 和跨包 re-export 均拒绝。Source definition 由 Host source-space mapping 规范化。身份与 codec 的唯一规则见 [PLUGIN_IDENTITY](PLUGIN_IDENTITY.md)。

Host 分开持有 catalog availability、durable auto-start policy、session intent；Core 持有 committed graph 与 running generations。来源只提交 immutable candidate，协调器统一计算 effective graph。Structural rejection 保留旧事实；一旦关闭旧 generation admission，就不能把旧 instance 伪装成可回滚 snapshot。

Provider 先启动、consumer 先停止；required failure 只阻塞 dependent closure。`init()` 返回的 cleanup 与显式登记的资源共同进入 generation effects；停止先关闭 admission、abort、等待已接纳操作，再 drain。没有第二个 Plugin teardown hook。

Constructor dependency 是固定 provider generation 与 caller Context 的 facade。缓存、并发与 Part occurrence 不得串 caller/cleanup owner；不使用可变全局 current caller。可调用 surface、shape 限制与 late init/commit publication 规则由 [CORE](CORE.md) 和[生命周期证据矩阵](CORE_LIFECYCLE_SEMANTICS.md)拥有。

## 按能力继续阅读

| 改动                                      | 唯一领域说明                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| Context scope、服务 plan、启动/关闭       | [HOST](HOST.md)、[Context host 公共契约](../docs/reference/context-hosts.md) |
| 配置来源、revision、保存与运行中应用      | [CONFIG](CONFIG.md)                                                          |
| Vite namespace、候选更新、恢复与关闭      | [HMR](HMR.md)                                                                |
| 已运行应用的脚本执行                      | [DEV_CONSOLE](DEV_CONSOLE.md)                                                |
| HTTP generation app、carrier、Management  | [HOST](HOST.md#http-与管理页面)、[HTTP 用法](../docs/runtime/http.md)        |
| Commands 与 carrier publication           | [COMMANDS](COMMANDS.md)                                                      |
| Database handle、migration、outbox        | [DATABASE](DATABASE.md)                                                      |
| 日志 owner、policy、store                 | [LOGGING](LOGGING.md)                                                        |
| Workbench publication、Content、MF/Bridge | [WORKBENCH](WORKBENCH.md)                                                    |
| Shell 状态、React、workspace              | [FRONTEND](FRONTEND.md)                                                      |
| Node module / Workers                     | [Node artifacts](../docs/runtime/node-artifacts.md)                          |
| 测试宿主、编译与实际运行边界              | [TESTING](TESTING.md)                                                        |
| 冻结部署与完整性验证                      | [DISTRIBUTION](DISTRIBUTION.md)                                              |

`standardServices()` 选择 HTTP、Commands、NodeModules、Workers 和 Persistence；`servicesPreset()` 另加 Vault、Logging、Management、管理命令及可选 Workbench。Database 由应用单独选择。未选择的后端不得因同包而加载。

动态来源的边界是原子发布/删除普通 ESM entry。Package Manager 是显式安装的普通 Plugin，拥有 acquisition、registry、安装状态和 UI；Host 来源层只处理文件发现与 catalog 事务。固定 imports 与动态来源共用应用声明和运行意图，不形成两套 Plugin 模型。

当前能力与验证范围以实现和领域文档为准；[提案](proposals/README.md)只记录未采纳或未实现方向。
