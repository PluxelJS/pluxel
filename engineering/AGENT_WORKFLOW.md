# Host 脚本 SDK 与执行

公开作者入口是 [`@pluxel/host/agent`](../packages/host/src/agent.ts)：`Script = (sdk, run) => unknown | Promise<unknown>`，其中 `run` 为 `{ id, input, signal }`。完整调用、CLI 与失败处理见[Host 自动化脚本](../docs/development/scripts.md)。插件 class 声明、配置源码描述、实例视图和材料同步由 [Plugin Control](PLUGIN_CONTROL.md) 维护。Vite 项目模块、Context 借用和 HMR 的约束由 [Dev Console](DEV_CONSOLE.md) 维护。

## 所有者和调用路径

```text
CLI / 编辑器
  → 跨进程 Cap’n Web 控制 target：describe / submit / result / cancel / control
  → ScriptExecutor：接纳、队列、身份、取消、结果保留
      ├─ Vite：ModuleRunner 加载目标项目模块
      └─ Node：加载作者侧编译的 JS 工厂
  → executeHostScript：创建并结算本次 scope
  → ScriptSdk：普通 Promise，直接调用 Host 用例
  → Host coordinator / 配置 / 策略 / Core Logging

Workbench 管理 RPC
  → 相同 Host 用例与报告投影
```

Host 持有插件图、配置来源和原始输入、版本、运行意图及生命周期。SDK 组织这些现有能力，复用 Host 配置和策略结果、稳定 `PluginNodeAddress` 以及共享 `PluginApplyReportSnapshot` 投影。Workbench 与脚本使用同一业务实现。领域约束继续由 [Host](HOST.md)、[Config](CONFIG.md) 和 [Logging](LOGGING.md) 维护。

执行器持有 run，加载器持有求值方式，连接持有认证和远程引用。跨进程 target 只负责提交与控制；同进程直接调用执行器和 Host。SDK 方法没有经过 Cap’n Web，也没有复制一套配置或生命周期逻辑。

| 公共入口                       | 所属职责                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `@pluxel/host/agent`           | 可移植 SDK、scope、运行内核、输入输出与制品协议                                |
| `@pluxel/host/agent/node`      | 显式启用的可信 Node 工厂加载器与 Host 执行所有者                               |
| `@pluxel/host/agent/transport` | 共享 Cap’n Web target、普通 Promise 客户端及跨边界校验                         |
| `@pluxel/host/agent/socket`    | 本地 Node socket carrier 的分帧、大小预算、背压与关闭                          |
| `@pluxel/host-vite/project`    | Vite 项目的 `ProjectScript` / `ProjectSdk`，当前构造器身份、真实实例和 Context |
| `@pluxel/rolldown/scripts`     | 作者侧 TS 检查、依赖打包与源码映射                                             |
| Services management session    | 管理认证、显式脚本权限和远程连接接线                                           |

可移植入口的运行时依赖闭包不包含 Node builtin、Vite、Services、编译器或平台加载器。transport 和 socket 分别从叶子入口选择。无官方 Services 的已启动 Host 可以直接使用 `createScriptScope({ ctx, signal })`。

## scope 的接纳和结算

`createScriptScope` 借用原 Host 和本次 signal，返回 SDK、`assertOpen`、`abort`、`dispose` 和版本 `snapshot`。SDK 每次调用都在 scope 中接纳并跟踪 Promise；缓存下来的方法同样检查是否关闭。scope 不拥有 Host，也不释放 root Context。

脚本结束后 `executeHostScript` 关闭后续调用，等待已接纳的 SDK 工作，再读取结束版本。取消先关闭接纳、传递 signal，并释放日志等待订阅；Host 已接纳的写入或生命周期操作依原路径结算。排空期间的失败保留为运行或 `cleanupError`，不能把取消抢先投影成操作未发生。

