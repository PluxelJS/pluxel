# 测试 Pluxel 插件

插件测试的标准组合是 Vitest、`@pluxel/test/vitest` preset，以及与被测边界匹配的 Pluxel
test host。preset 不是可有可无的 convenience：它安装 Pluxel lint guard、config metadata
transform、reflection setup 和确定的 package resolution conditions，使测试与真实插件工具链使用
同一种作者模型。

## 安装与配置

插件 package 的完整依赖分组见 [`plugin-package.md`](plugin-package.md)。测试部分至少需要这些 dev
dependencies：

```sh
pnpm add -D @pluxel/test @pluxel/core vitest oxlint
```

`@pluxel/runtime` 通常已经是插件的 dependency 或 peer dependency；runtime integration test 从它的
`@pluxel/runtime/test` subpath 导入。`@pluxel/test` 是 dev-only，不进入生产 dependencies。

每个插件 package 放一个 `vitest.config.ts`：

```ts
import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig(
	{},
	{
		include: ['src/**/*.ts', 'src/**/*.tsx', 'tests/**/*.ts', 'tests/**/*.tsx'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts'],
		passWithNoTests: false,
	},
)
```

- `include`/`exclude` 决定 Pluxel metadata transform 的源码范围，不是 Vitest test glob。
- preset 会在 transform 前运行 Pluxel build-correctness lint，因此需要安装 `oxlint`。
- 不要用 raw TypeScript runner 替代这条路径；constructor DI 和 config/feature metadata 依赖
  Pluxel toolchain。
- 需要其他 Vite plugin 时使用 `definePluxelVitestConfig(overrides, { prePlugins })` 明确它位于
  Pluxel plugin 之前还是之后，不要复制 preset 内部配置。

## 按被测边界选择 host

| 要验证的行为                                                    | 入口                                                             | 说明                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| 纯函数、领域模型、schema helper                                 | 直接 Vitest                                                      | 不启动 Pluxel，速度最快                                       |
| DI、required dependency graph、feature、effects、core lifecycle | `@pluxel/test` 的 `withHost()`                                   | core-only，不提供 HTTP、persistence、Vault 等 runtime service |
| config 注入、HTTP、persistence、Vault、Workbench Plane          | `@pluxel/runtime/test` 的 `withRuntimeHost()`                    | 默认 memory backend，callback 结束后自动 dispose              |
| 应用的 static catalog 和完整 fetch boundary                     | `@pluxel/runtime-static/test` 的 `createStaticRuntimeTestHost()` | 用于 host/application integration，不是普通插件单测默认选择   |
| dynamic loader、HMR、UI compiler、真实 Vite route               | 对应 runtime package 的集成测试                                  | 需要验证工具链或 route 时才上升到这一层                       |

选择能覆盖行为的最小 host。不要用 core-only host 测 HTTP，也不要为一个纯生命周期断言启动完整
static application。

## 标准 runtime 插件测试

```ts
import { withRuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'

import { OrdersPlugin } from '../src/index.ts'

describe('OrdersPlugin', () => {
	it('starts with normalized config and serves business HTTP without workbench', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add(OrdersPlugin)
				host.cfg(OrdersPlugin).set({ pageSize: 25 })
				host.cfg(OrdersPlugin).enable()
				await host.commit()

				expect(host.isRunning(OrdersPlugin)).toBe(true)
				expect(host.require(OrdersPlugin).pageSize).toBe(25)

				const response = await host.ctx.http.fetch(
					new Request('http://local.test/__pluxel/plugins/OrdersPlugin/api/orders'),
				)
				expect(response.status).toBe(200)
			},
			{ workbench: false },
		)
	})
})
```

`host.add()` 只修改 draft；`await host.commit()` 才应用 graph。`host.require()` 适合在成功启动后取得
类型化实例，未运行时会给出明确错误。`withRuntimeHost()` 在成功、断言失败和 callback 抛错时都会
dispose host，因此优先于手动维护 `afterEach` cleanup。

runtime host 默认使用 memory persistence、config service 和 runtime state，并默认启用私有
Workbench Plane。测试业务独立性时必须显式传 `{ workbench: false }`；只有验证Workbench contract、
layout 或 resource binding 时才启用它。

## 只测 core lifecycle

