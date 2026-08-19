---
title: 为什么是 Pluxel？
description: 从 Cordis 与 Koishi 的实践出发，理解 Pluxel 对依赖身份、能力所有权和生命周期的选择。
---

# 为什么是 Pluxel？

Pluxel 源自我们从 2023 年开始开发 Koishi Plugin 的经验。Koishi 的 Plugin runtime 建立在 [Cordis](https://github.com/cordiverse/cordis) 之上；Pluxel 保留了 Cordis 的 Context 和生命周期模型，但重新设计了业务依赖的身份与构建方式。

Cordis 已经解决了 Plugin 动态装载、替换和资源回收问题。Pluxel 要解决的是另一件事：让业务依赖在源码、构建产物和运行时依赖图中使用同一个身份。

## 保留的 Plugin 模型

[Cordis v3](https://github.com/cordiverse/cordis/tree/f8f10ec6734ebb4558addeba0f6a25294684d494) 确立了这些基础：

- Plugin 是能力与副作用的边界；
- Context 表达当前调用者和资源所有者；
- service availability 可以控制 Plugin 的装载与卸载；
- scope/effect 让资源随 Plugin 自动清理；
- 动态宿主可以在不重启整个应用的情况下替换能力。

Pluxel 沿用这套边界：listener、timer、route 和连接都归当前 Plugin 所有，在 stop、replacement 或启动回滚时释放。

## 为什么字符串依赖不够

Cordis v3 通过 module augmentation 为 Context service 提供类型。简化后的 service 定义如下：

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

这让 `ctx.timer` 和 `ctx.setTimeout()` 获得静态类型；service 注册、可用性和生命周期仍由 runtime 处理。

业务依赖的问题在于同一名称还要由作者在多个位置保持一致。以 `database` service 为例：

```ts
// provider registration
super(ctx, 'database')

// consumer dependency metadata
export const inject = ['database']

// consumer property lookup
ctx.database.get(table, id)
```

`database` 同时承担 provider 注册名、consumer dependency metadata 和 Context property。Declaration merging 可以检查属性类型，但无法保证三处名称同步，也不携带 provider 的 package root、named export 或构建来源。

这对 Pluxel 不够：

1. **依赖声明与使用位置分离。** `inject: ['database']` 和 `ctx.database` 是两处源码。修改属性名时，TypeScript 不会提醒开发者同步修改 `inject`。
2. **Context key 承担了业务依赖身份。** 同一个字符串参与注册、依赖声明和属性读取，却不携带 package root、named export 或构建 provenance。
3. **错误发现得较晚。** 漏写 `inject` 或名称不一致，要到装载或属性访问时才会暴露。

Pluxel 把 required dependency 收敛到 constructor，并在 TypeScript 擦除类型前生成依赖 metadata。构建工具可以直接检查 provider identity、参数位置和 package boundary。

## Pluxel 的能力边界

Pluxel 先判断一项能力属于业务组成、宿主公共设施，还是局部动态适配，再为它选择对应的表达方式和生命周期。

| 能力关系        | 标准表达                               | 身份与生命周期                                 |
| --------------- | -------------------------------------- | ---------------------------------------------- |
| Required Plugin | constructor value import               | definition slot、DI graph、provider generation |
| Optional Plugin | type-only opaque ref + `plugins.use()` | optional graph edge、consumer restart plan     |
| Host capability | Plugin Context 上的稳定 service        | runtime 安装、调用与注册绑定 owner Context     |
| Plugin 内部组成 | 普通 class/function + effects scope    | 随 owner generation 回收                       |

### 业务依赖进入 Plugin graph

普通业务 Plugin 之间的 required dependency 直接写在 constructor：

```ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { AccountsPlugin } from '@acme/accounts'

@Plugin({ displayName: 'Billing' })
export class BillingPlugin extends BasePlugin {
	constructor(private readonly accounts: AccountsPlugin) {
		super()
	}
}
```

这里没有第二份 `inject` 列表，也不需要业务 Plugin 通过 declaration merging 把自己挂到 Context。

构建工具记录 import 来源和 constructor 参数位置。package root、named export 和参数共同确定依赖边；runtime 根据构建结果注入当前 provider。

可选集成使用 type-only ref 和 `plugins.use()`。它同样进入 Plugin graph；provider 被替换时，runtime 重启 consumer，不回到 Context string lookup。

### 宿主公共设施进入 Context

HTTP、config、logger、effects、commands、persistence/database 等由宿主统一提供，仍然通过 Context 暴露：

```ts
declare module '@pluxel/context' {
	namespace Context {
		interface Services {
			effects: EffectsService
		}
	}
}
```

这里的 declaration merging 只声明宿主提供的 Context service，不表示业务 Plugin 之间的依赖。

每个 Plugin 使用自己的 Context。logger、effects 和其他注册项归当前 Plugin 所有，并在 replacement、rollback 或 shutdown 时回收。

普通业务 Plugin 不使用 declaration merging 声明依赖。Module augmentation 只用于 host-owned、稳定且跨 Plugin 可用的 Context contract。

## 为什么称为 typed meta-framework

Pluxel 所说的 typed，不只是给 runtime API 增加泛型。TypeScript 源码本身是框架语义的输入：

- constructor import 生成 required dependency edge；
- optional type provenance 生成 optional edge；
- package root 与 named export 生成稳定 Plugin identity；
- Valibot schema 同时提供配置类型、默认值、校验和 Workbench 表单；
- 同一份 metadata 被 static catalog、dynamic source、日志、配置和 Workbench 使用。

类型、构建产物和 runtime graph 使用同一个 Plugin identity。Static host 可以冻结完整 Plugin 闭包；dynamic host 在固定清单之外增加 source discovery。两种宿主都支持 replacement 与 HMR，Plugin 写法不变。

## 选择与代价

Pluxel 比 Cordis 的开放字符串模型更严格：

- Plugin 源码必须经过 Pluxel 的 Vite/Rolldown semantic pipeline；
- 公开 Plugin 必须来自可追溯的 package-root named export；
- 无法生成稳定 provenance 的动态写法会在构建时被拒绝；
- Plugin 作者需要接受 graph identity 和 generation lifecycle 的约束。

这些限制换来构建期依赖图检查，以及一致的替换、回滚和资源回收语义。

下一步可以阅读 [Plugin 模型与生命周期](./getting-started/plugin-model.md)，或直接[编写第一个 Plugin](./getting-started/index.md)。
