---
title: 使用与排查工作台
description: 查看依赖、定位启动和更新失败，以及部署 Workbench 时的连接要求。
---

本页面向运行应用的人：先在插件详情确认当前状态，再查看最近更新和依赖。
给 Plugin 编写页面请从 [Content](./content.md) 或 [View](./view.md) 开始。

## 从现象定位问题

| 现象                 | 下一步                                                     |
| -------------------- | ---------------------------------------------------------- |
| 插件没有运行         | 查看自动启动策略、配置校验和必须依赖                       |
| 修改源码后出现错误   | 对照当前状态与最近更新，确认是保留旧定义还是新实例启动失败 |
| 自定义页面显示构建中 | 等待构建完成；失败时按该页面显示的错误修复 renderer        |
| 页面提示会话失效     | 完整刷新页面，再重新打开插件页面                           |
| 保存配置后行为未变   | 检查保存结果；未注册在线更新处理时需要显式重启             |

## 内置依赖管理

插件概览用同一张「依赖管理」卡片展示必须依赖、可选集成、提供的能力和被依赖关系。依赖抽象能力时，
依赖行同时显示需求与实际实现，例如 `Cache → CachePlugin`。

- **当前插件使用**：只设置当前插件的这条必须依赖。具体插件的「默认实例」使用该插件的默认节点；
  抽象能力的「跟随全局默认」使用该能力的全局默认实现。手动指定实现或 Fork 后，显示「当前插件指定」。
- **提供的能力 / 全局默认实现**：设置该抽象能力的默认提供者，影响所有未单独指定实现的消费者。
  当前插件就是该默认实现时，显示「全局默认提供者」。

单独指定的实现优先于默认选择；恢复默认会移除当前插件的覆盖。修改依赖可能重启受影响的插件及其下游。
修改后，工作台刷新依赖图和已打开的依赖编辑器，未打开的编辑器在下次打开时读取最新设置。

## 内置 Plugin 目录诊断

目录行优先显示插件名称，不重复铺开包名、HMR badge 或运行状态文字。小菱形表示更新类别，小圆点表示运行状态；
悬浮或键盘聚焦指示器可查看具体说明；悬浮或聚焦插件名称会按行展示完整名称、来源、导出、状态、更新方式和 canonical reference。
分组标题只显示淡色数量，悬浮可查看运行数量；
更新异常仍保留警告图标。完整执行与来源信息在插件详情中展开查看。

来源取自插件定义，不会因为没有 HMR 信息而变成“未知来源”；静态内置插件也可能使用构建模块，来源与是否 HMR 是两件事。

Plugin 详情默认只展示简短说明（有则显示）、状态和来源。来源旁可以复制插件引用；执行方式、制品、更新边界、启动策略与
最近更新放在默认折叠的“调试信息”中，没有更新记录时不显示空占位。“复制诊断信息”可一次复制引用、执行和更新事实、
运行状态及问题代码，便于排查；不会复制 Vite module ID、绝对文件路径或包安装目录。

工作台分别显示当前运行状态、本插件上次更新记录和所属更新批次。一次应用或插件批次更新可以已提交，
同时只有部分插件的生命周期失败；正常插件不会因此标红。具体错误按插件节点归属，包含失败阶段、原因和阻塞它的依赖；
同一插件的不同 fork 分别记录。资源清理异常也属于上次更新历史，不能据此推断新实例没有运行。

“未报告生命周期”表示该次更新没有这个节点的完整执行报告，不代表启动成功。已修复的运行问题不会改写历史；
是否已恢复应看当前状态。调试信息保留所属批次的范围、结果和序号，便于关联同次更新。提交前失败会说明保留旧定义，
应用重载失败后成功创建补偿宿主会说明使用上一应用定义恢复。

自定义管理客户端分别读取 `recentUpdate.batch` 和 `recentUpdate.lifecycle`：前者记录更新批次结果，
后者记录本插件的历史生命周期问题。`lifecycle: null` 表示未报告；`{ issues: [] }` 表示该批未报告异常。
判断插件是否可用仍需读取当前运行状态。

