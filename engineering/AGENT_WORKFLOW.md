# Host 脚本 SDK 与执行

公开作者入口是 [`@pluxel/agent-sdk/host`](../packages/agent-sdk/src/host.ts)：`Script = (sdk, run) => unknown | Promise<unknown>`，其中 `run` 为 `{ id, input, signal }`。完整调用、CLI 与失败处理见[Host 自动化脚本](../docs/development/scripts.md)。插件 class 声明、配置源码描述、实例视图和材料同步由 [Plugin Control](PLUGIN_CONTROL.md) 维护。Vite 项目模块身份和 HMR 的约束由 [Dev Console](DEV_CONSOLE.md) 维护。

## 所有者和调用路径

```text
pluxel → @pluxel/agent-sdk/internal/cli（参数、文件与终端适配）
编辑器 / Node 程序
  → @pluxel/agent-sdk/client：发现、编译、连接、提交与原 receipt 恢复
  → 跨进程 Cap’n Web 控制 target：describe / submit / result / cancel / control
  → ScriptExecutor：接纳、队列、身份、取消、结果保留
      ├─ Vite：ModuleRunner 加载目标项目模块
      └─ Node：加载作者侧编译的 JS 工厂
  → executeHostScript：创建并结算本次 scope
  → ScriptSdk：同步选择插件引用，异步控制直接返回值或抛 ScriptError
  → Host coordinator / 配置 / 策略 / Core Logging

Workbench 管理 RPC
  → 相同 Host 用例与报告投影
```

Host 持有插件图、配置来源和原始输入、版本、运行意图及生命周期。SDK 组织这些现有能力，复用 Host 配置和策略用例、稳定 `PluginNodeAddress` 以及共享 `PluginApplyReportSnapshot` 投影。Host 统一判定协调与生命周期问题，SDK 与 Management 保留相同结论和完整报告。SDK 在控制边界去掉重复的成功标记，成功直接返回领域值，失败抛出 `ScriptError`。错误的 `details` 保留原领域联合，执行回执以有界 JSON 保留相同字段。作者使用普通 async/await，只在任务需要恢复时捕获错误。业务方法可以继续返回原生 Result，由自己的调用方处理。领域约束继续由 [Host](HOST.md)、[Config](CONFIG.md) 和 [Logging](LOGGING.md) 维护。

执行器持有 run，加载器持有求值方式，连接持有认证和远程引用。跨进程 target 只负责提交与控制；同进程直接调用执行器和 Host。SDK 方法没有经过 Cap’n Web，也没有复制一套配置或生命周期逻辑。

| 入口                                    | 所属职责                                                          |
| --------------------------------------- | ----------------------------------------------------------------- |
| `@pluxel/agent-sdk/client`              | 外部 Node 调用方与 SDK 自身的终端适配                             |
| `@pluxel/agent-sdk/internal/cli`        | 官方 CLI 的命令目录、参数与校验、文件读写、进度/结果/错误和退出码 |
| `@pluxel/agent-sdk/host`                | 作者使用的 SDK、地址关联与结果类型                                |
| `@pluxel/host/internal/agent/runtime`   | 框架执行内核、材料读取与输入输出协议                              |
| `@pluxel/host/internal/agent/node`      | 显式启用的可信 Node 工厂加载器与 Host 执行所有者                  |
| `@pluxel/host/internal/agent/transport` | 共享 Cap’n Web target、普通 Promise 客户端及跨边界校验            |
| `@pluxel/host/internal/agent/socket`    | 本地 Node socket carrier 的分帧、大小预算、背压与关闭             |
| `@pluxel/rolldown/scripts`              | 作者侧 TS 检查、依赖打包与源码映射                                |
| Services management session             | 管理认证、显式脚本权限和远程连接接线                              |

`/host` 导出唯一的 `Script` / `ScriptSdk`、结构化 `ScriptError` 和 `createScriptScope`；Host 的 executor、载体和材料接线位于内部入口。可移植 runtime 入口的依赖闭包不包含 Node builtin、Vite、Services、编译器或平台加载器。transport 和 socket 分别从叶子入口选择。无官方 Services 的已启动 Host 可以直接使用 `createScriptScope({ ctx, signal })`。

公开 `/host` 的运行时值统一由 Host 的 `internal/agent/host` 模块导出。Node 工厂绑定该模块的命名空间；Vite 单例解析把同一个公开入口映射到驱动采用的 Host 模块，并核对导入方的 Host 版本。类型检查与项目模块加载继续沿用各自的源码一致性校验，SDK 类与作用域工厂保持原生共享身份。

