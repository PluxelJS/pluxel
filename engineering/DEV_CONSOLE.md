# Vite 项目执行与开发控制

Host-vite 负责在项目模块图中加载脚本、等待源码更新并绑定当前 Host。脚本 SDK 和执行器由 [Agent Workflow](AGENT_WORKFLOW.md) 维护，操作步骤见[开发控制台](../docs/development/dev-console.md)。

## Ownership 与包边界

`host({ entry, scripts: true })` 启用私有本地通道。项目脚本使用 `@pluxel/agent-sdk/host` 的同一套 `Script` / `ScriptSdk`，通过现有 `pluxel` environment 的唯一 `ModuleRunner` 加载；通道可用于没有 Services、Management 或 Workbench 的 Host。

项目和上传执行共用 Host 的 ScriptExecutor，统一接纳、主体、预算、去重、取消和结算。脚本与 HMR 各有一个串行执行位置，使等待更新的脚本不会阻塞 apply。Host-vite 借用现有 Host、Context 和日志设施。

## 提交与执行

客户端在提交前生成 run ID、请求摘要和 v3 receipt。查询和取消由 `script result/cancel` 按原 receipt 连接，回执保存 root、instanceId、serviceId 和请求摘要。通用协议、输出与错误见 [Agent Workflow](AGENT_WORKFLOW.md#运行身份失败和预算)。Unix carrier 使用原生 RpcTransport/RpcSession；长度前缀只负责 framing、字节预算、背压和关闭。

实例描述位于 `.pluxel/dev-console`：目录权限 0700、文件 0600，短 socket 的临时父目录也是 0700。握手验证 protocol、instanceId、nonce 后授予共享控制 target；nonce/socket 不进入 receipt 或公开状态。启动时捕获 project/profile/Pitchfork qualified serviceId，连接时连同 root 和实例核对归属。发现和执行直接使用这些记录。

默认发现严格报告坏记录与版本失配，用 root/recordFile/expectedProtocol/actualProtocol 提供可审查诊断，不自动删除。显式 instance 和原 receipt 在验证目录权限后只读取目标记录，仍完整检查文件权限、归属和握手；无关记录不阻断精确目标。

项目请求包含文件、exportName 和 SHA-256。接纳前验证 realpath、源码预算与摘要；入口须位于 Vite root 内，并排除 node_modules、.git、.pluxel。`ModuleRunner` 合法加载的 workspace 依赖可以在 root 外。类型检查沿用最近的 TypeScript 配置和原生解析规则；starter 的服务端脚本继承 Host 配置，见[脚本布局](../docs/development/dev-console.md#编写可交互的开发脚本)。

## Vite 更新与执行边界

执行顺序为 prepare → watcher 更新屏障 → 绑定当前 Host epoch → load → 身份与摘要复核。prepare 后才选择 Host；绑定后 replacement 会撤回原 run，调用不能转到新 root。

每个已运行入口保留有界依赖 hash。后续加载发现变动时，先等待真实 watcher 在 route 同步 admission 确认，再等待有限更新屏障，均受 signal/deadline 控制。首次加载使用当前已提交 Host 和已观察更新；屏障覆盖已接纳序列，不提供整个文件系统快照。

模块失效在 route publication 前完成。static catalog 精确失效 importer，script-only 更新保留 Plugin 实例；同一 watcher 事件不会再次驱逐已发布 constructor。删除和读取失败进入来源移除路径。paused 且有运行时 pending，或 auto 模式仍有失败 pending 时，加载以 `hmr_pending` 结束。constructor 与 catalog 不符报告 `stale_target`；定义缺失和节点未运行分别诊断。

TypeScript 从生成声明检查 `#i18n`，执行准备阶段同时记录对应生成模块的可执行闭包，加载后复核原始字节。生成模块的失效由词条源码进入 Host 批次时驱动。 [Paraglide 编译](TOOLCHAIN.md#paraglide)

### 独立 HMR 控制

pause/apply/resume 直接调用 [HMR 调度器](HMR.md#开发批次调度)，独立于脚本 loader、Host scope 和应用 ready。控制 owner 随 Vite 实例存活；full-host replacement 只 abortScripts，不撤回促成 replacement 的控制 run。

取消关闭后续接纳并等待已开始的控制工作结算。已经切换的模式和已开始的候选保留真实结果。只有 Vite server 关闭才结束开发 owner。

## 操作 API 与资源

Node/Vite 都由 `executeHostScript` 创建、关闭和排空同一 `ScriptScope`。`sdk.ctx` 提供 run-scoped 根 Context 视图；`await sdk.plugin(address).context()` 捕获 running generation 的 Plugin Context 视图。内建能力直接使用固定属性，应用安装的服务通过 `service` 读取；借用值使用守卫 view 保持原生 API，缺失、访问和契约错误保留原义。直接业务调用与原生资源由脚本 await、传递取消和释放。

class 的 `nodeAddress(id?)` 在不可变地址上绑定精确 constructor。SDK 在规范化前固定证据；status/instance 在 committed read 中校验，生命周期在同一 exclusive session 内校验并提交，使用 coordinator 的 `pluginLifecycleUpdate`。校验与执行之间不能插入候选更替，缓存的旧 constructor（含 fork）在 replacement 后仍为 stale。

class 地址提供完整实例类型和动态配置；生成控制入口额外关联 Schema input/output 与 Part 配置。两者复用相同 run/generation 准入和成员视图，见 [Plugin Control](PLUGIN_CONTROL.md#typed-配置与实例)。SDK 控制成功直接返回值，失败抛出保留领域报告的 `ScriptError`。

结算后读取的 `revisions.after` 包含排空期间完成的变更。replacement 先 abort 原脚本并 drain 跟踪工作，再释放旧 root；同进程中无法强制终止不协作脚本。日志复用 Core Logging 的有界读取，或直接使用 `sdk.ctx.logger`；共享模块的 global console 属于应用进程。

## 实现与验证入口

- [`packages/host/src/agent/`](../packages/host/src/agent/)：共用 SDK、scope、执行和传输。
- [`packages/host-vite/src/console/`](../packages/host-vite/src/console/)：attachment/source 的 `ModuleRunner`、摘要、依赖和 epoch；server/discovery 的发现与握手。
- [`packages/agent-sdk/src/client/`](../packages/agent-sdk/src/client/)：普通 Promise 客户端、归属选择和原 receipt 恢复。
- [`packages/host-vite/tests/`](../packages/host-vite/tests/)：server/client/attachment 测试覆盖无 Services Host、fork、stale constructor、原生 Cap’n Web、摘要和权限。
- [`hmr-control.smoke.mjs`](../packages/host-vite/tests/hmr-control.smoke.mjs) 经真实 watcher 验证同批入口的语法修复、脚本与应用共享 constructor、暂停及 Host replacement。[`initial-source-recovery.smoke.mjs`](../packages/host-vite/tests/initial-source-recovery.smoke.mjs) 验证缺失的导入出现时自动恢复。

通用执行和 Node/Workers 验证由 [Agent Workflow](AGENT_WORKFLOW.md#验证入口与已验证范围)维护。