```ts
import { BasePlugin, Plugin, withHost } from '@pluxel/test'
import { describe, expect, it } from 'vitest'

@Plugin({ name: 'ProviderPlugin' })
class ProviderPlugin extends BasePlugin {}

@Plugin({ name: 'ConsumerPlugin' })
class ConsumerPlugin extends BasePlugin {
	constructor(readonly provider: ProviderPlugin) {
		super()
	}
}

it('starts providers before consumers', async () => {
	await withHost(async (host) => {
		host.add([ProviderPlugin, ConsumerPlugin])
		await host.commit()

		expect(host.isRunning(ProviderPlugin)).toBe(true)
		expect(host.require(ConsumerPlugin).provider).toBe(host.require(ProviderPlugin))
	})
})
```

`withHost()` 不注册 runtime services。如果插件 `init()` 使用 `ctx.http`、persistence 或 Vault，改用
`withRuntimeHost()`，不要 mock 一个不完整的 Context。

## 断言启动失败和依赖阻塞

成功路径使用严格的 `host.commit()`：任何插件启动失败都会直接 reject。预期失败并需要检查完整
report 时，使用 `commitAllowFail()` 和结构化 assertion helper：

```ts
import { assertPluginLifecycleIssue, BasePlugin, Plugin, withHost } from '@pluxel/test'

@Plugin({ name: 'BrokenProvider' })
class BrokenProvider extends BasePlugin {
	override init() {
		throw new Error('database schema is outdated')
	}
}

@Plugin({ name: 'BlockedConsumer' })
class BlockedConsumer extends BasePlugin {
	constructor(readonly provider: BrokenProvider) {
		super()
	}
}

it('reports the provider failure and blocks its required consumer', async () => {
	await withHost(async (host) => {
		host.add([BrokenProvider, BlockedConsumer])
		const summary = await host.commitAllowFail()

		assertPluginLifecycleIssue(summary, BrokenProvider, {
			kind: 'start-failed',
			message: /schema is outdated/,
		})
		assertPluginLifecycleIssue(summary, BlockedConsumer, {
			kind: 'dependency-blocked',
			blockedBy: BrokenProvider,
		})
	})
})
```

不要只断言日志文本，也不要把 lifecycle report 展平成自定义字符串。结构化 helper 会保留 plugin、
phase、kind 和 `blockedBy` 语义。

## 必须覆盖的插件行为

每个插件至少覆盖与它实际使用的边界：

1. 成功启动：有效 config 被归一化，核心 capability 可用。
2. 诚实失败：必要外部条件不满足时 lifecycle 是 failed，而不是 running 加一条日志。
3. required dependency：provider failure 会阻塞 consumer；optional provider 缺失不阻塞核心能力。
4. cleanup：remove、replacement 或 host dispose 后 timer、listener、route 和连接不再工作；cleanup 可重复。
5. Workbench Plane disabled：业务 HTTP、领域状态和核心生命周期仍然工作，workbench callback 不执行。
6. Workbench Plane enabled：测试 module mount、target layout、opaque grant、cleanup 和 UI artifact。
7. request-level failure：单次无效请求或上游超时不会错误地停止整个插件。

不要为了行覆盖率直接调用 private lifecycle method。通过 host commit、HTTP fetch、公开 capability、
replacement 和 dispose 观察作者可见行为。

## 文件系统 fixture

测试 workspace discovery、代码生成或文件 adapter 时可以使用 `@pluxel/test/fixtures`：

```ts
import { createFixture } from '@pluxel/test/fixtures'
import { expect, it } from 'vitest'

it('discovers a plugin package', async () => {
	await using fixture = await createFixture({
		'plugins/orders/package.json': '{"name":"orders"}\n',
		'plugins/orders/src/index.ts': 'export class OrdersPlugin {}\n',
	})

	const result = await discoverPlugins(fixture.path, { fs: fixture.fs })
	expect(result).toHaveLength(1)
})
```

每个 fixture 拥有隔离的 filesystem；优先用 `await using` 自动释放，并把 `fixture.fs`/`fixture.fsp`
显式传给被测代码。普通插件业务测试不需要 VFS fixture。

## Monorepo 与 CI

每个插件保留自己的 `vitest.config.ts` 最容易理解。需要根级自动发现时：

```ts
import { definePluxelVitestWorkspaceConfig } from '@pluxel/test/vitest'

export default definePluxelVitestWorkspaceConfig({
	test: {
		fileParallelism: false,
		minWorkers: 1,
		maxWorkers: 1,
	},
})
```

preset 本地默认允许没有 test 的 workspace package，CI 默认不允许。关键插件 package 建议显式设置
`passWithNoTests: false`，避免测试文件被误删或 glob 漂移后仍然绿灯。

提交前运行 `pnpm test`，最终运行 `pnpm verify`，让测试与 format、Pluxel Oxlint、typecheck 和 production
build 一起通过。
