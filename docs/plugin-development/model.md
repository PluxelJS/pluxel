---
title: 插件依赖与组成
description: 选择 required dependency、optional integration 和 Part，明确调用归属与插件身份。
---

当一个 Plugin 需要调用另一个 Plugin，或持有需要关闭的连接、定时器时，按本页组织依赖与清理。
第一次写 Plugin 可从[最小示例](../getting-started/first-plugin.md)开始；已有代码直接定位下面的依赖、资源或失败章节。

一个 Plugin 只有在必需依赖可用、配置校验成功且 `init()` 完成后才会运行。
你负责声明依赖、初始化业务资源并登记清理；宿主负责启动顺序、停止和热更新。

本页先判断组成关系，再说明 required/optional dependency 与调用归属。资源清理读[生命周期](./lifecycle.md)，通知与订阅读[事件](./events.md)；这些都是基础机制，不需要安装 HTTP 或 Workbench。

## 三种组成关系

先看这部分功能是否需要独立启动和停止。下表给出三种插件组成方式，以及无需插件机制的普通 helper：

| 关系             | 何时使用                               | 写法                                     |
| ---------------- | -------------------------------------- | ---------------------------------------- |
| 必需 Plugin      | 缺少提供方就不能工作                   | 构造器参数 + 值导入                      |
| 可选 Plugin 集成 | 提供方只是可选增强                     | `definePluginRef<T>()` + `plugins.use()` |
| PluginPart       | 需要局部配置和资源，但随父插件一起启停 | `this.parts.use(CachePart)`              |
| 简单内部 helper  | 只有少量纯逻辑或显式 wiring            | 普通类或函数，按需登记清理               |

需要被多个插件注入、独立启停的能力适合 Plugin；只服务当前插件的缓存、客户端和辅助逻辑，通常保留为内部代码。

## Required dependency

必须调用的其他 Plugin 通过构造器声明。提供业务能力的插件称为 provider，调用它的插件称为 consumer；这与 Host 安装的 Context 服务是不同的关系。
使用普通值导入，框架才能识别要注入哪个类：

```ts twoslash
// @filename: accounts.ts
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin({ displayName: 'Accounts' })
export class AccountsPlugin extends BasePlugin {
	listInvoices(): readonly string[] {
		return []
	}
}

// @filename: billing.ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { AccountsPlugin } from './accounts.ts'

@Plugin({ displayName: 'Billing' })
class BillingPlugin extends BasePlugin {
	constructor(private readonly accounts: AccountsPlugin) {
		super()
	}

	listInvoices() {
		return this.accounts.listInvoices()
	}
}
```

真实项目中从提供方包的根入口导入，例如 `import { AccountsPlugin } from '@acme/accounts'`。
构造器参数就是依赖声明，`@Plugin()` 不再重复列出依赖。依赖只在 Part 中使用时，写在该 Part 的构造器中即可。

启动 Billing 时，应先看到 Accounts 成功运行，再运行 Billing。Accounts 启动失败会阻塞 Billing，
但不会阻止其他无关插件启动。

同一个 Plugin definition 不能在一个 constructor 中重复声明。dependency override 按 requirement definition 识别依赖，参数名和位置不会成为
持久配置；如果需要 primary/replica 这类双角色，应先定义具有不同语义身份的 Plugin token，而不是重复同一个参数类型。

注入值是绑定 consumer caller Context 和当前 provider generation 的轻量 facade。provider replacement 后旧 facade、旧 method
reference 与旧字段写入都会被拒绝；普通 public field 的读写仍作用于 provider 自己的实例，不会在 consumer 侧形成影子字段。

因此 Plugin 及其基类不能声明 ECMAScript `#private` field、method 或 accessor：这类成员要求 receiver 持有原生 private brand，
与 caller facade 不兼容，构建工具会报 `plugin_caller_view_private_brand_unsupported`。TypeScript `private` 普通属性可以使用；
需要 runtime 强封装时，把状态放进 closure，或从 capability 返回带有明确 stop/replacement 失效语义的 handle。这个限制不适用于
不会作为 provider dependency facade 暴露的 `PluginPart`；Part constructor 接收依赖不会让 Part 自己成为 graph provider。

