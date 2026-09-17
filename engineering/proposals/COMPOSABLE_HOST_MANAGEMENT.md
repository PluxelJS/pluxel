# 可组合 Host 管理面与自定义 Runtime

状态：设计提案，尚未实现。本文中的新入口、类型和调用流程是实现目标，不是当前可用 API。
本轮只提交设计，不修改代码、包版本或当前用户用法。

## 1. 目标与当前缺口

外部应能创建 `@acme/runtime`：基于 Core 提供自己的 Context 服务，使用 Host 管理插件，使用 Host-dev 开发，
并以任意前端框架实现自己的工作台。它的插件可以依赖 `@acme/runtime`，如同官方插件依赖 `@pluxel/runtime`。
外部无需引入官方数据库、HTTP 框架、Workbench UI 或 Workbench 的界面发布模型。
只使用通用能力的插件仍依赖 Core；依赖平台服务的插件明确依赖相应 Runtime，不承诺任意平台插件互通。

当前已具备 Core 插件模型、Host coordinator、动态来源和共享 ModuleRunner。尚缺：

- `createHost()` 内部创建 Core root；官方 Runtime 则通过内部 composition helper 创建自己的 root。
- 完整管理 use case、管理协议和浏览器客户端仍在 Runtime。
- AI console 及其 Vite 会话绑定仍由 Runtime 拥有，轻量 `host({ entry })` 未提供这些能力。
- 配置的底层事实在 Core，但持久化管理操作、配置展示投影仍偏 Runtime。

当前外部可以用 Runtime 的 `management: true`、`workbench: false` 自建 UI；这是 headless Runtime，
不是本提案要求的独立 Runtime。现有事实以 [插件系统](../PLUGIN_SYSTEM.md)、[Runtime](../RUNTIME.md)、
[配置](../CONFIG.md)、[开发控制台](../DEV_CONSOLE.md) 与 [HMR](../HMR.md) 为准。

### 验收用例

一个独立安装的示例工作区，定义自己的 Runtime 包、一个自定义 Context 服务和一个消费它的插件。
使用非官方 UI 组件的管理页面，完成状态查询、启停、配置编辑，并通过 AI console 操作同一个 Vite 实例。
固定插件与动态来源共用这条路径；其依赖闭包和构建产物均不包含 `@pluxel/runtime` 或官方 Workbench。
官方 Runtime 必须使用相同公开组合入口，不拥有外部无法使用的关键接线特例。

## 2. 包边界

不新增 host-management、host-console、runtime-static 等独立包。子入口承担明确的平台边界。

| 入口                               | 责任                                                      | 不承担                                                |
| ---------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| `@pluxel/core`                     | 作者模型、DI、graph、generation、配置事实与校验           | HTTP、持久化策略、管理 UI                             |
| `@pluxel/core/host`（新增）        | 为 Runtime 作者提供受控的 root 创建前组合能力             | 默认作者入口的 service 安装、运行时修改 Context shape |
| `@pluxel/host`                     | Host 生命周期、catalog、运行意图、通用管理操作及协调队列  | 网络 listener、UI、官方服务                           |
| `@pluxel/host/management`（新增）  | 管理请求、认证接入、会话与订阅、fetch 和 WebSocket 接入   | Elysia、Vite、任意代码执行                            |
| `@pluxel/host/web`（新增）         | 浏览器会话、通用管理客户端和校验后的 DTO                  | server class、Node、React、Runtime 类型               |
| `@pluxel/host-dynamic`             | 来源发现、监听、撤回                                      | 管理后端、包管理器、Vite                              |
| `@pluxel/host-dev`                 | ModuleRunner、候选求值、更新队列、当前 Host 会话          | 官方 Runtime 服务                                     |
| `@pluxel/host-dev/vite`            | 轻量应用入口与自定义 Runtime 的开发组合接入               | 第二个 Host 或模块缓存                                |
| `@pluxel/host-dev/console`（新增） | 本地执行服务、run scope、通用开发操作和类型               | 浏览器 RPC、固定 Runtime 能力集合                     |
| `@pluxel/runtime`                  | 官方 Context 服务、存储适配、管理附加能力与 HTTP 承载     | 通用管理逻辑的另一份实现                              |
| `@pluxel/runtime/vite`             | 组合 Host-dev 与官方 artifacts、carrier、console 附加能力 | 另一套 HMR 驱动                                       |

