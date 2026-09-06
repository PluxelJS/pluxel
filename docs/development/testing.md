---
title: 测试 Pluxel 插件
description: 选择最小测试边界，用真实构建语义验证依赖、配置、HTTP、Workbench 与资源回收。
---

Plugin 测试应经过与生产构建一致的语义处理，包括装饰器转换、构造器依赖提取、配置 schema 提取和包根入口解析。直接 `new`
实例或模拟 Context 只适合测试普通业务对象，不能证明 Plugin 能被宿主正确加载、组合和停止。

## 安装 Vitest preset

```sh package-install
npx nypm add -D @pluxel/test @pluxel/core vitest@5.0.0 oxlint
```

Testing v2 固定使用 Vitest `5.0.0`；它要求 Node.js `>=22.12.0` 和 Vite `>=6.4.0`。Pluxel workspace
当前要求 Node.js `>=24`，新项目也应保持至少这个版本，不要以 `clearMocks: false` 或旧 runner entry 恢复 Vitest 4 行为。

最小 `vitest.config.ts`：

```ts twoslash
export { default } from '@pluxel/test/vitest'
```

需要自定义 include 或增加 Vite plugin 时：

```ts twoslash
import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	// Vitest owns test discovery and runner policy.
	test: { include: ['tests/**/*.test.ts'], passWithNoTests: false },
	// Pluxel owns source lowering/config extraction and consumes this field before Vite sees it.
	pluxel: { include: ['src/**/*.ts', 'tests/**/*.ts'] },
})
```

preset 在 TypeScript 擦除前运行 Pluxel semantic lowering 和 build-correctness lint。把 `vitest.config.ts` 纳入项目的
`tsconfig.include`，让 TypeScript 检查同一份 Vite/Vitest config；它不会注册 test setup 或自定义 matcher。不要关闭 lowering 来“简化”测试。

`test.include` 是 Vitest 的测试发现范围；`pluxel.include` / `exclude` 是 Pluxel source toolchain 的变换范围，例如被测试
间接导入的 fixture Plugin 也可能需要后者覆盖。两者不要混用。要在 semantic lowering 前增加 Vite transform，使用
`pluxel.prePlugins`；其余 Vite plugin 保持在顶层 `plugins`。

`@pluxel/test` 没有根入口。它只从明确 subpath 提供 runner、fixture 和 unsafe lowering 工具；test host 从所验证层的 package 导入。

使用本地 source overlay 时，Vitest 需要先从已构建的 `@pluxel/test/vitest` 读取 config bootstrap，因为 config 本身早于
Vite conditions 求值。普通测试脚本应先运行：

```sh
pluxel source build --package @pluxel/test
```

这只构建 preset 的 artifact 及其自身 build graph 前置；config 加载后，测试模块仍通过 `@pluxel/source` / `@pluxel/hmr` 读取当前源码。
不要改用相对 `src` import 或给整个 Vitest 进程加 condition。需要验证 production launcher/artifact 的测试才额外构建它自己的 owner。

## 先选择最小边界

| 需要验证                                                         | 唯一默认入口                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| 纯函数、普通对象                                                 | 不使用 host                                                           |
| Core graph、config、lifecycle、effects                           | `@pluxel/core/test`                                                   |
| Plugin 与 Runtime capability                                     | `@pluxel/runtime/test`                                                |
| fixed static application 的 configure、prepare、bindings、冷启动 | `@pluxel/runtime-static/test`                                         |
| dynamic source、Vite/HMR、HTTP 或 WebSocket carrier              | 项目 Vite command 或 `@pluxel/runtime-dynamic` 的 production launcher |
| static deployment artifact、filesystem、assets、TLS              | 启动真实 artifact                                                     |
| Workbench renderer 与 Shell                                      | React/browser test                                                    |

删除外层 application、source 或 carrier 后仍成立的断言，应回到更小的 host。同一 Plugin behavior 不要在 Runtime、static 和 dynamic
三层重复测试。

所有 public host 都由创建它的测试拥有：

```ts no-twoslash
await using host = createRuntimeTestHost()
```

host 的 `dispose()` 与异步释放协议是同一个幂等操作。环境不支持 explicit resource management 时，在 `finally` 中调用
`await host.dispose()`。

## Core：立即修改 graph

Core 没有 Runtime session intent 或 durable auto-start policy。`add/remove/restart/replaceDefinition` 都会立即提交并等待 lifecycle
稳定；方法 resolve 后可以直接断言，不再额外调用无参数 `commit()`。

