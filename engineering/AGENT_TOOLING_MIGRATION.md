# Agent 工具整理迁移记录

本轮基线为 `fba3a9a0`，初始工作区干净。本文只记录调查与迁移范围；当前用法继续由 [Inspection](../docs/development/inspection.md)、[Scripts](../docs/development/scripts.md)、[Plugin Control](../docs/development/plugin-control.md) 和所属工程页维护。

| 任务                 | 原有入口                                  | 权威实现                                         | 环境要求                      | 默认入口与保留职责                                          | 已知调用方                                          |
| -------------------- | ----------------------------------------- | ------------------------------------------------ | ----------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| 选择与操作节点       | ScriptSdk.plugin(address)                 | Host agent SDK、coordinator、Core identity       | 已接纳 Host 与 run scope      | 同一引用执行配置、生命周期与实例操作                        | plugin-host/dev、上传脚本、SDK tests                |
| 取得配置与实例类型   | 生成 ./control、源码 class 地址           | Host control-manifest、Rolldown control、catalog | 匹配的控制材料或当前 class    | 标准 definitionAddress()/nodeAddress()；按原证据提供能力    | CLI sync、脚本编译、Vite 检查                       |
| 动态发现             | sdk.plugins.list() 全量状态               | Host status 与 catalog                           | committed Host                | 有界定向分页，结果 address 直接交给 sdk.plugin              | plugin-host、发现文档、Workers bridge、create smoke |
| 定位声明与扩展结构   | 仅 openProject().plugin()                 | Rolldown inspect 与 semantic pass                | 作者源码材料                  | sdk.inspect(definitionAddress)；include/partPath 沿用原语义 | SDK、Vite 项目脚本、模板                            |
| 离线工作区与文件反查 | project.plugins/overview/file/plugin      | Rolldown inspect/workspace                       | Node 与磁盘源码               | 保留 openProject scope，显选 application；应用故障时仍可查  | inspection tests、源码查询指南                      |
| 当前 Vite 能力       | ProjectSdk、sdk.dev.ctx                   | Host-vite project SDK、console                   | 所选实例及其模块图            | 继承同一 SDK；只扩展 Context 借用与源码后端                 | plugin-host/dev、create smoke                       |
| 控制材料同步         | dev sync、script sync                     | CLI script/sync、Host materials                  | 原 console 或 Management 认证 | 保留同一同步实现与实际 module/exportName                    | CLI tests、installed smoke                          |
| 跨仓源码接线         | source register/list/install/build/doctor | CLI source registry/plan/execution               | 独立 checkout 与 sources 声明 | 保留接线、构建和诊断职责                                    | source tests、开发启动检查                          |
| 文档与工作区治理     | docs、workspace setup/doctor/sync、pncat  | CLI workspace、docs reader、原生 pncat           | 当前 Git/npm 来源             | 文档读取、只读诊断和显式维护各守原入口                      | AGENTS、skill、create/plugin 模板                   |
| 运行状态、日志、HMR  | dev status/instances/hmr/run、sdk.logs    | Host-vite console、Host executor、Core Logging   | 同一 profile/root/instance    | 保留现有执行通道及 pause/apply/resume 流程                  | CLI、真实 HMR、Workbench                            |
| 原操作查询与取消     | script result/cancel RECEIPT              | CLI receipt/output、Host executor                | 原 owner、实例与请求摘要      | 保留原 receipt；unknown 与部分完成由原结果报告              | receipt tests、部署与 console smoke                 |
| 隔离 Plugin 回归     | @pluxel/test、@pluxel/test/vitest         | 生产 Host 组合与正式 lowering                    | 显式 services，await 释放     | 保留源码 nodeAddress()，在线验证另走 console                | 业务测试、create/plugin 模板                        |

## 已完成基础与本轮边界

基线已统一地址、共享 Better Result、原 receipt 与作者测试 target；单节点 status 已按索引定向查询，本轮沿用这些实现。

- Host 声明源码查询类型与后端接口，Rolldown 继续拥有唯一静态分析实现，Host-vite 安装所选实例的源码后端。
- SDK 默认查询仅返回声明 summary，扩展复用 include/partPath/signal。调用收敛到 `sdk.inspect(definitionAddress)`，default、fork 和抽象依赖均按 definition 定位，不再从运行节点句柄查询。
- Vite 后端固定 application root/entry/sourceSpaces。source 元数据标为 current-disk、execution-target、runtimeMatch: 'unverified'；查询只读，由目标环境的编辑器或 agent 打开文件。
- 未安装后端的 Node、远端或静态环境返回 inspection_unavailable，reason 为 inspection_backend_unavailable。控制声明和构建文件继续与作者源码区分。
- 发现列表移除无界全量默认；业务脚本删除多余 parse 与展示名称匹配，保留实际地址和各自调用证据。
- 批量自动启动在独占提交边界交付 managedRevision；撤销固定该证据，后续客户端写入后返回版本冲突。
- 迁移公开类型、真实脚本、CLI/Workbench/tests、自动 AGENTS、skill、create/plugin 模板与原文档路由；发行资源由 CLI 构建生成。

## 验证归属

静态分析由 inspection-project/application/workspace tests 验证；SDK 检查 Result、取消、关闭和后端缺失；发现检查分页、定向选择与同名入口；批量撤销检查后续写入冲突。公开构建消费、模板 smoke 和真实 Vite HMR 分别验证各自边界。实际命令与结果随本轮交付记录，不在本页另存长期通过清单。
