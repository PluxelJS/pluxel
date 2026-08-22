---
title: 测试 Pluxel 插件
description: 用真实构建流程和对应的测试宿主验证依赖、配置、HTTP 与资源回收。
---

Plugin 测试应当经过与生产构建一致的语义处理，包括装饰器转换、构造器依赖提取、配置 schema 提取和包根入口解析。直接 `new` 一个实例或模拟 Context 只能验证普通业务逻辑，不能证明这个 Plugin 可以被宿主正确加载和停止。

## 选择测试宿主

### 安装与 Vitest preset

```sh package-install
npx nypm add -D @pluxel/test @pluxel/core vitest oxlint
```

最小 `vitest.config.ts`：

```ts twoslash
export { default } from '@pluxel/test/vitest'
```

需要自定义 include 或额外 Vite plugin 时：

```ts twoslash
import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	test: {
		include: ['tests/**/*.test.ts'],
	},
})
```

preset 在 TypeScript 擦除前运行 Pluxel semantic lowering，并执行 build-correctness lint。不要关闭这一步来“简化”测试。

### 选择测试边界

| 需要验证                                                   | 入口                              |
| ---------------------------------------------------------- | --------------------------------- |
| dependency graph、failure、replacement、effects            | `@pluxel/test` 的 core host       |
| runtime config、HTTP、database、vault、commands、Workbench | `@pluxel/runtime/test`            |
| static canonical entry 与 fixed catalog                    | `@pluxel/runtime-static/test`     |
| dynamic source discovery、Vite loader 与 HMR               | dynamic route test host/真实 Vite |
| package metadata、Workbench/worker/database artifact       | `pluxel build` integration        |

`@pluxel/test` 是 public dev-only core test surface，不会注册 runtime services。需要 `ctx.http` 或 `ctx.database` 时使用 runtime test entry。
普通 Core/Runtime test host 只提供 `add`、`remove`、`restart`、`replace`、`fork`、`override`、`commit` 与只读查询，不暴露
`PluginService`、graph 或 transaction internals；Core 自身的白盒测试显式从 `@pluxel/core/internal` 取得内部 authority。

## 常用测试

### Core lifecycle

```ts twoslash
import { BasePlugin, Plugin, withHost } from '@pluxel/test'
import { describe, expect, it, vi } from 'vitest'

const cleanup = vi.fn()

@Plugin()
class ProviderPlugin extends BasePlugin {
	override init() {
		return cleanup
	}
}

@Plugin()
class ConsumerPlugin extends BasePlugin {
	constructor(readonly provider: ProviderPlugin) {
		super()
	}
}

it('starts dependency order and drains effects', async () => {
	await withHost(async (host) => {
		host.add([ProviderPlugin, ConsumerPlugin])
		host.cfg(ProviderPlugin).enable()
		host.cfg(ConsumerPlugin).enable()

		await host.commit()
		expect(host.isRunning(ConsumerPlugin)).toBe(true)

		host.remove(ProviderPlugin)
		await host.commit()
		expect(cleanup).toHaveBeenCalledOnce()
	})
})
```

`host.add/remove` 只修改 catalog availability，`cfg(...).enable()/disable()` 修改 desired state；`add()` 不会隐式启用
Plugin，`remove()` 也不会暗中清除其 desired state。`await host.commit()` 才统一应用新的 graph plan。`commit()` 是 strict：
有 start failure 时抛出；预期失败并需要 summary 时使用 `commitAllowFail()`。

测试 HMR/replacement 时，replacement 必须像真实模块求值一样拥有目标 canonical definition facts，test host 不会把任意
subclass 偷偷改址。专门测试替身可以从 unsafe test entry 显式 lower：

```ts no-twoslash
import { InngestPlugin } from '@acme/inngest'
import { withRuntimeHost } from '@pluxel/runtime/test'
import { lowerTestReplacement } from '@pluxel/test/unsafe'

class TestInngestPlugin extends InngestPlugin {
	override async init() {}
}

lowerTestReplacement(InngestPlugin, TestInngestPlugin)

await withRuntimeHost(async (host) => {
	host.add(InngestPlugin)
	host.replace(InngestPlugin, TestInngestPlugin)
	host.cfg(InngestPlugin).enable()
	await host.commit()
})
```

替身若改变 constructor dependency，必须通过 `requires` 明确写出本次 evaluation 的 edge；不要复制旧 candidate metadata，
也不要给 RuntimeHost 增加 constructor/address fallback。这个 helper 只属于 `@pluxel/test/unsafe`，生产 replacement facts 始终来自
Vite/Rolldown semantic lowering。

### Runtime capability

