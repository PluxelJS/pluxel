# Host 配置重构：决策与验收

> 已实施，验收结算于 2026-11-05。核心契约、已知调用方和本地数据已迁移；根仓库与三个 local-projects 的完整门禁、生成应用和线上检查已通过。

本文只保留重构理由、迁移判断和验收索引。当前作者用法由 [Host 配置](../../docs/host/configuration.md#保存配置和运行策略)维护，事务与校验边界见 [CONFIG](../CONFIG.md)，创建和资源所有权见 [HOST](../HOST.md)。不在本页重复 API 类型、字段表或默认值。

## 必要决策

### 以运行意图组织入口

配置和策略首先面向本次运行：顶层 config 管 Plugin 输入，policy 管图策略与执行参数，runtime 管原生设施。取值 mode 不再同时表达存储、写权限或采用时机；文档接线留在 runtime.documents，普通应用不必填写它。没有新增 runtime.lifecycle 或通用 Store 注册表。

policy 的八项值共享一个可选 mode 映射，各项独立选择声明与保存值。这样只改启动超时或某一份名单时，不需要额外的 `{ mode, value }` 包装，也不会改变其他策略的取值。执行参数与图策略属于同一个运行意图，但保留各自真实的采用时机。

### 复用 Plugin 身份，精确到 node

`Plugin: { mode, config }` 的直觉保留为 records 中的 `{ owner, mode?, config? }`，使 constructor 有真正的值位置，避免 JavaScript 对象键退化为 class name。owner 复用现有 canonical PluginNodeAddress，不增加 nodeModule、包名或 fork 拼接 DSL。

| 场景                                   | 选择及理由                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| 源码 Plugin 或 node_modules 的具名导出 | 直接传 constructor，表示其 default node；包名不能区分同模块的多个导出                         |
| 已导入 Plugin 的 fork                  | 使用 `Plugin.nodeAddress('east')`，与 default、其他 fork 各自独立                             |
| 尚未加载的动态模块                     | 使用 canonical address 或已有引用解析器的结果；完整保留入口、导出名和 variant，不触发模块加载 |
| 全应用规则与个别例外                   | `record.mode → config.mode → declared-first`；域默认同样覆盖后来进入 catalog 的节点           |

允许 mode-only record，用来选择某个动态节点的规则；空记录和 canonical owner 重复均拒绝。default 与 fork 不继承彼此的值或 mode，复用输入用普通 TypeScript 变量表达。配置声明不代替代码来源、fork 声明或启动动作，Part 继续属于 owning node 的聚合记录。

### 原始输入、目标输出和保存结果分开

声明始终独立于保存输入，缺文档不写种子。否则一次启动就会把部署声明或 schema 默认值变成后续管理权威，使“重新继承”失去明确含义。reset 因此删除保存输入，不复制声明；env/file 也进入声明层，不再隐式锁住管理写入。

事务在同一协调队列内检查原始版本、删除路径并合并 set、校验最终有效输入、等待保存确认，再发布和通知。保留 managedInput、effectiveInput 与 config output，才能正确处理 transform、被遮盖的保存编辑及失效原始输入修复。查询不为了 defaults 额外执行 schema；来源证明不进入作者形状。

managedRevision 与 desired/applied revision 各自表达原始编辑和运行采用。Workbench 使用显示时的令牌；旧策略动作也透传 CAS，批量动作保留逐项结算。保存失败只返回已接纳输入及 unknown 回执，listener 失败仍保留已保存目标，不能伪装回滚。原始输入和 schema output 均遵守 [Core 的可移植数据边界](../CONFIG.md#toolchain-metadata)，不把带行为对象或未知 schema 异常投影成成功。

### 在唯一 root 中绑定执行参数

保存的超时、并发必须在首次创建 PluginService 前采用。Host 因此先创建唯一 root、读取文档并求值 policy，再通过内部一次性绑定确定执行参数，随后准备服务。不能靠延迟 require 却继续提前捕获旧参数，也不能创建第二个 root 或先启动后修改冻结配置。

绑定不成为作者 setter 或新生命周期 hook。运行中修改执行目标只报告需重建 Host；重启 Plugin 不改变本次 Host 的执行设施。借用文档 backend 的关闭权仍属于应用。

## 迁移判断

| 旧入口或行为                                            | 迁移依据                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| runtime.state / runtime.plugins / runtime.configRecords | 分别归入顶层图 policy、执行 policy 和 config；已知应用按实际启动意图迁移     |
| storage、memory、readonly 与取值 mode 混用              | 文档能力归入 runtime.documents；取值规则、权限、保留能力和采用回执各自表达   |
| override:false                                          | 不能机械替换为 saved-first：后者对缺少部分继承声明，旧行为由整份已有文档决定 |
| env/override 导致保存路径只读                           | 声明遮盖与写权限分开；实际策略动作仍须证明能生效                             |
| reset 恢复声明副本、裸 patch、saved boolean             | 分别改为删除原始输入、set/remove 事务和明确保存回执；表单编辑原始输入        |

config 保留 v4；state 改为只保存用户输入的稀疏 v7。v6 的真实四列原样转换，不猜测空列来自初始化还是人工选择，也不补四项执行默认值。转换保留原副本和可核对清单，运行时只读新格式，不留下兼容 reader、启动迁移或旧 alias。已有非可移植输入必须显式调整，不能靠 transform 后恰好可移植而静默接受。

作者字段、公共 exports、Management/Workbench、应用 resolver、Vite/native/browser、静态分析、生成模板与真实下游一并迁移。迁移过程的逐文件历史由 Git 保存。

## 六条验收路径

以下是可重复运行的回归入口；测试覆盖范围与整轮门禁是否通过分别记录，不以隔离 Host 代替在线应用。

| 作者路径                | 核对事实                                                                        | 回归入口                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 纯声明应用              | 输入快照、三种 mode、无初始化写回、只读与会话文档                               | [application](../../packages/host/tests/application.test.ts)、[config-store](../../packages/host/tests/config-store.test.ts)、[builtin-storage](../../packages/host/tests/builtin-storage.test.ts)                                                       |
| 局部声明加管理编辑      | 隐藏值仍可保存、路径替换/reset、CAS、保存失败与 listener 采用；表单不物化继承值 | [Host config](../../packages/host/tests/config.test.ts)、[真实 RPC 事务](../../packages/services/tests/management/management/host-input-transactions.test.ts)、[表单闭环](../../packages/workbench/shell/tests/web/config-form-loop.test.tsx)            |
| 保存优先且包含部署绑定  | 同一节点组合 code/file/env/saved，来源事实与 raw/output 分离                    | [配置层集成](../../packages/host/tests/config-layers-integration.test.ts)、[部署绑定](../../packages/host/tests/config-environment.test.ts)                                                                                                              |
| fork 与 Part 配置       | default/fork 隔离、Part 子树校验、动态目录和同包不同导出的精确 mode             | [配置层集成](../../packages/host/tests/config-layers-integration.test.ts)、[fork 控制面](../../packages/services/tests/management/management/plugin-forks.test.ts)、[静态绑定](../../packages/rolldown/tests/rolldown/static-config-environment.test.ts) |
| 借用嵌入文档            | factory 只解析一次、准备失败清理、排空 IO、不关闭共享 backend                   | [document-storage](../../packages/host/tests/document-storage.test.ts)、[embedded-launcher](../../projects/embedded-launcher/src/app.ts)                                                                                                                 |
| 保存执行参数后重建 Host | 服务准备前采用保存参数、当前执行不变、新 Host 采用目标                          | [policy-management](../../packages/host/tests/policy-management.test.ts)、[Core 一次性绑定](../../packages/core/tests/plugin-execution-binding.test.ts)                                                                                                  |

补充边界由 [ConfigInputPatch 类型检查](../../packages/host/tests/config.types.ts)、[外部文件更新](../../packages/host/tests/config-file-reload.test.ts)、[浏览器存储](../../packages/host/tests/browser-storage.test.ts)和[生成应用测试](../../packages/create/tests/create.test.mjs)维护。此次集成还发现并补上 Part schema 同时返回 value/issues 时的失败判定，以及外部较短文件被 Passthrough 读取关闭过程扩长的问题；这些修正保留在对应回归中。

## 已取得的实施证据

- 真实 plugin-host 完成 HMR apply 后应用 ready，目录含 24 个 Plugin；开发控制台验证 config 空提交不写入、过期 CAS 拒绝、policy validate 不推进 revision。应用与 Workbench HTTP 均为 200；验收结束后恢复原先停止的服务状态。脚本 runId 为 `70914715-e52d-4331-8045-42a1364c4ff5`，同实例 HMR 收尾 runId 为 `03ccb39d-eb89-4b57-8a42-fbf7e15f6867`；原 receipt 保留在本次操作记录中。这证明该次在线状态，不代表持续可用性。
- local-projects 的 rhythm、bot-new-omni、chatbot 已完成显式数据转换并保留原副本。新 Host 只读恢复分别识别 18、11、7 条配置记录；备份哈希校验通过，恢复前后文件内容哈希与 mtime 不变，未启动业务 Plugin。chatbot 未有的策略输入保持缺省，没有补写空列。
- 新生成 starter 已通过生产构建、制品完整性检查及开发/HMR 冒烟测试；这项证据独立于本仓库应用和静态模板断言。
- report-template-studio 已通过独立 compile-code 构建与 [runtime.mjs](../../projects/report-template-studio/tests/runtime.mjs)：两个外部 Node client、渲染、重启后 artifacts 保留、forget 保留用户文件及 discovery 清理均完成验证。

## 完整门禁结果

根仓库执行 `mise exec pnpm@11.28.8 -- vp run --concurrency-limit=2 workspace:verify`，135/135 任务成功。静态检查覆盖 2786 个文件的格式、1967 个文件的 lint 与类型；Host 的 231 项测试包含真实 Chromium 页面与 Web Worker 存储恢复，plugin-host 的 native 与 production-vite 启动、制品和自然 SIGTERM 回归通过。

三个下游分别执行无缓存 `workspace:verify`，并限制任务并发为 1：chatbot 34/34、rhythm 83/83、bot-new-omni 76/76。三者提交检查通过，迁移已提交推送。根仓库门禁使用仓库规定的缓存，日志中原有 skip 项保持跳过；以上结论针对本次本地工作区，不代表未执行用例或所有部署环境。

验收还修正了两项测试基础问题：Host 测试任务显式透传浏览器环境与缓存目录；被通用 data/ 忽略规则漏掉的 Typst 申请表输入补为受控的空白 fixture，原有原生分页断言保持不变。没有保留临时数据转换代码或新的后台服务。
