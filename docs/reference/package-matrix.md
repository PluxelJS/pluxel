---
title: Package 与入口矩阵
description: 区分公开包、仅供仓库内部使用的能力和不可直接导入的实现入口。
---

先按你要完成的任务选包；插件作者从 `@pluxel/core` 和实际所需能力包开始，创建应用用 `@pluxel/create`，装配宿主使用 Host 与显式 service 列表。

本页说明各包的用途和公开入口。`private` 和 `exports` 决定源码中的导入边界；实际可安装版本以 npm registry 和发布记录为准。

## 公开包

| Package                         | 用途                                                       | 从哪里开始                                                  |
| ------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| `@pluxel/create`                | 创建包含宿主、插件、前端和测试的示例项目                   | [快速开始](../getting-started/index.md)                     |
| `@pluxel/context`               | 为独立宿主组合固定能力与惰性服务                           | [组合 Context host](./context-hosts.md)                     |
| `@pluxel/core`                  | 插件依赖、启动停止和资源生命周期                           | [Plugin 模型](../getting-started/plugin-model.md)           |
| `@pluxel/services`              | 官方服务、日志、管理面与应用组合                           | [组合 Host 服务](./runtime-services.md)                     |
| `@pluxel/workbench`             | Content、View、Attachment、浏览器 SDK 与官方 Shell         | [View](../workbench/view.md)                                |
| `@pluxel/vault-admin`           | 可选 Vault 管理 View                                       | [Vault](../runtime/vault.md)                                |
| `@pluxel/host`                  | catalog、运行意图、图更新与动态来源                        | [配置插件宿主](../getting-started/host-setup.md)            |
| `@pluxel/host-dev`              | 通用 Vite、HMR 与在线开发控制台                            | [CLI 与工具链](../development/tooling.md)                   |
| `@pluxel/cli`                   | 脚手架、构建、数据库、发行物、开发控制台与源码工作区命令   | [CLI 与工具链](../development/tooling.md)                   |
| `@pluxel/rolldown`              | Plugin 构建集成与源码查询                                  | [开发和发布插件包](../development/plugin-package.md)        |
| `@pluxel/test`                  | 统一插件测试 host、Vitest/Vite preset 与文件 fixture       | [测试 Plugin](../development/testing.md)                    |
| `@pluxel/async`                 | 零依赖 async 任务图与有界并发迭代                          | [Async 任务图与有界迭代](./async.md)                        |
| `@pluxel/commands`              | command 定义、校验、live registry 与 argv/message 参数路由 | [Commands](../runtime/commands.md)                          |
| `valibot-form`                  | Valibot 表单 metadata 与可选 Web adapter                   | [Valibot 配置表单](../workbench/valibot-form.mdx)           |
| `@pluxel/auth`                  | Workbench 与 Management API 认证 provider                  | [Management 认证](../plugins/auth.md)                       |
| `@pluxel/wretch`                | Plugin-owned HTTP client                                   | [Wretch HTTP client](../plugins/wretch.md)                  |
| `@pluxel/fonts`                 | 服务端字体注册与 provider                                  | [字体](../plugins/rendering/fonts.md)                       |
| `@pluxel/canvas`                | 有预算约束的服务端 Canvas、Pretext 文字准备与静态表格工具  | [Canvas](../plugins/rendering/canvas.md)                    |
| `@pluxel/echarts`               | 服务端 ECharts 渲染                                        | [ECharts](../plugins/rendering/echarts.md)                  |
| `@pluxel/takumi`                | 有预算约束的 HTML/node-tree 图片渲染                       | [Takumi](../plugins/rendering/takumi.md)                    |
| `@pluxel/takumi-markdown`       | 有预算约束的 GFM Markdown、表格与静态代码高亮图片渲染      | [Markdown / Typst](../plugins/rendering/takumi-markdown.md) |
| `@pluxel/takumi-markdown-typst` | 可选受限 Typst 数学 SVG Markdown extension                 | [Markdown / Typst](../plugins/rendering/takumi-markdown.md) |

