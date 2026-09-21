---
title: 测试 Pluxel 插件
description: 选择最小测试边界，用真实构建语义验证依赖、配置、HTTP、Workbench 与资源回收。
---

本页帮助你验证插件能否启动、处理请求并在停止后释放资源。CLI 模板已配置 Vitest preset；在生成的插件目录运行 `pnpm test` 即可。手动接入已有项目时，安装 preset，并显式选择测试需要的服务。

插件测试需要真实的装饰器、依赖和配置转换。直接 `new` 实例或模拟 Context 只能验证普通对象行为，不能验证宿主加载和生命周期。

如果目标是操作眼前正在运行的 dev 实例，coding agent 必须使用 [开发控制台](./dev-console.md)。本页的 test host 用于独立的回归测试，不连接当前 dev，也不共享它的数据目录。

## 目标：一个宿主，按需安装能力

插件作者只做两个选择：是否需要运行插件，以及这个测试需要哪些服务。需要运行插件时统一使用 `createTestHost()`；不再选择 Core host、Service host 或 Workbench host。

- 纯函数和普通对象直接测试；纯 RPC 使用 Cap’n Web 的 `RpcStub`。
- 插件的依赖、配置、生命周期、HTTP、commands 与 Workbench 都使用同一个测试宿主模型。
- 真实应用启动、物理网络、构建产物与浏览器仍使用对应真实环境；统一 host 不冒充这些环境。
- 内部始终复用生产 Host 的运行图、配置与生命周期，不按选项切换两套具有不同语义的 Core/Services 执行器。

## 唯一作者入口与默认值

从 `@pluxel/test` 导入 `createTestHost()`、`definePluginFork()` 和测试断言错误类型。业务声明继续从 `@pluxel/core` 导入 `BasePlugin`、`Plugin`，服务工厂继续从原领域入口导入。`@pluxel/test/vitest` 只负责测试编译，`@pluxel/test/fixtures` 只负责文件等资源，不转发业务服务。

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

it('runs a plugin without optional services', async () => {
	await using host = await createTestHost()
	const counter = await host.start(CounterPlugin)
	expect(counter.increment()).toBe(1)
	await host.stop(CounterPlugin)
	expect(host.isRunning(CounterPlugin)).toBe(false)
})
```

配置面：

```ts no-twoslash
// 简化的配置轮廓；精确类型以 TestHostOptions 为准。
type TestHostOptions = Readonly<{
	services?: readonly HostService[]
	workbench?: boolean
	management?: boolean
	config?: CoreHostConfig
	state?: HostStateStoreOptions
	configRecords?: HostConfigStoreOptions
}>
```

| 选项                      | 语义                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `services`                | 默认 `[]`；完整服务列表，不隐式合并、不自动安装 standardServices                                                            |
| `workbench`               | 默认 `false`；`true` 安装 Workbench 测试后端、Management 与打开 entry 的 driver                                             |
| `management`              | 省略时随 `workbench` 启用，否则为 `false`；可单独设为 `true` 测管理面；与 `workbench: true` 同时显式设为 `false` 时拒绝配置 |
| `config`                  | 复用 Core 配置，省略时采用测试 root 的默认配置；不是服务或插件 catalog 的容器                                               |
| `state` / `configRecords` | 复用 Host 存储选项，省略时每个测试宿主独立使用内存，不写应用目录                                                            |

Host 自己的图策略、配置记录与 Plugin 可消费的 Persistence 服务是不同职责。内存 Host 存储不等于默认安装 `ctx.persistence`；插件需要 Persistence 时仍显式选择服务。

`createTestHost()` 统一返回 Promise，所有调用都写 `await using host = await createTestHost(...)`。不提供另一种同步工厂，也不提供 `mode: 'core' | 'service'`。

## 官方源码工具链与运行时服务

`@pluxel/test/vitest` 默认安装 Plugin 语义、依赖、配置、lint guard 与 Database 源码声明转换。测试仍显式选择运行时服务；配置编译插件不等于安装 Context capability。

选择 `nodeModules()` 后，测试组合层为没有显式制品来源的服务接入正式 Node 源码编译器；搭配 `workers()` 可以从 TypeScript task entry 按需编译并执行真实 worker。编译资源由本次 host 拥有并回收，空服务或 HTTP-only 测试不创建该编译器。显式配置 Node 制品来源时仍消费该来源，不用源码编译掩盖损坏或缺失的产物。

Workbench 测试后端使用测试制品，验证发布、RPC 和资源生命周期；不验证 MF/UI 制品构建、React 渲染或物理 WebSocket。Node 发布打包、native dependency 布局和开发 HMR 同样需要对应真实环境的验证。

## 最终配置形态：包显式选择，工具链集中复用

每个插件包可以保留一份很薄的 `vitest.config.ts`，明确选择测试 preset；无需重复列出官方转换插件。不自动查找、继承或合并仓库根配置，也不导入会启动开发应用的 Vite 配置。

```ts no-twoslash
// plugins/example/vitest.config.ts
import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	root: import.meta.dirname,
	test: { include: ['tests/**/*.test.ts'] },
})
```

有项目自定义转换时，将可复用的插件工厂放在项目共享文件中，由开发和测试配置显式调用。以下文件与函数名属于项目示例，不是新增的框架 API：

```ts no-twoslash
// plugins/example/vitest.config.ts
import { definePluxelVitestConfig } from '@pluxel/test/vitest'
import { projectSourcePlugins } from '../../tooling/source-plugins'

