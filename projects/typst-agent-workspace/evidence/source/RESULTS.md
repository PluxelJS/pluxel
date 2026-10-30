# Typst 源码协作验收

2026-10-28 至 2026-10-30，在本机 Linux、公开构建制品和真实 native 编译器上完成。

实际已接纳报告已从 `.state/draft.json` 一次转换到 `workspace/`。原 JSON 和旧 Agent Markdown 只归档在 `../markdown-baseline/`；运行代码不再读取它们。回归逐个比较旧报告与源码投影的全部文字、业务 JSON、figure 所在章节、合并和多段落表格；真实报告输出为 [1 页 PDF](migrated-report/report.pdf)，72,682 字节，无编译诊断。[首页](migrated-report/page-1.png) 已目视检查，三列表格、三线表、完整建议和行动建议中的图 1 均保留。

独立验收样本位于 `tests/fixtures/report/`，避免用测试占位文案覆盖实际报告。`scripts/source-evidence.mjs` 从普通文件开始，执行 Agent 源码修改、真实无 DOM Tiptap 中文/题注编辑、跨文件 label 改名、项目撤销/重做、完整目录保存与重新打开，然后把五个完整快照交给同一个编译会话：

| 快照                   | 结果                                                                       | PDF                             |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------- |
| 初始                   | 成功，revision 1，无诊断                                                   | [2 页](initial/report.pdf)      |
| 人编辑并重开           | 成功，revision 2，无诊断                                                   | [2 页](human-edited/report.pdf) |
| 仅 JSON 营收 120 → 180 | 成功，revision 3，无诊断                                                   | [2 页](json-updated/report.pdf) |
| 未闭合中文源码         | `COMPILE_FAILED`；准确报告 actions.typ 的范围；lastSuccessfulRevision 为 3 | 无伪成功 PDF                    |
| 显式修复               | 成功，revision 4，无诊断                                                   | [2 页](repaired/report.pdf)     |

[source.diff](source.diff) 显示人和 Agent 修改，未知内联调用、循环、外层 text 调用与未触及表格保留。PNG 确认仅 JSON 更新会使真实柱图与指标变化；分析正文不自动重写。源修订和会话 ID 见 [results.json](results.json)。单次 Editor 打开及编辑约 152 ms，包含本次样本 schema/解析；这不是性能基准，也不代表长报告或其他 Agent 的效率。

此外使用独立 `pypdf 6.21.3` 读取交付 PDF，而不是依赖生成器 JSON：确认 120/20% → 180/80%，分析仍保留原有 20% 文案，公式编号为式 2，引用三态分别显示默认、不附题注和附题注；富题注中的自引用/互引有限展开。初始 PDF 含 28 个内部链接，其余编辑样本各 26 个，实际报告 1 个，所有目的页存在。具体文字、页码和链接矩形见 [pdf-inspection.json](pdf-inspection.json)。

复跑主流程：

```sh
TYPST_FONT_FILES='["/run/host/fonts/noto-cjk/NotoSerifCJK-Regular.ttc"]' mise exec -- node scripts/source-evidence.mjs
```

独立 PDF 检查使用 `scripts/inspect-source-pdfs.py`，在含 `pypdf==6.21.3` 的 Python 环境运行。该工具不是应用依赖。

文件保存用 GNU `mv --exchange --no-copy -T` 原子替换完整目录。消费者读写共用排他锁并复核源摘要；无效路径、冲突失败无部分保存。无效 Typst 草稿本身允许保存，随后明确报告诊断。任意不守锁的外部写入在最终检查与 exchange 间的竞态、断电持久化、跨平台文件系统语义未验证。

本项目包含真实无 DOM Editor，未将其视为浏览器输入法/鼠标选区验收。浏览器交互由 Typst 包的独立浏览器消费者负责。

## 核心与浏览器集成验收

