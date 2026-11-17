# 配置：声明、保存与运行中应用

配置链分成 declaration/validation 与宿主持久化两层：

```text
Plugin + owned PluginPart fields: configs.use(ObjectSchema)
  -> toolchain owner/path schema facts
  -> core composite defaults / validation / normalized aggregate snapshot
  -> one Plugin config record / revision / notification owner
  -> Host config get / validate / patch / reset
  -> Host persistence / Management transport report / Workbench section projection
```

本页拥有配置的唯一事实链。声明与 UI schema 读[不变量](#不变量)及 [Toolchain metadata](#toolchain-metadata)；启动输入读 [Static startup config](#static-startup-config)；保存失败读[保存与应用](#保存与应用)；在线更新读 [Running generation notification](#running-generation-notification)。完整用法见[配置指南](../docs/plugin-development/configuration.md)。

## 第三方代码配置

应用工厂中的装配配置与 `configs.use()` 保存的领域记录有不同边界。装配直接使用上游类型与实例，默认值只是可选预设；插件记录保持可序列化、可验证和可管理。接入规则见 [API 设计](../.agents/rules/library-api-design.md#should第三方装配保留上游配置)。

| 接入                | 配置权威与框架职责                                                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZenFS               | `runtime.zenfs: zenfs(...)` 从 `@pluxel/core/config` 验证并快照原生挂载配置，保留 Backend、BackendConfiguration 和 FileSystem；Core 拥有独立 mount table、创建资源和文件能力撤回，借用实例仍归调用者。[FS](FS.md) 维护进程全局选项的隔离边界及持久挂载声明。                                         |
| LogTape             | `runtime.logtape: logtape(...)` 从 `@pluxel/core/config` 接收原生 Config 或绑定 root/store 的同步配置工厂；上游拥有 sink/filter/路由和原生资源，Core 负责安装、身份、动态 policy 和排空。[Logging](LOGGING.md)。                                                                                     |
| PostgreSQL / PGlite | `postgres()` / `pglite()` 接收原生驱动配置或借用实例，不另造 TLS、pool、extensions 参数。[Database](DATABASE.md) 维护 owner schema、迁移、公平调度和关闭。                                                                                                                                           |
| OpenTelemetry       | 抽象 `Otel` 接收原生 MeterProvider、TracerProvider 和 LoggerProvider，保留 sampler、views、processors 及 resource 配置；`OtelPlugin` 只提供可保存的 OTLP/Prometheus 预设。generation 拥有交付的 providers 与 flush/shutdown，观测状态区分预设管理的输出和外部输出。[OTel](../docs/plugins/otel.md)。 |
| Playwright          | 抽象 `Playwright` 的原生连接 hook 保留完整 connect/connectOverCDP 配置；`PlaywrightPlugin` 是 endpoint/Vault 预设。generation 拥有返回的连接，caller 拥有其 BrowserContext，外部浏览器进程仍由部署者管理。[Browser](../docs/plugins/browser.md)。                                                    |
| srvx / Elysia       | `listenElysia()` 保留原生 srvx TCP/TLS、middleware、plugin 和错误选项；Host 拥有 dispatch 与关闭。完全自管 transport 使用 `createElysiaHandler()` 与原生 srvx。[公开接线](../docs/host/configuration.md#独立-http-host)。                                                                            |
| Vite / tsdown       | 使用真实 Vite/tsdown 配置文件及原生插件；Pluxel 插件只加入 lowering、共享身份与制品约束。production runner 固定自身执行模式，不复制一套 bundler 参数。[Artifact build](ARTIFACT_BUILD.md)。                                                                                                          |
| Workers             | `workers({ worker })` 保留原生 Node WorkerOptions 的环境、参数、启动数据与资源限制；Services 只拥有固定入口、message/transfer、stdio、接纳和实际退出结算，不另建线程工厂 DSL。[Node artifacts](../docs/plugin-development/node-artifacts.md#原生线程选项)。                                          |
| Wretch / Redis / S3 | HTTP client 和连接继续返回原生 SDK；可保存设置拥有预算、凭据引用和部署选择。高级装配通过原生 client 或既有 provider，不能将密钥或函数扩散到管理记录。[Wretch](../docs/plugins/wretch.md)、[Redis](../docs/plugins/redis.md)、[Storage](../docs/plugins/storage.md)。                                 |

Vault 的 envelope/轮换与渲染的资源预算是独立领域契约，不作为 SDK 配置镜像。新增第三方能力时先明确代码配置与保存设置的所有者，再决定是否需要新的框架字段；不能用封闭实现白名单代替扩展点。

## Host 管理用例

`@pluxel/host` 的 `host.config` 提供 get、validate、patch、reset 与同步 status。节点可用性与 fork 查询来自同一个 Host coordinator；Host 拥有原始保存输入和 managedRevision，Core 拥有已校验的 desired output、desired/applied revision、validation ticket 与 generation notification。读取和校验也经过协调器队列，异步 schema 处理不会跨越正在接受的配置/目录事务读取混合状态。

Management 配置 RPC 与 Host-vite 开发控制台委托 Host；Management 负责 fieldPath 输入解析和 presentation 编译，Host 的共享 report 投影将 Slot 转换为 Address。`ConfigMutationRejectedError` 是 Host 的存储策略拒绝信号，Host readonly adapter 使用同一类，不复制错误判别。

## 不变量

- 每个具体 Plugin 和每个 direct `PluginPart` subclass 各自最多一个普通 class field 调用 `this.configs.use(ObjectSchema)`。
- Plugin schema 保持现有 flat root；Part schema 位于 occurrence field path。owner schema output 不能与直接 Part field 重名。
- 默认值和展示 metadata 属于同一个 schema；runtime 和业务代码不重复 fallback。
- `configs.use()` 将 schema output 投影为深只读 `ConfigSnapshot`，包括数组与 tuple；类型与注入的深冻结值一致。
- 配置在实例构造后、`init()` 前注入；constructor 和其他 field initializer 不读取配置值。
- config metadata 是 build-time semantic fact，不是 runtime AST 推断。
- config owner 始终是 canonical `PluginNodeAddress`，内存索引使用其稳定 binary-derived index key；ConfigService 不创建或保留 Core slot，
  也不使用 Plugin name/schema key。
- core validation 不依赖文件系统或 Workbench Plane。
- 原始声明与保存记录由 HostConfigStore 拥有；Core `ConfigService` 唯一拥有已校验的运行记录、revision、validation cache 与 generation 注入。schema output 不能反写成原始保存输入。
- `getRawConfig()` 对同一 revision 复用一个深冻结普通 snapshot；revision 改变后返回新 identity，旧引用不变，不使用 live `Proxy` view。
- 任意 Part config patch 都重新验证 composite record，并通知当前 owning Plugin generation；没有 Part config revision 或独立
  persistence/application owner。
- 应用构建保留配置工厂代码，不执行工厂或固定其启动返回值；Plugin code graph 的交付边界见 [Application Build](APPLICATION_BUILD.md)。

## 存储与创建边界

作者顶层 `config` 声明 Plugin 原始输入及逐 node 的 mode，`policy` 声明八项策略及逐字段 mode。`runtime` 只拥有 zenfs/logtape/tinybase/events 与 documents 接线。`runtime.documents.config/state` 各自接受 false 或 `{ readOnly?, storage? }`，不参与声明与保存值的选择。storage 唯一形式是同步 `(root: RootContext) => HostDocumentStorage`，两项 factory 在唯一 root 创建后、文档 IO 前各解析一次；factory 不执行 IO、不访问尚未准备的 Plugin/config 服务，也不能返回 Promise。

`HostDocumentStorage` 是借用的目录文档接口，包含 `getText(key)`、`put(key, text)`、`stat(key)` 和可选的 namespace 变化订阅 `subscribe(listener)`；put 等待完整原子提交，不接收 atomic 选项。Host 不导入 Services、不创建 filesystem backend，也不关闭应用共享的 backend。默认借用 Core 私有文档；false 禁用该域的文档 IO/订阅，readOnly 拒绝本实例管理写入。普通应用只在 `runtime.zenfs` 输入一次后端；`requireHostDocuments(root, namespace)` 借用 [FS](FS.md) 的 `services/host/<namespace>/<key>` 普通文件，首次 IO 等待后端准备，公开接线见 [Host 配置](../docs/host/configuration.md#保存配置和运行策略)。

`HostConfigStore(ctx, configOptions, storageOptions)` 继承 CoreConfigService，但声明、原始保存输入与 Core 已验证 output 分开持有。`HostStateStore` 拥有协调器所需的 policy 输入、有效值和 revision。两者只接受 SuperJSON v4/v7，没有兼容读取或启动迁移；缺失文档不会初始化声明、空列表或默认值。明确管理修改才提交稀疏原始输入。内容摘要去重，发布必须等待保存确认，fork/coordinator 补偿边界保持不变。

Core 的 `createCoreContextHost({ createConfigService })` 只允许在固定 CONFIG_SERVICE descriptor 的严格惰性工厂位置创建 CoreConfigService；它不是任意 root factory，不暴露替换 Core token 的权限。Host 加载两个 store 后组合 policy，并通过内部一次性绑定确定 PluginService 执行参数，再准备 coordinator 和服务；资源失败与关闭路径见 [Host](HOST.md#服务与资源)。关闭先排空已接纳操作，再等待 store 自己的写入并聚合错误。

## Static startup config

`HostApplicationFactory` 接收 startup 并返回完整 `HostApplication`。`startup` 提供 mode、env、platform bindings
和 deployment facts；resolver 每次 host startup 重新执行，可选择 services、config、policy、HTTP、
logging、profile 和 Workbench policy。

应用通过 `envBindings` / `fileBindings` 显式选取插件输入。`envBinding(owner, inputs)` / `fileBinding(owner, inputs)` 的 owner 接受 constructor 或 canonical node address；config schema 必须与 `configs.use()` metadata 中的同一对象一致，Vault 根 schema 声明 KV key 到记录的 shape。绑定 helper 从 schema input 推导 mapping / 文件记录 key，不从 Plugin 的静态字段推断。schema 定义只有一份，插件内部仍可使用任意普通 private 配置字段。

Host 从本次不可变 `startup.env` 解析环境映射，fileBindings 的 JSON 路径相对 `startup.root`。Host 不隐式解析整个环境配置 snapshot。来源元数据只包含路径、kind/name 和 readonly，不包含值。具体 mapping 与 Vault 规则见[用户配置文档](../docs/plugin-development/configuration.md)。

本次声明按 `config.records → fileBindings.config → envBindings.config` 合成，后者覆盖同路径。每个 owner 的 mode 按 record.mode → config.mode → declared-first 确定：declared-first 为声明优先，saved-first 为保存优先，declared-only 忽略保存输入；缺少部分最后由 schema 决定。default/fork 互不继承值或 mode，Part 属于 owning node 的聚合输入。mode-only record 合法，重复 owner 或 mode/config 同时缺失拒绝。constructor 在快照时 lower 为 canonical default address；地址声明不加载代码、创建 fork 或启动节点。

每个来源先接受无行为、可移植的原始树；普通对象递归合并，数组/tuple 原子替换。只对最终 effective input 执行完整 schema。被遮盖的原始值仅证明结构合法，取消遮盖或 definition 变化时重新验证。env/file 不形成管理写锁；模式、文档写权限与授权独立。schema defaults/transform output、声明和 env 都不反写原始保存输入。来源证明位于内部 WeakMap，作者字段不能伪造，source facts 与 shadowedPaths 在同一协调查询投影。

`patch` / `validate` 使用 `{ set?, remove? }`：先按字符串数组路径删除保存字段，再递归合并 set，最后验证一次。`reset(owner)` 删除保存记录；提供 paths 只删指定嵌套路径，`[]` 只读。reset 恢复继承，不保存声明副本；数组不接受索引删除，路径必须非空、有界、安全且互不重叠。Core low-level mutation 不能绕过 Host 的事务边界。

policy 四个图列表整项选择，显式空数组是值，省略才继承；四个执行参数使用相同三种模式，数值在各来源独立验证。纯管理编辑允许保存被遮盖的输入；承诺实际动作的单项命令在副作用前拒绝 policy_shadowed，并用 writtenFields 说明整列接管。forks 保存 canonical fork addresses，目录推导的 provider defaults 只属于当前运行图。执行参数固定在本次 Host，新目标以 requires-host-recreation 表达，完整契约见 [Host 配置](../docs/host/configuration.md#八项运行策略)。

Vault 绑定由 Host 在服务准备后、插件 admission 前通过 root-only `HostVaultBindings` 安装；缺失服务 fail-fast。config 与 Vault 绑定以稳定 node address 为目标，Vault 的命名子空间位于 `vault.namespace`。动态候选在 admission 前检查 config metadata 与已声明路径兼容性，失败保留原 catalog。Vault 根 schema 是本次 Host 固定的部署输入契约，在首次解析时校验记录 key 与原始值，不能因 Plugin 热替换重新执行 transform 或更改已安装记录。修改 Vault schema 或来源需要重新创建 Host；插件仍负责私有 KV 的业务校验。

## 外部保存配置

保存配置使用 SuperJSON v4 普通文档，经 Core FS 直接提交；没有独立的配置复制协议、实例角色、网络连接或部署版本。多个 Host 是否看见同一份文件，由 `runtime.zenfs` 所选的实际后端决定。

Host 在准备完成后订阅文档变化并补读一次，追平服务准备期间的写入。Core FS 仅在有订阅时观察已访问 key；Host 在同一个 coordinator exclusive queue 内读取最新 v4 文档，使用内容摘要跳过重复更新。原始记录完整替换 saved layer；保存文档缺失时清空保存输入，按本次 mode 重新组合声明，不写回文件。当前可用 owner 的完整 effective 配置全部通过 schema 后才接纳文档、推进 managedRevision 并发布 output；真正改变的目标通知 generation，raw body 不经 output 反写。未知 owner 原文保留到真实 admission，不创建 Slot、fork 或 generation。

外部文件已经由写入方保存，因此本次接纳不再写盘。运行中收到无效内容时保留当前有效配置并报告错误，修正后的新文件可重新接纳；启动时遇到无效文档仍拒绝启动。listener 失败沿 saved-not-applied 语义保留 desired。readonly 仅拒绝本实例管理写入，不禁止读取外部有效更新。关闭先取消订阅，再排空已接纳工作。

完整文件替换只防止读取半份文件，不提供跨实例读改写原子性。并发保存可能丢失修改；本地 expectedManagedRevision 不承担跨实例 CAS、冲突合并或自动选主。需要这类保证的共享业务数据使用数据库。Host policy 文档只在启动读取，外部文件变更不自动执行节点启停。公开使用边界由 [Host 配置](../docs/host/configuration.md#共享文件与外部修改)维护。

## 保存与应用

control-plane patch/reset/field mutation 与 fork/catalog mutation 共用 Host coordinator exclusive queue。可选 expectedManagedRevision 在同一队列内先与本 Host、本领域的原始保存版本比较，冲突先于任何副作用。managedRevision 只随原始保存输入改变，与 desired/applied revision 分开；只改被遮盖的保存值不推进目标 revision、不通知 listener。

Management catalog.statePolicy 在同一已提交视图中附上 policy 的 managedRevision；Workbench 原有自动启动、依赖和 fork 动作使用这份显示基线。自动启动批次在一次 exclusive session 中先检查令牌，再逐项提交并同步投影每项 control，不递归接纳队列，也不让第一项写入使自己的后续项冲突。保留原有逐项部分成功契约。

顺序固定为 validate once → 暂存原始候选和 normalized immutable snapshot → flush 原始记录 → 发布已确认输入/output → notify addressed running generation。stage 仅是 Host 私有事务，flush 失败时未确认输入和 output 都不能被 Core generation 观察。第一次 schema validation 的 output 是唯一 pre-persistence authority；写入后不得再次执行可能非确定或 throw 的 schema。无 effective input 或 definition 变化的 get/validate 复用已验证 output；查询不为了展示 defaults 再次运行 schema。generation notification
仍核对当前 definition facts，失败归入 `saved-not-applied`。validated snapshot 同时绑定 config record revision 与
immutable candidate config-definition identity；只有两者都匹配时 Core generation 注入才可复用，candidate replacement 不按相同 schema reference
猜测等价。

运行中的 node 只有在所有变化 declaration 都注册 listener 时才按 children-before-owner 顺序通知。全部 listener resolve 返回 `applied`；
listener 缺失或 reject 返回 `saved-not-applied`；node 未运行返回 `deferred`。已经验证并保存的 desired record 不因通知失败回滚，供后续
config mutation、显式 restart 或下次 boot 重试。fork 的 config record/revision/listener 相互隔离，修改一个 fork 不通知 default 或 sibling。

running apply 直接按 canonical node key 查找 generation config binding，不扫描 catalog、不运行 reconciler，也不 restart dependent closure。
Config field 保存最后一次 framework-confirmed slice；Plugin 自己拥有普通 runtime state、外部资源、幂等与 cleanup，listener reject 不承诺回滚
已经发生的 Plugin 副作用。persistence 独立报告 unchanged、confirmed（含 session/declared-durable/unknown retention）或 unknown，不把写入失败描述成确定回滚。HostStateStore 返回 revision-bound immutable snapshot/cache；同一 revision 的 read 不 deep clone。readonly backend
读取既有文件但不创建缺失文件，拒绝 mutation；malformed/version error fail-fast，且不隔离或重写原文件。

## Running generation notification

Plugin/Part 在声明者自己的 `init()` 中通过 `configs.onUpdate(this.config, listener)` 为 declaration 注册一次 generation-bound listener。
`this.config` 同时提供类型推导和运行时 field identity 校验；registration 不进入 schema/toolchain metadata，也不返回 dispose handle。init rollback、
stop、restart、replacement 与 shutdown 直接撤销对应 generation registration。

通知前先计算真正变化的 declaration slices，并检查所有 listener 是否齐全；缺少任一 listener 时不调用任何 listener。齐全时按
children-before-owner 逐个调用，参数是 deep-frozen `applied`/`desired` slice 与 generation withdrawal `signal`。`signal` 不表达 operation
timeout。全部 resolve 且 generation 仍有效后，Core 统一替换变化的 config fields，并推进整个 owning Plugin 的 applied revision；normalized
slice 没有变化时不调用 listener，只确认最新 revision。

listener reject 会停止后续通知，保留此前 framework-confirmed fields/revision，并保持 Plugin running；已经完成的较早 listener 副作用可以保留。
Management 用稳定 `listener_not_registered`、`listener_failed`、`generation_changed` code 报告未确认原因。框架不提供 restart instruction、
prepare/commit/discard、compensation 或另一套 effects lifecycle。Listener 应由 Plugin 自己保持幂等并收敛到最新 desired state；不得等待需要进入
同一 coordinator 的 config mutation、restart 或 graph operation。

## 输入接纳与成本

RPC 输入先按 `unknown` 校验 owner address、mutation descriptor 与 field mutation。原始配置拒绝 accessor、class、稀疏数组、非有限数值、undefined、symbol、循环和危险键；nested fieldPath 必须非空、有界且没有危险 segment。非法输入在副作用前返回 invalid_input；schema 的 validation_failed 带完整原始输入事实供修复。unexpected schema/programming error 继续 reject，不能按 message 分类成 domain failure。

Core revision cache 按 owner 索引；Host 原始记录选择随记录数增长，文档提交重写 O(B) 的完整 snapshot，B 是 serialized config bytes。每个明确 mutation 等待自己的确认，没有后台 debounce、隐式补写或失败重试；FS 普通文档另有固定 8 MiB 单文件预算，与 TinyBase 预算独立。当前契约不适合无界 fork/config 基数。写入失败不发布候选，返回 persistence_failed/state unknown；检查实际 backing 后才能决定后续操作，不能声称失败自动回滚。

## Toolchain metadata

`configSourcePlugin()` 在 TypeScript class field lowering 前验证具体 `@Plugin`/`PluginPart` 各自最多一个非 `#private`
`configs.use(ObjectSchema)` declaration，并写入 owner metadata：field name、schema 对象和可选的诊断 source。Plugin
semantic pass 同时 lower Part occurrence field path；这些 build helper 不是作者 API。

core 按 path partition raw input，分别执行 owner/Part schema default、transform 与校验，再冻结 aggregate output。Plugin field
只注入 root owner slice，每个 Part field 只注入自己的 slice。Management API 把每个 declaration 编译成带 path
和可移植 field node 的 version 2 presentation plan；无法表达的 node 显式成为 read-only `unsupported`，浏览器不执行 schema source。plan 不保存 defaults，也不为展示额外执行 schema transform。
Workbench 可以按 General/Part sections 编辑，但提交、持久化和 server validation 仍指向同一个 Plugin node owner。
Workbench Plane 不拥有配置事实，也不恢复 layout/template DSL。

字段 kind、requiredness、choices、format 与 range 都来自 Valibot schema。`formMeta({ title, description })` 将字段文案写入
Valibot 标准 metadata，并在同一 action 中补充 section、layout、help、placeholder 和 control variant 等 presentation
preference；这些偏好不能覆盖 schema 的类型或 validation 语义。

schema normalized output 必须是可持久化、无环的 plain object/array tree；leaf 只允许 JSON-compatible primitive。Core 在接受 snapshot
前 deep clone 并 deep freeze，拒绝 `Date`、`Map`、`Set`、class instance、function、symbol、accessor、cycle 与其他带隐藏 identity/behavior 的
value。这样 config revision 才能安全跨 persistence、RPC、Workbench 与 generation boundary，不把 schema library 的临时对象变成运行时权威。

control-plane 查询与成功修改返回 `HostConfigInputSnapshot`（mode、readonly、managedInput、effectiveInput、sources、shadowedPaths、managedRevision），以及 config output、persistence 和 application/desired/applied revision。`managedInput: null` 表示没有保存记录，不能与显式 `{}` 合并。validation_failed 必含完整输入事实及错误，没有成功 output 或采用状态；persistence_failed 带最后接纳的输入事实和 unknown 回执，也不伪造 output。invalid_input/node_unavailable 等早期失败不伪造 snapshot。Workbench 编辑 managedInput，只提交变更路径；effectiveInput 用于继承提示，config 仅展示目标结果。Host 结果没有 defaults 或 saved boolean。

## 实现入口

- `packages/core/src/services/config/`
- `packages/core/src/plugins/composition/PluginConfigs.ts`
- `packages/core/src/plugins/composition/ConfigUpdate.ts`
- `packages/core/src/plugins/runtime/plugin-service/ConfigUpdate.ts`
- `packages/core/src/plugins/runtime/definition.ts`
- `packages/host/src/config-store.ts`
- `packages/host/src/config-records.ts`
- `packages/host/src/config-paths.ts`
- `packages/host/src/input-mode.ts`
- `packages/host/src/persistence.ts`
- `packages/host/src/input-bindings.ts`
- `packages/valibot-form/src/core/rawInput.ts`
- `packages/host/src/config.ts`
- `packages/rolldown/src/rolldown/plugins/configSourcePlugin.ts`
- `packages/rolldown/src/rolldown/plugins/staticConfigEnvironment.ts`
- `packages/rolldown/src/cli/static-config-environment-output.ts`
- `docs/plugin-development/configuration.md`

作者用法见 [`docs/plugin-development/configuration.md`](../docs/plugin-development/configuration.md#声明规则)。

## 验证

覆盖 Plugin/重复 Part 的 config 聚合、constructor 不提前读取、schema input/output 差异、逐 node mode、env/file 声明、隐藏保存值与 reset 恢复继承。保存路径必须证明原始版本冲突在副作用前拒绝、flush 失败不发布、schema 不重复执行、candidate/revision 不匹配不能复用 snapshot。在线 apply 覆盖 listener 缺失/拒绝、generation 撤回、children-before-owner、fork 隔离以及 `saved-not-applied` 保留 desired record。

直接入口是 `packages/host/tests/config.test.ts`、`config-store.test.ts`、`config-environment.test.ts`、`config-file-reload.test.ts`、`config.types.ts`，以及 Core config/PluginPart 和 Services management config 测试。操作当前应用仍通过 [devconsole](../docs/development/dev-console.md)，检查返回的 persistence/application/applyFailure，不以命令完成代替应用成功。
