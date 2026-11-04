# Typst 源码与文档运行时

`@pluxel/plugin-typst` 是 workspace 内的 private 插件。编译契约由[Typst 用法](../../../docs/plugins/rendering/typst.md)维护，编辑契约由[源码编辑](../../../docs/plugins/rendering/typst-editor.md)维护。

## 权威与所有者

普通 `.typ` 保存正文、排版、模板调用和原生 label/ref；JSON 保存业务数据，图片是普通资源。Tiptap JSON、CST/AST、映射和静态引用索引只属于某个源码修订，重新打开不需要它们。没有 Markdown 中转、隐藏正文 JSON 或生成区域恢复链。

包内 source 层拥有解析、投影和源码事务；Tiptap 适配器拥有原生编辑事务准入和重投影。宿主持有文件 IO、权限、外部更新、存储 CAS 及编译调度。`TypstPlugin` 拥有编译资源，原有 `open/update/exportPdf/renderPage` 继续接收完整文件输入，不参与编辑历史。

## 编辑路径

```text
普通文件快照 → project.open(path) → 修订内投影 → 原生 Tiptap Editor
                                         ↓
原生事务 → prepareEdit → 最小可保留源码补丁 → apply → 新源码修订
                                               ↓
                       同一项目 undo/redo ← 原子接纳 → 通知宿主持久化/编译
```

`prepareEdit` 不产生副作用；`apply` 先检查修订、路径、权限、Unicode 边界和补丁重叠，再一次修改全部文件。结构化 label 改名连同已确认跨文件引用一起提交。外部 `replace` 接纳完整快照并清空旧历史。源文件可以无效；保存草稿与成功编译是不同阶段。诊断含 path、UTF-8 范围、源码 revision 和稳定 code。

`apply` 可同时接收 `createFiles` 与基线文件补丁，新章创建和目录更新共用一笔接纳与历史。新文件不覆盖已有路径；检查失败不改变文件、权限或历史；撤销新建将文件从项目中移除。`createFile` 沿用这一条事务路径。

编辑器的 `filterTransaction` 只预检，最终 `onTransaction` 接纳实际文档（含扩展追加事务）。只允许自身精确同步事务绕过准入；同步被其他扩展拒绝时保留源码、报告错误并阻止基于旧投影继续写。文件被外部删除同样明确停写。项目历史替代该视图内的独立 UndoRedo，复制和跨文件重构也是一笔项目历史。

## 解析、保真与位置

固定 `@r4ai/typst-ast-node/web` 0.3.0。Node 同步初始化，浏览器显式传入同版本 parser WASM；不会把 Node parser 打入浏览器。发布物部分 AST 字段与声明不同，`parse.ts` 在包内归一化。解析库不求值，也没有本实现承诺的增量 parser。

AST 识别结构，CST 与原文范围承担保真。无操作不写；文字编辑保留注释、空白、计算参数与未触及语法。需要重建时以已支持的最小结构为界；无法证明未知内容保留的操作拒绝并报告源码入口。builtin 的识别考虑已知 lexical shadow/import；未知调用、环境语句和动态程序不当作可自由搬运的普通内容。

结构化准入还检查回写后的投影：新生成的调用不能因当前位置的名称遮蔽而变成未请求的源码原子。作用域按声明顺序更新，嵌套内容不泄漏局部声明。已有语法错误只在拥有该错误的源码范围未受补丁影响时保留，偏移随前方 UTF-8 补丁换算；新的或被修改的语法错误拒绝接纳。直接源码编辑仍可保存无效草稿。

| 单位                       | 所有者与用途                              |
| -------------------------- | ----------------------------------------- |
| UTF-8 byte                 | parser range、源码补丁、诊断与来源范围    |
| JS UTF-16                  | 字符串切片；显式转换表拒绝 surrogate 中点 |
| ProseMirror position       | 节点开闭 token 加 UTF-16 文本长度         |
| 1-based UTF-16 line/column | native preview 源码定位                   |
| 0-based UTF-16 range       | compiler 诊断                             |

转义文字保留逐字符源跨度，emoji、组合字符、CRLF 与 `#` 前缀各自处理。公开 `findTypstEditorPosition` / `findTypstSourcePosition` 使用当前投影转换；未知源码取拥有者节点，不能宣称任意表达式都有精确字符投影。公开投影不泄漏 parser AST/CST 或可写回来源元数据。

