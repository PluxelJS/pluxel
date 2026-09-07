---
title: 为什么是 Pluxel？
description: 从 Koishi 与 Cordis 的实践出发，理解 Pluxel 对依赖身份、Context、生命周期和构建语义的选择。
---

Pluxel 是对 [Cordis v3](https://github.com/cordiverse/cordis/tree/f8f10ec6734ebb4558addeba0f6a25294684d494) 插件思想的一次再诠释。我们延续 Context、依赖注入和资源随插件回收的模型，希望把业务依赖的声明、类型和运行时身份进一步连接起来：开发者写下导入和构造函数参数，构建工具记录依赖关系，运行时据此管理启动、替换与清理。

这篇文章解释这套选择从何而来，以及它带来的能力和限制。阅读顺序是：实践来源 → Cordis 的依赖模型 → Pluxel 的选择 → 实现取舍与代价。想先体验应用，可以从[快速开始](./getting-started/index.md)创建项目，再回来了解这些设计。

## 从 Koishi Plugin 实践出发

我们从 2023 年开始编写 [Koishi](https://github.com/koishijs/koishi) 插件。Koishi 的插件运行时建立在 Cordis 之上；本文引用的 `@koishijs/core` 提交明确依赖 [Cordis 3.18.1](https://github.com/koishijs/koishi/blob/fb6e2c092242c0387f07f36e21082d5715c48449/packages/core/package.json#L36-L42)。Pluxel 对依赖模型的思考，来自持续编写、组合、替换插件和处理其资源生命周期的经验。

Cordis 的应用也已超出 Koishi 生态。DeepSeek 官方的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a) 将其 “everything is a plugin” 架构标记为 [powered by Cordis](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/README.md#L1-L9)，并在仓库中维护和发布 [Cordis 4.0.1](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/package.json#L1-L12)。这些实践说明了插件模型可以服务于不同类型的应用。

下面的代码与类型对比以链接中固定提交的 **Cordis v3** 为依据。DeepSeek Harness 的采用是模型背景，不作为推断 Cordis v4 实现细节的依据。

## 从 Cordis 学到的 Plugin 模型

Cordis 把功能组织成具有 Context 和生命周期的插件，这给应用组合提供了几个重要基础：

- **插件是能力与副作用的边界。** 一个功能可以连同它的监听器、定时器和其他资源一起装载、卸载。
- **Context 关联调用者与资源所有者。** 共享服务处理调用时，需要知道注册和清理属于哪个插件。
- **依赖可用性参与生命周期。** 必需服务尚未出现时等待，服务变化时卸载并按条件重新加载插件。
- **scope 和 effect 管理清理。** 资源跟随所属作用域释放，动态替换不必重启整个应用。

Pluxel 保留了这些判断。我们进一步关注的问题是：同一条业务依赖，如何在编辑器、构建产物和运行时中保持可追溯的关联？

## Cordis 如何连接类型与运行时

理解差异，需要分清 Cordis 中两个配合工作的部分：TypeScript 为 Context 提供类型，运行时根据服务名称和依赖声明决定插件何时可用。

### Declaration merging 提供 Context 类型

Cordis v3 的 service package 通过 module augmentation 扩展 `Context`。以 timer package 为例，下面保留类型扩展与服务注册，省略具体计时器实现：

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

	// setTimeout 的具体实现见下方源码链接。
}
```

当包含这些声明的 package 进入 TypeScript program 后，`timer` 和 `setTimeout` 会合并进 `Context` interface，编辑器因而能检查 `ctx.timer` 和 `ctx.setTimeout()` 的使用。完整实现见 [timer package 源码](https://github.com/cordiverse/cordis/blob/f8f10ec6734ebb4558addeba0f6a25294684d494/packages/timer/src/index.ts#L1-L35)。

`declare module` 建立静态类型表面；服务是否已经注册、当前是否可用、何时释放，则由 Cordis runtime 处理。类型中存在某个属性，与当前插件可以使用该服务，是需要分别表达的两件事。

### 一个名称连接注册、依赖和访问

以 `database` 服务为例，下面三个片段分别位于 provider 和 consumer 中：

```ts
// provider：以 database 名称注册服务
super(ctx, 'database')

// consumer：声明自己依赖 database 服务
export const inject = ['database']

// consumer：通过 Context 使用服务
ctx.database.get(table, id)
```

`database` 同时连接服务注册、依赖 metadata 和 Context 属性。Cordis 的 [Service 文档](https://github.com/cordiverse/cordis/blob/f8f10ec6734ebb4558addeba0f6a25294684d494/packages/core/README.md#L380-L407) 明确约定：必需服务为真值时插件才加载；服务变化时插件卸载；新值仍可用时插件重新加载。依赖可用性和动态生命周期已经是这套模型的一部分。

类型扩展可以检查 `ctx.database` 的属性访问，却不会自动生成或同步 `inject: ['database']`。对应源码中的 [`Inject`](https://github.com/cordiverse/cordis/blob/f8f10ec6734ebb4558addeba0f6a25294684d494/packages/core/src/registry.ts#L10-L43) 类型为 `string[] | Dict<Inject.Meta>`。如果 consumer 改用另一个已声明的 Context 属性，还需要同时维护依赖 metadata。

这种按名称连接的模型保留了运行时绑定的灵活性：consumer 可以声明所需的服务名称，而不必通过值导入绑定提供该服务的具体插件。常量、lint 或封装可以帮助维护名称的一致性；在上面的基础写法中，这几个位置仍是分别声明的。

## Pluxel 为什么选择另一种依赖表达

在长期维护多个插件包时，我们希望构建工具能够沿源码回答：这个参数依赖哪个包的哪个插件导出？声明的依赖是否就是代码正在使用的依赖？这个身份能否继续用于配置、日志、替换和发行检查？

这对应三个具体问题：

1. **声明与使用需要一起维护。** 独立的依赖名称列表和属性访问容易在修改时不同步，尤其是两边各自仍满足 TypeScript 类型检查时。
2. **服务名称没有直接表达来源。** 名称能够参与运行时查找，但它本身不包含包根入口、具名导出或构建时记录的来源关系。
3. **一部分错误希望提前发现。** 服务是否存在仍需运行时判断；可追溯的导入、参数与包边界错误，则可以交给构建阶段检查。

Pluxel 因此把必需插件依赖写在构造函数中：

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

构建工具在 TypeScript 擦除类型之前，记录 `AccountsPlugin` 的值导入来源及构造函数参数位置。包根入口与具名导出确定插件定义，参数声明确定依赖边；运行时根据这些 metadata 注入当前的 provider 实例。

业务插件不再另写一份 `inject` 列表，也不通过扩展 Context 属性注册自己。构造函数依赖的具体规则见[插件依赖与生命周期](./getting-started/plugin-model.md)。

### 两种选择的区别

| 比较点                 | Cordis v3 的上述 service 写法    | Pluxel 的必需插件依赖                        |
| ---------------------- | -------------------------------- | -------------------------------------------- |
| consumer 如何声明依赖  | `inject` 中的服务名称            | 构造函数中的插件参数与值导入                 |
| consumer 如何访问能力  | 对应的 Context 属性              | 注入的插件实例                               |
| 类型从哪里来           | Context 的类型扩展和服务类型     | 导入的插件类型与构造函数签名                 |
| 依赖关系如何进入运行时 | 运行时读取名称与依赖 metadata    | 构建工具从源码生成依赖 metadata              |
| provider 变化时怎么办  | 依赖服务变化驱动卸载和重新加载   | 依赖图与插件实例生命周期驱动替换、重启和清理 |
| 主要取舍               | 保留按名称进行运行时绑定的灵活性 | 以源码和构建约束换取可追溯的依赖身份         |

两者都提供类型支持，也都处理动态生命周期。Pluxel 增加的约束服务于源码、构建与运行时身份的一致性；这些检查也不能替代实际启动、业务校验或运行时的依赖可用性判断。

## Pluxel 的能力边界

明确业务依赖之后，还需要决定哪些能力进入插件依赖图，哪些由宿主统一提供，哪些只属于插件内部。把这几种关系混在一起，会使资源归属和替换行为难以解释。

| 能力关系     | 标准表达                                         | 身份与生命周期                                           |
| ------------ | ------------------------------------------------ | -------------------------------------------------------- |
| 必需插件依赖 | 构造函数参数与值导入                             | 进入依赖图，由插件定义和当前运行实例决定                 |
| 可选插件集成 | 类型导入、`definePluginRef()` 与 `plugins.use()` | 进入可选依赖图，provider 实例变化时重启受影响的 consumer |
| 宿主公共设施 | root 创建前确定的 Context 能力                   | 由宿主组合，调用和注册绑定明确的 Context                 |
| 插件内部组成 | 普通类、函数、effects scope 或 PluginPart        | 随所属插件的运行实例回收                                 |

每次插件启动都会创建新的运行实例，称为一个 **generation**。替换、回滚和关闭需要处理的是这些具体实例及其资源，不能只按类名判断一个旧句柄是否仍可使用。

### 业务依赖进入 Plugin graph

必需依赖使用前面的构造函数写法。可选集成则只导入 provider 的类型，用 `definePluginRef()` 建立保留来源信息的引用，再通过 `plugins.use()` 使用。可选 provider 不存在时，插件仍能完成自己的核心功能；provider 的运行实例变化时，运行时会重启相关 consumer。

两种关系都参与插件依赖图。可选引用使代码不必为“可能不存在的集成”建立直接的值导入，同时仍让工具链追溯它指向的插件。

普通计算和数据转换可以保持为函数或类。需要在同一个插件内部拆分配置、注册与清理时，再使用 [PluginPart](./getting-started/plugin-parts.md)；它不产生一个可以独立启停的治理节点。

### 宿主公共设施进入 Context

HTTP、配置、日志、effects、commands 和持久化等由宿主提供。公开的 `@pluxel/context` 是独立于 Plugin Runtime 的 Context host kernel；需要构建独立宿主的应用，可以在创建 root 前组合能力集合。

这个 kernel 负责同步、严格惰性的能力投影：只有访问时才构造所需的值，能力集合一经编译便不能修改。它本身不负责资源启动，也不调用能力的 `prepare()` 或 `dispose()`；资源生命周期由使用它的宿主管理。

Pluxel Runtime 使用同一个 kernel，在创建 root Context 时一次性编译官方能力。业务插件不能在模块执行或 `init()` 阶段动态改写 Runtime 的 Context 能力集合，第三方业务能力继续通过插件依赖图组合。Context 暴露可使用的能力和当前资源归属，不直接暴露完整宿主配置。

能力可以选择不同的共享范围：

| 作用域     | 在 Runtime 中的含义                                         |
| ---------- | ----------------------------------------------------------- |
| root       | 整个宿主共享的能力或后端                                    |
| scope      | 一个插件 generation 及其 Part、依赖调用视图共享的状态       |
| owner-view | 后端可以共享，但每个插件、Part 或依赖调用边有自己的访问视图 |

**owner-view** 是绑定明确 Context 的能力视图。例如，日志和事件服务可以共用后端，但每个调用者的日志归属、订阅和清理项保持独立。它们不依赖共享对象上一个会被异步调用反复改写的“当前 ctx”。独立宿主的组合方式见 [Context 参考](./reference/context-hosts.md)。

### 原生 HTTP 与框架生命周期如何配合

`ctx.elysia` 是严格惰性创建的真实 Elysia 2 application。同一个 generation 的插件与全部 Part 共享这一个 app，Elysia 中声明的路径就是最终产品路径，插件继续使用上游的路由、schema、hook 和 stream API。

Pluxel 补充的是它与插件依赖图的关系：在 `init()` 完成后 compile/seal，随 generation 原子发布或撤销路由，并把请求接纳、退出等待和流式响应体纳入资源生命周期。监听端口以及面向 srvx 的 HTTP carrier 接入由宿主拥有。这样，插件可以使用原生 HTTP 框架，同时让接口的可用性跟随自己的运行实例。具体用法见 [HTTP 指南](./runtime/http.md)。

## 为什么本地能力优先保持 Proxy-free

这里关注的是调用者身份和资源归属能否保持稳定。已知成员集合可以用普通对象、类或一次编译的 property descriptor 表达时，Pluxel 优先采用这些方式，让缓存句柄、反射和异步并发下的行为更容易解释。

目前几个关键位置遵循这一选择：

- **Context getter 与 owner-view**：能力形状预先编译，视图持有固定 Context，不通过 Proxy 改写共享对象上的调用者。
- **插件依赖的 caller facade**：provider 构造后固定可调用的成员表面，每次接纳的调用使用独立的普通 receiver，以保持并发调用的上下文归属。
- **具名 `EvtChannel`**：直接接收 owner Context，consumer 的订阅通过缓存的普通 facade 绑定到 effects。
- **`ctx.events`**：共享 root emitter 后端，每个 owner 取得绑定固定 Context 的普通服务视图，订阅进入自己的清理作用域。
- **配置快照**：每个 revision 返回深冻结的普通 snapshot。`configs.use()` 初始化时的占位 token 也保持冻结；初始化完成前读取配置由工具链拒绝。
- **`ctx.elysia`**：直接提供真实的上游实例，不用 Proxy 再包一层 HTTP API。

这种选择允许在确有需要的边界使用 Proxy。Workbench 的浏览器 Cap’n Web RPC stub 就是一个例子：远端方法来自运行时已经擦除类型的契约，本地没有可预编译的方法 schema，Proxy 能自然表达远程调用。

这个 RPC 边界不承担后端插件的依赖身份、Context owner 或生命周期排序。远端 observer 仍是显式的 Cap’n Web target，订阅由返回的 disposer 和 socket epoch 管理；socket epoch 可以理解为当前连接会话的有效期。网络断开或句柄被释放后，不能继续把旧 observer 当作有效订阅。

## 为什么称为 typed meta-framework

TypeScript 源码本身参与形成框架语义。这是 Pluxel 将类型信息、构建工具和运行时一起设计的原因：

| 源码中的声明          | 框架得到什么                      | 后续用于哪里                                   |
| --------------------- | --------------------------------- | ---------------------------------------------- |
| 构造函数参数与值导入  | 必需依赖边                        | 依赖检查、启动顺序与注入                       |
| 可选引用中的类型来源  | 可选依赖边                        | provider 可用性变化与 consumer 重启            |
| 包根入口与具名导出    | 稳定的 Plugin definition identity | 配置、日志、插件目录与替换                     |
| Valibot schema        | 配置类型、默认值、归一化与校验    | 宿主配置和 Workbench 表单                      |
| 构建时生成的 metadata | 可消费的插件与资源描述            | static catalog、dynamic source、发行与管理界面 |

类型、构建产物和运行时依赖图使用同一套插件身份。Static host 可以冻结和审计发行所需的完整闭包；dynamic host 在固定基线上增加可变来源的发现。两种 Vite 宿主都支持替换和 HMR，业务插件的写法保持一致。

这也解释了为什么 Pluxel 要求插件经过对应工具链：普通 TypeScript 类型擦除不会自动保留这些框架需要的关系。

## 性能取舍

把一部分工作提前，不代表运行时没有成本。Pluxel 在构建或 generation 构造阶段处理部分依赖解析和 caller 成员表面编译；运行时仍需提交依赖图变化、判断是否接纳调用，并为调用分配独立 receiver。

Context 的实现也区分了身份查找与日常访问。host 编译时用 capability descriptor 的**对象身份**建立映射，再分配 numeric slot；成功构造的能力值按 root、scope 或 owner-view 缓存。常规的 `ctx.foo` 缓存访问直接读取预编译 slot，不在 getter 热路径重复进行 descriptor 的字符串或 `Map` 查找。

这里使用 `Map` 是为了保留 descriptor 对象身份。`Object.create(null)` 适合字符串或 symbol key，不能直接替代以对象身份作为 key 的语义。这个细节说明了为何要分别考虑模型需要的身份语义、编译成本和热路径成本。

Pluxel 与 Cordis v4 目前没有同场、同语义的 benchmark，不能据此判断哪个框架更快。相关实现由 `@pluxel/context` 等包的 benchmark 持续验证；趋势数据也不能直接变成跨机器的延迟或吞吐承诺。这里的主要目标是依赖检查、身份一致性和可撤销调用，性能结论需要对应的测量支持。

## 选择与代价

这些能力建立在明确的约束之上：

- 插件源码必须经过 Pluxel 的 Vite/Rolldown 处理，保留构建所需的依赖与资源信息。
- 可发布插件必须来自可追溯的包根具名导出；无法确定稳定来源的动态写法会被构建工具拒绝。
- 插件作者需要遵循依赖图和 generation 生命周期：长期资源登记清理，旧实例退出后不继续复用其句柄。
- 应用显式选择插件清单和宿主能力，并承担它们的组合与交付配置。

这些限制适合需要长期维护插件组合、配置、热更新、可审计发行和资源回收的应用。它们也减少了一部分开放字符串注册和任意动态装配的自由度。是否值得采用，取决于应用是否需要这套可追溯的依赖与生命周期模型。

要实际体验，可以用[快速开始](./getting-started/index.md)创建已配置好工具链的项目；要继续理解作者模型，阅读[插件依赖与生命周期](./getting-started/plugin-model.md)。框架实现和约束的索引在[工程文档](https://github.com/PluxelJS/pluxel/blob/main/engineering/README.md)。
