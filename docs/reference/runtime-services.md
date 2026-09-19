---
title: 组合 Host 服务
description: 使用官方默认组合运行应用，或按需选择 Host 服务并管理准备与清理。
---

官方应用和 starter 使用 `HostApplication` 配合 `servicesPreset()`：应用声明插件、数据位置和启动策略，官方入口负责开发附件和部署制品路径。需要自定义服务集合时，使用 `@pluxel/host` 逐项组合；它默认只提供 Core 能力。

## 官方默认组合

```ts
// src/app.ts
import type { HostApplication } from '@pluxel/host'
import { pluginNodeAddressOf } from '@pluxel/core'
import { servicesPreset } from '@pluxel/services'
import { MyPlugin } from './plugin.js'

export default {
	plugins: [MyPlugin],
	async configure(startup) {
		return {
			services: await servicesPreset(startup, {
				persistence: startup.env.PLUXEL_DATA_ROOT ?? './data',
			}),
			state: { initial: { autoStart: [pluginNodeAddressOf(MyPlugin)] } },
		}
	},
} satisfies HostApplication
```

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { vitePreset } from '@pluxel/services/vite'

export default defineConfig({
	plugins: [vitePreset({ entry: './src/app.ts', devConsole: true })],
})
```

```ts
// tsdown.config.ts
import { defineConfig } from 'tsdown'
import { buildPreset } from '@pluxel/services/build'

export default defineConfig({
	entry: './src/app.ts',
	plugins: [buildPreset()],
})
```

`servicesPreset()` 异步返回普通服务清单，按所选能力加载模块；资源仍由 Host 准备与关闭。它提供 HTTP、Commands、NodeModules、Workers、Persistence、Vault、Logging、Management，以及 `managementCommands()` 提供的基础插件命令，默认加入 Workbench，页面位于 `/__pluxel/workbench`。它不加入业务 Plugin 或 Database；额外服务可以追加到等待得到的数组。可传 `product` 设置产品信息，`logging` 替换日志方案，`workbench: false` 关闭工作台，Management 仍可用。数据库或不同管理面组合应使用下文的显式服务安装器。

`vitePreset()` 组合通用 Host 开发驱动与官方服务开发附件，只为应用实际安装的 HTTP、NodeModules、Workbench 接入支持；Workbench 制品模块按需加载。`servicesPreset()`、`vitePreset()`、`buildPreset()` 属于同一个 `@pluxel/services` 包，运行时、Vite 与构建分别使用独立入口。

开发控制台归 `@pluxel/host-dev`，基础 `host({ entry, devConsole: true })` 即可启用；官方 `vitePreset()` 接受同样的开关。它不要求安装服务。脚本显式 import 服务 API，通过借用的 `dev.ctx` 访问已安装能力；见[开发控制台](../development/dev-console.md)。Core 始终提供 `ctx.logger`，Logging 配置负责输出与存储，不是插件使用 logger 的前提。

生产 Node/Workbench 制品目录由 `servicesPreset()` 根据 `startup.deployment.root` 定位，搬移发行目录不需要改写应用中的制品路径。业务数据仍由应用选择，部署时使用发行目录外的绝对数据路径。

`persistence` 安装的是 Plugin 存储能力，不自动持久化 Host 的配置和启动策略；需要保存它们时配置下文的 `configRecords.storage` 和 `state.storage`。环境变量由应用的 `configure(startup)` 显式读取，例如按 `startup.env.PLUXEL_WORKBENCH !== 'false'` 设置 `workbench`。

官方构建默认携带 Workbench shell，并维护动态插件所需的官方共享入口。后台应用可以同时选择 `servicesPreset(..., { persistence, workbench: false })` 与 `buildPreset({ variant: 'headless' })`。构建 variant 决定交付资源，服务声明决定本次启动安装哪些能力。

## 自定义开发组合

服务与开发附件可分别选择。通用 `host()` 只负责应用加载与 HMR；HTTP、Node 制品和 Workbench 使用普通 Vite 插件显式接入：

```ts
import { defineConfig } from 'vite'
import { host } from '@pluxel/host-dev/vite'
import { serviceSingletons } from '@pluxel/services/vite'
import { httpDevelopment } from '@pluxel/services/http/vite'
import { nodeArtifacts } from '@pluxel/services/node/vite'
import { workbenchArtifacts } from '@pluxel/workbench/dev'

