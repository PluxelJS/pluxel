# 插件最佳实践

本文是写代码和 code review 时的快速决策指南。完整 API 示例见
[`plugin-authoring.md`](plugin-authoring.md)，测试策略见 [`testing.md`](testing.md)，能够自动检查的
约束见 [`oxlint.md`](oxlint.md)。

## 按所有权组织代码

标准插件把声明、依赖、运行和可选Workbench分开：

```ts
const OrdersUi = workbenchContract.define({ views: {} })
const OrdersWorkbench = workbench.extension({
	contract: OrdersUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})

@Plugin({ name: 'OrdersPlugin' })
export class OrdersPlugin extends BasePlugin {
	private readonly config = this.configs.use(OrdersConfig)

	constructor(private readonly database: DatabasePlugin) {
		super()
	}

	override async init(signal: AbortSignal) {
		const worker = await createWorker(this.config, { signal })
		this.ctx.effects.defer(() => worker.stop())

		this.ctx.http.plugin.routes((app) => app.get('/orders', () => this.list()))

		this.ctx.workbench.mount(OrdersWorkbench, {})
	}
}
```

- module scope 和 class field 只放 declaration；不要在这里启动 I/O 或 lazy feature。
- constructor 只声明必需的 plugin dependency；不要读取 config、连接服务或决定宿主策略。
- `init()` 验证启动条件、创建资源、注册业务能力；无法提供核心能力时直接抛错。
- `ctx.workbench.mount()` 只挂载 Workbench resource Binding，业务行为不得依赖其返回值是否存在。

## Required、optional 与 feature

| 意图                     | 标准写法                                                       | 不要这样写                            |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------- |
| 没有 provider 就不能运行 | constructor parameter                                          | 在 decorator 重复依赖或运行时自行查找 |
| provider 仅提供增强能力  | `this.plugins.use(Provider, callback)`                         | optional provider 放进 constructor    |
| 插件内部必需组成         | decorator `features` + `this.features.use()`                   | 为内部实现制造独立 plugin             |
| 插件内部按需组成         | module-level `defineLazyFeature()` + runtime `features.load()` | 静态 import 后伪装 lazy load          |

constructor dependency 必须是 runtime import，不能使用 `import type`。插件源码也必须由 Pluxel
Vite/Rolldown pipeline 加载，否则 decorator metadata 不完整。

## 配置只声明和归一化一次

- 默认值写进 schema。
- `this.configs.use(schema)` 保持为 module-top-level plugin class 的普通字段，不能使用 `#private`。
- runtime 在实例构造后、`init()` 前注入归一化值，因此只在 `init()` 或之后读取。
- 不要再写 `this.config.timeout ?? 5000`；这会掩盖 schema 缺陷和无效输入。

## 生命周期要诚实且可回收

- 外部服务不可达、schema 不匹配或必要配置无效时，让 `init()` 失败并给出行动建议。
- 资源创建成功后立即登记 cleanup；不要等到函数末尾才统一登记。
- cleanup 必须幂等，并能处理部分初始化。
- timer、watcher、queue consumer 的单次错误属于业务错误，应捕获、结构化记录并按业务语义重试。
- 插件不得调用 `process.exit()`；插件报告事实，宿主决定退出、告警或降级。

## 保持业务面独立

| 能力                                     | 放置位置                                  |
| ---------------------------------------- | ----------------------------------------- |
| 业务 HTTP、webhook、外部 health endpoint | `ctx.http.plugin`                         |
| Workbench UI、API、stream、collection    | `ctx.workbench.mount(module, bindings)`   |
| 业务状态和事实源                         | 插件自己的 runtime/persistence capability |
| 进程退出、部署和健康策略                 | host                                      |

测试至少覆盖一次 `workbench: false`，证明业务 HTTP 和核心生命周期不依赖Workbench。

## API 与日志

- 固定事件集合使用具名 `EvtChannel`，不要退化为宽泛的 `Map<string, unknown>`。
- 外部平台 capability 让原生具名方法留在顶层；raw、诊断和组合工具统一放在 `$`。
- 从 `ctx.logger` 派生 logger，不直接导入 LogTape `getLogger()`。
- 调试日志使用 `ctx.logger.getDebugChannel('cache:lookup')`；topic 不带 `pluxel:` 前缀，也不包含 wildcard。
- 插件级日志等级由 active runtime policy 动态控制；插件不要读取 env 或自行缓存等级。
- 错误对象通过 `{ error }` 或 `{ err }` 结构化传递，不插值、不 stringify、不只记录 `.message`。
- UI RPC/SSE/SignalDB contract 放在共享类型边界，并为 `@pluxel/runtime/web` 提供 type augmentation。

## 提交前检查

1. 运行 `pnpm lint:fix`，阅读并理解仍未修复的 Pluxel rule；不要用 disable 绕过所有权问题。
2. 运行 `pnpm verify`，覆盖 format、unused suppressions、typecheck、tests 和 production build。
3. 确认 required/optional、plugin/feature、HTTP/workbench 三组边界都清楚。
4. 确认启动失败不会留下 running 假象，每个资源都有幂等 cleanup。
5. 确认 disabled Workbench Plane 测试仍通过，公开 contract 类型能被消费者发现。
6. 测试是否通过 `@pluxel/test/vitest` 和匹配边界的 core/runtime host 运行，而不是 mock Context 或
   raw TypeScript runner？
