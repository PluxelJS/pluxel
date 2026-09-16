# 通用插件宿主与可组合 HMR

> 状态：提案，尚未实现。本文提出目标分层、迁移顺序和验收条件，不是当前 API 契约。
> 本次只提交设计；包名、公开签名和实现须经实际接入验证后确定。

## 1. 问题与目标

应用可能只需要 Pluxel 的 DI、插件生命周期、源码热更新与生产构建，自行组合财务 UI、DuckDB、命令和 IPC，
无需安装 Runtime 的 HTTP、管理、Workbench 和托管数据库。当前缺少与 Runtime static host 对等的轻量生产宿主入口。

目标不是复制 static host 后删除功能，而是建立一个基于 Core 的通用插件宿主，让 Static / Dynamic 来源策略、
HMR 更新驱动和可选能力分别组合。Runtime 使用相同的宿主控制层，增加持久化策略与服务。

架构成立的直接标准：

- Core 轻量宿主与 Runtime 使用同一套 catalog、运行意图和图提交机制。
- Static / Dynamic 共用更新驱动，分别拥有来源发现与变化分类。
- 增减 Workbench 不修改共享 HMR 驱动，切换宿主组合不更换 HMR 引擎。
- 轻量消费路径在安装、开发加载与生产产物三个边界都不强制携带 Runtime。

## 2. 当前事实与约束

当前事实以以下工程文档和实现为依据：

- [Core](../CORE.md) 已拥有身份、DI 图、definition replacement、generation admission、effects 和生命周期结果。
- [HMR](../HMR.md) 明确单一 ModuleRunner、候选事实隔离、不可回滚边界以及 Static / Dynamic 更新行为。
- [Plugin System](../PLUGIN_SYSTEM.md) 定义 Runtime 能力、Workbench 和 Node module 的不同生命周期。
- [设计原则](../DESIGN_PRINCIPLES.md) 与 [治理](../GOVERNANCE.md) 要求 Core 不依赖 Vite、持久化或宿主策略，
  工具链不进入生产服务图，默认作者入口不暴露宿主内部控制面。
- [static host](../../packages/runtime-static/src/internal/host.ts) 创建 Runtime root，准备配置、运行状态与日志策略，
  通过 Runtime 图协调器启动和更新。
- [static Vite](../../packages/runtime-static/src/vite.ts) 同时组织求值、HMR、carrier、Workbench artifacts 和开发控制台。
- [Runtime coordinator](../../packages/runtime/src/internal/reconciliation/coordinator.ts) 同时包含 catalog、图规划、
  session intent、RuntimeState revision 与持久化协调。
- [源码管线](../../packages/rolldown/src/vite/plugin-source.ts) 当前包含 database transform、Runtime/UI resolution preset
  和 Workbench semantic facts；[semantic plugin](../../packages/rolldown/src/rolldown/plugins/pluginSemanticsPlugin.ts)
  虽允许 Core toolchain helper，默认仍选择 Runtime helper。
- [模块分类](../../packages/runtime-dev/src/host-modules.ts) 从 Runtime internal 取得 resolver；这属于实现依赖，
  原生模块/CJS 分类本身不需要管理面。

因此，现有 HMR 既有可提取的实现耦合，也有真实的宿主策略和资源发布语义，不能仅移动 import 或拼接插件数组。
本提案保留当前插件作者模型、identity、fork/provider/optional dependency 行为及生命周期约束，不借此重新设计它们。

## 3. 目标分层

```text
Static：应用入口导入图 ─┐
                       ├─ 共享源码处理与 HMR 驱动 ─→ 通用插件宿主 ─→ Core kernel
Dynamic：fixed + sources┘              ↑                    ↑
                               转换、构建、候选         资源准备、接受、结算
                                      └──── 可选能力扩展 ────┘

Core 轻量宿主 = 通用插件宿主 + 显式启动集合 + Core 能力
Runtime 宿主  = 通用插件宿主 + Runtime 策略 + 选定的运行时能力
```

这里的通用插件宿主是独立逻辑层，不把 Workbench 或持久化搬入 Core kernel。
优先验证独立轻量宿主包的依赖闭包；具体包名及是否使用独立宿主 subpath 留待实现验证，不提前冻结公开 API。
Vite/Rolldown 始终属于工具链，生产启动器无需安装它们。Context shape 与能力集合仍在 root 创建前固定。

