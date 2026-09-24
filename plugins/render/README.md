# 服务端渲染插件

各子目录都是独立 Plugin package。按输出选择和安装见 [渲染指南](../../docs/plugins/rendering/index.md)，
共同的输入所有权、预算、执行位置与取消规则见 [执行架构](ARCHITECTURE.md)。

| 维护范围                          | 包内约束                                 |
| --------------------------------- | ---------------------------------------- |
| 字体资源与默认选择                | [Fonts](fonts/DESIGN.md)                 |
| Native Canvas、Pretext 与静态表格 | [Canvas](canvas/DESIGN.md)               |
| Worker 图表渲染                   | [ECharts](echarts/DESIGN.md)             |
| HTML / node tree 原生渲染         | [Takumi](takumi/DESIGN.md)               |
| Markdown 文档准备                 | [Markdown](takumi-markdown/DESIGN.md)    |
| 可选受限数学编译                  | [Typst](takumi-markdown-typst/DESIGN.md) |
