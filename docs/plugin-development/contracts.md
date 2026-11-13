---
title: 契约、数据与资源
description: 区分本地插件方法、RPC 传输数据与远程资源引用，规范接口契约与生命周期归属。
---

在设计插件公开接口或 Workbench 扩展视图时，首要的是区分两类返回值：

- **纯数据（Data / Snapshot）**：只包含业务快照或操作回执，通常可以安全序列化、缓存并渲染在界面上；
- **资源能力（Capability / Resource Handle）**：代表一个可被调用的远程对象、事件订阅或长任务句柄，具有明确的生命周期和释放责任。

## 选择调用边界

| 调用场景               | 通信机制                             | 核心关注点                                 |
| ---------------------- | ------------------------------------ | ------------------------------------------ |
| 宿主内插件之间互相调用 | 构造函数依赖注入，直接调用领域方法   | 强类型实例、插件重启时代理视图自动失效     |
| Workbench 前端调用插件 | 基于 Cap'n Web 的 RPC Target 接口    | 输入参数校验、权限鉴权、页面关闭时自动清理 |
| 独立外部客户端访问     | HTTP 路由（Elysia）或 WebSocket 通道 | 自定义认证、标准 JSON 响应与错误码规范     |

插件之间的本地调用无需经过 RPC 封装或 DTO 序列化，直接调用方法即可；仅当通过 Workbench 暴露给前端时，才需要将其投影为符合 DTO 规范的数据。

## 第三方库的版本边界

把第三方运行时对象交给宿主时，由接收能力决定兼容版本。使用宿主 Elysia application 的插件遵守 [HTTP 依赖声明](./http.md)，向 Workbench 发布 `RpcTarget` 的插件遵守 [Workbench 发布与版本准入](https://github.com/PluxelJS/pluxel/blob/main/engineering/WORKBENCH.md#definition-与-publication)。作者直接从 `elysia`、`capnweb` 导入上游 API，并按对应能力声明精确 peer 与同版开发依赖。

插件私有 SDK、独立 HTTP/RPC 端点及其客户端由插件作者管理版本。通过 JSON 等数据协议交换信息时，双方约定传输格式；宿主的模块接线只覆盖它接收的运行时对象。插件间公开 Better Result 实例可使用 [Core 共享入口](./better-result.md)，原生 SDK 结果、操作回执和生命周期失败保留各自语义。

## 本地插件 API 按领域设计

同一宿主中的插件调用应直接使用领域方法。方法返回普通数据或具有明确关闭语义的对象：

- 返回快照对象时，建议返回浅冻结或不可变数据，避免调用方修改影响内部状态；
- 返回连接句柄时，应明确说明资源由谁负责关闭，并在插件停止时提供失效保护。

## 页面 API 只公开客户端需要的能力

面向 Workbench 前端暴露的接口，通常将 DTO 定义、接口描述与路由放置在 `workbench.ts` 中。这样前端与服务端能够共享同一份 TypeScript 类型契约：

```ts
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { OrdersWorkbench } from '../workbench.ts'

export const overviewScope = createWorkbenchRenderer(OrdersWorkbench.overview)

export const ordersQuery = overviewScope.query(({ api }) => ({
	queryKey: ['orders', 'snapshot'] as const,
	queryFn: () => api.snapshotDto(),
}))
```

## RPC 方法名表达返回值所有权

为了让前端开发者仅凭方法名就能辨别返回的是纯数据还是可调用对象，Workbench 的 RPC 接口遵循以下命名规范：

| 方法命名规范                | 返回值类型                                | 示例                                                   |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| **以 `*Dto` 结尾**          | 纯数据（快照、列表、分页、写入回执）      | `snapshotDto()`、`listDto(query)`、`updateDto(params)` |
| **标准动词（无 DTO 后缀）** | 无返回值命令操作                          | `refresh()`、`remove(id)`                              |
| **标准动词（无 DTO 后缀）** | 返回可调用的 Capability、订阅句柄或长任务 | `watch(observer)`、`openSession(config)`               |

例如，`refreshDto(): Promise<OrdersSnapshot>` 表示刷新数据并返回最新的订单快照；而 `refresh(): Promise<void>` 则表示触发后台刷新并等待操作完成。

## 共享 RPC 能力按作用域持有

在前端页面中，每次打开 View 或 Attachment 时，底层都会建立一个对应的生命周期作用域。在组件内直接消费此作用域提供的能力即可：

```ts
const { api } = overviewScope.useWorkbench()
```

页面内的多个组件共享同一个 `api` 引用，页面关闭时底层会自动向服务端注销对应的 RPC 会话，开发者无需手动调用释放逻辑。

## 生产者负责 DTO 边界

服务端在向前端返回数据前，应当完成输入校验、鉴权和数据字段投影。避免直接将数据库原始 ORM 实体或带有敏感私有字段的对象直接传给客户端。

可以使用 `@pluxel/workbench/server` 提供的 `assertWorkbenchDto` 校验数据是否符合传输要求：

```ts
import { assertWorkbenchDto } from '@pluxel/workbench/server'
import type { OrdersSnapshot } from './workbench.ts'

function projectOrdersDto(snapshot: OrdersSnapshot): OrdersSnapshot {
	const dto: OrdersSnapshot = {
		revision: snapshot.revision,
		openOrders: snapshot.openOrders,
	}
	assertWorkbenchDto(dto, 'Orders snapshot')
	return dto
}
```

## 数据与资源分别持有

在处理返回结果时，区分纯数据与资源引用的生命周期：

- **纯数据（DTO）**：可以直接在 React Query 或状态库中缓存，渲染完毕后由垃圾回收机制自然处理；
- **长连接与订阅句柄**：必须由显式的所属组件持有，并在组件卸载（如 `useEffect` 清理函数）时主动注销；
- **混合结果**：如果一次调用既返回业务数据又返回可调用的句柄，应在接收时解构并分别管理，不可将包含方法的句柄整体存入通用缓存中。
