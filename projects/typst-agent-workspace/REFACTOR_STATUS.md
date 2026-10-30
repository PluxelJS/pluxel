# Typst 源码权威重构

[TYPST_SOURCE_PROMPT.md](TYPST_SOURCE_PROMPT.md) 的核心、既有报告能力与已知调用方已迁移，2026-10-30 完成原重构目标，goal 状态为 complete。随后按用户要求进行提交前复查：对照旧功能、排查真实操作顺序、清理文档与依赖；本轮修复与验收状态见下文。

## 最终设计

普通 `.typ` 保存正文、模板调用和原生 label/ref，JSON 保存业务数据，图片保留为普通资源。Tiptap JSON、AST/CST、位置映射与静态索引均可重建，不是恢复项目的前提。

一条编辑路径：读取文件快照 → 解析和投影 → 原生 Tiptap 事务 → 保真补丁预检 → 项目原子接纳 → 宿主持久化及同一编译 session 更新。项目拥有跨文件事务、冲突与 undo/redo；宿主拥有磁盘 CAS、权限、外部监听和编译调度。保存草稿、结构化可编辑和编译成功分别报告，无效原文可保存，旧预览保留其旧回执。

解析范围和补丁使用 UTF-8 字节；JS 字符串和 ProseMirror 文本使用 UTF-16，节点位置另含结构 token。native 定位为 1-based UTF-16 行列，编译诊断为 0-based UTF-16；转换显式处理转义、emoji、组合字符、CRLF 和 `#` 边界。完整职责与短公开调用见 [DESIGN](../../plugins/render/typst/DESIGN.md) 和 [源码编辑用法](../../docs/plugins/rendering/typst-editor.md)。

## 既有能力迁移矩阵

| 能力                              | 当前行为与直接验证                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 正文、标题、列表、代码、常见 Mark | 原生 Editor 局部回写；中文与非 BMP 输入、空段落、连续排版、嵌套列表、链接、撤销和重开通过真实浏览器及桌面验证                   |
| 字体、字号、颜色、对齐            | 显式属性写入普通 Typst，模板继承保持；native 像素、18pt/颜色及关闭重开后的实际 PDF 已验证                                       |
| 手工表格                          | 合并/拆分、多段单元格、四种表格样式、列宽和单元格对齐保留；真实 TableKit 操作与独立 native 线条 oracle 通过                     |
| 图片、figure、题注、公式          | 尺寸/alt、富题注、原生数学保留；原 LaTeX 使用显式 MiTeX helper，图与题注一起移动，最终编号由 Typst 决定                         |
| label 与引用                      | 原生 label/ref、`@` 搜索、跨文件跳转、原子改名、移动/复制及只重绑副本内部引用；PDF 实际编号、三态题注显示与内部链接独立核验     |
| 模板组件与 JSON 字段              | 显式 module/export 与 literal 参数控件，插入 import/调用属于同一事务；数据控件写真实 JSON，图表重新求值；分析正文不自动改写     |
| 未知语法与环境语句                | 未知内联原位保留、未知块可源码修复；注释/空白/未修改参数保持，无法证明语义的移动或结构化改写明确拒绝                            |
| 保真、并发与历史                  | 无操作字节不变；补丁绑定文件及基线，跨文件失败不部分接纳；外部替换拒绝旧事务并重置历史，复制/改名可整体撤销                     |
| 错误恢复                          | 无效 Typst 原文和文件范围诊断保留；成功修复后恢复结构化编辑及同 session 编译，失败不生成伪成功 PDF                              |
| Agent 与人的协作                  | Agent 直接改 `.typ`/JSON，人编辑正文/题注/引用，保存重开后 Agent 读取对应源码；Studio 未保存捕获、lease、候选审阅和阶段回执通过 |

这些能力由[核心 206 项](evidence/source/core-tests.txt)、真实消费者及下列产物共同证明；测试数量本身不代替实际输入和输出。任意 Typst 程序的全可视化编辑不属于承诺。

## 已知调用方与交付证据

