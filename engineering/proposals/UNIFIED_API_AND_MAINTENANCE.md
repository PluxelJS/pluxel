# Pluxel 统一接口与维护路径

状态：已实施并通过完整工作区、独立安装及公开声明验收。2026-11-15。固定模型的 agent 任务对照实验保留为独立研究。

本轮覆盖地址提供者、Host 节点引用、控制材料、CLI 同步与回执、领域结果、协议所有权、公开入口、作用域释放和状态投影。已落地的契约由下列领域页维护，本页不再保留旧 API 对照或第二份拟议接口。

| 范围                                                           | 当前权威入口                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| definition、node、generation 与精确地址证据                    | [Plugin Identity](../PLUGIN_IDENTITY.md)                                                                                  |
| class / 生成地址提供者、类型关联、契约检查、材料 format 2      | [Plugin Control](../PLUGIN_CONTROL.md)、[公开控制指南](../../docs/development/plugin-control.md)                          |
| 配置 owner、启动策略、provider、部署输入绑定                   | [Host 配置](../../docs/host/configuration.md)、[Host 工程边界](../HOST.md)                                                |
| 按 canonical entry 同步、准确 module/exportName、发现 revision | [公开控制指南](../../docs/development/plugin-control.md)、[CLI 工作区](../CLI_WORKSPACES.md)                              |
| 本地 / 上传执行、统一 JSON、v3 receipt、原 owner 查询          | [自动化脚本](../../docs/development/scripts.md)、[Dev Console](../DEV_CONSOLE.md)、[Agent Workflow](../AGENT_WORKFLOW.md) |
| Host 结果判定、共享报告 parser、管理 RPC 与 UI                 | [Management](../../docs/host/management.md)、[Host 工程边界](../HOST.md)                                                  |
| 执行入口、标准释放、依赖隔离                                   | [Agent Workflow](../AGENT_WORKFLOW.md)、[Plugin Control](../PLUGIN_CONTROL.md)                                            |
| 单节点精确状态、同源投影与性能验证                             | [Host 工程边界](../HOST.md)、[状态基准](../../packages/host/bench/status.bench.mjs)                                       |
| 生成项目、skill 与文档路由                                     | [文档职责](../DOCUMENTATION.md)、[工作区工具链](../../docs/development/workspace-toolchain.md)                            |

## 验收与能力边界

地址与调用证据分开：原值保留 constructor 或控制摘要，spread / Object.assign 副本拒绝；JSON 或显式 parse 得到普通地址，不能恢复实例调用。JavaScript 无法识别作者将普通地址强行断言为类型化地址；动态配置仍按真实 Schema 与 Host 权限执行，不承诺复原已丢失的摘要。源码 class 保留实际实例类型，完整配置输入、输出与 Schema 描述由生成入口提供。

回归围绕同名插件与 fork、动态发现及同步后调用、Vite / Node 加载、HMR 旧证据、丢失接纳响应与原回执、统一失败报告、词法关闭与排空、Schema 与真实调用方展开。具体测试和实际门禁结果由上述领域页记录；不以示例能编译代替独立安装和真实运行。

本轮不增加跨 isolate 的业务调用后端、离线 Schema validator、查询 DSL 或状态缓存。后续能力继续由[控制 SDK 方向](plugin-control-sdk/README.md)维护；fork 模型去留由[独立讨论](REMOVE_PLUGIN_FORKS.md)决定。

## 尚待独立研究

需要固定模型、固定仓库快照和相同任务，对改动前后进行 agent 任务实验，记录查阅文件、API 选择、失败重试、错误目标操作、完成结果与 token 消耗。功能回归、类型提示、代码行数和本轮协作过程均不能替代这一对照实验；当前不声称已经证明 token 消耗或任务成功率改善。

实验沿用原定八类任务：同名插件配置与 CAS；动态安装后发现、同步及业务调用；同一操作用于 Vite 与上传；HMR 后旧证据拒绝及恢复；断开提交后查询原回执；新增 Host 报告分支；自定义 scope 正常、抛错和取消释放；从配置字段定位 Schema、调用方与检查入口。实验结果再决定是否需要扩展查询、缓存或生成能力，不以研究尚未完成为由保留等价的旧 API。
