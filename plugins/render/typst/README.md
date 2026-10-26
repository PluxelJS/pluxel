# `@pluxel/plugin-typst`

Workspace 内的 Typst 文档插件，当前保持 private。`renderSvg(source, options)` 提供无状态 SVG；`open()` 提供多文件输入、独立 Worker 编译、同修订 Vector/PDF、按页 PNG 和 `await using` 会话。

正文以 Tiptap JSON 为权威。可选编辑器提供基础文字排版、对齐、图片、表格、题注、LaTeX 公式和结构化引用；Agent Markdown 编辑同一份正文，Typst 模板通过 `#include` 组合各区域，统一页面、间距、题注位置与编号。不会把任意 Typst 源码反解回正文，也不维护 Markdown 磁盘镜像。源码块保留显式安装的高级入口。

| 任务                                   | 入口                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| Node 编译、字体和会话生命周期          | [Typst 用法](../../../docs/plugins/rendering/typst.md)      |
| 编辑正文、题注、公式、引用或接入 agent | [区域编辑](../../../docs/plugins/rendering/typst-editor.md) |
| 查看双面板演示和运行验收               | [Consumer](tests/consumer/README.md)                        |
| 修改编译器、生成或编辑边界             | [实现设计](DESIGN.md)                                       |
| 准备固定原生绑定                       | [Native 构建](native/README.md)                             |
| 更新固定公式运行时                     | [MiTeX 来源与生成](vendor/mitex/README.md)                  |

服务端接入须注册 FontsPlugin，并由 Host 安装 NodeModules；无状态 SVG 另需 Workers。`standardServices()` / `servicesPreset()` 已包含这些服务，安装本包本身不会挂载它们。无需启用 Workbench 或 Persistence；仅管理字体的持久化需要 Persistence。

根入口供 native 服务端使用，`/template` 是纯文档定义，`/browser` 提供预览，`/tiptap` 与 `/tiptap/react` 提供正文能力。`/wasm` 是独立的纯浏览器内存文本编译入口，宿主显式提供 WASM、字体 URL 与本次附加文件；与 native 会话的差异见[浏览器编译](../../../docs/plugins/rendering/typst.md#浏览器编译)。