`snapshot()` 在 scope 关闭后仍可读取 Host 版本，供结算后的 `revisions.after` 使用。它包含 catalog/runtime state 的 revision，以及配置/策略各自的 managed revision。版本差异提供核对线索，单步结果仍以领域报告为准。

SDK 的日志方法复用 Core Logging 的 stream、cursor、retention、gap 和等待订阅。`streams()` 只列出已配置历史流；`mark()` 可以创建尚未写入的已配置空流；缺少后端返回明确能力诊断。读取单批最多 10000 条，等待必须指定有限 timeout。scope 不新建 Logging sink，也不接管生产者寿命。

开发扩展从同一 scope 添加真实 Context 和实例能力。真实对象只在所属 run、Host epoch 和 Plugin generation 内借用，不能跨 run 保存。原生资源由创建它的脚本按原协议释放。

## 代码交付和加载

上传输入是 `ScriptArtifact`，格式为 `pluxel-js-factory/1`。`compileScript({ file, exportName, signal })` 对普通 TS/JS 文件使用 native TypeScript 检查并用 Rolldown 打包，共享固定输入。交付物包含工厂函数体、导出名、内容摘要和版本 3 source map，编译不会求值应用工厂。上传工厂包含脚本、通过材料验证的纯描述符与可打包的计算依赖，类型 import 被消除；运行时框架 import、Node builtin、远端协议、原生扩展和动态 import 明确拒绝。

工厂同步初始化并返回模块 exports，异步任务在导出函数中执行。Node 加载器在原进程 realm 使用 `vm.compileFunction`，每次 run 创建新的模块局部状态，随后调用所选导出并传入 SDK。它不依赖实验 ESM VM API、临时执行文件、`data:` import 或 ESM 缓存。加载错误和执行错误按工厂附带 source map 映回原作者文件。

Node 执行所有者固定借用的 Host、`instanceId` 和 `hostEpoch`。`close()` / `Symbol.asyncDispose` 取消并等待运行结算，借用的 Host 由应用继续拥有。这个加载器用于受信任同进程代码执行，`vm` 不提供安全沙盒；同步无限循环也无法在同一事件循环中强制终止。

Vite 输入为项目路径、导出名和源码摘要。Vite 使用目标项目的 ModuleRunner 与共享模块图，保留应用模块身份、import 基址、真实实例和 Context。它在源码更新屏障后绑定原 Host，完成 native 类型检查，并核对实际求值/缓存模块的原始输入和 Host 身份；Host 被替换会撤回原 run。Vite 的模块缓存语义保持不变，不以复制应用依赖的方式重置脚本模块。HMR 与脚本采用独立执行位置，具体控制顺序见 [Dev Console](DEV_CONSOLE.md)。

## 运行身份、失败和预算

执行器接纳前验证输入、目标可支持的加载方式、内容摘要、认证主体和预算；异步 preparation 后再次验证授权。相同 run ID 和相同摘要返回原运行，相同 ID 的不同内容返回 `request_conflict`。身份索引包含主体，其他主体不能查询或取消原 run。

CLI 在首次提交前保存或输出 receipt，记录原 endpoint/实例/run ID/请求摘要。每次查询仍向原实例重新认证并核对请求身份，无法连接、原 owner 消失、运行不存在和结果过期分别报告。结果过期保留 identity tombstone，旧 ID 不会重新执行。进程重启后没有持久去重或恢复承诺。

阶段为 admission、load、execute、encode、cleanup；状态从 queued/preparing/running 进入 succeeded、failed 或 cancelled。取消中的活动 run 保持 cancelling，直到脚本和 scope 真正结算。取消的终态保留取消错误及同期发生的 `executionError`。`close()` 等待真实结算，断开连接只释放控制引用。

成功终态要求函数、结果编码和清理均完成。脚本返回的领域失败值仍是成功结果；配置的保存与采用、生命周期和部分失败由原报告表达。脚本中途抛错、编码或清理失败都不会撤销已提交修改，也不会自动重试。前后版本、错误阶段和清理失败共同支持后续核对。