缓存按文件复用；普通修改只重解析受影响文件，实际 import 源变化使有关缓存失效。项目静态引用操作按需要读项目索引，不另存一份可写依赖图。快照中的字符串共享不可变值，字节资源在实际读取时给出独立副本，避免每次文字编辑复制所有资源。性能探针只说明代表性样本，不外推任意项目成本。

## 报告结构与依赖

文档模板拥有整篇结构、排版和固定区域；内容组件拥有局部内容，可以由模板固定放置，也可以由正文自由组合。固定结构通过普通源文件与宿主 `writablePaths` 表达，`isWritable` 将同一权限投影给编辑控件。数据控件默认只读，React 视图的 `editableFields` 显式开放字段或 JSON 子树，且仍须满足数据文件可写与整个视图可编辑。模板源码与 JSON 独立判断；只读模板可开放可写数据字段。派生数组长度不升级为整文件编辑。控件声明由视图持有，项目事务继续持有文件准入和历史；宿主其他业务入口及外部完整快照仍由宿主接纳，不把 UI 配置当成文件系统授权。

行内数据字段引用绑定 JSON 文件与字段路径；删除引用不删除数据，`#let` 与动态表达式保持 Typst 语言语义。React `renderComponentParameters` 只替换组件局部参数草稿的控件；应用/取消、过期检查、源码接纳和项目历史继续由既有路径拥有，不建立第二个文档或组件运行时。

静态字符串 import 投影为固定顺序的 `typstImport`，保留 CST 模块、别名和成员范围，属性修改走同一 writeback；新增导入、组件和字段插入共用该节点。准入核对重投影后的导入及组件/字段绑定，不能通过导入项注入额外语句或绕过作用域保护。动态 import 仍是源码节点。React 节点只拥有紧凑展示与浮层草稿，所有源码和业务数据继续由项目持有；浮层复用现有 FloatingMenu，不占据正文布局。宿主拥有模块文件打开与预览定位，`onEditor` 在 DOM 挂载后通知，以便跨文件目标聚焦和滚动。

独立成行的静态字符串 include 投影为可移动的 `typstInclude`，只引用原始文件，不把章节展开成另一个可写副本；行内 include 保持原位源码及段落边界，动态 include 保留环境边界。路径修改保留调用处注释，跨文件复制复用相对资源路径重定位。导入和章节入口由内部输入项声明，菜单只检查目标可用性；填完路径才生成真实插入命令，不以占位命令执行可用性探测。补全只列当前目录的直接子项，普通命令和延迟输入继续共用目标捕获、提交与历史。

输入表单提交后，源码编辑器以实际接纳结果与完成同步的投影文档给出内部事务回执；菜单核对该回执，避免把段尾空白等投影差异误报为失败。拒绝或回滚不能冒充成功，普通 Editor 没有源码回执时仍严格核对提交后的文档。

路径的目录确认只进入目录，文件的 Enter 或点击确认执行当前动作；Tab 只补全路径。浮层通过现有未应用标记保留单个活动草稿，重开入口只聚焦原稿。显式完成恢复触发器焦点，干净的外点或焦点离开不抢焦点。组合输入保护由共享表单守卫拥有，不依赖正文编辑器的 composing 状态。数值参数保留输入字符串到提交再转换，空白恢复默认；默认操作删除调用处参数，空字符串和显式零保留各自语义。

动作按钮在点击完成前保留输入焦点，避免补全列表因 blur 收起、浮层重新定位而吞掉鼠标点击。已有草稿时，源节点按钮的 mousedown 在 ProseMirror 移动选区前拦截；拒绝切换入口必须同时保留草稿和插入时捕获的选区。

`onSelection` 报告选区变化及已完成的正文点击，同位置再次点击也通知。宿主持有当前待跟随光标，当前预览才可定位，新预览显示或隐藏 pane 重显后重放；自动跟随不改变编辑器焦点及 pane，显式 `onReveal` 才能要求切换面板。native 调用跨度不含 markup `#`，源码位置映射取表达式内位置。组件输出缺少调用归属时明确报告不可定位，不按邻近源码或组件定义猜实例。

