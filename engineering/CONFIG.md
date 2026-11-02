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

`@pluxel/host` 的 `host.config` 提供 get、validate、patch、reset 与同步 status。节点可用性与 fork 查询来自同一个 Host coordinator；配置记录、revision、validation ticket 与 generation notification 继续由 Core 拥有。读取和校验也经过协调器队列，异步 schema 处理不会跨越正在接受的配置/目录事务读取混合状态。

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

Host 的顶层 `name` 标识当前宿主；`runtime` 集中 zenfs/logtape/tinybase/state/configRecords。`runtime.configRecords.records` 声明原始 Plugin 输入，`runtime.state` 平铺 autoStart/forks/providerDefaults/dependencyOverrides；两者各自支持 override、可选 storage 与 mode。`storage` 唯一形式是同步 `(root: RootContext) => HostDocumentStorage`，两项 factory 在 root 创建后、文档 IO 前各解析一次并校验，Core 的惰性 config factory 只消费已解析对象。factory 不执行 IO，也不能返回 Promise。

`HostDocumentStorage` 是借用的目录文档接口，包含 `getText(key)`、`put(key, text)`、`stat(key)` 和可选的 namespace 变化订阅 `subscribe(listener)`；put 无条件等待完整原子提交，不接收 atomic 选项。Host 不导入 Services、不创建 filesystem backend，也不关闭应用共享的 backend。默认使用 Core 内建私有文档，显式 memory 可选择临时状态，readonly 拒绝写入。普通应用只在 `runtime.zenfs` 输入一次后端；`requireHostDocuments(root, namespace)` 借用 [FS](FS.md) 的 `services/host/<namespace>/<key>` 普通文件，首次 IO 等待后端准备，公开接线见 [Host 配置](../docs/host/configuration.md#保存配置和运行策略)。

`HostConfigStore` 继承 CoreConfigService，复用唯一 records/revision/validation cache；`HostStateStore` 拥有 coordinator 需要的唯一 policy snapshot/revision。两者只接受 SuperJSON v4/v6 格式与 readonly 失败语义，没有兼容读取或启动迁移。Config debounce、digest 去重、确认前禁止应用，以及 fork/coordinator 补偿边界保持不变；state 的发布仍发生在完整持久化之后。

Core 的 `createCoreContextHost({ createConfigService })` 只允许在固定 CONFIG_SERVICE descriptor 的严格惰性工厂位置创建 CoreConfigService；它不是任意 root factory，不暴露替换 Core token 的权限。Host 准备阶段等待两个 store.ready 后交付，关闭先排空已接纳操作，再等待 store 自己的写入并聚合 flush 错误。环境配置在 Host 应用启动阶段解析，存储 backend 由应用显式提供。

## Static startup config

`HostApplicationFactory` 接收 startup 并返回完整 `HostApplication`。`startup` 提供 mode、env、platform bindings
和 deployment facts；resolver 每次 host startup 重新执行，可选择 服务、configRecords、state、HTTP、
logging、profile 和 Workbench policy。

应用通过 `envBindings` / `fileBindings` 显式选取插件输入。`envBinding(Plugin, inputs)` / `fileBinding(Plugin, inputs)` 接收导出的 schema 引用；config schema 必须与 `configs.use()` metadata 中的同一对象一致，Vault 根 schema 声明 KV key 到记录的 shape。绑定 helper 从 schema input 推导 mapping / 文件记录 key，不从 Plugin 的静态字段推断。schema 定义只有一份，插件内部仍可使用任意普通 private 配置字段。

Host 从本次不可变 `startup.env` 解析环境映射，fileBindings 的 JSON 路径相对 `startup.root`。Host 不隐式解析整个环境配置 snapshot。来源元数据只包含路径、kind/name 和 readonly，不包含值。具体 mapping 与 Vault 规则见[用户配置文档](../docs/plugin-development/configuration.md)。

声明由 `runtime.configRecords.records` 和 fileBindings config 合成，后者覆盖同路径。`override: false` 时，已有保存文档完整决定原始管理输入，仅文件缺失时初始化声明；`override: true` 仅把声明的显式路径覆盖到当前运行时，不改写保存文档。env 最后覆盖有效值。plain object 递归合并，array 替换；声明 override 与 env 控制路径及其祖先/后代拒绝管理写入，Core low-level mutation 也不能绕过。validation 使用完整有效输入，schema defaults/transform output 与 env 都不反写为原始保存记录。source facts 在同一 coordinator 查询中投影。

`reset(owner)` 是显式恢复本次声明的持久修改；提供 keys 时只恢复指定顶层字段，声明缺失字段被删除，`keys: []` 为无操作查询。readonly 与受控路径约束照常检查。

state 的 override 按明确给出的整列替换，省略列继承保存内容，空数组是有效的整列清空；受控列在任何图/元数据副作用前拒绝管理写入。forks 保存 canonical fork node addresses。目录推导的 provider defaults 只属于当前运行图，不能自动持久化为用户选择。

Vault 绑定由 Host 在服务准备后、插件 admission 前通过 root-only `HostVaultBindings` 安装；缺失服务 fail-fast。config 与 Vault 绑定以稳定 node address 为目标。动态候选在 admission 前检查 config metadata 与已声明环境路径兼容性，失败保留原 catalog。Vault 根 schema 是本次 Host 固定的部署输入契约，在首次解析时校验记录 key 与原始值，不能因 Plugin 热替换重新执行 transform 或更改已安装记录。修改 Vault schema 或来源需要重新创建 Host；插件仍负责私有 KV 的业务校验。

持久配置使用 SuperJSON v4 原始记录文档，state 使用 v6；通过 Core FS 原子提交，malformed/version error fail-fast。两者默认仅在缺失文档时使用声明初始化；应用重新打包不覆盖既有保存值。

## 外部保存配置

保存配置使用 SuperJSON v4 普通文档，经 Core FS 直接提交；没有独立的配置复制协议、实例角色、网络连接或部署版本。多个 Host 是否看见同一份文件，由 `runtime.zenfs` 所选的实际后端决定。

Host 在准备完成后订阅文档变化并补读一次，追平服务准备期间的写入。Core FS 仅在有订阅时观察已访问 key；Host 在同一个 coordinator exclusive queue 内读取最新 v4 文档，使用内容摘要跳过重复更新。原始记录完整替换 saved layer；保存文档缺失时清空原始保存输入，仅应用显式 override 与 env，不重新初始化声明或写回默认文件。当前可用 owner 的完整 effective 配置通过 schema 后才发布 normalized output 并通知 generation；raw body 不经 schema output 反写。未知 owner 原文保留到真实 admission，不创建 Slot、fork 或 generation。

外部文件已经由写入方保存，因此本次接纳不再写盘。运行中收到无效内容时保留当前有效配置并报告错误，修正后的新文件可重新接纳；启动时遇到无效文档仍拒绝启动。listener 失败沿 saved-not-applied 语义保留 desired。readonly 仅拒绝本实例管理写入，不禁止读取外部有效更新。关闭先取消订阅，再排空已接纳工作。

完整文件替换只防止读取半份文件，不提供跨实例读改写原子性。并发保存可能丢失修改；Host 不维护跨实例 history、sequence、expected version、冲突合并或自动选主。需要这类保证的共享业务数据使用数据库。Host policy 属于当前实例，不因外部文件变更自动执行节点启停。公开使用边界由 [Host 配置](../docs/host/configuration.md#共享文件与外部修改)维护。

## 保存与应用

control-plane patch/reset/field mutation 与 fork/catalog mutation 共用 host coordinator exclusive queue。顺序固定为 validate once -> stage
normalized immutable snapshot 与原始候选 -> flush 原始记录 -> confirm persisted revision -> notify addressed running generation。stage 不是已提交的内存
authority；flush 失败时未确认 revision 和 normalized snapshot 都不能被 Core generation 观察。第一次 schema validation 的 normalized output 是唯一
pre-persistence authority；写入后不得再次执行可能非确定或 throw 的 schema 并把已经改变的内存状态误报为 `unchanged`。generation notification
仍核对当前 definition facts，失败归入 `saved-not-applied`。validated snapshot 同时绑定 config record revision 与
immutable candidate config-definition identity；只有两者都匹配时 Core generation 注入才可复用，candidate replacement 不按相同 schema reference
猜测等价。

运行中的 node 只有在所有变化 declaration 都注册 listener 时才按 children-before-owner 顺序通知。全部 listener resolve 返回 `applied`；
listener 缺失或 reject 返回 `saved-not-applied`；node 未运行返回 `deferred`。已经验证并保存的 desired record 不因通知失败回滚，供后续
config mutation、显式 restart 或下次 boot 重试。fork 的 config record/revision/listener 相互隔离，修改一个 fork 不通知 default 或 sibling。

running apply 直接按 canonical node key 查找 generation config binding，不扫描 catalog、不运行 reconciler，也不 restart dependent closure。
Config field 保存最后一次 framework-confirmed slice；Plugin 自己拥有普通 runtime state、外部资源、幂等与 cleanup，listener reject 不承诺回滚
已经发生的 Plugin 副作用。HostStateStore 返回 revision-bound immutable snapshot/cache；同一 revision 的 read 不 deep clone。readonly backend
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

RPC 输入先按 `unknown` 校验 owner address、patch object 与 field mutation。nested `fieldPath` 必须非空、有界，并拒绝 `__proto__`、
`constructor`、`prototype` 等危险 segment；非法输入返回封闭 `invalid_input` 或 `validation_failed` 且 `state: 'unchanged'`，不能触发
prototype mutation。unexpected schema/programming error 继续 reject，不能按 message 分类成 domain failure。

内存 owner lookup 和 revision cache 为 O(1)。file backend 在 200 ms 内合并 mutation，随后原子重写 O(B) 的完整 snapshot，B 是
serialized config bytes；FS 普通文档另有固定 8 MiB 单文件预算，与 TinyBase 预算独立。当前契约不适合无界 fork/config 基数。写入失败不发布候选，返回 persistence_failed/state unknown；检查实际 backing 后才能决定后续操作，不能声称失败自动回滚。

## Toolchain metadata

`configSourcePlugin()` 在 TypeScript class field lowering 前验证具体 `@Plugin`/`PluginPart` 各自最多一个非 `#private`
`configs.use(ObjectSchema)` declaration，并写入 owner metadata：field name、schema 对象和可选的诊断 source。Plugin
semantic pass 同时 lower Part occurrence field path；这些 build helper 不是作者 API。

core 按 path partition raw input，分别执行 owner/Part schema default、transform 与校验，再冻结 aggregate output。Plugin field
只注入 root owner slice，每个 Part field只注入自己的 slice。Management API 把每个 declaration 编译成带 path、defaults
和可移植 field node 的 version 1 presentation plan；无法表达的 node 显式成为 read-only `unsupported`，浏览器不执行 schema source。
Workbench 可以按 General/Part sections 编辑，但提交、持久化和 server validation 仍指向同一个 Plugin node owner。
Workbench Plane 不拥有配置事实，也不恢复 layout/template DSL。

字段 kind、requiredness、choices、format 与 range 都来自 Valibot schema。`formMeta({ title, description })` 将字段文案写入
Valibot 标准 metadata，并在同一 action 中补充 section、layout、help、placeholder 和 control variant 等 presentation
preference；这些偏好不能覆盖 schema 的类型或 validation 语义。

schema normalized output 必须是可持久化、无环的 plain object/array tree；leaf 只允许 JSON-compatible primitive。Core 在接受 snapshot
前 deep clone 并 deep freeze，拒绝 `Date`、`Map`、`Set`、class instance、function、symbol、accessor、cycle 与其他带隐藏 identity/behavior 的
value。这样 config revision 才能安全跨 persistence、RPC、Workbench 与 generation boundary，不把 schema library 的临时对象变成运行时权威。

control-plane query 返回当前 raw `config` 与 `defaults`，并以 `saved: false` 和当前 `applied | deferred | saved-not-applied` application
状态表达 desired/applied revision 关系。成功 mutation
只返回已确认持久化的 `config`、application 状态与 apply report，不重复携带 defaults；`validation_failed.defaults` 仅在 defaults 能独立安全
计算时出现。调用者必须按 discriminant 分支，不能假设所有 `ConfigResult` 都有 defaults。

## 实现入口

- `packages/core/src/services/config/`
- `packages/core/src/plugins/composition/PluginConfigs.ts`
- `packages/core/src/plugins/composition/ConfigUpdate.ts`
- `packages/core/src/plugins/runtime/plugin-service/ConfigUpdate.ts`
- `packages/core/src/plugins/runtime/definition.ts`
- `packages/host/src/config-store.ts`
- `packages/host/src/config-records.ts`
- `packages/host/src/input-bindings.ts`
- `packages/valibot-form/src/core/rawInput.ts`
- `packages/host/src/config.ts`
- `packages/rolldown/src/rolldown/plugins/configSourcePlugin.ts`
- `packages/rolldown/src/rolldown/plugins/staticConfigEnvironment.ts`
- `packages/rolldown/src/cli/static-config-environment-output.ts`
- `docs/plugin-development/configuration.md`

作者用法见 [`docs/plugin-development/configuration.md`](../docs/plugin-development/configuration.md#声明规则)。

## 验证

覆盖 Plugin/重复 Part 的 config 聚合、constructor 不提前读取、schema input/output 差异、env 只读路径与 reset。保存路径必须证明 flush 失败不发布、schema 不重复执行、candidate/revision 不匹配不能复用 snapshot。在线 apply 覆盖 listener 缺失/拒绝、generation 撤回、children-before-owner、fork 隔离以及 `saved-not-applied` 保留 desired record。

直接入口是 `packages/host/tests/config.test.ts`、`config-store.test.ts`、`config-environment.test.ts`，以及 Core config/PluginPart 和 Services management config 测试。操作当前应用仍通过 [devconsole](../docs/development/dev-console.md)，检查返回的 saved/application/applyFailure，不以命令完成代替应用成功。
