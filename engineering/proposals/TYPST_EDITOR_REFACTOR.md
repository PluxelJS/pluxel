# Typst 编辑器重构实施记录

状态：I01–I06、R01–R04 已实施；2026-10-25 独立复核发现的 V01–V03 已修正并通过针对性回归。完整桌面流程再次通过，E01 本轮未复现，原失败证据保留。实施、独立复核与修正验证分别记录；当前结果见文末。

目标仍是降低误用和重复维护成本，保留实用编辑能力、严格准入、失败处理与资源边界。I05/R04 合并为一条候选流程；没有扩大到暂缓事项，也没有以减少测试覆盖换取通过。

## 当前契约与范围

- SDK、共享 UI 与内部职责：[区域编辑用法](../../docs/plugins/rendering/typst-editor.md)、[Typst DESIGN](../../plugins/render/typst/DESIGN.md)、实际 exports、实现和测试。本文只保留决策、实施证据与剩余事项，不另维护 API 定义。
- 独立浏览器宿主：[consumer README](../../plugins/render/typst/tests/consumer/README.md)；真实应用：[Studio README](../../projects/report-template-studio/README.md)。Studio 仅迁移受影响的共享能力，没有改写其存储、Monaco 或工作区生命周期。
- 工作规则：根 `AGENTS.md`、`plugins/AGENTS.md`、[开发 skill](../../.agents/skills/pluxel-development/SKILL.md)、[API 设计规则](../../.agents/rules/library-api-design.md)及相关工具链、前端、测试文档。

## 实施与基线

本轮实际 HEAD 为 `d2fc1ceb94a8d8401a2bd7e48d2d77b843d26a49`。开始时已有 `engineering/proposals/README.md`、`plugins/render/typst/README.md` 和 `vendor/split-like-vscode` 修改，以及本提案未跟踪文件。初次实施时这三项保持原样；原提案和原有 diff 保存在证据目录的 `baseline/`。初次交接没有提交、推送或发布；后续用户授权修正并提交推送，本次同步两个 README 的记录入口，继续保留无关 submodule 修改。

先重新复现了通用编译错误、候选 A 暂存后输入 B 却接纳 A、保存 quota 异常和无保护替换，再实施 R01/R02/R03、诊断/保存/候选、参数/布局/示例，最后使用最终源码与实际 dist 验证。旧计划中的历史测试没有计入本轮结果。

