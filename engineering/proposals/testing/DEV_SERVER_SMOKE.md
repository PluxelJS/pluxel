# Dynamic Runtime smoke boundary

> 状态：候选设计，尚未采纳或实现。本文收敛 coding agent 的真实 dev smoke 路径，不建立第二套 test-owned launcher。当前行为以
> [`../../../packages/runtime-dynamic/README.md`](../../../packages/runtime-dynamic/README.md) 为准。

## 修正后的决策

不新增 `@pluxel/runtime-dynamic/test.startDevServer()`。

dynamic Runtime 本来就由 Vite 承载。再由 test package 创建一台“测试 dev server”，会形成另一个语义入口：production/dev 使用
`dynamicRuntimeVitePlugin()` 或 `createDynamicDevRuntime()`，测试却通过新的 wrapper 决定 config resolution、readiness、端口与 teardown。
两者即使初版共用实现，长期也容易出现行为漂移。

coding agent 应根据目标直接使用 production 入口：

```text
验证真实项目的 Vite config / middleware / assets
  -> 运行项目已有 dev command
  -> fetch / WebSocket / browser 访问 Vite 输出的 origin

需要在 Vitest 或脚本内拥有 server lifetime
  -> 使用 @pluxel/runtime-dynamic 的 canonical programmatic launcher
  -> fetch / WebSocket / browser 访问 launcher.origin

只验证 Plugin behavior，不验证物理 carrier
  -> createRuntimeTestHost()
  -> host.http.fetch() / other in-process drivers
```

因此 test API 不拥有 dev server。它只应说明何时越过 in-process 边界，以及如何用标准客户端观察 production launcher。

## 收敛现有 programmatic launcher

当前 `createDynamicDevRuntime()` 需要：

```ts
const runtime = await createDynamicDevRuntime({ config: 'src/pluxel.dynamic.ts' })
await runtime.start()
try {
	// smoke
} finally {
	await runtime.stop()
}
```

这个 API 已经是现有的 production direct launcher，但 create/start/stop ceremony 不适合一次启动即 ready 的资源，也没有提供物理请求所需
的 origin。与其在 `/test` 再包一层，候选 breaking refactor 应直接改善这个唯一 launcher：

```ts
import { startDynamicDevRuntime } from '@pluxel/runtime-dynamic'

await using runtime = await startDynamicDevRuntime({
	config: new URL('../fixtures/pluxel.dynamic.ts', import.meta.url),
})

const response = await fetch(new URL('/health', runtime.origin))
expect(response.status).toBe(200)
```

候选最小 contract：

```ts
export interface DynamicDevRuntime extends AsyncDisposable {
	/** Available after the factory resolves. */
	readonly ctx: Context
	/** Actual loopback HTTP origin selected by Vite. */
	readonly origin: URL
	/** Idempotently releases all resources owned by this direct launcher. */
	dispose(): Promise<void>
}

export function startDynamicDevRuntime(
	options: Readonly<{
		config: string | URL
	}>,
): Promise<DynamicDevRuntime>
```

这不是新增一个 head，而是用 ready resource contract 取代现有 unstarted handle：

- 删除 `createDynamicDevRuntime()`、`.start()` 与 `.stop()`，不留 alias；
- `startDynamicDevRuntime()` resolve 时 config、Vite graph、initial reconciliation、HMR、carrier 与 listener 已 ready；
- startup 失败在 reject 前回收部分资源；
- `dispose()` 与 `[Symbol.asyncDispose]()` 是同一个幂等 operation；
- `origin` 从 Vite 实际 socket address 得到，不复制端口配置；
- direct launcher 固定 loopback 与 OS-assigned ephemeral port；部署监听选项继续属于 Vite/application host；
- `ctx` 是现有 production host authority，不由 test package 复制；smoke assertion 应优先经过 `origin`。

`config` 的 string 继续遵循 production dynamic launcher 的明确 path base；test 和跨 cwd 脚本推荐 file `URL`。实现前必须让 direct launcher、
Vite plugin 与 config diagnostics 对 URL/path normalization 使用同一底层函数，不能让两种宿主解释出不同 module。

## 唯一的 Vite 运行语义

canonical programmatic launcher 必须薄薄地拥有 production `dynamicRuntimeVitePlugin()` 建立的 Vite server，不能复制 boot、config loading、
HTTP middleware 或 HMR controller。项目自己的 `vite.config.ts` 仍直接安装同一个 plugin：

```ts
export default defineConfig({
	plugins: [
		dynamicRuntimeVitePlugin({
			config: './src/pluxel.dynamic.ts',
		}),
	],
})
```