`core/host` 是同包内的组合入口，不是把 `@pluxel/host` 搬进 Core；Core 仍不反向依赖 Host。
现有 Core 内联 Context kernel 的发行规则保持不变，不能只重导出当前 internal 文件，或让 capability identity 分裂。

`host/management` 可以依赖通用 RPC 库，但根入口及其类型图不能导入该入口。浏览器构建只能触及 `/web` 的依赖图。
子入口隔离保证运行和打包边界，不保证包管理器完全不下载同包声明的传递依赖；若将来安装体积成为实际问题，再凭测量拆包。

## 3. 自定义 Runtime 的 root 接入

选择「创建前组合，再一次性交由 Host 拥有」；不接管任意已经运行的 Root，不允许一个 Root 绑定两个 coordinator。

`core/host` 提供基于现有 Context installation 模型的受控创建入口：固定 Core 必需能力，自定义 Runtime 声明附加能力，
并通过显式支持的配置存储和生命周期集成位置完成接线。不开放替换 PluginService、effects 或直接变更事务实现的能力。
Core lifecycle 集成沿当前固定 hooks 的顺序、失败传播与 cleanup 语义收敛，不另建无限制 hook 总线。

Host 创建分为两个互斥输入：默认 Core 配置，或自定义 root factory。不要接受 `ctx?`、`config?`、`factory?`
任意组合的 options。最终 TypeScript 名称在实现两个实际 Runtime 调用点时确定，以下是生命周期契约：

1. 接纳应用声明并验证固定 catalog；此时未创建服务。
2. 调用 factory 一次。它创建完整且尚未启动插件的 Core-compatible root，服务资源立即登记 cleanup。
3. factory 成功返回时把 root 及其关闭责任交给 Host；失败前由 factory 清理已创建资源。
4. Host 绑定唯一 coordinator、配置管理与状态存储，完成必要启动准备，再接纳初始 catalog 并启动。
5. 返回后任何准备/启动失败由 Host 清理；不把半初始化 root 暴露给管理连接。

factory 返回值保留具体 Context 类型；自定义 Runtime 在自己的作者入口投影服务类型。不得要求把服务声明全局补到
官方 Runtime Context，也不得把所有平台的可选字段合并成一个巨型 Context。
Runtime 作者可以借用 root 做服务接线；普通管理客户端不取得 root、PluginService 或 raw transaction。

关闭责任唯一：Host 拥有 source 会话、coordinator、generation 和 root；管理端点与开发附件借用 Host。
关闭先撤销附件接纳与旧会话，再排空已接纳操作，停止 generation，最后释放 root 服务。
`close()` 幂等并复用同一个完成结果；清理失败仍尝试其余清理，最终报告聚合错误。
端点单独关闭只撤销自身会话，不关闭 Host；开发服务器关闭则由开发宿主所有者关闭 Host。

## 4. Host 通用管理操作

本地管理 facade 由 Host 持有，管理端点和 console 都借用它。优先迁移现有 use case 和领域结果，
不要为每个入口再创建 registry、manager 或状态缓存。

通用集合包括 catalog/status、生命周期和 auto-start、fork、依赖选择、配置读写及相关订阅。
保持三种事实分离：catalog 中可用、希望运行、实际上正在运行。来源安装结果不替代这些事实。
catalog、配置与状态 revision 各自保留；不以单个递增数字伪装跨存储全局事务。

所有管理 mutation 进入现有 coordinator exclusive queue；读操作返回已确认的 immutable snapshot。
多步脚本或多次客户端请求不是整体事务。慢订阅合并最新状态并有界保留，不积累无限事件队列。
生产不创建假的 HMR 状态；开发尝试诊断由 Host-dev 提供，管理会话仅在已接入时发布该能力。