| 编号      | 实施位置                                                                                                                                                                                                                                                                | 收益与保留能力                                                                                                                                                                                                      | 偏离与边界                                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I01       | [consumer 传输边界](../../plugins/render/typst/tests/consumer/server.ts)、[坐标/DTO](../../plugins/render/typst/tests/consumer/compile-contract.ts)、[宿主界面](../../plugins/render/typst/tests/consumer/main.tsx)、[worker](../../plugins/render/typst/src/worker.ts) | 错误类别、名称/code、具体诊断与成功 warning 到达界面；使用失败请求自己的 revision/mapping；集中转换零基与一基 UTF-16；可定位模板、区域和源码块。保留旧画面、过期 PDF 禁用、一个在途/最新待处理与实际 displayed 阶段 | 实测当前 native 绑定的 `takeDiagnostics` 只取 errors，故补取 `takeWarnings`；这是现有 wrapper 修复，没有升级或修改 native/compiler。早于生成的失败可无映射；旧坐标不跳到新草稿 |
| I02       | [consumer main](../../plugins/render/typst/tests/consumer/main.tsx)、[源码块待应用标记](../../plugins/render/typst/src/tiptap/blocks-react.tsx)                                                                                                                         | 实际成功保存的完整 raw 草稿为 baseline，保存失败不推进；保存与预览状态独立；替换前保护正文、未应用数据/源码/参数，取消保留 Editor/history；确认加载建立新身份                                                       | 沿用浏览器单槽与原生 beforeunload；不建设自动保存/数据库。关闭提示是否展示由浏览器平台决定；Studio 原有条件写入保持                                                            |
| I03       | [宿主参数表单](../../plugins/render/typst/tests/consumer/channel-parameters.tsx)、[已有组件定义](../../plugins/render/typst/tests/consumer/report-example.mjs)                                                                                                          | 复用 channels 的标题 validator，以原生命令一次 transaction 修改指定实例；ID 保持、两个实例独立、无效/取消不写；provider 数据仍独立，JSON 详情可达                                                                   | 固定展示本组件完整输入绑定，不开放无业务契约的任意路径；没有新增 SDK 表单 DSL/扩展点                                                                                           |
| I04       | [共享 UI](../../plugins/render/typst/src/tiptap/ui.tsx)、[共享样式](../../plugins/render/typst/src/tiptap/style.css)、[consumer 布局](../../plugins/render/typst/tests/consumer/style.css)、[Studio 样式](../../projects/report-template-studio/src/renderer/style.css) | 排版按需展开，字体/字号/文字色/背景色/继承/清除均保留；桌面并排、390×844 编辑/预览切换；隐藏不卸载 Editor 或预览；原有菜单、焦点、只读/IME 提示继续可达                                                             | Studio 消费同一共享组件，只做必要布局；原生 details 不引入第二套工具协议                                                                                                       |
| I05 / R04 | [consumer main](../../plugins/render/typst/tests/consumer/main.tsx)、[Studio BodyEditor](../../projects/report-template-studio/src/renderer/body-editor.tsx)                                                                                                            | 两宿主统一为固定目标→原文/候选对照→查看修改预览→接纳；唯一候选文字，改字立即使准备结果失效但不刷新 base revision；提交读取最新数据/权限/修订并核对接纳结果，一次 undo；范围外表格/组件保持                          | 共用含义而非巨型 UI；有损目标明确拒绝；使用手工文字与 fixture，没有付费模型或通用富文本 diff                                                                                   |
| I06       | [公开 React 示例](../../docs/plugins/rendering/typst-editor.md)、[props 注释](../../plugins/render/typst/src/tiptap/react.tsx)、[独立制品验收](../../plugins/render/typst/tests/consumer/acceptance.ts)                                                                 | 稳定 config/extensions，content 明确为初始化，onChange 保存快照；普通 rerender/数据/区域切换保留实例，整份草稿替换显式换 key/history；从正式文档提取最短示例并严格类型检查                                          | API 原名与初始化语义保留；没有受控 wrapper、alias 或隐式 setContent                                                                                                            |
| R01       | [candidate](../../plugins/render/typst/src/tiptap/candidate.ts)、[public export](../../plugins/render/typst/src/tiptap/index.ts)、两个宿主调用点                                                                                                                        | 窄的原生选区捕获能力统一完整块范围与 region/base revision；覆盖折叠/边界/排他结束/嵌套/原子/AllSelection/多 range CellSelection；删除两份旧范围算法；不修改正文/选区                                                | 捕获不授予权限，准备与提交仍各自严格校验；不迁移过期范围                                                                                                                       |
| R02       | [块扩展命令](../../plugins/render/typst/src/tiptap/blocks.ts)、[React 调用方](../../plugins/render/typst/src/tiptap/blocks-react.tsx)、[最新准入](../../plugins/render/typst/src/tiptap/react.tsx)                                                                      | 模板/源码插入和复制统一归原生命令；唯一实例 ID、独立 defaults/props、一次可撤销 transaction；移动 ID 保持；直接调用与 UI 共用只读/区域/IME 规则，can() 不写文档/历史/defaults                                       | UI 继续明确选择源码示例；载入/粘贴缺失或重复 ID 仍失败，没有静默修复                                                                                                           |
| R03       | [validation](../../plugins/render/typst/src/tiptap/validation.ts)、[serialize](../../plugins/render/typst/src/tiptap/serialize.ts)                                                                                                                                      | 一次同步公开调用内复用 schema 与区域/字段/模板/表格索引，内部校验和生成共享；保留原始 JSON、未知结构/属性、serializer、Unicode、字段、表格与集合检查，未知 callback 异常继续传播                                    | 没有跨调用缓存、公开 context/品牌对象或第二份树；新调用配置重新生效。测试证明构造次数与校验一致性，未测量或宣称用户可感知的提速                                                |

新增公开能力仅为共享目标捕获和对应块扩展的四项原生命令，契约详见正式文档。原有 prepare/apply、节点、React 与 browser/Node 入口保留；已迁移 consumer、Studio 与真实测试调用方，未保留同义 alias。两个包均为 private，未添加空 Tegami 或手改版本。

## 必须保留的设计

