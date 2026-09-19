---
title: Management 管理入口
description: 在独立 Host 中组合认证、管理投影与所选 HTTP carrier。
---

## 在独立 Host 中组合 Management

Management 现在由 `@pluxel/management` 提供。`managementAccess()` 安装认证权威，`management()` 在已有 Persistence 上安装管理投影，`managementHttp()` 将控制入口接入已选中的 HTTP carrier。三者都借用已存在的 Host，不创建物理 listener。

```ts
import { http } from '@pluxel/services/http'
import { persistence } from '@pluxel/services/persistence'
import { managementAccess } from '@pluxel/management/access'
import { management } from '@pluxel/management/service'
import { managementHttp } from '@pluxel/management/http'

const services = [
	http(),
	persistence({ mode: 'memory' }),
	managementAccess(),
	management(),
	managementHttp(),
]
```

自定义 carrier 可以借用 `createManagementEndpoint()`：HTTP 请求交给 `fetch()`，WebSocket 升级先调用 `prepareUpgrade()`，再将实际连接交给返回的 connection。可信地址、TLS 与 origin 来自 carrier；缺失时按未知处理，不从请求头推断。

关闭管理入口会关闭连接、取消认证交接，并使尚未进入 Host 执行队列的请求失效。已经接受的变更继续完成，不因浏览器断开而回滚。入口不拥有 Host 或 listener。Workbench 可将会话工厂与 artifact handler 绑定到同一入口，浏览器使用同一认证连接。`workbenchHttp()` 只安装 Shell，不隐式安装管理入口；完整的[显式组合示例](../workbench/standalone-host.md)同时声明 Workbench 准备依赖。官方 `servicesPreset()` 总是安装 `managementHttp()`，`workbench: false` 只关闭 Workbench。
