# Vite 项目执行与开发控制

用户用法见 [Vite 项目脚本](../docs/development/dev-console.md)。通用 SDK、执行器、上传制品和远程认证由 [Agent workflow](AGENT_WORKFLOW.md) 维护；本页只拥有 Vite 源码、模块身份、更新屏障和开发实例寿命。

## Ownership 与包边界

`host({ entry, scripts: true })` 选择私有本地脚本通道。`@pluxel/host-vite/project` 只有 ProjectScript/ProjectSdk 与引用类型；Host-vite 扩展同一个 `plugin()` 选择器以接受当前 constructor，Context 从 `dev.ctx` 借用。异步控制操作复用 Host ScriptScope 的 Better Result 与原生 `sdk.Result`，不依赖官方 Services、Management 或 Workbench。

现有 `pluxel` environment 的唯一 ModuleRunner 加载项目源码。Host-vite 不创建第二个 Host、database、logger 或执行队列。ScriptExecutor 来自 Host，项目和上传执行共享接纳、主体、预算、去重、取消与结果结算；HMR 使用同一内核的独立 lane。

## 提交与执行

CLI 生成原 run ID 和请求摘要，发送前输出 v2 receipt，随后用同一 Cap’n Web target 提交与查询。Unix carrier 使用上游 RpcTransport/RpcSession，长度前缀只负责 framing、字节预算、背压与关闭。旧 JSON 命令分发与 reader 已删除。

发现仍使用 `.pluxel/dev-console`，目录 0700、描述文件 0600、短临时 socket 父目录 0700。连接先检查 protocol、instanceId 和 nonce，再授予共享控制 target；nonce/socket 不进入 receipt 或公开状态。profile/project/Pitchfork qualified serviceId 在启动时捕获，并与 root、instanceId 共同验证归属。发现与执行不调用 Pitchfork。

项目请求携带文件、exportName 与 SHA-256。接纳前检查 realpath、源码预算与摘要，入口必须在 Vite root 内，排除 node_modules/.git/.pluxel。ModuleRunner 已合法加载的工作区依赖可以在 root 外。结果与输入遵循通用可移植数据规则。

检查器沿用脚本最近的 TypeScript 配置；前端发行声明与服务端源码解析不同，同样属于输入失配。starter 的服务端脚本目录继承 Host 配置，具体布局由[公开指南](../docs/development/dev-console.md#编写可交互的开发脚本)维护，检查器保留原生解析与源码守卫。

## Vite 更新与执行边界

保留 prepare → watcher 更新屏障 → 绑定当前 Host epoch → load → 身份和摘要复核。接纳后的项目任务在 prepare 完成后选择当前 Host；一旦绑定，后续 Host replacement 撤回该 run，后续调用不能转到新 root。

每个已运行入口保留有限依赖 hash。后续加载发现依赖变动时，等待真实 Vite watcher 在 route 同步 admission 确认，再等待有限更新屏障。等待受 run signal 与 deadline 控制；不会合成文件事件、全量 clearCache 或用延时伪装已应用。首次加载保证当前已提交 Host 与已观察更新，不声称提供整个文件系统快照。

失效发生在 route publication 之前。static catalog 使用精确 importer invalidation；script-only 更新保持 Plugin 实例。已发布 constructor 不因同一真实 watcher 事件再次失效，避免 import 身份与 running Plugin 分裂。删除与读取失败沿既有 source removal 路径处理。

paused 且有待处理运行时变化时以 `hmr_pending` 结束；auto 模式下失败遗留的 pending 同样不能冒充已应用。typed constructor 与 catalog 不符时以 `stale_target` 拒绝。没有匹配定义与节点未运行分别诊断。

### 独立 HMR 控制

pause/apply/resume 由 Vite 批次调度器执行，不加载项目模块，不借用 Host scope。应用尚未 ready、Management 未安装或 Host replacement 时仍可控制。只有 Vite server 关闭结束开发 owner。

脚本与 HMR 各有一个执行位置，避免等待更新的脚本阻塞 apply。full-host replacement 只 abortScripts，不撤回促成 replacement 的控制 run。取消停止后续接纳并等待已开始控制工作结算，已切换模式和已开始候选不会回滚。调度细节见 [HMR](HMR.md#开发批次调度)。

## 操作 API 与资源

`createProjectSdk(ctx, scope)` 只扩展当前 ScriptScope 的工厂和 `dev.ctx`。constructor 经 scope 的内部 `selectPlugin` 接入原 Host 队列和成员视图，不另行读取裸实例。状态与实例获取在 committed read 内验证实现身份；生命周期通过同一 exclusive session 验证并提交，共用 coordinator 的 `pluginLifecycleUpdate` 请求构造。候选更替无法插入校验与执行之间。已缓存 constructor 引用在 HMR 替换后返回 `stale_target`，fork 同样保留这个前提。

constructor 类型提供完整实例类型，Schema input/output 与 Part 配置关联由生成描述符提供。constructor 引用不提供 config；显式选择原生节点地址时使用未知字段的动态配置操作。所有实例视图都服从同一 run/generation 准入和排空。Root Context 及原业务返回的嵌套资源继续遵守各自所有权。

`executeHostScript` 拥有统一的函数执行、关闭 admission、排空 SDK 操作与 before/after revision 读取；after 包含排空期间真实完成的变更。开发扩展直接业务调用和原生资源仍由作者 await、传递取消与释放。Host replacement abort 原脚本并 drain 已跟踪工作后才释放旧 root；未协作脚本不能强制终止。

日志通过基础 SDK 的 Core Logging API 读取有界范围，或通过明确 import 的服务 token 使用原生 API。Vite 共享模块的 global console 属于应用进程，执行器不改写它来捕获逐 run 输出。

## 实现与验证入口

- `packages/host-vite/src/project.ts`、`project-sdk.ts`：开发扩展。
- `src/console/attachment.ts`、`source.ts`：ModuleRunner、源码摘要、依赖观察和 Host epoch。
- `src/console/server.ts`、`discovery.ts`：私有连接认证及发现；共享 target 与 carrier 位于 Host agent 子入口。
- `packages/cli/src/dev/client.ts`、`receipt.ts`：普通 Promise control client、归属选择及原 owner 查询。
- Host-vite project-sdk/server/client/attachment tests：无 Services 真实 Host、fork、过期 constructor、native Cap’n Web、摘要与权限。
- `tests/hmr-control.smoke.mjs`：真实 Vite watcher、共享 constructor 身份、暂停批次、失败修复、重复更新、Host replacement 和初始应用失败时的独立控制。
- `tests/initial-source-recovery.smoke.mjs`：初始源码失败后的真实恢复。

通用执行与 Node/CF 证据见 [Agent workflow](AGENT_WORKFLOW.md)。
