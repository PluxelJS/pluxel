# `@pluxel/takumi`

通过插件依赖使用 Takumi 原生 API，或在共享 Worker 中渲染 HTML、node tree 与业务 JSX 模板。

在直接导入它的包目录安装（catalog 工作区见下方指南）：

```sh
pnpm add @pluxel/takumi
```

宿主 catalog 包含 TakumiPlugin；业务插件通过 constructor 注入。`render`、`renderSvg`、`renderAnimation` 保留上游参数、返回值和错误。

`renderInWorker`、`renderSvgInWorker`、`renderAnimationInWorker` 使用已安装的 NodeModules / Workers 服务，只传可克隆的 HTML、node tree、CSS 与字体/图片 bytes。业务 JSX task 在 Worker 内构建组件，并从 `@pluxel/takumi/worker` 导入 `render`、`renderSvg` 或 `renderAnimation`，复用有界的线程内 Renderer 缓存。两种 Worker 用法都使用宿主共享线程池。

- [用法与验证](../../../docs/plugins/rendering/takumi.md)
- [维护约束](DESIGN.md)

跨 renderer 的调度、输入所有权与取消规则见 [执行架构](../ARCHITECTURE.md)。
