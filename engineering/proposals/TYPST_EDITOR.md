# Typst 前端入口与区域编辑：实施记录

状态：四个实施阶段及本地 Linux 验收已于 2026-10-23 完成，包含共享编辑界面、独立 consumer 和完整 Studio Electron 桌面流程。当前 API 由 exports、实现、[Typst 用法](../../docs/plugins/rendering/typst.md)和[区域编辑](../../docs/plugins/rendering/typst-editor.md)维护；运行时边界见 [Typst DESIGN](../../plugins/render/typst/DESIGN.md)。本文保留决策与可复查证据，不再维护另一份 API 示例。

## 已实施的决策

- 直接扩展 `@pluxel/plugin-typst`，保留包根 `TypstPlugin` 身份、native session 和 `/template`；增强 `/browser`，新增 `/tiptap`、`/tiptap/react`，没有另建 SDK 包。
- 正文保存 Tiptap 3 / ProseMirror 原生 JSON。官方 StarterKit、TableKit、Image 提供基础能力；TextStyleKit 提供字体、字号、文字颜色和背景颜色；dataField、宿主业务节点、准入与 Typst serializer 有显式契约，没有第二份正文 AST。
- Markdown/HTML 是受校验的输入；Markdown 不承载合并表格、多段单元格、文字排版格式和业务节点归档。排版格式使用独立的“排版扩展”行，原生 JSON、受控 HTML 与 Typst/PDF 保留四项样式，Markdown 显式报告损失并阻止有损候选覆盖。LLM 只提供暂存候选边界，宿主负责模型调用、授权和接纳。
- `/tiptap/react` 提供分组图标工具栏、段落/标题切换、选区浮动菜单、表格菜单与可搜索的 slash 插入；`/tiptap/style.css` 是显式加载的共享资源。Studio 和独立 consumer 使用同一套界面，菜单复用原生事务、准入与历史，宿主仅补业务命令和配色。
- `/browser` 拥有预览交互、SVG CTM、页面/目录跟随、命中和高亮；宿主决定草稿当前性、可见目标与异步导航复核。Monaco、双 worker、声明资源与 Vite 接线留在 Studio。
- Studio 将 raw data 与 regions 以同一存储版本条件写入；parsed data 只展示和编译。生成源码进入文档私有临时模板树 `_editor/`，正文变化更新模板，纯数据变化复用模板；工作区 ZIP 不带用户数据。
- optional peers 同时由 exports、JS 和声明图隔离。为满足真实根入口验收，Fonts 将纯字体 snapshot 声明与 Workbench RPC 声明分开，仅在 RPC 快照读取时加载 Workbench server 校验；静态 Workbench publication、producer 清单和 required constructor 身份保持一致。没有修改 Core、Workbench 协议或 native 编译器。

## 四阶段实施

| 阶段               | 完成的实现与所有者                                                                                                                                                                                                                                                                                        | 主要证据                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 预览与定位下沉  | [browser](../../plugins/render/typst/src/browser/preview.ts)、[navigation](../../plugins/render/typst/src/browser/navigation.ts) 持有共享算法；Studio [preview](../../projects/report-template-studio/src/renderer/preview.tsx) 通过公开入口回接，本地只保留 pane 可见性                                  | preview/source-navigation 测试与实际多页 consumer、Studio 桌面路径                                                                                                                       |
| 2. Tiptap 真实生成 | [tiptap](../../plugins/render/typst/src/tiptap/index.ts) 提供 raw JSON 准入、官方扩展、生成与双向映射；字段和合并表格直接进入现有 native session                                                                                                                                                          | [真实 native 测试](../../plugins/render/typst/tests/tiptap-native.test.ts)，实际 PDF/vector/PNG 与 glyph 定位                                                                            |
| 3. Studio 正文闭环 | [BodyEditor](../../projects/report-template-studio/src/renderer/body-editor.tsx)、[区域配置](../../projects/report-template-studio/src/backend/editor-config.ts)、[InputStore](../../projects/report-template-studio/src/backend/inputs.ts)；客户服务报告含固定模板、两个区域、数据切换、提示块与独立历史 | [后端 native](../../projects/report-template-studio/tests/editor-backend.test.ts)、[草稿存储](../../projects/report-template-studio/tests/inputs.test.ts)、workspace/DataForm 与桌面验收 |
| 4. 候选与外部消费  | 版本/权限两次检查、一次 transaction 接纳；独立 Vite consumer 使用移出工作区的实际构建制品，无源码 alias、Monaco、Studio、Electron 或浏览器 Workbench 图                                                                                                                                                   | [consumer 运行入口](../../plugins/render/typst/tests/consumer/README.md)，三阶段 strict types/build、无 DOM Node 与真实 Chromium 全流程已通过                                            |