```ts no-twoslash
import { BasePlugin, createCoreTestHost, Plugin } from '@pluxel/core/test'
import { expect, it, vi } from 'vitest'

const cleanup = vi.fn()

@Plugin()
class ProviderPlugin extends BasePlugin {
	protected override init() {
		return cleanup
	}
}

@Plugin()
class ConsumerPlugin extends BasePlugin {
	constructor(readonly provider: ProviderPlugin) {
		super()
	}
}

it('starts providers first and drains the graph', async () => {
	await using host = createCoreTestHost()

	const [provider, consumer] = await host.add([ProviderPlugin, ConsumerPlugin])
	expect(provider).toBe(host.require(ProviderPlugin))
	expect(consumer.provider).toBe(provider)

	await host.commit((change) => {
		change.remove(ConsumerPlugin)
		change.remove(ProviderPlugin)
	})

	expect(cleanup).toHaveBeenCalledOnce()
})
```

单个目标使用顶层 command；只有多个变化必须共享一个 graph boundary 时才用 callback：

```ts no-twoslash
await host.commit((change) => {
	change.add(ProviderPlugin)
	change.add(ConsumerPlugin, {
		initialConfig: { endpoint: 'https://api.example.test' },
	})
})
```

callback 只同步描述变化。不要把它声明为 `async`、在其中 `await`、返回值、嵌套 commit，或把 `change` 保存到外部。互相矛盾的 command
会在 production work 开始前失败；需要观察两个先后状态时，写两个明确 awaited operation。

## Runtime：立即表达本次进程意图

Runtime test host 的 `start/stop/restart/replaceDefinition` 同样立即提交。`start()` 会让目标 implementation 进入 test catalog、建立本次
进程的 running intent、启动 required provider closure，并返回当前实例；它不会修改下次冷启动的 auto-start policy。

```ts no-twoslash
import { BasePlugin, createRuntimeTestHost, Plugin } from '@pluxel/runtime/test'
import { expect, it } from 'vitest'

@Plugin()
class HealthPlugin extends BasePlugin {
	protected override init() {
		this.ctx.elysia.get('/health', () => ({ ok: true }))
	}
}

it('publishes and withdraws its route', async () => {
	await using host = createRuntimeTestHost()
	await host.start(HealthPlugin)

	const url = new URL('/health', host.http.origin)
	const response = await host.http.fetch(url)
	expect(await response.json()).toEqual({ ok: true })

	await host.stop(HealthPlugin)
	expect((await host.http.fetch(url)).status).toBe(404)
})
```

`host.http.fetch()` 经过真实 route directory、generation admission 和已 seal 的 Elysia app，但不打开物理端口。`host.http.origin`
是逻辑 origin，不是可连接 listener。WebSocket Upgrade、disconnect、close code 和 backpressure 必须走真实 carrier。

有 required provider 时，只把 implementation candidate 加入 `catalog`；依赖 edge 仍只来自 consumer constructor：

```ts no-twoslash
const consumer = await host.start(ConsumerPlugin, {
	catalog: [ProviderPlugin],
})
```

多个独立 root 可以一次启动，并保持 tuple 推导：

```ts no-twoslash
const [api, worker] = await host.start([ApiPlugin, WorkerPlugin])
```

不同目标需要不同首次配置时，使用一个同步 callback：

```ts no-twoslash
await host.commit((change) => {
	change.start(ApiPlugin, { initialConfig: { port: 8080 } })
	change.start(WorkerPlugin, { initialConfig: { concurrency: 4 } })
})
```

## 区分首次配置和运行期更新

`initialConfig` 只建立 node 第一次进入 lifecycle 前的 fixture state：

```ts no-twoslash
const worker = await host.start(WorkerPlugin, {
	initialConfig: {
		endpoint: 'https://api.example.test',
		concurrency: 2,
	},
})
```

node 已经拥有 committed config 或进入过 lifecycle 后，使用 production-like mutation：

```ts no-twoslash
const result = await host.config.patch(WorkerPlugin, {
	endpoint: 'https://api.example.test',
	concurrency: 8,
})

expect(result).toMatchObject({ ok: true, application: 'applied' })
```

`config.patch()` 经过真实 validation、persistence、desired revision 和 listener notification。它不会隐式 restart；只能通过完整重建安全应用
配置的 Plugin，应在 patch 后显式调用 `await host.restart(WorkerPlugin)`。不要直接给实例 private field 赋值，也不要用 bootstrap helper
绕过运行期配置语义。

Core 没有 Runtime persistence/config driver；需要在一个 Core graph boundary 中改变 desired config 时使用 callback
`change.config.patch()`。Runtime 的 live `host.config.patch()` 才代表完整宿主配置 mutation。