生成控制声明引用 Host 内部类型所有者 `@pluxel/host/internal/agent-types`，沿用控制模块已有的 Host 依赖；作者从 `/host` 导入相同类型，插件包无需因此引入源码编译器。

源码工具从 `@pluxel/agent-sdk/source` 直接调用，不经过 Script、SDK、Host、receipt 或 Vite console。类型、实现和资源归属由 [Toolchain](TOOLCHAIN.md#offline-plugin-inspection) 维护；运行节点的 `address.definition` 可直接交给源码查询。`@pluxel/agent-sdk/host` 发布 Host SDK 类型和 `createScriptScope`，源码与 Host 入口通过标准地址互通，各自保持依赖边界。

## 外部客户端

[`packages/agent-sdk/src/client/`](../packages/agent-sdk/src/client/) 拥有发现与 profile 选择、远端认证接线、材料同步、统一提交/等待和 receipt 编解码。`operations.ts` 是普通函数入口，`dev.ts` / `remote.ts` 分别适配本地 socket 与 Services session；两条载体复用 Host transport 的校验和快照，不复制运行协议。调用方输入先复制，连接在每次调用结束时关闭。

`onPrepared` 在发送前被等待；接纳响应丢失仍保留原 receipt，不重试提交。`signal` 中断客户端 IO，不撤销 Host 工作；真正取消只能交给原 executor。receipt 查询固定原连接位置、实例和请求摘要。材料下载可取消，进入原子安装后完成结算，不把已发布结果报告成未发生。公开契约与最短调用见 [Agent SDK](../docs/development/agent-sdk.md)。

SDK 的依赖方向为 Host 协议、Rolldown 编译器与 Services 认证客户端；没有 CLI 依赖。`/client` 按需加载远端认证和上传编译；`/host` 保持可移植。CLI 的进程启动代码通过内部 `/internal/client` 复用 profile 与实例元数据，Pitchfork 子进程仍由 CLI 管理。内部入口不是另一个作者 API。

## 终端适配与命令挂载

[`packages/agent-sdk/src/cli/`](../packages/agent-sdk/src/cli/) 拥有 `script run/result/cancel/sync`、`dev instances/run/hmr/sync` 的完整终端适配；命令只调用原 `/client` 函数。`manifest.ts` 保存参数、帮助、默认值与 Gunshi lazy children，`options.ts` 只维护一份未知选项和多余位置参数检查；CLI 保留的 dev 入口也复用此检查。`output.ts` 拥有 JSON、prepared/accepted、失败诊断和退出码；CLI 的解析失败与 service status 共享该呈现。

`/internal/cli` 只导出官方挂载和上述共享呈现实际使用的符号。加载目录仅加载 Gunshi 和轻量元数据，Gunshi 在帮助路径也会解析所选 lazy loader，因此 loader 返回执行回调，到实际 run 才导入命令主体；失败依赖也按需加载。`/source`、`/host`、`/client` 不导入终端适配，不写终端、不修改 `process.exitCode`。SDK 不持有服务启动，也不引用 CLI 的源码、测试或制品。

`@pluxel/cli` 保留唯一 executable、总命令树与其他领域命令。`dev` 的前台进程与 Pitchfork 管理仍属于 CLI；`dev status` 在 CLI 判断服务类型，Host 分支调用 `listHosts`，`scripts: false` 分支查询原生 Pitchfork 状态。`/internal/client` 显式导出 CLI 服务路径所需的项目选择、实例选择、错误上下文及类型；Host-vite 原生控制台协议测试仍使用其 `connectDevInstance`，Create 的生成项目测试复用项目选择。其余未消费的发现/连接 helper、receipt codec 与文件解析不再从内部入口导出。

`receipt.ts` 统一处理命令侧的提交前保存与有界文件读取，复用客户端的 token 上限和校验；它不改变 `/client` 的 receipt 语义。文件规则与恢复用法只在[自动化脚本](../docs/development/scripts.md#保存和恢复-receipt)维护。

命令主体测试位于 Agent SDK 的 `script-command`、`script-output`、`credentials`、`dev-console` 和 `dev-project` tests；CLI 的 `agent-commands` / `launcher` tests 从真实 executable 验证挂载、帮助、参数路由、服务状态和单一 JSON 输出。独立安装验收仍由 Services 的 `agent-installed` smoke 覆盖 SDK/CLI、真实认证、上传执行与原 receipt 恢复。

## scope 的接纳和结算

`createScriptScope` 借用原 Host 和本次 signal，返回 SDK、`assertOpen`、`abort`、`dispose` 和版本 `snapshot`，并实现 `AsyncDisposable`。`Symbol.asyncDispose` 与 `dispose()` 使用同一个幂等结算 Promise，供 `await using` 或显式关闭使用。`sdk.plugin(nodeAddress)` 同步选择并检查 scope，其余 Host 操作在 scope 中接纳并跟踪 Promise；缓存的工厂、引用和配置方法同样检查是否关闭。scope 不拥有 Host，也不释放 root Context。引用的类型关联与生成声明由 [Plugin Control](PLUGIN_CONTROL.md#typed-配置与实例)维护。

脚本结束后 `executeHostScript` 关闭后续调用，等待已接纳的 SDK 工作，再读取结束版本。异步控制的已知失败保留为 `ScriptError`，未知缺陷保留原异常。调用方已捕获的预期失败可由任务恢复，排空仍负责等待在途工作；原生业务调用和清理失败按原资源协议处理。未捕获的失败形成运行错误，清理错误另存 `cleanupError`。取消按信号的原始 reason 严格相等判定，并先于领域错误分类；策略用例保留相同的原生取消 reject 契约。取消先关闭接纳、传递 signal，并释放日志等待订阅；Host 已接纳的写入或生命周期操作依原路径结算，取消终态仍优先，不能抢先投影成操作未发生。

`snapshot()` 在 scope 关闭后仍可读取 Host 版本，供结算后的 `revisions.after` 使用。它包含 catalog/runtime state 的 revision，以及配置/策略各自的 managed revision。版本差异提供核对线索，单步结果仍以领域报告为准。

SDK 的日志方法复用 Core Logging 的 stream、cursor、retention、gap 和等待订阅。`streams()` 只列出已配置历史流；`mark()` 可以创建尚未写入的已配置空流；缺少后端返回明确能力诊断。读取单批最多 10000 条，等待必须指定有限 timeout。scope 不新建 Logging sink，也不接管生产者寿命。

`plugins.list` 复用 Host status 的身份枚举与状态投影，先按 package / 完整 definition 过滤、分页，再投影选中节点。默认 50、最大 200。cursor 绑定 coordinator 寿命、查询、catalog/runtime revision 和身份序列，允许同一 Host 的后续 run 接续。每个 coordinator 仅复用最近一个筛选条件的身份清单，catalog、policy snapshot、session/desired maps 或 applied membership 引用变化时重新枚举；状态、诊断和最近更新不进入缓存。这些输入变化抛出 `cursor_stale`，调用方从第一页重新读取；每页状态仍按当次 committed view 投影。

同一个 scope 在 Node 和 Vite 中直接提供 `sdk.ctx`。访问 getter 先检查 scope，再交付原 RootContext；`require(Token)` 沿用原能力查找与异常，原生资源由脚本创建者释放。源码 class 通过 `sdk.plugin(Constructor.nodeAddress())` 接入原成员视图，精确实现证据随地址保留，身份校验和生命周期变更属于同一个 committed 操作，见 [Dev Console](DEV_CONSOLE.md#操作-api-与资源)。原生资源由创建它的脚本按原协议释放。

## 代码交付和加载

上传输入是 `ScriptArtifact`，格式为 `pluxel-js-factory/4`。`compileScript({ file, exportName, signal })` 对普通 TS/JS 文件使用 native TypeScript 检查并用 Rolldown 打包，共享固定输入。交付物包含工厂函数体、导出名、内容摘要和版本 3 source map，编译不会求值应用工厂。上传工厂包含脚本、通过材料验证的标准地址提供者与可打包的计算依赖，类型 import 被消除。

作者的 `@pluxel/agent-sdk/host`、`@pluxel/core/better-result` 和生成控制模块的 `@pluxel/host/internal/control-reference` import 保留为受控共享绑定。格式 4 的工厂依次接收 Better Result、control-reference 与 Host 公共 API 的三个命名空间。加载器传入当前 realm 的实际 namespace，共用 `ScriptError`、原生 Result 身份和地址调用证据，生成入口按固定模板验证。独立 Better Result 包、其余框架运行时、Node builtin、远端协议、原生扩展和动态 import 明确拒绝。旧制品格式在输入校验时拒绝。

Rolldown 先生成 ESM，私有工厂转换器只处理标准 import/export 声明，保留严格模式、共享 namespace 身份与导出绑定；它不依赖打包器的互操作 helper。转换通过 `renderChunk` 与 MagicString 合成原源码映射，并在交付前重新按 Script 语法检查工厂。接收端执行固定参数的普通函数体，无需解析模块或安装编译工具。

工厂同步初始化并返回模块 exports，异步任务在导出函数中执行。Node 加载器在原进程 realm 使用 `vm.compileFunction`，每次 run 创建新的模块局部状态，随后调用所选导出并传入 SDK。它不依赖实验 ESM VM API、临时执行文件、`data:` import 或 ESM 缓存。加载错误和执行错误按工厂附带 source map 映回原作者文件。

Node 执行所有者固定借用的 Host、`instanceId` 和 `hostEpoch`。`close()` / `Symbol.asyncDispose` 取消并等待运行结算，借用的 Host 由应用继续拥有。这个加载器用于受信任同进程代码执行，`vm` 不提供安全沙盒；同步无限循环也无法在同一事件循环中强制终止。

Vite 输入为项目路径、导出名和源码摘要。Vite 使用目标项目的 ModuleRunner 与共享模块图，保留应用模块身份、import 基址、真实实例和 Context。它在源码更新屏障后绑定原 Host，完成 native 类型检查，并核对实际求值/缓存模块的原始输入和 Host 身份；Host 被替换会撤回原 run。Vite 的模块缓存语义保持不变，不以复制应用依赖的方式重置脚本模块。HMR 与脚本采用独立执行位置，具体控制顺序见 [Dev Console](DEV_CONSOLE.md)。

## 运行身份、失败和预算

执行器接纳前验证输入、目标可支持的加载方式、内容摘要、认证主体和预算；异步 preparation 后再次验证授权。相同 run ID 和相同摘要返回原运行，相同 ID 的不同内容返回 `request_conflict`。身份索引包含主体，其他主体不能查询或取消原 run。

CLI 在首次提交前保存或输出 receipt，采用单一 v3 协议，记录原实例/run ID/请求摘要，以及 local root/serviceId 或 remote endpoint。`script result/cancel` 根据回执选择原连接，不重新选择当前 profile。每次查询仍向原实例重新认证并核对请求身份，无法连接、原 owner 消失、运行不存在和结果过期分别报告。结果过期保留 identity tombstone，旧 ID 不会重新执行。进程重启后由调用方根据业务状态核对已发生的变化。

CLI 的 run/result/cancel 共用 `{ ok: true, value: { receipt, run } }`，命令失败输出 `{ ok: false, error }`，已准备的回执保留在 error。stderr 共同阶段为 prepared/accepted。退出码由同一实现按终态与等待策略判定，返回的领域 Err 保留为 `run.value`，不会改变执行完成状态。同步使用同一外壳，并按 canonical entry 返回准确 import，见 [Plugin Control](PLUGIN_CONTROL.md)。

阶段为 admission、load、execute、encode、cleanup；状态从 queued/preparing/running 进入 succeeded、failed 或 cancelled。取消中的活动 run 保持 cancelling，直到脚本和 scope 真正结算。取消的终态保留取消错误及同期发生的 `executionError`。`close()` 等待真实结算，断开连接只释放控制引用。

成功终态要求函数、结果编码和清理均完成。SDK 控制失败默认抛错并中断后续步骤，形成执行失败；`run.error.details` 保留配置、持久化与生命周期等领域信息。保存但尚未采用的配置仍由成功快照的 `application` 表达，持久化未知和生命周期部分变更继续携带完整报告。已经提交的修改保持有效，执行器不自动回滚或重试。脚本显式返回的业务 Result 仍是普通执行结果；其可选组合与 Panic 语义由 [Better Result](../docs/plugin-development/better-result.md)维护。

运行错误的有界诊断保留原生 Panic 的 cause 文本。cause 链及 Aggregate/Suppressed 子错误只读取自身数据属性，跳过访问器；沿用深度、节点、循环和消息长度限制，不把业务 Error 实例放入结果 DTO。

[`result-codec.ts`](../packages/host/src/agent/result-codec.ts) 只在 `executeHostScript` 的最终返回边界识别共享 Ok/Err 的实际原型和 own data，使用原生 `Result.codec` 输出 SerializedResult。普通 JSON 的 status/value/error 不触发识别。Result payload 继续经 `snapshotJson` 验证，拒绝嵌套 Result、能力对象、其他 class instance、getter、循环、BigInt、函数和非有限数值，不执行任意 `toJSON`。执行器最后再检查完整 envelope 的预算。直接使用 scope 得到原领域值，原业务 Result 保持共享库实例；跨进程结果是 DTO，不自动复活类。

[`protocol.ts`](../packages/host/src/agent/protocol.ts) 的 `snapshotJson` 是脚本 JSON 输入和 payload 的唯一投影所有者。它显式识别 Core 私有 WeakMap 中注册的原厂节点地址，仅编码规范 identity 字段；嵌套地址和 Result payload 复用同一分支及原有预算，不复制或输出调用证据。分离或外来标记转为 `result_not_serializable`，其余 symbol、访问器和能力对象仍按原规则拒绝。该分支不按 definition 重建证据；经 JSON 保存或交付的地址只具有动态管理能力。运行保留及完整 envelope 的预算由 [`runtime.ts`](../packages/host/src/agent/runtime.ts) 维护：

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
| 外部 Node 客户端            | [`client.test.ts`](../packages/agent-sdk/tests/client.test.ts)、[`entrypoints.test.ts`](../packages/agent-sdk/tests/entrypoints.test.ts)：输入快照、提交前持久化、中断、取消结算、原 receipt 与入口隔离 |
| 通用执行器                  | [`agent-runtime.test.ts`](../packages/host/tests/agent-runtime.test.ts)：身份、结果编码、有界保留、失败和取消结算                                                                                       |
| Node 加载                   | [`agent-node.test.ts`](../packages/host/tests/agent-node.test.ts)：实际制品加载、真实 Host、模块重复运行、原源码堆栈和关闭                                                                              |
| 脚本编译                    | [`scripts.test.ts`](../packages/rolldown/tests/scripts.test.ts)：真实 TypeScript 与 Rolldown、计算依赖、拒绝的运行时 import 和 source map                                                               |
| 可移植入口与 Workers 最小桥 | [`agent-portability.test.ts`](../packages/host/tests/agent-portability.test.ts)，范围见下                                                                                                               |
| Vite、CLI 与部署接收端      | [Dev Console](DEV_CONSOLE.md) 和各包 integration / installed smoke；交付门禁需包含真实 SDK/CLI→认证→无源码、无编译器的 Node 应用                                                                        |

交付验收及已知限制由 [Plugin Control](PLUGIN_CONTROL.md#验证入口)维护；具体历史执行记录由 Git 保留。

### Workers 的当前证据

可移植测试以 browser 条件从真实 `@pluxel/agent-sdk/host` export 生成单一 ESM bundle，检查模块闭包和外部 import，确认没有 Node、Vite、Services 或编译器依赖。

同一测试使用已安装的 Miniflare / workerd，在本机真实 workerd 中加载由 `compileScript` 生成的工厂。工厂作为 Dynamic Worker 的静态 JavaScript 模块文本加载，Core Better Result 绑定 Worker 内共享子入口。脚本通过普通 SDK 方法调用 WorkerEntrypoint RPC，再经受控测试桥进入原 Host。两次运行执行普通 await、循环和计算，将真实配置从 2 改为 4、再改为 8；每次工厂的模块计数均从 1 开始，Host 侧核对 `application: 'applied'`，测试最后关闭 workerd 与 scope。

测试复用官方 [Dynamic Worker Loader](https://developers.cloudflare.com/dynamic-workers/api-reference/) 和 [Workers RPC / ctx.exports](https://developers.cloudflare.com/workers/runtime-apis/context/#exports) 机制，使用 `globalOutbound: null` 限定最小能力桥。跨边界只传参数与结果，本地 run signal 在 Worker 内创建。这个测试桥只公开插件发现、配置读取和条件写入，作为受控 fixture 保留。

当前证据覆盖入口闭包、真实 Workers 加载、最小能力桥和重复工厂执行。正式 CF 后端尚未交付；部署环境、取消传播、在途调用排空、桥释放、回执 owner 寿命和错误映射仍需完整后端验证。D1/KV、Durable Object 持久任务与跨断线查询也没有本轮实现或验收，存储平台证据继续见 [FS](FS.md)。