两种方式的区别只是 server ownership：

| 使用方式                   | 谁组合 Vite config                     | 谁拥有 lifetime              | 适合验证                         |
| -------------------------- | -------------------------------------- | ---------------------------- | -------------------------------- |
| 项目 `vite`/dev command    | application                            | Vite CLI / application host  | 完整项目 config、assets、浏览器  |
| `startDynamicDevRuntime()` | Pluxel canonical direct-launch profile | returned production resource | 程序化 HTTP/WebSocket/HMR smoke  |
| `createRuntimeTestHost()`  | 不启动 Vite                            | returned test host           | 快速 Plugin behavior/integration |

这三者不是三个相互竞争的 Runtime 实现。前两者必须经过同一个 dynamic Vite plugin；第三者明确不声称验证 Vite 或 physical carrier。

## Ready 不等于所有 Plugin running

`startDynamicDevRuntime()` 的名称表示启动 dynamic Runtime server，不表示启动 catalog 中每个 Plugin。`plugins`/`sources` 只提供 catalog
availability；factory 不隐式制造 session intent 或 durable auto-start policy。

physical smoke 需要目标 Plugin running 时，应通过已启用的真实 Management/Workbench RPC 发出与产品相同的控制请求，或使用 fixture 已
显式准备的 runtime state，然后通过 `expect.poll()` 等待公开 endpoint。programmatic launcher 不增加 `runtime.start(Plugin)`、
`runtime.commit()` 或 `runtime.require(Plugin)` 这些绕过 control plane 的 test authority。

## RPC 与断言

launcher 只提供标准 origin，不提供另一套 `runtime.http.fetch()`、`runtime.rpc()`、Vitest matcher 或 codec：

- HTTP/mounted RPC 使用 `fetch(new URL(path, runtime.origin))`；
- WebSocket 使用 endpoint 自己的 production client，并从 `runtime.origin` 构造 `ws:` URL；
- Workbench/browser smoke 把 Playwright `baseURL` 指向 `runtime.origin`；
- HMR smoke 修改 test-owned source，通过公开响应等待新 generation；
- planning epoch、raw controller 和 lifecycle summary 仍属于 framework internal harness。

这使同一个 production server 可以被 Vitest、独立 Node script、Playwright 或 coding agent 的 shell smoke 使用，而无需每个 consumer 学习
Pluxel-specific test driver。

## Timeout、teardown 与状态安全

launcher 不内置 test timeout。compiler、migration、Plugin startup 与 drain 的期限由调用环境或 production cancellation contract 决定；
Vitest 可设置 test/hook timeout，eventual assertion 使用 `expect.poll()`/`vi.waitFor()`。隐藏的 5 秒或 30 秒 deadline 会让合法长任务变成
随机基础设施失败。

resource 同时拥有 listener/application carrier、Vite HMR/watch/compiler、Runtime controller、Plugin effects 和 launcher child leases。
`dispose()` resolve 后不得遗留端口、watcher、effect 或后台 task；重复调用幂等，多项 teardown failure 使用 `AggregateError` 保留。

programmatic launcher 与项目 dev command 都读取调用方的真实 config，不能为了测试偷偷覆盖 persistence、Vault、Database、config service 或
runtime state。自动化 smoke 应使用明确的 fixture config，并显式选择 memory backend 或 test-owned 临时目录/数据库。coding agent 在未知
仓库中不应把 production config 当作 disposable fixture。

不增加含糊的 `isolated: true`。完整 isolation 必须同时覆盖路径派生和每个 durable capability；在真实 fixture 证明统一 overlay contract 前，
布尔值只能制造虚假的安全保证。

## 验收条件

重构 canonical launcher 前至少证明：

1. direct launcher 与项目 Vite plugin path 共享 config normalization、boot 和 carrier implementation；
2. factory resolve 后可立即从 `origin` 请求 Runtime-owned route；
3. 通过真实 control RPC 启动 Plugin 后，可访问其 HTTP/WebSocket endpoint；
4. source edit 后可从公开结果观察 HMR replacement 与旧 connection drain；
5. invalid config、boot 或 listen failure 不遗留端口、watcher 和 Runtime effects；
6. `dispose()` 后 origin 拒绝连接且重复 dispose 成功；
7. memory fixture 与 temp-directory durable fixture 均无跨 test 状态泄漏；
8. 项目 dev command 和 programmatic launcher 的共同 conformance 不依赖 test-only implementation。

如果 application-host smoke 只需运行现有 `vite` command，就不应强迫它改用 programmatic launcher；后者只解决进程内需要明确 lifetime 与
origin 的用例。