export default defineConfig({
	plugins: [
		serviceSingletons(),
		host({ entry: './src/app.ts' }),
		httpDevelopment(),
		nodeArtifacts(),
		workbenchArtifacts(),
	],
})
```

`serviceSingletons()` 为官方包保持原生 ESM 模块身份，避免 Vite 与服务附件取得不同的 token 或 constructor。完全自定义的包集合可使用 `hostSingletons({ packages: [...] })`（`@pluxel/host-dev/vite`）显式选择共享身份的包。只选择应用所需的附件与对应服务；附件不安装运行时服务。第三方附件通过同一个 Host 开发附件接口接入。`vitePreset()` 是官方集合的快捷组合，自定义应用也可以使用它配合自己的服务清单。

## 创建宿主

```ts
import { createHost } from '@pluxel/host'
import { persistence } from '@pluxel/services/persistence'
import { vault } from '@pluxel/services/vault'
import { MyPlugin } from './plugin.js'

const host = await createHost({
	plugins: [MyPlugin],
	services: [persistence('./data/persistence'), vault()],
})
try {
	await host.start()
} finally {
	await host.close()
}
```

`plugins` 是可用目录；需要自动启动时，在 `state.initial.autoStart` 显式指定节点。`start()` 接纳目录并应用启动策略，服务准备在 `createHost()` 返回前完成。省略 `services` 不会创建附加服务的 backend、连接或清理任务。Vault 明确依赖 Persistence，Host 不自动补装依赖。

两个 Host 可以使用不同清单；同一份服务声明也可创建多个相互隔离的 Host。安装集合创建后固定，普通 Plugin 更新复用已准备的服务。修改安装清单需要创建新 Host。

## 读取和修改插件配置

通过 `host.config` 管理配置，不需要安装 Workbench 或创建管理连接：

```ts
const snapshot = await host.config.get(owner)
const checked = await host.config.validate(owner, { endpoint: 'https://example.com' })
if (checked.ok) {
	const result = await host.config.patch(owner, { endpoint: 'https://example.com' })
	// result.application 区分 applied、deferred 和 saved-not-applied。
}
await host.config.reset(owner, ['endpoint'])
```

`owner` 是 `PluginNodeAddress`。方法会先完成 Host 初始目录接纳，然后与图更新共用一个队列；不存在的节点、未声明的 fork 或没有配置 schema 的节点以结构化失败返回。`validate()` 合并当前记录进行校验，不写入。`patch()` 顶层合并后校验完整对象；`reset()` 删除指定键再经 schema 标准化，省略键列表时重置整个对象。

写入顺序为校验一次 → 暂存标准化快照 → 等待存储完成 → 确认 revision → 通知运行中的 generation。停止的节点返回 `deferred`，通知失败返回 `saved-not-applied`，不会把已经保存的值报告为未修改。省略存储时 Host 使用内存配置；Host 拥有唯一的存储实现，管理 RPC 和开发控制台也委托同一套用例。

关闭后所有配置方法拒绝新请求。Host 配置入口是受信任宿主 API，网络端点仍须通过既有认证和授权；它不会自动开放 RPC 或监听器。

## 保存配置和运行策略

Host 分别通过 `configRecords` 与 `state` 指定启动值及可选文档存储。两者不依赖安装 Persistence 服务，已有存储只需提供 `HostDocumentStorage` 的 `getText()`、`put()` 和 `stat()`：

```ts
import { createHost } from '@pluxel/host'
import { createNodePersistenceBackend } from '@pluxel/services/persistence'