```ts twoslash
import { BasePlugin, Plugin, withRuntimeHost } from '@pluxel/runtime/test'
import { expect, it } from 'vitest'

@Plugin()
class HealthPlugin extends BasePlugin {
	override init() {
		this.ctx.http.plugin.routes((app) => app.get('/health', () => ({ ok: true })))
	}
}

it('mounts and removes owner HTTP routes', async () => {
	await withRuntimeHost(
		async (host) => {
			host.add(HealthPlugin)
			host.cfg(HealthPlugin).enable()
			await host.commit()

			const plugin = host.require(HealthPlugin)
			const url = `http://local${plugin.ctx.http.plugin.base('/health')}`
			const response = await host.ctx.http.fetch(new Request(url))
			expect(await response.json()).toEqual({ ok: true })

			host.remove(HealthPlugin)
			await host.commit()
			expect((await host.ctx.http.fetch(new Request(url))).status).toBe(404)
		},
		{ workbench: false },
	)
})
```

`withRuntimeHost()` 在 callback 结束后自动 `dispose()`；需要手动控制 host lifetime 时使用 `createRuntimeHost()`。

### Config

```ts no-twoslash
host.add(WorkerPlugin)
host.cfg(WorkerPlugin).set({ concurrency: 8 })
host.cfg(WorkerPlugin).enable()
await host.commit()

expect(host.require(WorkerPlugin).observedConcurrency).toBe(8)
```

config handle 接受 Plugin constructor/address，不接受 display name。覆盖：

- 空 record 应用 schema defaults；
- 显式合法值产生 normalized output；
- 非法值让 Plugin start failed；
- replacement 后读取新 snapshot，旧 generation 被清理。

不要直接给实例 private field 赋值，那会绕过 runtime validation 和作者 contract。

## Failure 与 cleanup

### 断言失败与 blocked dependency

```ts no-twoslash
import { assertPluginLifecycleIssue } from '@pluxel/runtime/test'

const summary = await host.commitAllowFail()

assertPluginLifecycleIssue(summary, ProviderPlugin, {
	kind: 'start-failed',
})
assertPluginLifecycleIssue(summary, ConsumerPlugin, {
	kind: 'dependency-blocked',
})
```

测试不应只断言 rejected message。结构化 summary 可以区分 start failure、dependency blocked、cleanup/drain failure 和未启动原因。

同时放入一个无关 Plugin，确认 provider failure 没有错误地阻止整个 graph。

### Optional integration

至少覆盖三个状态：

1. provider absent：consumer running，callback 未执行；
2. provider added/running：consumer closure restart，callback 执行；
3. provider removed/replaced：旧 callback cleanup 完成，不持有旧 provider。

不要在一个 test 中手动直接调用 `plugins.use()` callback；让 graph commit 驱动它。

### Cleanup 与 rollback

为每类长期资源建立可观察断言：

- timer 被 clear；
- watcher/queue/worker 的 `dispose()` 已 settle；
- HTTP route、command、Workbench mount 不再可见；
- database/cache/Redis 等旧 owner handle 拒绝继续使用；
- `init()` 中途失败时，之前 acquire 的资源仍被释放。

cleanup test 要等待 host commit/dispose Promise，不能只检查是否调用过 `abort()`。

## 扩展边界

### Workbench enabled 与 disabled

业务 Plugin 至少在 `workbench: false` 下跑一次。它证明 HTTP、database、commands 和核心 lifecycle 没有暗中依赖 UI backend。

需要验证 Contract/Extension/Binding 时再启用默认 runtime Workbench，并测试：

- mount 只在 Plugin running 后可见；
- RPC/events/live query binding 随 owner generation 撤销；
- browser-safe contract 没有 server import；
- replacement 不保留旧 grant。

### Forks

Core host 支持按 fork address 配置多个实例；示例中的 concrete `ConnectorPlugin` 必须用
`@Plugin({ forkable: true })` 显式声明它能够安全地同时运行多个 node：

```ts no-twoslash
const East = host.fork(ConnectorPlugin, 'east')
const West = host.fork(ConnectorPlugin, 'west')

host.cfg(East).set({ region: 'east' })
host.cfg(East).enable()
host.cfg(West).set({ region: 'west' })
host.cfg(West).enable()
await host.commit()
```

测试 config、logs、persistence/cache caller ownership 不会在 fork 之间串线。

### 文件系统 fixture

纯文件操作使用 VFS fixture：

```ts twoslash
import { createFixture } from '@pluxel/test/fixtures'

await using fixture = await createFixture({
	'packages/a/src/index.ts': 'export const value = 1\n',
})

expect(fixture.fs.existsSync(fixture.getPath('packages/a/src/index.ts'))).toBe(true)
```

只有真实 watcher、child process 或工具链需要 native filesystem 时才用 disk fixture，并依赖 fixture disposal 清理临时目录。

### Static 与 dynamic integration

Static canonical entry：

```ts twoslash
import { createStaticRuntimeTestHost } from '@pluxel/runtime-static/test'
```

Dynamic HMR 集成测试通过真实 `dynamicRuntimeVitePlugin()` 加载 source，不直接调用内部 loader method。覆盖 initial commit、add/change/unlink、failed replacement 保留旧 generation 和 source recovery。

## CI 顺序

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`test` 证明 runtime behavior，`build` 证明 package root、metadata 和 artifacts 能真正发布；两者不能互相替代。
