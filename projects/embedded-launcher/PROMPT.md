# 新 Session 落地 Prompt

以下正文可作为新 session 的任务输入。设计权威仍是所链接文档；本页不复制协议或另设验收标准。

---

请开始实现 `projects/embedded-launcher/` 的 Pluxel 原生应用嵌入演示，不再只做方案讨论。

先遵循根 AGENTS.md，使用 smallest-complete 与 pluxel-development skill。阅读项目 README、STACK、RUNTIME、DESIGN、IMPLEMENTATION；联网阶段再读 NETWORK，选择理由需要时读 DECISIONS。只按涉及领域补读框架文档，不通读全仓库。检查当前源码、exports 和工作区修改，不回退已有工作。

已经确定 Rust + Iced 原生窗口 + 内嵌 LLRT，首版 Linux；按需使用 iced_aw，UI 测试使用配套 iced_test。LLRT 按插件生态选择，Iced 按外部事件接入和可验证性选择；不代表嵌入 SDK 已成熟或 UI 已实测。无具体实测阻断不要重新比较语言、运行时或 UI，不维护第二套后端，不换成 WebView、Electron 或 Node 发布执行。

目标是最小但真实完整的架构演示，不是完整 launcher 产品：核心应用通过 Pluxel Services 提供能力，同一份 TypeScript 插件在 Node/Vite 开发时真实 HMR，发布时在原生进程内 LLRT 运行；UI 与 CLI 共用活动 Host；展示配置、依赖、启停、联网、能力观察以及受控预编译包安装/更新/移除。

执行方式与完成责任：
- 请使用 goal 工具建立一个覆盖整个演示及 IMPLEMENTATION 最终验收的目标，不只建立阶段 A 目标；不自行设置 token 预算。若已有本任务 goal 则沿用，若存在无关未完成 goal 则先报告冲突，不覆盖。工具不可用时明确说明并维护等价的持久验收清单，不假装创建成功。
- 阶段是依赖顺序与验证门槛，不是交付终点。尽可能连续完成 A-D、整体验收、文档和可运行交付；不要因完成一个阶段、一个 subagent 返回或上下文切换就宣告任务完成。高完成度指范围内路径完整、失败可恢复、状态真实、UI 可操作且验证到位，不是继续扩展功能。
- 主动使用 subagent 分担已稳定边界内的工作。主 agent 持有总目标、共享协议和集成；可分别委派 LLRT 嵌入/兼容回归、TS 插件与 HMR、原生 UI/包管理、独立验收。按可用并发槽和依赖就绪程度调度，不要求四项同时执行；未稳定契约先共同核对，避免并行发明不同协议。
- 每个子任务明确输入、可修改文件、接口、验收和停止条件；不同 agent 不同时改相同文件或各自升级共享依赖。主 agent 必须亲自集成并跑真实跨边界验收，不能以各模块自测通过推断整套可运行。
- 随实现更新 IMPLEMENTATION 的阶段状态、实际命令、证据、剩余工作与下一步。仅当整个承诺范围的必要验收通过才将 goal 标为 complete；工具的暂停/阻断状态遵循其规则。若确有不可解决阻断，保留复现和准确缺口，不用降级演示或完成声明掩盖。

先完成 IMPLEMENTATION 阶段 A 的真实嵌入闭环：Rust 链接 LLRT，正式 lowering 的插件和 owner Service，原生 -> JS -> 异步原生 -> JS -> 原生往返，同一 runtime 内 stop/start/config，正常关闭与重复创建销毁。接管 LLRT 的进程退出、模块加载和关闭策略，复用标准库，不自行实现 Fetch/AbortSignal。按 RUNTIME 核实和修复已知上传/Origin 缺陷，锁定 revision 与有界补丁，建立项目内兼容回归。临时 /tmp 探针仅供参考，不作为交付依赖。

阶段 A 通过后按 B-C-D 连续推进，不停在脚手架或空 Host：真实原生 UI 与 Node/Vite HMR、Calculator 与 Commands CLI、插件管理、Network/Wretch 与观察、包存储与显式应用变更。逐阶段更新 IMPLEMENTATION 的状态和证据。范围始终是文档中的小型演示，不扩展市场、通用桌面 SDK、多运行时隔离或完整权限系统。

硬约束：
- 开发与发布共用应用服务契约；开发经本地 IPC 操作真实原生应用，发布用进程内有界队列，不传 JS 对象跨线程。
- Iced 按 STACK 的 Subscription/Message/update/view 接收应用投影；应用监督层拥有 runtime，UI 订阅不拥有它。UI task 取消不冒充远端取消，不新建通用 UI 抽象或复制领域状态。
- 业务插件/helper 修改必须使用现有唯一 ModuleRunner 的 HMR，不能偷偷重启 Node、Host 或原生程序冒充。稳定 SDK/装配变更按 DESIGN 分类处理。
- Plugin stop/start/config 不重建 JSRuntime；包安装只改变 installed selection，显式应用变更才重建插件 runtime，原生窗口与进程保留。
- 服务 owner、旧句柄失效、迟到结果、取消与 drain 遵循 Pluxel；不复制 graph、伪造 lowering metadata、绕私有源码入口或改写错误契约掩盖失败。
- 通用 npm/Web API 直接复用运行时，应用专属能力经 Services。观察仅承诺受观测入口，不声称捕获插件所有 IO 或提供恶意代码沙箱。

复用仓库现有构建/测试模式。仅当真实闭包要求时修改框架所属包及已知调用方，并同步文档、测试和必要 changelog；不要提前创建通用抽象。原生桥接/重建在真正嵌入程序验证，HMR 使用现有 dev console 固定 root/instance 并观察真实原生结果，发布制品在 workspace 外、无 Node 运行依赖环境验证。

UI 不停在一堆调试按钮：按 STACK 的 UI 约束补齐键盘流程、焦点、加载/空/错误/断连/待应用状态、长文本与中文字体。用 iced_test 验证消息、显示状态、语义操作与有限截图，并验证真实原生窗口。测试工具不可用时报告并使用真实原生自动化替代，不改成 Web UI；截图和控件测试不代替原生后端实际回执。

交付实际可运行的构建、dev、生产、CLI 命令，一条简短演示流程，以及实际验证结果与未验证边界。保持 README 与 IMPLEMENTATION 对应真实状态；遇到无法自行解决的阻断，提交最小复现与准确缺口，不用 mock 或子进程执行代替验收。
