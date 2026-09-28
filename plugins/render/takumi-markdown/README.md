# `@pluxel/takumi-markdown`

将 GFM Markdown、表格与固定代码高亮渲染为图片或 SVG。

在直接导入它的包目录安装（catalog 工作区见下方指南）：

```sh
pnpm add @pluxel/takumi-markdown
```

宿主 catalog 需要 FontsPlugin、TakumiPlugin、TakumiMarkdownPlugin；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../../docs/plugins/rendering/takumi-markdown.md)
- [维护约束](DESIGN.md)

跨 renderer 的调度、输入所有权与取消规则见 [执行架构](../ARCHITECTURE.md)。
