---
title: 为什么是 Pluxel？
description: 从 Cordis 与 Koishi 的实践出发，理解 Pluxel 对依赖身份、能力所有权和生命周期的选择。
---

Pluxel 是对 [Cordis v3](https://github.com/cordiverse/cordis/tree/f8f10ec6734ebb4558addeba0f6a25294684d494) Plugin 思想的一次再诠释。它以依赖注入为核心：Plugin 之间的 required dependency 直接写在 constructor，从 package root 的 value import 生成可追溯的依赖边，形成一条从 provider import 到 consumer 参数的清晰路径。保留的是 Plugin 的 Context 与生命周期模型，listener、timer、route 等副作用随所属 Plugin 自动回收，功能可以动态装载、替换和卸载；重新设计的是这些能力背后的依赖身份、构建语义和运行时边界。

## 从 Koishi Plugin 实践出发

我们从 2023 年开始编写 [Koishi](https://github.com/koishijs/koishi) Plugin。Koishi 的 Plugin runtime 建立在 Cordis 之上；当前 `@koishijs/core` 仍明确依赖 [Cordis 3.18.1](https://github.com/koishijs/koishi/blob/fb6e2c092242c0387f07f36e21082d5715c48449/packages/core/package.json#L36-L42)。Pluxel 对依赖模型的思考，来自这段持续的 Plugin 开发、组合和生命周期实践。

截至本文写作时，Cordis 的影响力已经远远超出 Koishi 生态。DeepSeek 官方的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a) 明确说明其 “everything is a plugin” 架构 [powered by Cordis](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/README.md#L1-L9)，并在仓库中维护和发布 [Cordis 4.0.1](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/package.json#L1-L12)。DeepSeek Harness 的采用印证了 Cordis 模型的适用性。

Pluxel 建立在这些实践之上，延续了 Cordis 模型最重要的直觉，并把长期积累的思考带向另一种依赖身份、构建语义和生命周期设计。

## 从 Cordis 学到的 Plugin 模型

[Cordis](https://github.com/cordiverse/cordis) 证明了 Context 与 Plugin lifecycle 可以形成一套简洁而强大的应用模型：

- Plugin 是能力与副作用的边界；
- Context 表达当前调用者和资源所有者；
- service availability 可以控制 Plugin 的装载与卸载；
- scope/effect 让资源跟随 Plugin 自动清理；
- 动态宿主可以在不重启整个应用的情况下替换能力。

Pluxel 延续这些判断，但改变了业务依赖的写法：同一条依赖不应该靠几处相同的字符串来维持。

## Cordis 如何连接类型与运行时

### Declaration merging 提供 Context 类型

Cordis v3 的 service package 通过 module augmentation 扩展 `Context`。以 timer package 为例，删去具体实现后，结构如下：

```ts
import { Context, Service } from '@cordisjs/core'

declare module '@cordisjs/core' {
	interface Context {
		timer: TimerService
		setTimeout(callback: () => void, delay: number): () => void
	}
}

export class TimerService extends Service {
	constructor(ctx: Context) {
		super(ctx, 'timer')
		ctx.mixin('timer', ['setTimeout'])
	}
}
```

当 package 进入 TypeScript program 后，`timer` 和 `setTimeout` 会合并进 `Context` interface，`ctx.timer` 与 `ctx.setTimeout()` 因而获得静态类型。可以直接查看 v3 的 [timer module augmentation](https://github.com/cordiverse/cordis/blob/f8f10ec6734ebb4558addeba0f6a25294684d494/packages/timer/src/index.ts#L1-L19)。

`declare module` 只建立类型表面。Service 的注册、可用性检查和生命周期由 Cordis runtime 完成。

### 一个名称承担三种职责

以 `database` service 为例，Cordis v3 的标准写法需要在三个位置使用同一个名称：

```ts
// provider 注册
super(ctx, 'database')

// consumer 声明依赖 metadata
export const inject = ['database']

// consumer 读取 Context property
ctx.database.get(table, id)
```

`database` 同时出现在 provider 注册、consumer 的 dependency metadata 和 Context property 中。Cordis runtime 用这个名称等待 provider、卸载 consumer，并在 service 恢复后重新加载。三处代码之间没有静态关联，名称需要由作者保持一致。

Declaration merging 能给 `ctx.database` 提供类型，却不会生成 `super(ctx, 'database')` 或 `inject: ['database']`，也不会在 consumer 改用 `ctx.storage` 时同步修改 dependency metadata。Cordis v3 的 `Inject` 类型本身就是 `string[] | Dict<Inject.Meta>`。常量、lint 和封装只能加固这套约定，无法消除重复声明。

这种写法换来了运行时绑定：Plugin 不必导入 provider，可以随 Context 和 service availability 动态装卸。Pluxel 保留了动态生命周期，但没有继续使用字符串作为业务依赖的身份。

## 为什么这对 Pluxel 不够

Cordis 并不缺少依赖可用性检查或动态生命周期。它的 [Service 文档](https://github.com/cordiverse/cordis/blob/f8f10ec6734ebb4558addeba0f6a25294684d494/packages/core/README.md#L368-L430) 明确约定：required service 不可用时 Plugin 不加载，service 变化时 Plugin 卸载，并在新值仍可用时重新加载。

问题在于，同一条依赖需要在几处代码中重复声明：

1. **依赖声明与使用位置分离。** `inject: ['database']` 和 `ctx.database` 是两处源码。修改属性名时，TypeScript 不会提醒开发者同步修改 `inject`。
2. **Context key 承担了业务依赖身份。** 同一个字符串参与注册、依赖声明和属性读取，却不携带 package root、named export 或构建 provenance。
3. **错误发现得较晚。** 漏写 `inject` 或名称不一致，要到 Plugin 装载或属性访问时才能发现。

Pluxel 为此增加了编译约束：required dependency 只写在 constructor 中，并在 TypeScript 擦除类型前转化为构建 metadata。构建工具可以据此检查 provider identity、constructor 参数和 package boundary。

## Pluxel 的能力边界

Pluxel 先判断一项能力属于业务组成、宿主公共设施，还是局部动态适配，再为它选择对应的表达方式和生命周期。

| 能力关系        | 标准表达                               | 身份与生命周期                                 |
| --------------- | -------------------------------------- | ---------------------------------------------- |
| Required Plugin | constructor value import               | definition slot、DI graph、provider generation |
| Optional Plugin | type-only opaque ref + `plugins.use()` | optional graph edge、consumer restart plan     |
| Host capability | root 创建前固定的 `Context` 投影       | host 组合、调用与注册绑定 owner Context        |
| Plugin 内部组成 | 普通 class/function + effects scope    | 随 owner generation 回收                       |

### 业务依赖进入 Plugin graph

普通业务 Plugin 之间的 required dependency 直接写在 constructor：

```ts
import { AccountsPlugin } from '@acme/accounts'

@Plugin({ displayName: 'Billing' })
export class BillingPlugin extends BasePlugin {
	constructor(private readonly accounts: AccountsPlugin) {
		super()
	}
}
```

这里没有第二份 `inject` 列表，也不需要业务 Plugin 通过 declaration merging 把自己挂到 Context。

构建工具在 TypeScript 擦除类型前记录 import 来源和 constructor 参数位置。package root、named export 和参数共同确定依赖边；runtime 根据构建结果注入当前的 provider generation。

可选集成使用 type-only opaque ref 和 `plugins.use()`。它同样会进入 Plugin graph；provider generation 变化时，runtime 会重启 consumer，而不是回到 Context string lookup。

### 宿主公共设施进入 Context

HTTP、config、logger、effects、commands、persistence/database 等由宿主统一提供，仍然通过 Context 暴露：

公开的 `@pluxel/context` 是一套独立于 Plugin Runtime 的 host kernel。需要构建 standalone host 的应用可以在创建 root 前组合
root、scope 和 owner-view capability；能力集合编译后不可修改。它只负责同步、严格惰性的 Context 投影，不负责资源启动、
`prepare()` 或 `dispose()`。

Pluxel Runtime 用同一个 kernel 在创建 root Context 时一次性编译官方能力。业务 Plugin 不注册 Context service，也不能在
module evaluation 或 `init()` 阶段修改 Runtime 的能力集合；Plugin 间的业务能力仍通过 Plugin graph 表达。

Context 只暴露能力和当前 owner identity，不暴露完整宿主配置。每项能力显式选择 root、Plugin generation 或 owner-view
作用域；`ctx.foo` 的缓存访问直接读取预编译 numeric slot，descriptor lookup 不在 getter 热路径。

每个 Plugin、Part 和 dependency caller edge 都使用自己的 owner view。logger、effects 和其他注册项归当前 owner 所有，
并在 replacement、rollback 或 shutdown 时随 generation 回收；共享 backend 不依赖可变的“当前 ctx”。

普通业务 Plugin 不使用 declaration merging 声明依赖；第三方业务能力继续通过 Plugin graph 组合。

### Proxy 只适配局部动态语义

Pluxel 不用 Context-wide Proxy 定义 dependency identity 或 service graph，但会在需要动态调用的局部接口使用 Proxy，例如：

- constructor 注入的 caller-aware Plugin view；
- `EvtChannel` 的 caller-bound method view；
- readonly config 与未初始化 sentinel；
- RPC/SSE 等动态 namespace。

这些 view 只处理调用者绑定或动态成员。provider identity、graph edge 和 lifecycle ordering 来自构建 metadata，不由 Proxy 决定。

## 为什么称为 typed meta-framework

Pluxel 所说的 typed，不只是给 runtime API 增加泛型。TypeScript 源码本身是框架语义的输入：

- constructor import 生成 required dependency edge；
- optional type provenance 生成 optional edge；
- package root 与 named export 生成 canonical Plugin identity；
- Valibot schema 同时提供配置类型、默认值、校验和 Workbench 表单；
- 同一份 metadata 被 static catalog、dynamic source、日志、配置和 Workbench 使用。

类型、构建产物和 runtime graph 使用同一个 Plugin identity。Static host 可以冻结和审计完整闭包；dynamic host 在固定基线上增加 source discovery。两种 Vite 宿主都支持 replacement 与 HMR，Plugin 的写法不变。

## 性能取舍

Pluxel 与 Cordis v4 目前没有同场、同语义的 benchmark，现有数据不能说明谁更快。Pluxel 把一部分依赖解析移到构建期，但 runtime 中仍有 graph commit、caller binding 和局部 Proxy。这项设计首先服务于依赖检查和身份一致性，不作性能承诺。

Context 本身会把 capability object identity 在 host compile 时映射成 numeric slot，成功构造的值按 root/scope/owner-view
缓存；常规 `ctx.foo` 热访问不做字符串或 `Map` 查找。这里使用 `Map` 是为了保持 descriptor 的 object identity，
`Object.create(null)` 的字符串/symbol key 语义不能直接替代。具体取舍由 `@pluxel/context` benchmark 持续验证，不把趋势数据
表述成跨机器 SLA。

## 选择与代价

Pluxel 比 Cordis 的开放字符串模型更严格：

- Plugin 源码必须经过 Pluxel 的 Vite/Rolldown semantic pipeline；
- 公开 Plugin 必须来自可追溯的 package-root named export；
- 无法生成稳定 provenance 的动态写法会在构建时被拒绝；
- Plugin 作者需要接受 graph identity 与 generation lifecycle 的约束。

我们接受这些限制，因为 Pluxel 需要在构建时检查完整的 Plugin 依赖图，并在运行时处理替换、回滚和资源回收，而不只是查找一个 service。

下一步可以阅读 [Plugin 模型与生命周期](./getting-started/plugin-model.md)，或直接[编写第一个 Plugin](./getting-started/index.md)。
