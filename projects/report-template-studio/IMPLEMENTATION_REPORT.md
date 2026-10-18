# 常驻文档服务重构实施报告

日期：2026-10-12。目标契约：[REFACTOR_DESIGN.md](REFACTOR_DESIGN.md)。重构、全部已知消费者迁移与 Linux 真实边界验收已完成；本报告供独立审核，不将未执行的平台或模型验证计为通过。[验证摘要](VALIDATION_EVIDENCE.json) 随提交保留实测回执与证据哈希；完整截图、PNG/PDF/ZIP 和日志位置记录在下文。当前公开用法由 [README](README.md#程序接入) 拥有。

## 最终架构与技术细化

所有消费者进入同一 `StudioPlugin → DocumentService → TemplateCompiler / 官方 TypstSession → ArtifactStore` 路径。没有兼容入口、双协议开关或旧编译备用链路。

| 所有者                | 最终职责与实现位置                                                                                                                                                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 业务契约              | [shared/contracts.ts](src/shared/contracts.ts)：必填 JSON data、独立 description、唯一 compile revision、二进制 preview、PNG/PDF/ZIP artifact 与结构化错误                                                                                                                                                      |
| 组合与官方生命周期    | [backend/plugin.ts](src/backend/plugin.ts)、[application.ts](src/backend/application.ts)、[runtime.ts](src/backend/runtime.ts)、[dev.ts](src/backend/dev.ts)：装配已有 Store、Fonts、Typst、Pi；官方 Host 启动/关闭与 host-vite generation 更新                                                                 |
| 文档所有权            | [backend/documents.ts](src/backend/documents.ts)：每个文档一个求值器和原生 session；按文档串行，四个活跃记录、八项等待队列、包括排队在内的 30 秒期限；只淘汰空闲 LRU，忙时明确 BUSY；共享快照借用、字体注册/open 互斥、移除/关闭结算                                                                            |
| 模板求值              | [compiler.ts](src/backend/compiler.ts)、[template-runtime.ts](src/backend/template-runtime.ts)：复用现有 Vite 模块图、QuickJS 和 `defineTypstDocument`；describe 不执行 createFiles，compile 不提取表单字段                                                                                                     |
| 产物所有权            | [backend/artifacts.ts](src/backend/artifacts.ts)：唯一目录内发布完整文件与 metadata，原子 rename，配额预留；24 小时、512 MiB、4096 个内容文件；关闭、HMR、正常重启、项目 forget、session 淘汰不提前删除已发布产物                                                                                               |
| RPC capability / 接纳 | [rpc/targets.ts](src/rpc/targets.ts)、[carrier.ts](src/rpc/carrier.ts)：显式具名方法，外部 Studio、桌面 Desktop、受信任 main 三种窄能力；generation 撤回后拒绝新调用，已接纳操作由 carrier 结算                                                                                                                 |
| 本机传输 / 发现       | [rpc/socket.ts](src/rpc/socket.ts)、[root-lock.ts](src/rpc/root-lock.ts)、[client/protocol.ts](src/client/protocol.ts)、[client/index.ts](src/client/index.ts)：认证、发现记录与当前用户权限、固定实例身份、canonical root 独占、4 字节长度帧与 32 MiB 上限、背压、连接清理；无 TCP/HTTP 业务 listener          |
| Electron 二进制       | [rpc/message-port.ts](src/rpc/message-port.ts)、[electron/main.ts](src/electron/main.ts)、[backend.ts](src/electron/backend.ts)、[preload.ts](src/electron/preload.ts)：真实 MessagePort，structured clone Uint8Array，空 transfer list 保留后端缓存；main 校验 window/frame/origin，PDF 保存仅接受 artifact id |

技术细化没有放宽目标契约：

- runtime 在官方 Host start 成功后通过当前 registry 的 `getInstance(StudioPlugin)` 获取就绪实例；开发继续使用官方 host-vite 接纳更新。carrier 独立持有 root/发现记录和连接，先撤回接纳与 target、结算操作，再关闭 Host。
- 锁定 Cap’n Web 0.12.0 的真实 Error 往返保留 code、issues、diagnostics、cause；继续使用 reject，没有新增通用结果 envelope。
- 新 exports 的 types/default 都指向构建文件。声明构建使用仅含 src 的 [tsconfig.build.json](tsconfig.build.json)，避免把测试的源码引用编译为下层包旁的新 `.d.ts`。首次 typecheck 要先 build；Windows workflow 同步顺序。
- renderer 的隔离 preload 转交底层 port，通过 `window.postMessage` 接收；main 使用另一个受信任 port 的 `resolveArtifact`，该能力不出现在外部 API 或 renderer API。保留原有 sandbox、contextIsolation、nodeIntegration 与 CSP 配置。
- 同一源码和输入的两次成功 compile 也产生不同 UUID。sourceRevision 仅标识内容，不代替编译身份；native 成功但应用发布失败会撤回旧映射，避免旧 revision 误读新 document。
- JSON 校验拒绝 undefined、非有限数、循环、类实例、accessor、稀疏数组等有损值，并检查真实 UTF-8 大小；schema 中没有缺省值的 absent optional 在校验前保持缺失。对象递归补齐，调用方数组决定长度，各已提供项可合并同索引默认项；空数组、空字符串、0、false 不被默认值覆盖。compile 从不读取或修改 InputStore。
- root 锁只在确认原 owner 已死亡后原子争用回收；没有 kill/抢占活跃进程。回收期间异常留下的 reclamation fence 保守拒绝，不声称硬崩溃时所有锁都能自动恢复。

## 公开入口与消费者迁移

[package.json](package.json) 提供四个实际构建入口：`/client`（发现/连接/withStudio）、`/contracts`（浏览器可用类型与错误判定）、`/runtime`（宿主级 startBackend/close，无 Electron）、保留唯一名称的 `/plugin`。没有业务 CLI、MCP、任意 invoke 或 agent 侧 session 生命周期。

最短完整公开消费见 [examples/inspect-report.ts](examples/inspect-report.ts)：由函数参数给出 instanceId、project root、entry 和 data，发现后精确选择，在 withStudio 内 compile → 指定末页 renderPage → exportPdf；失败输出结构化信息并停止，finally 断开连接。该示例进入 app typecheck；另外从真实发布包中导入该函数，在独立 Node 进程执行成功，末页 PNG 471388 B、PDF 110623 B，见 public-example.json（`test-results/refactor/public-example.json`）、PNG（`test-results/refactor/public-example.png`）、PDF（`test-results/refactor/public-example.pdf`） 和 复核驱动（`test-results/refactor/checks/public-example-driver.mjs`）。宿主驱动使用普通 .mjs 文件启动，避免测试用 stdin 的 --input-type 参数继承到原生 Worker；先前该探针参数错误的日志一并保留。

| 消费者 / 原功能                               | 最终方法与接线                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首页、项目选择与最近列表                      | [renderer/app.tsx](src/renderer/app.tsx)、[panes.tsx](src/renderer/panes.tsx)：listProjects/createProject/forgetProject；原生 openProject 由受校验 main 调用业务方法                                                                                                                                                                   |
| Explorer、源码保存、移动/删除、报表创建、资产 | [explorer.tsx](src/renderer/explorer.tsx)、[workspace.ts](src/renderer/workspace.ts)：getTree/readFile/writeFile/mkdir/createReport/rename/remove/putAsset；原有 expectedVersion 冲突保护                                                                                                                                              |
| 路径与全文搜索                                | [workspace-search.tsx](src/renderer/workspace-search.tsx)：具名 search；Pi search_files 仍经同一存储边界                                                                                                                                                                                                                               |
| 表单、默认值、输入持久化                      | [data-form.tsx](src/renderer/data-form.tsx)、[workspace.ts](src/renderer/workspace.ts)：describeDocument 独立加载；getInput/setInput 后显式 compile(data)，非法输入时表单仍可编辑                                                                                                                                                      |
| SVG、多页目录、双向定位、错误保留旧画面       | [preview.tsx](src/renderer/preview.tsx)、[source-navigation.ts](src/renderer/source-navigation.ts)：compile receipt 与 getPreview 分离，原 WASM/SVG 接收 Uint8Array；源码/输入/generation 与 revision 检查防止发布过期结果；真实桌面验证中修复末页跟踪和标题定位阈值                                                                   |
| PDF、ZIP、原生打开/导入/保存/显示目录         | [electron/main.ts](src/electron/main.ts)：PDF 用 artifact id 校验来源并经 dialog 复制；ZIP 二进制与原生文件对话框保留；外部程序使用 importWorkspaceFile/importAssetFile/exportWorkspaceFile                                                                                                                                            |
| Pi 编译与看图                                 | [backend/ai-tools.ts](src/backend/ai-tools.ts)：保留 compile_preview/read_preview_pages，新增 export_pdf；input 明确为 stored 或 data，同一 DocumentService/ArtifactStore；受信任 adapter 按 id 读 PNG，模型边界生成真实 image blocks；普通 read/bash 不能越出项目                                                                     |
| Pi 供应商、会话、消息、停止与引用             | [assistant.tsx](src/renderer/assistant.tsx)、[provider-settings.tsx](src/renderer/provider-settings.tsx)、[backend/ai.ts](src/backend/ai.ts)：models/providers/configureProvider/discoverModels、threads/createThread/snapshot/renameThread/deleteThread/prompt/abort 经 Desktop capability；外部 Studio capability 不含这些方法或密钥 |
| 外部 coding agent / 无桌面宿主                | 公开 client 经真实 AF_UNIX socket 认证，显式选择实例与项目，receipt + 可读文件产物；宿主一次 startBackend，消费者断连不关闭原生 session                                                                                                                                                                                                |

同步了 [README](README.md)、[新建项目 AGENTS](workspace-assets/AGENTS.md)、[typst-authoring skill](workspace-assets/.agents/skills/typst-authoring/SKILL.md)、[Typst 包文档链接](../../docs/plugins/rendering/typst.md)、开发/打包脚本和 [Windows workflow](../../.github/workflows/report-template-studio-windows.yml)。新 exports 的四组 `.mjs/.d.mts` 进入打包前检查，示例纳入 package files。添加 [.tegami/studio-resident-rpc.md](../../.tegami/studio-resident-rpc.md)；未手改版本或 publish-lock。

## 旧路径删除与数据保护

Studio 的 Elysia 注册、service/import/dependency、FetchRequest/FetchResponse、StudioBridge.fetch、studio:fetch、renderer HTTP request/status 映射、main/utility Fetch pending/id 桥、startBackend.fetch、vector number[] 回转、隐式保存输入、Pi 独立图像缓存及独立 PDF map 均已删除。其他应用的 Elysia 与供应商 `/v1` HTTP 调用保持其自身契约；Electron `net.fetch(file:)` 仍只加载生产页面资源。

旧符号搜索范围含 src、scripts、examples、tests、README、模板 AGENTS/skill；结果见 legacy-search.log（`test-results/refactor/checks/legacy-search.log`）。删除清单只作为此设计/报告的历史对照，没有可调用旧入口。`extractFormFields` 仅位于 description 路径。

开始实施时，已有改动为 `vendor/split-like-vscode` 的 submodule 指针与未跟踪的设计文档。submodule 仍为 `e60793224804dc803f4bf216083b5626029c2a80`，内部无改动；未执行 reset/clean 或重建 vendor tarball。设计仅补充状态、实施前标签和报告链接。普通项目/ZIP、recent、inputs、AI 会话与凭据存储格式保持；无需用户数据迁移，没有兼容 reader。

验证仅创建隔离临时 profile、项目和宿主，不连接用户当前 Vite/Studio 实例，不清空用户数据目录。真实 runtime 验证 forget 后源码仍在磁盘，重启和 HMR 后保存输入仍在，导出 ZIP 不包含输入/凭据/产物。测试结束清理各自的临时 profile 与搬移副本；证据副本保留在下面的 test-results。

## 检查命令与结果

基线仓库 HEAD：`a6421386f036fac836f97335cd56c307cc16efad`，实现、设计与本报告一并纳入重构提交。平台 Linux x64；pnpm 11.28.2，pnpm 脚本 Node 24.21.0，独立驱动 Node 24.16.0，Electron 44.7.0，Cap’n Web 0.12.0，原生 Typst 0.7.0。以下是实际运行结果，完整日志归档在 checks/（`test-results/refactor/checks/`）。

| 命令                                                                                                                     | 实际结果 / 日志                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @report-template-studio/app build`                                                                        | tsdown 声明与 Vite renderer 构建通过；再临时移出 dist 从零构建通过，452 个文件 SHA256 全部一致，见 clean-build.json（`test-results/refactor/clean-build.json`）、clean-build.log（`test-results/refactor/checks/clean-build.log`） |
| `pnpm --filter @report-template-studio/app typecheck`                                                                    | 通过，含公开示例；typecheck.log（`test-results/refactor/checks/typecheck.log`）                                                                                                                                                    |
| `pnpm --filter @report-template-studio/app test`                                                                         | 19 个测试文件，112/112；含真实 Typst、目录、host-vite HMR、Pi image 与真实 RPC，也含下述故障注入；tests.log（`test-results/refactor/checks/tests.log`）                                                                            |
| `pnpm --filter @pluxel/plugin-typst typecheck`                                                                           | 通过；typst-typecheck.log（`test-results/refactor/checks/typst-typecheck.log`）                                                                                                                                                    |
| `pnpm --filter @pluxel/plugin-typst test`                                                                                | linux-x64 native ready，7 个文件 56/56；typst-tests.log（`test-results/refactor/checks/typst-tests.log`）                                                                                                                          |
| `pnpm exec oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error projects/report-template-studio` | 通过；lint.log（`test-results/refactor/checks/lint.log`）                                                                                                                                                                          |
| 项目变更文件的 `oxfmt --check`、相对文档链接检查、`git diff --check`                                                     | 通过；format.log（`test-results/refactor/checks/format.log`）、documentation-links.json（`test-results/refactor/checks/documentation-links.json`）、diff-check.log（`test-results/refactor/checks/diff-check.log`）                |
| `pnpm source-declarations:check`                                                                                         | 通过，8 个显式声明，无新增源码旁生成声明；source-declarations.log（`test-results/refactor/checks/source-declarations.log`）                                                                                                        |
| `pnpm --filter @report-template-studio/app package`                                                                      | 生成完整可搬移 Linux x64 目录，依赖无符号链接，保留原生库/Worker/字体/QuickJS；package.log（`test-results/refactor/checks/package.log`）                                                                                           |
| `pnpm --filter @report-template-studio/app test:runtime`                                                                 | 公开 runtime 与两个独立 Node client 进程通过；runtime.log（`test-results/refactor/checks/runtime.log`）                                                                                                                            |
| 同一 runtime 检查，`STUDIO_APP_ROOT` 指向搬离工作区的包                                                                  | 通过；moved-runtime.log（`test-results/refactor/checks/moved-runtime.log`），证据记录实际搬移路径和包自身 client entry                                                                                                             |
| `test:desktop`，工作区生产构建与搬移生产 executable 各运行一次                                                           | 两者均通过 16 组真实桌面行为；下节两份 result.json。仅系统 dialog 选择被固定为测试临时路径                                                                                                                                         |

构建保留现有 Vite 大 chunk 提示；打包日志中有依赖 peer/deprecation 提示。它们没有导致这些检查失败，本次没有扩展为依赖升级或 renderer 分包重设计。

## 真实边界与可复核证据

### 独立进程、原生复用与本机产物

[tests/runtime.mjs](tests/runtime.mjs) 在求值公开 runtime 前开始限制 listener，只允许 socket/pipe，创建正式 production Host。[runtime-client.mjs](tests/runtime-client.mjs) 从实际 package export 在两个独立 Node 进程调用；后者没有导入 backend 源码，也没有替换 transport。发现和认证后固定实例/项目，读取/改写源码、显式 compile、读取首页/续页/末页/局部 PNG、导出 PDF、读结构化错误；两次连接使用同一 native session，旧 revision 明确冲突。每次运行读取八份外部 PNG，关闭后无 Worker/MessagePort/ServerWrap，发现记录与 root 锁清理。汇总中的残余 FSReqPromise/stdio PipeWrap 不被冒充业务连接。

| 证据                                                                                                                               | 实测值                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runtime/summary.json（`test-results/refactor/runtime/summary.json`）                                                               | 同 session `4c6e5ebd-9aed-4818-99f6-412372146f49`，native revision 2→4，三页、406 定位点；vector 218912 B、PDF 110623 B；0 TCP、2 IPC（含重启）                                                                              |
| moved-runtime/summary.json（`test-results/refactor/moved-runtime/summary.json`）                                                   | 运行目录已搬出 workspace，依赖与公开 client 来自包自身；同 session `29a631ab-4a61-43ea-bce2-bc179488928d`，native revision 2→4；重启产物保留、forget 用户文件保留、import 隔离均通过                                         |
| native-reuse.json（`test-results/refactor/native-reuse.json`） / [backend.test.ts](tests/backend.test.ts)                          | 官方 NativeCompilerClient 的真实执行观察：改 data、Typst、TypeScript/shared import，五个成功 UUID 期间只创建 1 native client / 1 Worker，session `91440e4a-7559-4166-967f-c853393e2211`；观察器调用原实现，没有替换 compiler |
| runtime/phase-1.json（`test-results/refactor/runtime/phase-1.json`）、phase-2.json（`test-results/refactor/runtime/phase-2.json`） | 包含真实 artifact 回执、外部读取及结构化 JSON/schema/路径/TypeScript/Typst/页码/裁剪/revision 失败                                                                                                                           |

代表性冷/热数据：公开 runtime 494.1/137.3 ms；搬移包 534.9/424.0 ms；native 复用观察 296.3/30.8 ms。计时不是同一负载的固定提速基准，验收依据是资源身份与文本编码删除，不宣称稳定倍数。

已用真实图片查看工具观察：搬移包 首页（`test-results/refactor/moved-runtime/phase-1-page-1.png`）、续页（`test-results/refactor/moved-runtime/phase-1-page-2.png`）、末页（`test-results/refactor/moved-runtime/phase-1-page-3.png`）、400×300 局部（`test-results/refactor/moved-runtime/phase-1-crop.png`）。中文、指标表、公式、静态图、36 行项目表和页码可读；裁剪符合请求区域。PDF 见 phase-1.pdf（`test-results/refactor/moved-runtime/phase-1.pdf`）。第二轮对应 phase-2 文件保存源码修改后的输出。

### Electron 与 UI

工作区验收：refactor-desktop-10/result.json（`test-results/refactor-desktop-10/result.json`） 和 port-evidence.json（`test-results/refactor-desktop-10/port-evidence.json`）。搬移 executable 验收：refactor-packaged-desktop-01/result.json（`test-results/refactor-packaged-desktop-01/result.json`） 和 port-evidence.json（`test-results/refactor-packaged-desktop-01/port-evidence.json`）；它记录包外路径及包内公开 client。

真实 renderer→utility MessagePort 返回 218912 B Uint8Array。修改第一次接收副本后再次读取两次，内容一致，后端缓存未 detach。输入/schema/TypeScript/Typst/页码/裁剪/revision 错误跨真实 port 可判定；外部 window/native sender 被拒绝，任意来源路径不能冒充 artifact id，保存取消正常返回 false，renderer 无 resolveArtifact 能力。

两轮均覆盖多页 SVG、末页/目录、双向源码定位、非法表单继续编辑并恢复、Typst 失败保留旧画面且停用旧 PDF、输入重启保留与 ZIP 排除、源码 HMR、文件 CRUD、配置损坏恢复、供应商设置/文件引用、TypeScript 补全/悬停、原生 PDF/ZIP/打开目录，未捕获 renderer 错误为零。视口 1050×994 CSS px、截图为 2×；已观察关键截图，没有空白或意外遮挡：

- 搬移包 末页与目录（`test-results/refactor-packaged-desktop-01/01-quarterly-last-page.png`）、源码联动（`test-results/refactor-packaged-desktop-01/01-quarterly-source-navigation.png`）。
- 工作区 Typst 诊断保留预览（`test-results/refactor-desktop-10/04-typst-diagnostic.png`）、schema 恢复（`test-results/refactor-desktop-10/05-schema-recovery.png`）、导入工作区（`test-results/refactor-desktop-10/06-imported-workspace.png`）。
- 搬移包原生保存的 workspace.pdf（`test-results/refactor-packaged-desktop-01/workspace.pdf`）（59154 B）、workspace.zip（`test-results/refactor-packaged-desktop-01/workspace.zip`）（41494864 B）。

此前 refactor-desktop-01…09 失败运行的日志/截图保留，未把它们计为通过；产品修复与测试探针修正后，第 10 轮和搬移包第 1 轮通过。从零构建与这两轮使用的完整 dist 452 文件一致；随后源码格式化并重建，执行文件、类型与 renderer 制品字节仍一致，仅六个 source map 更新。两次比较均记录在 clean-build.json。

### Pi image、HMR 与故障边界

[backend.test.ts](tests/backend.test.ts) 对正式业务服务创建实际 Pi 工具，compile_preview → read_preview_pages 返回三个真实 `image` block；解码字节逐个等于 trusted artifact-id 读取结果。见 pi-image-content.json（`test-results/refactor/pi-image-content.json`） 及 PNG 1（`test-results/refactor/pi-page-1.png`）、PNG 2（`test-results/refactor/pi-page-2.png`）、PNG 3（`test-results/refactor/pi-page-3.png`）（57264/279515/435184 B，附 SHA256）。非视觉模型拒绝；普通文件工具不能读取 artifacts；export_pdf 同服务生成 PDF。仅模型内容适配边界使用图片 base64，业务 receipt/vector 不使用该编码。

[rpc-dev.test.ts](tests/rpc-dev.test.ts) 编辑隔离副本的 application.name，触发真实官方 host-vite watcher、Host 替换与 generation 撤回。hmr-generation.json（`test-results/refactor/hmr-generation.json`） 记录旧连接/本地引用拒绝、instance/root/project/保存输入不变、旧 compile revision 失效、新编译成功；新 generation 通过 trusted port 恢复旧 artifact metadata，PNG/PDF 字节与 createdAt/expiresAt 完全一致。可比较 before PNG（`test-results/refactor/hmr-before.png`）/after PNG（`test-results/refactor/hmr-after.png`） 与 before PDF（`test-results/refactor/hmr-before.pdf`）/after PDF（`test-results/refactor/hmr-after.pdf`）。

另外补充的测试分别证明其实际边界，不能合并称为原生故障实测：

| 验证层                                                               | 覆盖与限制                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [documents.test.ts](tests/documents.test.ts)，10 项受控延迟/失败注入 | 忙容量、LRU、排队期限、旧/新快照并存、字体注册隔离、native 成功后发布失败撤回映射、磁盘写入中源码变更、forget 的提交闸门、关闭结算；这里原生操作是注入协作者                                                                                 |
| [artifacts.test.ts](tests/artifacts.test.ts)，6 项真实磁盘与受控故障 | 完整原子发布/重启恢复、metadata 深复制、并发字节/文件预留、配额拒绝不早删、过期/未完成清理仅自有文件、链接/外来文件保护、同时保留写入与清理失败原因；到期通过测试 policy/时间控制，无实际等待 24 小时                                        |
| [rpc.test.ts](tests/rpc.test.ts)，13 项                              | 真实 Node MessagePort/AF_UNIX 的 code/issues/diagnostics/cause 与二进制、认证与能力排除、身份变化、断连接纳任务、真实 oversized Cap’n Web 请求不执行/不重放；拆帧/UTF-8/背压测试使用受控字节流；真实 root 活 owner/确认死亡 owner 的并发回收 |
| [rpc-imports.test.ts](tests/rpc-imports.test.ts)                     | 独立进程导入已构建 public client/contracts；不求值 Electron/Pi/Vite/native，不创建 Worker 或 listener                                                                                                                                        |

## 复核方式与未验证边界

[VALIDATION_EVIDENCE.json](VALIDATION_EVIDENCE.json) 随提交保留关键实测回执、环境、原生复用与 HMR 证据、构建比较和本地证据 SHA256；其 validated snapshot 哈希对应原验收时刻，随后仅整理交付文档。完整 JSON、PNG、PDF、ZIP、原始日志位于本工作区被 gitignore 的 `test-results/`。独立审核先看提交 diff、验证摘要与可重复的 tests，再对照本地 evidence-manifest.json 的 SHA256。文中的 test-results 路径均为本地验收产物位置。JSON 中的原始 profile/artifact path 记录当时调用边界，测试清理后不承诺该临时路径仍存在；`evidencePath` 或本报告记录的本地路径对应保留下来的字节副本。目录可整体复制交给审核者。

从仓库根目录复跑：先按 README 准备依赖/native 并 build，再执行上表命令。桌面需要显示环境；本机 Flatpak 的 SUID helper 无法启用，因此本次两轮明确用了 `STUDIO_DISABLE_SANDBOX=1`，不是产品默认配置。搬移验收可将 release 整目录复制到工作区外，然后执行：

```sh
studio_project="$(pwd)/projects/report-template-studio"
# studio_moved 由审核者指定为已复制完整发布目录的绝对路径。
STUDIO_APP_ROOT="$studio_moved/resources/app" \
  STUDIO_RUNTIME_OUTPUT="$studio_project/test-results/review-runtime" \
  pnpm --filter @report-template-studio/app test:runtime
STUDIO_APP_ROOT="$studio_moved/resources/app" \
  STUDIO_EXECUTABLE="$studio_moved/pluxel-typst-studio" \
  STUDIO_SCREENSHOTS="$studio_project/test-results/review-desktop" \
  pnpm --filter @report-template-studio/app test:desktop
```

未验证项：

1. Windows named pipe、当前用户 ACL、原生 Typst 与完整 Electron GUI 的实际 Windows 运行，以及 macOS。本次提供实现并保留 Windows native/build/package/production runtime CI；验收记录时尚无 Windows CI 回执，未假称 CI 通过，Linux 证据不能替代它们。
2. 默认操作系统 sandbox 的实际启动。本次显式 --no-sandbox；renderer 的生产 webPreferences 保留并由源码核对，不等于已验证 OS sandbox。
3. 真实供应商/付费视觉模型的请求、图像接受能力和判断质量。真实 Pi image content 已验证，未发生模型生成调用。
4. 24 小时真实流逝、进程硬杀/断电时磁盘耐久性、回收 root 锁中途硬崩溃的恢复。原子发布、normal restart、受控过期/写失败/回收争用有证据；遗留 reclamation fence 会保守 ROOT_IN_USE，需要后续维护，不声称自动恢复。
5. 不共享同一文件系统/用户边界的 Flatpak、容器或跨用户部署。已验证同用户、同环境的外部进程实际读到路径；显式 discoveryDirectory 是部署选择，不能将路径回执解释为跨沙箱文件传输。
