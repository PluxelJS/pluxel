# Report Template Studio 常驻服务与 Agent 接入重构设计

> 历史设计基线（2026-10-12）。本提案保留当时的常驻服务设计，不作为 2026-10-28 源码权威迁移后的正文/输入契约；现行文件与 API 见 [README](README.md)。

当时状态：重构已实施，Linux 真实边界验收完成，待独立审核。日期：2026-10-12。最终实现位置、消费者迁移、检查结果和可复核证据见 [实施报告](IMPLEMENTATION_REPORT.md)；Windows/macOS、默认系统沙箱及真实模型调用的未验证范围也记录于该报告。评审者按文末验收矩阵检查最终 diff 与证据。当前公开用法由 [README](README.md#程序接入)、项目模板指引和相关包文档拥有。

目标是让 Electron UI、内置 Pi 和外部 coding agent 共用常驻应用的模板求值、Typst 增量编译与产物生成能力。业务接口使用普通 TypeScript 方法；跨进程调用统一使用 Cap’n Web。Electron 接收向量二进制，agent 接收应用生成的 PNG/PDF 文件引用，Pi 在模型适配边界读取图片并生成 image content。agent 不创建、关闭或持有原生编译 session。

本次采用一次性替换：最终实现删除 Studio 的 REST/Fetch 业务桥，不保留旧路由、旧客户端、兼容 alias、双协议开关或旧格式读取器。保留现有功能、模板契约与用户数据，不把删除旧实现理解为删除用户项目、表单输入或 AI 会话。

## 1 目标与范围

完成后必须能通过公开的程序入口做到：发现并选择一个正在运行的本机 Studio，选择项目与报表，提交外部数据，修改普通源码，反复编译，获取指定页或区域 PNG、导出 PDF，读取诊断并继续修正。外部 agent 不依赖 Electron 自动化、内部源码 import、隐藏 project id、临时脚本桥或 CLI 参数语法。

必须覆盖三类消费者：

| 消费者                  | 调用方式                                         | 实际接收内容                             |
| ----------------------- | ------------------------------------------------ | ---------------------------------------- |
| Electron renderer       | Cap’n Web over MessagePort                       | 编译回执、表单描述、导航、按需向量二进制 |
| 内置 Pi                 | 直接调用同一业务实现，工具层做输入和模型内容适配 | 小型文字回执、产物引用、模型可见图片     |
| 外部 agent 和 Node 程序 | Cap’n Web over 本机 IPC                          | 小型对象回执、PNG/PDF 绝对路径与元数据   |

同时保留作为库嵌入的入口：应用宿主可以在没有 Electron 的情况下启动一次后端，长期运行，结束宿主时关闭。这个生命周期入口属于宿主，不是 agent 每轮编译的推荐调用。

本次不增加 CLI、MCP server、远程多用户服务、TCP/HTTP 业务监听、通用 RPC 框架、自动视觉评分、向量差量协议、PDF 文件导入渲染器。现有 Typst 排版与 PNG 原生渲染继续复用，不引入第二个编译器或截图式 PDF 生成路径。

## 2 实施前源码与应保留的能力

本节记录实施前的来源和删除对象，其中“当前”均指重构前；不作为现行 API 教程。现行实现及必要技术细化见 [实施报告](IMPLEMENTATION_REPORT.md#最终架构与技术细化)。本文件的目标契约优先于需要删除的旧调用方式。

- [backend/plugin.ts](src/backend/plugin.ts) 当前混合 Elysia 路由、项目存储、表单输入、编译会话、字体注册、PDF 缓存和 Pi 装配。
- [backend/compiler.ts](src/backend/compiler.ts) 与 [backend/template-runtime.ts](src/backend/template-runtime.ts) 已有可保留的 Vite 模块图、QuickJS 隔离运行器和模板输入求值。
- [renderer/api.ts](src/renderer/api.ts)、[electron/preload.ts](src/electron/preload.ts)、[electron/backend.ts](src/electron/backend.ts) 当前传递模拟 HTTP 的 Request/Response，业务并没有使用已声明的 Cap’n Web 依赖。
- [Typst worker](../../plugins/render/typst/src/worker.ts) 保留 native compiler、shadow VFS 和最新成功 document；一次编译生成 vector、PDF 和 navigation。按页 PNG 来自 retained document，不再编译。
- [Typst session](../../plugins/render/typst/src/session.ts) 已拥有更新/页图队列、原生 revision、取消和释放契约。[当前用法](../../docs/plugins/rendering/typst.md) 是下层能力的依据。
- [TypstPreviewView](../../plugins/render/typst/src/browser/preview.ts) 接受完整 vector 字节，通过前端 WASM renderer 生成 SVG。当前是服务端增量编译、完整向量传输、前端 reset 后渲染；不能宣称已有前端增量补丁。
- Studio 当前把 vector `Uint8Array` 转为 `number[]` 放进 JSON，再在前端转回字节；这条转换必须删除。
- [Pi tools](src/backend/ai-tools.ts) 已有 `compile_preview` 与 `read_preview_pages`。保留这些有实际用户语义的工具名称，替换其后面的独立数据返回与编译编排。

以下能力不能因重构退化：普通目录和 `studio.json`、同名目录 TypeScript 报表发现、共享主题/字体、schema 默认值、`createFiles`、表单持久化、源码 HMR、冲突保护、双向源码定位、标题目录与分页、上次成功预览保留、工作区 ZIP、文件搜索、资产导入、系统保存/打开/显示文件、Pi 会话与供应商配置、无桌面后端运行、可搬移的生产应用。

## 3 唯一执行路径与所有权

```text
Electron renderer ── Cap’n Web / MessagePort ──┐
                                             │
外部 Node client ── Cap’n Web / local socket ──┼─ 明确的 RPC capability
                                             │            │
内置 Pi tools ────────────────────────────────┴─ 同一业务服务
                                                          │
                                  WorkspaceStore / InputStore
                                                          │
                                     DocumentService
                                      ├─ TemplateCompiler
                                      ├─ TypstSession
                                      └─ ArtifactStore
```

| 所有者                      | 责任                                                            | 不拥有                             |
| --------------------------- | --------------------------------------------------------------- | ---------------------------------- |
| StudioPlugin 与宿主 carrier | 业务组合、连接接纳、Plugin generation 生命周期                  | 第二份文档编译逻辑                 |
| WorkspaceStore              | 项目、真实源码/资产、路径验证、版本冲突、目录和 ZIP 契约        | 编译器、模型调用                   |
| InputStore                  | Studio 保存的用户输入                                           | 自动决定所有调用方的编译输入       |
| DocumentService             | 文档会话、快照、字体接线、调用编排、公开 revision、当前成功结果 | Electron、Pi SDK、HTTP、传输 codec |
| TemplateCompiler            | 同一份模块求值、默认值合并、schema 校验、虚拟文件生成           | 原生 Typst session、模型内容       |
| ArtifactStore               | PNG/PDF 写入、不可变路径、保留期限、容量、清理                  | 重新编译、解释模板数据             |
| RPC target                  | 暴露获授权的具名业务方法，转发调用                              | 缓存、路由分发器、业务规则副本     |
| Pi tool adapter             | 项目绑定、文本摘要、读产物、构造 image content                  | 独立 Typst session、独立页图缓存   |
| Electron shell              | 原生窗口、文件对话框、IPC port 接线、保存文件                   | 文档排版与任意文件读取后门         |

按业务边界抽取普通对象/类，不为这些职责各创建一个 Pluxel Plugin。保留 `StudioPlugin` 的现有 canonical export；Plugin 委托普通业务服务。`TypstPlugin`、`FontsPlugin` 仍通过现有依赖注入提供能力。不要绕过官方 NodeModules 与生命周期，私自拼 native worker 路径。

## 4 包入口与文件布局

本次保持现有应用包，不为接入增加第二个服务包或 SDK workspace。通过明确子入口实现库调用和导入隔离：

| 公开入口                                | 导出及约束                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `@report-template-studio/app/client`    | `discoverStudio`、`connectStudio`、`withStudio`、连接/发现类型。Node 客户端，只加载 Cap’n Web、Node IPC 和协议校验所需模块  |
| `@report-template-studio/app/contracts` | 公共业务类型、JSON 数据类型、可判定错误契约。浏览器可用，不加载后端、Electron、Pi、Vite 或原生 Typst                        |
| `@report-template-studio/app/runtime`   | 保留名称 `startBackend`，用于宿主一次性创建常驻后端；不 import Electron。保留已有 `root` 和 `assetsRoot` 的含义并明确文档化 |
| `@report-template-studio/app/plugin`    | 保留现有唯一 `StudioPlugin` 声明入口                                                                                        |

`startBackend()` 返回已就绪的业务入口和宿主级 `close()`；不再返回 `fetch()`。`root` 是应用状态目录，不是模板项目目录。启动时接纳本机 IPC；`close()` 关闭接纳、结算任务、回收连接、会话与临时资源。Electron、独立宿主使用同一应用声明，开发宿主沿用现有 host-vite carrier 接线。

同一个 canonical 应用状态 root 同时只允许一个宿主写入。这个准入由后端负责，不能只依赖 Electron 的窗口单实例锁；独立 runtime 与桌面重复打开同一 root 时明确拒绝并指向已有实例。不同 root 可以拥有不同实例，client 不替用户合并它们。不得通过杀进程或直接删除未确认失效的锁来取得所有权。

建议源码位置：`src/shared/` 拥有契约；`src/backend/documents.ts` 与 `artifacts.ts` 拥有对应业务；`src/rpc/` 只拥有 targets 与两种 transport；`src/client/` 拥有外部连接与发现。既有 store/compiler/runtime 文件继续承担原职责。文件名可在实施中细化，职责和入口不可重复。

为新 exports 生成真实 `.d.mts`/类型声明和构建产物，不用指向仓库源码的类型入口掩盖打包缺失。验证客户端从公开入口导入不会求值原生编译器或桌面依赖。本次承诺导入图隔离，不承诺整个应用包变成轻量独立安装包。

## 5 外部实例发现与连接

外部调用固定为本机、同用户、与应用共享文件系统。Linux/macOS 使用 Unix domain socket，Windows 使用 named pipe；不新增 TCP listener。Cap’n Web 的字符串传输适用于这条只传业务对象和路径的连接。

### 5.1 可发现的真实实例

应用启动就绪后原子发布 descriptor：`instanceId`、应用数据根、PID、平台、socket/pipe 地址、协议版本和认证所需随机凭据。每次进程重启生成新的 instanceId/凭据。项目列表通过连接后的 `listProjects()` 查询，不让 descriptor 的过期副本成为项目权威。

默认 discovery 位置固定为系统临时目录下 `pluxel-report-template-studio-<userKey>/instances`，userKey 从当前 OS 用户身份确定，client 与应用使用同一解析函数；不能让不同用户争用同一个私有目录。支持调用方显式提供 `discoveryDirectory` 以适应 Flatpak/容器文件系统隔离。目录与凭据必须限制为当前用户可读写；Windows 使用当前用户权限边界，不把 POSIX chmod 当成 Windows 权限证明。Unix socket 路径另用短私有目录，避免路径长度限制。

`discoverStudio({ discoveryDirectory? })` 只读发现记录并做有界握手校验，返回可连接实例，不创建应用、不导入项目、不改模板文件。返回列表不含凭据；凭据由 client 从受保护 descriptor 内部读取。失效记录不冒充在线实例。多个实例由调用者选择，不能自动挑第一个或偷偷启动新后端。

`connectStudio(instance)` 必须重新验证实例身份并完成认证才 resolve。重启或 descriptor 身份变化要求重新发现；不把连接静默切到另一个进程。认证失败不暴露任何业务 capability。应用退出仅删除自己 instanceId 对应的登记。

### 5.2 连接不是编译会话

`connectStudio()` 返回 `{ api, disconnect() }`，供长期脚本或集成层复用。`disconnect()` 只释放 RPC 引用和 socket，不关闭应用或文档 session。

`withStudio(instance, callback)` 是短程序的推荐入口：完成认证后提供相同 API，等待 callback 结束并在 finally 释放连接。它拥有真实的连接清理职责，不重写方法、错误或返回值，不是另一套业务 SDK。禁止 auto-start、自动重试业务写入、进程退出 hook 或靠 GC 释放来掩盖泄漏。

短程序每轮可以重连；应用持有的 TemplateRuntime、Typst Worker 和 memoized 计算跨连接保留。连接结束不把已接纳的编译强制 abort。外部 agent 不需要 `report.close()`、`session.dispose()` 或每次编译后的应用关闭代码。

### 5.3 本机 transport

用 `RpcSession` 与自定义 `RpcTransport` 连接 socket/pipe。字节流使用固定 4 字节大端长度前缀 + UTF-8 Cap’n Web 字符串消息，处理拆包、粘包、背压、关闭和错误；不要自创 JSON-RPC 的 method/params 协议，也不要通过通用 `invoke(name, args)` 分发业务。

消息上限以当前 Cap’n Web 支持的 limits 与业务输入约束统一配置；初始上限采用 32 MiB，在分配完整 frame 前检查。对 source/data 的验证要计算真实编码大小，超过上限明确失败，不能分片丢字段或把 64 MiB 工作区资产承诺误当成外部文本 RPC 单消息承诺。外部资产/ZIP 导入使用显式本机文件导入方法，读取范围与现有导入限制相同，不把大文件塞入字符串传输。

这不是开发控制台协议。开发控制台继续负责框架维护与在线诊断；产品 RPC 是发布版也支持的文档操作入口。验收用隔离启动的真实常驻后端检查外部调用，不以隔离测试冒充用户当前在线状态。

## 6 Electron 的二进制路径

主进程校验 renderer 的 window、frame 与 origin 后，用 `MessageChannelMain` 为 renderer 和 utility process 接通专用 port。renderer 侧使用 Cap’n Web 的 MessagePort 支持；Electron 的 Node 事件式 port 只适配到同一个 transport 契约，不向 renderer 暴露整个 ipcRenderer。主进程只负责接线与原生能力，不做每个业务方法的手写转发。

选择 `encodingLevel: 'structuredClonable'`，确保 vector 仍是 `Uint8Array`。禁止 vector 的 `Array.from`、JSON.stringify、Base64 和跨 contextBridge 传递 RPC Proxy。若预加载隔离世界需要转交 port，使用 Electron 支持的 port 转交机制，并验证真实 renderer→utility 往返。

结构化克隆不等于零拷贝。本次先保证无文本编码放大，不强行转移仍被后端缓存持有的 ArrayBuffer；转移会 detach 所有者 buffer，必须有独立所有权证据才能引入。

`getPreview({ projectId, entry, revision })` 返回当前版本的完整 `TypstPreview`、匹配的源码版本信息。保留 `format: 'vector'`、实际 compilerVersion、sessionId、原生 revision 与 navigation 的真实含义。UI 继续使用 TypstPreviewView/WASM→SVG，不改成 PNG 预览，也不从 PDF 反向生成 UI。

UI 的 generation 检查、候选渲染成功后替换、失败保留旧画面、双向源码定位与草稿禁用过期定位继续保留。新的 `compile()` 回执和 `getPreview()` 是两次读取；版本竞争按第 9 节处理，不能把后来的其他输入预览塞给旧回执。

原生打开/导入/保存/显示文件仍由 Electron shell 拥有。需要从产物保存 PDF 时，renderer 传经过验证的 artifact id 与建议文件名，由主进程/后端解析其真实路径后复制到用户选择位置；不让 renderer 请求复制任意绝对路径。文件对话框取消仍是正常结果。源码与业务 RPC 全部从旧 Fetch 桥迁出。

## 7 业务接口与输入

RPC 只暴露窄的 `RpcTarget`，不直接发布拥有全部内部方法的 StudioPlugin、WorkspaceStore 或 DocumentService 实例。外部 agent capability 不包含供应商凭据配置、Pi 模型付费调用、应用关闭或任意系统文件读取。桌面 capability 可增加现有 UI 需要的供应商/会话管理、二进制预览方法；共有方法必须委托同一个实现。

### 7.1 文档核心契约

下面是目标接口骨架，实施时补齐已有字段与准确类型，不应增加同义入口。`JsonObject` 是递归 JSON 值对象；类型约束与运行时验证均拒绝非 JSON 值、循环、非有限数字和超限输入，不用 JSON round-trip 静默丢失内容。

```ts
interface DocumentTarget {
	projectId: string
	entry: string // 工作区相对 POSIX 路径，folder/folder.ts
}

interface CompileRequest extends DocumentTarget {
	data: JsonObject // 必填；{} 明确请求 schema 默认值
}

interface CompileResult extends DocumentTarget {
	revision: string // 应用生成的不透明编译身份
	sourceRevision: string
	name: string
	template: string
	data: JsonObject // 实际校验/转换后的输入
	pageCount: number
	pages: readonly TypstPage[] // 1-based，宽高单位 pt
	outline: readonly TypstOutlineItem[]
	diagnostics: readonly TypstDiagnostic[]
	elapsedMs: number
}

interface RevisionTarget extends DocumentTarget {
	revision: string
}

interface RenderPageRequest extends RevisionTarget {
	page: number // 1-based 正整数
	scale?: number // 与官方 renderPage 相同：默认 2，pixels / pt
	region?: TypstRegion // 页面局部 pt；省略为整页
}

interface PreviewResult extends RevisionTarget {
	sourceRevision: string
	sourceVersions: Readonly<Record<string, string>>
	preview: TypstPreview // 官方完整类型，data 为 Uint8Array
}

interface StudioApi {
	compile(input: CompileRequest): Promise<CompileResult>
	renderPage(input: RenderPageRequest): Promise<PageArtifact>
	exportPdf(input: RevisionTarget): Promise<PdfArtifact>
	// 另包含项目/文件/输入/描述方法，见下一节。
}

interface DesktopApi extends StudioApi {
	getPreview(input: RevisionTarget): Promise<PreviewResult>
	// 另包含现有桌面供应商/会话管理方法。
}
```

继续使用官方 `TypstRegion`、`TypstPage`、`TypstDiagnostic` 等真实类型，不重复发明坐标、诊断或 PNG 参数协议。`CompileResult` 不含向量字节、PNG 字节、PDF 字节、Form FieldNode 或完整源码定位点；不把 UI 专属描述放进每个 agent 编译回执。结构化结果可以完整返回，Pi 工具文本摘要再按模型预算裁剪并报告截断。

所有传输输入在业务接纳边界校验。直接调用与 RPC 调用经过相同验证，不为 Pi 设置绕过规则。`AbortSignal` 不作为 RPC 参数；内部宿主仍可传递它给官方 Typst。外部首版采用应用操作 deadline 与断连不取消语义，不增加 job/operation registry 来模拟尚未需要的远程取消。

### 7.2 项目文件与现有 UI 方法

从当前路由逐项迁移为有类型的具名方法。以下是迁移覆盖表，不保留路径字符串作为业务接口：

| 领域         | 必须覆盖的动作                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 项目         | listProjects、getProject、createProject、openProject、forgetProject、getTree                                                     |
| 源码         | readFile、writeFile、mkdir、createReport、rename、remove、search                                                                 |
| 输入         | getInput、setInput；存储键与当前目录不变                                                                                         |
| 文档描述     | describeDocument：返回 schema 对应 fields/defaults、描述来源版本，数据不合法时表单仍可展示                                       |
| 资产与 ZIP   | 保留现有完整导入/导出、限额和失败清理；桌面使用二进制，外部程序使用显式本机文件来源/产物路径                                     |
| 桌面 Pi 管理 | models、providers、configureProvider、discoverModels、threads、createThread、snapshot、renameThread、deleteThread、prompt、abort |

已有方法名可按真实上下文保留；不能为了迁移另做 `/api/…` 到方法名的兼容表。相同 store 操作只维护一个实现。外部文件写入继续接受 `expectedVersion`，创建文件必须显式表达不存在前提；不能因 agent 是本机调用而取消冲突保护。

本机导入文件是明确的文件读取能力，限定于导入动作并检查大小/文件类型；不要添加 `readAnyFile()`。桌面与外部文件内容的交付不同，不代表底层存储验证可以重复实现。

### 7.3 输入只有一个决策点

`compile.data` 必填：省略即拒绝。调用者传 `{}` 使用默认值；显式值保留空字符串、0、false、null 的真实校验语义。默认值合并固定为当前实现的含义：对象递归补齐缺失键；调用方提供数组时以该数组的长度和项为准，不追加默认数组的剩余项，但每个提供的项仍递归合并同一索引的默认值；显式空数组保持为空。以既有测试加真实输入验收固定这些行为，不把“数组覆盖”误实现成另一套算法。

UI 先读取或保存 InputStore，再把本轮实际输入传给 compile。Pi 的 `compile_preview` 提供明确的 `input` 判别参数：`{ kind: 'stored' }` 或 `{ kind: 'data', data }`，两者必选其一；适配层解析 stored 后调用同一个 compile。外部程序使用 getInput 后显式传值，或直接传业务数据。任何一次编译都不隐式写入 InputStore。

表单字段提取从编译必经路径拆出，放在同一受限模块运行器的 describe 操作中，不在 Node 任意执行报表模块。`describeDocument` 不执行 createFiles。业务求值的默认值合并、schema 校验和 createFiles 只保留一份实现；模板继续允许既有 Valibot/valibot-form 元数据 import，但纯原生 Valibot 模板编译不必执行字段提取。

TypeScript 入口、Typst 源码、共享资源和字体的现有格式不改。`/inputs/` 仍为编译虚拟命名空间；不为外部 agent 在模板目录里生成 data.json 或应用连接配置。

## 8 常驻会话与增量编译

DocumentService 以规范化后的项目身份和 entry 为唯一会话键，内部生成 key，不要求调用者手拼。缓存 TemplateRuntime、TypstSession、字体快照和当前成功结果；RPC target 与 socket 不拥有它们。TemplateCompiler 的内部缓存须服从这个所有者：不能保留一个独立的 FIFO 淘汰器，在另一文档正在 evaluate/describe 时关闭它的 runtime。每个文档记录统一拥有求值器与可选的原生 session，describe 与 compile 共享这份记录及接纳规则。

操作沿一条路径执行：验证输入→取得稳定源码/资产快照→求值和 schema 校验→取得/复用 session→`session.update({ files, template? })`→构造回执。源码变化提交完整模板替换，底层负责 shadow VFS delta 与 memoization；纯数据变化不重新加载字体或复制模板。

物化源码快照按项目 revision 不可变；借用快照的 evaluate/open/update 操作完成前不得删除目录。项目中两个报表同时编译时，新 revision 替换项目缓存只撤销缓存引用，不能立即删除仍被另一个操作读取的旧目录。按实际借用寿命清理快照；不要沿用旧全局队列下“替换缓存就 rm(previous.root)”的假设。原生 session 已拥有自己的模板副本时无需无限保留应用侧旧快照。

保留有界会话容量，初始沿用 4 个文档的现有上限，并与 TypstPlugin.maxSessions 对齐。忙会话不能被淘汰；无空闲容量时返回 BUSY。空闲会话按实际最近使用顺序回收，不能称作 LRU 却只按最早插入回收。容量回收和后端 generation 替换可以结束会话，普通 RPC 断开不能。

字体变化必须释放旧 session 后按官方契约重建，应用负责此过程。字体注册与 open 的快照阶段使用短的共享互斥保护，防止多个项目临时注册污染 FontsPlugin 的全局快照；注册 cleanup 在所有成功/失败路径结算。普通编译/图片操作按文档串行，项目移除等待该项目在途任务，不能继续依赖一个阻塞所有项目的全局 Promise 队列。

复用 TypstSession 的原生队列；DocumentService 的文档级接纳仅用于让源码快照、求值、update 与输出版本判断成为有序操作，不另建通用调度框架。并发队列有上限并把排队时间计入 deadline，沿用实际官方配置，不让应用外层形成无界队列。

普通 COMPILE_FAILED 保留可用 session 与上一份成功预览，但本次明确失败。超时/取消/原生退出按官方契约结算；已关闭 session 不继续调用，下一次显式 compile 可以建立新 session。字体、会话重建等事实写入现有诊断日志，不返回伪造的连续 native revision。

应用关闭顺序是停止接纳→结算/取消在途任务→回收文档 runtime 和 worker→释放快照及连接→撤销发现记录。Backend HMR 属于 generation 替换，允许清理原生会话；模板源码 HMR 则应保留 compiler。两者不能混淆。

## 9 Revision 与并发

公开 revision 使用每次成功编译的唯一不透明字符串，例如 UUID；不能继续仅用 workspace+data hash 冒充编译身份。哈希可用于内容比较，但同内容重编译、字体变化、session 重建和应用重启都不能使旧引用被误认为新编译结果。

映射关系由 DocumentService 持有：公开 revision→实际 session/native revision、源码快照、输入及对应结果。调用者只消费公开 revision；getPreview 内部仍保持 TypstPreview 要求的真实 sessionId/native revision。

native update 成功与应用发布回执是两个阶段。如果 native 已替换 document，但后续快照检查或回执构造失败，必须撤销已不再可读的旧原生映射，报告本次失败；不能仍把旧公开 revision 指向已被替换的 native document。已经送给 UI 的旧 SVG/字节可以继续展示，已发布磁盘产物也继续有效。只有 native 确实保留旧 document 的失败，才继续保留它的可读映射。

本次只保留每个文档最新成功的原生 document，不承诺任意历史 revision 可重新渲染：

1. compile 成功后，新的当前 revision 替换旧原生结果。
2. getPreview/renderPage/exportPdf 在文档队列内校验指定 revision，只使用那一次成功结果，绝不以 latest 替代。
3. 源码/字体在编译后变化时，新的预览/页图/PDF 请求报告 REVISION_CONFLICT；UI 可以保留已收到的旧画面，但关闭过期源码定位。生成过程中外部改动也要检查，未发布产物删除后报冲突。
4. 更改 InputStore 不改变已经显式传入 compile 的数据快照；UI 用自己的输入版本判断其画面是否仍适合展示。删除旧实现里“任何 storedInput 改动都使外部显式 data 产物失效”的隐含绑定。
5. 多客户端 A compile→B compile→A renderPage 的结果是 A 明确收到 REVISION_CONFLICT。不会串图，不创建每个连接一套 session，不偷偷重编译 A。调用者决定何时重新 compile；库不无限重试。
6. 已落盘并返回的产物是那一版的不可变证据，不因后续 compile、源码编辑、session 淘汰或项目移除而改写。其读取寿命由 ArtifactStore 决定。

快照读取期间外部编辑不受进程内 mutex 保护；使用现有文件版本/内容检查，在 materialize 的前后验证源快照一致性，冲突明确失败。不能仅持有内存队列就宣称获得操作系统级目录快照。

UI 只展示它自己的输入对应的回执与预览，不把另一个 agent 的 compile 自动当作表单修改。遇到 getPreview 版本竞争保留上次画面并提示更新；只在用户/源码/数据的实际后续触发下重新编译，不启动无界争抢循环。高并发历史预览需求不属于此次实现。

## 10 产物契约与寿命

```ts
interface Artifact {
	id: string
	projectId: string
	entry: string
	revision: string
	path: string // 本机可读取的绝对路径，写入已完成
	byteLength: number
	createdAt: string // ISO 时间
	expiresAt: string // 在此时间之前应用不会主动清理
}

interface PdfArtifact extends Artifact {
	kind: 'pdf'
	mimeType: 'application/pdf'
}

interface PageArtifact extends Artifact {
	kind: 'png'
	mimeType: 'image/png'
	page: number
	width: number // 实际像素，不承诺与请求比例恰好整除
	height: number
	region: TypstRegion // 原生 renderer 返回的实际对齐区域，pt
	headings: readonly TypstOutlineItem[]
	sources: readonly { path: string; fromLine: number; toLine: number }[]
}
```

路径是有意提供给本机消费者的访问契约，不是让调用方解析目录结构的协议。产物不含 Base64、number[]、Uint8Array、可执行内容句柄或任意原生对象。

`renderPage` 沿用官方 scale/region/页码验证及内存上限，应用可以收紧输出字节限额，但不能悄悄缩图。Pi 的 maxDimensionPx 模型预算由工具层换算成明确 scale，返回实际尺寸；批量工具逐页调用，页数/总图片字节限制属于 Pi 模型适配，不限制外部程序只能访问前三页。

`exportPdf` 调用当前 session.exportPdf(nativeRevision)，不重新编译；`renderPage` 同样只渲染 retained document。两者写文件成功才返回，不能把“已接纳”描述成“路径已就绪”。

产物写到应用状态目录的 `artifacts/`，不放入模板工作区、不进入 ZIP、不进入源码 watcher。使用随机 artifact id 创建独立目录，临时文件完整写入后原子发布；任何失败不得返回半文件路径。同一 revision 的重复导出允许返回同一仍有效的文件引用，不得覆盖旧内容或隐式延长已公布的清理规则。

初始保留策略固定为生成后至少 24 小时、总容量 512 MiB、最多 4096 个已发布文件。这是本次选择的默认产品策略，不是既有实现或性能结论。实现只在一个配置所有者维护它们，并在公开文档说明；不要为每个调用暴露 TTL 参数。并发写入计入容量预留，目录计数与磁盘字节都受约束。容量满时只清理已过期产物；仍不足返回 LIMIT_EXCEEDED，不能提前删除承诺期内文件。

expiresAt 前，正常关闭、重启、Backend HMR、项目忘记/移除都不主动删除已发布产物；应用启动加载自己的产物 metadata 并清理过期文件/未完成临时文件，不重新编译。这是当前产物存储契约，不是旧版本兼容 reader。元数据与文件发布必须能恢复一致状态，扫描不能跟随恶意符号链接或删除非自有路径。

expiresAt 后路径可能仍存在，但不保证可读。需要长期保留的消费者复制 PDF/PNG 到自己的输出目录。应用 profile 被用户删除、磁盘故障等外部破坏不属于保留保证。外部 client 的路径必须在实际 agent 运行环境中可读；Flatpak/容器不共享目录时明确报告部署限制，不能返回客户端不可见路径并宣称接入成功。

## 11 Pi 接入

Pi 与外部 agent 的文档方法共用 DocumentService，不能把 Pi 工具本身当成编译服务。保留项目绑定、read/edit/write/find/ls/search_files 和受限 bash 的既有权限边界。

`compile_preview` 调用唯一 compile，按第 7 节显式选择输入，返回摘要、revision、页数、尺寸、标题、诊断。它不返回全量向量或把 PDF 编码进文本。

`read_preview_pages` 使用同一 renderPage 产物，服务返回后由受信任工具 adapter 按 artifact id 验证并读取 PNG，向模型返回 image content 和对应文本元数据。模型能力检查继续保留。image content 的 Base64 仅存在于 Pi/模型 SDK 要求的边界，不进入公共 RPC/Artifact 类型，也不写入源文件。不要把只返回 PNG 路径字符串当作 Pi 已看见图片的验收。

Pi 的产物读取权限只授予受信任 adapter；模型可调用的普通 read/bash 工具仍限定在模板 workspace，不为读取 artifacts 放宽到整个应用数据目录。AI 凭据和其他会话仍不可读。

增加 Pi 的 PDF 导出工具，委托同一 exportPdf 并返回产物信息；不复制 Electron 的下载路径。Pi 工具调用由原有会话生命周期管理，停止模型生成不意味着强制终止所有消费者共享的编译器。已接纳的有界文档调用可完成，取消的 Pi turn 不发布迟到工具结果；应用关闭仍按官方取消/清理契约处理。

## 12 错误与生命周期反馈

延续异常/reject 风格，不引入第二套通用 Result envelope。保留原生 Typst error code 与 cause 的含义；Studio 只为自己的输入、项目、版本与产物边界增加必要 code。

公共错误字段至少支持：`code`、`message`、可选 `diagnostics`、可选结构化 `issues`（字段路径、规则、message）、必要的项目/entry/revision 信息。compile 输入不合法时 UI 仍可通过 describeDocument 展示字段，不要求错误回包携带旧 fields。不要把 Valibot issues 仅 join 成字符串。

使用普通可序列化字段承载诊断，不依赖跨 RPC 保留自定义 class prototype 或客户端 `instanceof ServerError`。可保留客户端错误判定 helper，但不能包装所有原生错误丢失 code/cause。当前锁定 Cap’n Web 的错误序列化能力以实测为准；检验自有字段在 MessagePort 和 socket 两条真实边界往返，不只测试本地 throw。

| 情况                      | 必须可观察的反馈                                      |
| ------------------------- | ----------------------------------------------------- |
| JSON/schema/路径/页码非法 | 稳定输入错误与字段/源码位置，不修改状态               |
| Typst 编译失败            | COMPILE_FAILED 和原生 diagnostics，上一成功画面可保留 |
| 输出 revision 失效        | REVISION_CONFLICT，说明需显式重新编译                 |
| 资源/产物额度不足         | BUSY 或 LIMIT_EXCEEDED，不能伪装成空结果              |
| backend generation 撤回   | BACKEND_UNAVAILABLE/CLOSED，不调用已失效对象          |
| socket 中断               | client reject；已接纳写入可能已完成，禁止自动重放     |
| 产物写入失败              | IO 原因保留，不返回可用路径                           |

凭据、供应商密钥、无关用户数据不进入发现输出、诊断或日志；编译源码位置与用户主动请求的本机产物路径可正常返回。未知异常保留本地 cause，传输按项目错误边界提供可用信息。

开发 carrier 在 HMR attach/detach 时明确撤回旧 target，断开受影响连接或使调用失败；重新连接仍要验证当前实例身份。应用进程常驻不代表 Plugin generation 永远有效，不用自动重试写入掩盖替换。

## 13 必须删除的旧路径

下列项目是完成条件，不是保留过渡层的建议：

| 删除对象                                                               | 最终替代                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------- |
| StudioPlugin 中所有 `/api/…` Elysia 注册                               | 具名业务方法 + RPC targets                        |
| Studio 专属 Elysia service/import/dependency                           | 新业务路径不需要 HTTP；仓库其他应用的 Elysia 不动 |
| `FetchRequest`、`FetchResponse`、`StudioBridge.fetch`、`studio:fetch`  | MessagePort Cap’n Web                             |
| renderer `request(path)` / `api<T>(path)` 与 ApiError HTTP status 映射 | 准确的 RPC client 与错误契约                      |
| 主进程/utility process 的 Fetch id/pending/request 路由桥              | port 接线与 RPC session 所有权                    |
| `startBackend().fetch`、开发 carrier 的 Fetch handler                  | 就绪业务入口和 RPC carrier                        |
| CompileResult 中 vector `number[]` 与回转 Uint8Array                   | 独立二进制 getPreview                             |
| 编译隐式读取 stored input、storedInput 绑定的显式 data 失效            | 必填 data 与独立 UI 输入持久化                    |
| 编译必经的 extractFormFields                                           | describeDocument                                  |
| Pi 专属编译/图像缓存、以字节为公共回执的 readPreviewPages              | 同一 DocumentService + ArtifactStore + Pi adapter |
| Studio 中重复持有的独立 PDF map/重复版本权威                           | 官方 session 当前结果 + ArtifactStore 已导出文件  |
| 仅凭内容 hash 的公开编译 revision                                      | 唯一编译身份，源码 hash 保留为内容版本            |
| 依赖旧 REST 路径、number[]、HTTP status 的测试和文档                   | 真实 RPC 与消费者验收                             |

保留 `read_preview_pages` 和 `compile_preview` 工具名称、官方 TypstSession 名称、模板入口格式，不为“清理旧设计”无意义地重命名。现有纯文件版本/输入存储算法只在新契约确实要求时调整。保留项目 ZIP 和本地用户数据格式，不添加 dual reader 或清空数据重建。

删除后搜索旧符号、旧 URI、旧入口与文档链接，检查 `workspace-assets/AGENTS.md`、附带 typst-authoring skill、生产打包文件清单和 Windows workflow。产品来源和模板生成入口均必须更新；不要只更新仓库 README 而让新建项目仍建议旧工具。

## 14 最短公开消费示例

下面是目标 API 用法示例，交付时必须成为从真实 package exports 可执行、可类型检查的示例。不要只把此片段保留为未经验证的伪代码。

```ts
import { discoverStudio, withStudio } from '@report-template-studio/app/client'

const instances = await discoverStudio()
// 固定用户选择的实例；不要以 instances[0] 代替选择。
const instance = instances.find((item) => item.instanceId === selectedInstanceId)
if (!instance) throw new Error('所选 Studio 实例不可用，请重新发现')

await withStudio(instance, async (studio) => {
	const projects = await studio.listProjects()
	const project = projects.find((item) => item.root === selectedProjectRoot)
	if (!project) throw new Error('请先明确选择或打开目标项目')

	const target = { projectId: project.id, entry: '报表/季度经营分析/季度经营分析.ts' }
	const compiled = await studio.compile({ ...target, data: {} })
	const page = await studio.renderPage({
		...target,
		revision: compiled.revision,
		page: compiled.pageCount,
		scale: 2,
	})
	const pdf = await studio.exportPdf({ ...target, revision: compiled.revision })
	console.log({ revision: compiled.revision, page, pdf })
})
```

`selectedInstanceId` 与 `selectedProjectRoot` 是调用者显式选择的参数，完整可执行示例必须展示其来源，例如调用脚本导出函数的参数；不得通过新增业务 CLI 解析器补齐。失败时打印结构化错误并停止本轮，不能无条件捕获后继续导出。

图片路径交给外部 agent 的 view-image 能力；下一轮修改源码后重复 compile/render。Pi 则由工具适配器完成图片读取，操作过程不需要模型自行写临时 Node bridge。

## 15 实施顺序

顺序用于尽早验证关键边界，最终只能保留一条业务路线。

1. 记录当前工作区改动和受影响文件，阅读项目 AGENTS、[API 规则](../../.agents/rules/library-api-design.md) 与适用开发文档。工作区已有大量未提交改动，禁止 reset/clean/覆盖用户修改。先列出当前路由到目标方法的覆盖清单。
2. 定义 contracts 与 DocumentService/ArtifactStore 所有权，抽出既有编译实现，不另造编译器。固定 data、revision、诊断和产物寿命。
3. 做一个真实边界验证：公开 client→本机 socket→常驻后端→现有季度经营分析→PNG/PDF 文件→客户端读取；另外用真实 Electron MessagePort 验证 Uint8Array 向量进入现有 SVG renderer。验证失败先修复边界，不扩展通用 transport 框架。
4. 迁移全部 Studio 业务路由、Electron 原生交互、UI 编译/表单/预览/保存与 Pi 工具；复用同一服务。同步移除旧 Fetch/REST 路径，不留下最终 fallback。
5. 完成发现、断连、HMR、会话容量、跨项目字体、产物重启保留等边界与针对性回归。
6. 更新 exports、类型声明、构建/打包、生产 runtime 测试、Windows 路径、项目 README 与模板 AGENTS/skill。公开包发生用户可见变化时按仓库要求增加有包 bump 与标题的 `.tegami`；文档本身不需要空 changelog。
7. 按下一节完成验证，检查最终旧符号搜索和 diff，交付实施报告供独立审核。

若某项上游行为与本设计技术前提冲突，先用最小真实复现定位，再在本文件修改受影响决定及理由，使设计与实现同步。不能为赶进度回退 REST、引入第二套编译路线、静默放弃 Windows、取消资源隔离或把验收门槛改成 mock 通过。普通文件布局和私有 helper 取舍由实施者判断，不需要逐项询问用户。

## 16 验收矩阵

测试按真实边界组织。优先复用现有测试，移除只保护旧机制的断言，不能通过删掉用户行为断言让迁移过关。

| 必须证明的结果       | 最少证据                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 外部可发现与程序调用 | 从已构建公开 client export 在另一个 Node 进程发现、认证、选择项目、编译与输出；不导入内部源码、不替换真实 transport                               |
| 无桌面运行与库入口   | 公开 runtime 启动一个长期 Host，外部脚本多次连接操作；不加载 Electron，关闭后无 worker/socket/发现记录泄漏                                        |
| 真正复用增量编译     | 同 entry 连续改数据、改 Typst、改 TS/shared import 三轮；通过测试层观察 native compiler/Worker 创建次数或身份，证明未每轮重建；只断言结果相等不够 |
| 连接与 session 分离  | 第一个 client 编译后断开，第二个 client 继续更新，原生会话仍被复用；后台处理不因断连误 abort                                                      |
| Electron 二进制      | 真实 renderer→utility MessagePort 往返 Uint8Array，内容一致且 backend 缓存未 detach；无 number[]/Base64/JSON vector 中转                          |
| UI 可用              | 真实多页 SVG、翻页/目录、源码双向定位、错误保留旧画面、表单非法输入仍可编辑、PDF 保存；截图检查无空白/布局退化                                    |
| 外部 agent 看图      | 生成首页、续页、末页与局部裁剪，外部进程读到 PNG；使用真实图片查看工具观察内容，PNG magic bytes 不足以证明可用                                    |
| Pi 看图              | Pi 工具返回真实 image content，与同一 artifact 的 PNG 一致；非视觉模型拒绝，不能只有路径文字或 mock 图片                                          |
| 显式数据             | UI saved input、Pi stored/data、外部 data 使用同一合并/校验；compile 不改 InputStore；空串/0/false/数组/必填缺失有实际覆盖                        |
| 诊断往返             | TypeScript 语法、schema、Typst 语法、错误页码/裁剪、版本冲突在 socket 与 MessagePort 都可程序判定并定位                                           |
| 并发不会串版本       | A compile→B compile→A 读图明确冲突；独立项目不会串数据/字体；源文件在渲染时变化拒绝发布混合结果                                                   |
| 产物寿命             | 路径返回时完整、唯一、不被覆盖；重编译、session 淘汰、项目 forget、正常重启不提前删除；到期清理只影响自有文件                                     |
| 有界资源             | 忙会话不被淘汰、queue/capacity 满明确拒绝；产物 quota 满不提前删承诺文件；并发写入预留不突破限额                                                  |
| 权限与暴露面         | 无凭据连接失败；外部 API 无供应商密钥/任意文件读取/应用 shutdown；普通 Pi 文件工具不能读取应用 artifacts 或凭据                                   |
| 构建与部署           | app/typst 相关 typecheck 和测试通过，真实 build 与 production runtime smoke；从搬离 workspace 的应用产物及公开 client 入口验证                    |
| 跨平台               | Linux Unix socket 与 Windows named pipe 的真实进程测试；Electron port 与原生 Typst 的 Windows 现有 CI/打包验收不能被删除                          |
| 无旧兼容             | 第 13 节旧符号在运行源码/现行教程中消失；残留只允许此设计里的删除清单和明确的历史记录                                                             |

现有 `tests/runtime.mjs` 通过拦截全部 `net.Server.listen` 验证无监听，这会误伤新的本机 socket。将断言精确改为“没有 TCP/HTTP 业务 listener，仅允许本设计的本机 IPC”，仍检查导入期/启动期；不要简单删除该边界。开发 renderer 的 Vite HTTP 仍是现有例外。

性能验收只要求证实复用与移除多余文本编码，记录代表性冷/热运行和产物字节即可；不以一次测量宣称固定倍数提速。无法执行的 Windows、GUI 或真实模型调用必须列为未验证项，不能写成通过。Pi 模型内容适配可不发生付费模型调用，但不能声称因此已经完成模型视觉质量评估。

为新并发边界补充最小回归：同项目两个文档分别借用新旧快照时旧目录仍可读；一个文档 evaluate/describe 在途时不会被另一文档的容量回收关闭；native 更新成功但应用发布失败时旧 revision 不会误读新 document。

## 17 交付与审核材料

实施完成时提供一份项目内实施报告，包含：最终架构与本设计的必要差异、公开入口与最短调用、旧路径删除结果、检查命令及结果、外部进程调用证据、UI 截图/PNG/PDF 产物位置、session 复用证据、未验证边界。报告引用实际文件和结果，不仅列“完成”的任务清单。

审核者以最终 diff、运行路径和上述证据核对，而不是仅凭实施者的总结。阻断项包括：旧协议仍可用、客户端每轮重建 compiler、Pi 未拿到 image content、向量经过 JSON 文本、版本串用、返回半文件/不可读路径、提前清理产物、未同步已知 UI 调用方、绕过官方 Typst/Host 生命周期、把未运行检查写成通过。

实施结果已记录于 [实施报告](IMPLEMENTATION_REPORT.md)，公开用法由当前 README/包文档拥有。本文件保留目标契约及实施前删除清单，供独立审核对照，不成为第二套教程。

## 18 相关依据

- [工程原则](../../engineering/DESIGN_PRINCIPLES.md)：契约可读、行为可观测、修复可审查，以及单一所有者。
- [API 设计规则](../../.agents/rules/library-api-design.md)：明确公开入口、生命周期、失败、跨进程与 agent 消费验收。
- [Typst 公开用法](../../docs/plugins/rendering/typst.md) 与 [实现设计](../../plugins/render/typst/DESIGN.md)：增量 session、同 revision 输出与原生取消语义。
- [Cap’n Web 自定义传输](https://capnweb.com/transports/custom/)：字符串、保留字节、结构化克隆编码的区别；使用本仓库锁定版本实际验证，不依赖文档中的未来能力。
- [Electron MessagePorts](https://www.electronjs.org/docs/latest/tutorial/message-ports)：主进程与 renderer 的 port 转交、事件 API 差异。Electron utility process 还须按实际安装版本验证其接线。