## 断言 lifecycle failure

成功路径的 lifecycle command 是 strict：请求的 postcondition 未满足时抛出 `PluginLifecycleAssertionError`，并保留 slot-free
`summary.lifecycleReport`。预期 start、blocked 或 drain failure 时使用 `commitExpectFail()`：

```ts no-twoslash
import { pluginNodeAddressOf } from '@pluxel/core/test'

const failure = await host.commitExpectFail((change) => {
	change.start(ConsumerPlugin, { catalog: [BrokenProviderPlugin] })
})

expect(failure.lifecycleReport.issues).toContainEqual(
	expect.objectContaining({
		plugin: pluginNodeAddressOf(BrokenProviderPlugin),
		kind: 'start-failed',
	}),
)
expect(failure.lifecycleReport.issues).toContainEqual(
	expect.objectContaining({
		plugin: pluginNodeAddressOf(ConsumerPlugin),
		kind: 'dependency-blocked',
		blockedBy: pluginNodeAddressOf(BrokenProviderPlugin),
	}),
)
```

`commitExpectFail()` 只有观察到 lifecycle issue 才成功返回；完全成功会作为 assertion error 拒绝。programming error、invalid graph、配置
输入错误、persistence failure 或 capability disabled 仍直接抛出。测试分支依赖 stable `plugin/phase/kind/blockedBy`，不要依赖完整
message；Vitest 5 的 `expect.objectContaining()` 和 `expect.stringContaining()` 足以表达这些 structured assertions。

## Fork 与 replacement

Fork 是独立于 host 的 typed value。concrete Plugin 必须用 `@Plugin({ forkable: true })` 声明可并行运行多个 node：

```ts no-twoslash
import { definePluginFork } from '@pluxel/runtime/test'

const East = definePluginFork(ConnectorPlugin, 'east')
const West = definePluginFork(ConnectorPlugin, 'west')

await host.commit((change) => {
	change.start(East, { initialConfig: { region: 'east' } })
	change.start(West, { initialConfig: { region: 'west' } })
})
```

`definePluginFork()` 不读 host、不修改 catalog，也不启动 Plugin。definition replacement 后，旧 constructor 和旧 fork ref 都会 stale；
用新 implementation 和同一 fork ID 重建 ref。

测试 replacement 时，替身必须像真实模块求值一样拥有目标 canonical definition facts：

```ts no-twoslash
import { createRuntimeTestHost } from '@pluxel/runtime/test'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { InngestPlugin } from '@acme/inngest'

class TestInngestPlugin extends InngestPlugin {
	protected override async init() {}
}

lowerTestReplacement(InngestPlugin, TestInngestPlugin)

await using host = createRuntimeTestHost()
await host.start(InngestPlugin)
await host.replaceDefinition(InngestPlugin, TestInngestPlugin)
```

替身若改变 constructor dependency，必须通过 unsafe helper 的 `requires` 明确写出本次 evaluation edge。生产 replacement facts 始终来自
Vite/Rolldown semantic lowering。

## 使用 Runtime drivers

public author host 不暴露 root `ctx`、raw service、transaction 或 backend admin。通过返回的 Plugin instance 观察公开业务状态；通过 driver
观察 Plugin 发布的 inbound surface：

- `host.http.origin/fetch`：in-process Fetch，不验证 WebSocket carrier；
- `host.commands.execute/list`：真实 command catalog、validation、owner registration 和 withdrawal；
- `host.workbench.open`：真实 publication、session、layout 与 local Cap'n Web membrane；
- `host.config.patch`：production-like config mutation。

Workbench 默认关闭；只在测试发布行为时显式开启，并为每次 open 提供 principal：

```ts no-twoslash
await using host = createRuntimeTestHost({
	vault: {},
	workbench: { enabled: true },
})

await host.start(ConnectorPlugin)

using opened = await host.workbench.open({
	target: ConnectorPlugin,
	entry: ConnectorWorkbench.credentials,
	principal: ADMIN,
})

const result = await opened.root.run('replace', { authKey: 'test-secret' })
expect(result.action).toMatchObject({ ok: true })
```

`open()` 不模拟 renderer 或点击。React 控件、router 和 Shell state 在 browser test 中验证；WebSocket handshake、Origin、framing 与 disconnect
在 real-carrier test 中验证。Workbench disabled 时 driver 会明确拒绝，不会偷偷安装 capability。

### Pure `RpcTarget` object contract

不经过 host 的 target object 可以通过本地 Cap'n Web membrane 验证参数/返回值复制和 capability 语义：