客户端可判断的拒绝保留稳定 discriminant/code，包含地址、已关闭会话、非法输入、只读、revision 冲突等领域情况。
编程异常继续 reject，不按 message 猜测失败类别；HTTP/执行 envelope 不吞并领域失败和 apply report。

### 配置与持久化

Core 仍是 raw record、revision、validation cache、normalized snapshot 和 generation notification 的唯一权威。
Host 提取当前 Runtime 的配置管理编排；存储适配器只负责读取、确认写入和关闭，不重复执行 schema 或通知插件。
默认内存提交确认不承诺跨进程持久化。文件适配留在 Runtime；外部可以提供自己的存储实现。

保留当前顺序：validate once → stage → flush/存储确认 → 确认 revision → notify 当前 generation。
写入失败不得使未确认值可见；通知失败保留已保存配置并报告 `saved-not-applied`，未运行时报告 `deferred`。
不因抽取管理面引入第二个 ConfigService，或把外部存储强制实现成 Runtime ConfigService 子类。

Host state 与配置存储是不同领域，不合成万能 KV 接口，不承诺跨二者 ACID；既有复合 mutation 的失败与补偿语义必须逐项保留。
Readonly、冲突、初始化失败及关闭责任是存储契约的一部分。初始 seed 只作用于新 store，已有持久记录的权威不改变。

可移植配置展示计划由可选 presenter 生成；复用当前 schema 投影，不把 Valibot 表单编译器放进 Host 根入口。
未安装 presenter 时仍支持配置读取、校验与修改，显式缺少表单描述能力；客户端不执行服务端 schema 函数。
配置描述、平台 catalog 分组和 UI 布局偏好不是 Core graph 事实；后两者由工作台/平台自行保存。

## 5. 可挂载管理端点

`host/management` 创建端点但不监听端口。端点借用指定 Host 和管理操作，提供三类职责：

- `fetch`：处理命中管理路径的普通 Request，返回 Response。
- WebSocket 接入：接受 carrier 已完成 upgrade 的连接，绑定同一个认证及管理会话。
- `close`：关闭新接纳并撤销连接、订阅和 retained leases。

挂载前缀在创建时固定；子路径相对此前缀解析。未匹配返回明确的「未处理」结果，由 carrier 继续分发，
不能用真假 404 的内容猜测是否命中。最终可采用 `Response | null`；平台包装层负责转换成自己的路由返回值。
绑定到独立路径的外部服务器也可以把未处理转换成 404。

标准 fetch 不能表达跨平台 WebSocket upgrade。保留现有 Cap’n Web over WebSocket 协议，提供最小连接适配契约；
不强迫 Node/Vite 用非标准 Response 冒充可移植 upgrade，不另造 REST 与 RPC 两套管理操作。
若 carrier 不支持 WebSocket，挂载时明确拒绝完整管理端点，不在访问后才表现为半可用后台。

认证前不授予管理 capability。来自真实连接的 peer、TLS 和可信 origin 信息由 carrier 显式传递，缺失按 unknown 处理；
不得根据客户端提供的 Host/Forwarded header 推导信任，也不得自动给自定义 carrier 开放 loopback recovery。
通用认证接入保留身份/授权及撤销边界；官方 Runtime 适配当前 recovery 和 owner-bound provider 策略。
需要插件提供认证的外部 Runtime 必须在 root 创建前安装对应 owner-bound 服务，其 provider withdrawal 进入 generation drain。
浏览器 cookie commit、origin 校验和单次 ticket 沿现有安全契约迁移，不只抽取业务路由而遗漏会话接线。

`host/web` 提供通用会话和 borrowed Management facade。一次 document 会话使用一条连接，认证后取得明确的能力描述。
Runtime 的 Workbench 与附加管理继续共享此物理会话，不另建一条重复认证的管理 socket。
扩展采用启动时固定、具名且有明确类型/版本的 capability root，由平台自己的 `/web` 封装；
不开放 `invoke(string, unknown)`、自动枚举 Context 服务或任意插件方法的全局 RPC。
各扩展自行拥有输入校验、授权、调用 lease 与撤销，不能凭已认证连接绕过 owner admission。

