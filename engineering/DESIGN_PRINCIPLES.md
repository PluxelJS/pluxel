# 工程不变量

本页维护跨领域约束。执行路径见 [Plugin 系统](PLUGIN_SYSTEM.md)，具体机制、源码和验证入口由[领域页](README.md)维护。

## 首要目标：契约可读，行为可观测，修复可审查

调用、声明与执行反馈应足够让开发者和 coding agent 判断行为，定位该改的输入。

- 名称、参数和返回值表达目标、副作用与完成阶段；类型帮助选择合法用法。
- 配置来源、默认、覆盖顺序、读取时机和资源所有者明确。已提交、已保存、已应用和已就绪分别报告。
- 在最早能可靠判断的位置拒绝非法输入，保留 cause，说明期待与实际、已经发生的影响和下一步；详情按权限提供，敏感值不进入诊断。
- 检查默认只读；codemod、清单修正与数据转换通过显式操作写入，提供可审查 diff，报告冲突和部分失败。修复只使用确定依据，执行仍校验输入。
- 默认、标准化、重试、HMR 保留旧实例与共享模块绑定各有明确条件和结果。不得靠换依赖、猜入口、跳过坏配置或重置数据掩盖失败。

工具集成沿用上游配置、环境变量语义与优先级。确需差异时在所属文档解释原因。框架变量共用解析器。API 取舍、依赖清单的写入依据和包解析失败的诊断分别由对应文档维护。[API 设计规则](../.agents/rules/library-api-design.md) · [工作区依赖](CLI_WORKSPACES.md#外部依赖政策) · [包来源解析](TOOLCHAIN.md#package-source-inference)

## 一个事实，一个所有者

[系统边界](PLUGIN_SYSTEM.md)定义 Context、Core、Host、Services 与 Workbench 的职责。来源、管理面和 UI 读取领域所有者的状态；graph、lifecycle、配置等事实各自维护一份。

依赖方向按具体模块与求值入口判断，基础能力保持独立于上层组合、未选择 backend 和构建工具。具体声明与导出规则由 [Governance](GOVERNANCE.md)维护。

同一语义保留一个公开入口。本地仓库变更同步已知调用方；必要数据显式转换后删除转换代码，避免保留假设消费者的 alias、旧 reader 或启动迁移。

## 声明必须给出可验证的事实

Plugin 身份由 canonical entry 与唯一 root named export 确定；required edge 来自 constructor，optional integration 只观察 catalog。工具链在 TypeScript 擦除前生成声明事实，namespace 求值后才能接纳 frozen candidate。缺失或不兼容事实在接纳边界失败。身份、作者模型和 lowering 分别由 [Identity](PLUGIN_IDENTITY.md)、[Plugin 系统](PLUGIN_SYSTEM.md#plugin-作者模型)和 [Toolchain](TOOLCHAIN.md)维护。

原生 SDK、decision、receipt 和 lifecycle failure 保留各自协议。调用者需要恢复的本地领域失败显式建模，选择见 [Better Result](../docs/plugin-development/better-result.md)。

## 所有权必须经得起缓存和并发

资源获取成功后立即登记幂等 cleanup，创建者拥有释放责任，借用者保持共享 backend/listener/root 的寿命。logger、gate、effects 与 registration 固定 owner Context；缓存、Part occurrence 和异步 callback 不改变归属，共享 registry 不依赖可变“当前 caller”。

已知成员优先用普通对象、class 或预编译 descriptor。开放成员或 type-erased RPC 等场景可使用 Proxy，取舍须保持反射、identity、调试和生命周期语义。

Context shape 编译后固定，Host 在 root 创建前组合服务。每个 Plugin generation 对应一个 kernel scope；Part child 与 dependency caller view 共用 backing，分别拥有 owner-view cache。Plugin 不能追加服务安装。

## 生命周期只发布真实结果

provider 先启动、后停止；required failure 只阻塞 dependent closure。init 无法提供能力时失败，返回 cleanup 与显式资源进入同一代 effects。

停止先关闭 admission，再 abort、等待已接纳操作并 drain。旧 admission 关闭后，旧 instance 已失效；晚到结果不能重新发布它。replacement、rollback、optional restart、stop 和 shutdown 复用同一清理机制。

不可变候选先校验，可见状态在所属 commit 边界切换。Core 报告 lifecycle 结果，宿主决定退出、告警或降级。详细 transition 与 publication 规则见[生命周期语义](CORE_LIFECYCLE_SEMANTICS.md)。

## 可选能力关闭即无运行成本

关闭的可选服务不加入 Context 安装集合，也不创建 backend、compiler、watcher、route、transport 或持久状态。optional callback 未执行时，Plugin 仍能完成核心生命周期；业务 API 和状态独立于可选 Workbench。

启用 Workbench 时遵守固定 Cap’n Web/WebSocket、MF2 Manifest/Snapshot 与 React Bridge 规则。Content-only definition 走无 renderer、零 MF 路径，详见 [Workbench](WORKBENCH.md)。

## 证据应覆盖改动所在边界

验证方式由改动影响决定，见 [Testing](TESTING.md)：公开入口核对真实调用和发行消费；handle 检查缓存、多 owner、并发与撤回；lifecycle 检查失败、late result 与 teardown；可选能力检查启用和关闭。Plugin 源码入口包含 semantic lowering 与真实 Module Runner。

在线状态通过既有[开发控制台](../docs/development/dev-console.md)观察。文档变更核对实际内容、链接、锚点与格式。

## 当前文档不承担历史记录

当前规则、公开用法、历史依据与提案的归属见 [Documentation](DOCUMENTATION.md)。替换规则同步已知入口与调用方，移除旧用法；有用的既往依据保留在 [Records](records/README.md)。