支持段落/标题/列表、常见 mark、显式字体字号颜色/对齐、代码、手工表格、合并与多段单元格、表格样式、图片、figure/富文本题注、label/ref。模板负责最终排版；编辑器不模拟 `set/show` 的求值外观。未知内联留在原位，未知块提供源码卡片；错误范围可修复，仍可确认的其他结构继续编辑。

静态 label 与确认目标的范围绑定，旁边的注释/空白保留。rename 只修改解析确认的声明与引用；动态 label、文献 key 等静态未命中只是未确认，真实编译裁决。移动检查环境依赖与相对资源路径；不能把“字节不变”当成语义不变。复制确认完整块时分配不冲突 label，仅重绑复制范围内的引用。隐藏 UUID 不作为项目的引用权威。

`source/library` 提供待持久化的普通 `lib/pluxel.typ` 和固定 MiTeX 文件。模板显式 `#show: report.document` 安装 metadata 引用显示；LaTeX 使用 `report.latex`，原生数学保持原式。`report.reference` 的 `caption:auto/false/true` 复用短引用规则防止题注自引/互引展开无界。`false` 禁用题注，编号与 supplement 仍按 Typst 模板；不是强行剥掉“图/表”的数字。

组件声明指向真实项目 module/export，只声明可控 literal 参数与 JSON 参数名。控件回写调用处，数据控件直接修改实际 JSON；动态图表重新求值，分析文字不自动改写。helper 识别校验真实 import 和固定库内容；用户修改 helper 定义后，不能继续假设原语义，调用退回源码编辑。源码修订与 helper provenance 共同决定投影。

## 边界

TypstPlugin 是 native compiler 的唯一插件所有者。无状态 `renderSvg(source, options)` 供数学扩展与应用复用，完整文档编辑使用 `open()`；两者共享包内固定 native binding 和字体读取，按所需状态选择执行模型。

业务在输入前验证数据。核心只内置 JSON 编码，其余格式接受用户已编码的文本、字节或真实文件；文件表同时表达逻辑路径与来源，没有额外 Schema、Codec 或输入声明层。

Template 是普通 root/entry 配置。Session 固定字体快照，串行接纳完整输入文件表与可选模板树替换，持有最新成功产物并负责清理。应用拥有通信与归档，Preview 只消费产物。

## 执行路径

```text
renderSvg → shared Workers admission → bounded UTF-8 source / portable fonts
          → one per-job native compiler → caller-owned SVG bytes
open → 快照本地模板与可移植字体 → 分配有界 session
update → session 队列 → 准备动态文件 / 可选模板替换
       → session 专用 Worker → 复用 NodeCompiler、同步 shadow VFS delta
       → 同 document 导出 Vector/PDF/源码与标题坐标 → 发布成功修订
renderPage → 同 session 队列 → 校验 retained revision → bounded PNG / pixel crop（不编译）
exportPdf → 校验 revision → 返回独立 PDF 副本
close → 撤销接纳 → 终止专用线程并确认退出 → 清理私有资源
```

NodeModules 负责正式构建制品定位和替换生命周期；每个 session 至多一个独立 Worker，maxSessions 是线程上限。通用 Workers 没有线程亲和契约，因此此有状态计算不借用无状态任务池。

无状态 SVG 使用 `runPrepared()`，不另建队列或线程池；源码计量和字体读取在获准执行后进行，返回前检查 output bytes。请求采用 `settlement: 'execution'`，caller/provider 关闭均取消并等待执行结算，不持有会话。SVG 源码是可信完整 Typst 文档，受限公式语法归数学扩展所有。

Worker 保留 NodeCompiler、最新成功 document 与文件内容索引；同一私有文件快照中未变化的文件不重复读取，变更调用 mapShadow、删除调用 unmapShadow。每次 compile resetRead 刷新读取缓存，native memoized 计算仍保留；evictCache 按年龄清理，不代表 native RSS 硬上限。字体变化由调用方关闭并重开 session，避免同名字体缓存串扰。

取消在途 native 计算需要终止线程并关闭会话，不能在已销毁线程上继续更新。调用方可重新 open。普通编译诊断不关闭会话；修复源码后可在原会话继续。无法确认退出时保留目录并报告 EXECUTION_UNSETTLED。