## 验收对照

| 必须证明的行为                | 已有实际证据                                                                                                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 公共入口可消费、可选依赖隔离  | 独立目录分别检查包根与浏览器应用；`skipLibCheck: false`。无 Tiptap/React 时根、template、browser 可用；加入 Tiptap 后 Node 无 DOM 解析/生成，再加入 React 完成生产构建和编辑。根入口 import hook 禁止 React/Tiptap/Monaco；浏览器构建模块清单拒绝 Node/native/Core/services/Workbench。 |
| Studio 真正消费、源码编辑保留 | 正常预览、命中、高亮与区域编辑从公开子入口导入；没有 plugin 源码深导入。Monaco、TypeScript completion/hover 与双 worker 继续使用原应用构建路径。                                                                                                                                        |
| 预览交互保留                  | 真实三页、目录/页码跟随、源码点击和反向高亮；consumer 验证缩放、重复第 3 页命中、修饰键和拖选；workspace 验证多预览只操作明确的可见目标。                                                                                                                                               |
| 原生编辑语义                  | consumer 已验证真实 CDP 中文/非 BMP 输入、DOM 选区格式化、列表、表格操作、Markdown 表格粘贴、字段、undo/redo、切区和保存重开；Studio 桌面按独立入口复核。                                                                                                                               |
| 共享编辑界面                  | consumer 实测标题下拉、选区浮动菜单、slash 搜索/方向键/Enter/Escape、字段实时数据、一次撤销恢复查询、表格菜单、只读权限与移动端布局；独立排版行验证字体、字号、前景/背景、自定义色、单项清除与重置的原生 history，两个宿主均从公开 CSS 入口加载样式。                                   |
| 固定模板和区域限制            | raw JSON 先于 ProseMirror 规范化检查；伪造区域/属性、禁用节点、外部 commands、只读权限与候选均不能绕过。后端保存与编译重复验证配置、模板修订和原始输入。                                                                                                                                |
| 数据只绑定一次                | transform raw/parsed 分离、保存重开、客户字段变化与无额外 history 已验证。DataForm 仅提交实际编辑路径，初次读取完成前不开放编辑；延迟读取与 CAS 回归保留完整草稿。                                                                                                                      |
| 表格与序列化                  | 真 PDF/PNG 包含合并/跨行、列宽、多段单元格、字段、竖线、组合 Marks、Unicode、链接、资源与外部提示块；未知节点/Mark/属性及异常 Unicode 明确失败。                                                                                                                                        |
| 外部扩展                      | consumer 与 Studio 分别定义提示块、按钮、属性准入和输出；可编辑、保存重开并进入真实 PDF。缺 serializer 明确失败。                                                                                                                                                                       |
| Markdown 两端一致             | 同一字段/GFM 表格样本在无 DOM Node 与浏览器得到相同 JSON；代码中标签保留文字，非法字段/HTML 属性明确失败。受控 HTML 的部分/嵌套样式、字段样式和等价 CSS 往返通过；有损 Markdown 候选保留当前排版，粘贴一次撤销精确恢复。                                                                |
| LLM 接纳有界                  | 确定候选一次接纳/一次撤销；旧版本、权限变化、禁用节点、非法字段和复杂区域覆盖均保留当前文档；原生 transaction 被拒绝时不冒充成功。                                                                                                                                                      |
| 修订、错误与资源              | 一个在途请求和最新待处理快照，旧结果不发布；native 编译失败保留旧预览并拒绝旧图定位，修复后恢复；按明确成功修订导出 PDF。View/Editor/session 关闭、过期回调及临时树清理均有回归。                                                                                                       |
| 定位与 UTF-16                 | native 真实源码及 `_editor/` 区域分别双向定位；字符/原子/嵌套块映射与真实 native glyph 对接，正反向使用实际光标位置。映射精确绑定 snapshot，排他结束和非 BMP 列数有测试；生成文件不作为源码打开，异步打开后复核序号。                                                                   |
| 草稿、条件写入与快照          | InputStore raw/regions 统一 CAS、并发赢家保留、rename、坏草稿保留、模板修订冲突、保留路径冲突、私有树与源码 ZIP 隔离均已验证；未保存 data/regions 可预览，未保存源码不冒充当前输出。                                                                                                    |