### Core kernel

继续拥有图验证、slot identity、required/optional closure、provider-first start、consumer-first stop、
generation gate、effects drain、事务和结构化生命周期结果。不得复制到 Static、Dynamic 或 Runtime 中。

### 通用插件宿主

拥有 immutable catalog、显式运行意图、图操作规划和宿主操作协调。区分希望运行的集合与实际运行结果：
初始化失败不删除运行意图，下次有效源码更新可以恢复失败节点及 required consumers；显式停止则保持停止。

从 Runtime 协调器提取不依赖存储的 catalog 校验、图差异与规划机制，而非重新实现一份简化协调器。
控制入口负责启动、更新、停止和关闭；结果反映本次操作的接受状态与生命周期事实，不读取全局最后一次提交来归因。
轻量宿主的默认运行意图来自明确启动集合，不暗中引入持久化、管理 API 或定时重试。

### Runtime 组合

拥有持久化启停策略、session policy 的输入与恢复、配置/日志等服务准备，以及 HTTP、管理和可选能力安装。
Runtime 将策略解析后的意图交给共同宿主控制层，不保留第二套 catalog 权威或图提交引擎。
管理 RPC、认证与 UI 消费宿主操作和状态，不是通用宿主运行的前提。

持久化 revision 校验及失败结果必须保留现有语义；本提案不假定存储提交与内存图提交可以成为一个可回滚事务。

### Static / Dynamic 来源策略

Static 从确定的应用入口取得 catalog，跟踪普通 import closure，区分 definition 更新与需要重新创建宿主的应用变化。
“静态”指目录由应用入口确定，不禁止源码更新引起目录增删，不包含任意目录扫描。

Dynamic 合并 fixed baseline 与声明的 mutable sources，负责发现、增删和 source anchors，继续只通过文件协议
与 package producer 交互。来源策略不决定持久化启停、不直接创建第二套 Core 事务。

两种策略共享求值、失效、失败候选恢复与执行机制，不强制合成一个处处判断 static/dynamic 的大插件。

## 4. 一次更新的权威与阶段

一次定义更新沿单一控制路径执行：

1. 来源策略识别变化，共享工具链转换、求值并形成 immutable candidate；转换事实属于本次候选。
2. 扩展准备所需资源。准备不改变当前生效资源；允许的后台工作必须有明确的新旧代归属。
3. 通用宿主在自己的操作序列中读取最新运行意图，完成图规划与校验；过期准备结果须重新验证或丢弃。
4. Core 执行旧代关闭与资源排空，在既定接受点发布新图和 catalog，激活新代启动所需的预验证资源。
5. Core 启动新 generation，宿主返回本次生命周期结果；工具链据接受事实结算模块图及 semantic facts。
6. 扩展按各自发布结果执行通知或后台任务，候选未接受时释放其准备资源。

必须区分三个边界，不把它们压成一个成功 boolean：

| 边界                     | 含义                                               |
| ------------------------ | -------------------------------------------------- |
| 旧代 admission 关闭前    | 验证/准备拒绝可以保留旧运行代                      |
| 第一次关闭旧代 admission | 已越过不可回滚点；不能再声称旧实例完整保留         |
| 图与 catalog 接受点      | 候选成为当前权威；新 generation 启动前激活对应资源 |

初始化、drain 或接受后的通知失败不能把已接受候选报告成“未应用”。若发生不可回滚点之后、正常接受之前的异常，
必须根据 Core 的实际结果报告中断/不可用及权威状态，不能用“尚未触发接受回调”推导旧代仍健康。
公共结果的最终结构由实现验证决定，至少能区分拒绝、接受及生命周期问题；异常路径不得丢失接受事实。

接受阶段尽量只做预验证状态的同步切换，不执行编译或长耗时 IO。多扩展的顺序、依赖和失败语义由宿主预先固定；
不能声称多个回调天然原子。若切换仍抛错，应报告实际部分发布状态，不伪装为跨资源回滚。
先用真实 Workbench/Node artifact 接入验证最小阶段契约，不预设任意后端、任意 hook 的通用框架。

### 并发与关闭

工具链负责候选求值顺序，宿主负责所有图修改顺序。HMR 与管理命令进入同一个宿主提交入口，
不得各持一份运行意图快照后直接修改 Core。队列等待不得形成宿主反向等待 HMR 的锁环。