| 设计                                | 保留理由与验收边界                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| 原生 Tiptap JSON 为正文权威         | 表格、Marks、字段、组件不能被 Markdown/HTML 静默简化；不建第二份 AST/history |
| raw data 与 parsed data 分开        | transform 只在规定边界执行，保存与重开不重复变换；数据更新不制造正文事务     |
| 草稿、编译、存储修订分开            | 分别表达编辑内容、成功产物与条件写入；不能合成一个数字或把完成编译当作已保存 |
| compiled 与 displayed 状态分开      | 编译成功与浏览器实际展示不是同一时刻；可以聚合相关字段，但不能删除真实阶段   |
| 一个在途编译与最新待处理快照        | 避免旧结果覆盖新草稿；不通过逐键 abort 终止 native session                   |
| 候选准备与提交复核                  | 权限、数据、内容、版本可能变化；预检查不代替提交接纳                         |
| 每区域原生 Editor/history           | 区域切换、业务数据变化不破坏正文历史；替换文档有独立身份                     |
| 模板组件与源码块独立启用            | 使用可信组件与允许用户编写可执行 Typst 是不同授权                            |
| 独立 browser/tiptap/react/Node 入口 | 保留无 DOM 使用、可选 peers 和运行环境隔离，不强制装 Monaco/Workbench        |
| 当前修订导出及明确资源释放          | 旧 PDF 不冒充当前草稿；取消、线程退出、dispose 与普通编译失败仍有不同语义    |
| 严格准入与显式转换                  | 错误输入可修复但不可悄悄改写；卸载扩展不自动删除草稿内容                     |

表格样式、合并/跨行、字段、图片、组件移动/复制、源码编辑、文字排版、双向定位、目录/页码、只读、IME、Markdown/HTML 与一次撤销等已有实用能力均须保留。不得把减少测试范围或禁用按钮作为重构完成。

## 暂缓与不做

- **通用组件参数 schema/表单协议**：先完成 I03 的真实宿主表单；多个组件出现相同需求后再评估。现有 defaults/validator/表单可以复用宿主规则，不急于扩张 SDK。
- **万能 EditorController、通用编译/导航框架**：两宿主的 IO、pane、存储与生命周期不同。只抽取已有证据相同的窄规则，不能仅因 main.tsx 较长引入总控对象。
- **跨调用 schema 缓存、增量准入、性能参数**：先测量真实文档；本轮 R03 不承担这些承诺。
- **在 consumer 引入 Monaco、完整 Typst LSP**：textarea 是独立轻量消费示例；I01 补足诊断和定位，完整源码 IDE 继续由 Studio 持有。
- **拆新 SDK 包、合并现有子入口、统一所有错误为 Result、另建正文格式或组件注册平台**：当前没有足以抵消迁移和维护成本的证据。
- **任意 Typst 反解富文本、完整有损格式往返、多人协作、模型供应商接入、自动数据迁移**：不属于本轮。
- **框架、native/compiler、工具链升级和无关应用重构**：当前计划不需要；若遇到真实阻塞，先定位并说明，不能顺手扩张范围。

## 本轮自测与交接证据

证据根目录：`/tmp/pluxel-typst-refactor-20261024/`。`handoff/index.json` 索引最终截图、PDF、日志、服务状态及 `implementation.diff`；diff 相对本轮开始的工作区，包含新增文件和本提案的实施记录更新，排除前三项原有无关修改。原始基线在 `baseline/`，失败尝试留在根目录供排障，不计作通过证据。

工具链：mise 管理的 Node 24.22.0、pnpm 11.28.6、Vite+ 1.4.0；测试使用当前 native binding 与真实 Electron 44.9.0。所有会写依赖 dist 的任务顺序执行，类型与独立制品检查读取实际构建声明。

