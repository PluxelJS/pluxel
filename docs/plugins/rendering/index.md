---
title: 服务端渲染 Plugin
description: 组合 Fonts、Canvas、ECharts 与 Takumi，在服务端生成图片和图表。
icon: Image
---

Pluxel 提供四个服务端渲染 package，按实际需要组合：

| Plugin            | 何时使用                                              |
| ----------------- | ----------------------------------------------------- |
| `@pluxel/fonts`   | 发现系统字体、注册随包字体或管理默认字体              |
| `@pluxel/canvas`  | 绘制位图与 SVG、解码图片或进行文字布局                |
| `@pluxel/echarts` | 使用 Fonts 和 Canvas 在 Worker 中生成 ECharts 图片    |
| `@pluxel/takumi`  | 使用 Fonts 可移植字体从 HTML/node tree 生成图片或 SVG |

只需要字体管理时安装 `@pluxel/fonts`；命令式绘图使用 Fonts 与 Canvas；服务端图表再加入 ECharts；
HTML/CSS 图片使用 Fonts 与 Takumi，不要求 Canvas/ECharts。具体配置和 API 见[服务端字体](./fonts.md)、
[服务端 Canvas](./canvas.md)、[服务端 ECharts](./echarts.md)和[Takumi HTML 图片渲染](./takumi.md)。
