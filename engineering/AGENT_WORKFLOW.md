# Host 脚本 SDK 与执行

作者通过 [`@pluxel/agent-sdk/host`](../packages/agent-sdk/src/host.ts) 编写 `Script = (sdk, run) => unknown | Promise<unknown>`，`run` 包含 `{ id, input, signal }`。Node 上传与 Vite 项目脚本使用同一 SDK。公开调用见[自动化脚本](../docs/development/scripts.md)，控制声明见 [Plugin Control](PLUGIN_CONTROL.md)，Vite 加载见 [Dev Console](DEV_CONSOLE.md)。

## 所有者和调用路径

```text
pluxel → agent-sdk/internal/cli：参数、文件、终端
编辑器 / Node → agent-sdk/client：发现、编译、连接、提交、receipt 恢复
  → Cap’n Web target：describe / submit / result / cancel / control
  → ScriptExecutor：接纳、队列、运行身份、取消、保留结果
      ├─ Vite ModuleRunner：目标项目模块
      └─ Node loader：作者侧编译的 JS 工厂
  → executeHostScript：创建并结算 ScriptScope
  → ScriptSdk → Host coordinator / config / policy / Core Logging
```

Host 拥有装配、catalog、运行意图和持久策略，coordinator 调用 Core 的 graph、配置事实和 generation；SDK 调用原用例并复用 Management 的报告投影。控制成功直接返回领域值，已知失败抛出 `ScriptError`，`details` 保留原领域联合；未知异常保持原对象。业务方法继续使用提供方的返回协议。SDK 在进程内直接调用 Host，跨进程 target 负责接纳和控制 run。

