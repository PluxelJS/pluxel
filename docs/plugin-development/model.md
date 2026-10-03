---
title: 插件依赖与组成
description: 按业务契约、组合职责和生命周期选择依赖、聚合、桥接与注册模式。
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
| 可选 Plugin 集成 | 允许提供方缺席，接受其变化引起的重启   | `definePluginRef<T>()` + `plugins.use()` |
| PluginPart       | 需要局部配置和资源，但随父插件一起启停 | `this.parts.use(CachePart)`              |
| 简单内部 helper  | 只有少量纯逻辑或显式 wiring            | 普通类或函数，按需登记清理               |

需要被多个插件注入、独立启停的能力适合 Plugin；只服务当前插件的缓存、客户端和辅助逻辑，通常保留为内部代码。

组合逻辑可以由消费方、聚合插件或独立桥接插件拥有，按[架构选型](#先确定组合职责与依赖方向)判断。

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

可选依赖允许 provider 缺席，consumer 仍须履行自己的业务契约，并接受 provider 变化引起的重新初始化。
它适用于内部增强和多来源聚合；依赖数量和代码长短不是选型依据。

### 先确定组合职责与依赖方向

按以下顺序决定依赖模式：

1. **缺失语义**：提供方不可用时，对外承诺是否仍成立？不成立就声明 required。
2. **组合职责**：谁负责识别来源、适配协议和合并结果？由这一方声明依赖。
3. **生命周期**：提供方变化时，消费方及其下游能否接受重启？不能接受就重新划分集成边界。

**应用可以不装配某项功能，不等于该功能内部的依赖可选。** 例如桥接插件可以不装配，但一旦运行，双方都是必需依赖。
各模式可以组合使用：

| 业务关系                           | 依赖方向与模式                             | 主要取舍                                             |
| ---------------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| 完成业务必须调用某项能力           | consumer 必需依赖 provider                 | 缺失应阻止启动；运行中的调用失败仍需业务处理         |
| 当前插件自身的可选增强             | consumer 可选依赖 provider                 | 组合逻辑属于 consumer，允许它随 provider 变化重启    |
| 统一查询多个已知、可缺席的数据源   | 聚合器可选依赖各来源                       | 来源无需知道聚合器；聚合器承担部分结果语义和重启影响 |
| 两个独立能力之间的适配、同步或转发 | 桥接插件必需依赖双方                       | 将集成生命周期集中到桥接插件，应用显式装配它         |
| 新增贡献者时不希望修改中心插件     | 贡献者或适配插件依赖中心，调用领域注册协议 | 中心无需枚举贡献者，但必须设计注册、撤销与失效语义   |

不要为了减少依赖条数、省去装配或绕开依赖环而使用 optional。聚合、桥接和注册各有职责边界，没有统一优先级。

### 声明可选集成

使用 type-only import 和 module-level opaque ref。下面假设审计只是辅助记录，注册操作返回注销函数；
若“没有审计就不能接单”，Orders 应声明 required，并在业务操作中处理审计失败。

```ts twoslash
// @filename: audit.ts
import { BasePlugin } from '@pluxel/core'

export declare class AuditPlugin extends BasePlugin {
	registerSource(source: BasePlugin): () => void
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

### 对启动图和生命周期的影响

optional 允许 provider 不可用，但仍然声明了一条图上的依赖边：

- provider 在图中存在时，optional edge 参与启动排序和环检测。把 required 改成 optional 不能消除依赖环；例如 A 可选依赖 B、B 必需依赖 A，双方存在时仍然成环。
- provider absent、当前未运行或 start-failed 时 callback 不执行，也不阻塞 consumer；optional 声明本身不会启动 provider。
- provider generation 出现、消失或 replacement 时，Core 会重启 consumer，以及直接或间接必需依赖它的下游插件，使 optional integration 不会持有旧 provider。旧 consumer 会清理资源，新实例会重新初始化；一直不可用的 provider 重试失败不会单凭这次重试触发 consumer 重启。
- callback 在 consumer 的 `init()` 内执行，抛错会让 consumer 初始化失败。provider 可选不代表集成代码的错误会被忽略。

把集成挪到 `PluginPart` 不会隔离重启影响：Part 的 optional edge 仍合并到所属 Plugin。

不要用动态 `import()`、轮询 availability 或缓存裸实例模拟 optional edge。高频变化的业务对象也不适合建模为 Plugin graph edge。

### 聚合多个可选数据源

多个插件提供同类数据、聚合器负责统一查询时，由聚合器可选依赖来源。箭头表示“依赖于”：

```text
Consumer -> DataCatalog
DataCatalog --optional--> SourceA
DataCatalog --optional--> SourceB
DataCatalog --optional--> SourceC
```

DataCatalog 在 `init()` 中为每个已知来源分别声明直接的 `plugins.use()` 调用，将可用来源接入当前实例，
再通过自己的公开方法拉取和合并数据。每次重新初始化都从当前可用来源建立集合，不把 provider 实例或方法引用存到跨 generation 的全局缓存。
`plugins.use()` 的同步 callback 负责接入；异步查询及其失败处理放在明确的业务调用中。

这利用了 optional 的缺失容忍、启动排序和 generation 变化后的重新初始化。来源无需知道或依赖 DataCatalog。
在没有其他依赖关系时，DataCatalog 的变化不会通过这些边重启来源；来源变化则可能重启 DataCatalog 及其必需下游。
重点评估来源变化频率和聚合器的下游范围。

聚合器必须明确以下业务契约，不能让 optional 代替这些决定：

- 零个来源时，是合法空结果、显式不可用，还是初始化失败；如果某个来源始终必需，就对它声明 required，其他来源仍可 optional。
- 来源未接入、查询失败和查询成功但没有数据如何区分；返回部分结果时，调用方如何识别缺失来源和完整性。
- 多来源数据如何确定身份、去重、排序或处理冲突；并发查询如何处理超时、取消和单项失败。

这种模式显式枚举已知来源。`definePluginRef<T>()` 不会自动发现所有实现同一 TypeScript 接口的插件，
新增来源通常需要修改聚合器的声明；需要开放贡献时，再考虑下面的注册模式。

### 开放贡献与注册模式

如果中心插件需要接收未知数量的第三方贡献者，可以由贡献者调用中心公开的注册方法；若贡献者不应知道中心，
由独立适配插件必需依赖双方，负责注册。这是应用设计的领域协议，不能把它当作 `plugins.use()` 自带的发现能力。

注册方是否可选依赖中心，仍由缺失语义决定：贡献者没有中心也有独立业务时可以 optional；
专门负责向中心贡献功能的适配插件通常应 required。不要同时让中心依赖贡献者、贡献者又依赖中心，形成依赖环。

注册协议需要明确贡献标识、重复注册规则、撤销方式，以及正在执行的调用如何取消或完成。
注册应返回可释放的登记资源，由注册方在停止或初始化回滚时清理；中心不得在来源停止后继续调用保存的实例或回调。
这种设计让中心不必因贡献集合变化而重启，但需要显式处理集合变化和资源失效；中心自身变化仍可能重启依赖它的注册方。

### 何时拆出桥接插件

如果 Orders 和 Audit 各自有完整职责，而“把订单事件接入审计”是组合后的功能，可以新增 `OrdersAuditPlugin`，
在构造器中必需依赖 `OrdersPlugin` 和 `AuditPlugin`。依赖方向如下，箭头表示“依赖于”：

```text
OrdersAuditPlugin -> OrdersPlugin
OrdersAuditPlugin -> AuditPlugin
```

对同一个辅助审计需求，两种设计的取舍如下。这里假设没有其他依赖边连接 Orders 和 Audit：

| 场景                                   | Orders 可选依赖 Audit                       | 桥接插件必需依赖双方                            |
| -------------------------------------- | ------------------------------------------- | ----------------------------------------------- |
| Audit 不可用                           | Orders 运行，跳过审计集成                   | Orders 运行，桥接插件不能运行                   |
| Audit 从不可用变为运行，或替换运行实例 | Orders 重新初始化，其必需下游也受影响       | 桥接插件建立或重建集成，Orders 不因这条关系重启 |
| 集成初始化抛错                         | Orders 初始化失败                           | 桥接插件初始化失败，双方基础插件可继续运行      |
| 增加一种集成                           | 修改 Orders，增加 optional 声明和初始化逻辑 | 新增桥接插件，并由应用装配                      |

Orders 和 Audit 无需为这项集成互相声明依赖。由应用显式装配桥接插件，桥接插件在双方成功运行后建立订阅，
并为自己创建的订阅或其他资源登记清理，具体写法见[事件](./events.md)和[生命周期](./lifecycle.md)。

桥接插件增加了一个需要装配、配置和观察状态的节点，也要求双方提供足够的公开能力；不要让基础插件反过来依赖桥接插件来完成自己的初始化。
它隔离的是这项集成引入的生命周期影响，不保证业务操作不会互相影响。方法调用或事件处理中的失败仍按对应业务协议传播。
尤其是事件桥接，订阅建立前或桥接停止期间的通知不会自动补发；需要补偿、重放或可靠交付时，应另行设计持久化和恢复协议，不能仅靠拆插件保证。

集成需要独立配置、启停或失败处理，或基础插件开始积累不属于自身职责的第三方适配时，考虑拆出桥接插件。
归属明确的内部增强和聚合逻辑仍可留在消费方，无需为每个 callback 新建插件。

### 验证所选架构

隔离回归按[插件测试](./testing.md)编写，断言业务结果和实例是否替换，不能只检查 callback 执行：

| 范围               | 验证重点                                                                            |
| ------------------ | ----------------------------------------------------------------------------------- |
| 所有 optional 集成 | provider 缺失、首次可用、替换、停止和集成初始化失败时的运行状态、重启范围、资源清理 |
| 聚合器             | 零来源、部分来源失败、结果完整性                                                    |
| 注册模式           | 重复注册、撤销、中心重启后重新注册、来源停止后的旧调用失效                          |
| 桥接插件           | 一方变化时另一方实例保持不变；需要可靠事件处理时，验证停用期间的数据恢复            |

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