const files = createNodePersistenceBackend({ root: './data' })
const host = await createHost({
	plugins: [MyPlugin],
	configRecords: {
		storage: files.namespace('config'),
		initial: [{ owner, config: { endpoint: 'https://example.com' } }],
	},
	state: {
		storage: files.namespace('runtime-state'),
		initial: { autoStart: [owner] },
	},
})
```

省略 `storage` 时只用内存。提供 `storage` 时默认 `mode: 'writable'`；`mode: 'readonly'` 读取已有文档并拒绝写入，文档不存在时保留 `initial` 且不创建文件。已有文档优先于启动种子，Host 返回前会完成两个存储的准备。配置保留 v3、运行策略保留 v5 文档格式，不在应用重新打包时覆盖已有数据。

文档存储是借用的：Host 关闭时等待自己的写入、清理定时器并报告 flush 失败；不会调用外部 backend 的 close。共享 backend 的创建和关闭由应用或对应服务拥有。`put()` 必须在完整文档提交后才 resolve，并在 `{ atomic: true }` 时提供旧文档或新文档的完整替换语义；不能用“请求已入队”冒充写入成功。

Host 应用解析器从显式传入的 `startup.env` 读取 `PLUXEL_CONFIG` 及编译生成的环境绑定。初始配置按 `configRecords.initial`、编译绑定、`PLUXEL_CONFIG` 的顺序覆盖合并；持久化记录优先于初始种子。底层 `createHost()` 不隐式读取进程环境。

## Plugin 读取能力

`this.ctx.logger` 是 Core 始终提供的基础能力，插件无需 import `@pluxel/logging`，也无需 `ctx.require(Logging)`。宿主的 `logging(plan)` 配置输出 sink、过滤策略和日志存储；省略它不移除 logger，但不由 Host 安装这些输出和管理后端。`Logging` token 是宿主侧日志管理能力，与插件直接使用的 logger 不同。

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { Vault } from '@pluxel/services/vault'

@Plugin()
export class CredentialsPlugin extends BasePlugin {
	init() {
		const storage = this.ctx.require(Vault)
		// 使用该 Plugin owner 绑定的 storage。
	}
}
```

服务目录声明只让合法的可选属性进入通用 Context 类型，不证明任意宿主已经安装服务。必需能力通过 `ctx.require(token)` 按对象身份读取；未安装抛出 `ContextCapabilityMissingError`，已安装服务的构造异常原样传播。可选路径可以使用 `ctx.vault?.…`，但准备失败不会伪装成可选缺失。

Token 的访问范围与 backend 生命周期不同：`owner` 只允许 Plugin、Part 和 caller Context；`root` 只能在真实 RootContext 上通过 `require()` 取得。`ctx.root` 是同一个宿主根引用，持有它就持有 root 能力访问权；访问范围表达资源所有权，不是隔离不可信插件的安全沙箱。共享一个 backend 并不意味着向 root 或全部插件开放同一 API。

## 编写服务安装器

同步 Context descriptor 负责属性和 view；Host 的 `prepare()` 负责资源。两者使用同一个 token，不建立额外 registry。

```ts
import { defineContextCapability, installRootCapability } from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'

const Clock = defineContextCapability<{ now(): number }>('acme.clock', {
	access: 'root',
	property: 'acmeClock',
})

export function clock() {
	return defineHostService({
		name: 'Acme clock',
		capabilities: [
			installRootCapability(Clock, {
				property: 'acmeClock',
				create: () => ({ now: () => Date.now() }),
			}),
		],
		prepare({ ctx }) {
			ctx.require(Clock)
		},
	})
}
```

安装器只生成声明；不要在调用安装器时打开连接。需要依赖时填写 `requires: { clock: Clock }`，`prepare({ dependencies })` 中的 `dependencies.clock` 从该 token 推导。依赖只能是能在 root 访问的能力；owner-only API 不能注入共享 backend。一个服务可提供多个 descriptor，它们进入同一份计划统一校验。

异步构造的 backend 可以在 `prepare()` 中创建，以 root 为 WeakMap key 保存，再由同步 descriptor 读取并创建 owner view。资源创建成功后立即调用本次准备传入的 `effects.defer()` 或 `effects.own()` 登记清理；准备中途失败也必须释放已经获取的资源。不要在声明闭包中保存由多个 Host 共享的单例 backend。

## 顺序与失败

创建顺序固定：验证插件目录和完整服务清单 → 编译 Context shape → 创建 root → 按依赖顺序准备服务 → 返回 Host。重复 token、属性冲突、缺失依赖和循环都在工厂调用前拒绝；不同 token 不按属性名互相替代。没有依赖关系时按当前可准备项的声明顺序执行。

准备失败会清理已获取的资源，并拒绝 `createHost()`。如果清理也失败，`AggregateError` 保留原始准备异常作为 `cause`。关闭先停止新接纳和来源会话、排空图操作、停止 Plugin generation，再逆序释放服务；某项清理失败不阻止其余清理。`close()` 幂等，重复调用复用同一个 Promise。

