---
title: Management 管理服务
description: 装配宿主管理接口、权限认证与状态快照服务。
---

`@pluxel/services/management` 提供了宿主底层的管理与自省能力。它是 Workbench 界面与远程控制台的数据源，负责向客户端提供插件状态快照、配置修改与控制指令。

## 组装管理服务

在需要自定义管理通道的独立宿主中，可以组合以下核心模块：

```ts
import { elysia } from '@pluxel/services/elysia'
import { managementAccess } from '@pluxel/services/management/access'
import { management } from '@pluxel/services/management/service'
import { managementHttp } from '@pluxel/services/management/http'

const services = [
	elysia(), // 底层 Web 服务
	managementAccess(), // 访问控制与认证鉴权
	management(), // 核心状态投影服务
	managementHttp(), // 将管理接口挂载至 HTTP 路径
]
```

官方的 `servicesPreset()` 默认已经包含了这套管理服务。当在预设中设置 `workbench: false` 时，Workbench 前端界面将被禁用，但底层轻量的 Management API 仍可用于自动化脚本和远程管理。

## 读取管理状态快照

通过管理客户端可以查询当前宿主所有插件的实时拓扑与运行状态：

- 插件状态快照返回只读的不可变对象，可直接在 React 或外部监控系统中消费；
- 状态中包含了每个插件节点的地址（NodeAddress）、期望状态（DesiredState）以及当前生命周期状态（LifecycleState）；
- 如果插件启动失败，快照中将完整附带详细的失败原因与堆栈信息。
