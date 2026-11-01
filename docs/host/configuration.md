---
title: Host 配置教程
description: 用一份 HostApplication 组合插件、服务、开发工具和生产部署。
---

Host 拥有插件目录、运行策略和服务生命周期。应用入口默认导出 `defineHostApplication(factory)` 声明的 `HostApplicationFactory`；Vite 和生产构建读取同一个入口。
插件只依赖 Core 和实际使用的服务，不需要全局 Runtime。

本页是应用装配的权威教程，各章可独立读取。只改 Plugin 方法、schema 或日志写法时，直接读[插件开发范式](../plugin-development/index.md)。编写自定义服务安装器再读[服务扩展](./services.md)。

| 本次要配置什么                     | 章节                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| 第三方 SDK 配置与可选预设          | [原生配置](#原生配置与预设)                                                               |
| 服务与固定插件、启动策略           | [组合](#选择组合)、[应用入口](#应用入口)                                                  |
| Vite 与动态插件来源                | [Vite](#vite-开发)、[动态来源](#动态来源)                                                 |
| 环境变量、JSON 文件与只读覆盖      | [环境](#配置环境变量)、[插件配置绑定](#绑定部署环境与-json-文件)                          |
| 配置及运行策略跨重启保存           | [持久化](#保存配置和运行策略)                                                             |
| 文件后端、只读或浏览器存储         | [FS](#选择文件后端)                                                                       |
| Vault 后端、部署凭据与备份         | [后端](#选择后端)、[绑定](#部署凭据)、[备份](#密钥与备份)                                 |
| 控制台、Workbench store 与远程日志 | [日志配置](#host-logging)、[OTLP](#远程输出原生-logtape-sink)                             |
| SQL 后端、应用自管连接与生命周期   | [Backend](#选择-native-postgresql-或-pglite)、[应用数据库](#application-private-database) |
| 轻量独立 Host                      | [Logging](#独立-logging-host)、[HTTP listener](#独立-http-host)                           |
| 浏览器与 Web Worker                | [浏览器 Host](#浏览器-host)                                                               |
| 生产制品                           | [构建](#生产构建)                                                                         |

以下 `HostApplication`、`servicesPreset()` 和独立 `createHost()` 示例表示不同装配方式；选择一种适合现有项目的入口，不叠加创建第二个 Host。

## 原生配置与预设

应用代码直接使用上游配置：文件后端使用 ZenFS `mounts`，日志使用 LogTape `Config`，SQL 使用 pg/PGlite 原生配置或实例，HTTP listener 使用 srvx options。预设负责常用默认值，自定义装配保留原生 options、callback 和组合能力；框架只约束自己拥有的身份、dispatch、资源与关闭行为。OTel 和 Playwright 分别通过[原生 providers](../plugins/otel.md)和[原生连接](../plugins/browser.md#使用原生连接参数)接入，业务插件依赖抽象能力，应用选择默认或自定义 provider。

插件的 `configs.use()` 仍描述可保存、可经管理面编辑的领域设置。函数和连接通过代码装配，部署凭据沿用 Vault 与环境绑定；进阶 SDK 装配使用应用代码或各插件的 provider 扩展入口。

## 选择组合

- 自定义或轻量宿主：`@pluxel/host`，只安装显式列出的服务。
- 浏览器与 Web Worker：`@pluxel/host/browser`，使用固定插件目录和浏览器可用的服务。
- 官方服务器组合：`servicesPreset()`，包括 HTTP、Commands、Node artifacts、Workers、Vault、Management 和默认启用的 Workbench。日志通过 `config.logger: logtape()` 选择，托管 SQL Database 按需另行安装。
- 无管理页面的常用基础组合：`standardServices()`，包括 HTTP、Commands、Node artifacts 和 Workers。

Database 单独安装；关闭 Workbench 不会关闭插件业务能力。详细服务列表与资源归属见[组合 Host 服务](./services.md)。

## 浏览器 Host

`@pluxel/host/browser` 导出同一个 `createHost()`、`defineHostService()` 及其类型，执行真实的 Core 依赖图、配置和生命周期。这个入口不加载 Node 应用启动器或文件系统来源；插件、所选服务及其依赖也必须支持浏览器，能在启用 Node 兼容层的 Worker 运行不代表浏览器可用。

普通 `@Plugin` 源码仍需在构建阶段经过 Pluxel lowering。Vite 同时为开发模块和生产 Worker 安装独立编译插件：

```ts no-twoslash
// vite.config.ts
import { defineConfig } from 'vite'
import { configSourcePlugin, createPluginSemanticsPlugin } from '@pluxel/rolldown/plugins'

const root = import.meta.dirname
export default defineConfig({
	root,
	oxc: { decorator: { legacy: true } },
	plugins: [createPluginSemanticsPlugin({ root }).plugin, configSourcePlugin()],
	worker: {
		plugins: () => [createPluginSemanticsPlugin({ root }).plugin, configSourcePlugin()],
	},
})
```

在页面或 Worker 中装配已编译的插件，并检查启动报告。下面的 `DemoPlugin` 是普通导出的 Plugin；它依赖的 provider 也要列入 `plugins`：

```ts no-twoslash
import { pluginNodeAddressOf } from '@pluxel/core'
import { createHost } from '@pluxel/host/browser'
import { DemoPlugin, ProviderPlugin } from './plugins'

const host = await createHost({
	plugins: [DemoPlugin, ProviderPlugin],
	state: { initial: { autoStart: [pluginNodeAddressOf(DemoPlugin)] } },
})
try {
	const report = await host.start()
	if (
		report.reconciliation.length > 0 ||
		(report.core.status === 'committed' && !report.core.summary.lifecycleReport.ok)
	) {
		throw new Error('Plugin 启动失败', { cause: report })
	}
	console.log(await host.status())
	// 在 Host 存续期间执行应用操作。
} finally {
	await host.close()
}
```

FS 与 TinyBase 始终内建；配置和运行策略使用同一个 Core 文件后端，默认 InMemory 仅在内存中保留。业务 consumer 通过 constructor 注入 provider，在 `init()` 中注册页面或 Worker 的消息处理，并用 `ctx.effects` 释放监听器；界面可以消费 `host.status()` 展示真实节点状态。停止页面或 Worker 前由创建者 `await host.close()`，然后终止 Worker；直接 `terminate()` 不会等待插件清理。

## 应用入口

```ts no-twoslash
import { resolve } from 'node:path'
import * as nativeFs from 'node:fs'
import { pluginNodeAddressOf } from '@pluxel/core'
import { defineHostApplication } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { servicesPreset } from '@pluxel/services/preset'
import { Passthrough } from '@pluxel/core/fs'
import { logtape, zenfs } from '@pluxel/core/config'
import { TodoPlugin } from '@app/todo'

export default defineHostApplication(async (startup) => {
	const environment = resolveHostEnv(startup.env)
	const prefix = resolve(startup.root, environment.dataRoot, 'fs')
	await nativeFs.promises.mkdir(prefix, { recursive: true })
	return {
		name: 'my-app',
		plugins: [TodoPlugin],
		config: {
			logger: logtape(),
			storage: zenfs({
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
		services: await servicesPreset(startup, {
			workbench: environment.workbench ?? true,
		}),
		state: { initial: { autoStart: [pluginNodeAddressOf(TodoPlugin)] } },
		configRecords: {
			initial: [{ owner: pluginNodeAddressOf(TodoPlugin), config: { maxItems: 100 } }],
		},
	}
})
```

`plugins` 表示代码可用，不代表自动启动。`state.initial.autoStart` 选择冷启动时运行的节点，插件自己的 required dependencies 由图统一处理。

配置工厂每次创建新 Host 时执行，可以读取 `env`、`bindings`、`root` 和 `deployment`。构建不会执行它。
Vite 和生产构建都要求入口直接默认导出 `defineHostApplication(内联工厂)`：工厂直接返回对象，或在块中以唯一、无条件的最后一条顶层 `return` 返回对象；返回对象不使用 spread。`delivery: 'standalone'` 构建中的 `plugins` 使用直接数组或模块级 const/imported 数组，不使用条件、函数调用或 startup 计算。构建只分析静态清单，不执行工厂。没有环境绑定时，Vite 可运行条件插件数组。

静态清单的数组必须始终保留声明时的成员：不要在模块、工厂、helper 或 callback 中修改、通过别名修改，或用动态 import 追加插件。构建会拒绝工厂中的明显修改、别名和向 helper 传递数组；`map`、`slice` 等只读使用可以保留，但 callback 也不得修改原数组。这是部署合同，有限语法检查不能证明任意 JavaScript 的副作用。需要来源目录时使用 modules 交付和显式 `sources`；standalone 拒绝声明 sources。

`prepare({ host, startup })` 在服务与开发附件准备完成后、插件启动前执行；适合应用级硬前提。资源获取成功后立即登记到明确的 owner，清理失败不会跳过其他资源。

`configRecords` 和 `state` 默认使用 Core 的内部文档，是否跨启动保存取决于 `config.storage` 后端；省略后端时使用 InMemory。需要临时状态时显式选择 `mode: 'memory'`，见[保存配置和运行策略](#保存配置和运行策略)。已有持久文档优先于启动 seed。

## Vite 开发

```ts no-twoslash
import { defineConfig } from 'vite'
import { vitePreset } from '@pluxel/services/vite'
import { hostEnv } from '@pluxel/host/environment'

export default defineConfig({
	server: { host: hostEnv.hostBind ?? '127.0.0.1', port: hostEnv.hostPort ?? 3000 },
	plugins: [vitePreset({ entry: './src/app.ts', devConsole: true })],
})
```

自定义宿主可以使用 `@pluxel/host-vite` 的 `host()` 并显式组合服务开发附件。应用、动态插件和控制台共享 Host 专用的 `pluxel` Vite environment；默认 SSR 和第三方 SSR 加载保持独立。插件源码必须经过 Pluxel lowering，执行空间边界见[工具链说明](../development/tooling.md#source-build-boundary)。
React 页面由应用显式安装 React Vite plugin。

配置工厂 identity 变化时重新求值完整配置并重建 Host，固定插件的 import 更新也可能触发重建。工厂求值失败保留旧 Host。动态来源更新若未使工厂失效，则复用本次配置并提交 catalog replacement。失败候选保留旧实现；已提交后的 init 失败则报告新一代的生命周期问题，不声称旧代仍然运行。
在线检查与修改见[开发控制台](../development/dev-console.md)。

自行通过 Vite `createServer()` 持有开发会话、并向 `bindings` 借出连接或存储时，关闭顺序为：
先 `await closeHostViteSession(server)`（从 `@pluxel/host-vite` 导入），然后在 `finally` 中
`await server.close()`，最后释放借出的资源。首项停止 Host 更新接纳并排空已有工作，保留原始清理失败；
仅调用 Vite `server.close()` 会丢失部分插件关闭错误。未取得 Host 会话的 server 返回 `undefined`；
已取得会话的重复关闭复用同一个结果。这个函数不关闭 Vite server，也不接管调用者提供的连接。

## 动态来源

```ts no-twoslash
import { pluginSource } from '@pluxel/host/sources'

const sources = [
	pluginSource({
		kind: 'directory',
		path: './managed-plugins/entries',
		include: ['*.mjs'],
	}),
]
```

将 `sources` 放在应用声明中。来源负责发现入口，包安装由应用或 Package Manager 负责；新入口进入同一个 Host catalog，是否运行仍取决于策略。
`pluginSource()` 只创建并冻结 file/directory 数据，不打开 watcher。启动时缺失 directory 为空；缺失 file、逃逸路径和坏入口明确失败。Vite 运行时删除已经观察的 file 会撤回其定义。
声明指向的文件或目录根、以及 include 命中的入口必须是普通文件/目录，符号链接以 `TypeError`、`code: 'PLUGIN_SOURCE_SYMLINK'` 拒绝并附 `file` 位置；不遍历目录中的符号链接子目录。父级目录可以是别名，执行入口在打开来源时固定其真实路径。
Vite 会话打开后新建父目录别名或重定向其真实路径，会以 `PLUGIN_SOURCE_PATH_CHANGED` 拒绝；恢复原路径或重启 Vite 应用会话后再接纳，普通 Host replacement 不重新绑定观察路径。

原生 `runHostApplication()` 在一次启动中扫描预编译 `.js/.mjs`，与固定 imports 合并后启动。当前进程不响应后续新增、改写或删除，发布在**新进程下次启动**生效。它不编译 TS，也不启动 Vite。

Vite 开发和生产均持续接纳来源发布，普通 ESM 传递依赖属于同一个 runner 图；CommonJS、原生模块及显式 singleton 保留 Node 缓存边界。入口进入 catalog 与 Plugin 启动是独立事实。
显式设置 `CHOKIDAR_USEPOLLING` / `CHOKIDAR_INTERVAL` 时需符合固定观察策略；冲突会拒绝并给出所需值，规则见[来源观察与关闭](https://github.com/PluxelJS/pluxel/blob/main/engineering/HMR.md#来源发现与资源所有权)。

producer 在副作用前验证声明：

```ts no-twoslash
import { requirePluginSource } from '@pluxel/host/sources'

const policy = requirePluginSource(ctx, {
	kind: 'directory',
	path: entriesDir,
	include: ['*.mjs'],
})
// policy.updates 是 'next-start' 或 'live'；缺失/不匹配会抛 SOURCE_REQUIRED / SOURCE_NOT_DECLARED。
```

`createHost()` 只接收已求值插件与服务；扫描和持续更新分别归上述执行入口。

## Vite 生产

在一个新的 `NODE_ENV=production` 进程中，显式选已有配置文件；唯一应用 entry 仍写在该文件的 `host()` / `vitePreset()` 中：

```ts no-twoslash
// vite.runtime.config.ts；与启动脚本放在同一目录
import { defineConfig } from 'vite'
import { vitePreset } from '@pluxel/services/vite'

export default defineConfig({
	root: import.meta.dirname,
	plugins: [vitePreset({ entry: 'dist/app.mjs' })],
})
```

```ts no-twoslash
// start-vite.mjs
import { runViteApplication } from '@pluxel/host-vite/run'

const session = await runViteApplication({
	root: import.meta.dirname,
	configFile: './vite.runtime.config.ts',
})
const shutdown = () => {
	void session.close().catch((error) => {
		process.exitCode = 1
		console.error(error)
	})
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
```

未设置 NODE_ENV 时入口会设置 production；development/test 进程会被拒绝。入口强制 production conditions、middleware mode 和关闭浏览器 HMR，启动 promise 等待目录、制品、Host 报告和已安装 listener。Plugin init issue 保留在启动报告中；装配或硬前提失败会关闭整个会话并抛错。

`vitePreset()` 的 HTTP 服务拥有独立业务 listener；生产没有 Vite 公共中间件、dev console 或 source Shell。配置中启用 devConsole/source Shell 会拒绝启动。`close()` 或 signal abort 停止接纳、排空已接纳更新并释放 watcher/listener。清理失败仍继续释放其余资源，`close()` 拒绝并保留原始失败；重复调用返回同一关闭结果。不要将开发前端配置直接用作生产配置；create 模板提供独立示例。

执行 `root` 必须是绝对路径；配置中另有 `root` 时必须指向同一目录。应用的相对来源和数据路径以 `startup.root` 为基准；开发前端 root 与生产应用 root 可能不同。需要共享已有数据时显式设置同一个绝对 `PLUXEL_DATA_ROOT`。

选择 Vite 生产部署时，直接使用的 `@pluxel/host-vite`、`vite` 以及配置 imports 必须声明为应用的 `dependencies`。选择 native 部署时，这些执行工具留在 `devDependencies`，生产安装不需要它们。

## 配置环境变量

`@pluxel/host/environment` 提供 `env`、`hostEnv`、`resolveHostEnv(input)`。显式参数用于根据本次 startup 环境解析，不依赖修改 `process.env`。

| 变量                                    | 含义                                                     |
| --------------------------------------- | -------------------------------------------------------- |
| `PLUXEL_DATA_ROOT`                      | 数据目录默认值，省略为 `.pluxel`；应用决定子目录         |
| `PLUXEL_HOST_BIND` / `PLUXEL_HOST_PORT` | 物理 listener 地址与端口，分别优先于通用 `HOST` / `PORT` |
| `PLUXEL_WORKBENCH`                      | 由应用传给服务组合的页面开关                             |
| `HOST` / `PORT`                         | 通用监听输入；没有反向代理或公开 origin 时也生效         |
| `PLUXEL_PUBLIC_ORIGIN`                  | 显式 HTTP(S) 公开 origin，优先于 `PITCHFORK_URL`         |
| `PITCHFORK_URL`                         | Pitchfork 提供的公开 origin；未显式配置时自动采用        |

解析后的 `hostEnv.publicOrigin` 由 Vite 和 native listener 共同用于管理会话的浏览器同源校验，Vite 还用它打印公开访问地址；没有公开 origin 时使用监听 origin。它不改变物理监听地址、客户端地址或 TLS 判定，也不从 `Forwarded` / `X-Forwarded-*` 请求头推断。公开 origin 必须是 HTTP(S) origin，不含凭证、业务路径、查询参数或片段。开发代理的配置与排障见[工作区工具链](../development/workspace-toolchain.md#端口与公开地址)。

## 绑定部署环境与 JSON 文件

大多数插件只需 `configs.use(schema)`，通过 Workbench 或 Host 配置 API 设置值。只有部署系统负责提供固定值时，才在应用入口加绑定：环境变量使用 `envBinding`，挂载的 JSON 文件使用 `fileBinding`。两者都由 Host 在启动时读取。

应用解析在首次异步读取前捕获绑定的文件路径、namespace 和环境 mapping；读取期间修改原声明不会改变本次输入或来源记录。schema 保留原实例，不能借修改 schema 对象改变已声明的契约。

环境绑定从本次 `startup.env` 生成覆盖层，优先于保存值；该层不写入配置存储。

Plugin 需要导出传给 `configs.use()` 的同一个 schema：

```ts no-twoslash
// WorkerPlugin.ts
import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'

export const WorkerConfig = v.object({
	endpoint: v.pipe(v.string(), v.url()),
	http: v.object({
		enabled: v.optional(v.boolean(), true),
		timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 5_000),
	}),
})

@Plugin()
export class WorkerPlugin extends BasePlugin {
	private readonly config = this.configs.use(WorkerConfig)
}
```

应用入口 直接声明部署名称；不要在配置工厂中重复解析类型或拼装 Plugin address：

```ts no-twoslash
import { defineHostApplication, envBinding } from '@pluxel/host'
import { WorkerPlugin, WorkerConfig } from './WorkerPlugin.ts'

export default defineHostApplication(() => ({
	name: 'worker-app',
	plugins: [WorkerPlugin],
	envBindings: [
		envBinding(WorkerPlugin, {
			config: {
				schema: WorkerConfig,
				mapping: {
					endpoint: 'WORKER_ENDPOINT',
					http: { enabled: 'WORKER_HTTP_ENABLED', timeoutMs: 'WORKER_HTTP_TIMEOUT_MS' },
				},
			},
		}),
	],
}))
```

插件不声明静态 schema 字段。宿主导入传给 `configs.use()` 的同一个 Valibot schema 值，`envBinding` 根据 `schema` 推导 `mapping` 的输入字段；Host 启动时核对它与插件的配置声明一致。`envBinding` 和 `fileBinding` 都要求 Valibot schema，普通 Standard Schema 实现不能用于这两个绑定。这里只复用定义，不复制 schema。普通静态配置可用 `satisfies`；`defineHostApplication` 保留启动上下文，绑定 helper 提供字段之间的类型推导。

Mapping 从 schema input 推导：object 可展开，也可绑定一个 JSON 变量；array、tuple 与动态 record 使用完整 JSON。环境名称匹配 `[A-Z_][A-Z0-9_]*`。string 保留原文，number 要求有限 JSON number，boolean 只接受 `true`/`false`，复合类型使用 JSON。config 环境缺失不生成覆盖，空字符串和 `null` 按 schema 校验；诊断不包含输入值。

配置优先级为：

```text
configRecords.initial < fileBindings config < saved config < envBindings config
```

对象递归合并，数组整体替换。持久文件只保存管理界面或 Host API 修改的层；基础值、schema 默认值和 env 覆盖不会被复制进去。移除 env 后，下一次启动重新显示 saved 或基础值。reset 删除 saved 值，重新显示基础值。

被 env 控制的路径及其祖先、后代拒绝修改和 reset，包括提交相同值。Workbench 显示来源并禁用对应字段；Host 返回的 `sources` 只有路径、来源种类、名称和只读状态，不含凭据。未绑定的兄弟字段仍可编辑。

JSON 文件通过 `fileBindings: [fileBinding(WorkerPlugin, { config: { schema: WorkerConfig, path: './worker.json' } })]` 提供基础值（`fileBinding` 从 `@pluxel/host` 导入），路径相对 `startup.root`。文件只在启动时读取，不由构建读取或打包。修改文件或 env 需要重新创建 Host。

部署凭据不放在普通 config。需要从环境变量或挂载文件提供凭据时，按 [Vault 部署绑定](#部署凭据)声明只读记录；需要交互登录或刷新凭据时，使用可写 Vault。

应用生产构建 从同一声明生成 `.env.example`，只输出说明和注释状态的空 placeholder，不读取构建机环境或复制 schema default。`envBindings` 使用 direct array literal，每项调用从 `@pluxel/host` 导入的 `envBinding`，第一个参数是静态目录中的 Plugin 标识符，第二个参数直接声明 `config`/`vault` 与其 `schema`、`mapping`；mapping 使用对象树和字符串 literal。动态分支不作为构建期来源清单。

直接消费 runtime control-plane `ConfigResult` 时按 discriminant 处理返回值：query 返回 `config` 和 `defaults`，并标记
`saved: false`；成功 mutation 返回已持久化的 `config`、`application` 与 apply report，不再重复返回 defaults。
`validation_failed` 只有在 defaults 可以独立计算时才带可选 `defaults`。持久化失败不会发布 staged revision，也不会把未确认的值注入
Plugin generation。

## 选择文件后端

在 `config.storage` 中使用 `zenfs(nativeConfig)`（`@pluxel/core/config`）。它沿用 ZenFS 原生配置与 `mounts`，Plugin 文件、TinyBase 状态与 Host 私有文档共用每个 Core 的独立挂载表。helper 验证并快照声明、正规化挂载路径，省略根挂载时补 InMemory；不打开后端或等待 ready。Core 也接受原生 `FsConfig`，可直接组合上游 Backend、嵌套 BackendConfiguration 和已打开的 FileSystem。

| 场景               | 原生挂载配置                                                          |
| ------------------ | --------------------------------------------------------------------- |
| 隔离测试、临时数据 | `{ mounts: { '/': InMemory } }`                                       |
| Node 持久目录      | `{ mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } } }` |
| 浏览器持久数据     | `{ mounts: { '/': { backend: IndexedDB, storeName: 'my-app' } } }`    |

`@pluxel/core/fs` 提供 InMemory、Passthrough 和常用原生类型，IndexedDB 从 `/fs/browser` 导入。也可以直接导入其他 ZenFS Backend。配置创建的实例由 Core 关闭；直接传入的 FileSystem 是借用资源，由应用在所有借用 Host 关闭后释放。同一份 backend 配置可为多个 Host 各创建新实例。

Passthrough 接收完整 `node:fs`，目录须由应用显式准备；Core 不替上游更改 prefix 行为。例如独立 Node Host：

```ts
import { zenfs } from '@pluxel/core/config'
import * as nativeFs from 'node:fs'
import { resolve } from 'node:path'
import { createHost } from '@pluxel/host'
import { Passthrough } from '@pluxel/core/fs'

const prefix = resolve('./data/fs')
await nativeFs.promises.mkdir(prefix, { recursive: true })
const host = await createHost({
	plugins: [],
	config: {
		storage: zenfs({
			mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
			durableMounts: ['/'],
		}),
	},
})
try {
	await host.start()
} finally {
	await host.close()
}
```

可以再挂载 `'/tmp': InMemory`、应用的自定义 Backend 或借用的 FileSystem；backend 的 options、嵌套组合和错误沿用 ZenFS。浏览器的 `storeName` 使用稳定部署 profile，页面或 Worker 结束前等待 `host.close()`。

`durableMounts` 是应用对确切挂载点可跨启动保存的声明，默认空数组；需要持久保证的插件会据此检查。自定义后端不能仅凭名称推断持久性，嵌套挂载也不会自动继承父挂载声明。这不增加磁盘 fsync 保证。

`readOnly`、uid/gid、defaultDirectories 等保留原生配置。`log`、`disableAccessChecks`、`resolveFullWalk` 修改 ZenFS 模块全局状态，无法逐 Host 隔离；固定版本未实现的 `onlySyncOnClose` 也不接纳。插件目录与资源边界见[文件存储](../plugin-development/fs.md#目录与资源所有权)。

## 保存配置和运行策略

Host 分别通过 `configRecords` 与 `state` 指定启动值，默认使用 Core 内建 TinyBase 的私有文档。不需要手工配置文档适配或安装存储服务；是否跨 Host 保留取决于同一项 `config.storage`：

```ts twoslash
import { zenfs } from '@pluxel/core/config'
import { createHost } from '@pluxel/host'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import * as nativeFs from 'node:fs'
import { resolve } from 'node:path'
import { Passthrough } from '@pluxel/core/fs'
import * as v from 'valibot'

@Plugin()
class MyPlugin extends BasePlugin {
	private readonly config = this.configs.use(v.object({ endpoint: v.pipe(v.string(), v.url()) }))

	endpoint(): string {
		return this.config.endpoint
	}
}

const owner = pluginNodeAddressOf(MyPlugin)
const prefix = resolve('./data/fs')
await nativeFs.promises.mkdir(prefix, { recursive: true })

const host = await createHost({
	plugins: [MyPlugin],
	config: {
		storage: zenfs({
			mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
			durableMounts: ['/'],
		}),
	},
	configRecords: {
		initial: [{ owner, config: { endpoint: 'https://example.com' } }],
	},
	state: {
		initial: { autoStart: [owner] },
	},
})
try {
	await host.start()
} finally {
	await host.close()
}
```

默认 `mode: 'writable'`；使用 `mode: 'memory'` 可为该领域显式选择临时状态。`mode: 'readonly'` 读取已有文档并拒绝写入，文档不存在时保留 `initial` 且不创建文件。已有文档优先于启动种子，Host 返回前会完成两个存储的准备。配置保留 v3、运行策略保留 v5 文档格式，不在应用重新打包时覆盖已有数据。

只读配置直接设置 `configRecords: { mode: 'readonly' }`，只读运行策略设置 `state: { mode: 'readonly' }`，均无需提供 storage factory。整个数据后端只读时，同时设置 `config.storage.readOnly: true`；文档模式控制对应领域的管理写入，FS 的只读选择控制实际文件写入。

嵌入宿主可在 `configRecords.storage` 或 `state.storage` 提供同步 `(root) => HostDocumentStorage` factory，借用已有应用适配；不转交 backend 所有权。factory 在 root 创建后、文档 IO 前解析一次，异步 factory 和直接对象会被拒绝。普通应用省略这些 factory，使用内建文档。

文档存储只在完整原子提交后确认成功；只有缺失返回 `undefined`。`HostDocumentStorage` 仅需 `getText(key)`、`put(key, text)` 和 `stat(key)`，`put()` 不接受 atomic 选项。每次写入先保存候选，再切换已确认读视图，同一 namespace 的并发写入串行处理。

Host 关闭先排空配置、策略和服务写入，再排空 Core TinyBase 并关闭 Core FS；外部借用适配的 backend 仍由应用关闭。关闭会报告 flush 失败，不能用“请求已入队”冒充写入成功。

## 跨实例同步保存配置

同一应用部署需要共享管理保存的配置时，在 `HostApplication` 或 `createHost()` 中显式提供 `configSync`，选择一个 writer 和多个 replica。同步范围只有 saved config；env/file 基础值、Vault、运行策略、插件 TinyBase Store 和业务文件仍归各实例。副本通过本地 env 形成自己的有效配置，不把环境覆盖发回 writer。

两个角色必须使用同一 `scope` 和真实部署制品的 `artifact: { name, catalogHash }`。官方静态与 Node 模块启动入口将 manifest 中的 application 事实放入 `startup.deployment.application`，并核对配置中的 artifact。嵌入式 `createHost()` 由部署者提供同一事实，不能用随意生成的名称或 hash 绕过接纳。以下类型完整的配置片段接收部署已提供的 artifact、连接地址与凭据：

```ts twoslash
import type { HostConfigArtifact, HostConfigSyncOptions } from '@pluxel/host'

export function synchronization(
	artifact: HostConfigArtifact,
	url: string,
	token: string,
): { writer: HostConfigSyncOptions; replica: HostConfigSyncOptions } {
	return {
		writer: {
			role: 'writer',
			scope: 'production',
			artifact,
			identity: 'primary',
			replicas: [{ identity: 'secondary', token }],
		},
		replica: {
			role: 'replica',
			scope: 'production',
			artifact,
			identity: 'secondary',
			writer: 'primary',
			url,
			token,
		},
	}
}
```

分别把 `writer` 或 `replica` 赋给对应 Host 的 `configSync`。凭据由部署预配，每个副本使用自己的 identity/token；token 不进入保存配置正文。writer 的 `host.configSync.fetch(request)` 是 Fetch handler，由宿主挂到自己的 HTTP/TLS listener；它不会自行监听端口，也不通过业务 Plugin 路由决定可用性。副本请求使用 Bearer token 和 `X-Pluxel-Config-Replica`，Host 管理连接、最长 20 秒的版本 long poll 和关闭取消；应用无需另写轮询任务。

writer 的 `host.config.get(owner)` 与 `host.config.status()` 返回 `{ history, seq }` 版本。patch/reset 必须通过 options.expected 原样回传草稿读取时的版本；缺失或过期返回 `version_conflict / state: unchanged`。编辑器应保留草稿并让用户核对冲突，不读取最新版本后自动重新提交。Management 与 Workbench 使用同一版本检查；副本的管理配置为只读，删除 fork 也会在停止 Plugin 前拒绝。副本文件后端仍需可写，以原子保存已接纳的同步快照。

副本启动先完整校验已有缓存；缓存有效时可离线启动，没有缓存时必须先获取、校验并保存首份快照，然后才能首次接纳 Plugin。连接失败不会写出默认空配置。后续快照先校验所有当前可用 owner 的完整有效配置、原子保存，再发布和通知；未知 owner 保留原文并列为 unavailable，后续真实接纳时再校验，不自动创建 fork 或启动插件。通知失败仍是已保存但未应用，可沿既有 listener/restart 路径恢复。

`host.configSync.status()` 分别报告 `sourceVersion`、`savedVersion`、`connection`、`error` 和 `unavailable`，连接成功不能代替本地保存成功。启用同步后，`config.json` 使用 v4 外层封装，原 v3 saved body 与 history/seq 在同一份文档中原子保存；关闭不会重试未知结果的失败写入。旧 v3 文档启用同步前需要显式转换，运行时拒绝格式不符的文档。各实例使用独立数据目录；多个 writer 共写同一目录或自动选主不在此契约内。

Host 应用解析器从本次 `startup.env` 读取显式 `envBindings`，文件输入来自 `fileBindings`。普通配置优先级为基础对象/文件 < 管理保存值 < env，合并后由 schema 校验；env 控制的路径只读且不落盘。Vault env/file 绑定是整记录只读。底层 `createHost()` 不隐式读取进程环境。

## 选择后端

可写 Vault 使用加密后端，文件位置沿用 Host 的 Core 存储配置：

```ts no-twoslash
import { defineHostApplication } from '@pluxel/host'
import { vault } from '@pluxel/services/vault'

export default defineHostApplication((startup) => ({
	plugins: [],
	services: [vault({ deployIdentity: startup.env.PLUXEL_VAULT_DEPLOY_IDENTITY })],
}))
```

只有部署凭据时选择 `vault({ backend: 'bindings' })`。它不打开 FS，不创建密钥或磁盘文件；没有绑定的记录不存在，所有写入拒绝。`servicesPreset(startup, options)` 显式从该 startup 环境读取部署解锁身份，`options.vault` 可以覆盖后端和部署解锁身份。直接 `vault()` 不读取进程环境。

## 部署凭据

宿主在应用工厂中通过 `envBindings` 或 `fileBindings` 用 `envBinding` / `fileBinding` 把导出的凭据根 schema 绑定到输入。Host 先完成 schema 校验、准备服务，再安装绑定，最后启动插件。见[应用入口](./configuration.md)。

```ts no-twoslash
import { defineHostApplication, envBinding } from '@pluxel/host'
import * as v from 'valibot'
import { MyPlugin } from './MyPlugin.ts'

const Credentials = v.object({ primary: v.object({ token: v.string() }) })

export default defineHostApplication(() => ({
	plugins: [MyPlugin],
	envBindings: [
		envBinding(MyPlugin, {
			vault: { schema: Credentials, mapping: { primary: { token: 'APP_TOKEN' } } },
		}),
	],
}))
```

若凭据由挂载的 JSON 文件提供，则在同一个应用入口中用 `fileBindings: [fileBinding(MyPlugin, { vault: { schema: Credentials, paths: { primary: './credentials.json' } } })]` 替换上面的 `envBindings`。同一记录只能绑定一个来源。

显式绑定的 env/file 是整条只读记录，绝不与已存 KV 拼接。缺失输入不会偷偷回退到旧凭据；移除绑定后才重新读取持久记录。部署输入不写入加密 snapshot。

导出的凭据根 schema 使用 `v.object({ primary: CredentialSchema })` 声明固定记录，或 `v.record(KeySchema, CredentialSchema)` 声明账号记录。宿主显式导入这个 schema，传给绑定的 `vault.schema`，在 `mapping` / `paths` 中填写记录 key 和环境名/JSON 路径。它是本次 Host 的部署入口契约，修改它需要重新创建 Host；Plugin 热替换不会自动替换该契约。私有 KV 的写入仍由业务用例校验，不会自动成为部署入口。每个明确映射的环境名都必须存在；schema 的 optional 字段可以不映射。

## 密钥与备份

Vault snapshot 使用 version 2，包含结构化 KV 与每条记录的 revision；不支持的版本或缺少 revision 时启动失败。

加密后端使用 `global/keys.age` 包装数据密钥，`global/state.enc` 保存记录，`global/blobs/` 保存独立 blob。`security/identity.json` 保存宿主身份。已有仓库无法解锁、损坏或缺失 snapshot 时启动失败，不作为空仓库覆盖。

Root 通过 `VaultAdmin` 管理解锁、宿主密钥和部署 recipients。`rekey()` 原子重写密钥 envelope，数据密钥与密文内容保持；失败保留先前可用数据。部署私钥由宿主显式输入，不放入 Plugin config、日志或 UI。

备份与回滚应在 Host 停止后整体复制 FS 的 `services/vault/` 目录：包括 `security/identity.json`、`global/keys.age`、`global/state.enc` 和 `global/blobs/`。不要分别恢复不匹配的 key envelope 与数据文件；不支持跨进程 writer 或跨 config/Vault 事务。

## 可选管理页面与服务配套插件

Vault 管理页由同一个服务包的 `@pluxel/services/plugins` 入口提供，不需要额外安装 UI 插件包。
`VaultAdminPlugin` 是普通 Plugin：它使用 Vault 能力并发布 Workbench 页面，管理操作仍通过 Management 的已认证会话执行。

```ts no-twoslash
import { zenfs } from '@pluxel/core/config'
import { pluginNodeAddressOf } from '@pluxel/core'
import { defineHostApplication } from '@pluxel/host'
import * as nativeFs from 'node:fs'
import { resolve } from 'node:path'
import { servicesPreset } from '@pluxel/services/preset'
import { Passthrough } from '@pluxel/core/fs'
import { VaultAdminPlugin } from '@pluxel/services/plugins'

export default defineHostApplication(async (startup) => {
	const prefix = resolve(startup.root, '.pluxel/fs')
	await nativeFs.promises.mkdir(prefix, { recursive: true })
	return {
		name: 'vault-example',
		config: {
			storage: zenfs({
				mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
				durableMounts: ['/'],
			}),
		},
		services: await servicesPreset(startup, {}),
		plugins: [VaultAdminPlugin],
		state: { initial: { autoStart: [pluginNodeAddressOf(VaultAdminPlugin)] } },
	}
})
```

在正常 Host 开发或生产入口启动应用后，登录 Workbench 即可访问 Vault 页面。缺少 Vault 服务时插件启动失败；关闭 Workbench 时不发布页面，Vault 服务仍独立运行。页面撤回随 Plugin 停止，后端资源随 Host 服务关闭，不建立第二套生命周期。

第三方服务可以采用同样的结构：服务入口负责业务能力，一个显式 `./plugins` 导出集中提供可选配套 Plugin；应用选择服务、插件与启动策略。基础服务入口不导入 `/plugins`，页面组件不在服务器入口求值。同一个 Plugin 只从一个公开入口具名导出，不能再从根入口重复转发。包内路径、构建和测试示例见 `packages/services/src/plugins.ts` 与 `packages/services/tests/vault-plugin.test.ts`。

## Host logging

在 `config.logger` 中使用 `@pluxel/core/config` 的 `logtape(nativeConfig, options)`。它接收 LogTape 原生 `Config`：`sinks` 填原生 sink，`filters`、`loggers`、`parentSinks`、`captureSourceLocation` 和 `contextLocalStorage` 沿用上游语义，formatter 由 sink 自己选择。

```ts
import { getConsoleSink, getJsonLinesFormatter, type Config } from '@logtape/logtape'
import { logtape } from '@pluxel/core/config'
import { createHost } from '@pluxel/host'

const nativeConfig = {
	sinks: { console: getConsoleSink({ formatter: getJsonLinesFormatter() }) },
	loggers: [
		{ category: ['pluxel'], sinks: ['console'], lowestLevel: 'trace' },
		{ category: ['pluxel', 'runtime'], lowestLevel: 'info' },
		{ category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'warning' },
	],
} satisfies Config<'console', string>

const host = await createHost({
	plugins: [],
	config: {
		logger: logtape(nativeConfig, { profile: 'production', debugTopics: ['cache:lookup'] }),
	},
})
try {
	host.ctx.logger.info('Host ready')
} finally {
	await host.close()
}
```

`options` 只描述 Pluxel 自己拥有的 policy 命名空间、`initialPluginPolicy`、`debugTopics`、`policyLoadFailure` 与借用的 `policyStore`；rootId 由 Core 固定，不由日志属性或 native category 配置改写。普通应用 category 也可直接加入 `loggers`。插件 category 使用可逆 node address，框架会在原生 filter 之前检查 active root、插件动态 policy 和 debug topic。

`loggers` 的级别与 filter 仍是宿主静态门槛。需要 Workbench 调低某个插件等级时，把接收插件日志的 logger 保持在 `trace`；动态 policy 不会越过原生的门槛。子 logger 的 `filters` 替换继承、`parentSinks: 'inherit' | 'override' | 'forward'` 均保留。完整配置见 [LogTape Configuration](https://logtape.org/manual/config)，格式与输出见 [Sinks](https://logtape.org/manual/sinks)。

`logtape()` 提供可选的默认预设：易读 console、按 `info` 过滤的终端输出，以及接收 `trace` 的有界 Workbench store。自定义配置完整替换默认输出；静默且保留 policy manager 时使用 `logtape({ sinks: {}, loggers: [] })`。省略 `config.logger` 不安装进程日志配置，`ctx.logger` 仍可调用。`servicesPreset()` 只组合服务，不安装日志；应用和 starter 在自己的 `config.logger` 中明确选择输出。

已有 foreign LogTape installation 会使配置了 logger 的 Host 准备失败；`reset: true` 也会被明确拒绝。不要在同一进程额外调用全局 `configure()`/`reset()` 接管 Core 的安装。关闭只释放本 root 安装的配置，发现外部替换时报告错误并保留它。

### 隐式上下文与原生资源

需要跨 `await` 关联请求时，直接在原生配置中传入运行时适用的 `contextLocalStorage`，再使用 LogTape 的 `withContext()`：

```ts
import { AsyncLocalStorage } from 'node:async_hooks'
import { getConsoleSink, withContext } from '@logtape/logtape'
import { logtape } from '@pluxel/core/config'
import { createHost } from '@pluxel/host'

const host = await createHost({
	plugins: [],
	config: {
		logger: logtape({
			contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
			sinks: { console: getConsoleSink() },
			loggers: [{ category: ['pluxel'], sinks: ['console'], lowestLevel: 'info' }],
		}),
	},
})
try {
	await withContext({ requestId: 'request-42' }, async () => {
		await Promise.resolve()
		host.ctx.logger.info('request completed')
	})
} finally {
	await host.close()
}
```

传入的 sink、filter、formatter 和 context storage 保持原对象。LogTape 处理 `Symbol.dispose`/`Symbol.asyncDispose`；Core 在插件停止并输出关闭日志后等待它们释放。配置了 logger 的 root 可通过 `ctx.require(Logging)`（`@pluxel/core/logging`）读取 manager；`await logging.flush()` 刷新 store/policy，并等待提供原生 `drain()` 的 sink。它不把任何后端的接纳改成远端送达确认，自定义 sink 的投递、重试与资源语义仍由该 sink 决定。

## 远程输出：原生 LogTape sink

直接把 `@logtape/otel` 的 sink 放进原生 `sinks`。应用按需安装 exporter；Pluxel 默认不加载网络输出：

```sh
vp add @logtape/otel@^2.4.2 @opentelemetry/sdk-logs@^0.222.0 @opentelemetry/resources@^2.11.0 @opentelemetry/exporter-logs-otlp-proto@^0.222.0
```

在启动环境中设置完整的 logs endpoint；VictoriaLogs 示例：

```sh
OTEL_SERVICE_NAME=orders
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://victorialogs:9428/insert/opentelemetry/v1/logs
```

下面使用原生批量 processor 与 HTTP/protobuf exporter。认证、超时沿用 exporter 的标准 `OTEL_EXPORTER_OTLP_LOGS_HEADERS`、`OTEL_EXPORTER_OTLP_LOGS_TIMEOUT` 环境变量。

```ts no-twoslash
import { getConsoleSink, getJsonLinesFormatter } from '@logtape/logtape'
import { getOpenTelemetrySink } from '@logtape/otel'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import { logtape } from '@pluxel/core/config'
import { createHost } from '@pluxel/host'

const endpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
if (!endpoint) throw new Error('Set OTEL_EXPORTER_OTLP_LOGS_ENDPOINT before enabling remote logs')

const provider = new LoggerProvider({
	resource: resourceFromAttributes({
		'service.name': process.env.OTEL_SERVICE_NAME ?? 'pluxel-app',
	}),
	processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: endpoint }) })],
})
const sink = getOpenTelemetrySink({ loggerProvider: provider, diagnostics: true })
const host = await createHost({
	plugins: [],
	config: {
		logger: logtape(
			({ createRuntimeLogSink }) => ({
				sinks: {
					remote: sink,
					console: getConsoleSink({ formatter: getJsonLinesFormatter() }),
					memory: createRuntimeLogSink(),
				},
				loggers: [
					{ category: ['pluxel'], sinks: ['remote', 'memory'], lowestLevel: 'trace' },
					{ category: ['pluxel', 'runtime'], lowestLevel: 'info' },
					{ category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'warning' },
				],
			}),
			{ profile: 'production' },
		),
	},
}).catch(async (error: unknown) => {
	// Also cover failures before Core takes ownership; SDK shutdown is idempotent.
	const [cleanup] = await Promise.allSettled([provider.shutdown()])
	if (cleanup.status === 'rejected') {
		throw new AggregateError(
			[error, cleanup.reason],
			'Host setup and log provider shutdown failed',
			{
				cause: error,
			},
		)
	}
	throw error
})
try {
	host.ctx.logger.info('Host ready')
} finally {
	await host.close()
}
```

`memory` 保留 Workbench/开发控制台的有界查询；`diagnostics: true` 把进程级 OTel SDK diagnostics 接入 LogTape。meta logger 独立输出到本地，避免回送远程 sink。

- 每个配置了日志的 root 创建独立 sink/provider。LogTape async disposal 也会 shutdown 传入的 provider，不要传入其他组件仍在使用的共享 provider。
- 需要立即发送 OTel 批次时使用原生 `await provider.forceFlush()`。这个 sink 没有原生 `drain()`，所以 manager 的 `flush()` 不替代 provider 的 flush。队列、超时、重试与丢弃遵循 OTel SDK，没有持久队列或无损交付保证。
- 原生 sink 保留 category 和结构化属性，默认把 Error 投影为 OTel exception 属性；需要 cause/自定义字段时使用上游 `exceptionAttributes: 'raw'`。后端 stream 使用稳定 service/deployment 属性，不使用每次启动变化的 rootId 或 request ID。
- 本方案不依赖 `@pluxel/plugin-otel` Plugin；该 Plugin 的 telemetry logger 与 `ctx.logger` 是不同入口。

更多参数直接查 [LogTape OTel sink](https://logtape.org/sinks/otel) 和 [OTel SDK](https://open-telemetry.github.io/opentelemetry-js/modules/_opentelemetry_sdk-logs.html)。已有采集器时可选择原生 JSON console 或 JSONL file sink，不必经过网络 exporter。

## 独立 Logging Host

Workbench store 需要绑定当前 manager 的 registry，所以使用同步 factory；它在 Core 准备期间求值一次。其余配置仍是原生 `Config`，也可直接组合 LogTape 的 `withFilter()` 等函数。factory 的 `rootId` 可用于精确匹配当前 root；`createRuntimeLogSink()` 只能在 factory 求值期间调用。

```ts
import { logtape } from '@pluxel/core/config'
import { Logging } from '@pluxel/core/logging'
import { createHost } from '@pluxel/host'

const host = await createHost({
	plugins: [],
	config: {
		logger: logtape(
			({ createRuntimeLogSink }) => ({
				sinks: { memory: createRuntimeLogSink({ windowLines: 50_000 }) },
				loggers: [
					{ category: ['pluxel'], sinks: ['memory'], lowestLevel: 'trace' },
					{ category: ['logtape', 'meta'], lowestLevel: null },
				],
			}),
			{ profile: 'application' },
		),
	},
})
try {
	host.ctx.logger.info('Host ready')
	const logging = host.ctx.require(Logging)
	logging.flushStores()
	const recent = logging.stores.getOrCreate('default').tailWindow(100)
} finally {
	await host.close()
}
```

日志查询和 policy 属于所选 Core root 的 manager，不依赖 Services 或 Management。policy 默认通过 Core 私有文档保存，沿用 `config.storage` 后端。省略后端时使用 InMemory；持久后端会恢复同一 profile 的 policy。`logtape(nativeConfig, { policyStore })` 可提供同步 root factory，返回借用的 `PluginLogPolicyStore`，不转交后端所有权。

删除 fork 会在同一 Host 队列内清理日志 policy；保存失败时保留 fork。TinyBase 文档 writer 故障后阻断后续保存，关闭并检查实际 backing 后再恢复 Host。同一进程只允许一个配置了日志的活动 root；其他未配置 logger 的 Host 不安装进程日志 owner。

### 宿主安装与访问

Core 负责安装、绑定和关闭进程日志 owner。宿主或控制台从 `@pluxel/core/logging` 导入 `Logging`，通过 `host.ctx.require(Logging)` 或 `dev.ctx.require(Logging)` 访问这一个 manager；省略 `config.logger` 时不提供这个 token。控制台查询不创建第二个日志 owner。

## 在 Workbench 查看与归档

Workbench 使用同一份有界日志存储，通过已认证的 Management 会话查询与 follow，不增加 HTTP/SSE 日志 API。
日志携带 node address、reference 和可读标签；range 按传输预算分页，超大单条记录明确标记 payload 截断。
需要进程外归档时配置 file 或 OpenTelemetry sink；Plugin 的业务 HTTP 不负责暴露宿主日志。

## 独立 HTTP Host

安装 `@pluxel/services` 与 `elysia@2.0.0-rc.0`；Elysia 是 HTTP 服务的可选 peer，不会随其他服务安装。

当前 Elysia 已通过 TypeBox 1.4.2 的发布前 schema 编译回归；生成项目通过 catalog 统一版本。

`elysia()` 安装 generation-scoped Elysia application；生产 Node 接线统一使用 srvx。
`listenElysia()` 直接接收原生 [srvx ServerOptions](https://srvx.h3.dev/guide/options)，包括 TLS、Node server options、middleware、plugins、trustProxy、body limit 和 error handler。Host 拥有请求分发、启动时机和关闭，故不接受 `fetch`、`manual`、`gracefulShutdown`；这些字段在资源获取前拒绝。
可选 `publicDir` 在创建 listener 时固定（相对路径以当时 cwd 解析），只在非保留路径的业务 404 后服务编译资源和 SPA fallback。

```ts no-twoslash
import { createHost } from '@pluxel/host'
import { elysia } from '@pluxel/services/elysia'
import { listenElysia } from '@pluxel/services/elysia/node'

const host = await createHost({ plugins: [MyRoutes], services: [elysia()] })
await host.startNode(MyRoutesAddress)
const listener = await listenElysia(host, {
	hostname: '127.0.0.1',
	port: 3000,
	node: { keepAliveTimeout: 5_000 },
	maxRequestBodySize: 1024 * 1024,
})
// 应用结束时关闭 listener 与 Host。
await listener.close()
```

需要 IPC、自定义启动/关闭或独立 transport 时，使用 `/elysia` 的 `createElysiaHandler(host)` 与原生 srvx；调用者负责关闭 server 与 Host。TCP helper 不接受 `node.path/handle/fd`，因为返回值和 carrier metadata 需要实际 TCP 地址。

```ts
import { createHost } from '@pluxel/host'
import { createElysiaHandler, elysia } from '@pluxel/services/elysia'
import { serve } from 'srvx/node'

const host = await createHost({ plugins: [], services: [elysia()] })
try {
	const server = serve({
		fetch: createElysiaHandler(host),
		port: 0,
		gracefulShutdown: false,
	})
	try {
		await server.ready()
		// 运行应用；连接选项直接使用 srvx 原生配置。
	} finally {
		await server.close(true)
	}
} finally {
	await host.close()
}
```

`ElysiaApp` 仅供 Plugin/Part 使用。底层 directory、endpoint/fallback 和 carrier 接线属于框架内部，
不提供第二套公共 server API 或可替换 adapter。Management 与 Workbench 复用同一请求分发。

宿主拥有 listener、port、process shutdown 和物理 server policy，部署 ingress、反向代理或平台拥有 TLS。Plugin 调用 application 的 `listen()` / `stop()` 会立即
失败；`onStart()` / `onStop()` 也会立即失败，因为 Elysia 2 rc.0 尚未公开供外部 carrier 驱动的 attach/detach epoch。Plugin 也不
调用 Server view 的 `stop()`、`reload()`、`ref()` 或 `unref()`，不选择 srvx/runtime adapter。srvx 的接入属于宿主 carrier 工作，
不是 Plugin 的第二套 Web 作者 API。

handler 取得的 `server` 是 generation-scoped、carrier-backed view。`url`、`port`、`hostname` 和 `development` 反映当前宿主 listener；
`id` 是本 generation 内稳定的 virtual-server value，不是物理 listener identity。`server.url` 每次返回独立 `URL`，修改它不会重配
listener。Node carrier 还支持 `server.requestIP(request)` 读取该请求的远端 address、port 和 IP family；把其他来源或已经脱离当前
owner invocation 的 `Request` 传入会明确失败。

## Application-private database

应用也可以完全自管 SQL：把 schema、client、repositories、migration 和 connection lifecycle 放进普通 application-private package，例如 `@app/database`。这个 package 自己声明 ORM 和 driver dependency；不要只把依赖安装在 workspace root，再让子包隐式使用。与托管 Database 的选择及原生查询见[数据库与数据归属](../plugin-development/database.md)。

只选择自管 SQL 时，应用服务列表不安装 `database()`；误用 `ctx.require(Database)` 会直接失败。standalone 构建设置 `managedDatabaseDrivers: []`，移除托管后端的 driver 闭包，再用 `residualDependencies` 声明应用实际需要交付的 driver 与动态资源，见[应用交付](../development/distribution.md)。迁移资源也由应用明确发布，开发与生产构建不执行 SQL 迁移。

内置 Plugin 优先消费 repository 或 application service。只有确实需要构造查询时才暴露 ORM client；不要让每个 Plugin 各自读取 DSN、创建 pool 或运行 migration。

### 整个应用依赖数据库

如果没有数据库，整个应用 就没有可运行的核心功能，数据库是 host-owned root resource：应用 `prepare()` 必须在 Plugin graph 启动前完成连接、migration 和必要 preflight；失败直接终止本次 host startup。成功实例按 root Context 绑定，关闭登记到 root effects，不能归属任一 consumer Plugin。

Application package 导出接收 Context 的 typed accessor，不把数据库投影成 `ctx.database`，也不使用进程级 module singleton：

```ts no-twoslash
// @app/database — application-private server module
import type { Context } from '@pluxel/core'
import { openDatabase, migrate, type AppDatabase, type DatabaseOptions } from './internal.js'

const active = new WeakMap<object, AppDatabase>()

export async function prepareAppDatabase(ctx: Context, options: DatabaseOptions): Promise<void> {
	const root = ctx.root
	if (active.has(root)) return
	const database = await openDatabase(options)

	try {
		await migrate(database)
		active.set(root, database)
		root.effects.defer(
			async () => {
				if (active.get(root) === database) active.delete(root)
				await database.close()
			},
			{ tag: 'AppDatabase', phase: 'shutdown' },
		)
	} catch (error) {
		if (active.get(root) === database) active.delete(root)
		await database.close()
		throw error
	}
}

export function appDatabaseFor(ctx: Context): AppDatabase {
	const database = active.get(ctx.root)
	if (!database) throw new Error('Application database has not been prepared')
	return database
}
```

`appDatabaseFor(ctx)` 的参数既保留 root 隔离和完整返回类型，也在调用点诚实表达 application-private dependency。不要用 declaration merging 增加 `ctx.appDatabase`；应用声明的泛型不能反向改变独立编译 Plugin 的 Context shape。

应用入口统一决定部署路径，同时供宿主 FS 和 application database 使用：

```ts no-twoslash
import { zenfs } from '@pluxel/core/config'
import { resolve } from 'node:path'
import * as nativeFs from 'node:fs'
import { defineHostApplication } from '@pluxel/host'
import { prepareAppDatabase } from '@app/database'
import { standardServices } from '@pluxel/services'
import { Passthrough } from '@pluxel/core/fs'

function storagePaths({ env }) {
	// 部署时传入发行目录外的绝对路径。
	const root = resolve(env.APP_DATA_ROOT ?? './data')
	return {
		hostFiles: resolve(root, 'runtime'),
		applicationDatabase: resolve(root, 'application.sqlite'),
	}
}

export default defineHostApplication(async (startup) => {
	const prefix = storagePaths(startup).hostFiles
	await nativeFs.promises.mkdir(prefix, { recursive: true })
	return {
		name: 'application',
		plugins: [BillingPlugin, AuditPlugin],
		config: {
			storage: zenfs({
				mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
				durableMounts: ['/'],
			}),
		},
		services: standardServices(),
		async prepare({ host, startup }) {
			await prepareAppDatabase(host.ctx, {
				filename: storagePaths(startup).applicationDatabase,
			})
		},
	}
})
```

Plugin 在 `init()` 或之后同步取得已准备实例：

```ts no-twoslash
protected override init() {
	this.database = appDatabaseFor(this.ctx)
}
```

SQLite path、DSN、TLS 和 pool options 从 `startup.env`、`bindings` 或部署配置显式解析，不从 Context 猜测。FS 后端可能是 InMemory 或 IndexedDB，不保证存在原生 driver 可打开的磁盘目录。

`prepare()` 不是通用 service lifecycle：这里只表达“数据库是整个应用的硬 readiness 前提”。数据库 package 负责领域初始化，root effects 负责 acquisition rollback、正常 stop 和 shutdown；consumer replacement 不能关闭共享实例。

### 只有部分 Plugin 依赖数据库

如果数据库失败时无关 Plugin 仍应运行，把数据库建模为 application-private provider Plugin，并让 consumer 通过 constructor 声明 required dependency。provider 在 `init()` 打开和迁移数据库，并立即把关闭登记到自己的 effects；provider failure 只阻塞 dependents。不要同时保留 root `prepare()` 和 provider Plugin 两套所有权。

应用自行负责 migration 并发、连接恢复、备份、durability 和 shutdown。provider 的替换会关闭它持有的连接；consumer 不能缓存该连接跨越 provider 的生命周期。原生 driver 与目标数据库的行为由应用验证。

## 选择 native PostgreSQL 或 PGlite

`postgres()` 直接接收 [`pg.PoolConfig`](https://node-postgres.com/apis/pool)，`pglite()` 直接接收 [`PGliteOptions`](https://pglite.dev/docs/api#options)。参数名、连接来源和默认值由 driver 决定：PostgreSQL 可使用 `connectionString`、Unix socket、`PG*` 环境变量、异步 `password`、完整 `ssl` 和原生 pool 选项；PGlite 可使用 `extensions`、`fs`、`loadDataDir`、parser/serializer 与启动参数。无需连接字符串时也可以调用 `postgres()`；`pglite()` 省略配置使用上游的内存默认值。

```ts twoslash
import { createHost } from '@pluxel/host'
import { database } from '@pluxel/services/database'
import { postgres } from '@pluxel/services/database/postgres'

const host = await createHost({
	plugins: [],
	services: [
		database({
			backend: postgres({
				host: '/var/run/postgresql',
				database: 'app',
				user: 'app',
				max: 4,
				connectionTimeoutMillis: 5_000,
				application_name: 'app',
			}),
		}),
	],
})
try {
	// 启动使用托管 SQL 的 Plugin。
} finally {
	await host.close()
}
```

传入配置时，所选 driver 仍在第一次 Plugin 使用 Database 时才加载并创建资源；Host 在已接纳操作排空后关闭自己创建的资源。也可以传入已有的原生 `Pool` 或 `PGlite` 实例：`postgres(pool)` / `pglite(client)` 借用该实例，Host 排空后只撤下自己的 listener，不调用它的 `end()` / `close()`。应用负责让借用资源在 Host 生命周期内保持可用，并在所有使用者关闭后释放；不要在运行中改变借用 pool 的并发上限。PostgreSQL 调度并发读取原生 pool 的 `options.max`，PGlite 始终串行调度。

| 部署或验证目标                                     | Backend                |
| -------------------------------------------------- | ---------------------- |
| 正式部署、持续用户数据或多个 Plugin 频繁访问数据库 | native PostgreSQL      |
| 本机开发、自动化测试                               | PGlite                 |
| row lock、deadlock、pool exhaustion、连接中断      | 必须验证 native PG     |
| 多进程并发 migration、advisory lock 和故障恢复     | 必须验证 native PG     |
| throughput、latency、容量规划或生产硬件性能验收    | 必须使用目标 native PG |

PGlite 是执行真实 PostgreSQL 语义的本地 backend，不是 query mock；它适合快速验证 schema、migration、CRUD、owner isolation 和 Plugin lifecycle。但是 Pluxel 会把共享 PGlite 上的所有 database operation 串行调度，因此一个 host 中的 Plugin 会共同受到单连接吞吐上限影响。不要用 PGlite benchmark 推断 native PostgreSQL 性能。

PGlite 的 data directory 只为本机工作流提供正常关闭后的便利重启，不是部署存储承诺。Pluxel 不以补充 filesystem flush 或 fault-injection 测试的方式把它升级为 production baseline；需要正式部署时使用 native PostgreSQL。资源受限时，应在目标设备上调低 PostgreSQL connection/pool budget 并实测，而不是把 PGlite 带入部署。

连接字符串、TLS、pool 与 PGlite data directory 是 host startup policy，不是 Plugin config。Plugin schema/query 不根据 backend 分支。

## 生产构建

把构建选项保存在 `tsdown.config.ts`：

```ts no-twoslash
import { defineConfig } from 'vite-plus/pack'
import { pluxel } from '@pluxel/rolldown'

export default defineConfig({
	entry: './src/app.ts',
	plugins: [pluxel()],
})
```

在应用的 `vite.config.ts` 中导入这份配置并设置 `pack` 字段，然后运行 `vp pack`。已有开发配置时保留其他字段：

```ts no-twoslash
import { defineConfig } from 'vite-plus'
import pack from './tsdown.config'

export default defineConfig({ pack })
```

`@pluxel/rolldown` 的 `pluxel()` 统一构建官方与自定义服务组合。生产 bootstrap 通过 `@pluxel/host` 启动同一应用，HTTP handler/listener 属于 `@pluxel/services/elysia/*`。
`delivery` 独立选择交付边界：默认 `standalone` 内联框架和固定插件，`launcher` 可选 `node`、`fetch` 或 `host`，不能声明 sources。`modules` 编译本包模块、保留真实包 imports 与公开 Plugin identity，并导出应用工厂；它不自动启动，也不接受 launcher/residualDependencies。资源 `variant` 与服务安装是独立决定。

modules 同时支持 `package.json#imports`：本包目标进入编译，外部目标保留包依赖；搬移输出后不依赖原来的源码映射。

有 sources 的应用（包括 create 模板）使用：

```ts no-twoslash
export default defineConfig({
	entry: './src/app.ts',
	plugins: [pluxel({ delivery: 'modules' })],
})
```

默认应用入口为 `dist/app.mjs`。若用 tsdown 的 `outputOptions.entryFileNames` 自定义命名，保留 `.mjs` 扩展名，并让启动路径对应实际产物；输出的 `package.json` 的 `./app` export 与 `pluxel-deployment.json` 的 `server.entry` 会同步记录实际入口。

原生启动示例：

```ts no-twoslash
import { runHostApplication } from '@pluxel/host'
import { serviceSharedPackages } from '@pluxel/services/sources'

const host = await runHostApplication('./dist/app.mjs', {
	startup: { root: import.meta.dirname, mode: 'production', env: process.env, bindings: {} },
	sharedPackages: serviceSharedPackages,
})
let listener
try {
	const { listenElysia } = await import('@pluxel/services/elysia/node')
	listener = await listenElysia(host)
} catch (error) {
	const [cleanup] = await Promise.allSettled([host.close()])
	if (cleanup.status === 'rejected')
		throw new AggregateError([error, cleanup.reason], 'Listener startup and cleanup failed', {
			cause: error,
		})
	throw error
}
export const stop = listener.close
```

必须由全新 Node 进程的 launcher 在应用及其业务依赖闭包首次求值之前调用；服务运行入口也延后 import。入口先建立共享绑定，再加载默认工厂、固定 imports 和来源。已在 scope 外求值的 entry 与受控缓存中的绑定冲突会明确拒绝；Node 没有公开的 ESM cache 查询，不能证明此前普通依赖的完整闭包。预先导入这些依赖违反启动前置条件，不能事后重新绑定 token。

Core/Host 绑定启动器安装；`sharedPackages` 中的其他包相对 startup.root 解析，包括合法 exports，应用须声明所使用的共享包依赖。官方清单来自 `@pluxel/services/sources`，因此官方模板直接声明 Services、Workbench、Commands、Elysia、`@sinclair/typebox`、`typebox` 和 `exact-mirror`；不要依赖工作区 hoist 提供这些安装事实。实际安装版本及 importer 声明必须兼容，错误版本会拒绝；清单不安装服务。自定义服务可以追加包名。Workbench publisher 的 `capnweb` 和托管状态消费者的 `tinybase` 各自按领域精确版本接纳，不能放入全局 `sharedPackages`；私有库保留自身解析。依赖声明见[插件包](../development/plugin-package.md)。

交付和搬离工作区验证见[发行物](../development/distribution.md)。Node 已有回归覆盖；其他平台需要独立验证网络与原生依赖，不能只凭 Fetch 类型兼容推定支持。

## 测试

插件测试统一使用 `@pluxel/test` 的 `createTestHost()`，按需显式组合服务。它们是隔离宿主，不能代表已经运行的开发应用。具体调用见[测试插件](../plugin-development/testing.md)。
