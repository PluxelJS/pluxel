# 服务端渲染插件

`plugins/render/*` 按能力链归类 Pluxel 官方服务端渲染插件。这个目录只表达仓库分类；每个子目录仍是
独立安装、独立装配的普通插件 package，不存在隐式 catalog、聚合插件或额外作者 API。

当前依赖方向为：

```text
                  ┌─> @pluxel/canvas -> @pluxel/echarts
@pluxel/fonts ----┤
                  └─> @pluxel/takumi
```

- [`@pluxel/fonts`](fonts/README.md) 拥有进程内字体发现、注册、持久化和默认选择。
- [`@pluxel/canvas`](canvas/README.md) 提供有资源预算的原生 Canvas、SVG、图片和文字布局能力。
- [`@pluxel/echarts`](echarts/README.md) 将 Apache ECharts SSR 接入 Canvas、Fonts 和共享 worker lifecycle。
- [`@pluxel/takumi`](takumi/README.md) 消费 Fonts 的可移植资源，以有界 native async task 渲染 HTML/node tree。

业务插件只注入自己直接使用的 renderer 能力；required dependency 继续由各插件 constructor 唯一声明。
整体执行、输入所有权、预算、取消和并发规则见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。