“目录 HMR”表示应用模块图变化时热替换插件目录；入口或应用配置边界变化仍需重建应用。外部包通常显示“入口 HMR”：
替换插件入口可以触发更新，但不会监听包内部源码；只有确认源码在监听图中时才显示“源码 HMR”。制品信息无法确定时显示“未报告”，
不从扩展名或包路径猜测。

正常切换插件、日志等路由不会重建整个工作台。切到另一插件时只重置对应插件的表单和视图，同一插件子路由保留工作台状态；
会话失效或插件发布更新导致的完整刷新仍遵循原有生命周期规则。

单个页面渲染失败会在对应编辑区显示错误与“重试”，其他编辑区和工作台导航保持可用。标签、分栏和布局变化会合并保存到浏览器本地，
切到后台或离开页面时补写待保存的布局；这不保存未提交的插件配置或表单草稿。

目录搜索支持以下字段；多个 token 使用 AND：

- 普通关键词：名称、定义位置、导出名、canonical reference 和 execution 词；
- `@包名`：只匹配 definition address 中的 package name；
- `ref:关键词`：只匹配 canonical reference；
- `exec:关键词`：只匹配制品、更新方式和最近结果，例如 `hmr`、`entry-only`、`bundle`、`restored-previous` 或“失败”。

## 生命周期和故障

同一 document 只有一条 `/__pluxel/runtime/session` WebSocket。认证 challenge、Management、Workbench layout、
Plugin API 和 observer 都复用这个 Cap’n Web session。认证或 publication epoch 失效、socket broken 时，页面要求完整
reload；不会在原 document 内切换 transport、重连一部分功能或复用旧 API root。

MF2 manifest 和 JS/CSS 仍通过 HTTP 获取；Content plan 则随现有 `openEntry()` RPC 返回，不增加浏览器 artifact
fetch。浏览器写入 `HttpOnly` cookie 还有一个 single-use cookie-commit POST。这些端点不承载 Workbench RPC。

Plugin stop/replacement 会撤销 publication，并使当前 socket epoch 失效。Shell 销毁所有 active Bridges、释放 opened
handles，再要求整页 reload。开发期 Content/topology 可以先发布，缺失 producer 在后台构建；未就绪或失败的 View/Attachment
placement 会保留在原位置并显示构建中或构建失败状态，producer 成功提交后触发 reload。Production/static build 仍要求
Content/MF candidate 全部验证并原子提交后才生效。

Bridge destroy 也会关闭 per-open renderer owner：私有 `QueryClient`、subscription 与 active mutation lifetime 一次清理。Pending
`refetch()` / `mutateAsync()` 会以 closed error 及时拒绝；无法取消的 RPC 可以在后台 settle，但晚到的 fulfilled DTO 仍会
detach/dispose，且不会再更新已关闭页面。Portable/scope/key/limit/closed 与 mutation-pending 错误提供稳定 code；Plugin
自己的领域/RPC error 保持原样。

Plugin 启停命令的 `ok: true` 表示运行意图与 graph commit 已应用，不保证每个 `init()` 或 drain 都成功。Workbench 会继续读取
`report.core.summary.lifecycleReport`：目标 Plugin 有结构化 lifecycle issue 时直接显示该 issue 的安全 message；只有 report 没有
可解释当前节点的 issue、但观察状态尚未达到目标时，才显示“运行状态仍未收敛”的协调提示。

## Vite 与反向代理

Static/dynamic Vite adapter 在 Vite 自己的 Node listener 上接入 Runtime HTTP/Upgrade，并先让 Vite HMR socket 匹配；开发者
不需要为 Workbench 再启动或代理一个端口。

生产反向代理只需保留同源路径并正确转发 WebSocket Upgrade：Workbench document、`/__pluxel/` HTTP endpoints、MF assets
和 `/__pluxel/runtime/session` 应到达同一个 Runtime deployment。Runtime 不相信 `Forwarded` / `X-Forwarded-*` 推断
physical TLS 或 locality。内建 production Node launcher 只监听 HTTP，因此默认只通过 loopback/SSH tunnel 管理，不通过普通
TLS 反代开放 remote Management，反代也不应从 loopback 地址回源。需要 remote Management 的平台集成必须提供自身能证明
HTTPS 的 application carrier。多实例部署还需要让 control socket、OIDC callback 和短期 cookie ticket 命中签发它们的实例。