Plugin 对其他节点暴露的可调用成员使用 prototype method；accessor 只返回普通数据，或有自身 receiver 与失效契约的对象 handle。
不要使用 `status = () => ...`、function expression field 或 `this.status.bind(this)` field。这些写法会捕获 raw provider，无法保留 consumer 的 caller Context，构建工具会报
`plugin_caller_view_callable_field_unsupported`。普通数据 field 仍可读写；需要 callable handle 时返回有独立对象 receiver 和明确
stop/replacement 失效语义的 capability。

dependency facade 在 provider construction 完成后固定 ordinary field/prototype surface，因此不要用 type-only
`declare field` 或在 `init()`/method 中动态增加跨 Plugin 字段；前者会得到
`plugin_caller_view_declared_field_unsupported`。需要暴露的数据使用真实 class field，需要行为使用 prototype method。

## Optional integration

如果最终宿主可以完全不安装 provider，使用 type-only import 和 module-level opaque ref：

```ts twoslash
// @filename: audit.ts
import { BasePlugin } from '@pluxel/core'

export declare class AuditPlugin extends BasePlugin {
	registerSource(source: BasePlugin): void
}

// @filename: orders.ts
import type { AuditPlugin } from './audit.ts'
import { BasePlugin, definePluginRef, Plugin } from '@pluxel/core'

const Audit = definePluginRef<AuditPlugin>()

@Plugin({ displayName: 'Orders' })
export class OrdersPlugin extends BasePlugin {
	protected override init() {
		this.plugins.use(Audit, (audit) => audit.registerSource(this))
	}
}
```

这条写法有严格边界：

- ref 是 non-exported module-level `const`；
- type 必须能唯一追溯到具体 Plugin 的 package-root named export；
- `plugins.use()` 是 `init()` 中的直接语句；
- callback 同步执行，可以返回 cleanup 或 disposable；
- ref 不会 import、安装、注册 provider package，也不会改变其自动启动策略。

provider absent、当前未运行或 start-failed 时 callback 不执行，也不阻塞 consumer。provider generation 出现、消失或 replacement 时，Core 会重启 consumer 及其 required dependent closure，使 optional integration 不会持有旧 provider。

不要用动态 `import()`、轮询 availability 或缓存裸实例模拟 optional edge。高频变化的业务对象也不适合建模为 Plugin graph edge。

## 用 PluginPart 拆分插件内部资源

连接管理、缓存和同步任务需要各自的配置与清理，但始终跟随同一个 Plugin 启停时，使用 `PluginPart`。
这里的 owner 就是包含这个 Part 的插件；Part 不会变成可单独启停或被其他插件注入的新节点。

完整缓存示例见[使用 PluginPart](./parts.md)。没有这些资源需求时，普通函数或类即可。

## 启动、资源与事件

资源获取、失败初始化及停止清理见[生命周期与 effects](./lifecycle.md)。`ctx.events` 广播与依赖提供方的 `EvtChannel` 用法见[事件](./events.md)；事件类型声明本身不会建立依赖。

## Identity 不等于 class name

具体 Plugin 必须由显式公开的包根或子路径的唯一 named export 暴露；host-local Plugin 则来自 canonical source entry 的唯一 root export。

配置、日志和跨进程调用使用稳定地址：`PluginDefinitionAddress` 标识实现，`PluginNodeAddress` 标识默认实例或某个 fork。
不要把类名或展示名称当作持久化 ID。

fork 是同一个插件实现的另一个运行实例：共享实现、schema 和源码更新，各自持有配置、生命周期与资源。只有确实能安全运行多个实例的 concrete Plugin 才声明
`@Plugin({ forkable: true })`；abstract capability 本身不承诺 forkability，每个 provider 独立作出决定。class name、constructor
object 与 `displayName` 都不参与 identity；`displayName` 用于界面和 pretty log。日志与 Workbench 会显示 package/source、
root export 和 fork，例如
`package:@acme/orders::OrdersPlugin#fork=east`，不会把 opaque digest 当作公开 Plugin ID。

HTTP 路径不从 Plugin identity 派生。Plugin 在 generation-scoped `ctx.require(ElysiaApp)` 中声明的 path 就是最终产品 contract；fork 若要
同时提供 HTTP，必须从已校验业务 config 得到彼此不冲突的显式 namespace，或由唯一 gateway Plugin 统一承载入口。

Plugin source 必须经过 Pluxel Vite/Rolldown pipeline。raw TypeScript runner 不生成这些语义事实。

下一步按任务选择：[使用 PluginPart](./parts.md)或[配置模型](./configuration.md)。HTTP、worker、Workbench 和完整测试矩阵都是按需专题，不是继续理解核心模型的前置阅读。
