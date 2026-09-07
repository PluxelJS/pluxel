---
title: 服务端渲染 Plugin
description: 组合 Fonts、Canvas、ECharts、Takumi 与 Markdown，在服务端生成静态图片和图表。
icon: Image
---

先按输出内容选择一个 renderer，再安装它需要的字体或绘图依赖。已有应用从下表进入示例；还没有项目先完成 [快速开始](../../getting-started/index.md)。生成结果是图片字节或 SVG，保存文件、发送附件和 HTTP 响应由业务插件完成。

## 选择输出方式

| Plugin                                               | 何时使用                                              |
| ---------------------------------------------------- | ----------------------------------------------------- |
| [Fonts](./fonts.md)                                  | 发现系统字体、注册随包字体或管理默认字体              |
| [Canvas](./canvas.md)                                | 绘制位图与 SVG、解码图片、进行文字布局或生成静态表格  |
| [ECharts](./echarts.md)                              | 使用 Fonts 和 Canvas 在 Worker 中生成 ECharts 图片    |
| [Takumi](./takumi.md)                                | 使用 Fonts 可移植字体从 HTML/node tree 生成图片或 SVG |
| [Markdown](./takumi-markdown.md)                     | 将 GFM Markdown、表格和固定代码高亮渲染为 Takumi 图片 |
| [Typst 数学](./takumi-markdown.md#可选的-typst-数学) | 可选地把受限数学公式编译为 Markdown 中的 SVG 数学资产 |

只需要字体管理时安装 `@pluxel/fonts`；命令式绘图使用 Fonts 与 Canvas；服务端图表再加入 ECharts；
HTML/CSS 图片使用 Fonts 与 Takumi，不要求 Canvas/ECharts。需要文档、GFM 表格或静态代码块时再加 Markdown；需要受限数学时才加 Typst。
具体配置和 API 见[服务端字体](./fonts.md)、[服务端 Canvas](./canvas.md)、[服务端 ECharts](./echarts.md)、
[Takumi HTML 图片渲染](./takumi.md)和[Markdown / Typst 图片渲染](./takumi-markdown.md)。