export default definePluxelVitestConfig({
	root: import.meta.dirname,
	plugins: projectSourcePlugins(),
	test: { include: ['tests/**/*.test.ts'] },
})
```

共享文件只创建所需插件，不启动 host、监听端口或读取当前开发实例。每份配置调用工厂取得自己的插件实例，避免跨项目共享有状态实例。需要先于官方转换执行的插件放入 `pluxel.prePlugins`；普通 `plugins` 接在 preset 的官方插件之后，实际执行仍遵循 Vite 的 `enforce` 和 hook 规则。官方插件由 preset 安装一次，共享列表不重复添加。

确实需要共享整份配置时，作者显式导入并用 Vitest 的 `mergeConfig()` 合并，再将结果传给一次 `definePluxelVitestConfig()`；数组按合并规则组合，不能假设会自动去重插件。根配置可以通过 `test.projects` 发现各包的配置文件，负责统一执行；包的工具链仍由自身配置明确表达。独立插件项目在自己的根目录采用同一写法，不要求存在上级仓库。

Vitest 默认可以读取 `vite.config.*`，但存在独立 `vitest.config.*` 时优先使用后者，不会自动合并两者。这里选择显式测试配置，是为了让测试接入可见且能独立运行，不是 Vitest 强制每包配置。外部服务的 Vite 转换按上述方式正常组合；纯 Rolldown 构建插件需接入对应构建流程。Vitest 的 `plugins` 只作用于其模块图，不会自动进入 Node/Worker 的独立制品构建。外部转换必须按对应构建入口配置，不能把 Vite 插件列表视为所有构建流程的通用配置。

## 用生产服务工厂组合测试能力

只测试 HTTP 的插件：

```ts no-twoslash
import { createTestHost } from '@pluxel/test'
import { http } from '@pluxel/services/http'

await using host = await createTestHost({ services: [http()] })
await host.start(HealthPlugin)
const response = await host.http.fetch(new URL('/health', host.http.origin))
expect(await response.json()).toEqual({ ok: true })
```

需要常用基础服务与 Vault 时，显式表达这个组合：

```ts no-twoslash
import { standardServices } from '@pluxel/services'
import { vault } from '@pluxel/services/vault'

