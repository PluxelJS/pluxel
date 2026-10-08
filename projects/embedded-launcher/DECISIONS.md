# 设计思考与取舍

本页解释 [目标设计](DESIGN.md) 的选择，不另维护生命周期或消息契约。项目展示的核心是：原生应用拥有业务基础，Pluxel 管理可替换扩展，同一插件可在不同执行环境消费相同应用能力。

## 决策顺序

1. 先固定要证明的路径：同一插件开发时 HMR、发布时内嵌执行，两端都调用真实应用能力。
2. 再分配所有权：应用拥有原生资源与执行监督，Pluxel 拥有插件生命周期，UI 只消费投影。先有边界，再选语言和组件库。
3. 按实际 npm 包与 API 探针选择运行时，再选择能直接嵌入它的主应用工具链；CLI 成功不推导嵌入成功。
4. 按外部事件接入、必要组件、测试反馈和维护负担选择 UI，不按 Launcher 外观、组件数量或模型熟悉度决定。
5. 从真实嵌入往返开始逐阶段验证，再补齐完整演示；只在具体证据否定路线时重开对应决策，不维护备用实现。

当前结论是 Rust + Iced + LLRT；接线与依赖只在 [STACK](STACK.md) 维护。以下保留取舍依据，不保留并行实施路线。

## 为什么选 Launcher

查询 provider、动作、命令、配置和原生能力都有清晰的扩展边界。少量 UI 即可观察插件依赖、启停、失败和更新；不需要先完成文档模型、编辑器、撤销栈或渲染引擎。原生应用保留自身能力，插件对它增加功能，而不是用插件拼装一个空壳服务端。

Calculator 是纯业务 provider，Launcher 与 CLI 是两种消费方式；NativeActions 覆盖真实异步原生调用，RemoteLookup 补充出站 IO 与能力观察。继续增加天气、文件索引、账户、AI、插件市场会把工作变成产品开发。

## 为什么选 Rust 原生应用与 LLRT

选择 LLRT 的首要依据是插件生态：同条件包测试与部分 Node 工具兼容更符合目标，不因 C++/Rust 决定运行时。Rust 避免主应用与 LLRT 的 Rust 装配层之间额外的跨语言 FFI，底层引擎绑定仍由 rquickjs 提供。首版 Linux，应用服务不依赖 UI 类型。

LLRT 放在专用线程，复用异步执行机制并验证 CPU 预算与公平性；线程不是权限沙箱。JS 值和销毁留在执行线程，UI 操作回主线程。LLRT 的绑定工具可减少手工代码，但现成 Vm 的退出和全局策略仍需接管，不能宣称比 txiki 天然更适合嵌入。

运行时采用完整现成实现的选型依据与现代包兼容门槛见 [运行时研究](RUNTIME.md)。标准 Web API 的开发/发布 backend 可以不同；应用特有能力继续连接真实原生应用。

### UI 库与 coding agent

2026-10-08 的文档/API 调研，不是完整候选应用的性能、稳定性或 agent 成功率实测。所有候选都能接外部消息；差异在于应用需要维护多少接线与 UI 约定，而不是谁有“QuickJS 专用支持”。

| 方案 | 与本例相关的优势 | 取舍 |
| --- | --- | --- |
| Iced + 按需 iced_aw（选择） | Subscription/Message/update/view 直接表达外部事件与显示投影；iced_test 支持无头交互与截图 | 组件够本例使用，但需统一主题和布局；iced_aw 是扩展控件，不是完整桌面设计系统 |
| GPUI Kit | 组件、主题与资源配套更完整；异步任务接收 channel 后更新 Entity，同样可以清晰接入 LLRT | 需管理 Entity/Context、观察关系和任务寿命，并使用 Kit 配套的 GPUI 快照；本例暂不需要富工作台的组件广度 |
| libcosmic | 基于 Iced 的完整 COSMIC 应用工具包，比附加控件更成体系 | 同时采用 COSMIC 设计体系和应用约定；本例无需额外平台集成 |
| Slint | 声明式 UI、预览与 Rust 逻辑分离，有无头测试和开发 MCP 工具 | 新增 .slint DSL、生成接口与模型映射；需核对许可与发布条件；本例没有足够的视觉设计收益来优先采用 |
| egui/eframe | Rust 内直接布局，egui_kittest 与 inspection 提供测试反馈 | 外部事件与 UI 状态的组织更依赖应用约定；并非不能做好，但不作为本例默认 |

