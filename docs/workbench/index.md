---
title: 给插件添加管理界面
description: 按任务选择配置表单、Markdown 操作页、React 页面或可复用界面。
---

Workbench 是应用自带的管理工作台。普通插件已经可以在这里查看状态、编辑配置、调整依赖和查看日志；
需要额外业务操作时，再为它添加页面。业务能力应由 Plugin 自己提供，关闭工作台后仍能运行。

## 如何选择

| 你要做什么                             | 从这里开始                                                        |
| -------------------------------------- | ----------------------------------------------------------------- |
| 编辑普通配置，例如地址、并发数和开关   | [声明配置](../getting-started/configuration.md)，自动生成标准表单 |
| 展示说明、状态、按钮或一次性表单       | [Content：无需 React 的操作页](./content.md)                      |
| 自定义布局、分页、流式输出或长任务     | [View：React 管理页面](./view.md)                                 |
| 在另一个插件中使用已有的设置页或选择器 | [Attachment：复用插件界面](./composition.md)                      |
| 调整插件列表的分组和顺序               | [插件分组](./plugin-groups.md)                                    |
| 排查插件启动、更新或工作台连接问题     | [使用与排查工作台](./operations.md)                               |

例如连接状态和 PING 按钮用 Content；有流式输出和取消操作的 Agent 会话用 View。
普通配置直接复用标准表单。密钥存入 [Vault](../runtime/vault.md)，配置只保存引用；
已有明确写入或轮换流程的一次性凭据表单可以用 Content，多步骤登录和恢复流程使用 View。

## 先确认工作台可用

从新建应用模板开始时，运行 `pnpm dev`，打开终端输出的 Workbench 地址。
现有宿主按[宿主配置](../getting-started/host-setup.md#选择组合)启用 Workbench，
并安装它要求的浏览器依赖。先确认插件已经运行，再检查自定义标签是否出现。

新增页面通常只需要三步：

1. 在 Plugin 包中用 `workbench.define()` 声明固定的页面列表。
2. 在 Plugin 的 `init()` 中调用一次 `this.ctx.workbench?.publish()`，提供页面需要的业务操作。
3. 打开页面并执行一次读取或按钮操作，关闭后确认订阅和长任务得到清理。

`?.` 允许同一个 Plugin 在没有工作台的宿主中继续运行。页面声明与发布代码的 key 必须一致。
这里的“声明”描述有哪些页面；订单、账号、字体集合等动态数据由 API 返回，不按每条记录新建页面声明。

## 继续实现或排错

页面 API 返回有界普通数据，资源型结果声明清理责任；具体规则见 [API 契约](../api/contracts.md)。
页面的 route、参数、宿主能力和布局见 [View](./view.md)，查询、写入与订阅见[页面资源](./renderer-resources.md)。
宿主接入官方 Shell、管理连接或自定义 Vite 附件见[独立 Host](./standalone-host.md)。

生产构建还需验证 Content 与 React 制品；页面能在开发环境打开，不代表发布包已经包含这些资源。
运行中的应用通过[开发控制台](../development/dev-console.md)检查，隔离回归使用[测试宿主](../development/testing.md)。
