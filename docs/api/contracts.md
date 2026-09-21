---
title: 契约、数据与资源
description: 区分本地能力、RPC 数据和资源引用，让插件作者只维护必要的公共契约。
---

设计 API 时，先回答调用方要读取一个事实，还是取得一项可持续使用的能力。前者返回 snapshot 或操作回执，后者返回有明确生命周期的 handle；不必让每个业务实体都变成远端对象。

## 本地插件 API 按领域设计

同一 host 中，required dependency 通过 constructor 声明。方法使用领域词汇，按需要返回普通数据或具有明确撤回语义的对象，不为本地调用复制一套 RPC 方法和 DTO。

只读 TypeScript 类型不会隔离共享可变对象。返回快照时，由生产者保证调用方不能通过它意外修改内部状态；返回 handle 时，说明谁拥有资源、停止或 replacement 后还能否调用。需要持续使用的对象不能只靠最初取得它时的一次可用性检查。

跨 Plugin 的可调用入口使用 prototype method；不要用捕获原始实例的 function-valued field 代替。具体 caller 与生命周期规则见[插件模型](../getting-started/plugin-model.md)。

## 页面 API 只公开客户端需要的能力

Workbench 的默认写法把 browser-safe DTO、API interface 和 definition 放在 `workbench.ts`。服务端 target 实现这个 interface；客户端通过 exact descriptor 获得对应类型，不再手写第二份 client interface。

沿用 [View 教程](../workbench/view.md)中的 `OrdersSnapshot`、`OrdersApi` 和 `OrdersWorkbench`，查询直接调用 API：

```ts
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { OrdersWorkbench } from '../workbench.ts'

export const overviewScope = createWorkbenchRenderer(OrdersWorkbench.overview)

export const ordersQuery = overviewScope.query(({ api }) => ({
	queryKey: ['orders', 'snapshot'] as const,
	queryFn: () => api.snapshotDto(),
}))
```

普通 scope query/mutation 已经处理结果边界，作者不需要在其中再包一次 `consumeWorkbenchValue()`。只有 UI 需要消费写入后的事实时才返回回执或快照；只需刷新查询时，mutation 可以返回 `void` 并声明失效范围。

一个公开类型应对应一个真实兼容性承诺。不要直接把数据库 row、SDK 实例或 Plugin implementation 当作浏览器契约。只有出现真实的第二客户端时，才把共用 contract 提取到中立模块或独立 subpath；`import type` 避免运行时加载，但仍需保证公开声明的依赖适合客户端消费。

## 共享 RPC 能力按作用域持有

Workbench 已经为每次打开页面取得所需 root。`scope.useWorkbench()`、query 和 mutation factory 借用同一组引用，不执行获取 RPC，也不调用 `dup()`。View 使用 `api`，Attachment 使用 `provider` 和可选 `consumer`；这里的 `provider` 表示 Attachment 的能力提供方，不是需要作者再创建的 React Provider。

组件需要手动使用能力时，直接写 `const { api } = overviewScope.useWorkbench()`；普通读写优先声明 scope query/mutation，统一处理结果、订阅和查询失效。页面组件默认消费 scope/resource，不从 host 或 session 根重新导航，也不创建自己的连接。`host` 提供宿主交互；本地服务端 Plugin 之间仍通过 dependency 调用领域能力，不绕经浏览器 RPC。

| 边界                          | 持有与共享规则                                                       |
| ----------------------------- | -------------------------------------------------------------------- |
| document session              | Shell 持有连接、认证与顶层 capability                                |
| 单次 View/Attachment open     | opened handle 持有 root；scope 向本页面所有组件借出同一引用          |
| 多组件长期共用的子 capability | 在最近共同父级设置一个领域 owner，获取一次，用 Context 或 props 借出 |
| 单次任务独占的子 capability   | 任务内取得并释放，依赖它的异步调用完成后再退出作用域                 |
| DTO 查询                      | resource cache 只保存数据，不承担 capability 生命周期                |

不要按服务端对象层级机械增加 Provider。只有某个 scope 确实绑定身份、资源范围或独立生命周期时才建立相应 owner；简单查询直接传业务参数。不同 open 的 root 与 cache 保持独立，即使 descriptor 相同也不建立全局 stub 池。

借用者不释放共享引用。`dup()` 只用于确实需要独立持有的引用，并由新 owner 释放；它不会延长服务端授权或 Plugin generation。子 owner 在 scope 变化或页面关闭时释放自己取得的引用，迟到的获取结果只释放、不发布。共享 capability 不等于调用自动去重；重复 DTO 读取由同一 resource 的 query key 管理。

## RPC 方法名表达返回值所有权

纯数据 RPC 方法统一使用 `*Dto` 后缀，并在 interface 和 target 实现中写出返回类型。名称描述返回值契约，不表示这个方法只读；返回纯数据回执的写操作也使用后缀。

| 方法边界与返回值                                             | 命名                          | 示例                                                         |
| ------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------ |
| RPC 返回纯数据，包括 primitive、snapshot、分页结果或操作回执 | `*Dto`                        | `snapshotDto()`、`listDto(input)`、`updateDto(input)`        |
| RPC 命令返回 `void`                                          | 领域动词                      | `refresh()`、`remove(id)`                                    |
| RPC 返回 capability、订阅 handle 或混合数据与 capability     | 领域动词，不加 `Dto`          | `watch(observer)`、`openEntry(input)`                        |
| 本地 Plugin 领域方法、客户端 facade 或已打开的 handle        | 领域词汇，不随 transport 改名 | `plugin.snapshot()`、`client.plugins.list()`、`opened.run()` |