来源：[Iced Subscription](https://docs.rs/iced/0.14.0/iced/struct.Subscription.html)、[iced_aw](https://github.com/iced-rs/iced_aw)、[iced_test](https://docs.rs/iced_test/0.14.0/iced_test/)、[GPUI Kit 配套版本](https://gpui-kit.com/docs/installation/)、[GPUI Task](https://gpui-kit.com/docs/task/)、[COSMIC Toolkit](https://pop-os.github.io/libcosmic-book/)、[Slint testing/MCP](https://docs.rs/i-slint-backend-testing/1.18.1/i_slint_backend_testing/)、[Slint 许可证入口](https://github.com/slint-ui/slint/blob/v1.18.1/LICENSE.md)、[egui_kittest](https://docs.rs/egui_kittest/latest/egui_kittest/)、[eframe](https://docs.rs/eframe/latest/eframe/)。这些工具的存在不等于本机已经验证可用。

最终选择 Iced，不是认定其组件或性能胜过 GPUI Kit，而是本例的主要复杂性在跨环境事件、失效与回执，显式消息流加必要控件已能完整表达。若目标变成编辑器、多面板、复杂表格工作台，GPUI Kit 的收益会更大；这不是当前范围。Iced 仍需验收焦点、中文输入、实际窗口和资源稳定，不能以消息模型推导行为正确。

不让 UI executor 承载 LLRT，不让订阅寿命决定 runtime 寿命，不把 UI task 丢弃当作远端取消。上述要求对所有候选相同。桥接协议与 Services 不依赖 UI 库，但不为潜在替换再造 UI 抽象；Rust UI 的热重载不代替 Node/Vite 插件 HMR。

## 为什么开发侧继续运行 Node

Node/Vite 保留现有源码求值、语义编译、依赖失效、诊断和 HMR。开发插件仍通过应用 Services 操作正在运行的原生应用，实际跨进程通信恰好迫使能力契约明确异步、可取消、可撤回。

仅在 Node 里模拟剪贴板或原生目录会隐藏关键风险；每次修改都重启原生应用又不能展示 HMR。选择原生应用持续运行、Node 插件后端独立更新，是两者间直接且可验证的路径。Node 测试通过不证明 QuickJS 兼容，生产引擎验证从第一个阶段开始。

## 为什么不让每个插件拥有一个 JSRuntime

Pluxel 当前 constructor DI、caller facade 和共享服务建立在同一 JS 对象空间。每插件一个 runtime 会要求分布式依赖协议、跨 runtime API 和不同的失败语义。本示例用一个 JSRuntime 承载一个 Host，stop/start 只改变 Plugin generation；更新包时整体重建 runtime。

这保留 Pluxel 核心能力，不把嵌入适配变成另一套插件系统。第三方恶意代码的隔离需要独立设计与验证，不能从 QuickJS 或 capability token 的存在推导安全承诺。

## 为什么采用服务，而不把核心应用注入成巨型对象

Service 提供明确的业务 surface 和固定 owner view，能将注册、订阅与调用撤回接入 generation。原生资源的真正 owner 仍在应用，Plugin 无权关闭共享 backend。内部实现继续复用原生 API，只在跨环境数据、生命周期和访问边界增加必要适配。

不是所有东西都要成为新 Service。Host 已有配置与状态 storage 接口，Commands 已有 registry/argv/mount，Core 已有日志、事件和 effects。复用这些能力比创建 LauncherSettings、LauncherEvents、LauncherCommands 等同义包装更清楚。

## 为什么不默认安装全部官方服务

演示服务能力应由真实任务驱动：Commands 证明多入口，effects 证明撤回，配置证明持久与生效区别，logger 证明失败定位，自定义 Services 证明嵌入。入站 HTTP 服务、Workbench、NodeWorkers、数据库或 Vault 没有首版消费者，全部安装会扩大依赖闭包；RemoteLookup 的出站 Fetch 不要求安装这些服务。

Management 可复用的投影与 Host API 必须核对；原生入口不为了使用它而启动 Web 管理平面。此次不承诺所有官方服务可移植。

## 为什么使用显式 DTO 协议

Rust、Node 和 LLRT 跨越进程、线程及对象空间，固定业务消息比远程对象图更容易审查。JSON-RPC 承担请求关联与错误结构，项目只补少量应用方法、取消和快照事件。开发使用 Unix domain socket，发布用队列投递同一语义，保留一致行为但不强制相同物理传输。

协议是本示例的应用集成边界，先保持项目私有，不命名或发布成 Pluxel 通用 RPC 标准。TS 类型与 Rust 同名结构不足以证明兼容，必须共享 wire fixtures 并在真实两端往返。暂不建设通用 IDL 生成器。

## 为什么不能承诺跨进程原子 HMR

Pluxel 可以提交本地 graph 和服务状态，原生 UI 呈现还需要消息传递。把 socket ACK 放进同步 publish hook 会破坏现有 lifecycle 契约。设计采用本地权威提交、异步版本化投影、执行时再次校验句柄；UI 最终显示新结果，而旧动作自撤回起就无法接纳。

同样，包已安装、包已加载、插件已启动和 UI 已呈现是不同事实。保持这些区别，才能在失败时告诉用户真实结果，而不是靠一个总的 ready 标志掩盖未完成部分。

## 为什么包管理先支持本地预编译包

本例要验证安装权威、运行快照和独立 JSRuntime 更新，不需要用户端包解析器。构建端处理依赖，原生端只验证和安装受控制品。新装、升级、移除统一在显式应用变更时接纳，减少模块缓存和共享 ABI 的更新分支。

ESM JS 与引擎绑定较少。QuickJS 字节码与版本耦合且对输入来源有额外约束，首版不采用。[官方说明](https://quickjs-ng.github.io/quickjs/developer-guide/intro/)。后续网络分发或热安装必须有真实需求再扩展；不复制现有 pnpm Package Manager 来制造一个看似通用的兼容层。

## 什么才值得抽成可复用框架能力

可嵌入 Host 的无 Node 入口、明确的 runtime 基础要求、现有编译器的目标制品约束，可能属于 Pluxel。Launcher 查询模型、原生 UI、原生动作协议和本地包存储策略先属于示例。只有第二个实际消费者证明契约稳定且有共同所有权时，才考虑提取应用 SDK。

实施中如需为一个最小插件改动多个无关服务或复制整个 Host，应暂停扩展，重新查明 portable 闭包边界。优雅来自所有权清晰、路径直接、行为可验证，不以抽象数量或代码行数判断。
