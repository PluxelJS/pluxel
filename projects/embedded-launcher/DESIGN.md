# 架构设计

本页是 Embedded Launcher 的目标设计。文中的应用服务、消息和目录名称均为拟议项目契约；已有 Pluxel API 以链接到的源码和官方文档为准。实现状态及验证缺口只在 [实施文档](IMPLEMENTATION.md) 维护。

## 1. 所有权与执行拓扑

原生应用独立可启动，拥有窗口、剪贴板、原生动作、数据文件、插件包存储和运行时监督。Pluxel Host 拥有插件图、配置语义和运行意图；Core 拥有 generation 与调用撤回。两者通过应用能力协议连接。

```text
开发
  Qt 原生应用 <-- 本地 socket --> Node 执行会话
                                     Vite 的唯一 Pluxel ModuleRunner
                                     Host + Services + 插件 (HMR)

发布
  Qt 原生应用 <-- 异步队列 --> 专用线程中的 QuickJS-NG JSRuntime
                                Host + 同一 Services + 预编译插件

CLI 客户端 --> 原生应用本地入口 --> 当前唯一活动 Host 的 CLI carrier
```

一个原生应用实例只能绑定一个活动插件执行会话。开发模式不同时启动内嵌 QuickJS 插件后端；发布模式不启动 Node。模式由显式启动参数决定，连接失败不自动切换模式。开发与发布默认使用不同数据 profile，同一 profile 禁止两个应用实例同时写入。

| 所有者            | 持有内容                                            | 不拥有的内容                 |
| ----------------- | --------------------------------------------------- | ---------------------------- |
| 原生应用          | 原生状态、包集合、运行时监督、UI 线程               | 插件依赖图、配置合并规则     |
| 执行会话          | transport、启动 bindings、Host 借用的存储、运行环境 | 每个插件的业务状态           |
| Host              | catalog、配置与运行策略、服务准备与结算             | 包下载、原生进程退出策略     |
| 应用 Services     | owner view、查询注册、桥接调用、贡献快照            | 另一套插件 graph 或生命周期  |
| Plugin generation | 业务实例、命令、订阅、查询 provider                 | 共享连接、原生应用和文件存储 |
| 原生 UI           | 当前贡献与状态的投影                                | 第二份可写配置或启停策略     |

原生应用能力先于插件存在；不把核心应用包装成一个必须随插件一起重启的 Plugin。应用服务不暴露完整 `app` 对象，也不向插件传递 QObject、指针或任意原生调用入口。

## 2. 同一业务契约，两种连接实现

项目内分出 portable 的应用能力契约、Service 实现和插件，以及 Node/QuickJS 两个执行适配器。插件和 Service 的业务部分不判断 `isNode`、不访问 socket，也不解析原生句柄。

两端使用相同的异步请求、响应、取消和事件语义。开发侧采用 Qt local socket 与 Node `net`，发布侧用 C API 加异步线程队列；原生领域 handler 共用。发布不绕回本地 socket，也不为模拟同步原生 API 让开发侧阻塞等待。

首版消息使用受限 JSON 数据；socket 使用有长度上限的帧，复用 JSON-RPC 2.0 的请求/响应结构，取消和快照事件作为明确的方法扩展。优先选已有解析/编码设施；不实现远程对象代理、引用传输或另一套 Command 系统。冻结协议前需完成真实 C++/JS 往返。

- 协议版本、应用实例、profile 和角色在握手中核对。原生端发行会话 ID，旧连接不能自行恢复旧身份。
- 本地端点限制同用户访问；开发后端使用本次启动的连接凭据，并绑定准确实例。CLI 角色只能调用选定管理和命令入口，不能注册插件贡献或读写任意存储路径。
- 参数和结果只允许有限数值、字符串、boolean、null、普通对象和数组；大整数或精确小数由领域契约明确编码为字符串。拒绝循环、函数、Error 实例、隐式 `undefined` 和非有限数值。
- 每个请求有会话内唯一 ID。取消是协作请求，不是回滚；写入已提交时保留真实回执。断连后无法确认副作用时返回结果未知，不自动重放启动应用、安装或配置写入。
- transport 支持双向并发请求。等待一次异步响应期间继续处理入站消息，避免“原生等 JS，JS 又等原生”的死锁；禁止同步重入 JS。
- 必须限制帧大小、在途请求、排队结果和日志数量。查询只保留最新待执行输入，管理写入串行结算；取消、关闭、响应不能被查询洪峰无限挤压。