| 命令（均在仓库根运行）                                                                                                                                                                                        | 本次实际结果                                                                                                                           | 最终日志/产物（相对证据根目录）                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `mise exec -- vp run @pluxel/plugin-typst#compile`                                                                                                                                                            | 成功；后续类型/测试任务也核对构建依赖                                                                                                  | `compile-final.log`                                                                |
| `mise exec -- vp run @pluxel/plugin-typst#check-types`                                                                                                                                                        | 成功                                                                                                                                   | `typst-types.log`                                                                  |
| `mise exec -- vp run @pluxel/plugin-typst#check-tests`                                                                                                                                                        | 17 文件、127 项通过，12.27s；含真实 warning/PDF/错误恢复                                                                               | `typst-tests.log`                                                                  |
| `mise exec -- vp run @report-template-studio/app#check-types`                                                                                                                                                 | 成功                                                                                                                                   | `studio-types.log`                                                                 |
| `mise exec -- vp run @report-template-studio/app#check-tests`                                                                                                                                                 | 28 文件、167 通过/1 跳过，64.93s；跳过项原为 Windows ACL 专用，Linux 不适用                                                            | `studio-tests.log`                                                                 |
| `mise exec -- vp run @report-template-studio/app#compile`                                                                                                                                                     | 成功                                                                                                                                   | `studio-build.log`                                                                 |
| `PLUXEL_TYPST_CONSUMER_OUTPUT=/tmp/pluxel-typst-refactor-20261024/isolated-verified mise exec -- node plugins/render/typst/tests/consumer.mjs`                                                                | 独立制品安装验收 1 项通过，111.88s；无 DOM 根入口、无编辑器 browser 消费、严格声明/公开文档 React 示例、完整 React/原生 PDF 与模块边界 | `isolated-verified.log`、`isolated-verified/evidence/`                             |
| `TMPDIR=/tmp/pluxel-typst-refactor-20261024/managed mise exec -- node plugins/render/typst/tests/consumer/report-example-check.mjs`                                                                           | 原覆盖及新增 refactor 场景通过，page errors `[]`                                                                                       | `browser-report-example-check.log`、`managed/typst-report-ui-paYHj5/`              |
| `TMPDIR=/tmp/pluxel-typst-refactor-20261024/managed mise exec -- node plugins/render/typst/tests/consumer/contexts-check.mjs`                                                                                 | 通过，page errors `[]`                                                                                                                 | `browser-contexts-check.log`                                                       |
| `TMPDIR=/tmp/pluxel-typst-refactor-20261024/managed mise exec -- node plugins/render/typst/tests/consumer/blocks-check.mjs`                                                                                   | 通过，page errors `[]`                                                                                                                 | `browser-blocks-check.log`                                                         |
| `TMPDIR=/tmp/pluxel-typst-refactor-20261024/managed mise exec -- node plugins/render/typst/tests/consumer/table-style.mjs`                                                                                    | 通过，page errors `[]`                                                                                                                 | `browser-table-style.log`                                                          |
| `STUDIO_SCREENSHOTS=/tmp/pluxel-typst-refactor-20261024/studio-headless-complete STUDIO_DISABLE_SANDBOX=1 STUDIO_OZONE_PLATFORM=headless mise exec -- node projects/report-template-studio/tests/desktop.mjs` | 完整原生 Electron 流程通过；真实 preload/IPC、Monaco、组件/候选、保存重开、PDF/ZIP、重复退出与资源清理；22 项 passed 记录              | `studio-headless-complete.log`、`studio-headless-complete/result.json`、截图与 PDF |
| `mise exec -- vp check <本轮变更文件>`、`git diff --check`、旧符号/链接/基线检查                                                                                                                              | 通过：37 文件格式正确，29 代码文件无 lint/type 错误；其余复核见 `handoff/checks.json`                                                  | `format-final.log`、`review-final.log`                                             |

新增浏览器场景由现有 report 入口执行 [refactor-cases.mjs](../../plugins/render/typst/tests/consumer/refactor-cases.mjs)：候选 A→B 失效、quota/保存 baseline、取消/确认替换、beforeunload reload 取消、Editor 身份/重建、失败请求映射、UTF-16、旧响应竞态、warning 修复、双实例改参/撤销、直接命令只读与真实 CDP IME、源码块未应用输入、移动端 pane/触屏/参数表单及资源身份。延迟用例持有真实 HTTP 编译响应，不伪造成功结果；quota 用隔离上下文注入存储失败；测试不碰用户已有保存槽。

保留并适配原有断言，没有删除困难场景、降低准入或新增 skip。桌面用例现显式打开折叠排版、以 Shift+F10 打开既有选区菜单，并等待 ArrowRight 对应的原生选区/DOM caret 结算后 Enter，额外断言原 IME 段落仍在。失败回执另存原始错误，避免退出检查掩盖起因。

可读证据（`handoff/` 中也有副本）：

- 桌面 1440×900：`managed/typst-report-ui-paYHj5/refactor/parameters-desktop.png`、`candidate-review.png`、`template-diagnostic.png`、`component-diagnostic.png`、`warning.png`、`save-failure.png`。
- 窄屏 390×844：同目录的 `mobile-editor.png`、`mobile-preview.png`、`mobile-touch-menu.png`、`mobile-parameters.png`，包含实际菜单、表单与编辑/预览切换，不只检查无横向溢出。
- 真实 PDF：同目录 `final.pdf`；独立消费 `isolated-verified/evidence/latest.pdf`、`native-page-1.png`；Studio `studio-headless-complete/body-reopened.pdf`、`workspace.pdf` 及 `09b-body-typography-reopened.png`。Electron 窗口 1440×900，内容截图 1440×875（标题栏占 25px）。

## 服务、剩余事项与未验证边界