关闭先停止来源与直接调用的 admission，丢弃尚未执行的 debounce/候选，等待已接纳工作按明确规则结算，
随后完成 Core/effects 与扩展清理，最后关闭 runner。关闭后不得重新启动 watcher 或发起新发布。
取消不等于回滚或底层 IO 已停止；具体操作必须说明是撤销排队、协作停止还是仅丢弃迟到结果，关闭仍等待真实资源释放。

应用入口变化仍可要求 full-host replacement。旧宿主停止后从旧成功定义创建 fresh compensation host，
属于宿主重建补偿，不是恢复旧 generation；仅补偿成功才能报告恢复。普通图事务不继承这种“回滚”语义。

## 5. 可组合能力扩展

对外可提供一个能力组合入口，内部同时连接源码插件、构建过程和必要的宿主更新阶段。
“Rolldown HMR 插件”在此表示组合入口，不表示 Rolldown 的 transform/build hook 本身能控制运行中生命周期。
生产构建复用转换与 artifact 构建部分，开发模式才安装 Vite 监听和更新接入。

### Workbench

拥有声明 lowering、Content/producer 构建与校验、候选 topology 准备，以及接受点的资源激活。
继续由 Workbench 自己决定何时关闭会话、刷新 document；共享 HMR 驱动不直接读取 `ctx.workbench`。
允许后台 producer 构建的路径保留 building/failed 状态和 epoch 校验，迟到结果不得覆盖新候选。
不开启时不安装 backend、compiler、watcher、route 或 browser graph。

### Node artifacts

拥有声明、单独构建、加载及 owner-bound consumer setup。保留“新 setup 成功后 cleanup previous，失败保留
last-known-good”的现有语义；owner stop 使迟到 setup 失效并清理。不能将其强制改为 Core definition 的先停后启。
artifact-only 更新无需伪造 catalog 变化，但共享 owner/关闭边界，不能在 owner 已撤回后发布。

### 普通运行时服务

只需遵守 root/generation 生命周期的能力无需成为 HMR 扩展。Vault 例如不依赖 Workbench，但当前依赖
root persistence 和启动前 prepare；拆分后仍需宿主负责这些依赖及 flush/关闭。
使用 Vault 的 Plugin 更新不等于 Vault 服务自身实现的热替换。服务可独立组合不意味着 Core 默认安装它。

## 6. 模块身份、构建与发行

- 保持每个 Vite server 单一 Pluxel SSR ModuleRunner，不因扩展或宿主组合产生第二份 evaluated namespace。
- Core singleton bridge 是基础要求；Runtime、Elysia 与 UI singleton 由对应能力组合补充，不能把 Runtime preset
  当作 Core 默认配置。仍保持 bare specifier 与文件路径分类一致、原生/CJS 边界正确。
- Core-only lowering 生成 Core toolchain helper；database 与 Workbench 的 transform、resolver preset 和 build 依赖
  必须在各自组合边界归属清晰，不靠 tree-shaking 掩盖强制安装依赖。
- source/build 使用同一 canonical entry 与 root export 身份规则，不让 bundle 路径、constructor 或 displayName 成为身份。
- artifact candidate 的事实提交/丢弃遵循真实接受点，不能让失败候选污染 active classification。
- production host 只加载构建后的定义与启用能力的产物，不安装 Vite 或在启动时重编译源码。

安装依赖、实际开发加载和生产 bundle/import closure 分别验收；关闭功能、没有执行某个分支或一次 tree-shaking
成功，都不足以证明依赖裁剪。TypeScript declarations 也不得把轻量消费者带回 Runtime。

## 7. 迁移顺序与删除项

1. 提取通用宿主控制层，用 Core-only provider/consumer 完成生产启动、手动候选更新与关闭。
   同时让现有 Runtime static 路径使用它，验证 Runtime 策略能叠加，而非新增长期平行协调器。
2. 拆出 Core source preset、runner/classifier 与候选更新驱动。用真实 Vite 源码更新验证 Core static 和 Runtime static；
   保留失败导入恢复、singleton identity 和应用重建语义。
3. 将 Workbench 和 Node artifact 的工具链接入移至能力组合，移除共享驱动中的专有服务调用。
   两者保留各自 artifact lifecycle，验证启用与禁用成本。
