# `@pluxel/canvas`

有资源预算的 native Canvas、图片解码、Pretext 与静态表格。

在直接导入它的包目录安装（catalog 工作区见下方指南）：

```sh
pnpm add @pluxel/canvas
```

宿主 catalog 需要 FontsPlugin、CanvasPlugin；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../../docs/plugins/rendering/canvas.md)
- [维护约束](DESIGN.md)

跨 renderer 的调度、输入所有权与取消规则见 [执行架构](../ARCHITECTURE.md)。