原生绑定固定 typst.ts 源码版本，使用本包 `native/` 中可审查的最小补丁暴露 `NodeTypstDocument.navigation()` 与 `renderPage()`。它直接遍历本次 document 的 frame/span 和 introspector；不建立第二个编译器、语言服务或业务监听端口。构建产物由包携带，Plugin 从自己的包位置解析 native 路径并作为内部输入传给 Worker；缓存中的 extracted artifact 不自行猜包位置，不修改 node_modules，也不在主线程加载 binding。

## 资源与修订

模板在 open 复制，update.template 可提交完整替换；动态输入在 session 排队后写入 staging，准备完成再替换 inputs 目录。文本/JSON 分块编码，文件走磁盘复制或 copy-on-write clone，Worker 消息只传路径和小型配置。逻辑完整替换不要求输入原样经过跨线程 clone。

每次任务返回有界 Vector/PDF、源码定位信息与诊断。成功替换当前修订；失败保留旧产物。exportPdf 在调用时取得对应 PDF 引用，后续更新不影响该导出。关闭、调用方停止和 provider 替换共用幂等清理。

固定范围是本地模板目录、动态文件与可移植字体。上游系统字体及 Typst 包加载仍是部署环境输入，不宣称完整可复现或安全沙箱。

## 浏览器与宿主

