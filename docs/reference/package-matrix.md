---
title: Package 与入口矩阵
description: 区分公开包、仅供仓库内部使用的能力和不可直接导入的实现入口。
---

本页汇总了 Pluxel 官方包的功能分类、导出入口与公开可用状态。

## 公开发布的 npm 包

以下软件包公开发布在 npm 上，可直接作为项目的依赖引入：

| 软件包名 | 功能定位 | 指南文档 |
| :--- | :--- | :--- |
| `@pluxel/create` | 快速创建包含宿主、插件、前端与测试设施的脚手架 | [快速开始](../getting-started/index.md) |
| `@pluxel/core` | 插件核心模型、依赖图编排、生命周期与持久化状态 | [插件模型](../plugin-development/model.md) |
| `@pluxel/context` | 独立宿主的上下文能力组合与惰性初始化内核 | [组合 Context host](./context-hosts.md) |
| `@pluxel/services` | 官方基础服务集合（HTTP 路由、进程日志、命令与管理端点） | [组合 Host 服务](../host/services.md) |
| `@pluxel/workbench` | 控制台 Content、View 与 Attachment 定义及前端 SDK | [工作台视图](../workbench/view.md) |
| `@pluxel/host` | 宿主应用装配、静态/动态来源加载与运行策略 | [配置插件宿主](../host/configuration.md) |
| `@pluxel/host-vite` | 基于 Vite 的开发与生产运行支持、热更新与控制台驱动 | [CLI 与工具链](../development/tooling.md) |
| `@pluxel/cli` | 项目管理、脚手架、编译构建、发行物打包与工作区治理工具 | [CLI 与工具链](../development/tooling.md) |
| `@pluxel/rolldown` | 插件构建编译器、语义降阶转换器与源码静态分析接口 | [开发和发布插件包](../development/plugin-package.md) |
| `@pluxel/test` | 隔离测试宿主、Vitest 预设与测试夹具 | [插件测试](../plugin-development/testing.md) |
| `@pluxel/async` | 异步任务编排、并发池限制与重试工具库 | [Async 异步工具](../plugin-development/async.md) |
| `@pluxel/commands` | 命令系统声明、参数校验与 Cap'n Web / MCP 协议投影 | [Commands 命令](../plugin-development/commands.md) |
| `valibot-form` | 基于 Valibot 的表单元数据抽象与 Web 渲染适配器 | [Valibot 配置表单](../workbench/valibot-form.mdx) |
| `@pluxel/plugin-auth` | Workbench 与管理 API 鉴权服务插件 | [Management 认证](../plugins/auth.md) |
| `@pluxel/plugin-wretch` | 插件专属的类型安全 HTTP 客户端能力 | [Wretch HTTP 客户端](../plugins/wretch.md) |
| `@pluxel/plugin-playwright` | 外部 CDP / Playwright 浏览器自动化连接插件 | [浏览器连接](../plugins/browser.md) |
| `@pluxel/plugin-invoice` | 电子发票与财政票据图片解析提取插件 | [发票提取与查验](../plugins/invoice.md) |
| `@pluxel/plugin-fonts` | 服务端跨平台字体注册与管理插件 | [服务端字体](../plugins/rendering/fonts.md) |
| `@pluxel/plugin-canvas` | 基于原生 Skia 的服务端 Canvas 绘图与排版插件 | [服务端 Canvas](../plugins/rendering/canvas.md) |
| `@pluxel/plugin-echarts` | 基于 Worker 线程池的服务端 Apache ECharts 渲染插件 | [服务端 ECharts](../plugins/rendering/echarts.md) |
| `@pluxel/plugin-takumi` | JSX / HTML 图片矢量渲染与动画生成插件 | [Takumi 渲染](../plugins/rendering/takumi.md) |
| `@pluxel/plugin-takumi-markdown` | 支持 GFM 与代码高亮的 Markdown 转图片渲染插件 | [Markdown 图片渲染](../plugins/rendering/takumi-markdown.md) |

## 细粒度子路径导出

为了保持打包体积最小化，部分复杂能力包采用了按需子路径导出：
- **`@pluxel/services`**：
  - `@pluxel/services/elysia`：HTTP 路由与服务装配；
  - `@pluxel/services/database`：基于 Drizzle 的数据库服务；
  - `@pluxel/services/management`：管理端点与客户端会话；
  - `@pluxel/services/preset`：常用基础服务的一站式集成预设。
- **`@pluxel/core`**：
  - `@pluxel/core/fs`：文件系统抽象与存储后端；
  - `@pluxel/core/better-result`：标准类型化 Result 错误处理库；
  - `@pluxel/core/logging`：日志捕获与流式游标查询。

<span id="workspace-only-能力"></span>
## 工作区私有包（Workspace-Only）

以下包标记为 `private: true`，主要用于 Pluxel 官方工作区内部维护或源码联调开发：

| 软件包名 | 核心能力 | 文档入口 |
| :--- | :--- | :--- |
| `@pluxel/plugin-typst` | Typst 文档增量编译、矢量预览与 PDF 导出 | [Typst 文档](../plugins/rendering/typst.md) |
| `@pluxel/plugin-cache` | 细粒度业务缓存与 Single-flight 请求合并 | [缓存服务](../plugins/cache.md) |
| `@pluxel/plugin-rates` | 基于令牌桶的请求频率限制 | [请求频率控制](../plugins/rates.md) |
| `@pluxel/plugin-redis` | 共享 Redis 客户端与事务执行 | [Redis 客户端](../plugins/redis.md) |
| `@pluxel/plugin-storage` | 兼容 S3 协议的本地及远程对象存储 | [S3 对象存储](../plugins/storage.md) |
| `@pluxel/plugin-otel` | OpenTelemetry 遥测导出 | [OpenTelemetry](../plugins/otel.md) |
| `@pluxel/plugin-package-manager` | 动态 npm 插件包管理与离线安装 | [包管理器](../plugins/package-manager.md) |

若需在外部工程中使用这些私有包，请使用 `pluxel source` 命令建立跨仓源码关联。