| 调用方                  | 结果                                                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typst-agent-workspace` | 11 项 workflow 通过；原用户报告完整迁移到 `workspace/`，普通文件独立重开；[实际报告 PDF](evidence/source/migrated-report/report.pdf) 为 1 页、72,682 字节，无诊断                                                                                                      |
| Typst 主浏览器消费者    | [10 项真实交互](evidence/source/browser/results.json)通过：中文选区、`@`、富题注/label、未知源码、JSON、错误修复、保存重开；桌面/移动截图已目视                                                                                                                        |
| 文档浏览器示例          | [真实浏览器验收](evidence/source/docs-browser/commands.txt)通过：WASM 冷启动、HMR、离线恢复、撤销、段落/表格双向定位、停止重启及桌面/移动布局                                                                                                                          |
| 仓库外构建制品          | [独立接入](evidence/source/artifact/RESULTS.md)通过：严格公开类型、Node/Web parity、WASM 资源、真实 React 插入/clipboard/页面重载、同 session native PDF/PNG；纯编译不加载编辑 peer                                                                                    |
| Report Template Studio  | 31 文件、218 项通过，1 项 Windows 专用跳过；完整 Electron 桌面 24 组路径通过，包括 5 报告批次、正文与银行 PDF、关闭重开、schema 恢复和普通 `data.json` ZIP 往返；[当前两代重连](evidence/source/studio/recovery.json)通过，同一页面继续编辑并两次导出PDF，正常退出清理 |
| 原纯编译消费者          | 现有 ReportStudio、Takumi Markdown 编译入口保持；源码编辑不进入包根、`/template`、`/browser` 依赖链                                                                                                                                                                    |

[完整证据与复跑命令](evidence/source/RESULTS.md)及 [Studio 桌面证据](evidence/source/studio/RESULTS.md)包含源码 diff、JSON 单独更新使真实柱图/指标变化、同会话错误修复、PDF 独立读取与分段计时。小样本计时只说明该路径，未外推任意报告或 Agent 效率，也未据此增加 Worker 或额外持久缓存。

## 清理与必要复杂度

正式路径已删除旧正文 JSON 权威、Markdown 中转、生成区域、旧 serializer/candidate/blocks/reference-targets 等转换模块、对应 exports 和旧测试入口；已知调用方一次迁移，没有运行时旧读取器、兼容 alias 或启动转换。原报告旧 JSON/Markdown 仅归档于 `evidence/markdown-baseline/`。旧测试按行为由 source/Editor/native/浏览器回归替代。

新增复杂度限定为当前契约需要的 parser 接线、位置转换、保留式补丁、import/shadow 来源判断和统一项目事务。固定 `@r4ai/typst-ast-node/web` 0.3.0；Node 同步、Web 显式异步初始化 371,384 字节 parser WASM。没有第二个解释器或编译器，没有持久化的第二份引用索引。helper 是普通 `lib/pluxel.typ` 与 MiTeX 文件；修改其定义后相应调用退回源码编辑，不猜测旧语义。

公开用法、包 README、生成工作区 AGENTS 和内置 Typst authoring skill 已同步。历史提案明确标为历史，旧实现链接固定到已验证提交。证据日志改用 `.txt`，数据快照纳入精确的 gitignore 例外。相关包均为 private，未添加空 Tegami、手改版本或 publish lock。

## 提交前复查

- 保真回写：同文字表格单元格的原生参数逐格保留；完整富链接改址可用；取消对齐保留前后注释。
- 事务准入：只有自身同步事务能绕过写回；嵌套声明不泄漏作用域，名称遮蔽不会生成语义不明的格式调用；已有错误块不妨碍无关有效段落编辑。
- Studio：提交成功返回已保存基线，显式不完整编译草稿拒绝混入磁盘内容；正文与源码文件视图共用输入保存、冲突和关闭状态。先编辑文件再打开表单会移交最新草稿、等待在途保存，保留真实冲突；无效 JSON 保留原文件草稿，修复后再接管。
- 文件操作：保存后立即重命名曾复用保存前的在途刷新，误报版本冲突；精确回归复现后改为等待旧刷新、共用下一次读取，不放宽磁盘 CAS，不增加重试写入或第二个刷新队列。
- 重连提示：工作区和 AI 面板忽略旧连接的迟到读取；健康读取清除暂时连接提示，真实操作失败及未保存草稿继续保留。组件回归和两代真实重连均已验证。
- 文档与依赖：无 DOM 示例使用原生 JSONContent 并实际执行；说明远程候选存储基线与本地内容基线的区别；移除无消费者的 `@tiptap/markdown` catalog，冻结锁文件离线验证通过。

本轮核心 206 项、文件消费者 11 项、Studio 218 项通过（另 1 项 Windows 专用跳过）；真实 Electron 桌面 24 组路径、两代后端重连与恢复后的 PDF 导出均通过。

## 分工与独立审查

- `root`：统一契约、Tiptap/React 接线、文档、构建、整体集成和最终产物核验。
- `parser_audit`：AST/CST、位置、投影、保真回写与 native 能力核验。
- `consumer_audit`：实际旧报告迁移、公开制品接入和既有功能的独立证据。
- `design_review`：项目事务、设计审查和 Studio 源码迁移。
- `studio_finish`：Studio 最终桌面/恢复验收，修复实际暴露的候选基线、选区、批次和字段发布问题。
- `completion_audit`：只读逐项核对 prompt、实际源码、测试断言、PDF/PNG 和文档；最后另审查批次编译、定位回执与 schema 发布顺序，未发现未处理阻断项。作者的桌面结果仍由主 agent 核验。
- 提交前复查：`feature_review` 核对旧功能与表格/链接，`source_review` 核对准入/保真并独立审查 Studio 所有者交接，`scenario_review` 核对并修复存储/编译/文件视图；主 agent 执行整体构建、真实消费端验收与提交。

## 已验证范围

- 未知求值、动态 label、文献 key 和不确定作用域保持源码；静态未命中不一律等同缺失，真实编译裁决。
- 源码修订、存储摘要和成功编译回执用途不同。`session.update({ files })` 是完整文件表替换；监听和磁盘原子保存由宿主负责。
- 工作区使用 GNU `mv --exchange --no-copy -T` 交换完整目录并在锁内复核摘要。不声称任意不守锁 writer、断电持久化或跨平台文件系统语义已验证。
- Studio 刷新/重连批次顺序编译，把批次开始时的 `preferredPreview` 放最后，保留原四会话上限；不承诺动态切换或外部并发下所有旧回执永久有效，过期仍明确返回 `REVISION_CONFLICT`。
- Studio 完整桌面及重连专项在本机 Linux Wayland 验证；新增原生确认弹窗未在 headless 完成，详见 Studio 复查记录；Windows ACL 测试按平台跳过，未宣称 Windows/macOS 桌面或长期稳定性。
- 初始无关改动 `vendor/split-like-vscode` 未触碰并排除在提交之外。验收使用任务所属隔离实例和已有服务入口；不涉及包发布或部署。