`/browser` 只依赖纯 preview/diagnostic 契约，拥有命中算法、SVG CTM、普通点击过滤、页面/目录跟随、滚动与高亮。固定 0.7.0 SVG 的内部引用携带 `handleTypstLocation(this, page, x, y)`；View 只解析这组数值，移除内联处理器并由实例自己的滚动容器完成跳转，不执行 renderer 脚本、不安装全局回调。链接优先于源码命中，键盘激活使用相同的当前修订检查；外部链接保留浏览器行为。View 只持有调用方提供的 renderer；销毁 View 不关闭共享 renderer。同步状态回调可以销毁 View，后续导航发布、高亮与计时器必须在同一调用中停止。宿主拥有源文件与客户端草稿当前性、可见 pane 选择及异步打开后的复核，不向 View 注入整个应用 controller。缩放也由 View 统一维护：只设置根 SVG 的尺寸，通过页内坐标保存阅读位置，视口 resize 或隐藏后重显时恢复。宿主提供滚动容器、目录与页码控件，不再自行按百分比拉伸 SVG；缩放单位与容器 CSS 约束见[浏览器预览](../../../docs/plugins/rendering/typst.md#浏览器预览)。

根入口、`/template` 和 `/browser` 不依赖 Tiptap/React/parser。`/source`、`/source/browser` 选择解析环境；`/tiptap` 可用于真实无 DOM Editor，`/tiptap/react` 持有控件和 NodeView。React 必须先挂载原生 view 再渲染读取 view.dom 的工具栏。CSS 独立导入；Monaco、工作区和通信由宿主维护。

`/document` 的 `createTypstDocumentProject` 借用现有 source project，拥有安全语义投影与编辑准入。宿主声明开放的文档 ID/path/title、可选模板标题 label、固定引用和资源 path/URL；动态目录通过同一声明函数重新读取。源码文件、修订、权限和历史仍只有 source project 一个所有者，document project 不持久化另一份正文，也不接管编译、章节 CRUD、存储、认证或 HTTP。label 和 source object identity 映射成实例内不透明 ID，未知内容用带密钥摘要的 key/title 固定节点；前导 import/environment 保留私有，资源映射保留原始拼写。公共失败只含固定安全 code/message。

`navigation({ revision, navigation })` 要求同次源码修订，源码 span 通过 projection 变成公开文档位置；真实目标来自 native introspector，链接矩形与 Position/Location/URL 来自 FrameItem::Link。固定目标可以没有编辑器位置，未知本地 URL 与不安全 scheme 不传出；不再按 outline 顺序猜章节、不从 glyph 合成链接。安全 DTO 由 `document/types.ts` 单独持有，server、语义编辑器、PNG 预览和宿主 wire type 共用。

`/tiptap/document` 与 `/tiptap/document/react` 不加载 source/parser，复用语义节点和原生编辑控件。引用使用不透明 ID 与可选 `{documentId, position}`，没有编辑器目的地时不提供虚构的跳转按钮。内容校验拒绝 schema 外属性，普通事务不能改写固定节点，宿主同步只替换差异并保留原生选区。默认本地历史和显式远端历史各有一个所有者；共享 UI 的事务标记放在不依赖 source 的模块中。`/document/react` 独立持有安全 PNG 页面的命中、跟随、原生内部链接、滚动与高亮，过期/草稿状态禁用旧几何，宿主只持有实际页图 URL、当前修订与打开面板行为。第三个分章演示直接消费这些公开入口，私有 project 适配仅保留章节目录事务与模板文件，server 适配仅保留串行 lease、编译、持久化和 HTTP。

文件工作区以磁盘文件快照和 CAS 提交为存储边界。浏览器示例保存普通文件表；Studio 将正文与数据存入工作区，保留捕获 lease 和保存/编译/preview 分阶段回执。它们共享 source 核心，不能用隔离 test host 证明在线状态。

浏览器 consumer 以桌面工作区为目标，将经营报告与固定审批表放在同一文件树的两个根文件夹中，各自持有项目、编辑历史与保存键；文件导航不改变浏览器 URL；Worksplit 的 routed document 持有每个文件的编辑草稿，其 `preview`/`keep` 持有临时标签与编辑后保留语义。左侧 Border 放文件树，中央默认编辑与整篇预览左右分组，原生 Model 独占标签、选择、分屏和最大化。各项目预览拥有一条编译会话，文件标签共用该预览；会话随预览关闭释放。文件树从项目快照派生，不另外维护文件内容。宿主通过 `createFile` 创建可撤销的新 `.typ`，章节经普通 `include` 进入所属文件夹的 `main.typ` 完整预览；源码修订决定当前预览和 PDF 是否可用，不另设预览入口状态。审批表由宿主原生表单编辑实际 JSON，一次字段确认是一笔项目事务；模板保留只读，长单元格的留白与续页由普通 Typst 定义。当前两个用例共享文件、准入、历史和编译，不从单个表单提取公共 schema 或另一份文档状态。

第三个分章项目书使用独立文档页面。宿主在服务端持有源码项目及预导入、章节目录和固定表达式；浏览器仅持有当前章节的语义视图与待同步草稿。正文仍由原有准入生成补丁，目录 JSON 只保存章节身份、标题和顺序。创建章节通过一笔 `createFiles + patches` 同时加入文件及目录；创建、改名、重排与正文编辑共用项目历史。业务引用目录不公开文件路径，图资源经白名单 URL 映射，原生编译结果返回页图及安全错误；同次编译的源码定位在私有端转换为章节身份、语义 PM 区间和页面矩形，并从引用节点及真实章锚生成内部链接热点。浏览器只用这些安全几何数据双向定位；链接优先于正文命中，草稿未同步及修订不符时停止旧坐标交互，新排版后重放当前光标。Vite 静态访问同时拒绝私有模块和模板路径，避免通过开发服务绕过界面。页面 lease 与保存文档身份分离，保存保留服务端文件快照，浏览器存储只留文档 ID。

## 实现与回归入口

| 路径                                                | 职责                                                |
| --------------------------------------------------- | --------------------------------------------------- |
| `src/source/parse.ts`, `project.ts`, `writeback.ts` | 解析、投影、最小保留式回写                          |
| `src/source/project-state.ts`, `state-types.ts`     | 原子源码事务、索引、重构、历史与公开接口            |
| `src/source/positions.ts`                           | 源码与编辑器位置转换                                |
| `src/tiptap/source-editor.ts`, `source-react.tsx`   | 原生 Editor 准入、React 控件与修复入口              |
| `src/session.ts`, `resources.ts`, `worker.ts`       | 编译队列、完整快照、native 资源与成功修订           |
| `src/browser/`                                      | 预览、命中、滚动和当前性检查                        |
| `tests/typst-source-*.test.ts`                      | 保真、真实 Editor、独立扩展准入、事务与 native 回归 |
| `tests/consumer/source-check.mjs`                   | 现有 Playwright 服务上的真实浏览器操作              |
| `projects/typst-agent-workspace`                    | 公开制品、普通磁盘项目、人/Agent 往返与 PDF 证据    |

迁移矩阵、验证结果与能力边界记录于[重构状态](../../../projects/typst-agent-workspace/REFACTOR_STATUS.md)；验收事实在工作区 `evidence/source/RESULTS.md`，历史 Markdown 证据只用于基线比较。