## 6. Host-dev 会话与 AI console

开发会话持有当前 Host、host epoch 和统一驱动的有限更新 barrier。
这是 Runtime 集成所需的受控借用接口，不是可写的 `currentHost` 全局变量。
附件在会话发布后绑定一次，返回 cleanup；绑定失败清理已绑定附件及候选宿主，不公布半成功会话。
固定附件按声明顺序绑定、逆序清理；关闭后禁止迟到绑定。宿主发布不在 coordinator 锁内等待附件回调。

`host-dev/console` 提取现有 Unix socket discovery、执行队列、源码 admission、取消、预算与结果协议。
CLI 保持 discovery/submit/result/cancel 职责，不依赖 Runtime，不执行插件代码。沿用当前 Unix 平台支持范围。
通用 run API 操作 Host 的插件、依赖、fork 和配置；类型化 Plugin target 仍检查当前 catalog constructor identity。
Runtime 的 HTTP、commands、Workbench、日志 store 等由 Runtime 创建 run scope 时显式提供；
自定义 Runtime 可以提供自己的具体 scope 类型与附加操作，不要求冒充 Runtime dev 接口。
不把 test host 接口继承到 console，也不把本地 TypeScript 执行暴露到公共管理 HTTP。

每个 run 借用一个固定 host epoch。先等待已观察文件更新和有限 barrier，然后执行；脚本体不长期占据 coordinator。
host replacement 先 abort 旧 run、撤回管理连接和附件，再 drain 跟踪操作并关闭旧 Host；后续 run 才使用新 epoch。
协作式取消不回滚已提交操作，不能强制终止任意 JS 或自动回收用户私建资源；未 settle 的 run 不虚假释放执行 slot。
操作取消、执行完成和领域成功保持三个独立结果层次。现有源码/JSON/排队/结果保留预算不因迁移放宽。

## 7. Vite、来源与刷新

平台使用者只安装一个平台开发插件：轻量应用用 `host-dev/vite`，官方应用用 `runtime/vite`，
自建平台用 `@acme/runtime/vite`。不要求叠加 host/static、host/dynamic 和 runtime 三个驱动。
平台开发插件在内部组合共享驱动、宿主 factory、管理 carrier 和 console scope；普通前端插件照常使用。
管理适配挂载同一个 Vite server 并借用同一个 Host，不再次 createHost，也不创建另一个 ModuleRunner。

应用仍为普通对象与 `satisfies`，固定 `plugins` 和可选 `sources` 是统一来源配置，不增加 static/dynamic mode 开关。
自定义 Runtime 自行定义服务启动配置，但复用来源类型和求值语义，不恢复只做 identity 的 defineXXXConfig。
Host root factory 属于平台接线；不要把它当成每个应用必须重复书写的配置。

自定义 Runtime 作者包必须进入同一 canonical 模块身份策略。Vite、semantic lowering、声明产物与生产发行必须验证：
Core 作者符号原样转发、自定义服务 capability identity 唯一，开发和生产不会各装一份 Core。
不按包名后缀猜测 Runtime；如需平台声明固定 singleton entries，应限定于平台集成输入并校验，
不把可随意覆盖 classifier 的 policy 暴露给业务应用。现有 framework facade 的生产映射须覆盖实际示例入口。

| 变化                                     | 必须发生的行为                                                   |
| ---------------------------------------- | ---------------------------------------------------------------- |
| 插件源码或动态 entry 更新                | 当前 Host 内更新受影响 graph；保留运行意图，不默认重建 root      |
| 配置 mutation                            | 当前配置 revision 与 notification；不借 Vite reload 冒充配置应用 |
| 失败候选                                 | 接受点之前保留上一有效状态；接受点之后如实报告 lifecycle issues  |
| 应用服务配置变化导致 root replacement    | 新 host epoch；旧连接/run 引用撤销，不转接旧 handle              |
| 官方 Workbench publication/producer 变化 | 保持既有会话撤销与完整 document refresh 策略                     |
| 外部 UI 自身组件变化                     | 使用外部框架的正常 Vite HMR                                      |

