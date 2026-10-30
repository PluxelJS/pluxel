# `@pluxel/plugin-typst`

Workspace 内的 Typst 文档插件，当前保持 private。`renderSvg(source, options)` 提供无状态 SVG；`open()` 提供多文件输入、独立 Worker 编译、同修订 Vector/PDF、按页 PNG 和 `await using` 会话。

普通 `.typ` 文件是正文权威，业务数据和图片分别保存为 JSON 与资源文件。人通过可选 Tiptap 视图编辑，Agent 直接修改同一份源码；项目事务统一补丁接纳、跨文件引用和撤销重做。支持基础文字排版、对齐、图片、表格、富题注、LaTeX 与原生数学、模板参数和数据绑定；未知语法原位保留并提供源码入口。完整文件快照继续由原有 Typst 会话编译。

| 任务                                   | 入口                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| Node 编译、字体和会话生命周期          | [Typst 用法](../../../docs/plugins/rendering/typst.md)      |
| 编辑正文、题注、公式、引用或接入 agent | [源码编辑](../../../docs/plugins/rendering/typst-editor.md) |
| 查看双面板演示和运行验收               | [Consumer](tests/consumer/README.md)                        |
| 修改编译器、投影或编辑边界             | [实现设计](DESIGN.md)                                       |
| 准备固定原生绑定                       | [Native 构建](native/README.md)                             |
| 更新固定公式运行时                     | [MiTeX 来源与生成](vendor/mitex/README.md)                  |

服务端接入须注册 FontsPlugin，并由 Host 安装 NodeModules；无状态 SVG 另需 Workers。`standardServices()` / `servicesPreset()` 已包含这些服务，安装本包本身不会挂载它们。无需启用 Workbench 或 Fs；仅管理字体的持久化需要 Fs。

根入口供 native 服务端使用，`/template` 是纯文档定义，`/browser` 提供预览；这些入口不加载编辑器或解析器。`/source` 和 `/source/browser` 分别提供 Node/Web 源码项目，`/tiptap` 与 `/tiptap/react` 提供结构化编辑视图。`/wasm` 是独立的纯浏览器内存文本编译入口，宿主显式提供 WASM、字体 URL 与本次附加文件；与 native 会话的差异见[浏览器编译](../../../docs/plugins/rendering/typst.md#浏览器编译)。