每项服务取得独立的 effects scope，因此服务内部的 `shutdown`、`runtime`、`final` phase 不改变服务依赖之间的关闭顺序。

HTTP、Database、Persistence、Vault、Commands、NodeModules、Workers、Logging、Management 和 Workbench 均可显式组合到 Host；`servicesPreset()` 仅返回服务清单，准备、失败回滚和关闭统一由 Host 负责。

## 服务参与 Plugin 发布

需要像 HTTP 一样随 Plugin generation 原子发布资源的服务可提供固定 `lifecycle(ctx)`，返回 Core 的
`finalizeGeneration`、`settleGenerations`、`prepareCommit`、`publishCommit` hooks。Host 每个 root 绑定一次，
按服务依赖顺序调用。finalize 可以在不同 generation 间并发；settle 收集候选拒绝，prepare 完成所有可能失败的工作，
publish 只同步交换已准备好的状态且必须返回 `undefined`。不得在 publish 分配资源、启动异步工作或抛出预期失败。
工厂本身不做 IO，不动态添加 hook；资源仍归服务 effects 所有。这复用 Core 的单次提交，不产生第二份生命周期。

## Database

```ts
import { createHost } from '@pluxel/host'
import { database } from '@pluxel/services/database'
import { pglite } from '@pluxel/services/database/pglite'

const host = await createHost({
	services: [database({ backend: pglite({ dataDir: './data/database' }) })],
})
```

安装 PGlite backend 时由应用显式安装 `@electric-sql/pglite`；PostgreSQL 应用安装 `pg`，并使用
`postgres({ connectionString })`（来自 `@pluxel/services/database/postgres`）。工厂声明不打开数据库；
第一次 Plugin `ctx.require(Database).use(definition)` 才加载对应驱动并完成 owner migration。
省略 Database descriptor 不产生数据库 capability、连接、目录或 driver 安装依赖。
backend 工厂返回 Host 独占的 adapter，Host 在 accepted operations 排空后关闭它；每个 Host 应通过工厂创建自己的资源。
驱动选择由实际 backend import 决定，Standalone Host 不需要额外维护 driver 启用列表。

## 宿主管理操作

独立 Host 提供 `status()` 读取一次已提交图的状态，`setAutoStart()` 持久化冷启动意图，
`setProviderDefault()` / `setDependencyOverride()` 修改 provider 选择，`forks.ensure()` / `forks.remove()`
管理 fork。它们与 `startNode()`、配置操作共用同一协调队列；读写前会完成首次 `start()`。
状态包含不可用节点与最近生命周期失败，不因启动失败就丢弃用户意图。

服务若拥有 fork 的持久元数据，可声明 `removeNodeMetadata(ctx, node)`。Host 先停止 fork，再删除配置与服务元数据，
最后提交 fork 删除；服务按依赖逆序清理，失败保留已停止的 fork，以便重试。普通 generation 停止不会删除持久元数据。

## 自定义组合的开发和生产接入

`HostApplication` 固定声明 `plugins`、`sources`，在每次启动时调用
`configure({ root, mode, env, bindings, deployment })` 获取 `services`、`config`、`state`、`configRecords`。
`configure` 不能替换 Plugin 目录。服务准备完成、开发附件接好之后，Host 调用可选的
`prepare({ host, startup })`，再启动 Plugin；失败由启动入口回滚整个 Host。

```ts
import type { HostApplication } from '@pluxel/host'
import { standardServices } from '@pluxel/services'
import { resolve } from 'node:path'

export default {
	plugins: [],
	configure({ env, deployment }) {
		return {
			services: standardServices({
				persistence: env.DATA_DIRECTORY ?? './data',
				nodeModules: deployment ? { root: resolve(deployment.root, 'artifacts/node') } : undefined,
			}),
		}
	},
} satisfies HostApplication
```

`standardServices()` 明确提供 HTTP、Commands、NodeModules、Workers、Persistence。
Vault、Database、Logging、Management、Workbench 另行加入服务数组；它不加入任何 Plugin。
`nodeModules` 直接接收 `nodeModules(options)` 的制品定位配置，供 NodeModules 与 Workers 共用。
生产 freezer 输出的 `artifacts/node` 必须相对 `deployment.root` 选择，不能依赖启动目录；
开发不配置该目录，使用 `vitePreset()` 接入已安装 NodeModules 的源码编译器，或在 `host()` 旁显式添加 `nodeArtifacts()`。自行组合服务时同样把生产制品配置传给 `nodeModules()`。
直接 `runHostApplication(application, { startup })`（`@pluxel/host/application`）返回普通 `PluginHost`，
不创建监听器，也不增加 `fetch` 成员。