- 复用既有 `pluxel/typst`，URL `http://typst.pluxel.localhost:8088`，原托管 PID `998863`、port `3410`，最终仍运行。`typst` profile 为 `console: false`，不存在控制台 HMR pause/apply；consumer 用普通 Vite HMR，SDK 变更重建实际 dist 后再验收。没有重启共享 supervisor，也未操作其他任务服务。
- 开始及最终 Studio profile 均无运行实例；桌面验收使用独立临时 profile 并正常释放，不需要给用户已有应用做 HMR 暂停/恢复。最终 `dev status`、Pitchfork 状态与有界日志在证据目录；日志中的已修复构建中间态不代替最终成功结果。现有 fixture 的 public JSON 导入提示和初始化 deprecated warning 仍可见，未计作 page error，也未扩张为依赖升级。
- Wayland 完整流程未验证：本机 Electron 在启动阶段出现 SIGSEGV；保留失败日志。使用原生 Ozone headless 后执行相同完整脚本并通过，测试只增加可选环境参数与固定窗口，不改变产品显示/sandbox 默认。该结果不证明 Wayland/X11 或操作系统沙箱兼容性。
- 未验证 Windows/macOS、发布/安装包、`test:desktop-recovery` 专项、操作系统真实输入法面板及大文档性能；CDP IME/Unicode 和构建后的 Electron 完整流程已实际执行。未运行付费模型，也未把这些边界写成通过。
- 交接时实施者报告范围内没有已知未完成代码项；独立复核随后发现的问题见下文 V01–V03。上述平台边界及暂缓事项仍保留。本轮自测不授予 A01–A10 通过状态。

## 独立验收清单

以下保留原要求，状态汇总 2026-10-25 独立复核和随后修正回归。“本机通过”限于下文记录的源码审查、实际复跑及交接证据复核，不扩张为跨平台或性能保证。待修正项只需针对明确缺口补齐，不重做已经成立的设计。

| 验收组             | 必须证明的行为                                                                                                                               | 状态                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| A01 范围与身份     | 两宿主对折叠光标、跨段落、块边界、嵌套/表格/原子选区有一致且明确的完整块范围；范围与修订一起固定；无效范围拒绝                               | 本机通过                       |
| A02 组件命令       | 插入/复制 ID 唯一，移动 ID 不变；defaults 互不污染；直接程序调用与 UI 行为一致；一次 undo/redo；只读/IME/预演不误写；坏旧输入仍拒绝          | V03 修正回归通过               |
| A03 校验一致性     | 未知节点/Mark/属性、缺 serializer、非法 Unicode/表格/字段/区域集合仍失败；不同调用的配置变化可见；未知异常不被误分类；没有新公共缓存生命周期 | 本机通过                       |
| A04 诊断           | 模板/组件错误及 warning 可解释；使用失败请求自己的映射；UTF-16/零基转换正确；快速编辑不误定位；修复后预览/PDF 恢复                           | 本机通过                       |
| A05 保存           | 编译与保存状态独立；保存失败保留 dirty；取消切换/重开不丢正文和未应用输入；确认放弃可执行；raw/regions/模板保存重开一致                      | V01/V02 修正回归通过           |
| A06 候选           | 原文、目标、候选可核对；暂存后改字不会接纳隐藏旧文本；数据/正文/模板变化及撤权均阻止旧候选；拒绝有损目标；范围外图表/表格不变；成功一次撤销  | 本机通过                       |
| A07 参数与布局     | 两组件实例独立改参、错误不提交；桌面/窄屏功能可达；切换保留选区/history；上下文菜单、触屏入口、键盘、IME 与只读不退化                        | V01 修正回归通过               |
| A08 生命周期与接入 | rerender/数据更新不重置编辑器，替换文档不沿用 history；旧结果不发布；session/View/Editor 释放正确；根与浏览器可选依赖隔离                    | 本机通过，制品隔离复核交接证据 |
| A09 实际产物       | 真实 native 预览/PDF 和双向定位正确；独立 consumer 使用最终 dist；Studio 通过公开入口使用改动，Monaco 与原有桌面流程保留                     | 本机复跑通过；E01 本轮未复现   |
| A10 契约与范围     | exports、类型、运行时、文档一致；被替代算法已删除；没有同义 alias、静默修复、新正文模型或无关框架变更                                        | V03 修正回归通过               |

| 阶段                     | 状态                 | 证据与结论                                                               |
| ------------------------ | -------------------- | ------------------------------------------------------------------------ |
| 当前源码、改动与服务基线 | 已复核               | 本轮 HEAD、baseline、原有修改保护及服务记录                              |
| I01–I06、R01–R04 实施    | 已实施               | 见逐项位置与收益/边界；I05/R04 合并                                      |
| 最终自测与交接           | 已完成自测           | 最终源码对应的类型、单测、独立制品、真实浏览器/Electron、diff 与证据索引 |
| 独立验收 A01–A10         | 已复核并完成修正回归 | 方向符合原计划；V01–V03 已修正回归，E01 保留历史失败证据                 |

