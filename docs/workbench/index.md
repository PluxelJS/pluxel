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
现有宿主按[宿主配置](../getting-started/host-setup.md#workbench-与-management-access)启用 Workbench，
并安装它要求的浏览器依赖。先确认插件已经运行，再检查自定义标签是否出现。

新增页面通常只需要三步：

1. 在 Plugin 包中用 `workbench.define()` 声明固定的页面列表。
2. 在 Plugin 的 `init()` 中调用一次 `this.ctx.workbench?.publish()`，提供页面需要的业务操作。
3. 打开页面并执行一次读取或按钮操作，关闭后确认订阅和长任务得到清理。

`?.` 允许同一个 Plugin 在没有工作台的宿主中继续运行。页面声明与发布代码的 key 必须一致。
这里的“声明”描述有哪些页面；订单、账号、字体集合等动态数据由 API 返回，不按每条记录新建页面声明。

## Host-rendered Content

Content 使用 Markdown 排版，用 slot 插入数据或操作。宿主统一显示，不需要单独编写前端组件。
完整示例、表单和 Markdown 支持范围见 [Content](./content.md)。

## 完整 View 参考：server push 与 custom callback

先完成 [View 的读取与刷新示例](./view.md)。后台变化需要通知页面时，再查该页后半部分的订阅示例。
`query`、`mutation`、错误恢复与数据限制集中在 [页面资源参考](./renderer-resources.md)。

## Placement 与参数化 route

`workbench.tab()` 将页面放到插件详情；`workbench.route()` 提供独立地址。
同一个编辑器需要打开不同账号时，声明一个 `/accounts/:accountId` 路由，由服务端匹配参数。
完整写法见 [页面位置和参数](./view.md#placement-与参数化-route)。

## Attachment

Attachment 让提供界面的插件维护 UI 和 API，使用界面的插件决定把它放在哪里。
例如 FontsPlugin 维护字体选择器，Canvas 在自己的详情页放置它。
从 [复用插件界面](./composition.md)选择单方 API 或双方 API 的写法。

## 内置依赖管理

工作台可以设置当前插件使用的实现，也可以设置抽象能力的全局默认提供者。
两者的影响范围及刷新行为见 [依赖管理](./operations.md#内置依赖管理)。

## 内置 Plugin 目录诊断

当前运行状态与最近一次更新是两类信息：更新曾失败，不代表插件现在仍不可用。
查看来源、更新记录、搜索语法和复制诊断的方法见 [目录诊断](./operations.md#内置-plugin-目录诊断)。

## API 设计准则

页面只取得完成当前任务所需的方法。读取返回普通数据，大列表分页；写入通常返回 `void` 并触发重读，
只有页面确实消费结果时才返回数据。需要取消或进度的长任务应明确自己的释放方式。
不向浏览器返回 Plugin 实例、Context、数据库连接或原始 socket。

## Host 能力

React 页面可从 `scope.useWorkbench()` 取得 `host`，使用通知、确认、外观、相对导航和当前文档信息。
自定义三栏布局使用 Pane Kit。示例与限制见 [页面中的宿主能力](./view.md#host-能力)。

## 生命周期和故障

每次打开页面都会创建独立 API 与页面状态，关闭、插件重启或会话结束时一起释放。
插件更新或会话失效可能要求完整刷新，页面不能继续使用旧 API。
开发期页面显示“构建中”或“构建失败”的含义见 [生命周期和故障](./operations.md#生命周期和故障)。

## Vite 与反向代理

开发期业务应用与工作台共用 Vite 的端口。部署时还需正确处理 WebSocket、同源路径和管理访问权限，
详见 [Vite 与反向代理](./operations.md#vite-与反向代理)。

## 验证清单

- Plugin 能在关闭 Workbench 后正常提供业务能力。
- 打开页面能读取真实状态；一次操作成功后界面显示最新结果，失败时给出可理解的提示。
- 关闭页面后不再更新已卸载组件，订阅和任务得到释放。
- 项目的类型检查和生产构建通过；生产产物中保留所需 Content 或 React 页面资源。
- 运行中的应用使用[开发控制台](../development/dev-console.md)检查真实实例；隔离测试用于回归覆盖。
