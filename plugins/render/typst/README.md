# `@pluxel/plugin-typst`

Workspace 内的 Typst 文档插件，当前保持 private。`renderSvg(source, options)` 提供无状态 SVG；`open()` 提供多文件输入、独立 Worker 编译、同修订 Vector/PDF、按页 PNG 和 `await using` 会话。

普通 `.typ` 保存正文，业务数据与图片分别保存为 JSON 与资源文件。完整工程可组合带保留式补丁的 Tiptap 编辑、Agent 源码事务、内容组件及 MiTeX。分章应用可选严格的 Typst 与 Tiptap 往返，人和 Agent 共享正文接纳。两条路径使用原生会话编译普通文件。

| 任务                                   | 入口                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| Node 编译、字体和会话生命周期          | [Typst 用法](../../../docs/plugins/rendering/typst.md)      |
| 编辑正文、题注、公式、引用或接入 agent | [源码编辑](../../../docs/plugins/rendering/typst-editor.md) |
| 查看双面板演示和运行验收               | [Consumer](tests/consumer/README.md)                        |
| 修改编译器、投影或编辑边界             | [实现设计](DESIGN.md)                                       |
| 准备固定原生绑定                       | [Native 构建](native/README.md)                             |
| 更新固定公式运行时                     | [MiTeX 来源与生成](vendor/mitex/README.md)                  |

服务端接入须注册 FontsPlugin，并由 Host 安装 NodeModules；无状态 SVG 另需 Workers。`servicesPreset()` 已包含这些服务，安装本包本身不会挂载它们。无需启用 Workbench；字体偏好与上传使用 Core 内建 TinyBase 和 FS，部署字体仍通过原生文件路径加载。

根入口供 native 服务端使用，`/template` 是纯文档定义，`/browser` 提供预览。`/source` 与 `/source/browser` 分别提供 Node/Web 源码工程，`/tiptap` 与 `/tiptap/react` 提供结构化源码视图。`/document` 的 `parseTypstDocument` 和 `printTypstDocument` 转换章节正文。`/tiptap/document` 与 `/tiptap/document/react` 编辑文档树，`/document/react` 消费页图与公开导航。 [章节正文编辑](../../../docs/plugins/rendering/typst-editor.md#按章节编辑正文)

`/wasm` 提供纯浏览器内存文本编译，宿主显式提供 WASM、字体 URL 与本次附加文件。 [浏览器编译](../../../docs/plugins/rendering/typst.md#浏览器编译)