## 2026-10-25 独立验收结论

首次独立复核结论：**设计方向符合原预期，保留本轮重构；修正三个局部缺口后再完成验收。** 后续修正已完成，见文末；以下保留当时的分析。 本轮没有发现需要引入通用控制器、表单 DSL、跨调用缓存或重写 Studio 的理由。

- R01 的目标捕获统一了两宿主已存在的规则；R02 把身份、默认值所有权与撤销边界交给原生命令。这些抽取有真实调用方，值得保留。
- R03 只复用一次同步调用的准备工作，严格校验与提交复核仍在，没有以复杂缓存换取未经测量的性能承诺。
- I01、I05/R04、I06 分别改善失败定位、候选可见事实和 React 接入约定；没有新增正文 AST、受控回填或兼容别名。
- I04 的折叠排版与保留挂载的窄屏切换有效减少常驻占用；实际检查了桌面与窄屏操作和截图。原有工具应继续保留。
- I02/I03 的剩余问题集中在**未确认表单的生命周期和状态来源**。标题暂存可以保留，但它不能随临时选区消失；显示状态、保存和离开判断也应表达同一事实。

### 独立复核的证据范围

证据目录为 `/tmp/pluxel-typst-review-20261025/`，属于本机临时证据；关键复现与验收条件同时记录在本文，避免依赖临时目录才能理解问题。

| 复核                                        | 实际结果                                                                                                                                                                                                                 | 证据                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 读取原提案、最终 diff、两个调用方与正式契约 | 对照交接 `baseline/proposal.md`；37 个交接源码文件 SHA-256 全部一致，之后本次只修改本文                                                                                                                                  | `source-check.json`；交接的 `baseline/` 与 `handoff/`                                                              |
| Typst 全量测试                              | 在包目录执行 `mise exec -- vp test run --config vitest.config.ts`；17 文件、127 项通过，8.61s                                                                                                                            | `typst-tests.log`                                                                                                  |
| Studio 输入恢复与候选回归                   | 在应用目录执行 `mise exec -- vp test run --config vitest.config.ts tests/input-recovery.test.tsx`；6 项通过                                                                                                              | `studio-input.log`                                                                                                 |
| 真实浏览器 report 入口与新增 refactor 场景  | 在根目录执行 `TMPDIR=/tmp/pluxel-typst-review-20261025 mise exec -- node plugins/render/typst/tests/consumer/report-example-check.mjs`；通过，page errors 为空，包含真实 native/PDF、diagnostics、候选、保存、IME 与窄屏 | `report-browser.log`、`typst-report-ui-aa3l2J/`                                                                    |
| 自测外的交互与输入边界探针                  | 复现 V01–V03，page errors 为空；这说明业务状态错误不一定伴随页面异常                                                                                                                                                     | `review-probe.mjs`、`review-probe.json`、`parameter-loss.png`                                                      |
| 完整 Electron 首次复跑                      | 正文编辑、候选、保存重开、排版与 PDF 已执行；后续 `formMeta` 补全失败，整条脚本未通过                                                                                                                                    | `studio-desktop.log`、`studio/failure.json`、`studio/09b-body-typography-reopened.png`、`studio/body-reopened.pdf` |
| 完整 Electron 原样再跑                      | 相同源码、相同 Ozone headless 参数，不修改断言；完整通过，22 项 passed 记录，包括补全/悬停、PDF/ZIP 与退出清理。保留首次失败，未查明波动原因                                                                             | `studio-desktop-repeat.log`、`studio-repeat/result.json`                                                           |

未重新构建依赖或重跑独立安装制品测试；这些结果是核对相同源码后的交接证据复核，不冒充本次重新执行。Windows/macOS、Wayland/X11、真实输入法面板及大文档性能仍不在通过范围。沿用 `pluxel/typst` PID `998863`，没有修改产品源码、提交、推送或发布。

### V01：未确认的渠道标题随选区切换消失（P2；A05/A07）

位置：[channel-parameters.tsx](../../plugins/render/typst/tests/consumer/channel-parameters.tsx) 的 `ChannelParameters` 选区分支及 `ChannelTitle` 局部状态，验收时为第 12–31 行。

