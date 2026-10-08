# 实施与验收交接

当前推进阶段 B/C 集成验收与 D 实现：阶段 A 的真实嵌入核心路径与兼容关闭已通过；真实原生窗口、基础 HMR/配置与断线重连已验证，完整竞态、包安装、联网和性能验收仍未完成。研究期 LLRT/txiki CLI 探针及空 Host smoke 的证据只在 [RUNTIME](RUNTIME.md) 维护，不继承为实现验收。先读 [README](README.md) 和 [设计](DESIGN.md)，再按阶段读取框架入口。

## 实施状态

本表是实现进度的唯一维护处；每阶段完成后填写真实命令、产物位置、观察结果和剩余缺口，不以文件存在或 CLI 退出码代替功能验收。

| 阶段 | 当前状态 | 完成证据 |
| --- | --- | --- |
| A：真实 LLRT 嵌入与插件生命周期 | 主要门槛通过，最终集成后仍需回归 | 主 agent 亲跑 smoke、runtime regression、14 项兼容与正常关闭；重复兼容销毁子任务已过，见下 |
| B：Node/Vite HMR 与原生往返 | 已实现，部分真实验收通过 | helper HMR、旧 action 拒绝、init 失败修复、断线窗口保留与 fresh session；完整竞态待补 |
| C：UI/CLI/配置与插件管理 | 已实现，部分真实验收通过 | Wayland 真实截图中文正常、保存/应用精度与 CLI 共享结果；真实控件/剪贴板待补 |
| D：联网、能力观察、安装和 runtime 重建 | 主路径已实现并真实通过，扩展矩阵未全验收 | workspace 外无 Node、HTTPS/Wretch、v1→v2、移除/显式恢复、ABI/摘要拒绝通过 |

先完成 A 再展开 B-D；无需预先生成所有模块。遇到关键嵌入阻断应保留最小复现，解释影响并修正当前路线，不靠删掉能力或改为 Node 发布执行伪装成功。

阶段不是自动停工点；新 session 按 [PROMPT](PROMPT.md) 用一个完整交付 goal 持续推进，并在接口稳定后委派 subagent。主 agent 对全流程集成、真实验收和最终完成状态负责，子任务完成不等于总目标完成。

### 当前执行记录（2026-10-08）