应用 `tsdown.config.ts` 使用 `pluxel()`（`@pluxel/rolldown`）。`launcher: 'host'` 适合后台服务；
`'fetch'` 输出 HTTP handler，`'node'` 再启动 Node 监听器。后两项要求应用选择 `http()`。
构建不会执行 `configure()`，运行时才读取最新环境。`variant: 'headless'` 不携带 Workbench shell。
Workbench 应用显式安装 `workbenchService()` 和 `workbenchHttp()`，并选择 `variant: 'workbench'` 携带 shell。

当前开发附件编译源码 Plugin 的 Workbench 声明；它尚不加载已安装包的 `dist/workbench` inventory，这份预编译 inventory 由生产构建合并并加载。因此仅提供编译产物的 Workbench Plugin（包括 npm 安装的 `@pluxel/vault-admin`）在开发时可能因缺少已提交的 view artifact 而启动失败；Workbench shell 可访问不代表这些 Plugin 已就绪。

### 动态插件的共享入口

`sourceFrameworks` 是未来动态 Plugin 可以借用的框架模块入口清单，不是前端框架选择或权限白名单。动态来源的未来 Plugin 无法从静态 import 图推导。使用底层 `@pluxel/rolldown` 时，用 `pluxel({ sourceFrameworks: [...] })`
列出它们允许借用的选装框架作者入口，例如 `@pluxel/services/http`、`@pluxel/workbench` 和 `elysia/ws`。
Core 基础作者入口固定提供；清单中的其他入口必须能从应用解析，并随部署一起打包，动态 Plugin 借用同一模块身份。
构建时，Core、Host 与清单所选包的根入口和子路径统一从应用解析，避免依赖树中的多份物理安装生成不同的 capability token；这不额外收集未导入的子路径。
该清单不安装服务，也不扫描工作区发现服务；固定 Plugin 的依赖沿实际 import 图打包。

官方 `@pluxel/services/build` 已包含默认服务的共享入口，Workbench variant 还包含 Workbench 作者入口；无需手写这份配套清单。需要自定义服务的动态插件时，`sourceFrameworks` 在官方清单上追加入口，例如 `buildPreset({ sourceFrameworks: ['@acme/service'] })`。应用仍须独立安装对应服务。

开发更新结果可从 `host.status()` 的 `recentUpdate` 和 Management 更新订阅读取，无需额外配置 reader。
候选加载失败时保留上一版本；整应用替换失败后会尝试从上一次成功声明建立新 Host，并报告补偿结果。
首次启动或补偿失败且没有可用 Host 时记录 `failed`，不会报告为已保留或恢复旧版本。

动态来源 watcher、缺失依赖恢复 watcher 及恢复通知失败也进入同一份应用更新记录，并保留原始错误到日志。
这类失败不会把所有已运行插件标成启动失败；现有 Host 仍运行时报告 `retained-previous`。
更新记录表示最近一次尝试，不是 watcher 健康检查：后续更新成功可以覆盖该记录，不承诺失效 watcher 会自动重新建立。

官方 `vitePreset()` 同时提供服务所需的数据库声明转换，将已校验的迁移事实注入 `defineDatabase()`；
通用 `host()` 保持 Core 源码工具链，需要手工组合数据库开发能力时显式添加 `databaseSourceVitePlugin()`。

控制台查询需要已有可用 Host；如果应用首次求值就失败、尚未建立 Host，先查看 Vite 日志并修复源码。
这与已有 Host 的空插件目录不同：后者仍可执行控制台脚本并读取应用级更新结果。

动态 entry 首次加载就有语法错误或缺失依赖时，修复 entry 或补齐依赖即可再次尝试，无需先有已启动插件。
单个 entry 的语法修复保持无关服务与插件代继续运行。执行来源仅在工具链有明确事实时标为源码或构建模块；
未观察到元数据的安装包保持 `unreported`，其动态更新范围仍明确为 entry-only。