```ts no-twoslash
import { createLocalRpcClient } from '@pluxel/runtime/test'
import { RpcTarget } from '@pluxel/runtime/capnweb'

interface CounterApi extends RpcTarget {
	read(): { count: number }
}

class CounterTarget extends RpcTarget implements CounterApi {
	read() {
		return { count: 1 }
	}
}

using api = createLocalRpcClient<CounterApi>(new CounterTarget())
expect(await api.read()).toEqual({ count: 1 })
```

`createLocalRpcClient()` 借用 target：释放返回的 stub 不会释放 target 或它的领域服务。它不验证 Elysia mount、HTTP Upgrade、WebSocket、Origin
或 disconnect；mounted HTTP endpoint 使用 `host.http.fetch()`，WebSocket carrier 使用真实 listener。
直接调用 target instance 只能证明本地 class 行为，不能证明 RPC contract；需要作为 Workbench View、CLI 或其他
Cap’n Web session 入口的 target，至少用上述 local membrane 覆盖其 portable 参数/返回值、callback 和 child capability 所有权。
同一 target class 被多个入口使用时可以复用这组 object-contract 测试；各入口的认证、admission、取消和 transport lifecycle
则在该入口自己的 integration test 中验证。

Vault、database、persistence 和 worker 不自动变成 root test backdoor。需要白盒验证 Plugin-owned 数据时，从当前 running instance 取得
owner-bound handle；restart/replacement 后重新取得新 instance 和 handle。大量业务 seed 由具体 Plugin package 提供领域 fixture。

## PluginPart、optional integration 与 cleanup

`PluginPart` 的 Context、immediate host 和 composition DSL 是 protected。通过 Part/owner 声明的最小 public 查询验证业务状态，通过真实
capability catalog 验证 registration 与回收；只有 framework internal test 才读取 occurrence authority。

Optional integration 至少覆盖：

1. provider absent：consumer running，callback 不执行；
2. provider running：consumer closure restart，callback 执行；
3. provider removed/replaced：旧 callback cleanup 完成，不持有旧 provider。

不要直接调用 `plugins.use()` callback；让 graph commit 驱动它。

每类长期资源都应有可观察 cleanup 断言：timer 已 clear、watcher/worker 已 settle、HTTP/command/Workbench publication 已撤销、旧 owner
handle 已拒绝使用。等待 lifecycle command 或 host disposal 的 Promise，不能只检查是否调用过 `abort()`。

## Filesystem fixture

纯文件操作使用 VFS fixture：

```ts twoslash
import { createFixture } from '@pluxel/test/fixtures'

await using fixture = await createFixture({
	'packages/a/src/index.ts': 'export const value = 1\n',
})

expect(fixture.fs.existsSync(fixture.getPath('packages/a/src/index.ts'))).toBe(true)
```

只有真实 watcher、child process 或工具链需要 native filesystem 时才使用 disk fixture，并由 fixture disposal 清理临时目录。

## Static application 与 dynamic smoke

完整 fixed static application 使用 ready-on-return 的 test host：

```ts no-twoslash
import { startStaticApplicationTestHost } from '@pluxel/runtime-static/test'
import application from '../src/pluxel.static.ts'

await using host = await startStaticApplicationTestHost(application)
expect(host.isRunning(OrdersPlugin)).toBe(true)

const response = await host.http.fetch(new URL('/orders', host.http.origin))
```

这个 host 验证 `defineStaticRuntime()` 的 configure、prepare、bindings、fixed catalog 和 cold boot。它没有 Plugin lifecycle mutation、root
`ctx`、HMR 或 physical listener；`startupReport` 保存 static partial startup 事实。

Dynamic source/HMR 或物理 carrier 使用 production 入口，不建立第二个 test launcher：

```ts no-twoslash
import { startDynamicDevRuntime } from '@pluxel/runtime-dynamic'

await using runtime = await startDynamicDevRuntime({
	entry: new URL('../fixtures/pluxel.dynamic.ts', import.meta.url),
})

const response = await fetch(new URL('/health', runtime.origin))
```

factory resolve 时 Vite、initial reconciliation、HMR、carrier 与 listener 都已 ready。`signal` 只取消尚未完成的 startup；resolve 后 lifetime
只由 returned resource 拥有。项目已有完整 Vite config、assets 或 browser graph 时，直接运行项目的 Vite command。

Static deployment 的 filesystem、assets、TLS 和 signal ownership 必须由真实 freezer artifact smoke 验证，不能由 in-process application host
代替。

## CI 顺序

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`test` 证明 runtime behavior，`build` 证明 package root、metadata 和 artifacts 可以真正发布；两者不能互相替代。
