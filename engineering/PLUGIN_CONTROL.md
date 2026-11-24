# 插件控制材料与实例调用

控制材料把源码类型、标准地址和已接纳实现关联起来。生成器描述声明，Host 按原 identity/catalog/config/generation 验证和执行。公开调用见[插件控制](../docs/development/plugin-control.md)，脚本执行见 [Agent Workflow](AGENT_WORKFLOW.md)。

## 所有者与输入

| 所有者            | 实现                                                                                                                                       | 职责                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Host              | [`control-manifest.ts`](../packages/host/src/control-manifest.ts)                                                                          | 格式、规范编码、文件验证、标准模板                   |
| Rolldown          | [`control/`](../packages/rolldown/src/control/index.ts)                                                                                    | semantic facts、固定 TS 输入、声明闭包、配置源码描述 |
| Host catalog      | [`catalog.ts`](../packages/host/src/catalog.ts)                                                                                            | 随候选接纳不可变材料及 available/unavailable 状态    |
| Native loader     | [`control-material.node.ts`](../packages/host/src/control-material.node.ts)、[`loaded-modules.ts`](../packages/host/src/loaded-modules.ts) | 绑定实际加载 owner，保留 constructor 第一次记录      |
| Vite              | [`control.ts`](../packages/host-vite/src/control.ts)                                                                                       | 实际求值输入比对、原更新批次、type-only 失效         |
| Script SDK        | [`control.ts`](../packages/host/src/agent/control.ts)、[`sdk.ts`](../packages/host/src/agent/sdk.ts)                                       | typed target、事务内检查、同进程成员视图             |
| 材料服务 / 客户端 | [Host materials](../packages/host/src/agent/materials.ts)、[client materials](../packages/agent-sdk/src/client/materials.ts)               | committed 快照、分块读取、完整验证、原子安装         |

Core 拥有规范身份和精确地址值的弱证据注册。class/生成入口统一提供 `address()`、`nodeAddress()`、`nodeAddress(forkId)`；SDK 只接收完整 node address。证据不进入 equality、route 或持久化 key。

## 生成与声明

