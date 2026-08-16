# 插件最佳实践

本文是写代码和 code review 时的快速决策指南。package、tsdown 和发布边界见
[`plugin-package.md`](plugin-package.md)，完整 API 示例见
[`plugin-authoring.md`](plugin-authoring.md)，测试策略见 [`testing.md`](testing.md)，能够自动检查的约束见
[`oxlint.md`](oxlint.md)。

## 按所有权组织代码

标准插件把声明、依赖、运行和可选Workbench分开：

```ts
const OrdersUi = workbenchContract.define({ views: {} })
const OrdersWorkbench = workbench.extension({
	contract: OrdersUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})

@Plugin({ displayName: 'Orders' })
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

- module scope 和 class field 只放 declaration；不要在这里启动 I/O 或执行 lazy import。
- constructor 只声明必需的 plugin dependency；不要读取 config、连接服务或决定宿主策略。
- `init()` 验证启动条件、创建资源、注册业务能力；无法提供核心能力时直接抛错。
- `ctx.workbench.mount()` 只挂载 Workbench resource Binding，业务行为不得依赖其返回值是否存在。

constructor dependency 是带 `ctx.caller` 的轻量 view。provider method 中的顶层标量赋值属于当前 caller view，
不应拿来表达跨 consumer 的共享 mutation。provider-wide 状态放进稳定对象并修改对象内容；caller-owned 状态用
`Context` 作 key：

```ts
import { BasePlugin, type Context } from '@pluxel/runtime'

class SharedProvider extends BasePlugin {
	private readonly state = { defaultName: 'system' }
	private readonly callers = new Map<Context, unknown>()

	setDefault(name: string) {
		this.state.defaultName = name
	}
}
```

不要在 caller 调用路径写 `this.defaultName = name` 并期待其他 consumer 看到新值。provider stop/replacement 仍由
effects 清理共享对象持有的外部资源。

## Required、optional 与内部组成

| 意图                             | 标准写法                                                  | 不要这样写                            |
| -------------------------------- | --------------------------------------------------------- | ------------------------------------- |
| 没有 provider 就不能运行         | constructor + direct root value import                    | 在 decorator 重复依赖或运行时自行查找 |
| provider package 允许不存在      | `definePluginRef<T>()` + init-time `plugins.use(Ref, cb)` | raw import、轮询或缓存 provider 实例  |
| Plugin 内部拆分                  | 普通 class/function + owner effects                       | 创建第二套内部 lifecycle              |
| 独立配置、失败、启停或治理的组成 | 独立 Plugin                                               | 把治理边界藏进普通 helper             |

constructor dependency 必须从 provider package root value-import，不能使用 `import type`。optional ref 的 `T` 则必须来自
root direct type import，ref 自身不导出。Plugin 源码必须由 Pluxel Vite/Rolldown pipeline 加载，否则 definition/edge facts
缺失并明确失败。

## 配置只声明和归一化一次

- 默认值写进 schema。
- `this.configs.use(schema)` 保持为 module-top-level plugin class 的普通字段，不能使用 `#private`。
- runtime 在实例构造后、`init()` 前注入归一化值，因此只在 `init()` 或之后读取。
- 不要再写 `this.config.timeout ?? 5000`；这会掩盖 schema 缺陷和无效输入。

## 生命周期要诚实且可回收

- 外部服务不可达、schema 不匹配或必要配置无效时，让 `init()` 失败并给出行动建议。
- 资源创建成功后立即登记 cleanup；不要等到函数末尾才统一登记。
- `init()` 最终 cleanup/disposable 会自动进入 generation effects；停止、rollback、replacement 和 optional restart 只 drain effects。
- cleanup 必须幂等，并能处理部分初始化。
- timer、watcher、queue consumer 的单次错误属于业务错误，应捕获、结构化记录并按业务语义重试。
- 插件不得调用 `process.exit()`；插件报告事实，宿主决定退出、告警或降级。
- 第三方库若只有无法 unregister 的进程全局 callback/registry，全局 callback 保持稳定且无 active invocation 时拒绝
  工作；caller 状态仍放在 Context-owned registry。并发异步调用用 async context 传递 scope，不写 module-level
  `currentCaller`。第三方 API 能直接接收配置对象时，传 caller-owned snapshot，不把对象塞进不可回收的全局名称表。

## 保持业务面独立

| 能力                                     | 放置位置                                |
| ---------------------------------------- | --------------------------------------- |
| 业务 HTTP、webhook、外部 health endpoint | `ctx.http.plugin`                       |
| Workbench UI、RPC、stream、live query    | `ctx.workbench.mount(module, bindings)` |
| 独立 plugin 的关系型状态                 | `ctx.database.use(definition)`          |
| static application 的统一关系型状态      | application-private database module     |
| 进程退出、部署和健康策略                 | host                                    |

测试至少覆盖一次 `workbench: false`，证明业务 HTTP 和核心生命周期不依赖Workbench。

## API 与日志

- 固定事件集合使用具名 `EvtChannel`，不要退化为宽泛的 `Map<string, unknown>`。
- 外部平台 capability 让原生具名方法留在顶层；raw、诊断和组合工具统一放在 `$`。
- 从 `ctx.logger` 派生 logger，不直接导入 LogTape `getLogger()`。
- 调试日志使用 `ctx.logger.getDebugChannel('cache:lookup')`；topic 不带 `pluxel:` 前缀，也不包含 wildcard。
- 插件级日志等级由 active runtime policy 动态控制；插件不要读取 env 或自行缓存等级。
- 错误对象通过 `{ error }` 或 `{ err }` 结构化传递，不插值、不 stringify、不只记录 `.message`。
- UI RPC/events/live-query contract 放在 browser-safe 共享边界，并为 `@pluxel/runtime/web` 提供 type augmentation。

## 提交前检查

1. 确认 `package.json` 入口与 `dist` 一致，runtime 是 peer，插件依赖有明确版本来源；生成的
   `pluxel.pluginPackages` 不由作者手写。
2. 确认 `tsdown.config.ts` 只描述 package 输入/输出，没有再次安装 `pluginPackage()`、decorator transform
   或复制 Pluxel compiler plugin。
3. 运行 `pnpm lint:fix`，阅读并理解仍未修复的 Pluxel rule；不要用 disable 绕过所有权问题。
4. 运行 `pnpm verify`，覆盖 format、unused suppressions、typecheck、tests 和 production build。
5. 确认 required/optional、Plugin/内部对象、HTTP/Workbench 三组边界都清楚。
6. 确认启动失败不会留下 running 假象，每个资源都有幂等 cleanup。
7. 确认 disabled Workbench Plane 测试仍通过，公开 contract 类型能被消费者发现。
8. 独立数据库 plugin 是否提交/检查 `drizzle/` 或显式声明 reset；application database 是否只有一个 module owner、pool 和 migration 入口？
9. 测试是否通过 `@pluxel/test/vitest` 和匹配边界的 core/runtime host 运行，而不是 mock Context 或
   raw TypeScript runner？
