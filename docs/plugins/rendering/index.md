---
title: 服务端渲染 Plugin
description: 组合 Fonts、Canvas 与 ECharts，在服务端生成图片和图表。
icon: Image
---

Pluxel 提供三个服务端渲染 package，按依赖链组合：

| Plugin            | 何时使用                                           |
| ----------------- | -------------------------------------------------- |
| `@pluxel/fonts`   | 发现系统字体、注册随包字体或管理默认字体           |
| `@pluxel/canvas`  | 绘制位图与 SVG、解码图片或进行文字布局             |
| `@pluxel/echarts` | 使用 Fonts 和 Canvas 在 Worker 中生成 ECharts 图片 |

只需要字体管理时安装 `@pluxel/fonts`；需要绘图时安装 Fonts 与 Canvas；需要服务端图表时安装三者。具体配置和 API 分别见[服务端字体](./fonts.md)、[服务端 Canvas](./canvas.md)和[服务端 ECharts](./echarts.md)。