纯通用管理订阅可在同一 Host 内观察插件状态变化，不要求每次插件 HMR 都断开；带 generation-bound 扩展的会话按其撤销契约失效。
客户端显式报告 epoch invalidation，不在旧 document 静默连接到新 Host。外部 shell 决定提示或整页刷新；
保留官方刷新策略不等于强制外部实现官方 Workbench 的 renderer/remote 模型。

动态 package manager 仍为文件生产者，安装 ≠ 发布 ≠ catalog 接纳 ≠ running。
安装卸载及其 UI 属于平台插件扩展；通用管理只报告已观察的来源/catalog/运行事实，不内置 registry 或 pnpm。
生产原生 ESM 的已加载入口升级仍要求 restart；本提案不通过 query cache bust 声称提供生产 HMR。

## 8. 测试与迁移

先移动所属实现与现有测试，再补真实边界缺口；不按每个 facade 重复测试 graph 和配置规则。

| 验证边界           | 最少需要保护的风险                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| Core / `core/test` | 自定义能力的 owner 隔离、插件配置与 generation cleanup；复用已有领域测试                           |
| Host               | factory 失败和唯一关闭责任、管理排队、存储失败不发布配置、停止意图保留                             |
| Management carrier | 真实 HTTP/WebSocket 认证、unknown peer、订阅撤回、端点关闭不关闭 Host                              |
| Host-dev + CLI     | 真实 Vite 同实例操作、有限 barrier、epoch replacement、失败附件清理；迁移现有 console 测试         |
| 外部打包示例       | 自建 Runtime 类型与 singleton identity、Core-only 依赖闭包、管理 UI/config/console、固定与动态来源 |
| 官方 Runtime       | headless management、Workbench 单会话与刷新、官方宿主及 create 示例回归                            |

不新增独立测试包；普通插件用 `core/test`，官方服务插件用 `runtime/test`，`@pluxel/test/vitest` 仍为唯一预设。
只有真实重复夹具需求才增加 `host/test`。跨 carrier 行为用真实进程，test host 不能代替正在运行的应用。
官方既有测试是回归证据；独立 tarball 安装样例是抽象成立的证据，不能以 workspace alias 通过替代。

### 实施顺序与完成门槛

1. 先做自定义 root composition 和配置/状态适配边界；官方 Runtime 改走同一入口，验证 owner 与关闭责任。
2. 提取 Host 通用管理操作和 DTO；迁移领域测试，不把日志/Vault/Workbench 混入基础集合。
3. 提取管理 endpoint、`host/web` 及必要会话扩展接点；官方 HTTP 挂载，验证原单 socket 契约。
4. 提取开发会话与 console；官方 Runtime、轻量 Host、自建 Runtime 走同一驱动。
5. 完成外部示例和官方/create 回归，核对生产模块身份及 disabled 依赖闭包。
6. 更新 `docs/` 的宿主组合、配置、测试、console 和自定义管理指南；更新当前工程约束及 package exports，
   为公开包实际变更加 Tegami 记录。删除过渡内部转发和已实现提案段落，不保留兼容 alias。

具体 factory/endpoint/extension TypeScript 签名须在步骤 1、3 用官方与自建两个调用点共同验证，
但本提案已确定所有权、能力边界、调用顺序和失败规则；不能以名字未定为由扩大成通用插件注册框架。
实现过程中若发现现有服务必须反向依赖 Runtime，先拆清该服务的事实与适配，不以 optional Runtime import 掩盖问题。

## 9. 不纳入本轮的设计

不把官方 Workbench 变成可替换 React/MF adapter，不要求外部实现其 Content/View/Attachment；
不提取所有 Node/Workbench artifact compiler，不设计通用微前端平台，也不重做包管理器。
[自定义宿主 artifact 组合](COMPOSABLE_PLUGIN_HOST_HMR.md)仍是独立后续边界。
本提案的价值以「外部能自建 Runtime 并复用插件管理和开发链」验证，不以新增包、接口或测试数量衡量。
