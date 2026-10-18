# `@pluxel/plugin-takumi-markdown`

将 GFM Markdown、表格、固定代码高亮与可选 Typst 数学渲染为图片或 SVG。

在直接导入它的包目录安装（catalog 工作区见下方指南）：

```sh
pnpm add @pluxel/plugin-takumi-markdown
```

宿主 catalog 包含 TakumiPlugin、TakumiMarkdownPlugin，并安装 NodeModules / Workers 服务。业务插件通过 constructor 注入 Markdown 能力，创建 `createRenderer({ extensions?, theme? })`，再用 `render(source, options)` 或 `renderSvg(source, options)` 取得 bytes / SVG string。最终渲染使用共享 Worker options；字体使用具体 bytes，远程图片需要显式 `images.allowRemote: true`。

扩展通过 `MarkdownExtensionContext.theme` 取得本次解析后的主题。源码工作区中存在运行的 TypstPlugin 时自动启用内置受限公式，通过其 stateless SVG API 复用编译、字体与 Worker；公式背景透明，前景色跟随文档主题。普通 Markdown 不要求安装 Typst；provider 变化会重启 Markdown 与下游并使旧 renderer 失效。

- [用法、配置与验证](../../../docs/plugins/rendering/takumi-markdown.md)
- [维护约束](DESIGN.md)

跨 renderer 的调度、输入所有权与取消规则见 [执行架构](../ARCHITECTURE.md)。
