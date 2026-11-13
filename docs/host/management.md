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

## 开启上传脚本

`managementHttp({ scripts: true })` 显式允许已认证的管理员向 Node Host 上传并执行脚本；使用官方预设时传 `servicesPreset(startup, { scripts: true })`。默认关闭时，Runtime Session 只返回管理能力，不加载 Node 脚本 owner、求值器或执行队列。Workbench 与脚本使用同一套 Host 配置及生命周期实现。

脚本在应用进程和真实 Host 上运行，具备该进程的权限。启用这项能力意味着信任获得管理认证的脚本作者。Vite 中的项目脚本由 `host({ scripts: true })` 开启，加载项目模块，与 Node 上传制品共用 SDK 和执行内核。

客户端先经原生 Runtime Session 认证取得可选的 `execution` capability，再通过 Cap’n Web 提交、查询或取消；SDK 调用留在应用进程。同一认证主体重新连接后可用原回执查询运行，关闭连接不会取消已经接纳的任务。撤回认证提供者、替换凭据或显式退出会取消相关主体的任务；取消仍要等待已经开始的实际工作结算，失败和取消都不会自动回滚或重新提交。提供者的 `authorizationSignal` 表达凭据撤回寿命，独立于连接与 provider session 的释放。

CLI 凭据从 `--credentials-file` 的 JSON 文件读取：密码模式用 `{ "password": "..." }`，TOTP 用额外的 `"code"`，已完成浏览器登录的会话可提供 `"cookie"`。CLI 在首次上传前输出并可保存只包含目标、运行标识和内容指纹的回执；查询和取消使用原回执。[完整 SDK、CLI 与资源释放示例](../development/scripts.md)。

## 读取管理状态快照

通过管理客户端可以查询当前宿主所有插件的实时拓扑与运行状态：

- 插件状态快照返回只读的不可变对象，可直接在 React 或外部监控系统中消费；
- 状态中包含了每个插件节点的地址（NodeAddress）、期望状态（DesiredState）以及当前生命周期状态（LifecycleState）；
- 如果插件启动失败，快照中将完整附带详细的失败原因与堆栈信息。