- 主 agent 负责共享接口、工作区接入、集成与真实验收；LLRT 子任务限于 `native/`、运行时准备脚本和补丁；TS 子任务限于 `src/`、`sdk/`、插件构建与测试。另有只读验收审计。
- 阶段 A 接口：私有模块 `launcher:bridge` 的 `request(json): Promise<string>`，嵌入入口 `dist/embedded.mjs` 导出 `dispatch(json): Promise<string>` 和 `close(): Promise<void>`。传输 JSON-RPC DTO，JS 引用不跨线程。
- 环境已确认 Node 24.16.0、pnpm 11.28.2、Rust/Cargo 1.97.1；Wayland socket 存在，窗口尚未验证。LLRT 固定 `0a10758f31eec3e5421a6b8ff1f459df1f4354c4`，有界补丁在 `patches/llrt-embedded.patch`，仍需真实运行回归。
- 子任务已报告 `cargo check --manifest-path projects/embedded-launcher/native/Cargo.toml`、TS typecheck 和正式 lowering build 通过，主 agent 尚待执行集成验收。Node 替代 transport smoke 只用于诊断，不能证明嵌入成功。
- 主 agent 已运行 `pnpm exec vitest run scripts/repository-packages.test.mjs`：输出 3 files / 12 tests passed；新增精确 SDK inventory 回归通过。`oxlint` 检查修改的 inventory 脚本通过。
- 主 agent 已亲跑 `cargo run --manifest-path projects/embedded-launcher/native/Cargo.toml --bin embedded-smoke`，退出 0：3 次真实 LLRT 创建销毁，每次 Commands → owner Service → 原生异步 echo → JS → Rust 返回；`1/3` 从 `0.3333333333` 配置为 `0.333`，停止 Calculator 后命令撤回，重新启动恢复，reset 已应用，关闭后 live runtime 计数为 0。另直接运行同一 binary 退出 0，原始输出在本地 `native/main-agent-smoke.log`（日志不入库，命令可重跑）。这仍不覆盖阶段 A 的全部门槛。
- 主 agent 随后重跑最新 `embedded-smoke`，第 4 个 runtime 的旧 Native Service、依赖 facade、Commands registration 撤回与同名新代可用共 5 项均为 true；亲跑 `cargo test --manifest-path projects/embedded-launcher/native/Cargo.toml --test runtime` 通过（1 case，含多个场景与 5 次销毁循环）。该回归覆盖退出接管、timer 异常后继续执行、并发入站、CPU interrupt、Blob/FormData/Origin、timer 注册表归零。
- 新增 14 项现代 npm/Web API fixture，在 Node 对照全过；首次真实 LLRT 运行收到 14 项成功值，但随后的 runtime 关闭触发 QuickJS `JS_FreeRuntime: list_empty(&rt->gc_obj_list)` 断言（exit 134）。该失败曾阻止 A 通过，修复及复验见下一项。
- 上述关闭失败已修复：释放 Context 后调用 `runtime.run_gc().await`，再释放 Runtime；默认断言保持开启，无标准 API 改写或泄漏 runtime。主 agent 已亲跑 `cargo run --locked --manifest-path projects/embedded-launcher/native/Cargo.toml --bin compatibility-check -- projects/embedded-launcher/dist`，退出 0，14 项成功、8 次 HTTP、关闭后 live runtimes 为 0。子任务随后扩展同进程 3 次循环，报告 42 项 / 24 次 HTTP 全过，每次销毁计数归零；最终集成时主 agent 再跑新循环版本。
- 当前继续 B/C：Rust 子任务拥有监督层、IPC 和 Cargo；TS 子任务拥有 SDK、业务 Plugin 和 Host 管理控制器；UI 子任务仅修改 `native/src/ui.rs`、UI 测试和字体；主 agent 拥有 Node 执行连接、开发 bootstrap、必要框架关闭入口和集成验收。
- B/C 主 agent 实测：`node dev.mjs` 打开真实 Wayland Iced 窗口；`embedded-launcher cli --profile ... --method ui.screenshot --params ...` 实际截图（本地 `.pluxel/dev/screenshots/dev-connected.png`），中文与状态可见。没有把 iced_test 离屏截图当作真实窗口证据。
- 固定 dev console root 与 instance `58ca284f-bf5e-4b4a-9496-09273e9159a2` 后修改 `calculator-label.ts`，新结果含 `HMR 实测`，catalogRevision 1→2，Host epoch `f0326db9-0e46-4c81-8089-2592eca3f0f9`、lease `2f9a8ae2-e906-4638-b751-ac4b889f4d95` 不变；旧 action 返回 `Action handle revoked`。临时引入 init throw 得到真实 `applied-with-issues / scope:definitions / start-failed`，修复后结果恢复。临时源码已还原。这一轮验证的是当前 Host 返回值，完整原生最新投影竞态仍待验收。
- 同一 dev console 配置 precision=3：`saved:true / application:applied`，原生 CLI `-- calc 1/3` 返回 `text:0.333, echo:0.333, precision:3`。误用 `calculator` 子命令明确得到 `Usage: calc <expression>`，实际命令为 `calc`。
- 首次 Node 退出后原生进程也消失，未误标为窗口保留。开发启动改为 detached 子进程；复验 Node PID334164 正常退出后 native PID334197 仍在，真实截图 `dev-disconnected.png` 显示断连、无旧结果；重连 Node PID357664 取得 fresh execution session，原生 PID保持。对应新 dev console instance `ec9b349c-5160-4040-a516-d3679f092d07`。启动仅在旧 endpoint 的 pid 已确认 ESRCH 时交由原生 profile lock 恢复；不修复坏配置或认证失败。
- D 构建 `node build/release.mjs` 已生成 `release/runtime/embedded.mjs`、共享单例 chunk、seed.zip 及两个版本 ZIP；manifest exports 从正式 lowering collector 提取。尚不能以 ZIP 存在宣称安装/重建通过。
- 下一步：补齐真实 UI 消息与 HMR 竞态验收；继续 Network、能力观察、安装/显式应用与 workspace 外无 Node 验收。

## 1. 已核对的基础与缺口

