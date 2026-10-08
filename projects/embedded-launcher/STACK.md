# 技术选型与实现约定

本页拥有确定的技术路线；所有权与消息语义见 [DESIGN](DESIGN.md)，已验证事实和缺陷见 [RUNTIME](RUNTIME.md)，阶段验收见 [IMPLEMENTATION](IMPLEMENTATION.md)。以下依赖是实施选择，不代表已完成集成。

## 1. 唯一路线

**Rust 主应用 + Iced 原生窗口 + 内嵌 LLRT；TypeScript 插件开发运行于 Node/Vite。首版 Linux。** 不保留第二套 UI 或 txiki 后端。原生 UI 指无浏览器/WebView，不要求系统原生 widget 外观。

| 层 | 选择 | 边界 |
| --- | --- | --- |
| UI | Iced 0.14 系列；按需 iced_aw | 外部消息驱动的状态投影；只选一种渲染 backend |
| 发布 JS | LLRT 的运行时装配和标准库 | 优先复用 llrt_core，用小型 embedder 适配接管错误、加载、关闭；不照搬 CLI 退出策略 |
| 绑定 | LLRT 锁定的 rquickjs | 注册项目私有 bridge module，不独立升级或链接第二份 QuickJS |
| 原生异步 | tokio | JS 专用线程内 current-thread executor，按锁定版本验证调度；UI 不执行 JS |
| 协议 | serde/serde_json + 有界 channel | Rust DTO 显式校验；开发 Unix socket 与发布进程内队列使用同一语义 |
| 原生构建/测试 | Cargo / cargo test | 锁文件与工具链入库；真实嵌入和 UI 集成另外验收 |
| JS 构建 | 工作区 tsdown/Rolldown + @pluxel/rolldown | 正式 lowering、共享身份和产物闭包检查 |
| JS 开发/测试 | Node/Vite + @pluxel/host-vite；Vitest + @pluxel/test | 唯一 ModuleRunner；在线操作用现有 dev console |