连接和存储由执行会话提前创建，再通过启动 bindings 借给应用工厂。**当前 `createHost()` 在 Services prepare 前等待配置和状态存储就绪**，不能让 `HostDocumentStorage` 等待尚未执行的 bridge Service prepare。启动失败由执行会话回收已获取资源；Host replacement 借用同一连接，Plugin stop 不关闭它。

Host 只决定存储文档的内容，原生端只按受限命名空间原子存取完整文档。配置文件损坏时报告错误并保留字节，不重置为空。原生设置页通过 `host.config` 读、校验、修改，不能直接编辑 Host 存储文档。参见 [存储接口](../../packages/host/src/document-storage.ts) 与 [Host 配置](../../docs/host/configuration.md)。

## 3. 应用 Services 与插件图

使用现有 capability token、Host service installer 和 owner effects。能力 shape 在 root 创建前固定。安装器声明不做 IO；异步准备和清理由服务生命周期拥有，借用的 execution transport 不被服务关闭。参见 [服务安装与发布 hooks](../../docs/host/services.md)。

| 拟议能力                           | 插件看到的职责                          | 实现所有权                                           |
| ---------------------------------- | --------------------------------------- | ---------------------------------------------------- |
| `Launcher`                         | 注册查询 provider，返回结构化结果与动作 | root registry + 固定 owner view；generation 拥有注册 |
| `Clipboard`                        | 写入文本并取得完成回执                  | owner 调用保护 + 原生 UI 线程执行                    |
| `Desktop`                          | 查询有限的原生动作目录，执行已知动作    | 原生应用拥有目录与动作，插件不能执行任意 shell       |
| `Commands`（已有）                 | 发布命令、目录和 carrier mount          | 复用 `@pluxel/services/commands`                     |
| Host 配置/状态 storage（已有接口） | 配置与 auto-start 持久化                | Host 拥有语义，原生应用拥有 backend                  |
| Core logger/events/effects（已有） | 诊断、Host 内事件、资源清理             | 沿用 Core，不包装成平行基础设施                      |

```text
Calculator                  原生应用能力
  ^          ^                 ^
  |          |                 |
CalculatorLauncher        NativeActions
CalculatorCommands
  |
CliCarrier (通过 constructor 声明需要的载体能力)
```

`Calculator` 使用成熟的 portable 表达式解析库，拥有计算方法与精度配置，禁用任意 JS 求值。`CalculatorLauncher` 依赖它并注册搜索结果和复制动作；`CalculatorCommands` 依赖它及 CLI carrier，发布同一个业务方法的命令入口。`NativeActions` 查询真实原生动作目录，展示异步能力、取消和副作用回执。选择一个无需外部服务的原生动作即可，不实现全盘索引。

CLI 客户端只把 argv 发送到原生应用，再转给活动 Host 的 `CliCarrier`。carrier 使用 `@pluxel/commands/argv` 和 Commands `createMount()`；整个处理与回复准备处于 provider/publisher owner 保护内。root command registry 与 argv 路由是同一 Command 的两个显式发布载体，不把所有 root 命令自动暴露给终端。

CLI 不创建另一个 Host，不执行另一份 Calculator。Command 的 Result、领域拒绝和已提交回执保持原义；桥接层只显式编码，不能把 fulfilled Err 当成功。传输成功不意味着终端已显示响应。参见 [Commands 契约](../../docs/plugin-development/commands.md)。

原生管理入口由 Host 执行适配层拥有，即使所有业务插件停止也能 start/config。它只投影真实 Host API 和报告，不创建第二个 graph。首版不默认安装带 HTTP/Workbench 的 preset；已有 Management 的可复用部分须检查依赖后再选，不能为了原生管理引入浏览器认证与服务端 listener。

## 4. 查询、动作与跨边界发布