await using host = await createTestHost({
	services: [...standardServices({ persistence: { mode: 'memory' } }), vault()],
})
```

自定义服务直接放入同一 `services` 数组，不为每个服务增加 `database: true`、`vault: { ... }` 等平行配置字段。服务仍通过生产声明表达依赖；缺少依赖时在创建 host 阶段失败，不等到测试调用时才悄悄补装。

Workbench 的最小组合：

```ts no-twoslash
import { http } from '@pluxel/services/http'
import { persistence } from '@pluxel/services/persistence'

await using host = await createTestHost({
	services: [http(), persistence({ mode: 'memory' })],
	workbench: true,
})
await host.start(OrdersPlugin)
using opened = await host.workbench.open({
	target: OrdersPlugin,
	entry: OrdersWorkbench.overview,
	principal: { provider: 'test', subject: 'administrator' },
})
using snapshot = await opened.api.snapshotDto()
expect(snapshot.openOrders).toBe(0)
```

`workbench` 和 `management` 是测试交互平面的组合选项：它们选择测试 artifact、身份交接与资源跟踪，而不是业务服务快捷开关。HTTP 与 Persistence 仍是显式前置，不因启用选项而偷偷装入。生产应用继续使用生产 Workbench/Management 装配，不把测试后端传给生产 Host。

## 一套生命周期词汇

| 作者操作                                          | 唯一语义                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `await host.start(Target, options?)`              | 确保目标实现可用，建立本次运行意图，提交并等待稳定；返回当前实例                                           |
| `await host.start([A, B])`                        | 一次提交启动多个目标，返回有类型的实例 tuple                                                               |
| `await host.stop(Target)`                         | 撤销目标的运行意图，按生产依赖规则收敛运行图；保留 catalog 和配置，不承诺停止仍被其他消费者需要的 provider |
| `await host.restart(Target)`                      | 执行生产 restart 并返回新实例；依赖传播遵循生产规则                                                        |
| `host.require(Target)` / `host.isRunning(Target)` | 读取当前运行事实，不启动、不注册                                                                           |
| `await host.replaceDefinition(Current, Next)`     | 显式替换同一 definition 的实现，沿生产 replacement 路径收敛                                                |
| `await host.config.patch(Target, patch)`          | 应用运行期配置变更，返回权威结果；不伪装成首次配置，也不隐式 restart                                       |

不保留顶层 `host.add()` / `host.remove()` 作为生命周期同义词。只有 catalog 的可用性操作叫 `add/remove`，并放入事务的 `change.catalog` 中。

单目标的便利操作内部调用同一 commit 路径，resolve 后即可断言，不再手动提交一次。`start` 的 `initialConfig` 仅在 node 第一次进入生命周期前接受；`catalog: [Provider]` 仅提供依赖解析候选，真实 dependency 仍由 constructor 声明。

## 普通操作一步完成，复杂变化显式提交

```ts no-twoslash
const consumer = await host.start(ConsumerPlugin, {
	catalog: [ProviderPlugin],
	initialConfig: { endpoint: 'https://example.test' },
})