结果编码只读取普通 JSON 数据，拒绝能力对象、class instance、getter、循环、BigInt、函数和非有限数值。预算在 [`protocol.ts`](../packages/host/src/agent/protocol.ts) 和 [`runtime.ts`](../packages/host/src/agent/runtime.ts) 维护：

| 项目                                 | 当前上限                      |
| ------------------------------------ | ----------------------------- |
| 单次输入、结果、工厂代码、source map | 各 1 MiB                      |
| JSON 深度 / 访问节点                 | 64 / 100000                   |
| timeout（包含排队、加载与协作执行）  | 默认 30000 ms，最大 300000 ms |
| script / HMR 各自等待队列            | 各 16 项，分别串行            |
| 已完成结果保留                       | 100 项且总计不超过 16 MiB     |
| owner 内接纳身份                     | 100000 项，达到上限拒绝新 ID  |

## 授权和执行所有者

远程部署复用 Management session 的认证，通过 `bootstrap.execution` 授予共享控制 target。`managementHttp({ scripts: true })` 或 `servicesPreset(..., { scripts: true })` 显式启用。关闭时没有 Node 求值器加载和执行队列；普通管理权限与脚本执行开关分别判断。

Services 的 Node 执行 owner 随 Host 存活。控制连接断开不取消已接纳任务，相同 provider/subject 重新认证可以查询；显式退出认证、provider generation 撤回或 provider 的 authorization signal 撤回会取消该主体任务。连接 signal 和授权 signal 分开处理。Host 关闭先撤回执行权限并 drain owner，再结束应用资源。

Vite 控制 owner 随开发实例存活，其私有本地连接认证独立于应用的 Management 就绪情况。HMR 控制仍能在 Host 未 ready 时接纳；脚本固定借用执行时绑定的 Host。受保护的本地 socket 与远程 WebSocket 复用同一控制 target，各 carrier 只处理消息运输。

## 验证入口与已验证范围

测试必须验证调用方可观察的配置、日志、生命周期和结算，真实 Host 由正常 lowering / 配置 schema / coordinator 运行，避免靠旧接口断言约束 SDK。核心入口：

| 验证                        | 位置与覆盖                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 直接 SDK                    | [`agent-sdk.test.ts`](../packages/host/tests/agent-sdk.test.ts)：无 Services Host，读取/计算/CAS/实际采用、来源与遮盖、只读、持久化确认失败、保存后采用失败、启停失败、取消排空、真实日志范围与订阅释放 |
| 作者类型                    | [`agent-sdk.typecheck.ts`](../packages/host/tests/agent-sdk.typecheck.ts)：稳定节点地址、版本条件、日志有限等待和普通 Script 类型推导                                                                   |
| 通用执行器                  | [`agent-runtime.test.ts`](../packages/host/tests/agent-runtime.test.ts)：身份、结果编码、有界保留、失败和取消结算                                                                                       |
| Node 加载                   | [`agent-node.test.ts`](../packages/host/tests/agent-node.test.ts)：实际制品加载、真实 Host、模块重复运行、原源码堆栈和关闭                                                                              |
| 脚本编译                    | [`scripts.test.ts`](../packages/rolldown/tests/scripts.test.ts)：真实 TypeScript 与 Rolldown、计算依赖、拒绝的运行时 import 和 source map                                                               |
| 可移植入口与 Workers 最小桥 | [`agent-portability.test.ts`](../packages/host/tests/agent-portability.test.ts)，范围见下                                                                                                               |
| Vite、CLI 与部署接收端      | [Dev Console](DEV_CONSOLE.md) 和各包 integration / installed smoke；交付门禁需包含真实 CLI→认证→无源码、无编译器的 Node 应用                                                                            |