例如 `refreshDto(): Promise<OrdersSnapshot>` 返回刷新后的事实，`refresh(): Promise<void>` 只承诺操作完成。两者按实际消费需求选择，不为统一命名额外制造回执。纯数据 Result union 仍是 DTO；只要其中一个分支带 capability，整体就是资源或混合结果。

Framework raw RPC 同样遵守这项规则：Workbench session 的 `layoutDto()` 返回布局，`openEntry()` 返回含 root 的打开结果；Content root 的 `subscribeDto()`、`loadDto()`、`runDto()` 返回数据。`subscribeDto()` 会注册 observer，但注册寿命归 Content root，返回的 initial DTO 不持有订阅 handle。对应本地 opened handle 继续使用 `subscribe()`、`load()`、`run()`。Management 的 raw value methods 使用 `*Dto`，消费后的本地 facade 保留领域方法名。

## 生产者负责 DTO 边界

服务端 target 依次完成输入的领域校验、基于可信 principal 与当前状态的授权、领域操作，以及面向客户端的字段投影。不要直接返回数据库 row、Plugin、Context 或供应商对象。标注返回类型可以检查已知字段；运行时输入和可传输性仍要验证。

`RpcTarget` 的原型方法和 getter 属于远端可访问表面，TypeScript `private` 不会在运行时隐藏它们。Target 的内部辅助方法使用 `#private` 或移到普通领域服务。此规则只针对 RPC target；Plugin 类受 caller facade 约束，不能照搬 `#private`，遵循[插件模型](../getting-started/plugin-model.md)。

已经是明确 DTO 的领域快照可以直接复用；只在需要隐藏字段或转换领域表示时建立投影。返回前调用 `@pluxel/workbench/server` 的 `assertWorkbenchDto(dto)`，验证完整数据树和大小、深度预算。该函数不复制、不冻结、不释放资源，也不改变对象身份；它不替代领域 schema、授权或隐私字段选择，不会替调用方删除 capability。异步领域结果先 `await`，再校验实际 DTO。

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

生产者校验负责保证发出的值符合 DTO 承诺；Cap’n Web 负责 transport 编解码；客户端消费边界负责接管解码后的对象并冻结以供缓存。它们分别拥有不同责任，不需要再增加 `copyDto()` 层。

## 数据与资源分别持有

| 结果                                  | 消费方式                                | 清理责任                                         |
| ------------------------------------- | --------------------------------------- | ------------------------------------------------ |
| scope query/mutation 的 portable 数据 | 页面读取本地结果，不缓存 stub           | renderer boundary 处理 transport result          |
| View/Attachment root                  | 通过 scope 或对应低层 Hook 借用         | 打开页面的 owner 释放，组件不自行释放借来的 root |
| 订阅、child capability、长任务 handle | 显式持有，按领域契约使用                | 获取者或接管它的 owner 清理                      |
| 混合数据与 capability 的结果          | 拆分数据和资源，明确 ownership transfer | 不能整体当作普通查询数据缓存                     |

当前 scope 的数据边界接管返回值所有权，校验完整数据树后原地深冻结，移除并释放 top-level transport result 的元数据；不会再复制 RPC 已解码的数据。它不是任意 Cap’n Web 值的缓存：显式 `undefined` 字段、非枚举业务字段、class、accessor、cycle、binary 和 capability 都不属于 portable 查询结果。省略 optional 字段与写入 `undefined` 字段不同。

如果 query/mutation 返回本地对象而非 RPC 结果，也会转移整个数据树的所有权；返回新构造或已不可变的快照，不要返回其他代码仍会修改的借用对象。表单需要独立草稿时，按业务字段建立草稿。

手动读取 RPC、订阅和资源型返回值的操作方式以[页面资源](../workbench/renderer-resources.md)为准。`consumeWorkbenchValue()` 处理纯数据并返回 `WorkbenchSnapshot<T>`。它接管传入的对象或 PromiseLike 结果，保留数据对象身份，并在成功或失败时清理结果；调用方不再单独 dispose 同一结果。它不把 capability 转成数据。不要把通用的 `JSON.stringify()` / `structuredClone()` 当作 RPC ownership 转移机制。

## 方法签名之外还要说明什么

为一个公开方法写文档时，补充调用方无法从类型推导的内容即可：

- 返回的是 snapshot、live handle 还是写入回执；是否有版本、新鲜度或部分成功语义。
- 输入在哪里验证，身份与 scope 从何而来，实际执行时如何授权。
- 资源由谁创建、借用和释放，stop、replacement、关闭页面后如何失效。
- 哪些失败可恢复；取消或断线后，写入是否可能已提交。

Cap’n Web 负责远端引用和调用，不替业务决定授权、事务和恢复。不要假设自定义 Error 的字段会自动穿过 transport；需要客户端分支处理的错误必须验证实际接收结果。已有领域 Result 或 receipt 若承载部分成功、冲突或未知结果，也不能为了统一返回风格丢掉这些信息。