await host.commit((change) => {
	change.catalog.add([AlternateProvider, AnotherConsumer])
	change.dependencies.setDefault({
		requirement: Transport,
		provider: AlternateProvider,
	})
	change.start(AnotherConsumer)
})
```

`change.start/stop/restart/replaceDefinition` 与顶层操作使用同样的领域语义，只是暂存在本次事务里。`change.catalog.add/remove` 只修改实现可用性；删除后如何停止实例、处理阻塞依赖，由生产 Host 判定。Fork 使用 `definePluginFork()` 和 `change.forks.ensure/remove`，不把 fork 身份压成字符串或新增另一种测试宿主。

`commit` callback 只同步声明变化，不 `await`、不嵌套提交、不读中途状态。一个提交代表一个 graph boundary，不承诺把已发生的外部副作用回滚成数据库事务。需要观察先后状态时写两次 awaited 操作。

成功路径默认严格检查目标结果；失败测试使用现有 `commitExpectFail()` 返回的结构化 lifecycle report。它只接受预期的生命周期失败，不吞掉输入错误、配置错误或测试自身异常。不增加第三种“宽松启动”方法。

## Driver 是测试访问方式，不是第二套服务

使用 `host.http`、`host.commands`、`host.config`，避免另建通用 `getDriver(token)` registry。HTTP 和 commands driver 只调用已安装的生产服务；方法入口可以稳定存在，但没有选择对应服务时，调用必须给出明确的未安装错误。`config` 属于 Host 本身，不要求额外安装 Plugin Persistence 服务。

`host.workbench` 只在 `workbench: true` 时存在：literal `true` 提供确定的类型，省略或 `false` 不暴露该属性；动态 boolean 对应需要收窄的可选属性。不要从任意 `HostService[]` 静态推断所有第三方服务的 driver 类型，也不要给运行时未安装的能力制造空实现。

| Driver/边界                 | 能验证什么                                                   | 不能替代什么                                 |
| --------------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| `host.http.fetch()`         | 真实路由、输入处理、owner admission 和响应                   | 物理 listener、TLS、Upgrade、网络断开        |
| `host.commands`             | 命令注册、验证、调用和撤回                                   | 业务客户端或外部消息 carrier                 |
| `host.workbench.open()`     | 发布、principal/params、Content/View/Attachment RPC 与 lease | 真实登录链路、WebSocket、MF 构建、React 渲染 |
| `new RpcStub(new Target())` | 原生本地 RPC contract 与引用语义                             | Workbench publication 或网络 transport       |

自定义服务通常通过被测 Plugin 的业务入口验证，不为了可测试性公开内部 registry。`start/require` 返回的 Plugin 实例也不替代跨插件 caller facade；验证调用者身份与撤回时建立真实 Consumer，并从注入依赖发起调用。

## 清理和失败保持一个 owner

Host、fixture 使用 `await using`；打开的 RPC entry、手动取得的 RPC 结果与子 capability 使用对应的 `using`。借用引用不释放，框架已接管的结果不重复释放。测试声明资源时按依赖顺序取得，退出时逆序释放。

Host 关闭时沿现有生产顺序拒收新操作、等待已接纳调用并清理测试资源与服务。测试 driver 负责跟踪其创建的 body、subscription 和 lease；泄漏仍应报告，其他清理仍应执行。故意验证关闭、失败或资源泄漏的测试允许显式 dispose，不为追求统一语法改变测试含义。

## 包边界与安装依赖

`@pluxel/test` 是上层作者组合包，显式依赖官方 Services 与所需测试驱动。正常安装测试工具时包管理器会安装这些依赖；直接 import `@pluxel/services/*` 的插件包仍须声明自己的直接依赖，不能依赖传递安装。

安装包、加载模块和初始化服务是不同层次。`services: []` 不初始化可选官方服务；fixture/preset 子入口不主动启动服务运行时。生产 Host/Core 不反向依赖测试组合包，第三方服务仍遵循生产 `HostService` 契约。Core 白盒测试继续使用内部 harness，普通插件作者只使用统一根入口。

仓库 TypeScript 测试默认用 `using` 管理 `Disposable`，用 `await using` 管理异步释放的 host、fixture 和文件句柄；取得资源后立即声明，初始化或断言失败时也会清理。需要检查释放后的状态时，用显式 `{ ... }` 块限定资源寿命，再在块外断言。依赖资源的异步操作应在退出作用域前完成，返回 Promise 时按需使用 `return await`。

`using` 不替代所有 `finally`：恢复 fake timers、环境变量、锁和运行状态，或者处理所有权转移、特殊清理顺序时，继续使用明确的 `try/finally`。资源只有 `close()` 而不实现释放协议时，也不必为替换语法临时包装。业务执行与释放同时失败时，`using` 使用标准 `SuppressedError` 保存两者；需要不同错误优先级的代码保留显式处理。借用的 RPC root 不进入 `using`，已交给框架消费的 DTO 结果也不重复释放。

## 安装 Vitest preset

```sh package-install
npx nypm add -D @pluxel/test @pluxel/core vitest@5.0.0 oxlint
```

当前 preset 使用 Vitest `5.0.0`，项目使用 Node.js 24+。直接使用服务工厂时声明 `@pluxel/services`；选择 HTTP 时满足 Elysia peer，直接使用 Workbench 声明时安装 `@pluxel/workbench` 及相应 peers。

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

`@pluxel/test` 根入口提供 host；`/vitest`、`/fixtures` 和 `/unsafe` 分别提供编译配置、文件资源和受限 toolchain 测试工具。

使用本地 source overlay 时，Vitest 需要先从已构建的 `@pluxel/test/vitest` 读取 config bootstrap，因为 config 本身早于
Vite conditions 求值。普通测试脚本应先运行：

```sh
pluxel source build --package @pluxel/test
```

这只构建 preset 的 artifact 及其自身 build graph 前置；config 加载后，测试模块仍通过 `@pluxel/source` / `@pluxel/hmr` 读取当前源码。
不要改用相对 `src` import 或给整个 Vitest 进程加 condition。需要验证 production launcher/artifact 的测试才额外构建它自己的 owner。

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

Core 内部 harness 的 desired config mutation 属于白盒图测试；普通插件测试使用这里的生产 Host 配置路径。

## 断言 lifecycle failure

成功路径的 lifecycle command 是 strict：请求的 postcondition 未满足时抛出 `PluginLifecycleAssertionError`，并保留 slot-free
`summary.lifecycleReport`。预期 start、blocked 或 drain failure 时使用 `commitExpectFail()`：

```ts no-twoslash
import { pluginNodeAddressOf } from '@pluxel/core'

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

## 抽象 provider 与 consumer override

抽象 Plugin 是 dependency requirement；通过 concrete provider 实现它，再从 consumer 验证真实注入。不要对抽象 token 调用 `require()`。下面的 token 应从 fixture 或被测 package 导入，`ConnectorPlugin` 必须声明实现 `Connector`：

```ts no-twoslash
await host.commit((change) => {
	change.catalog.add([ConnectorPlugin, ConsumerPlugin])
	change.dependencies.setDefault({
		requirement: Connector,
		provider: ConnectorPlugin,
	})
	change.start(ConsumerPlugin)
})

expect(host.require(ConsumerPlugin).connector.ctx.pluginInfo.nodeAddress).toEqual(
	host.require(ConnectorPlugin).ctx.pluginInfo.nodeAddress,
)
```

全局 default 只能选 concrete Plugin，不能选 fork。为特定 consumer 选择 fork 时，使用 `definePluginFork()` 得到 target，再调用
`change.dependencies.setOverride({ consumer: ConsumerPlugin, requirement: Connector, provider: East })`。
`clearDefault(Connector)` 和 `clearOverride({ consumer: ConsumerPlugin, requirement: Connector })` 分别清除选择。
requirement 按 definition identity 识别；依赖修改经过 graph，重启受影响 consumer 及其 dependent closure，操作后重新 `require()` 取得实例。

服务 host 的 `change.forks.ensure(East)` 可以先建立 fork，再显式 `change.start(East)`；`change.forks.remove(East)` 移除 fork。
fixture/catalog/replacement 与 strict assertion 是测试专属。操作在线应用时使用[开发控制台](./dev-console.md)：`dev.plugins` 和 `dev.config` 操作当前 Host，其他能力由脚本显式导入其服务 API。控制台不继承测试 host 的事务或 fixture 接口。

## Fork 与 replacement

Fork 是独立于 host 的 typed value。concrete Plugin 必须用 `@Plugin({ forkable: true })` 声明可并行运行多个 node：

```ts no-twoslash
import { definePluginFork } from '@pluxel/test'

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
import { createTestHost } from '@pluxel/test'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { InngestPlugin } from '@acme/inngest'

class TestInngestPlugin extends InngestPlugin {
	protected override async init() {}
}

lowerTestReplacement(InngestPlugin, TestInngestPlugin)

await using host = await createTestHost()
await host.start(InngestPlugin)
await host.replaceDefinition(InngestPlugin, TestInngestPlugin)
```

替身若改变 constructor dependency，必须通过 unsafe helper 的 `requires` 明确写出本次 evaluation edge。生产 replacement facts 始终来自
Vite/Rolldown semantic lowering。

## 使用服务 drivers

`createTestHost()` 默认不安装可选服务。需要 HTTP、commands 或 Workbench 时显式组合服务。

public author host 不暴露 root `ctx`、raw service、transaction 或 backend admin。通过返回的 Plugin instance 观察公开业务状态；通过 driver
观察 Plugin 发布的 inbound surface：

- `host.http.origin/fetch`：in-process Fetch，不验证 WebSocket carrier；
- `host.commands.execute/list`：真实 command catalog、validation、owner registration 和 withdrawal；
- Workbench test host 的 `host.workbench.open`：真实 publication、session、layout 与 local Cap'n Web membrane；
- `host.config.patch`：production-like config mutation。

`workbench: true` 安装测试用 Workbench 制品查询及 Management，不创建浏览器 Shell 或监听端口。每次 open 显式提供 principal：

```ts no-twoslash
import { createTestHost } from '@pluxel/test'
import { standardServices } from '@pluxel/services'
import { vault } from '@pluxel/services/vault'

await using host = await createTestHost({
	workbench: true,
	services: [...standardServices({ persistence: { mode: 'memory' } }), vault()],
})

await host.start(ConnectorPlugin)

using opened = await host.workbench.open({
	target: ConnectorPlugin,
	entry: ConnectorWorkbench.credentials,
	principal: ADMIN,
})

const result = await opened.root.runDto('replace', { authKey: 'test-secret' })
expect(result.action).toMatchObject({ ok: true })
```

`open()` 不模拟 renderer 或点击。React 控件、router 和 Shell state 在 browser test 中验证；WebSocket handshake、Origin、framing 与 disconnect
在 real-carrier test 中验证。基础服务 host 不提供 Workbench driver。

### Pure `RpcTarget` object contract

不经过 host 的 target object 可以通过本地 Cap'n Web membrane 验证参数/返回值复制和 capability 语义：

```ts no-twoslash
import { assertWorkbenchDto } from '@pluxel/workbench/server'
import { RpcStub, RpcTarget } from 'capnweb'

interface CounterApi extends RpcTarget {
	readDto(): { count: number }
}

class CounterTarget extends RpcTarget implements CounterApi {
	readDto(): { count: number } {
		const dto = { count: 1 }
		assertWorkbenchDto(dto)
		return dto
	}
}

using api = new RpcStub<CounterApi>(new CounterTarget())
using result = await api.readDto()
expect(result).toEqual({ count: 1 })
```

`RpcStub` 使用 Cap’n Web 的原生引用所有权；测试创建 fresh target，由 stub 生命周期负责释放，不再额外手动释放同一 target。它不验证 Elysia mount、HTTP Upgrade、WebSocket、Origin
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

## 应用与开发集成验证

Plugin 行为使用统一 test host，并选择最小服务集合。完整应用的声明、启动策略、动态发现、HMR、Workbench 与浏览器图，
通过项目唯一的 Vite 配置验证，不建立第二个测试启动器。已经运行的应用使用[开发控制台](./dev-console.md)检查。

生产目录的文件、assets、listener 和 signal ownership 通过真实 `pluxel()` 构建产物的 smoke 验证，不能以
in-process Plugin test host 代替。`@pluxel/create` 的 packed smoke 同时验证外部安装、生成 workspace、生产 HTTP/Workbench 和 Vite 应用。

## CI 顺序

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`test` 证明 runtime behavior，`build` 证明 package root、metadata 和 artifacts 可以真正发布；两者不能互相替代。