复现：载入图表报告并保存 → 选中渠道卡片 → 输入新标题但不确认 → 点击普通段落 → 再选同一卡片。新标题恢复成旧的“渠道收入与目标”，没有放弃提示。此时再重开也没有提示，因为未应用输入的 DOM 标记已经随表单卸载而消失。两个组件实例之间切换也有同样的生命周期风险。

原因：未确认文字只由按选区挂载的 `ChannelTitle` 持有，选区变化直接卸载组件。普通选择动作由此隐含了“取消参数修改”，违反减少误操作和保留未应用输入的目标；正文没有变化，undo 也不能找回这些字。

最小修正方向：让宿主持有待确认参数及其实例身份，或者让有待确认输入的表单固定目标直到明确确认/取消。选择只决定查看位置，不能无提示销毁输入；不需要通用表单平台，也不把未通过校验的输入写进正文。

再验收：输入标题后点段落、另一组件、另一区域及预览定位，回到原实例仍能恢复文字，或先得到明确的放弃选择；拒绝放弃保留输入。保持双实例隔离、确认一次 undo、只读及 IME。

### V02：取消参数后“有未应用输入”不会清除（P2；A05）

位置：[main.tsx](../../plugins/render/typst/tests/consumer/main.tsx) 的 `hasUnappliedInput`、`unappliedInput` effect 与保存状态，验收时 effect 为第 146–149 行。

复现：保存图表报告 → 修改组件标题 → 点击“取消参数修改”。实际未应用标记数量已为 0，顶部仍显示“已保存到本浏览器 · 有未应用输入”；再次成功保存也不消失。

原因：保存/离开实时读取 DOM，顶部提示则使用另一份只在 `draft/inputVersion/epoch` 变化时更新的扫描结果。取消只改子组件状态，没有触发该 effect，所以两个判断产生分叉。

最小修正方向：让提示、保存和离开判断使用一致且会随输入、确认、取消及生命周期变化更新的事实。不应要求再输入一个字符才刷新，也不要为此另建通用状态管理层。

再验收：取消后立即清除提示，确认后准确显示未保存，成功保存后显示已保存；取消替换保留输入时仍显示未应用。还要覆盖源码块应用、撤销及组件切换，避免只修一个按钮。

### V03：新块命令把显式 null 静默替换成默认值（P2；A02/A10）

位置：[blocks.ts](../../plugins/render/typst/src/tiptap/blocks.ts) 的 `insertTypstTemplateBlock`，验收时为第 109–110 行。

通过真实浏览器中的原生 Editor 分别调用以下 JavaScript：

```js
editor.commands.insertTypstTemplateBlock({ template: 'channels', props: null })
editor.commands.insertTypstTemplateBlock({ template: 'channels', dataPath: null })
```

两者及相应 `can()` 都返回 `true`，实际写入节点；`props: null` 变成宿主 defaults，`dataPath: null` 变成 `[]`（完整输入绑定）。类型与现有属性 validator 并不允许这两个 null，但 `??` 在校验前消除了错误输入。

