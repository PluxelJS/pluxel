# 隔离构建制品验收

2026-10-30 提交前复验，`PLUXEL_TYPST_CONSUMER_OUTPUT=/tmp/typst-source-review-artifact mise exec -- node plugins/render/typst/tests/consumer.mjs`：1/1 通过（37.64 秒），见 [执行结果](acceptance.txt)。

验收复制实际 dist/native 制品到仓库外，展开发布 dependency/export 协议，不加载工作区源码。纯编译入口的严格类型和导入在未安装 Tiptap/React 的环境通过；Node/Web 解析器运行时同样不加载它们。公开 parser WASM 资源 371384 字节，两个环境投影一致，无操作保存保持全部源字节。

随后安装明确的编辑 peer，真实无 DOM Editor 修改中文、跨文件改 label、拒绝旧修订、undo/redo 和从 files 重开通过。公开 React 文档示例通过严格类型，生产 Vite 包在共享 Chromium 中完成选区中文输入、源码撤销、保存与切换文件；插入菜单明确选择 JSON 绑定的模板组件，编辑参数后 undo/redo；插入真实 JSON 字段、更新数据并观察显示变化，再撤销数据修改。保存后执行页面重载，仅用普通 files 重建新项目，组件和字段仍可识别。

剪贴板验收对实际编辑器 schema 的四种源码节点逐个执行 `serializeForClipboard`、`DOMParser.fromSchema().parseSlice()` 和 `pasteHTML()`：未知行内表达式、未知块、环境声明、组件及字段的属性全部保留，完整源文件字节保持一致。解析结果在粘贴前独立比对，不能通过拒绝粘贴、保留旧文档来伪装成功。桌面和移动截图已检查，KaTeX、组件、字段与未知源码正常显示，无页面异常。

原生阶段由独立安装的 Core/Fonts/services/Typst 制品运行公开 Host，业务 Plugin 通过 constructor 注入 Typst。四次请求共享一个 session：成功修订 1、仅 JSON 修改后的修订 2、明确 COMPILE_FAILED（保留成功修订 2）、修复后的修订 3。公开 `session.update` 的本次耗时分别为 **157.402 / 7.550 / 4.781 / 5.358 ms**，不含 PDF 导出与 PNG 渲染；这是一次实测记录，不是性能保证。

实际 PDF/PNG 显示图表营收 80/40 → 120/60，合计 120 → 180；新插入的行内字段和「浏览器插入指标」组件同步变化，中文正文和未知表达式保持。另用独立 pypdf 6.21.3 读取三份交付 PDF：每份一页、三个内部链接，所有目标页存在，并从 PDF 文字确认组件、字段和图表数据。坏源码未产生成功 PDF。

[完整结果](summary.json)、[原生回执](native.json)、[独立 PDF 文字和链接检查](pdf-inspection.json)、[安装和执行日志](commands.txt)。[初始 PDF](native-0.pdf)、[JSON 更新后 PDF](native-1.pdf)、[修复后 PDF](native-3.pdf)。

此验收证明当前本机构建制品的隔离消费路径，不宣称已向 registry 发布或覆盖其它 OS/包管理器。网络安装和共享 Playwright 服务是复跑前提；字体使用 `PLUXEL_TYPST_TEST_FONT` 或本机 Noto Serif CJK 路径。其它 UI 能力由主浏览器消费者及其 source-check 验证。
