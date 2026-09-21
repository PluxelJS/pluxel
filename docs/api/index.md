---
title: API 设计与使用
description: 选择插件本地 API、浏览器 RPC 或 HTTP，并明确数据和资源的所有权。
---

给其他插件或客户端提供能力时，先确定调用边界，再决定返回数据还是可继续调用的对象。本目录解释当前 API 的选择与契约；完整接线继续使用各领域教程。

## 选择调用边界

| 调用方                   | 使用方式                                                      | 需要保证的边界                               |
| ------------------------ | ------------------------------------------------------------- | -------------------------------------------- |
| 同一 host 的其他 Plugin  | constructor dependency，调用领域方法                          | caller 归属、generation 撤回、返回对象所有权 |
| Workbench 页面           | fresh `RpcTarget` + View/Attachment                           | 当前授权、输入校验、per-open 资源清理        |
| 简单管理内容             | Content 的 data/action                                        | 有界展示数据、服务端表单校验                 |
| 独立业务 Web、外部客户端 | 自己的 HTTP application；确有需要时挂载独立 Cap’n Web session | 自己的认证、授权、连接与错误契约             |

Plugin 间本地调用不需要绕经 Workbench 或先序列化成 RPC DTO。业务能力应能在 Workbench 关闭时独立工作。DTO 是可传输的数据快照；capability 是允许调用某项能力的对象引用，两者的寿命不同。

## 按任务阅读

| 任务                                                   | 文档                                             |
| ------------------------------------------------------ | ------------------------------------------------ |
| 判断返回 snapshot 还是 handle，避免复制 API 类型和数据 | [契约、数据与资源](./contracts.md)               |
| 声明插件依赖与清理资源                                 | [插件模型](../getting-started/plugin-model.md)   |
| 编写页面 API 与 React 查询                             | [View](../workbench/view.md)                     |
| 复用另一个插件的界面                                   | [组合与 Attachment](../workbench/composition.md) |
| 缓存、订阅、取消与错误处理                             | [页面资源](../workbench/renderer-resources.md)   |
| 不写 React，展示状态和短操作                           | [Content](../workbench/content.md)               |
| 提供业务 HTTP API                                      | [HTTP](../runtime/http.md)                       |

这里维护选择规则和跨边界概念，不另抄一套方法签名、配置默认值或 Workbench 生命周期规范。具体 API 的行为以链接到的领域页为准。
