---
title: Host 服务组合与扩展
description: 使用官方默认组合运行应用，或按需选择 Host 服务并管理准备与清理。
---

只配置现有应用时先读[Host 配置教程](./configuration.md)的目标章节。本页用于逐项组合服务、编写安装器，以及核对准备、回滚和发布所有权。

官方应用和 starter 使用 `defineHostApplication(factory)` 配合 `servicesPreset()`：应用声明插件、数据位置和启动策略，官方入口负责开发附件和部署制品路径。需要自定义服务集合时，使用 `@pluxel/host` 逐项组合；它默认只提供 Core 能力。

| 你负责什么               | 从哪里开始                                                  |
| ------------------------ | ----------------------------------------------------------- |
| 应用装配                 | [官方组合](#官方默认组合)或[创建宿主](#创建宿主)            |
| Plugin 使用现有服务      | [读取能力](#plugin-读取能力)；通常无需阅读安装器实现        |
| 配置和启动策略持久化     | [保存配置和运行策略](./configuration.md#保存配置和运行策略) |
| 自定义服务               | [安装器](#编写服务安装器) → [顺序与失败](#顺序与失败)       |
| 参与 generation 原子发布 | [发布 hooks](#服务参与-plugin-发布)                         |

## 官方默认组合

新应用直接采用[宿主配置](./configuration.md#应用入口)中的应用、Vite 与构建示例。三处声明分别决定本次运行的能力、开发附件和交付制品：

| 入口                                            | 职责                            |
| ----------------------------------------------- | ------------------------------- |
| `@pluxel/services/preset` 的 `servicesPreset()` | 返回运行时服务清单              |
| `@pluxel/services/vite` 的 `vitePreset()`       | 为已安装服务接入开发附件        |
| `@pluxel/rolldown` 的 `pluxel()`                | 选择应用交付并编译 Shell 与制品 |

`servicesPreset()` 异步返回普通服务清单，按所选能力加载模块；资源仍由 Host 准备与关闭。它提供 HTTP、Commands、NodeModules、Workers、Vault、Management，以及 `managementCommands()` 提供的基础插件命令，默认加入 Workbench，页面位于 `/__pluxel/workbench`。FS 与 TinyBase 属于每个 Core 的固定能力，[后端](./configuration.md#选择文件后端)只在 Host 的 `runtime.zenfs` 中选择。它不加入业务 Plugin 或 Database；额外服务可以追加到等待得到的数组。可传 `product` 设置产品信息，`workbench: false` 关闭工作台，Management 仍可用。省略 `workbench` 时默认启用；显式传入非布尔值或未知顶层选项会在服务加载前拒绝并指出字段。日志由应用通过 `runtime.logtape: logtape()`（`@pluxel/core/config`）配置，preset 不补装输出。数据库或自定义管理面组合使用下文的显式服务安装器。

`vitePreset()` 组合通用 Host 开发驱动与官方服务开发附件，只为应用实际安装的 HTTP、NodeModules、Workbench 接入支持；Workbench 制品模块按需加载。Services 的官方组合分别拥有运行时服务和 Vite 附件；应用交付与配套制品统一由 `@pluxel/rolldown` 的 `pluxel()` 构建。`@pluxel/services` 根入口只提供 `standardServices()`，不加载 Management 或 Workbench 后端。

开发控制台归 `@pluxel/host-vite`，基础 `host({ entry, devConsole: true })` 即可启用；官方 `vitePreset()` 接受同样的开关。它不要求安装服务。脚本显式 import 服务 API，通过借用的 `dev.ctx` 访问已安装能力；见[开发控制台](../development/dev-console.md)。Core 始终提供 `ctx.logger`，Logging 配置负责输出与存储，不是插件使用 logger 的前提。

部署入口解析并验证交付清单，把已确认的 `startup.deployment.delivery` 交给 `servicesPreset()`。preset 不重复读取清单；standalone 使用应用的 `artifacts/node`，modules 使用各已加载模块所属输出的已校验 inventory。清单缺失、无效或种类未知时由部署入口拒绝启动。Workbench 制品仍从应用的 `workbench` 目录加载，搬移发行目录不需要改写应用中的制品路径。业务数据仍由应用选择，部署时使用发行目录外的绝对数据路径。

Host 的配置和启动策略默认通过 Core 私有文档保存，沿用 `runtime.zenfs`；普通应用无需额外接线。嵌入应用可继续提供[借用文档适配](./configuration.md#保存配置和运行策略)。已有配置或状态文件若解析或结构校验失败，Host 准备失败且保留原文件；人工修复或从备份恢复后再重启。环境变量由应用的配置工厂显式读取，例如按 `startup.env.PLUXEL_WORKBENCH !== 'false'` 设置 `workbench`。

应用构建默认携带 Workbench shell；原生来源的共享身份由 runtime sharedPackages 选择。后台应用可以同时选择 `servicesPreset(startup, { workbench: false })` 与 `pluxel({ variant: 'headless' })`。构建 variant 决定交付资源，服务声明决定本次启动安装哪些能力。`workbench: false` 保留认证与管理 HTTP/WebSocket 接入，但不加载 Workbench 后端或 Shell。

## 创建宿主

```ts
import { zenfs } from '@pluxel/core/config'
import { createHost } from '@pluxel/host'
import * as nativeFs from 'node:fs'
import { resolve } from 'node:path'
import { Passthrough } from '@pluxel/core/fs'
import { vault } from '@pluxel/services/vault'
import { MyPlugin } from './plugin.js'

const prefix = resolve('./data/fs')
await nativeFs.promises.mkdir(prefix, { recursive: true })
await using host = await createHost({
	plugins: [MyPlugin],
	services: [vault()],
	runtime: {
		zenfs: zenfs({
			mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
			durableMounts: ['/'],
		}),
	},
})
await host.start()
```

`plugins` 是可用目录；需要自动启动时，在 `runtime.state.autoStart` 显式指定节点。`start()` 接纳目录并应用启动策略，服务准备在 `createHost()` 返回前完成。省略 `services` 不会创建附加服务的 backend、连接或清理任务。Vault 的默认加密后端借用 Core FS；`vault({ backend: 'bindings' })` 只提供部署绑定读取，不打开 Vault 加密目录。Host 不自动补装依赖。

短作用域使用 `await using`：离开作用域时等待 Host 排空操作、停止插件并释放服务。`Symbol.asyncDispose` 与 `close()` 共用一次关闭结果，清理失败会向调用方传播。跨越函数作用域的长期运行 Host 由创建者显式 `await host.close()`。

`createHost()` 只接受 Host 配置字段，未知字段在资源获取前拒绝；应用解析结果中的 `startup/sources/prepare` 属于执行入口，不能整对象传给它。服务选择和配置容器在异步准备前捕获；`updateCatalog()` 同样捕获调用时的插件数组。借用的 storage、callback 与服务 handle 保留原身份。

两个 Host 可以使用不同清单；同一份服务声明也可创建多个相互隔离的 Host。安装集合创建后固定，普通 Plugin 更新复用已准备的服务。修改安装清单需要创建新 Host。

## Plugin 读取能力

`this.ctx.logger` 是 Core 始终提供的基础能力，插件无需 import 日志包，也无需 `ctx.require(Logging)`。应用在 `runtime.logtape` 直接提供原生 LogTape Config 或 root factory；框架选项使用 `{ input, options }`，`logtape()`（`@pluxel/core/config`）是可选输出预设；省略 `runtime.logtape` 不安装进程日志配置。`Logging` token 从 `@pluxel/core/logging` 导入，用于宿主侧读取已配置的 manager，见[日志配置](./configuration.md#host-logging)。

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { Vault } from '@pluxel/services/vault'

@Plugin()
export class CredentialsPlugin extends BasePlugin {
	init() {
		const storage = this.ctx.require(Vault)
		// get/set/delete 返回带 revision、source 和 writable 的不可变快照。
		const kv = storage.kv()
		// 持久写在确认提交后返回；部署绑定整条只读。
	}
}
```

服务目录声明只让合法的可选属性进入通用 Context 类型，不证明任意宿主已经安装服务。必需能力通过 `ctx.require(token)` 按对象身份读取；未安装抛出 `ContextCapabilityMissingError`，已安装服务的构造异常原样传播。可选路径可以使用 `ctx.vault?.…`，但准备失败不会伪装成可选缺失。

Token 的访问范围与 backend 生命周期不同：`owner` 只允许 Plugin、Part 和 caller Context；`root` 只能在真实 RootContext 上通过 `require()` 取得。`ctx.root` 是同一个宿主根引用，持有它就持有 root 能力访问权；访问范围表达资源所有权，不是隔离不可信插件的安全沙箱。共享一个 backend 并不意味着向 root 或全部插件开放同一 API。

## 读取和修改插件配置

通过 `host.config` 管理配置，不需要安装 Workbench 或创建管理连接：

```ts
const snapshot = await host.config.get(owner)
if (!snapshot.ok) throw new Error(snapshot.message)
if (snapshot.readonly) throw new Error('Configuration is read-only')
const checked = await host.config.validate(owner, { endpoint: 'https://example.com' })
if (!checked.ok) throw new Error(checked.message)
const result = await host.config.patch(owner, { endpoint: 'https://example.com' })
if (!result.ok) throw new Error(result.message)
// result.application 区分 applied、deferred 和 saved-not-applied。
```

`owner` 是 `PluginNodeAddress`。方法会先完成 Host 初始目录接纳，然后与图更新共用一个队列；不存在的节点、未声明的 fork 或没有配置 schema 的节点以结构化失败返回。`validate()` 合并当前记录进行校验，不写入。`patch()` 顶层合并后校验完整对象；`reset()` 删除指定键再经 schema 标准化，省略键列表时重置整个对象。

写入顺序为校验一次 → 暂存标准化快照 → 等待存储完成 → 确认 revision → 通知运行中的 generation。停止的节点返回 `deferred`，通知失败返回 `saved-not-applied`，不会把已经保存的值报告为未修改。默认文档使用 Core 的文件后端；Host 拥有唯一的配置存储实现，管理 RPC 和开发控制台也委托同一套用例。

成功读取与写入返回 `readonly`，`host.config.status()` 与 Management 的 `client.config.status()` 提供不依赖插件 schema 的只读状态。管理调用使用 `client.config.patch(owner, patch)` 与 `patchField(owner, input)`；不要求部署版本或 expected 参数。文件外部变化通过同一配置校验与通知路径接纳，见[共享文件](./configuration.md#共享文件与外部修改)。多个实例同时写入可能覆盖修改，需要并发保证时使用数据库。

关闭后所有配置方法拒绝新请求。Host 配置入口是受信任宿主 API，网络端点仍须通过既有认证和授权；它不会自动开放 RPC 或监听器。

## 宿主管理操作

独立 Host 提供 `status()` 读取一次已提交图的状态，`setAutoStart()` 持久化冷启动意图，
`setProviderDefault()` / `setDependencyOverride()` 修改 provider 选择，`forks.ensure()` / `forks.remove()`
管理 fork。它们与 `startNode()`、配置操作共用同一协调队列；读写前会完成首次 `start()`。
状态包含不可用节点与最近生命周期失败，不因启动失败就丢弃用户意图。

Fork 操作直接接收完整地址：`const east = WorkerPlugin.nodeAddress('east')`，然后调用
`host.forks.ensure(east, { autoStart: true })` 或 `host.forks.remove(east)`。取得地址本身不创建实例；
`ensure` 省略 `autoStart` 时保留已有选择，新 fork 默认不自动启动。`selectFor: { consumer, requirement }`
可与创建一起提交依赖选择。结果的 `ok: false` 分支保留失败原因与状态，调用方必须检查。
Management 对应 `client.forks.ensure({ fork: east, autoStart: true })` 和 `client.forks.remove(east)`；
这些入口只接受 fork 地址，不接受 default 节点或拆分的 `base` / `forkId`。

服务若拥有 fork 的持久元数据，可声明 `removeNodeMetadata(ctx, node)`。Host 先停止 fork，再删除配置与服务元数据，
最后提交 fork 删除；服务按依赖逆序清理，失败保留已停止的 fork，以便重试。普通 generation 停止不会删除持久元数据。

## 自定义开发组合

服务与开发附件可分别选择。通用 `host()` 只负责应用加载与 HMR；HTTP、Node 制品和 Workbench 使用普通 Vite 插件显式接入：

```ts
import { defineConfig } from 'vite'
import { host } from '@pluxel/host-vite'
import { serviceSingletons } from '@pluxel/services/vite'
import { elysiaDevelopment } from '@pluxel/services/elysia/vite'
import { nodeArtifacts } from '@pluxel/services/node/vite'
import { workbenchArtifacts } from '@pluxel/workbench/vite'

export default defineConfig({
	plugins: [
		serviceSingletons(),
		host({ entry: './src/app.ts' }),
		elysiaDevelopment(),
		nodeArtifacts(),
		workbenchArtifacts(),
	],
})
```

`serviceSingletons()` 为官方包保持原生 ESM 模块身份，避免 Vite 与服务附件取得不同的 token 或 constructor。最终 Host 的 package owner 由 `host({ entry })` 确定。Workbench target 的 Cap’n Web 与托管状态消费者的 TinyBase 都先核对原声明及实际安装，再接到宿主模块。TinyBase 的原生子路径保留 Node／browser 条件，私有版本保留自身解析；版本契约见[插件包](../development/plugin-package.md)。完全自定义的包集合可使用 `hostSingletons({ packages: [...] })`（`@pluxel/host-vite`）显式选择共享身份的包。只选择应用所需的附件与对应服务；附件不安装运行时服务。第三方附件通过同一个 Host 开发附件接口接入。`vitePreset()` 是官方集合的快捷组合，自定义应用也可以使用它配合自己的服务清单。

## 自定义组合的开发和生产接入

`defineHostApplication(factory)` 提供 startup 上下文类型并保留工厂返回类型；`HostApplicationFactory` 表示工厂，`HostApplication` 表示其返回的完整配置对象。
Host 每次启动传入 `{ root, mode, env, bindings, deployment }`，等待同步或异步工厂返回
`name`、`plugins`、`sources`、`services`、`runtime` 与可选 `prepare`。
Host 为每次装配浅复制并冻结 startup、env、bindings 和 deployment，工厂与 `prepare` 共用这份快照。bindings 中的资源对象保留原身份与调用方所有权；冻结不会递归到这些资源。直接调用 `runHostApplication` 时，传入的 env 是完整输入，不会隐式合并进程环境。
模块导入不执行工厂。普通静态片段可用 `satisfies` 检查，在工厂中组合；工厂只描述装配，资源应由服务 `prepare` 获取。服务准备完成、开发附件接好之后，Host 调用可选的
`prepare({ host, startup })`，再启动 Plugin；失败由启动入口回滚整个 Host。

```ts
import { zenfs } from '@pluxel/core/config'
import { defineHostApplication } from '@pluxel/host'
import { standardServices } from '@pluxel/services'
import { resolve } from 'node:path'
import * as nativeFs from 'node:fs'
import { Passthrough } from '@pluxel/core/fs'

export default defineHostApplication(async ({ env, deployment }) => {
	const prefix = resolve(env.DATA_DIRECTORY ?? './data')
	await nativeFs.promises.mkdir(prefix, { recursive: true })
	return {
		plugins: [],
		services: standardServices({
			nodeModules:
				deployment?.delivery === 'standalone'
					? { root: resolve(deployment.root, 'artifacts/node') }
					: undefined,
		}),
		runtime: {
			zenfs: zenfs({
				mounts: {
					'/': {
						backend: Passthrough,
						fs: nativeFs,
						prefix,
					},
				},
				durableMounts: ['/'],
			}),
		},
	}
})
```

`standardServices()` 明确提供 HTTP、Commands、NodeModules 和 Workers；FS 与 TinyBase 固定由 Core 提供。
Vault、Database、Management、Workbench 另行加入服务数组；日志通过 `runtime.logtape` 选择。该组合不加入任何 Plugin。
`nodeModules` 直接接收 `nodeModules(options)` 的制品定位配置，供 NodeModules 与 Workers 共用。
standalone 交付由 freezer 输出的 `artifacts/node` 必须相对 `deployment.root` 选择，不能依赖启动目录；modules 交付使用包内制品，不配置该目录。
开发不配置该目录，使用 `vitePreset()` 接入已安装 NodeModules 的源码编译器，或在 `host()` 旁显式添加 `nodeArtifacts()`。自行组合服务时同样把生产制品配置传给 `nodeModules()`。

显式配置 Node 制品的 `root` 或 `resolve` 时，Vite 保留该制品来源，不创建自动源码编译附件。显式再附加源码 compiler 会因来源冲突失败；清理时即使来源撤回失败，也会排空已接纳 setup 并清理活动 consumer，多个失败聚合报告。
直接 `runHostApplication('./dist/app.mjs', { startup })`（`@pluxel/host`）返回普通 `PluginHost`，
不创建监听器，也不增加 `fetch` 成员。

应用 `tsdown.config.ts` 使用 `pluxel()`（`@pluxel/rolldown`）。`launcher: 'host'` 适合后台服务；
`'fetch'` 输出 HTTP handler，`'node'` 再启动 Node 监听器。后两项要求应用选择 `elysia()`。
构建不会执行配置工厂，运行时才读取最新环境。`variant: 'headless'` 不携带 Workbench shell。
Workbench 应用通过 `servicesPreset()`，或[显式组合](../workbench/standalone-host.md) `workbenchService()`、`managementHttp({ bindings })` 与 `workbenchHttp()`，并选择 `variant: 'workbench'` 携带 shell。

仅安装 Management 无需安装 Workbench，包含 TypeScript 使用场景。自定义 Workbench Shell 可调用
`createRuntimeSessionClient<WorkbenchSessionApi>()`，分别从 `@pluxel/services/management/session` 与
`@pluxel/workbench/client` 导入工厂和 API 类型；普通管理客户端无需指定泛型。

客户端拥有 bootstrap 的 RPC graph。收到 epoch 失效通知时，它先终止原生 RPC session 并清空 `current`，
再调用 observer；调用方可在 observer 中释放自己持有的子句柄。关闭后的客户端拒绝新的或仍在等待的 bootstrap，
不重新连接，也不接纳迟到结果。

开发附件同时接入源码 Plugin 的 Workbench 声明和已安装包的 `dist/workbench` inventory。对于预编译包，它依据本次实际求值模块的 Core ABI 识别所属包，只接纳 catalog 选中的 Plugin definition，并校验产物；不会重新编译发布包。因此 npm 安装的 `@pluxel/services/plugins` 也可在开发环境启动。源码与包产物共享候选提交、拒绝保留和移除撤回流程；仍应通过插件状态确认启动结果，Workbench shell 可访问不代表所有 Plugin 已就绪。

### 动态插件的共享入口

原生固定 imports 与来源共享身份使用 `runHostApplication(..., { sharedPackages: serviceSharedPackages })`，清单来自 `@pluxel/services/sources`，包括 Services、Workbench、Commands 及其共享 token 依赖。Core/Host 始终由执行入口绑定；额外包从 startup.root 解析。需要自定义服务时追加 package name，并显式安装对应服务。

该机制先验证实际安装版本与 importer 声明，再选择 canonical 安装。Workbench target 与托管 TinyBase 消费者分别使用能力所有者的精确版本准入，私有 RPC／Store 保留自身解析。`capnweb` 与 `tinybase` 不直接加入 `sharedPackages`，以免绕过能力归属而重定向私有依赖。`serviceSingletons()` 在 Vite 中使用同一共享包清单和版本原则。交付选择与完整启动示例见[Host 配置](./configuration.md#生产构建)。

开发更新状态见 `host.status().recentUpdate` 或 Management 更新订阅，恢复语义见[HMR 失败与自动恢复](../development/tooling.md#hmr-失败与自动恢复)。
动态 watcher 或恢复通知失败同样记录原始错误；已有 Host 仍运行时可报告 `retained-previous`，但这不保证失效 watcher 自动重建。首次应用求值失败、尚无 Host 时，先修复 Vite 日志中的错误，不能使用控制台查询。

官方 `vitePreset()` 包含 Database 声明转换；自定义开发组合从 `@pluxel/rolldown/vite` 导入 `databaseSourceVitePlugin()`。

## Database

托管 SQL 由 `@pluxel/services/database` 提供，不在默认服务组合中，按需选择 backend：

```ts twoslash
import { createHost } from '@pluxel/host'
import { database } from '@pluxel/services/database'
import { pglite } from '@pluxel/services/database/pglite'

await using host = await createHost({
	plugins: [],
	services: [database({ backend: pglite({ dataDir: './data/database' }) })],
})
// 添加并启动需要托管 SQL 的 Plugin。
```

正式部署从 `@pluxel/services/database/postgres` 导入 `postgres`。两个 backend 工厂直接接收所选 driver 的原生配置或实例；配置创建的连接由 Host 排空后关闭，传入的实例由应用拥有。应用直接声明所选 driver：PGlite 使用 `@electric-sql/pglite`，PostgreSQL 使用 `pg`。服务工厂不打开数据库；第一次 Plugin 调用 `ctx.require(Database).use(definition)` 才加载 driver 并准备 owner migration。schema、迁移与生命周期见[数据库与数据归属](../plugin-development/database.md)，原生选项、资源借用及后端部署选择见[Host 配置](./configuration.md#选择-native-postgresql-或-pglite)。

应用也可以直接使用 Drizzle 与 driver 并拥有迁移、连接池和关闭流程，无需安装托管 Database，见[应用完全自管 SQL](../plugin-development/database.md#应用完全自管-sql)及[连接所有权](./configuration.md#application-private-database)。

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

准备失败会清理已获取的资源，并拒绝 `createHost()`。如果清理也失败，`AggregateError` 保留原始准备异常作为 `cause`。Host 关闭先停止新接纳、排空图操作、停止 Plugin generation，再逆序释放服务；某项清理失败不阻止其余清理。`close()` 幂等，重复调用复用同一个 Promise。Vite 执行会话拥有来源 watcher，在关闭 Host 前停止并排空观察；Host replacement 复用该来源 owner，见[HMR](https://github.com/PluxelJS/pluxel/blob/main/engineering/HMR.md#来源发现与资源所有权)。

每项服务取得独立的 effects scope，因此服务内部的 `shutdown`、`runtime`、`final` phase 不改变服务依赖之间的关闭顺序。

HTTP、Database、Vault、Commands、NodeModules、Workers、Management 和 Workbench 均可显式组合到 Host；`servicesPreset()` 仅返回服务清单，准备、失败回滚和关闭统一由 Host 负责。Core FS 与 TinyBase 的首次异步 IO 等待同一个准备任务，Host 在服务 prepare 前通过它们恢复配置，并等待所选日志配置准备完成；其他服务沿用自身 prepare 契约。

## 服务参与 Plugin 发布

需要像 HTTP 一样随 Plugin generation 原子发布资源的服务可提供固定 `lifecycle(ctx)`，返回 Core 的
`finalizeGeneration`、`settleGenerations`、`prepareCommit`、`publishCommit` hooks。Host 每个 root 绑定一次，
按服务依赖顺序调用。finalize 可以在不同 generation 间并发；settle 收集候选拒绝，prepare 完成所有可能失败的工作，
publish 只同步交换已准备好的状态且必须返回 `undefined`。不得在 publish 分配资源、启动异步工作或抛出预期失败。
工厂本身不做 IO，不动态添加 hook；资源仍归服务 effects 所有。这复用 Core 的单次提交，不产生第二份生命周期。

## 包依赖与共享实例

应用显式提供使用到的 Core、Host、Services 等框架 peer，以保证能力 token、Context 和编译 ABI 使用同一实例。optional peer 仅在启用对应入口时需要，例如 Workbench、Vite 与构建工具。普通实现依赖由所属包安装。

Core 拥有插件内核，Host 拥有应用与动态来源，Services 拥有官方服务及其组合，Workbench 拥有 UI 能力与 Shell。日志运行时归 Core，Management 和 preset 是 Services 的领域入口，不需要分别安装包。Services 的可选 Workbench 组合与 Workbench 使用的 Services 协议允许包级相互引用；具体模块不能依靠循环初始化，也不能从基础入口加载未选择的后端。插件集成测试宿主使用 `@pluxel/test`。

持久化路径及保存插件配置/运行策略，见[Host 配置](./configuration.md#保存配置和运行策略)。