原生搜索框产生递增 query revision，一次输入只跨桥一次。JS 中的 Launcher 服务分发给当前 provider，在 JS 内合并结果；原生端负责列表呈现与键盘交互。先用确定的 provider 顺序与本地排序，避免各插件用不可比较的任意 score 竞争。

provider 接收查询、数量限制和 AbortSignal，返回一批有界结果；首版不做流式结果协议。结果包含 provider 内稳定 ID、标题、副标题、可选的原生图标 key 和动作描述。函数留在 JS registry；原生只持有不可复用的 action handle。

查询变更取消旧查询；晚到结果仍须按 revision 检查，不能只相信 callback 遵守取消。新输入立即让旧结果动作失效，防止列表尚未刷新时执行上一查询。结果被替换时释放其 callback 表项；已接纳调用只保留完成所需引用，不能等到 Plugin 停止才清理每次查询的动作。空列表表示查询成功但无匹配，provider failure 单独进入报告，不伪装为空。

为防止旧调用和旧结果复活，保留以下各自有独立寿命的身份：

| 身份                | 何时变化                                  | 解决的问题             |
| ------------------- | ----------------------------------------- | ---------------------- |
| execution session   | 连接重建、Node 重启或 JSRuntime 重建      | 旧 transport 消息      |
| Host lease          | Host replacement                          | 同连接上的旧 Host 回调 |
| registration handle | provider/动作所属 generation 或注册被撤销 | 同名注册复活旧句柄     |
| query revision      | 用户输入变化                              | 旧查询覆盖新结果       |

这些身份由各 owner 生成，通过不透明句柄携带；插件不自行拼接 generation ID。原生端只有贡献投影，JS registry 是可调用贡献的权威。执行 action 时在 JS 接纳边界重新校验 owner 和句柄；UI 上“看起来可用”不构成接纳。

Launcher 注册在 `init()` 中进入候选集合，通过现有 service lifecycle hooks 参与 generation 结算；初始化失败不得留下可执行结果。`publishCommit` 只同步切换 JS 内已准备好的快照，不能等待 socket、原生 ACK 或分配异步资源。后续 transport pump 发送已提交、带 revision 的投影，原生丢弃过期投影。撤回发生后，即使 UI 还短暂显示旧项目，旧句柄也已经不可调用。

不宣称 JS graph 和原生 UI 跨进程原子提交。Host 报告说明运行时结算，原生 ACK 说明某个投影已经呈现；二者分别可观察。需要等待 UI 更新的自动化验收等待相应 projection revision，不通过任意 sleep 推断成功。

## 5. 开发 HMR 与真实原生交互

开发拓扑必须使用 `@pluxel/host-vite` 已有的唯一 Pluxel environment 和 ModuleRunner。服务端插件源码不是浏览器 HMR；不另用 `ssrLoadModule()`、Node import 缓存或 watcher 执行同一插件。语义 lowering、catalog 接纳、依赖失效和更新分类全部沿用框架。[HMR 权威约束](../../engineering/HMR.md)。

开发启动顺序：原生应用创建本地端点 -> Node 执行会话连接并确认 profile -> 建立可用的借用存储 -> Vite 的标准 Host 入口读取 startup bindings -> 创建 Host 和 Host lease -> 启动插件 -> 原生接收贡献快照。Node 只获得显式开放的原生业务能力；不能在开发时用本机 fs/剪贴板替代真实应用调用。

应用 service token、Core/Host 和 Commands 所需共享实例必须一致。使用现有 `hostSingletons({ packages })` 和官方服务 singleton 规则，明确 SDK 身份包的 built ESM 入口。该规则按包名包含其子路径，所以应用能力契约和 Services 放入独立的项目内 private SDK 包，业务插件留在演示应用包；不能把两者放在同一包后将整个包选为 singleton。SDK 和执行桥接边界作为稳定基础设施，修改它们允许重建 SDK 并重启 Node 开发执行会话；业务插件与普通业务 helper 必须 HMR。