[Iced](https://docs.rs/iced/0.14.0/iced/) 提供原生窗口与消息驱动 UI；[rquickjs](https://docs.rs/rquickjs/latest/rquickjs/) 提供绑定。实际 API 读取锁定版本，不复制 latest/dev 示例。JS 沿用工作区 catalog/lockfile；Rust crate 版本在首次编译成功后固定，iced_aw/iced_test 与 Iced 配套。LLRT 锁定精确 commit 与依赖锁，上游补丁记录来源、目的、回归和移除条件。

LLRT 不是完善的嵌入 SDK。若 core 退出/全局策略无法用小补丁接管，报告具体阻断，再决定是否使用同版本 rquickjs + 官方 LLRT 模块装配；不能默默删减标准库，让嵌入支持面与 CLI 探针不一致。

## 2. 按阶段引入原生依赖

- 文件选择用 rfd；剪贴板优先复用 UI backend，若需可验证的独立读写再引入 arboard。排队成功不冒充系统写入成功。
- 配置目录用 directories，profile 单写者锁用 fs2。完整文档用 tempfile 在同目录写入、flush/sync 后原子替换；明确错误和持久化回执，不截断原文件做 fallback。
- 受控 ZIP 用 zip，摘要用 sha2。逐项限制路径、链接、文件数量和展开大小，写 staging 后提交 selection，不手写归档解析器。
- 原生诊断用 tracing；入口复杂到需要时才引入 clap。不引入通用 DI/RPC 框架或数据库。
- 不为 JS Fetch 增加应用自有 reqwest bridge。HTTP/TLS 由 LLRT 实现，Service 只增加生命周期和观测。

不要求阶段 A 装齐所有依赖，按实际消费者引入。未验证的跨平台配置不进入支持声明。

## 3. 线程与资源

| 职责（不要求独立 crate） | 寿命/线程 | 责任 |
| --- | --- | --- |
| 窗口与原生能力 | UI 主线程，应用寿命 | 搜索、结果、管理表单、剪贴板和有限动作 |
| ExecutionSupervisor | 应用寿命 | dev/embedded 选择、session 与重建，不复制 graph |
| LocalEndpoint | 原生异步任务 | Linux Unix socket；Node backend 与 CLI 角色校验 |
| EmbeddedExecutor | 专用线程，每个 runtime 寿命 | LLRT Context、jobs、回调与 Promise 引用 |
| PackageStore / DocumentStore | 可共用串行 IO 队列 | 不可变包、installed selection、Host 借用文档 |

JS 值、函数及销毁均留在执行线程；跨线程只传 DTO/字节与不透明 ID。不能凭 Send、mutex 或 Context lock 在 UI 线程执行插件。等待原生响应时仍推进 executor 和入站消息，禁止持有同步锁跨 await 或同步重入 JS。使用 LLRT/rquickjs 的 jobs、timer、异步机制，不另写忙轮询 pump。

UI 通过 Subscription 接收新投影，不无条件持续轮询；具体接线见第 7 节。关闭顺序遵循 DESIGN：关接纳 -> executor 存活时 close Host、取消并 drain -> 释放 JS/原生引用 -> 结束 runtime。CPU interrupt 与异步取消分别验证，超时不伪装成功清理。

## 4. TypeScript 包与身份

| 包 | 用途 |
| --- | --- |
| @pluxel/core、@pluxel/host | 原有 Plugin/Host、配置、依赖、effects、日志；按实际闭包处理 Node 特定入口 |
| @pluxel/services/commands | 现有安装器、owner mount，不自造命令系统 |
| @pluxel/commands、/argv、/typebox | 同一 Command 的 UI/CLI 入口，沿用 schema 路径 |
| valibot | Plugin 配置与有限 wire 校验，沿用工作区版本 |
| wretch | RemoteLookup，注入 owner-bound fetch；不是整个 @pluxel/wretch provider |
| mathjs/number | 首选计算器引擎，仍需实际兼容与体积验证 |

private SDK 包提供 DTO、Service tokens 和实现；业务插件放另一个应用包，避免按包 singleton 排除业务 HMR。Core、SDK tokens、Commands 等共享身份在同一 realm 唯一。公共 API 以当前仓库 exports/源码为准，不从设计抄造签名。

插件可以依赖已验证的 Node 工具模块，不一刀切禁止 node:*，也不假设 Node 完整能力可用。应用专属 IO 经 Services。开发 transport 的 node:net 不进入发布闭包。构建明确 exports 条件：优先可移植/Web 入口，externalize 已验证 Node 模块；未知残留 import 明确失败，不放空 shim。

socket 帧为四字节无符号大端长度 + UTF-8 JSON，限制大小。发布传同一消息 DTO，不模拟 socket 帧。JSON-RPC envelope、业务结构、取消扩展分别校验，不序列化函数。Rust/TS 共享有效/无效 wire fixtures，不先建通用 IDL。

## 5. 计算器与 CLI

采用 [mathjs number 自定义构建](https://mathjs.org/docs/custom_bundling.html)，验证体积、初始化、算式后锁定。用成熟 parser/AST，限定数值、括号、四则和少量白名单函数；限制长度、深度、节点数，拒绝赋值、属性访问、矩阵、用户函数，禁止 JS eval。精度指显示有效数字，内部 JS number；非有限结果为领域失败，UI/CLI 复用相同格式化结果。

若 mathjs 实测不合适，记录失败后选成熟替代，不手写 parser、不引入第二个运行时。Calculator 不暴露库 AST 或实例。

同一原生程序的 cli 子命令在启动 GUI 前分流，无需图形会话；连接明确的运行中实例。保持 argv token 数组，不拼 shell。只转发给活动 Host 的 Commands carrier，不创建第二个 Host。

## 6. 拟议入口

以下尚不可执行，实施后 README 只列实际命令：

| 入口 | 职责 |
| --- | --- |
| build:native | Cargo 构建原生程序与 LLRT |
| build:sdk | 稳定身份包供 Vite singleton 和发布消费 |
| dev | 单一 Node bootstrap 监督原生 dev 模式与 Vite，握手后启动 Host |
| build:plugins | 正式 lowering、闭包检查、manifest、ZIP |
| start | 原生程序内嵌 LLRT，无 Node 运行依赖 |
| 原生 cli ... | 同一活动 Host |
| test / test:native | JS/原生测试；真实 HMR、嵌入制品 smoke 分开报告 |

Node bootstrap 拥有 Vite 和借用连接；退出先等 Host/Vite 清理再关连接。SDK/执行器变化允许明确重启 Node，普通插件/helper 必须 HMR。运行时缺陷与验证门槛只在 RUNTIME 维护。

## 7. UI 完成度与 agent 验证

选择理由只在 [DECISIONS](DECISIONS.md) 维护；本节拥有 Iced 接线与 UI 验收约定，不创建通用 UI 抽象。

```text
Node/Vite IPC 或 LLRT 队列 -> 应用事件 -> Subscription -> Message -> update -> view
UI 操作 -> 应用请求 -> ExecutionSupervisor/领域 handler -> 带身份的回执或投影
```

- ExecutionSupervisor 的寿命属于应用，不属于 Subscription。订阅只消费事件，不创建或销毁 LLRT；切换管理视图不能中断执行会话。订阅 identity 保持稳定，重连后按 DESIGN 的 session/lease/revision 接纳快照，不能因为 channel 重建接受旧结果。
- `update` 更新显示投影并提交请求，`view` 只构造控件。按查询、管理等职责拆消息和视图，不建立第二套 graph、配置合并或包激活逻辑。待提交表单是 UI 草稿，保存和生效结果由实际 owner 回执决定。
- `Task` 用于异步请求结果接入，不在 UI executor 执行 JS 或阻塞 IO；LLRT 始终留在专用线程。丢弃 UI task/subscription 不代表远端操作已取消或回滚，取消、未知结果和 drain 仍遵循应用协议。

- 优先使用 Iced 内建控件；菜单、数字输入等确有缺口再按 feature 引入 [iced_aw](https://github.com/iced-rs/iced_aw)。统一少量主题、间距与状态样式，不引入 libcosmic 或另建组件框架。
- 完成搜索键盘导航、Enter 执行动作、Escape/焦点恢复、管理视图切换。覆盖加载、无结果、错误、断连、插件不可用、已安装待应用，长名称/错误有可读展开方式。验证窄窗口、缩放、中文字体与输入法；字体文件需明确来源与许可。
- 用匹配版本的 [iced_test](https://docs.rs/iced_test/0.14.0/iced_test/) 做按文本/选择器定位、点击、键盘输入和有限截图回归；分别断言操作产生的消息、状态更新和可见结果。不能通过坐标碰巧点中或放宽快照阈值掩盖错位。
- headless 控件测试、截图与真正窗口端到端分别报告；最终必须验证真实 UI 经桥接影响原生/Host 状态。可访问树和截图都不能代替实际副作用回执。

本轮未构建候选 UI 对比，不将选择理由写成已测的性能或 agent 效率提升。Rust UI 热更新不替代 Node/Vite 插件 HMR。
