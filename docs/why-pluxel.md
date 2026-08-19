---
title: 为什么是 Pluxel？
description: 从 Cordis 与 Koishi 的实践出发，理解 Pluxel 对依赖身份、能力所有权和生命周期的选择。
---

# 为什么是 Pluxel？

Pluxel 是对 [Cordis v3](https://github.com/cordiverse/cordis/tree/f8f10ec6734ebb4558addeba0f6a25294684d494) Plugin 思想的一次再诠释与重构。

我们希望保留 Cordis 带来的组合体验：Plugin 拥有 Context 和生命周期，listener、timer、route 等副作用随所属 Plugin 自动回收，功能可以动态装载、替换和卸载。我们重新设计的是这些能力背后的依赖身份、构建语义和运行时边界。

Pluxel 的核心原则是：

> **业务组成进入 Plugin graph；宿主公共设施进入 Context；动态分派只留在确实需要它的局部边界。**

这条原则决定了 required dependency、declaration merging、Proxy、生命周期和工具链各自负责什么。

## 从 Koishi Plugin 实践出发

我们从 2023 年开始编写 [Koishi](https://github.com/koishijs/koishi) Plugin。Koishi 的 Plugin runtime 建立在 Cordis 之上；当前 `@koishijs/core` 仍明确依赖 [Cordis 3.18.1](https://github.com/koishijs/koishi/blob/fb6e2c092242c0387f07f36e21082d5715c48449/packages/core/package.json#L36-L42)。Pluxel 对依赖模型的思考，来自这段持续的 Plugin 开发、组合和生命周期实践。

截至本文写作时，Cordis 的影响力已经远远超出 Koishi 生态。DeepSeek 官方的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a) 明确说明其 “everything is a plugin” 架构 [powered by Cordis](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/README.md#L1-L9)，并在仓库中维护和发布 [Cordis 4.0.1](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/package.json#L1-L12)。这进一步说明 Cordis 模型的生命力，也让更多开发者开始认识这套设计。

我们对此抱有真诚的尊重。没有 Cordis 与 Koishi 提供的长期实践土壤，就不会有 Pluxel。Pluxel 延续了这套模型最重要的直觉，也把我们从 2023 年开始积累的思考带向了另一种依赖身份、构建语义和生命周期设计。本文记录的正是这段技术传承与选择。

## 从 Cordis 学到的 Plugin 模型

[Cordis](https://github.com/cordiverse/cordis) 证明了 Context 与 Plugin lifecycle 可以形成一套简洁而强大的应用模型：

- Plugin 是能力与副作用的边界；
- Context 表达当前调用者和资源所有者；
- service availability 可以控制 Plugin 的装载与卸载；
- scope/effect 让资源跟随 Plugin 自动清理；
- 动态宿主可以在不重启整个应用的情况下替换能力。

Pluxel 延续这些判断。它不是为了否定 Cordis 而另造一套术语，而是要解决我们在扩大这套模型时遇到的一个具体问题：同一条业务依赖不应由多份字符串事实维持。

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
// provider registration
super(ctx, 'database')

// consumer dependency metadata
export const inject = ['database']

// consumer property lookup
ctx.database.get(table, id)
```

这三处对应三条独立的实现路径。

`Service` constructor 使用 `name` 注册实例：

```ts
constructor(protected ctx: Context, name: string) {
	// ...
	self.name = name
	self.ctx.set(name, self)
}
```

`Inject.resolve()` 将 consumer 的字符串数组转换为 runtime dependency table：

```ts
if (Array.isArray(inject)) {
	return Object.fromEntries(inject.map((name) => [name, { required: true }]))
}
```

Context Proxy 再从被访问的 property name 查找 service：

```ts
get(target, prop, ctx) {
	const [name, internal] = ReflectService.resolveInject(target, prop)
	// ...
	return ctx.reflect.get(name)
}
```

对应源码分别是 [Service 注册](https://github.com/cordiverse/cordis/blob/f8f10ec6734ebb4558addeba0f6a25294684d494/packages/core/src/service.ts#L10-L35)、[Inject 解析](https://github.com/cordiverse/cordis/blob/f8f10ec6734ebb4558addeba0f6a25294684d494/packages/core/src/registry.ts#L8-L52) 和 [Context Proxy lookup](https://github.com/cordiverse/cordis/blob/f8f10ec6734ebb4558addeba0f6a25294684d494/packages/core/src/reflect.ts#L16-L72)。

因此，`database` 同时是 provider 注册名、consumer dependency metadata 和 Context property。Cordis runtime 能根据它等待 provider、卸载 consumer，并在 service 恢复后重新加载；但三处能够表示同一能力，是因为作者维护了相同的字符串，而不是因为源码中存在一条从 provider import 到 consumer parameter 的直接关系。

Declaration merging 能给 `ctx.database` 提供类型，却不会生成 `super(ctx, 'database')` 或 `inject: ['database']`，也不会在 consumer 改用 `ctx.storage` 时同步修改 dependency metadata。Cordis v3 的 `Inject` 类型本身就是 `string[] | Dict<Inject.Meta>`。常量、lint 和封装可以继续加固这套约定，但不能消除重复声明。

### Proxy 是 runtime Context 的解释器

Cordis v3 `3.18.1` 已经从 `Context` constructor 返回 `new Proxy(this, ReflectService.handler)`；Proxy 并不是 v4 才引入的，也不只是一种 service locator 写法。v4 将 scope/lifecycle 重构为 Fiber，并重新组织 registry 与 reflection，进一步明确了 Context 的双重角色：组件向 Context 写入可回收的 effect，也从 Context 读取会随环境变化的 coeffect。

当前 Cordis v4 的根 Context 大致如下：

```ts
export class Context {
	constructor() {
		const self = new Proxy(this, ReflectService.handler)
		this.root = self
		this.fiber = new Fiber(self /* ... */)
		this.reflect = new ReflectService(self)
		return self
	}
}
```

一次 `ctx.database` 读取的含义由访问发生时的 runtime Context 决定。Proxy handler 先区分普通属性和 accessor，再结合当前 Fiber 的 `inject`、Context 的 isolate key、Fiber parent chain 与 active service implementation 寻找值；未声明依赖、依赖尚未 active 和跨 isolate 访问会得到不同结果。`ctx.provide()` 安装或撤销 implementation 时，又会通知相关 Fiber 重新检查依赖并刷新 lifecycle。固定版本实现见 [Context constructor](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/context.ts#L36-L49)、[Proxy handler](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/reflect.ts#L27-L133) 和 [Inject 定义](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/registry.ts#L11-L59)。

因此，Cordis 的字符串 key 是有意保留的 late binding point。Plugin 不需要 import provider constructor；同一份代码可以在不同 Context、isolate 和 provider incarnation 下运行。Fiber 则同时持有这次 Plugin execution、它产生的 effect，以及它声明的 coeffect 当前是否满足。provider 变化会在 runtime 触发 unload/reload，effect cleanup 使旧组成可以被撤销。这正是 Cordis 所说的时空可组合性：空间上响应依赖环境，时间上回收组件对环境的改变。

从这个角度看，[Cordis #34](https://github.com/cordiverse/cordis/issues/34) 不是 Fiber 路线的结论，更不是 Pluxel 可以长期依赖的差异。关联的 [Cordis #39](https://github.com/cordiverse/cordis/pull/39) 正在用 desired snapshot 与 generation token 分离、ownership-before-execution 和 reentrant-safe disposal 完善同一套 runtime 模型。它说明的是这条路线把依赖变化、旧异步工作、publication 和 cleanup 的一致性明确交给 runtime protocol；实现可以修复并继续演进，架构并不需要因此放弃 Proxy 或 Fiber。

## 为什么这对 Pluxel 不够

Cordis 并不缺少依赖可用性检查或动态生命周期。它的 [Service 文档](https://github.com/cordiverse/cordis/blob/f8f10ec6734ebb4558addeba0f6a25294684d494/packages/core/README.md#L368-L430) 明确约定：required service 不可用时 Plugin 不加载，service 变化时 Plugin 卸载，并在新值仍可用时重新加载。

Pluxel 不满意的不是结果，而是这些结果需要由多少份独立事实和 runtime 解释共同维持。

1. **依赖声明与使用位置分离。** `inject: ['database']` 和 `ctx.database` 是两处源码。修改实际使用时，TypeScript 不会从中推导 dependency metadata 也需要变化。
2. **Context key 承担了业务依赖身份。** 同一个字符串参与注册、依赖声明和属性读取，却不携带 package root、named export 或构建 provenance。
3. **关键错误进入 runtime 才能暴露。** Cordis 可以在装载或属性访问时发现 service 不可用、漏写 inject 或命名不一致；Pluxel 希望在生成应用闭包时验证 provider identity、constructor 参数与 package boundary。
4. **依赖关系主要由 runtime metadata 解释。** 在 Cordis core 的这套模型中，registry、scope/Fiber 和 Proxy 共同解释 inject 与 service relationship，package provenance 不是 dependency identity 的输入。
5. **Context-wide Proxy 承担统一解释成本。** 每次 Context property lookup 都需要进入通用 handler，再区分 JavaScript 属性与框架 service 语义。

Cordis 用成熟的 runtime 机制补足了字符串模型的行为，但这些机制不能把三处声明变成同一份事实。Pluxel 因而选择增加编译约束：required dependency 只写一次，并在 TypeScript 擦除前转化为构建 metadata。

## Pluxel 的能力边界

Pluxel 先判断一项能力属于业务组成、宿主公共设施，还是局部动态适配，再为它选择对应的表达方式和生命周期。

| 能力关系        | 标准表达                                | 身份与生命周期                                 |
| --------------- | --------------------------------------- | ---------------------------------------------- |
| Required Plugin | constructor value import                | definition slot、DI graph、provider generation |
| Optional Plugin | type-only opaque ref + `plugins.use()`  | optional graph edge、consumer restart plan     |
| Host capability | plugin-owned `Context` 上的稳定 service | runtime 安装、调用与注册绑定 owner Context     |
| Plugin 内部组成 | 普通 class/function + effects scope     | 随 owner generation 回收                       |

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

Pluxel semantic pass 在 TypeScript 擦除前读取 value import provenance，将 package root、root named export 和 constructor 参数位置写入 Plugin definition facts。Runtime 根据这些 facts 建立 DI graph，并将当前 provider generation 注入 consumer。

```text
constructor value import
  → build-time provenance
  → Plugin definition identity
  → verified dependency edge
  → runtime generation injection
```

如果业务集成是 optional，则使用 type-only opaque ref 和 `plugins.use()`；它仍然进入 Plugin graph，由 generation 变化驱动 consumer restart，而不是退回 Context string lookup。

### 宿主公共设施进入 Context

HTTP、config、logger、effects、commands、persistence/database 等不是任意业务 Plugin，它们是宿主为所有 Plugin 安装的稳定 runtime capability。它们适合通过 Context 暴露：

```ts
declare module '@pluxel/context' {
	namespace Context {
		interface Services {
			effects: EffectsService
		}
	}
}
```

这里使用 declaration merging 是有意的：它描述的是“宿主保证每个 Plugin Context 具备哪些基础设施”，不是“某个业务 Plugin 依赖哪个业务 Plugin”。Service class 由 runtime 注册，`Context.prototype` 预安装对应 getter，实例通过内部 symbol mapping/cache 解析。

“所有 Plugin 共享”指共享稳定的能力表面和宿主安装策略，不代表共享可变调用者。每个 Plugin 仍使用自己的 Context；logger、effects、registration 和 invocation gate 保留 owner，replacement、rollback 和 shutdown 按 generation 回收资源。

因此，Pluxel 的设计并不是让业务作者换一种 declaration merging 写法，而是让普通业务 Plugin 根本不需要通过 declaration merging 声明依赖。Module augmentation 被保留在它最合适的范围：host-owned、稳定、跨 Plugin 可用的 Context contract。

### Proxy 只适配局部动态语义

同样的原则适用于 Proxy。Pluxel 不用 Context-wide Proxy 定义 dependency identity 或 service graph，但在确实需要动态调用语义的局部边界使用 Proxy，例如：

- constructor 注入的 caller-aware Plugin view；
- `EvtChannel` 的 caller-bound method view；
- readonly config 与未初始化 sentinel；
- RPC/SSE 等动态 namespace。

这些 view 适配调用者或动态成员，不负责决定 provider identity、graph edge 或 lifecycle ordering。移除某个 view Proxy 不会让构建产物中的 dependency edge 消失。

## 为什么称为 typed meta-framework

Pluxel 所说的 typed，不只是给 runtime API 增加泛型。TypeScript 源码本身是框架语义的输入：

- constructor import 生成 required dependency edge；
- optional type provenance 生成 optional edge；
- package root 与 named export 生成 canonical Plugin identity；
- Valibot schema 同时提供配置类型、默认值、校验和 Workbench 表单；
- 同一份 metadata 被 static catalog、dynamic source、日志、配置和 Workbench 使用。

类型、构建产物和 runtime graph 因而不再维护三套平行身份。Static host 可以冻结和审计完整闭包；dynamic host 可以在不改变 Plugin 作者模型的前提下提供 source discovery、replacement 与 HMR。

## 性能取舍

目前没有 Cordis v4 与 Pluxel 的同场、同语义 benchmark，因此我们不宣称 Pluxel 比 Cordis 快多少。现有 Pluxel DI benchmark 对比的是 diod，也不能用于证明对 Cordis 的优势。

能够从实现确认的是执行路径不同：

| 路径                   | Cordis v4                              | Pluxel                                   |
| ---------------------- | -------------------------------------- | ---------------------------------------- |
| Context service access | 通用 Context Proxy `get` trap          | 预安装 prototype getter + symbol cache   |
| Plugin dependency      | runtime registry/Fiber 解释 inject key | build 生成 edge，commit 验证并应用 graph |
| 动态调用适配           | 集中在 Context Proxy lookup            | 限定在 caller-aware/dynamic view         |

Pluxel 的动机是缩小动态分派范围、把可摊销的工作前移到构建期，并让 Context lookup、graph commit 和 caller binding 各自拥有专门路径。这是实现成本模型，不是跑分结论；现代 JavaScript engine 中的 Proxy 不等于必然缓慢，Pluxel 的局部 Proxy 也有自己的 trap 成本。

性能不是首要理由。更重要的是让 package provenance、graph identity、构建期诊断和 generation lifecycle 使用同一组事实。

## 选择与代价

Pluxel 比 Cordis 的开放字符串模型更严格：

- Plugin 源码必须经过 Pluxel 的 Vite/Rolldown semantic pipeline；
- 公开 Plugin 必须来自可追溯的 package-root named export；
- 无法生成稳定 provenance 的动态写法会在构建时被拒绝；
- Plugin 作者需要接受 graph identity 与 generation lifecycle 的约束。

我们接受这些代价，因为 Pluxel 面向的不只是运行时 service lookup，而是需要被构建、验证、冻结、动态替换和治理的完整应用能力图。

下一步可以阅读 [Plugin 模型与生命周期](./getting-started/plugin-model.md)，或直接[编写第一个 Plugin](./getting-started/index.md)。