| 变化/操作                | 应发生的事                                                         | 保持存活                                |
| ------------------------ | ------------------------------------------------------------------ | --------------------------------------- |
| 插件或其业务 helper 修改 | 现有 definition HMR，撤回旧 generation，启动新代并重新投影当前查询 | 原生应用、连接、Node 进程、未受影响插件 |
| 编译/结构接纳失败        | 保持尚未撤回的旧事实，报告真实拒绝                                 | 原生应用与开发会话                      |
| 新 generation init 失败  | 撤回失败代的注册，依赖分支按 Core 报告；不复活已停止旧实例         | 原生应用、其他可运行分支                |
| 应用工厂/服务装配修改    | 既有 Host replacement，关闭旧 Host lease，再接入新 Host            | 原生应用、执行连接                      |
| 稳定 SDK/Node 执行器变化 | 明确重启开发执行会话并重新握手                                     | 原生应用与其数据                        |
| stop/start/config        | 使用当前 Host 的正常 API；配置应用按现有报告结算                   | JS 执行环境和原生应用                   |

Host replacement 后，原生端清除旧 lease 的贡献并暂时显示未就绪；新 Host 只同步当前 UI 查询等读状态，不重放用户曾执行的动作。Host-vite 的补偿 Host 也是新 lease，遵循框架已有结果报告，不伪造 restored。状态存储仍由执行会话借用，旧 Host 关闭和存储结算完成后才能交给新 Host。

断开连接时原生端立即拒绝旧会话动作、清除旧贡献，核心窗口继续工作。Node 侧关闭接纳并清理 Host。重连创建新会话和 fresh Host，不给旧闭包重新绑定 session。断连前已接纳的原生写入按真实结果结算；取消或断连不会撤销已经写入的剪贴板。

运行时诊断至少关联 session、Host lease、插件地址、贡献 revision 与请求 ID。Plugin generation 用框架已有诊断事实，不再维护另一份编号。读取和操作已运行的 Vite Host 必须使用 [dev console](../../docs/development/dev-console.md)，固定 root/instance；原生 UI 验收另观察真实窗口与原生状态，不能用隔离 Host 替代。

## 6. 发布运行时与 portable 制品

QuickJS-NG JSRuntime 及其 JSValue 全部由专用执行线程拥有；UI 线程只处理原生 UI 操作。线程间投递 DTO，不传 JSValue。Promise jobs 和定时器进入该执行线程事件循环，按有界工作批次运行并让出控制权；原生异步完成后投递回该线程 resolve/reject，再推进 jobs。

实施时锁定引擎版本，审计 Core、Host、Commands、应用 Services 与传递依赖的完整产物闭包。已发现需要核对的能力包括 TextEncoder、AbortController/AbortSignal.any、定时器、structuredClone 和 dispose symbols；这是审计起点，不是完整支持清单。按实际使用补齐语义，不能放置不工作的 stub。CPU 执行预算用引擎 interrupt 机制验证；它不等于 Promise/原生 IO 的取消。

生产编译复用现有 Plugin lowering ABI，输出 ESM JS 与准确的 canonical definition 映射。普通依赖随包内联，残留 import 只能是清单允许的宿主共享模块或包内明确模块。Core、toolchain helpers、应用 service tokens 等由同一 realm 的模块映射提供，禁止每包私带一份 Core。首次采用一个 runtime/realm 承载整个插件 graph；不承诺每插件独立沙箱。

运行时 loader 只读取本次激活包集合中的 immutable 文件，不进行 npm 解析、下载安装、TS 编译或补猜模块入口。插件包保留稳定 canonical identity，物理 revision 变化不改变节点配置地址。当前 Node modules/standalone launcher 不能直接当作 QuickJS 入口；需要经验证的独立嵌入入口和项目构建适配。

首版发布 JS，不发布 QuickJS 字节码。字节码绑定引擎版本且不适合作为未经信任来源的输入；JS 交付也不自动构成安全沙箱。演示仅安装受控示例包，恶意插件隔离、多租户和应用权限系统不在首版支持声明内。

## 7. 安装、更新与普通生命周期

原生应用拥有一个小型本地包存储。首版从文件选择器安装演示构建产生的预编译包，不在用户机器运行 npm/pnpm 或 install scripts。不能直接套用当前 Node/pnpm [Package Manager](../../docs/plugins/package-manager.md)；只复用其“安装事实与运行事实分离”的原则。