2026-11-13 脚本执行器的历史验证基线如下；2026-11-14 插件控制重构的当前验证记录由 [Plugin Control](PLUGIN_CONTROL.md#2026-11-14-落地验证)维护。

- SDK、Config、policy 与可移植/Workers 测试 25 项通过；SDK/执行器/Node 专项 22 项通过，脚本编译 3 项、Cap’n Web 共享身份与打包 22 项通过。
- 真实 TLS、非 loopback、密码 challenge 的 CLI→Management session→Node Host 路径通过，核对未启用执行、错误凭据、主体隔离、重复身份、冲突、断线查询、部分失败、取消结算和提供者撤回。Services 管理与 HTTP 相关 186 项、CLI 104 项、Auth 8 项专项通过。
- [`agent-installed.test.ts`](../packages/services/tests/agent-installed.test.ts) 从真实 tarball 独立安装作者 CLI/SDK，使用正式 standalone/headless 构建，将单文件应用移至接收目录并删除应用源码，Node loader 禁止从接收目录之外加载模块。接收端无 compiler、Vite 或 Workbench。配置 2→4→8、CAS 冲突、采用、非空日志、启停、原 receipt、部分失败不回滚、原脚本堆栈、取消与 SIGTERM 关闭均通过。
- 只获得公开指南、声明和目标信息的独立 agent，通过上述安装后的 CLI 读取配置，处理 count 字符串的 validation_failed，再以版本条件将 count 从 11 改为 22。复读的 application 为 applied、desiredRevision=appliedRevision=5；原 receipt 新连接查询得到相同 instanceId/runId/requestHash。
- [`hmr-control.test.ts`](../packages/host-vite/tests/hmr-control.test.ts) 的真实 Vite 用例核对同一模块图、实际实例、过期 constructor、依赖修改、paused pending、失败修复、Host replacement 和五轮八文件批量更新。最近直接运行记录为 64 次模块求值、16 批更新、72 个 Plugin generation 启动并全部释放，失败启动恢复另有 8/8 释放。

该基线的全工作区门禁 `mise exec -- vp run --concurrency-limit=2 verify` 通过：135/135 项任务成功，118/120 项可缓存任务命中。2683 个文件格式正确，1876 个文件没有 lint 警告、错误或类型错误；仓库治理与源码声明检查均通过。文档站构建与链接校验通过，生成 660 个文件。

### Workers 的当前证据

可移植测试以 browser 条件从真实 `@pluxel/host/agent` export 生成单一 ESM bundle，检查模块闭包和外部 import，确认没有 Node、Vite、Services 或编译器依赖。

同一测试使用已安装的 Miniflare 5.20261103.0-beta / workerd 1.20261103.1，在本机真实 workerd 中加载由 `compileScript` 生成的工厂。工厂作为 Dynamic Worker 的静态 JavaScript 模块文本加载，脚本通过普通 SDK 方法调用 WorkerEntrypoint RPC，再经受控测试桥进入原 Host。两次运行执行普通 await、循环和计算，将真实配置从 2 改为 4、再改为 8；每次工厂的模块计数均从 1 开始，Host 侧核对 `application: 'applied'`，测试最后关闭 workerd 与 scope。

测试复用官方 [Dynamic Worker Loader](https://developers.cloudflare.com/dynamic-workers/api-reference/) 和 [Workers RPC / ctx.exports](https://developers.cloudflare.com/workers/runtime-apis/context/#exports) 机制，使用 `globalOutbound: null` 限定最小能力桥。跨边界只传参数与结果，本地 run signal 在 Worker 内创建。这个测试桥只公开插件发现、配置读取和条件写入，作为受控 fixture 保留。

当前证据覆盖入口闭包、真实 Workers 加载、最小能力桥和重复工厂执行。正式 CF 后端尚未交付；部署环境、取消传播、在途调用排空、桥释放、回执 owner 寿命和错误映射仍需完整后端验证。D1/KV、Durable Object 持久任务与跨断线查询也没有本轮实现或验收，存储平台证据继续见 [FS](FS.md)。