- [核心完整测试](core-tests.txt)：23 个文件、206 项通过，包括原有编译/预览/资源/WASM/native回归及新源码投影/事务/真实Editor；提交前补充表格参数、链接、注释、词法作用域与已有错误范围保真回归。
- [独立工作区](workflow-tests.txt)：11 项通过，包含实际原报告完整迁移、跨文件复制/移动、磁盘冲突、无效草稿和同一native会话数据重算。
- [主浏览器](browser/results.json)：10项通过，新增未应用草稿保护和真实HTTP迟到/同修订异内容请求拒绝；桌面/移动截图已检查。
- [文档浏览器](docs-browser/commands.txt)：真实共享Chromium，WASM冷启动、HMR、离线编译、撤销、段落/表格定位、错误恢复、停止重启及桌面/移动全通过。
- [隔离构建制品](artifact/RESULTS.md)：提交前以当前制品复验通过，覆盖新增组件/字段插入、undo/redo、JSON实时值、仅文件重开及四类源码原子的HTML解析/粘贴保真；新的三份PDF文字与内部链接已独立读取。
- [Studio](studio/RESULTS.md)：31 文件、218 项通过，1 项 Windows 专用跳过；真实 Electron 桌面 24 组路径及两代后端重连通过。普通源码/JSON、Agent 捕获与接纳、中文排版、表格、候选与共享历史、双向定位、五报告批次、关闭重开、schema 恢复及 ZIP 往返均有实际证据。

Studio 的五份交付 PDF 另由独立 `pypdf 6.21.3` 读取，[检查记录](studio/pdf-inspection.json)确认正文中的中文和非 BMP 字符、列表、接纳建议、银行名称与两代重连后的不同数据。重开前后的正文文字及解码页面内容相同；PDF 时间戳和 document ID 会改变，不承诺 PDF 二进制相同。重开后的源文件字节由桌面脚本直接比较。主 agent 已目视原生 PNG、正文重开、ZIP 导入与重连后的界面。

[分段计时](timings.json)使用14文件、9个Typst文件的同一类报告，预热5次后采样30次局部中文修改。CST+AST中位约0.36ms，投影其余约0.39ms，纯补丁准备约0.43ms，完整项目准入约1.77ms；每次候选准入只调用目标文件的CST和AST解析各一次。计时包含所注明的边界，不代表长报告、其他机器或中文输入法总体延迟。编译成本在隔离制品native回执中单独记录；未据此增加Worker或额外持久缓存。

复跑计时：在 `plugins/render/typst` 执行 `mise exec -- vp exec tsx tests/source-timing.ts`。

## 复跑检查

最终 [hk 检查记录](checks.txt)：127 个文件格式通过，98 个代码文件无 lint 或类型错误；`git diff --check` 通过。本轮当前 Markdown 的本地文件链接已核对，源码验收目录没有被 git 忽略的未跟踪证据。独立审查结果与最终迁移矩阵见 [重构状态](../../REFACTOR_STATUS.md)。

以下命令在对应目录运行；浏览器脚本沿用仓库已有服务和共享 Playwright WebSocket。

| 目录                             | 命令                                                                                                                                                  | 本次结果                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `plugins/render/typst`           | `mise exec -- vp run compile-lib`                                                                                                                     | 19/19 构建任务成功                  |
| `plugins/render/typst`           | `mise exec -- vp test run`                                                                                                                            | 23 文件，206 项通过                 |
| `projects/typst-agent-workspace` | `TYPST_FONT_FILES='["/run/host/fonts/noto-cjk/NotoSerifCJK-Regular.ttc"]' mise exec -- node --test tests/workflow.test.mjs`                           | 11 项通过，包含 native              |
| 仓库根目录                       | `mise exec -- node projects/docs/tests/typst.browser.mjs --url http://docs.pluxel.localhost:8088/examples --artifacts /tmp/typst-docs-source-browser` | 完整文档浏览器验收通过              |
| 仓库根目录                       | `mise exec -- hk check`                                                                                                                               | 本次改动的格式、lint 与类型检查通过 |

隔离制品的安装、构建与执行命令见 [artifact/commands.txt](artifact/commands.txt)；Studio 命令及 Linux headless/Wayland 验证边界见 [studio/commands.txt](studio/commands.txt) 和 [Studio 结果](studio/RESULTS.md)。源码中的相对资源路径保持可移植；上述字体路径和服务地址是本机验收环境输入。

提交前一次工作区 native 用例在宿主启动阶段失败，原日志见 [workflow-start-failure.txt](workflow-start-failure.txt)；当时默认 reporter 折叠了内部生命周期报告，无法据此判定根因。启用完整报告的独立运行以及统一重建消费者后的完整 11 项均通过，实际用户报告单独编译也成功。未用重试逻辑掩盖失败，也未把后续通过解释为已经定位首轮失败原因。
