---
title: 插件自动化测试
description: 使用 @pluxel/test 搭建隔离的测试宿主，验证依赖注入、配置变更、生命周期与异常回滚。
---

Pluxel 提供了专门的测试工具库 `@pluxel/test`。通过 `createTestHost()`，你可以在 Vitest 中以纯内存的方式启动微型宿主，运行真实的依赖图、配置校验和生命周期调度，而无需启动整个真实的 Web 应用或持久化数据库。

日常修改在所属包运行相关文件，例如 `vp test run tests/plugin.test.ts`。普通领域逻辑可以直接测试，涉及注入、配置或生命周期时再创建测试宿主。其他验证入口见[局部验证](../development/workspace-toolchain.md#局部验证)。

## 安装与配置 Vitest

在插件项目中安装测试依赖：

```sh
vp add -D @pluxel/test @pluxel/core vitest@5.0.5 vite-plus
```

在插件根目录创建 `vitest.config.ts`：

```ts twoslash
export { default } from '@pluxel/test/vitest'
```

如果需要自定义测试匹配目录，可以使用 `definePluxelVitestConfig`：

```ts twoslash
import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	test: { include: ['tests/**/*.test.ts'], passWithNoTests: false },
	pluxel: { include: ['src/**/*.ts', 'tests/**/*.ts'] },
})
```

`@pluxel/test/vitest` 预设会在测试执行前对插件进行编译转换，确保装饰器、依赖图与配置 Schema 能被运行时正确识别。

## 编写第一个测试（基础用法）

使用 `createTestHost()` 创建测试宿主，并通过 `await using` 在用例结束时自动释放宿主：

```ts no-twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import { createTestHost } from '@pluxel/test'
import { expect, it } from 'vitest'

@Plugin()
class CounterPlugin extends BasePlugin {
	private count = 0
	increment() {
		return ++this.count
	}
}

it('能够启动插件并调用其方法', async () => {
	await using host = await createTestHost()

	// 启动插件并获取实例
	const counter = await host.start(CounterPlugin.nodeAddress())
	expect(counter.increment()).toBe(1)

	// 停止插件
	await host.stop(CounterPlugin.nodeAddress())
	expect(host.isRunning(CounterPlugin.nodeAddress())).toBe(false)
})
```

### `createTestHost` 常用选项

- `services`：挂载测试所需的服务列表（默认为 `[]`）。
- `coreConfig.http.fetch`：替换 `ctx.wretch` 和 `ctx.fetch` 共享的最终传输，保留宿主策略。 [出站请求测试](./outbound-http.md#在测试中替换传输)
- `workbench`：设为 `true` 时启用 Workbench 测试环境驱动。
- `policy` / `config`：传入自定义的初始策略或插件初始配置。
- `vaultBindings`：使用与 Host 相同的部署记录格式，向指定插件注入只读凭据；后端通过 `coreConfig.vault` 选择。

## 按需挂载测试服务

被测插件需要 HTTP 等可选基础设施时，在创建测试宿主时传入对应的单项服务工厂。FS、TinyBase 与 Vault 是内建能力，无需安装：

### 测试 HTTP 插件

```ts no-twoslash
import { createTestHost } from '@pluxel/test'
import { elysia } from '@pluxel/services/elysia'

await using host = await createTestHost({ services: [elysia()] })
await host.start(HealthPlugin.nodeAddress())

// 通过内置的 host.http.fetch 直接发起请求
const response = await host.http.fetch(new URL('/health', host.http.origin))
expect(await response.json()).toEqual({ ok: true })
```

### 测试单项服务与凭据

```ts no-twoslash
import { createTestHost } from '@pluxel/test'
import { elysia } from '@pluxel/services/elysia'
import { commands } from '@pluxel/services/commands'
import { CredentialsPlugin } from './credentials-plugin'

await using host = await createTestHost({
	services: [elysia(), commands()],
	coreConfig: { vault: { backend: 'bindings' } },
	vaultBindings: [
		{
			owner: CredentialsPlugin.nodeAddress(),
			key: 'primary',
			value: { token: 'test-token' },
			source: 'env',
		},
	],
})
```

插件通过 `ctx.vault` 访问自己的凭据空间。`bindings` 后端只读，没有绑定的记录返回 `exists: false`；需要验证加密持久化或解锁状态时，选择加密后端并通过相应管理操作建立测试前置状态，见 [Vault](./vault.md)。

## 测试宿主核心 API

节点操作统一使用源码 class 生成的原地址，例如 `const node = CounterPlugin.nodeAddress()`；fork 使用 `CounterPlugin.nodeAddress('east')`。可以缓存地址，`start()`、`require()` 和 `restart()` 从地址保留准确实例类型。

`catalog.add()`、`replaceDefinition()` 和全局 provider default 继续接收 constructor，用于声明可装配实现。测试节点地址携带原 constructor 的精确证据；JSON、显式 `parsePluginNodeAddress()` 得到的纯身份和生成控制入口地址不能提供测试装配实现。复制的地址、其他 Core 副本的证据和已被替换的实现都会明确失败。

| 操作                                             | 说明                                   |
| ------------------------------------------------ | -------------------------------------- |
| `await host.start(node, options?)`               | 启动目标插件并等待就绪，返回强类型实例 |
| `await host.start([first, second])`              | 一次性启动多个插件，返回实例元组       |
| `await host.stop(node)`                          | 停止指定插件并触发其资源清理回调       |
| `await host.restart(node)`                       | 重启插件并返回新实例                   |
| `host.isRunning(node)`                           | 检查插件当前是否处于运行状态           |
| `await host.config.patch(node, { set, remove })` | 在运行时修改插件配置并验证热更新       |

## 初始配置与运行时配置更新

### 传入初始配置（首次启动）

在启动插件时，可通过 `initialConfig` 传入初始配置数据：

```ts no-twoslash
const worker = await host.start(WorkerPlugin.nodeAddress(), {
	initialConfig: {
		endpoint: 'https://api.example.test',
		concurrency: 2,
	},
})
```

### 运行时配置修改（热更新测试）

当插件已经处于运行状态时，使用 `host.config.patch` 模拟外部配置保存与热应用：

```ts no-twoslash
const result = await host.config.patch(WorkerPlugin.nodeAddress(), {
	set: {
		endpoint: 'https://api.example.test',
		concurrency: 8,
	},
})

// 若插件注册了 configs.onUpdate，application 状态为 'applied'
expect(result).toMatchObject({ ok: true, application: 'applied' })
```

## 断言生命周期异常（commitExpectFail）

为了验证上游异常或依赖缺失时插件能够按预期阻塞，可以使用 `host.commitExpectFail()`：

```ts no-twoslash
import { parsePluginNodeAddress } from '@pluxel/core'

const failure = await host.commitExpectFail((change) => {
	// 启动一个依赖了故障提供方的消费插件
	change.start(ConsumerPlugin.nodeAddress(), { catalog: [BrokenProviderPlugin] })
})

// 断言故障提供方报错
expect(failure.lifecycleReport.issues).toContainEqual(
	expect.objectContaining({
		plugin: parsePluginNodeAddress(BrokenProviderPlugin.nodeAddress()),
		kind: 'start-failed',
	}),
)

// 断言下游消费插件被正常阻塞
expect(failure.lifecycleReport.issues).toContainEqual(
	expect.objectContaining({
		plugin: parsePluginNodeAddress(ConsumerPlugin.nodeAddress()),
		kind: 'dependency-blocked',
		blockedBy: parsePluginNodeAddress(BrokenProviderPlugin.nodeAddress()),
	}),
)
```

<span id="抽象-provider-与-consumer-override"></span>

## 抽象 Provider 与 Consumer 依赖替换

在单元测试中，经常需要用 Mock 插件替换真实的上游服务：

```ts no-twoslash
await host.commit((change) => {
	change.catalog.add([MockStoragePlugin, ConsumerPlugin])

	// 将 Storage 抽象依赖定向到 MockStoragePlugin
	change.dependencies.setDefault({
		requirement: StorageToken,
		provider: MockStoragePlugin,
	})

	change.start(ConsumerPlugin.nodeAddress())
})
```

测试分叉节点时，同样通过源码 class 的 `nodeAddress(forkId)` 选择：

```ts no-twoslash
const East = RegionPlugin.nodeAddress('east')
const West = RegionPlugin.nodeAddress('west')

await host.commit((change) => {
	change.start(East, { initialConfig: { region: 'east' } })
	change.start(West, { initialConfig: { region: 'west' } })
})
```

## PluginPart、optional integration 与 cleanup

验证带有局部部件和资源清理的插件时，建议重点覆盖：

1. **清理是否彻底**：插件调用 `host.stop()` 后，其内部通过 `ctx.effects.defer()` 注册的回调是否被调用，后台连接是否真正关闭；
2. **局部异常回滚**：如果挂载的某个 `PluginPart` 在 `init()` 中抛出错误，验证主插件是否能够整洁回滚，已创建的资源是否被完整清理；
3. **可选依赖启闭**：验证可选依赖从“不存在”到“被动态启动”时，消费方插件能否正确建立与断开集成。

## 文件夹具

`@pluxel/test/fixtures` 的 `createFixture()` 创建内存文件树；需要真实磁盘路径、子进程或原生文件监听时使用 `createDiskFixture()`。两者都支持 `await using`，作用域结束后删除夹具目录。

```ts
import { createFixture } from '@pluxel/test/fixtures'
import { expect } from 'vitest'

await using fixture = await createFixture({ 'input.txt': 'hello' })
const path = fixture.getPath('input.txt')
await fixture.fsp.writeFile(path, 'updated')
expect(await fixture.fsp.readFile(path, 'utf8')).toBe('updated')
```

Promise 文件操作使用 `fixture.fsp`（或 `fixture.fs.promises`）。`fixture.fs` 的异步方法遵循 Node callback 形式，必须传入回调；同步方法保留 `Sync` 后缀。内存夹具自行拥有文件系统与临时目录，不接受 `fs` 或 `tempDir` 选项；磁盘夹具允许 `tempDir`，使用原生文件系统并拒绝 `fs` 覆盖。非法选项在 JavaScript 调用中也会抛错。
