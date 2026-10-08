# 设计思考与取舍

本页解释 [目标设计](DESIGN.md) 的选择，不另维护生命周期或消息契约。项目展示的核心是：原生应用拥有业务基础，Pluxel 管理可替换扩展，同一插件可在不同执行环境消费相同应用能力。

## 为什么选 Launcher

查询 provider、动作、命令、配置和原生能力都有清晰的扩展边界。少量 UI 即可观察插件依赖、启停、失败和更新；不需要先完成文档模型、编辑器、撤销栈或渲染引擎。原生应用保留自身能力，插件对它增加功能，而不是用插件拼装一个空壳服务端。

Calculator 是纯业务 provider，Launcher 与 CLI 是两种消费方式；NativeActions 再覆盖真实异步原生调用。三类路径足够体现架构，继续增加天气、文件索引、账户、AI、插件市场会把工作变成产品开发。

## 为什么选原生 Qt Widgets 与 QuickJS-NG

Widgets 可以提供搜索框、列表、设置表单和文件选择器，无需 Web 技术栈；C++ 可直接对接 QuickJS-NG C API。首版选择 Linux，避免把跨平台打包问题和运行时架构验证混在一起。UI 工具包可以替换，应用能力语义和 Pluxel Services 不应依赖 QWidget。

QuickJS 运行在独立线程让 CPU 工作不直接阻塞 UI，仍需执行预算和公平 job pump。线程不是权限沙箱，也不意味着一个 JSRuntime 能被多线程并发访问。引擎全部访问固定在所属线程，原生 UI 操作排回主线程。[QuickJS C API](https://quickjs-ng.github.io/quickjs/developer-guide/intro/) 和 [Qt QThread](https://doc.qt.io/qt-6/qthread.html) 是实施依据。

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

演示服务能力应由真实任务驱动：Commands 证明多入口，effects 证明撤回，配置证明持久与生效区别，logger 证明失败定位，自定义 Services 证明嵌入。HTTP、Workbench、NodeWorkers、数据库或 Vault 没有首版消费者，全部安装会掩盖可组合性并扩大 QuickJS 依赖闭包。

Management 可复用的投影与 Host API 必须核对；原生入口不为了使用它而启动 Web 管理平面。此次不承诺所有官方服务可移植。

## 为什么使用显式 DTO 协议

Qt、Node 和 QuickJS 跨越进程、线程及对象空间，固定业务消息比远程对象图更容易审查。JSON-RPC 承担请求关联与错误结构，项目只补少量应用方法、取消和快照事件。开发使用 [QLocalSocket](https://doc.qt.io/qt-6/qlocalsocket.html)，发布用队列投递同一语义，保留一致行为但不强制相同物理传输。

协议是本示例的应用集成边界，先保持项目私有，不命名或发布成 Pluxel 通用 RPC 标准。TS 类型与 C++ 同名结构不足以证明兼容，必须共享 wire fixtures 并在真实两端往返。暂不建设通用 IDL 生成器。

## 为什么不能承诺跨进程原子 HMR

Pluxel 可以提交本地 graph 和服务状态，原生 UI 呈现还需要消息传递。把 socket ACK 放进同步 publish hook 会破坏现有 lifecycle 契约。设计采用本地权威提交、异步版本化投影、执行时再次校验句柄；UI 最终显示新结果，而旧动作自撤回起就无法接纳。

同样，包已安装、包已加载、插件已启动和 UI 已呈现是不同事实。保持这些区别，才能在失败时告诉用户真实结果，而不是靠一个总的 ready 标志掩盖未完成部分。

## 为什么包管理先支持本地预编译包

本例要验证安装权威、运行快照和独立 JSRuntime 更新，不需要用户端包解析器。构建端处理依赖，原生端只验证和安装受控制品。新装、升级、移除统一在显式应用变更时接纳，减少模块缓存和共享 ABI 的更新分支。

ESM JS 与引擎绑定较少。QuickJS 字节码与版本耦合且对输入来源有额外约束，首版不采用。[官方说明](https://quickjs-ng.github.io/quickjs/developer-guide/intro/)。后续网络分发或热安装必须有真实需求再扩展；不复制现有 pnpm Package Manager 来制造一个看似通用的兼容层。

## 什么才值得抽成可复用框架能力

可嵌入 Host 的无 Node 入口、明确的 runtime 基础要求、现有编译器的目标制品约束，可能属于 Pluxel。Launcher 查询模型、Qt UI、原生动作协议和本地包存储策略先属于示例。只有第二个实际消费者证明契约稳定且有共同所有权时，才考虑提取应用 SDK。

实施中如需为一个最小插件改动多个无关服务或复制整个 Host，应暂停扩展，重新查明 portable 闭包边界。优雅来自所有权清晰、路径直接、行为可验证，不以抽象数量或代码行数判断。