构建从 emit 后的声明提取公开业务成员名与已有类文档，在材料根写 `catalog.json`，与其他文件一起进入 format 3 清单校验。同步按 `kind` 和完整 definition 区分插件与服务，将选中的定义按实际导出名写入接收端目录。服务行保留访问范围。`openControl` 固定快照，先校验并读取这个目录文件；首次详细查询才读取完整材料并启动可复用的声明检查器。`inspectPlugin` 和 `inspectService` 查询成员和关联类型，`inspectConfig` 读取生成入口的配置输入、输出与按 Part 路径保留的 schema。长配置源码类型单独写入 `config.d.mts`，从原公共入口转导出。公开示例见[按需浏览业务接口](../docs/development/plugin-control.md#按需浏览业务接口)。

`createPluginControlPlugin` 接入唯一 `createPluginBuildPipeline`，在 generateBundle pre 阶段从本次 collector 的 sourceDefinitions/sourceContents 生成 `control/` 并登记 watch 依赖。tsdown exports hook 组合 customExports，同时生成开发/发布 `./control`；finalization 维护 `pluxel.control` 和原字段顺序。modules 与 standalone 使用相同格式。

`generatePluginControl` 固定 native TypeScript 的源码、声明与设置，在镜像文件系统中 declaration-only emit，不求值插件。Schema 类型见证只用于 emit。分析和 emit 继承作者 target/lib/类型配置及原路径基址；构建使用 tsdownConfigResolved 的配置路径或 false，直接调用的 `tsconfig` 省略时从 root 查找，确无配置才用默认环境。整批程序由构建 owner 选择，临时目录不能增加 DOM globals 或改变 types 解析。

emit 镜像从作者已有 `export type *`、随后已有 import 的模块中，为经 native checker 确认的原导出类型身份追加本地 type-only import，避免较大程序将生产者的推导返回类型写成无法从生产者解析的下游重导出包。见证保留 type-only 模块属性，带属性的普通值 import 保留原生处理；本地别名避开作者标识符，不新增导出或任意跨模块依赖。原星号声明、歧义诊断、stripInternal 和冻结来源检查仍由原路径执行。

实例 S 保留完整 class 声明：继承、private nominal identity、重载、this、泛型、递归关系。手写 Pick 会破坏 `self()`、`same(OriginalClass)` 等关系。`typeImports: 'package'` 引用原公开包，默认 closure 携带本地声明及 ambient roots；两者都保留公开外部类型引用，由作者提供依赖。模式由构建选择，另装原实现的物理声明拥有自己的 nominal identity。

emit 使用 `removeComments: false`，stripInternal 遵循作者配置；descriptor/Instance alias 取原 class Node.jsDoc（含装饰器前注释），成员/继承文档由原生 emitter 保留。配置 I/O 来自 Standard Schema 和 Part 树：input 保留 default 前可选项，output 表达验证/变换结果，无配置为 never。`ConfigDeclaration` 记录表达式、路径、本地源码和可选 documentation，环境引用保持表达式。注释改变材料 snapshot，结构摘要按下节规范化。

JSON 只有被公开类型引用才进入声明；配置引用原文进入源码描述与配置摘要，纯实现数据留在编译读集。消费 JSON 类型的项目需 `resolveJsonModule`。

分析、emit 或生成期间输入变化明确失败。构建拒绝产物；Vite 保留原应用更新语义并将控制材料标 unavailable，status/list issues 显示 `control_analysis_failed` 或 `control_source_changed`，修复接纳后清除。完整相关模块的公开声明必须可 emit；应用工厂若推导出无法命名的匿名服务类型，应标注 HostApplication 返回值。

原生 @ts-ignore/@ts-expect-error 允许的可选引用按真实注释和作用行保留，其他缺失引用仍失败。ambient module 取自 native symbol 和原 roots；skipLibCheck 不补齐未解析引用。例如 Elysia 的公开 bun 引用仍需作者安装可选 `@types/bun`。生成器不合成 any/unknown 或空声明掩盖缺失。

## Service 声明与材料

Service 与 Plugin definition 共用 canonical entry + exportName 身份规则，服务没有node/fork地址。服务直接以普通/abstract class声明；安装点与 `ctx.service` 的具名导入由semantic pass定位原导出并绑定身份，`defineServiceRef<T>()` 生成指向同一身份的optional引用。包显式提供 `@pluxel/source` 声明入口时，声明证明从该入口读取，不以 Vite 运行时 bundle 的解析结果替代。服务安装集合由固定Context plan拥有，不伪装成Plugin catalog节点。Core 的 logger、effects、events、FS、TinyBase 和日志运行时直接由 Context 提供，不生成 Service 声明或控制材料。

manifest format 3 以 `services` 独立记录服务definition、access和API contract。生成入口导出required `ServiceDefinition<FooInstance, Access>`与原生Instance类型；Script的optional helper只接受已校验入口的FooInstance类型。required/optional引用都在receiver realm构造，由SDK定位当前已安装声明并校验contract，返回原生API的受守卫借用视图。服务构造与业务异常不归并为缺失。

Host材料装载器将已验证material绑定到实际安装声明；同一Host只提供已安装的服务。材料查询和同步分别返回 `definitions` 与 `services`，共用不可变快照验证、筛选和原子current发布。未安装服务不因材料存在而可用。Service不需要Plugin实例typed evidence；选择owner Context仍捕获该节点的当前running generation与撤回规则。

## 文件与摘要

format 3 材料包含 index.mjs、index.d.mts、声明闭包和 manifest.json。JavaScript 逐字匹配确定性模板，通过 Host `internal/control-reference` 创建冻结地址提供者；清单为每个 definition 指定 module，导出名在模块内唯一。路径限安全相对路径，文件记录 UTF-8 字节数/SHA-256，snapshot 摘要来自规范编码的 unsigned manifest；原 Plugin 实现不进入材料。

公开 `./control` 的包显式声明兼容 Host peer。仅控制入口依赖 Host 时可 optional，其他运行入口依赖则 required；control-exports 在 exports 写回和 finalization 前验证。Host 不进入 dependencies/optionalDependencies，构建不推断版本或修补作者依赖。

每个 definition 分别计算 config/instance 摘要，config null 表示无配置。输入包括格式、编译器版本、strictNullChecks、规范化可达声明；配置还包括 Schema 表达式和本地依赖，因此 validator/default 变化会失配。本地注释、位置和展示空白规范化；未携带的外部声明按原文计算，类型等价改写也可能保守失配。

一次 native emit 后按各 definition 可达闭包计算摘要；实现专用 import 不扩张其他定义摘要。definitionInputs 映回 watcher owner 索引；共享 ambient、metadata 和同文件多 class 可保守联动。

摘要验证声明兼容性，owner 绑定验证真实实现。Native 对 constructor 固定首次模块/包/材料；磁盘新版本不能重新标记 ESM 缓存里的旧 constructor。新求值 constructor 才能绑定新输出，standalone 从实际 bootstrap URL 登记。

Vite 将 `ModuleRunner`.evaluatedModules 中缓存代码的 source map 原始输入与生成程序逐项比对，防止磁盘 B 声明绑定缓存 A。type-only 依赖加入原 route 反向 owner 索引，经 watcher/driver 失效；材料随候选 provenance 提交，只从 committed catalog 读取。

## typed 配置与实例

`PluginDescriptor<I, O, S>.nodeAddress()` 返回不变关联的 `PluginControlNodeAddress<I, O, S>`。标准工厂深度冻结身份，Core WeakMap 将声明摘要或精确 constructor 绑定到原地址。同 identity 的新版本不覆盖旧证据。SDK 在规范化前固定证据；spread/Object.assign 的 opaque 标记用于诊断副本，JSON/parse 只产生身份，实例访问报 `control_evidence_missing`。

引用均有 status/start/stop/restart。生成地址开放 instance，并在有配置时开放 `ScriptPluginConfig<I, O>`；readonly 函数属性让提取/赋值后仍保持 I/O 约束。配置不同的联合只开放 get，无配置/已擦除关联不开放 config。class 地址提供完整实例和未知字段动态配置；普通地址只有动态管理。引用的 address 保留输入类型/证据，可重新选择；SDK 引用和 view 限本 run，地址/提供者可跨 run 保存。

工厂、引用和配置方法通过闭包固定目标，不依赖 receiver。scope 先检查接纳，异步控制成功返回值，已知失败抛 `ScriptError`，details 保留完整来源、revision、持久化、采用状态和 lifecycle report；未知异常保持原对象。Node/Vite describe 同时声明 plugin、plugin.config、plugin.instance。restart 后可重新取得新 generation view，旧 view 保持撤回。

配置摘要在原 lookup/transaction 内校验，保留 CAS 错误顺序，在 Schema/持久化前拒绝失配。preview 不写入；Host/Workbench 继续原领域协议，SDK 仅在返回处投影。持久化 unknown、保存后未采用的 application 状态保持原义。

instance 在 committed read 中验证 descriptor、当前实现和 generation，并在 Promise 接触业务实例前包装为冻结 `{ instance: view }`，避免读取业务 then。每 scope 缓存成员 view；方法/get/set 进入原 owner invocation，provider 作为 receiver，提取和显式 call 保持 JavaScript this，同 scope 直接实例参数可解包。

同步调用保持同步，native Promise 保留原对象、用旁路 reaction 跟踪；异常 species 抛原错误。自定义 thenable、流、迭代器、嵌套资源保留业务协议。同步 self 映回 view，异步/嵌套值不递归改写；重定义、删除、冻结和替换 view 原型不受支持。

SDK 加载时检查 `Promise.prototype.then` 对普通对象是否抛错。在标准实现中，这个方法也能识别来自其他 realm 的 Promise。若实现接受普通对象（例如示例所用的 Hermes），SDK 只跟踪当前 realm 的 Promise 实例及其子类。插件同步返回数组时会立即释放借用，脚本作用域可以正常关闭。

scope/generation 等待已接纳工作。为避免 provider 与 coordinator 互等，活跃业务调用期间拒绝 coordinator 操作，已有排队 Host 工作时拒绝新业务调用，报 `borrowed_generation_conflict`；日志仍可用。先 await 业务方法再修改配置/生命周期。Context/原生资源的释放和业务 Result 继续由原作者协议负责。

## 同步与脚本输入

Management 的 plugins.control-materials 与 Vite target 沿原连接读材料，独立于 scripts 开关。读取固定 committed catalog、已安装服务集合和所选 definitions/services；每连接最长缓存 5 分钟、128 份、共 64 MiB，索引分页、文件按 32 KiB UTF-8/base64 分块。过期报 `control_snapshot_expired`，重新同步。

script sync/dev sync 共用客户端实现；packageName/完整 definition 互斥筛选在连接前校验，收齐索引后只下载选中 snapshot，仍完整验证该 snapshot 的声明闭包。无匹配定义报错且保留 current。验证后写 `.snapshots/<digest>`，再原子切换 current symlink。按 canonical entry 生成稳定模块，只导出所选Plugin/Service定义；普通具名导出保留原名，特殊名称冲突在生成时处理，输出 module/exportName/importStatement 供直接导入。原始材料保留验证后的声明/数据，执行模块由标准模板生成。owner marker、内容和锁检查拒绝覆盖作者文件或被修改快照，旧快照由显式维护清理。

完整性检查不比较作者安装的外部类型与生成环境。package/closure 都可能引用外部声明，作者须提供匹配版本；Host 摘要只核对 descriptor 与已接纳实现。

上传与 Vite 类型检查共用 native TS 固定读取器：固定内容、缺失结果、目录 realpath，current 原子切换不改变同次编译输入。控制入口完整验证后才进入上传工厂，检查结束还验证 TS 实际读取对应声明；package exports 在两阶段切换明确失败。共享 namespace 和工厂格式由 [Agent Workflow](AGENT_WORKFLOW.md#代码交付和加载)拥有。Vite 使用原 `ModuleRunner`，比对实际缓存与受检输入，失败不调用导出；请求/receipt 保持原协议，读集属于本次加载证据。

## 验证入口

| 边界                                                  | 测试                                                                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| native emit、Part、源码/JSDoc、nominal 类型、独立消费 | [`control.test.ts`](../packages/rolldown/tests/control.test.ts)                                                                                                                        |
| typed API、无配置与联合                               | [`agent/control.typecheck.ts`](../packages/host/tests/agent/control.typecheck.ts)、tsconfig.control.json                                                                               |
| 成员 view、CAS/摘要顺序、取消/generation/then         | [`agent/control.test.ts`](../packages/host/tests/agent/control.test.ts)                                                                                                                |
| 生成→编译→Node/receipt→实际业务/配置                  | [`agent/control-delivery.test.ts`](../packages/host/tests/agent/control-delivery.test.ts)                                                                                              |
| 首次 constructor 与原 owner                           | [`agent/control-material.node.test.ts`](../packages/host/tests/agent/control-material.node.test.ts)                                                                                    |
| Vite 实际缓存和受检输入                               | [`environment-inputs.test.ts`](../packages/host-vite/tests/environment-inputs.test.ts)、[`dev-console-attachment.test.ts`](../packages/host-vite/tests/dev-console-attachment.test.ts) |
| 独立安装、TLS 认证、无源码接收、同步/调用             | [`installed/agent.smoke.mjs`](../packages/services/tests/installed/agent.smoke.mjs)                                                                                                    |
| 固定声明入口、snapshot/exports 竞争                   | [`script-inputs.test.ts`](../packages/rolldown/tests/script-inputs.test.ts)                                                                                                            |
| 同步稳定性、验证、作者文件冲突                        | [`script-sync.test.ts`](../packages/agent-sdk/tests/script-sync.test.ts)                                                                                                               |
| exports、作者定制、连续构建                           | [`plugin-build.test.ts`](../packages/rolldown/tests/plugin-build.test.ts)                                                                                                              |
| HMR、独立摘要、相同源码、generation 释放              | [`hmr-control.test.ts`](../packages/host-vite/tests/hmr-control.test.ts)、[`module-bytes.test.ts`](../packages/host-vite/tests/module-bytes.test.ts)                                   |
| 编码、预期/未知失败、取消排空                         | [`agent/runtime.test.ts`](../packages/host/tests/agent/runtime.test.ts)、[`agent/operations.test.ts`](../packages/host/tests/agent/operations.test.ts)                                 |
| 正式安装与生成项目交付                                | [`smoke-starter.ts`](../packages/create/scripts/smoke-starter.ts)                                                                                                                      |

严格 dist 声明消费、负例和 LSP 补全的独立证据见 [tsgo 实验](experiments/tsgo-plugin-inputs/README.md)。交付验收关注真实声明、领域报告、共享 namespace、原源码定位、独立认证、实际采用、原 receipt 和资源释放；一次运行计数由 Git 历史保存。

### 已知限制

- Elysia 2.0.0-rc.0 在独立 TypeScript 7.0.2 严格 library checking 下可复现 TS2536/TS2344，Services 可选安装检查有该上游声明失败。
- 既往交付检查中的嵌套 fixture 超时和 Typst 观察缺口见[验收记录](records/host-deployment.md#控制-sdk-交付观察2026-11-15)。
- 模型 token/成功率对照尚未开展，见[独立研究](proposals/AGENT_WORKFLOW_EVALUATION.md#要回答的问题)。跨 isolate 业务投影、持久任务和离线 validator 各需独立后端。
