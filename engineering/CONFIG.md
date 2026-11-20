# 配置：声明、保存与运行中应用

配置以 Plugin node 为单位，Host 保存原始输入，Core 校验并向 generation 注入 output：

```text
configs.use(ObjectSchema) / owned PluginPart declarations
  → toolchain owner/path metadata
  → Host 合并声明与保存输入
  → Core composite validation / immutable output
  → Host 保存原始记录
  → Core 通知当前 generation
  → Management report / Workbench presentation
```

公开声明、binding 和调用示例见[配置指南](../docs/plugin-development/configuration.md)。

## 第三方代码配置

应用装配保留上游配置和实例；可管理的 Plugin 记录使用可序列化 schema。可选 preset 提供默认值，原生高级配置继续由应用选择，设计规则见[第三方装配](../.agents/rules/library-api-design.md#should第三方装配保留上游配置)。

| 接入              | 当前入口与资源 owner                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZenFS             | `coreConfig.zenfs` 快照原生 mount 声明，Core 拥有创建的 backend、隔离 mount table，传入 FileSystem 只借用；[FS](FS.md)                                                  |
| LogTape           | `coreConfig.logtape` 接收原生 Config/同步 root factory，Core 拥有安装、身份、policy、排空；[Logging](LOGGING.md)                                                        |
| PostgreSQL/PGlite | 原生 driver 配置或借用实例，Database 拥有 owner schema、migration 和 scheduler；[Database](DATABASE.md)                                                                 |
| OpenTelemetry     | `Otel` 接收原生 providers，`OtelPlugin` 提供可保存预设，generation 拥有交付 providers 的 flush/shutdown；[OTel](../docs/plugins/otel.md)                                |
| Playwright        | 原生连接 hook 保留 connect/connectOverCDP 参数，Plugin 拥有连接、caller 拥有 BrowserContext、部署者拥有浏览器进程；[Browser](../docs/plugins/browser.md)                |
| srvx/Elysia       | `listenElysia()` 保留 TCP/TLS、middleware、plugin 和 error options，Host 拥有 dispatch/关闭；[接线](../docs/host/configuration.md#独立-http-host)                       |
| Vite/tsdown       | 原生配置文件和插件，Pluxel 增加 lowering/共享身份/制品检查；[Artifact Build](ARTIFACT_BUILD.md)                                                                         |
| Workers           | 原生 WorkerOptions，Services 拥有固定 entry、message/transfer、stdio、admission 和退出结算；[Node artifacts](../docs/plugin-development/node-artifacts.md#选择安装能力) |
| 出站 HTTP         | `coreConfig.http` 提供部署限制和传输，Core 持有已应用策略，插件借用原生 Wretch 或 Fetch。 [出站 HTTP](OUTBOUND_HTTP.md)                                                 |
| Redis/S3          | 原生 SDK client，保存设置只承担预算、凭据引用和部署选择。 [Redis](../docs/plugins/redis.md) · [Storage](../docs/plugins/storage.md)                                     |

Vault envelope/轮换和渲染预算属于各领域，不复制为 SDK 参数镜像。新增字段应有明确 owner，不以封闭实现白名单代替原生扩展点。

## Host 管理用例

`host.config` 提供 get、validate、patch、reset 和同步 status。Host coordinator 统一节点可用性、fork 查询及读写队列，避免异步校验跨越 config/catalog 事务读取混合状态。

| 所有者             | 持有内容                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------- |
| HostConfigStore    | declaration、managedInput、managedRevision、输入来源与保存                                |
| Core ConfigService | 已验证 desired output、desired/applied revision、validation cache/ticket、generation 注入 |
| Management         | fieldPath 输入解析、presentation plan、transport DTO                                      |
| Workbench          | 编辑 managedInput、继承提示、展示 output 与采用结果                                       |

Host-vite 与 Management 委托同一 Host 用例。共享 report 投影将 Slot 转成 Address。存储策略拒绝统一使用 `ConfigMutationRejectedError`。

查询和成功修改返回 `HostConfigInputSnapshot`：mode、readonly、managedInput、effectiveInput、sources、shadowedPaths、managedRevision，另带 output、persistence 和 application/desired/applied revision。`managedInput: null` 表示无记录，显式 `{}` 仍是记录。validation_failed 带完整输入与错误；persistence_failed 带最后已接纳输入和 unknown 回执；早期 invalid_input/node_unavailable 不伪造 snapshot/output。Workbench 只提交变化路径，effectiveInput 用于继承提示。

## 不变量

- 每个具体 Plugin/direct PluginPart subclass 最多一个普通 field 调用 `this.configs.use(ObjectSchema)`，且不能是 `#private`。
- Plugin schema 为 flat root，Part schema 按 occurrence field path 嵌套；owner output 不与直接 Part field 重名。
- schema 同时拥有默认值和展示 metadata，output 为深冻结 `ConfigSnapshot`，类型包括深只读 array/tuple。
- 配置在构造后、init 前注入；constructor/其他 field initializer 不读取配置值。
- metadata 由编译器产生，Core validation 不依赖 FS 或 Workbench。
- owner 是 canonical node address，ConfigService 以稳定 index key 索引，不创建 Core Slot。
- 原始输入与 normalized output 分开。output、defaults、声明和 env 不反写保存输入。
- `getRawConfig()` 在同一 revision 返回同一深冻结 snapshot，新 revision 换 identity，旧引用不变。
- 任一 Part mutation 重新验证整个 composite record，共用 owner revision、保存和通知。
- 应用构建保留 factory 代码，启动时才求值，见 [Application Build](APPLICATION_BUILD.md)。

## 存储与创建边界

节点条目提供输入与 mode。`config.document` 和 `policy.document` 各接受 `false` 或 `{ readOnly?, storage? }`。`false` 关闭该域 IO 和订阅，`readOnly` 拒绝本实例管理写入。输入优先级单独选择。

storage 是同步 `(root: RootContext) => HostDocumentStorage`，在唯一 root 创建后、IO 前各求值一次。factory 只接线，不执行 IO、不访问尚未准备的 Plugin/config，也不返回 Promise。`HostDocumentStorage` 的目录、原子 put、订阅和借用关闭边界由 [FS](FS.md#host-文档与关闭) 维护；默认借用 `services/host/<namespace>/<key>`，应用只需在 coreConfig.zenfs 选择一次 backend。

`HostConfigStore` 继承 CoreConfigService，但分别持有 declaration/saved input 和已校验 output；`HostStateStore` 持有 policy input、effective value、revision。config 仅接受 SuperJSON v4，state 仅接受 v8。缺失文档不写入声明或默认种子；明确 mutation 才保存稀疏原始记录。内容摘要去重，发布等待保存确认，坏格式保留原文件。

`createCoreContextHost({ createConfigService })` 只允许在固定 CONFIG_SERVICE 惰性 factory 位置创建服务。Host 读取 stores、组合 policy，一次绑定 PluginService 执行参数，再准备 coordinator 和服务。失败/关闭沿[同一 Host 资源路径](HOST.md#服务与资源)，先排空协调操作，再排空 store 写入并聚合错误。

### v7 运行策略迁移

将旧工厂返回的 `policy` 按原样导出为 JSON，放在 `{ "policy": { ... } }` 中。可附加 `nodes` 数组，将其他需要核对的节点地址纳入比较。构建 Host 后，在仓库根目录预览转换。

```sh
vp run @pluxel/host#compile
vp exec node packages/host/scripts/migrate-policy-v7.mjs --policy author.json --state state.json
```

报告的 `declaration` 提供逐节点代码选项，将已有固定实现的选项合入对应 `plugins` 条目。`comparison` 和 `global` 逐项比对采用结果，`adjustments` 列出为保留旧遮盖语义而修改的保存选择。核对报告及 `futureKeys` 后，停下写入该文档的旧 Host，以相同命令附加 `--write`。工具在 `unresolved` 为空且目标文件仍为本次读取的内容时原子替换文档。

## Static startup config

每次启动重新执行 `HostApplicationFactory(startup)`。startup 提供 mode、root、env、platform bindings 和 deployment facts，工厂据此选择完整应用。

`envBinding(inputs)` 和 `fileBinding(inputs)` 显式选取 config/Vault 输入。Host 从条目所在节点取得 canonical owner。config schema 与 `configs.use()` 的 metadata 为同一个对象，helper 从 schema input 推导 mapping/key。Vault 根 schema 定义 KV key 到记录的 shape。

Host 从不可变 startup.env 解析 env，JSON 文件路径相对 startup.root。来源 metadata 只含路径、kind/name、readonly，不含值。声明按 `节点.config → fileBindings.config → envBindings.config` 合成，后者覆盖同路径。

每个 node mode 按 `节点.configMode → config.mode → inputMode → declared-first` 选择：

| mode           | 选择规则               |
| -------------- | ---------------------- |
| declared-first | 声明优先，保存输入补缺 |
| saved-first    | 保存输入优先，声明补缺 |
| declared-only  | 只用声明               |

fork 省略代码 `config` 时以默认节点的代码数据为起点，显式空对象从空输入开始。其他节点字段、保存值和校验结果分别归属各自节点。按地址声明可以先于实现接纳，Host 保留输入并投影 unavailable。Part 归入所在节点的聚合输入。

原始来源先通过可移植数据树校验；普通对象递归合并，array/tuple 整项替换。只有最终 effective input 执行完整 schema。被遮盖值仅验证结构，在取消遮盖或 definition 改变时重新验证。env/file 不建立管理写锁，mode、权限、文档 readOnly 独立。来源证明保存在内部 WeakMap，与 shadowedPaths 在同一协调查询投影。

`patch/validate({ set?, remove? })` 先按 string[] 路径删除 saved fields，再递归合并 set，最后校验一次。`reset(owner)` 删除保存记录，带 paths 时只删指定嵌套字段，`[]` 只读。reset 恢复继承；路径非空、有界、安全、互不重叠，array 不允许按 index 删除。Core mutation 不能绕过 Host 事务。

Host 按节点选择自动启动与 fork 可用性，按 consumer 和 requirement 选择 provider override。保存输入分别用 `false` 或 `null` 表达禁用或清除。原始 `patch` 按键写入，`reset` 删除目标，批量撤销可同时写入先前记录并删除原先缺失的键。有效策略再投影为协调器所需的启动根、可用 fork 和依赖覆盖，并核验 fork 引用。应用的 provider defaults 整项选择，execution 独立选择各字段。节点级 `policyMode` 优先于 `policy.modes[field]`、`policy.mode` 和 `inputMode`。原始策略编辑可以保存被遮盖值。要求实际生效的命令在副作用前报告 `policy_shadowed`。已保存但待切换的执行参数以 `requires-host-recreation` 报告。

Host 在 Plugin admission 前通过 Core 的内部注入边界安装已校验的 Vault 部署记录。动态 candidate 接纳前验证 config metadata 和已声明路径，失败保留 catalog。Vault 根 schema 是 Host 固定部署输入，只在首次解析校验；Plugin replacement 不重跑 transform。更改 Vault schema/来源需重建 Host，私有 KV 业务校验仍归 Plugin。命名子空间使用 vault.namespace。

## 外部保存配置

Host 准备后订阅 config 文档并补读一次，追平准备期间写入。观察器属于 [FS](FS.md#共享文件与观察)；Host 在同一 exclusive queue 读取最新 v4 文档，按摘要去重，完整替换 saved layer。文件删除清空保存输入并重组声明，不后台重建。

当前可用 owner 的 effective config 全部通过 schema 后，才接纳文档、推进 managedRevision、发布 output 并通知变化 generation。未知 owner 保留原输入到实际 admission，不创建 Slot/fork/generation。外部写入已经保存，本实例不重复写盘。

运行中坏内容保留当前有效配置，后续有效内容可恢复；启动遇坏文档拒绝准备。listener 失败保留 desired，readonly 实例仍可读取外部更新。关闭先取消订阅，再排空已接纳工作。policy 文档仅在启动读取，外部修改不自动启停节点。

多个 Host 是否共享文件由实际 backend 决定。完整替换防止半文件读取，并发读改写仍可能丢失修改；expectedManagedRevision 只作用于本 Host，跨实例一致性业务使用数据库。公开说明见[共享文件](../docs/host/configuration.md#共享文件与外部修改)。

## 保存与应用

patch/reset/field mutation 与 fork/catalog mutation 共用 coordinator exclusive queue。expectedManagedRevision 在任何副作用前比较本领域原始保存版本；只改被遮盖值推进 managedRevision，不推进 desired/applied revision 或通知 listener。

固定顺序为：

```text
validate once → stage raw input + immutable output → flush raw input
  → publish confirmed input/output → notify addressed generation
```

stage 对外不可见。flush 失败不发布候选，返回 persistence_failed/unknown，需检查实际 backing。首次 schema output 是保存前唯一结果，保存后不重复执行 schema。effective input/definition 未变的查询复用 cache；snapshot 同时绑定 record revision 和 immutable candidate identity，两者均匹配才可复用注入。

通知按 canonical node key 直接找 generation binding，不扫描 catalog、运行 reconciler 或 restart dependent closure。未运行为 deferred；listener 全部完成为 applied；缺失、失败或 generation 变化为 saved-not-applied。已保存 desired 不回滚，后续 mutation/restart/boot 可重试。fork 的记录、revision、listener 各自隔离。

persistence 独立报告 unchanged、confirmed（session/declared-durable/unknown retention）或 unknown。Plugin 拥有业务状态、外部资源、幂等与 cleanup，listener 已发生的副作用不会自动回滚。HostStateStore 同 revision 复用 immutable snapshot；readonly 读取既有文档，不创建缺失文件或修复坏文件。

Management catalog.statePolicy 附带同一 committed view 的 managedRevision。auto-start batch 在一次 exclusive session 检查基线，再逐项提交/投影，最后返回最终令牌；Workbench 撤销使用原操作令牌恢复修改前的原始输入。生命周期 batch/准入前拒绝不提供该令牌；批量仍保留逐项部分成功和 unknown。

## Running generation notification

Plugin/Part 在自己的 `init()` 用 `configs.onUpdate(this.config, listener)` 注册一次 generation-bound listener。field 同时提供类型和运行时 identity；registration 不进入 metadata，也不返回 disposer，随 rollback/stop/restart/replacement/shutdown 撤销。

Core 先计算变化 slices、检查 listener 齐全；缺少一个即全部不调用。齐全时 children-before-owner 顺序传入深冻结 applied/desired slice 和 generation withdrawal signal。全部 resolve 且 generation 有效后，统一替换 config fields、推进 owner applied revision。normalized slice 未变时仅确认 revision。

reject 停止后续通知，保留 framework-confirmed fields/revision，Plugin 继续 running，较早 listener 的副作用可保留。稳定错误码是 listener_not_registered、listener_failed、generation_changed。listener 自己保持幂等并收敛 desired，不等待会重新进入本 coordinator 的 mutation/restart/graph operation。withdrawal signal 不代表 operation timeout。

## 输入接纳与成本

RPC 从 unknown 校验 owner、mutation descriptor 和 fieldPath。原始树拒绝 accessor/class、稀疏数组、非有限数值、undefined/symbol、循环及危险键；fieldPath 非空、有界、安全。结构失败为 invalid_input，schema validation_failed 保留完整原始输入；未知 schema/programming error 继续 reject，不能按 message 猜分类。

Core revision cache 按 owner 索引；Host 按节点索引代码声明，完整文档重写 O(B)。每次明确 mutation 等待自身确认，不后台 debounce 或重试。FS 普通文档预算为 8 MiB，独立于 TinyBase；无界 config/fork 规模需改变存储实现。

## Toolchain metadata

`configSourcePlugin()` 在 class field lowering 前写入 field name、schema object 和可选 diagnostic source；Plugin semantic pass 写入 Part occurrence paths。Core 按 path 划分 raw input，分别执行 owner/Part defaults、transform 和 validation，冻结 aggregate，仅向各 field 注入所属 slice。

normalized output 只能是无环 plain object/array 和 JSON primitives；Core clone/freeze，拒绝 Date/Map/Set、class、function、symbol、accessor 等隐藏行为或 identity。

Management 将 declaration 编译为 version 2 presentation plan：path 和可移植 field nodes。无法表达的 node 显示为 read-only unsupported；浏览器不执行 schema，plan 不复制 defaults 或为展示重跑 transform。General/Part sections 共用一个 node 保存与验证。

Valibot schema 拥有 kind、requiredness、choices、format、range。`formMeta()` 添加 title/description 及 section/layout/help/placeholder/control variant，展示偏好不改变 validation。

## 实现入口

- `packages/core/src/services/config/`：output、revision、validation cache。
- `packages/core/src/plugins/composition/{PluginConfigs,ConfigUpdate}.ts`、`plugins/runtime/plugin-service/ConfigUpdate.ts`：声明与 generation listener。
- `packages/host/src/{config-store,config-records,config-paths,input-mode,persistence,input-bindings,config}.ts`：原始输入、事务、来源和保存。
- `packages/valibot-form/src/core/rawInput.ts`：可移植原始输入检查。
- `packages/rolldown/src/rolldown/plugins/{configSourcePlugin,staticConfigEnvironment}.ts`、`src/cli/static-config-environment-output.ts`：metadata 与 binding 编译。

## 验证

Host 通过 [配置操作](../packages/host/tests/config/operations.test.ts) 验证读取、保存、采用与恢复。[文档输入](../packages/host/tests/storage/startup-inputs.test.ts) 覆盖冷启动拒绝及保留原文件，`config/deployment-inputs.test.ts` 与 `config/file-reload.test.ts` 分别验证部署输入和文件观察。

- [配置层集成](../packages/host/tests/config/layers.test.ts)：code/file/env/saved、动态节点、default/fork。
- [管理操作](../packages/services/tests/management/plugin-operations.test.ts)、[表单保存](../packages/workbench/shell/tests/plugins/config/plugin-configuration.test.tsx)：原始输入、CAS、保存/采用反馈。
- [借用文档](../packages/host/tests/storage/documents.test.ts)、[浏览器存储](../packages/host/tests/browser/storage.test.ts)：factory、IO 排空、backend owner、页面/Worker 恢复。
- [部署策略](../packages/host/tests/policy/deployment.test.ts)、[策略编辑](../packages/host/tests/policy/management.test.ts)、[执行参数绑定](../packages/core/tests/plugins/plugin-execution-binding.test.ts)：当前 Host 参数固定、重建采用新目标。

保存回归重点是冲突先于副作用、flush 失败不发布、schema 只执行一次、snapshot identity 正确；[监听器通知](../packages/host/tests/config/listeners.test.ts) 覆盖监听器缺失或拒绝、实例撤回、Part 先于 owner、fork 隔离及保留 desired。在线验证从现有 [devconsole](../docs/development/dev-console.md) 检查 persistence/application/applyFailure。