| 入口                                        | 职责                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `@pluxel/agent-sdk/source`                  | 普通源码查询函数；实现与类型由 Rolldown 拥有，见 [Toolchain](TOOLCHAIN.md#offline-plugin-inspection) |
| `@pluxel/agent-sdk/host`                    | 唯一 Script/ScriptSdk、`ScriptError`、`createScriptScope` 和地址关联类型                             |
| `@pluxel/agent-sdk/client`                  | 外部发现、提交、HMR、材料同步和原 receipt 查询/取消                                                  |
| `@pluxel/agent-sdk/internal/cli`            | 官方命令挂载与终端呈现                                                                               |
| `@pluxel/host/internal/agent/runtime`       | 可移植执行内核、材料读取和输入输出协议                                                               |
| Host `/internal/agent/node`                 | 可信 Node 工厂加载器与执行 owner                                                                     |
| Host `/internal/agent/transport`、`/socket` | 共享 target / Promise client 与本地 socket carrier                                                   |
| `@pluxel/rolldown/scripts`                  | 作者侧 TS 检查、依赖打包和 source map                                                                |
| Services management session                 | 远程认证、脚本权限与连接接线                                                                         |

`/source` 不经过 Script、Host、receipt 或 Vite。源码 definition 与运行节点共享标准地址，但源码发现按 import 图返回定义，运行列表按 committed catalog 返回节点。

`/host` 的运行时值来自 Host 的 `internal/agent/host` 命名空间。Node 工厂直接绑定它；Vite 单例解析映射到驱动采用的同一 Host 并核对版本。生成声明引用 Host 的 `internal/agent-types`，插件无需引入编译器。可移植 runtime 的闭包不含 Node builtin、Vite、Services、编译器和平台加载器，transport/socket 从各自叶子入口选择。没有 Services 的 Host 也可直接使用 `createScriptScope({ ctx, signal })`。

## 外部客户端

[`packages/agent-sdk/src/client/`](../packages/agent-sdk/src/client/) 的 `operations.ts` 提供普通函数；`dev.ts` / `remote.ts` 分别接本地 socket 和 Services session，共用 Host transport 校验与快照。输入先复制，每次操作关闭自己的连接；远程认证与上传编译按需加载。

提交前等待 `onPrepared`，响应丢失仍保留原 receipt，不自动重提。客户端 signal 中断 IO；取消 Host 工作须调用原 executor。查询固定原位置、实例和请求摘要。材料下载可取消，进入原子安装后等待结算，保留已经发布的结果。

CLI 通过 `/internal/client` 复用项目/profile/实例选择及错误上下文；Pitchfork 子进程仍由 CLI 管理。Agent SDK 的依赖方向为 Host 协议、Rolldown 编译和 Services 认证客户端。

## 终端适配与命令挂载

[`packages/agent-sdk/src/cli/`](../packages/agent-sdk/src/cli/) 拥有 `script run/result/cancel/sync`、`dev instances/run/hmr/sync` 的适配，命令调用 `/client`。`manifest.ts` 定义 Gunshi lazy children 与参数，`options.ts` 统一未知选项/多余参数检查，`output.ts` 统一 JSON、阶段、诊断与退出码。CLI 的解析失败和服务状态也复用该呈现。

帮助路径仅加载 Gunshi 和轻量目录；lazy loader 返回执行回调，实际运行才导入主体及失败依赖。`/source`、`/host`、`/client` 保持普通库行为，不导入终端适配或修改 `process.exitCode`。`@pluxel/cli` 拥有唯一 executable、总命令树、前台启动与 Pitchfork 管理；`dev status` 对 Host 调用 `listHosts`，对 `scripts: false` 服务查询 Pitchfork。

命令侧 `receipt.ts` 复用客户端的 token 预算与校验，负责提交前保存及有界文件读取，文件用法见[保存和恢复 receipt](../docs/development/scripts.md#保存和恢复-receipt)。SDK 命令主体测试与 CLI executable 的挂载测试分属各自包；独立安装验收由 Services `agent-installed` smoke 完成。

## scope 的接纳和结算

`createScriptScope` 借用 Host 和 signal，返回 SDK、`assertOpen`、`abort`、`dispose`、版本 `snapshot`。`dispose()` 与 `Symbol.asyncDispose` 共用幂等结算 Promise。`sdk.plugin(address)` 同步检查 scope；工厂、引用、配置方法提取后仍检查接纳并跟踪异步工作。scope 结束只释放本次工作，Host/root 由应用拥有。

`executeHostScript` 在函数结束后关闭接纳、排空 SDK 工作，再读取 `revisions.after`。未捕获异常进入运行错误，清理异常单列 `cleanupError`。取消以 signal 原始 reason 的严格相等优先分类：先关闭接纳、传递 signal、释放日志订阅，再等待已接纳写入和生命周期操作真实结算。终态保留取消及同期 `executionError`，不把已提交操作报告成未发生。

`snapshot()` 关闭后仍可读取 catalog/runtime revision 与 config/policy managed revision。具体采用结果以领域报告为准。`sdk.ctx` getter 先检查 scope，再返回原 RootContext；`require(Token)` 保持原生能力查找与异常。直接业务调用和创建的资源由脚本 await、传递取消并释放。源码 constructor 的精确证据与实例视图见 [Dev Console](DEV_CONSOLE.md#操作-api-与资源)。

日志复用 Core 的 stream、cursor、retention、gap 和订阅：`streams()` 只列已配置历史流，`mark()` 可建立已配置空流，缺后端明确失败；单批最多 10000 条，等待必须有有限 timeout。

`plugins.list` 先按 package/完整 definition 过滤分页，再投影当前 committed 状态，默认 50、最大 200。cursor 绑定 coordinator、查询、catalog/runtime revision 和身份序列，可跨同一 Host 的 run 接续。每个 coordinator 只缓存最近筛选条件的身份清单；catalog、policy snapshot、session/desired maps 或 applied membership 引用变化后重枚举。状态/诊断不缓存；输入变化报 `cursor_stale`，从第一页重读。

## 代码交付和加载

上传格式为 `pluxel-js-factory/4`。`compileScript({ file, exportName, signal })` 固定普通 TS/JS 输入，用 native TypeScript 检查、Rolldown 打包，产出函数体、导出名、摘要和 v3 source map。编译不求值应用工厂。

工厂依次接收 Better Result、control-reference、Host 公共 API 三个共享命名空间。允许的共享绑定为 `@pluxel/core/better-result`、已验证控制模块使用的 `@pluxel/host/internal/control-reference`、作者的 `@pluxel/agent-sdk/host`；加载器传入当前 realm 的真实值，保留 Result、地址证据和 `ScriptError` 身份。其他框架运行时、独立 Better Result、Node builtin、远程协议、native 扩展和 dynamic import 拒绝打包；旧制品格式在输入校验时拒绝。

Rolldown 先生成 ESM；私有转换器处理标准 import/export，通过 renderChunk/MagicString 合成映射，并按 Script 语法复检函数体。工厂同步返回 exports，异步业务放在导出函数中。Node 用 `vm.compileFunction` 在原 realm 加载，每次 run 创建新模块局部状态；加载/执行错误映回作者文件。接收端无需源码、编译器、临时模块或实验 ESM VM API。

Node owner 固定 Host、instanceId 和 hostEpoch，关闭取消并等待结算。它执行受信任同进程代码；vm 不提供安全隔离，也不能强制中断同一事件循环中的同步无限循环。

Vite 输入是路径、导出名和源码摘要，保留项目的 `ModuleRunner` 缓存和共享身份。在更新屏障后绑定 Host，完成类型检查并核对实际缓存输入；replacement 撤回原 run。完整顺序见 [Dev Console](DEV_CONSOLE.md#vite-更新与执行边界)。

## 运行身份、失败和预算

接纳检查加载方式、摘要、主体和预算，异步 preparation 后复核授权。同主体的相同 run ID/摘要返回原运行，不同内容报 `request_conflict`；其他主体不能查询或取消。结果过期后保留 identity tombstone，旧 ID 不会重新执行。

v3 receipt 在首次发送前保存/输出，固定 instanceId、runId、requestHash 和 local root/serviceId 或 remote endpoint。查询重新认证原实例；无法连接、owner 消失、运行不存在与结果过期分别报告。进程重启后的业务变化由调用方核对。receipt codec 统一校验规范 UTF-8/base64 编码，payload 上限 8 KiB、token 上限 16 KiB，凭据/nonce/socket 不进入回执。

run/result/cancel 输出 `{ ok: true, value: { receipt, run } }`；sync 输出 `{ ok: true, value }`。命令失败为 `{ ok: false, error }` 并保留已准备 receipt，stdout 只写最终 JSON，stderr 写 prepared/accepted 阶段。领域 Err 可以是成功运行的 `run.value`；退出码由终态与等待策略决定。

执行阶段是 admission、load、execute、encode、cleanup。queued/preparing/running 最终进入 succeeded/failed/cancelled；取消中的活动任务保持 cancelling，直到脚本与 scope 结算。成功要求函数、编码和清理全部完成。SDK 失败的 `run.error.details` 保留持久化、配置和 lifecycle 报告；保存后尚未采用的 `application`、持久化 unknown 和部分变更保持原义。已提交修改继续有效，执行器不自动回滚或重试。

[`result-codec.ts`](../packages/host/src/agent/result-codec.ts) 仅在最终返回处按实际原型和 own data 识别共享 Ok/Err，用原生 `Result.codec` 交付 DTO；普通 status/value/error JSON 不触发识别。直接 scope 保留业务 Result 实例，跨进程不复活类。Result payload 继续经 [`protocol.ts`](../packages/host/src/agent/protocol.ts) 的 `snapshotJson` 验证，拒绝嵌套 Result、能力/其他 class、getter、循环、BigInt、函数和非有限数值，不执行 toJSON。

`snapshotJson` 也负责原厂节点地址投影：只识别 Core 私有 WeakMap 登记的地址，仅输出规范 identity，省略调用证据。分离/外来标记报 `result_not_serializable`；JSON 地址只有动态管理能力。错误 cause、Aggregate/Suppressed 子错误按有界深度/节点/消息读取 own data，跳过访问器，保留 Panic cause 文本而不交付业务 Error。

[`runtime.ts`](../packages/host/src/agent/runtime.ts) 维护运行保留与完整 envelope 预算：

| 项目                              | 上限                          |
| --------------------------------- | ----------------------------- |
| 单次输入、结果、工厂、source map  | 各 1 MiB                      |
| JSON 深度 / 节点                  | 64 / 100000                   |
| timeout（含排队、加载、协作执行） | 默认 30000 ms，最大 300000 ms |
| script / HMR 等待队列             | 各 16 项，分别串行            |
| 完成结果                          | 100 项，总计 16 MiB           |
| owner 内接纳身份                  | 100000 项，满后拒绝新 ID      |

## 授权和执行所有者

远程通过 Management `bootstrap.execution` 授予 target，须由 `managementHttp({ scripts: true })` 或 `servicesPreset(..., { scripts: true })` 启用；普通管理权限与脚本开关分别检查。关闭时不创建 Node loader 或队列。

Node owner 随 Host 存活。连接断开只释放控制引用，相同 provider/subject 可重新认证查询；退出认证、provider generation 或 authorization signal 撤回会取消主体工作。连接 signal 与授权 signal 独立，Host 先撤权、drain owner，再释放应用资源。

Vite owner 随开发实例存活，私有 socket 认证独立于 Management ready。脚本借用绑定 epoch，HMR 可在 Host 未 ready 时控制调度器。本地 socket 和远程 WebSocket 共用 target，各 carrier 只负责传输。

## 验证入口与已验证范围

| 边界                                              | 入口                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| SDK 配置/CAS/采用、持久化失败、启停、日志、取消   | [`agent-sdk.test.ts`](../packages/host/tests/agent-sdk.test.ts)、[`agent-sdk.typecheck.ts`](../packages/host/tests/agent-sdk.typecheck.ts) |
| 客户端快照、提交前回执、中断、原 owner 与入口隔离 | [`client.test.ts`](../packages/agent-sdk/tests/client.test.ts)、[`entrypoints.test.ts`](../packages/agent-sdk/tests/entrypoints.test.ts)   |
| 身份、编码、保留、失败、取消                      | [`agent-runtime.test.ts`](../packages/host/tests/agent-runtime.test.ts)                                                                    |
| Node 制品、重复运行、原源码堆栈、关闭             | [`agent-node.test.ts`](../packages/host/tests/agent-node.test.ts)                                                                          |
| TS/Rolldown、依赖、共享绑定、source map           | [`scripts.test.ts`](../packages/rolldown/tests/scripts.test.ts)                                                                            |
| 可移植入口与 Workers 最小桥                       | [`agent-portability.test.ts`](../packages/host/tests/agent-portability.test.ts)                                                            |
| Vite 与交付接收端                                 | [Dev Console](DEV_CONSOLE.md#实现与验证入口)、[Plugin Control](PLUGIN_CONTROL.md#验证入口)                                                 |

真实 Host 验证复用正常 lowering、schema 与 coordinator；独立交付需经过 SDK/CLI → 认证 → 无源码/编译器 Node 应用。

### Workers 的当前证据

portability 测试从真实 `/host` export 按 browser 条件生成 ESM，检查闭包没有 Node/Vite/Services/编译器。真实 Miniflare/workerd 通过 Dynamic Worker 的静态模块文本加载 compileScript 工厂；共享 Core Result，使用 WorkerEntrypoint RPC 的受控桥访问原 Host。两次运行验证 await/计算、实际配置采用、模块计数重置及 scope/workerd 关闭。

桥只公开发现、配置读取和条件写入，使用 `globalOutbound: null`，run signal 在 Worker 本地创建。机制参见 [Dynamic Worker Loader](https://developers.cloudflare.com/dynamic-workers/api-reference/) 与 [Workers RPC](https://developers.cloudflare.com/workers/runtime-apis/context/#exports)。正式 CF 后端尚未交付：部署、取消传播、在途排空、桥释放、receipt owner、错误映射及 D1/KV/DO 持久任务仍需完整后端验证。存储证据见 [FS](FS.md)。