这些 package 未标记为 private，并声明了面向消费者的入口。消费者只从 package `exports` 导入；版本可用性以 registry 和 release metadata 为准。

`@pluxel/services/management/client`、`/session` 和 `/protocol` 提供浏览器管理客户端、认证会话与 DTO；`/react` 只提供 React Context adapter。`@pluxel/workbench` 提供 browser-safe Content、Direct View 与 Attachment definition，`/client` 提供 Shell layout/opened-handle client，`/react` 提供 exact descriptor hook、host facade 与 Pane Kit。React 入口使用宿主提供的 singleton。RPC object model 直接从 `capnweb` 导入。

`@pluxel/commands/capnweb` 与 `@pluxel/commands/mcp` 分别把选定 Command 投影为原生 Cap’n Web 方法与 MCP Tool；适配器不安装 server 或会话，协议依赖按入口隔离。

宿主服务、preset 与开发附件的组合见[服务参考](./runtime-services.md)。开发脚本从 `@pluxel/host-dev/console` 导入 `defineDevConsole()`，调用方法见[devconsole](../development/dev-console.md)。

`@pluxel/services/http/node` 提供标准 Host launcher 使用的 Node srvx/crossws carrier 和 `listenHostHttp()`。`createHostHttpHandler()` 与 HTTP 服务共用 `@pluxel/services/http` 入口。Plugin 业务 HTTP 通过 `@pluxel/services/http` 的 owner capability 声明。`@pluxel/services/management/http` 将管理入口挂到所选 carrier；管理服务、Workbench publication 和浏览器 shell 都需显式选择。

源码查询从 `@pluxel/rolldown/inspect` 导入 `openProject()`，定位声明、依赖、配置和所选应用的输入；
不启动 Host 或执行应用模块，详见[inspect 源码查询](../development/inspection.md)。

## 同包的可选入口

`@pluxel/services/logging`、`/management`、`/preset`、`/vite` 与 `/build` 都属于 `@pluxel/services`；`@pluxel/host/dynamic` 属于 Host。安装包不等于启用所有领域：基础入口不加载未选择的日志、管理面、Workbench 或开发后端。浏览器协议、开发工具与服务安装器通过各自入口保持求值边界。

## Workspace-only 能力

以下 package 标记为 `private: true`，不能作为普通 npm 安装依赖。只有在支持这些包的源码 workspace 中才能集成；跨仓库联调先看[源码开发](../development/source-workspaces.md)：

| Package                   | 能力                                       | 文档                                             |
| ------------------------- | ------------------------------------------ | ------------------------------------------------ |
| `@pluxel/cache`           | owner-scoped cache、single-flight、backend | [缓存](../plugins/cache.md)                      |
| `@pluxel/rates`           | 按 identity 计费的频率限制                 | [请求频率控制](../plugins/rates.md)              |
| `@pluxel/redis`           | Redis client、script 与 backend            | [Redis](../plugins/redis.md)                     |
| `@pluxel/storage`         | local/remote object storage                | [对象存储](../plugins/storage.md)                |
| `@pluxel/otel`            | traces、metrics 与 exporters               | [OpenTelemetry](../plugins/otel.md)              |
| `@pluxel/package-manager` | dynamic host package 管理                  | [Package manager](../plugins/package-manager.md) |

仓库外项目不得把这些 package 视为可安装的公共依赖，也不得用源码相对路径绕过 package boundary。

## 实现入口

- 官方 Shell 源码位于 `packages/workbench/shell/`，与 Workbench SDK 同包维护，编译后作为静态资源交付。
- `@pluxel/host/internal*` 等带 `internal` 的 export 由框架自身使用，不承诺作者兼容性。

业务代码不得依赖这些实现入口。缺失的公开能力需要通过稳定 public contract 提供。