4. Dynamic 的 fixed/mutable 来源接入同一驱动，保留 source producer 文件协议、发现边界和删除行为。
5. 验证发布 tarball、干净消费项目与生产产物；更新当前工程文档、用户文档和公开 API 后完成迁移。

各阶段完成后删除被替代的对应实现：Runtime 协调器中的通用 catalog/图规划副本、route 中重复的更新执行与结算代码、
共享 preset 的无条件 Runtime 能力安装，以及跨包源码路径借用的已迁移 helper。
现有 Runtime 公开入口可继续作为组合入口，不能继续保留另一套语义权威。迁移不顺带删除 fork、重做作者 API、
改变 Workbench 协议或拆分所有 Runtime 服务。

实施时用户可见的包变更按仓库规则添加 Tegami changelog；本提案本身不修改当前 API 文档或包版本。

## 8. 验收与否决条件

| 场景                   | 必须观察到的结果                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Core 轻量闭环          | 资源 provider 和 consumer 按依赖启动，源码替换重启 closure，退出等待资源真正释放      |
| 编译/求值/结构验证失败 | 接受前拒绝保留旧代；修复原文件、新导入文件或缺失依赖后正常恢复                        |
| 新代初始化失败         | 报告已接受及受阻节点；下次有效更新恢复 desired closure，显式停止保持停止              |
| 连续更新与关闭         | 失败不堵塞后续更新，迟到候选不能覆盖新代；取消不冒充完成清理，关闭后无新发布          |
| 普通依赖文件变化       | importer graph 正确触发更新，不只监听 Plugin entry                                    |
| Runtime 管理并发       | 管理启停与 HMR 按同一入口结算，持久化 revision 冲突不静默覆盖用户意图                 |
| Static 应用变化        | 需要时完整重建，补偿失败不报告恢复，旧句柄不冒充新代                                  |
| Dynamic 来源变化       | fixed 与 mutable 共用图，新增/替换/删除保持身份和依赖正确；安装仍由 producer 负责     |
| Workbench 开关         | 启用保留 artifacts/publication/session 行为；禁用无对应 backend/compiler/browser 负担 |
| Node artifact          | artifact-only 更新保留 staged setup 语义，owner 撤回后的迟到 setup 被清理             |
| 开发与构建身份         | 同一插件的 canonical identity 一致，无重复 Core/Runtime module identity               |
| 干净消费项目           | 仅通过公开入口启动和开发；安装、声明、开发加载、生产依赖闭包均无强制 Runtime 依赖     |

先用真实 Vite ModuleRunner 和发布产物验证最短闭环，再扩展已有生命周期和 Runtime 回归。
若涉及已有运行中的开发进程，依照 [开发控制台](../../docs/development/dev-console.md) 发现并固定实例；
隔离 test host 只证明隔离路径，不代表在线应用状态。

以下任一情况表明分层尚未成立，应调整边界而非追加模式分支：

- 新增能力仍要求修改 Static / Dynamic 驱动的专有判断。
- Runtime 与轻量宿主仍各保存一套 committed catalog 或各实现一次图事务。
- 为提取共享层而把 RuntimeState、Workbench DTO 或 Vite 带进 Core kernel。
- 扩展可以独立提交插件图，或接受后失败仍被报告为保留旧实例。
- 轻量消费必须导入 internal API、安装 Runtime，或手工维护生成身份。

## 9. 假设与未决问题

当前假设是 Core 的事务与生命周期机制足以承载两种宿主；主要工作是提取宿主控制层和工具链能力边界，
而非新增一个事务引擎。尚未通过拆分、运行或发布实验验证工作量与依赖裁剪。

实施前需通过第一条真实路径决定：

- 通用宿主的包归属、最小公开入口与必要结果类型；默认 Plugin 作者入口保持收敛。
- RuntimeState 持久化失败/revision 冲突如何接入共同操作序列，保留当前可恢复与不可回滚语义。
- 多个真实扩展所需的最小阶段契约、排序，以及接受阶段异常的实际可观察状态；不先公开通用 middleware 系统。
- Core-only Context 组合及声明生成是否能保持能力类型准确，并遵守内联 Context kernel 的身份边界。
- Workbench/Node artifact 的发行拆分粒度，如何同时保证未启用时零加载与轻量安装闭包。

这些未决项不改变目标控制路径：来源产生候选，扩展贡献能力，通用宿主决定运行意图与唯一图提交，Core 执行生命周期。
