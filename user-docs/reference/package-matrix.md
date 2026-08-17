---
title: Package 与入口矩阵
description: 区分公开包、仅供仓库内部使用的能力和不可直接导入的实现入口。
---

# Package 与入口矩阵

本页说明仓库中每个包允许如何使用，不代表它已经发布到 npm。`private` 和 `exports` 决定源码中的导入边界；实际可安装版本以 npm registry 和发布记录为准。

## 公开包

| Package                   | 用途                                                     | 从哪里开始                                           |
| ------------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| `@pluxel/core`            | 最小 Plugin 图、DI、generation lifecycle 与基础 services | [Plugin 模型](../getting-started/plugin-model.md)    |
| `@pluxel/runtime`         | Plugin、生命周期、配置、HTTP、日志和宿主共享契约         | [第一个 Plugin](../getting-started/index.md)         |
| `@pluxel/runtime-static`  | 使用固定 Plugin catalog 的宿主                           | [配置插件宿主](../getting-started/host-setup.md)     |
| `@pluxel/runtime-dynamic` | 组合固定 catalog 与 mutable file sources 的宿主          | [配置插件宿主](../getting-started/host-setup.md)     |
| `@pluxel/cli`             | 脚手架、构建、数据库、发行物、HMR 与源码工作区命令       | [CLI 与工具链](../development/tooling.md)            |
| `@pluxel/rolldown`        | Plugin package 与 static application 构建集成            | [开发和发布插件包](../development/plugin-package.md) |
| `@pluxel/test`            | 经过真实语义转换的 Plugin 测试 harness                   | [测试 Plugin](../development/testing.md)             |
| `@pluxel/commands`        | command registry、CLI/Agent 投影与参数路由               | [Commands](../runtime/commands.md)                   |
| `valibot-form`            | Valibot 表单 metadata 与可选 Web adapter                 | [Valibot 配置表单](../workbench/valibot-form.mdx)    |
| `@pluxel/wretch`          | Plugin-owned HTTP client                                 | [Wretch HTTP client](../runtime/wretch.md)           |
| `@pluxel/fonts`           | 服务端字体注册与 provider                                | [字体](../rendering/fonts.md)                        |
| `@pluxel/canvas`          | 有预算约束的服务端 Canvas                                | [Canvas](../rendering/canvas.md)                     |
| `@pluxel/echarts`         | 服务端 ECharts 渲染                                      | [ECharts](../rendering/echarts.md)                   |

这些 package 未标记为 private，并声明了面向消费者的入口。消费者只从 package `exports` 导入；版本可用性以 registry 和 release metadata 为准。

## Workspace-only 能力

以下 package 标记为 `private: true`，仅供当前 workspace 集成：

| Package                   | 能力                                       | 文档                                                 |
| ------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| `@pluxel/cache`           | owner-scoped cache、single-flight、backend | [缓存](../runtime/cache.md)                          |
| `@pluxel/rates`           | 按 identity 计费的频率限制                 | [请求频率控制](../runtime/rates.md)                  |
| `@pluxel/redis`           | Redis client、script 与 backend            | [Redis](../runtime/redis.md)                         |
| `@pluxel/storage`         | local/remote object storage                | [对象存储](../runtime/storage.md)                    |
| `@pluxel/otel`            | traces、metrics 与 exporters               | [OpenTelemetry](../runtime/otel.md)                  |
| `@pluxel/package-manager` | dynamic host package 管理                  | [Package manager](../development/package-manager.md) |

仓库外项目不得把这些 package 视为可安装的公共依赖，也不得用源码相对路径绕过 package boundary。

## 不应成为用户入口的 package

- `@pluxel/context` 是 runtime 的 Context 实现细节。
- `@pluxel/runtime-dev` 是开发支持层。
- `@pluxel/workbench-app` 是组装后的应用，不是 Plugin UI SDK。
- `@pluxel/runtime/internal*` 等带 `internal` 的 export 由框架自身使用，不承诺作者兼容性。

业务代码不得依赖这些实现入口。缺失的公开能力需要通过稳定 public contract 提供。

## 选择规则

1. 写 Plugin 时从 `@pluxel/runtime` 和一个明确的能力 package 开始。
2. 装配宿主时选择 static 或 dynamic runtime，不在业务 Plugin 中依赖宿主实现。
3. 测试使用 `@pluxel/test` 或 runtime 提供的公开 test subpath，不直接 new 内部 host。
4. 导入路径必须存在于所安装版本的 `exports`，且目标 package 不能是 private。
5. `package.json#exports` 与真实源码 export 是入口契约；文档必须与该契约保持一致。
