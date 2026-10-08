# 实施与验收交接

当前完成：设计文档和现有契约核对。当前未完成：任何运行代码、QuickJS 兼容性实验、原生 UI、性能测量。以下是下一 session 的实施顺序，不是已经完成的能力清单。先读 [README](README.md) 和 [设计](DESIGN.md)，再按阶段读取框架入口。

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
| QuickJS     | [C API](https://quickjs-ng.github.io/quickjs/developer-guide/intro/)、[模块和 jobs API](https://github.com/quickjs-ng/quickjs/blob/master/quickjs.h) | 真正嵌入、异步 pump、模块实例、资源释放和目标版本锁定           |

实施前读取仓库 AGENTS、工程原则和 API 设计规则。当前工作区可能已有其他修改，不回退它们。框架公开行为变化需要同步所属 docs/engineering 和 `.tegami`；本次纯设计文档不需要 changelog。

## 2. 预期代码布局

以下是职责布局建议，不是要求先生成全部空目录；按阶段添加实际需要的文件。

```text
embedded-launcher/
  native/              Qt Widgets、原生能力、包存储、执行监督、CLI 入口
  src/app.ts           同一套插件与服务装配，接收 execution bindings
  sdk/                 独立 private 包：业务 DTO、wire 校验、service tokens
    src/services/      Launcher/Clipboard/Desktop owner views 与贡献投影
    fixtures/          C++/JS 共享 wire fixtures
  src/plugins/         Calculator、两种集成、NativeActions、CliCarrier
  src/execution/       Node 开发连接与 QuickJS bootstrap
  build/               portable 构建规则与示例包制品生成
  dev/                 官方 dev console 检查脚本
  tests/               双环境集成、native bridge 与制品 smoke
```

SDK 独立 package identity 用于满足现有按包名选择 singleton 的边界；它与业务插件不能共用被 externalize 的包名。实施时为 `projects/embedded-launcher/sdk` 添加准确的 workspace 匹配并核对仓库包发现/检查脚本对嵌套 private 包的处理，不泛化扫描范围。SDK 只导出 portable 契约和 Services，Node/QuickJS 适配器留在应用包；插件不能 import 原生执行器。先保持这两个包，不额外拆分每个示例插件。

## 3. 阶段 A：最早否定错误路线的真实闭环

锁定 Qt 和 QuickJS-NG，建立最小原生程序，使用真实 C API 而不是 qjs CLI 的额外标准库或 WASM 模拟器。构建一个经正式 lowering 的插件，加一个真实 owner Service 和 Commands 命令。

验收：原生调用插件 -> 插件异步调用原生能力 -> Promise 完成 -> 原生收到结果；在同一个 JSRuntime 中 stop/start，旧句柄失效，新调用正常；关闭 Host 后释放引擎。记录产物的 residual imports 和必需 globals，包括传递依赖。验证 Commands/配置/依赖的代表路径，不以 `console.log` 或 JS_Eval 成功代替。

这一阶段决定 portable Host 入口、基础 globals 和构建目标所需的最小框架改动。不要暂时删掉 Commands、关闭 lowering 或手写 DI 来做一个容易通过的演示。若需要迁移公共入口，在所属包完整修复并验证已知调用方。

## 4. 阶段 B：真实 Node/Vite HMR

建立 Qt 本地端点，Node 执行会话先连接，再通过现有 Host startup bindings 装配。启用 dev console；稳定 token 与 bridge 按已有 singleton 规则接入，插件源码由唯一 ModuleRunner 执行。

完成 CalculatorLauncher 与 NativeActions 的最小结果列表。修改插件返回值和一个普通业务 helper，真实 Qt 窗口自动更新；Vite 更新报告必须证明走了 HMR，而不是后台重启 Node 或原生程序。

必验以下时序：

- 查询等待原生异步响应时修改插件；旧响应不能发布结果或恢复旧动作。
- 缓存旧 action handle，HMR 后执行必须被拒绝；同名新动作可用。
- 新 generation 初始化失败，原生显示真实失败，失败代无残留贡献；修复源码可继续更新。
- 修改 app factory 触发 Host replacement，新 lease 可用，旧 lease 不可执行，配置存储仍正常。
- Node 断开，Qt 窗口保持；fresh Node 会话重连，只重发当前查询，不重放副作用。

用已有 dev console 查询当前 root/instance 的状态和日志；原生窗口与剪贴板的结果单独观察。不得另建隔离 Host 冒充开发会话验证。

## 5. 阶段 C：插件能力与管理

补齐 Calculator、CalculatorCommands、CliCarrier 和 NativeActions。root Commands 与 CLI carrier 复用同一个 Command 定义，验证原生 UI/CLI 共享同一 Calculator 状态。原生管理视图仅做插件列表、实际状态、start/stop、auto-start 和计算器配置表单；不实现通用 schema 表单引擎。

配置表单由现有 schema 校验，展示保存与应用的真实结果。启停失败读取 Host 报告，不由原生端猜测依赖状态。发布包的兼容性要求和 canonical plugin identity 此时定稿。

## 6. 阶段 D：生产安装与 JSRuntime 更新

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
| 发布环境缺 Node/源码    | 真实 Qt + 原生 QuickJS-NG 路径仍工作                               |

纯计算用普通测试；Plugin 行为用正式 lowering 的隔离测试；socket 与 C API 用共享 wire fixtures 和真实集成。生命周期、HMR 和发布兼容必须跑上述真实路径。原生 UI 使用 Qt 的测试/自动化设施与截图，不以浏览器 Playwright 替代 Widgets 验证。

性能测量按 DESIGN 的可观察项给出平台和样本，先确认合理范围内资源稳定和操作无重复；没有测量前不写延迟保证。不要为通过 benchmark 削弱 owner 校验、清理或错误报告。

## 8. 完成与停止条件

README 提供实际存在的构建、开发、生产和 CLI 命令；从干净构建到两种运行方式可复现。给出一条短演示流程：查询 -> 改源码 HMR -> 改配置 -> stop/start -> 安装新版 -> 应用变更。记录实际验证的平台、引擎版本、失败场景和剩余边界。

到此即完成架构演示。不要继续实现插件市场、通用桌面 SDK、任意 UI 插件、全盘搜索、跨平台安装器或每插件隔离运行时。若实现改变本设计，先更新实际拥有该事实的章节，删除被替代的路线，避免让下一位读者在两套方案中猜测。