| 项目        | 当前事实/来源                                                                                                                                        | 实施要解决的问题                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Core/Host   | [系统边界](../../engineering/PLUGIN_SYSTEM.md)、[Host 实现](../../packages/host/src/host.ts)                                                         | 不复制 graph；Host 根入口含 Node 执行路径，需审计 portable 闭包 |
| Plugin 编译 | [版本化 lowering ABI](../../engineering/TOOLCHAIN.md)                                                                                                | 两端复用 lowering；不能依赖 runtime reflection 或原始 TS        |
| 开发执行    | [HMR](../../engineering/HMR.md)                                                                                                                      | 唯一 ModuleRunner，普通插件变更必须为 definition HMR            |
| singleton   | [hostSingletons](../../packages/host-vite/src/singletons.ts)、[官方服务接线](../../packages/services/src/vite.ts)                                    | 应用 SDK token 与官方服务保持同一实例；业务插件留在 HMR 图      |
| 应用服务    | [服务组合](../../docs/host/services.md)                                                                                                              | owner 绑定、候选注册与提交投影、cleanup                         |
| Commands    | [Commands](../../docs/plugin-development/commands.md)、[服务实现](../../packages/services/src/commands/service.ts)                                   | 复用 argv/mount；核对其完整依赖在 QuickJS 中可运行              |
| 配置持久化  | [HostDocumentStorage](../../packages/host/src/document-storage.ts)                                                                                   | 启动前可用；原生存储 commit 与 Host apply 分开报告              |
| 包管理      | [现有 Node/pnpm 模型](../../docs/plugins/package-manager.md)                                                                                         | 本例实现受控预编译包安装，不声称已有 QuickJS 安装器             |
| LLRT | [Vm](https://github.com/awslabs/llrt/blob/v0.9.0-beta/llrt_core/src/vm.rs)、[运行时证据](RUNTIME.md) | 真正嵌入、错误/退出接管、异步调度、加载和销毁；CLI 成功不替代它 |

实施前读取仓库 AGENTS、工程原则和 API 设计规则。当前工作区可能已有其他修改，不回退它们。框架公开行为变化需要同步所属 docs/engineering 和 `.tegami`；本次纯设计文档不需要 changelog。

## 2. 预期代码布局

以下是职责布局建议，不是要求先生成全部空目录；按阶段添加实际需要的文件。

```text
embedded-launcher/
  native/              Rust/Iced、原生能力、包存储、执行监督、CLI 入口
  src/app.ts           同一套插件与服务装配，接收 execution bindings
  sdk/                 独立 private 包：业务 DTO、wire 校验、service tokens
    src/services/      Launcher/Clipboard/Desktop owner views 与贡献投影
    fixtures/          Rust/JS 共享 wire fixtures
  src/plugins/         Calculator、两种集成、NativeActions、CliCarrier
  src/execution/       Node 开发连接与 LLRT bootstrap
  build/               portable 构建规则与示例包制品生成
  dev/                 官方 dev console 检查脚本
  tests/               双环境集成、native bridge 与制品 smoke
```

SDK 独立 package identity 用于满足现有按包名选择 singleton 的边界；它与业务插件不能共用被 externalize 的包名。实施时为 `projects/embedded-launcher/sdk` 添加准确的 workspace 匹配并核对仓库包发现/检查脚本对嵌套 private 包的处理，不泛化扫描范围。SDK 只导出 portable 契约和 Services，Node/QuickJS 适配器留在应用包；插件不能 import 原生执行器。先保持这两个包，不额外拆分每个示例插件。

## 3. 阶段 A：最早否定错误路线的真实闭环

先按 [运行时研究](RUNTIME.md) 验证 LLRT 真正嵌入、错误策略、线程唤醒与反复销毁，按 [技术选型](STACK.md) 锁定 Rust 依赖和完整 runtime 版本。把临时 CLI 探针重建为项目内正式测试；核实并修复已记录的 Blob/FormData 与 Origin 问题后重跑。建立实际链接运行时库的最小原生程序，不能用 CLI 成功或 WASM 模拟器代替嵌入证据。构建一个经正式 lowering 的插件，加一个真实 owner Service 和 Commands 命令。

验收：原生调用插件 -> 插件异步调用原生能力 -> Promise 完成 -> 原生收到结果；在同一个 JSRuntime 中 stop/start，旧句柄失效，新调用正常；关闭 Host 后释放引擎。记录产物的 residual imports 和必需 globals，包括传递依赖。验证 Commands/配置/依赖的代表路径，不以 `console.log` 或 JS_Eval 成功代替。

这一阶段验证已选 LLRT 的嵌入路线是否通过，以及 portable Host 入口和构建目标所需的最小框架改动。标准 globals 复用成熟实现；不得自行实现简化 Fetch/AbortSignal 来通过测试。不要暂时删掉 Commands、关闭 lowering 或手写 DI 来做一个容易通过的演示。若需要迁移公共入口，在所属包完整修复并验证已知调用方。

## 4. 阶段 B：真实 Node/Vite HMR

建立 Rust Unix socket 端点，Node 执行会话先连接，再通过现有 Host startup bindings 装配。启用 dev console；稳定 token 与 bridge 按已有 singleton 规则接入，插件源码由唯一 ModuleRunner 执行。

完成 CalculatorLauncher 与 NativeActions 的最小结果列表。修改插件返回值和一个普通业务 helper，真实原生窗口自动更新；Vite 更新报告必须证明走了 HMR，而不是后台重启 Node 或原生程序。

必验以下时序：

- 查询等待原生异步响应时修改插件；旧响应不能发布结果或恢复旧动作。
- 缓存旧 action handle，HMR 后执行必须被拒绝；同名新动作可用。
- 新 generation 初始化失败，原生显示真实失败，失败代无残留贡献；修复源码可继续更新。
- 修改 app factory 触发 Host replacement，新 lease 可用，旧 lease 不可执行，配置存储仍正常。
- Node 断开，原生窗口保持；fresh Node 会话重连，只重发当前查询，不重放副作用。

用已有 dev console 查询当前 root/instance 的状态和日志；原生窗口与剪贴板的结果单独观察。不得另建隔离 Host 冒充开发会话验证。

## 5. 阶段 C：插件能力与管理

补齐 Calculator、CalculatorCommands、CliCarrier 和 NativeActions。root Commands 与 CLI carrier 复用同一个 Command 定义，验证原生 UI/CLI 共享同一 Calculator 状态。原生管理视图仅做插件列表、实际状态、start/stop、auto-start 和计算器配置表单；不实现通用 schema 表单引擎。

配置表单由现有 schema 校验，展示保存与应用的真实结果。启停失败读取 Host 报告，不由原生端猜测依赖状态。发布包的兼容性要求和 canonical plugin identity 此时定稿。

## 6. 阶段 D：生产安装与 JSRuntime 更新

进入最终交付前，补齐 [联网与能力观察](NETWORK.md) 的 RemoteLookup、Fetch/Wretch 与运行时能力投影，并执行该页的双环境验收。它沿用阶段 B 的真实 bridge 和 HMR，不另起一个 Node-only 网络演示。

完成预编译包、原生包存储和版本选择。生产包放到 workspace 外，原生程序在无 Node/pnpm 可执行文件的环境中加载；没有源码目录也能运行。用本地文件选择器安装两个版本，再显式应用变更。

验证原生 PID/窗口保持，execution session 和 JSRuntime 实例改变；active revision 与 installed revision 正确展示，auto-start/配置持久化。新装插件不自动启用。移除包前后的当前运行事实与下次激活集合不能混淆；延迟 import 必须仍读取旧 active revision 的文件。

首次只支持一个安装队列和一份 installed selection。安装包验证失败保留旧选择；新 runtime 启动失败保留诊断和原生管理入口，允许显式选择上一集合 fresh start，不能暗中回滚数据或复活旧实例。

## 7. 最终验收矩阵

| 操作                    | 必须在真实边界观察的结果                                           |
| ----------------------- | ------------------------------------------------------------------ |
| UI 与 CLI 计算同一算式  | 同一 Host/Calculator 的配置和结果一致；CLI 无第二个 Host           |
| 改精度配置              | 两入口按 Host apply 报告生效，JSRuntime 身份不变；重建后持久值保留 |
| stop CalculatorLauncher | 只撤回其查询/动作，CalculatorCommands 继续可用                     |
| stop Calculator         | dependents 按 Core 规则结算；缓存 facade/动作不可继续执行          |
| 多次 start/stop         | JSRuntime 不重建，无重复命令/provider/订阅                         |
| HMR 与快速连续输入交错  | 只有最新 query 和有效 owner 的结果可执行                           |
| 同名注册替换            | 旧句柄永远不复活，不能按 name 重定向旧动作                         |
| 初始/部分 init 失败     | 原生可管理剩余插件，无半初始化贡献；报告与可见状态一致             |
| CLI 调用中停止 owner    | 取消与 drain 按 Commands 契约完成，已提交领域回执不被覆盖          |
| 断连发生在原生写入后    | 不自动重试写入；结果未知与明确拒绝区分                             |
| Host replacement/补偿   | 连接可借用，新 lease 生效，旧贡献失效；恢复报告来自 Vite           |
| 安装升级但尚未应用      | 当前 active 行为不变，installed 标记待应用                         |
| 应用升级/移除           | 只重建插件 JSRuntime，窗口不关闭，完整新集合加载                   |
| ABI 不匹配/包文件损坏   | 激活前拒绝，指出具体输入；不降级加载或补猜入口                     |
| 重复 HMR/运行时重建     | 有界资源计数回归稳定，JS handles、原生回调和 pending 请求无累积    |
| 发布环境缺 Node/源码    | 真实 Rust UI + 内嵌 LLRT 路径仍工作                               |

纯计算用普通测试；Plugin 行为用正式 lowering 的隔离测试；socket 与 rquickjs 绑定用共享 wire fixtures 和真实集成。生命周期、HMR 和发布兼容必须跑上述真实路径。原生 UI 用 iced_test、原生窗口自动化和截图验证，接线与覆盖要求见 [STACK 第 7 节](STACK.md#7-ui-完成度与-agent-验证)；不得用浏览器 Playwright 页面替代真实窗口。测试视图切换不影响 runtime 身份，UI 的迟到回执不能覆盖新 session/query。

性能测量按 DESIGN 的可观察项给出平台和样本，先确认合理范围内资源稳定和操作无重复；没有测量前不写延迟保证。不要为通过 benchmark 削弱 owner 校验、清理或错误报告。

## 8. 完成与停止条件

README 提供实际存在的构建、开发、生产和 CLI 命令；从干净构建到两种运行方式可复现。给出一条短演示流程：查询 -> 改源码 HMR -> 改配置 -> stop/start -> 安装新版 -> 应用变更。记录实际验证的平台、引擎版本、失败场景和剩余边界。

到此即完成架构演示。不要继续实现插件市场、通用桌面 SDK、任意 UI 插件、全盘搜索、跨平台安装器或每插件隔离运行时。若实现改变本设计，先更新实际拥有该事实的章节，删除被替代的路线，避免让下一位读者在两套方案中猜测。


## 本次提交验收与剩余边界（2026-10-08）

用户最后要求优先演示功能跑通、约 10 分钟内提交推送。本次按此收敛，不把原完整矩阵全部标为通过。

已由主 agent 真实验证：

- `tests/development-acceptance.mjs` 对固定 instance `85c345a8-1fa4-4141-a507-79e02072d6fd` 通过四条主链：普通 helper HMR 后原生 UI 收到新 subtitle且Host epoch不变；旧action拒绝；真实剪贴板回执后独立 `wl-paste` 读到一致结果；初始化失败贡献撤回/源码修复恢复；precision=4 后 Commands 和原生 CLI 都返回 `0.3333`。原始结果本地 `.pluxel/acceptance/development.json`，脚本可复现。
- 实际复制 binary 与 release/runtime 到 `/tmp/pluxel-launcher-release-check/`，设置 `PATH=/nonexistent` 启动真实 Iced+嵌入 LLRT，CLI `calc 1/3` 成功。此路径不含仓库源码或 node_modules；系统动态库仍为当前 Linux 环境。没有把 PATH 限制描述成隔离安全沙箱。
- v1 活动期间安装 v2，installed=2、active=1、pending=true，UI仍返回 `计算 v1.0.0 1/3`；显式 apply 后新execution session、active=2、pending=false，原生窗口持续存活。remove/apply可建立空插件Host，selectPrevious/apply重新恢复 v2。ABI=999 ZIP与改坏plugins.mjs摘要ZIP均在安装阶段明确拒绝。
- 生产 UI 输入 `web delectus`，通过真实 LLRT Fetch + owner Network + Wretch 返回公开 HTTPS JSON 的5条结果；Network观察含origin/method/status200/实际读取bytes609、completed计数、active=0，不含query/header/body。`web example` 的空结果是远端真实空数组，未假造匹配。
- 已查看真实生产 Packages 页面截图：installed/active=2、无待应用、安装/应用/上一集合/移除入口完整。截图本地 `profile/screenshots/production-packages-settled.png`；不提交临时截图或含认证信息的profile。
- 主 agent 再跑 compatibility-check：3次runtime、42项兼容、24次真实HTTP全部通过，liveRuntimesAfterClose=0。host-vite全套22 files/122 tests、项目TS 2 files/5 tests、相关typecheck通过。

仍未完整验证：Network完整双环境故障/流分支矩阵（DNS/TLS失败、各类clone/tee/pipe与owner停止时的drain）；长时间资源与延迟基准；IME组合输入；文件选择器人工选中文件的桌面portal流程（安装后端与管理UI接线已实现，当前真实安装验收经CLI）；完整快速输入/异步等待期间HMR竞态与app factory replacement；失败新runtime的全部恢复时序；跨Linux发行版及优化release构建。共享wire valid/invalid fixtures尚未完整建立。保持完整goal未完成，不以提交成功替代这些验收。

提交前收尾：主 agent 亲跑原生 `runtime` 1项、`supervisor` 2项、`ui` 9项全部通过；项目最终 typecheck、5项TS测试、插件/两个版本制品重建、oxlint与仓库治理检查通过。包存储对已有active目录的selection.mjs额外完整性复核、ZIP实际展开字节累计的进一步加固尚未实施；当前包仅支持本演示构建的受控输入，不宣称恶意包安全沙箱。