最小修正方向：仅省略或 `undefined` 使用默认值；显式非法值交给已有属性校验拒绝，不扩大类型来合理化静默回退。对应 [API 默认值规则](../../.agents/rules/library-api-design.md#should默认值省略语义与优先级可推导)：只有缺失值才应用默认，非法显式输入不能伪装成成功的另一种操作。

再验收：上述输入的命令和 `can()` 返回失败且正文/history/defaults 不变；省略参数仍正确创建独立 defaults，合法显式参数仍完全替换 defaults。无需新 validator DSL 或额外 wrapper。

### E01：完整桌面验收未得到一致通过结果（A09）

独立首次复跑使用与交接相同的 Ozone headless 参数。脚本在 `projects/report-template-studio/tests/desktop.mjs:1157` 报 `Missing language service completion formMeta`，截图显示 Monaco 的 “No suggestions”。之前的 `object` 补全、正文与候选、保存重开及真实 PDF 已完成；page errors 为空。

相同源码、相同参数原样再跑后完整通过，结果包含 22 项 passed。因此 A09 的本机完整流程已有本次通过证据，但首次失败仍保留，稳定性根因尚未确认。两次均使用 `STUDIO_DISABLE_SANDBOX=1 STUDIO_OZONE_PLATFORM=headless mise exec -- node projects/report-template-studio/tests/desktop.mjs`，仅 `STUDIO_SCREENSHOTS` 改为各自的独立证据目录。

失败断言不是本轮新增，不能仅凭这次失败归因于 Typst 重构；E01 也不与 V01–V03 并列为已确认的设计缺陷。后续需要区分语言服务、模型/光标结算与测试时序，保留原断言与首次失败证据，不用删检查、加 skip、无界重试或升级整套工具链换取通过。修正三个确定问题后的最终回归若再次失败，应定位原因并如实报告。

## 2026-10-25 验收后修正

用户在独立验收后授权清理、修正并提交推送。上一节的历史失败保留用于解释修正动机；以下为本次实际处理，不继续保留已经执行完毕的交接 prompt。

- **V01 已修正：** `ChannelParameters` 按原生实例 ID 保留每份 `ChannelTitle` 状态。选区只决定哪个表单显示输入控件，未选中实例保留待应用标记。位置变化不会把草稿串给另一个实例；明确删除实例或替换整份文档结束其局部表单生命周期。没有新增通用表单协议或第二份正文树。
- **V02 已修正：** 删除 `inputVersion` 与依赖输入事件的延迟扫描。仅观察编辑面板内的 `data-typst-unapplied` 属性和子树变化，用同一标记驱动提示与保存/离开判断，覆盖取消、应用、隐藏和卸载。观察器随宿主释放。
- **V03 已修正：** `insertTypstTemplateBlock` 仅在字段为 `undefined` 时补默认值，显式 `null` 继续进入现有属性 validator 并返回失败。单测验证 `can()`、正文、defaults、原有 undo/redo 与合法显式参数，未扩大公共类型。
- **浏览器测试释放已清理：** 本次发现上一轮直接退出 Chromium 的探针残留预览会话，触发 8 页面上限。按测试时间与证据确认自己的三个会话后，通过现有 `/session/close` 释放，随后也释放本次旧测试退出时残留的一个会话；没有重启服务或修改会话上限。四组浏览器入口和 refactor 子页面现在记录各自的 client ID，并在关闭浏览器前等待关闭接口的 204 回执，避免依赖 pagehide keepalive 的完成时序。

新增浏览器回归覆盖：两实例同时暂存、点击段落/组件/区域后恢复、未选中参数仍阻止保存、取消重开保留输入、取消其中一个实例仍保留另一个未应用提示、取消全部即时清除提示、确认与一次撤销、实例删除/撤销后的标记清理，以及源码应用/撤销后的输入状态。原来的 diagnostics、候选、IME、布局、保存和 PDF 断言保留。

源码应用/撤销用例检查原生 JSON 完整恢复与未应用提示清除；初始 raw fixture 未声明的原生默认属性可能在第一次正文 transaction 后显式出现在快照中，因此不能把原生文档相等误当成 raw 保存字节相等。正式草稿仍按实际 raw 快照判断 dirty，没有静默改写保存基线。

独立制品首次浏览器验收在首个字体切换断言处超时：控件值已改变，标题未出现对应样式 span。临时记录 DOM/原生选区与 transaction 后，完整流程通过，记录显示所选 `Editable` 正常生成样式并支持一次撤销/重做；尚不能据此确认首次失败根因。临时探针不提交，正式脚本只增强失败时的选区证据，不改动作、断言、超时或重试。首次失败位于 `isolated/`，有效排查记录位于 `isolated-trace3/`，移除临时探针后的最终脚本也完整通过（`isolated-final/`，27.11s，page errors 为空）。首次失败仍作为未解释的稳定性记录保留，不宣称已修复根因。

排查过程中还遇到 `/tmp` 容量不足与临时探针记录不可序列化对象的中断，分别保存于 `isolated-trace.log`、`isolated-trace2.log`，不计为通过；本轮独立安装目录移至磁盘缓存并保留原路径链接，所有失败证据仍可访问。

最终检查和 E01 复核结果记录于 `/tmp/pluxel-typst-fix-20261025/`，实际结果如下。

| 检查                        | 结果                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| Typst / Studio 构建         | 均通过，读取最终 dist                                                                         |
| 两包 TypeScript 检查        | 均通过                                                                                        |
| Typst 全量测试              | 17 文件、128 项通过                                                                           |
| Studio 全量测试             | 28 文件、167 项通过；原有 Windows ACL 专项在 Linux 跳过                                       |
| 四组真实浏览器检查          | 均通过，page errors 为空                                                                      |
| 独立制品安装验收            | 最终脚本通过：独立安装、严格类型、依赖隔离及完整真实浏览器/PDF 流程；保留首次字体断言超时记录 |
| Electron 完整桌面流程 / E01 | 22 组通过，含补全/悬停、PDF/ZIP 与退出清理；E01 本轮未复现                                    |
| 提交范围与检查              | 仅 Typst 重构、Studio 受影响调用方及相关文档；无关 submodule 保留                             |
