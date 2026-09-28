# `@pluxel/takumi`

使用可移植字体，把 HTML / node tree 渲染为图片或 SVG。

在直接导入它的包目录安装（catalog 工作区见下方指南）：

```sh
pnpm add @pluxel/takumi
```

宿主 catalog 需要 FontsPlugin、TakumiPlugin；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../../docs/plugins/rendering/takumi.md)
- [维护约束](DESIGN.md)

跨 renderer 的调度、输入所有权与取消规则见 [执行架构](../ARCHITECTURE.md)。