## 实际检查

2026-10-23 本地 Linux 环境：

- Typst 全套：12 文件、87 项通过，包含严格排版准入、HTML 样式与 Markdown 损失、真实 PDF 字体和 PNG 颜色检查。
- Studio 全套：26 文件、156 项通过、1 项 Windows 专用 ACL 用例按平台跳过。
- Fonts 全套：4 文件、24 项通过；纯类型拆分后的 root/import 与真实 production Host 也通过，无 Workbench 服务，Fonts 与 Typst 都为 running，issues 为空，constructorRequires 精确指向 FontsPlugin。
- Typst、Fonts、Studio 类型检查通过；Typst 与 Studio 实际构建通过，最后 Studio 任务图 22/22 成功。
- 独立 consumer 全流程通过，61 次 native 编译、浏览器错误为零；本轮输出 `pluxel-typst-consumer-LimfmB/evidence/` 记录 strict/install/build、模块清单、Markdown/HTML 结果、原始草稿、字体注册/portable 快照、PDF/PNG、12 张编辑器和移动端截图与 native 测量。独立宿主通过公开 Fonts API 注册原字体字节；TTC 的 Skia 首 face 清单不替代 Typst 字体发现，两种实际字体选择均无 unknown-font 诊断。
- 变更范围 `vp check` 无格式、lint 或类型错误；catalog policy 一致，治理 35 package roots / 22 public packages 通过，治理测试 3 文件 30 项通过。
- Studio 完整 Electron 桌面验收通过，21 组流程包含正文、IME、表格、字体/字号/前景与背景颜色、清除排版保留加粗、候选与撤销、保存重开、双向定位，以及原有 Monaco completion/hover、诊断、PDF/ZIP 与退出清理。结果、正文 PDF 和截图位于 `projects/report-template-studio/test-results/desktop/`；`result.json` 记录每项通过结果。

复核时修复了实际接收方发现的缺口：根入口 transitive React/RPC 声明泄漏、ProseMirror null-prototype attrs 跨 CapnWeb 传输、生成 heading 的反向定位起点，以及受控粘贴与前一次编辑合并历史的问题。额外覆盖首次草稿读取与用户输入竞态。没有通过安装禁止依赖、跳过声明检查或改写错误内容绕过验收。

### 复跑入口

从仓库根按顺序构建，避免并发恢复同一依赖的 dist：

```sh
mise exec -- vp run @pluxel/plugin-typst#compile
mise exec -- vp run @report-template-studio/app#compile
mise exec -- node plugins/render/typst/tests/consumer.mjs
mise exec -- node projects/report-template-studio/tests/desktop.mjs
```

包内测试入口仍是各自 `test` / `typecheck` scripts，详见 [Studio 验证](../../projects/report-template-studio/README.md#验证)和 consumer README。直接运行 `vp test run --config vitest.config.ts` 不重新构建共享依赖。

性能仅记录实际样本，不作延迟保证：历史块级映射版本的 Studio 首轮客户服务报告测量包含两个区域、合并表格、字段和提示块，输出 1 页、5 个 block mapping；该 native 样本冷编译 256.80ms，纯数据 40.62ms，正文变化 72.91ms。本轮独立 consumer 的 61 次 native update/PDF 样本中，冷编译 2073.10ms（包含已注册 26.4MB Noto TTC 的首次字体发现与渲染），54 次正文编辑中位 7.15ms（5.10–872.36），6 次纯数据更新中位 6.66ms（5.19–14.49）；host 启动约 403.44ms、字体准备约 359.59ms、session open 约 30.30ms、浏览器到首个真实预览约 2620.27ms 分别记录。小样本数据不能外推大文档性能。

本轮没有调用付费模型，没有提交、推送、发布或改包版本。Typst 当前是 private 包，因此以实际构建制品验收，不伪造发布版本或 tarball；必要的公开 Fonts 修复已添加 patch Tegami。

尚未验证 Windows/macOS 桌面交互、其他浏览器与生产发布安装；不把 Linux Chromium/Electron 结果延伸为这些平台保证。任意 `.typ` 反向导入、通用 HTML→Typst、完整 Typst LSP、多人协作和模型供应商系统均不属于本轮交付。