包 manifest 的最小事实是格式版本、包名/版本、canonical exports、文件及摘要、lowering ABI 与宿主 SDK 兼容要求，以及必须共同存在的插件包约束。不能把 definition 声明再手写成第二套权威元数据。安装时限制解包路径、文件数量/大小，拒绝越界路径和链接；摘要用于完整性，不等同于来源签名。

原生安装队列串行执行：校验完整候选包集合 -> 写入 immutable revision -> 原子保存 installed selection。当前执行会话继续固定引用原来的 active selection，不覆盖或删除它使用的 bytes。UI 同时展示 installed 与 active revision，安装回执只能报告“已安装，待应用”。

| 操作                           | catalog/运行结果                                                            | 重建 JSRuntime   |
| ------------------------------ | --------------------------------------------------------------------------- | ---------------- |
| start/stop 已在 catalog 的插件 | 当前 graph 正常结算                                                         | 否               |
| 修改配置                       | 返回 applied/deferred/saved-not-applied 等真实结果；可能重建插件 generation | 否               |
| 修改 auto-start                | 持久策略变更；与本次 session intent 分开                                    | 否               |
| 安装/升级包                    | 改变 installed selection，当前 active 不变                                  | 安装本身不重建   |
| 移除包                         | 下次激活集合不含此包；当前 active 可另行 stop                               | 移除本身不重建   |
| 应用已安装变更                 | 关闭当前 Host/JSRuntime，以 installed selection 创建新执行会话              | 是，仅插件运行时 |

为了保持首版一致，新装、升级和卸载统一在显式“应用变更”时进入生产 catalog，不另做热安装分支。安装成功不自动启用新插件；旧节点的持久 auto-start 策略继续生效。显式 start/stop 沿用 Host 的 session intent，重建后不偷偷持久化它；需要下次启动保持的选择用 auto-start 表达。

“应用变更”由原生运行时管理器发起，即使插件全部失败也可操作：

1. 固定目标 selection，暂停接纳新的插件查询/动作/CLI 和管理写入；仍允许关闭必需的存储结算与 cleanup 通信。
2. 关闭 Host，abort 并 drain 已接纳调用，释放 owner 注册，完成持久写入，撤回 Host lease。
3. 释放 timers、原生回调表、pending jobs 引用及全部 JS handles，销毁旧 JSRuntime。
4. 新建 JSRuntime 和 execution session，加载目标集合及配置，依照持久运行策略启动。
5. 发布真实 Host 状态与新贡献，重发当前查询；原生窗口和输入保留。

启动前发现 ABI/包图不兼容时保留旧运行时。旧 runtime 已销毁后若新运行时失败，窗口展示插件运行不可用及诊断；不宣称回滚。用户可显式选择保留的上一包集合并创建 fresh runtime。关闭超时不默认用强杀冒充正常 stop；若验证需要强制重置路径，必须区分未完成 IO 和清理结果，再扩大设计。

开发 profile 中 workspace 源码定义由 Vite 唯一管理；安装同 canonical identity 的制品须拒绝并报告冲突。首版包管理演示在生产 profile 验收；开发模式不提供另一条偷偷绕过 HMR 的即时包加载通道。

## 8. 效率与可观察性

查询热路径只跨桥传输入和结果批次，不逐项 RPC 排序或读取标题。原生应用执行 IO，插件按需使用；不复制全量原生目录到每个 generation。没有新输入或状态变化时无需 UI 轮询。日志有界并批量投递，包含来源 owner，日志 transport 失效不能递归生成日志。

首版用快照和 revision，慢接收端合并尚未发送的查询投影；命令回执和配置提交结果不能被合并丢弃。更复杂的增量协议、二进制编码和缓存只有测量证明需要才增加。

测量输入到原生列表更新、桥接往返、取消到旧动作失效、HMR 到新结果呈现、运行时重建时间与多次循环后的句柄数。记录引擎版本、平台、包大小、provider 数和样本数，先建立基线再设性能门槛。准确的失败状态和 bounded work 是首版要求，不能以未实测的“零成本”作为验收结论。
