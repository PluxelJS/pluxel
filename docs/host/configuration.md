---
title: Host 宿主配置教程
description: 使用 defineHostApplication 统一组装插件、挂载服务、配置存储与构建生产制品。
---

在 Pluxel 架构中，**宿主（Host）** 是整个应用的装配中心。它负责维护插件清单、设定启动策略、组装持久化服务，并管理应用从本地开发到生产部署的完整生命周期。

应用入口通常默认导出一个由 `defineHostApplication(factory)` 定义的应用工厂。Vite 本地开发服务器与生产构建流水线直接读取同一个入口，保证开发环境与生产环境行为的一致性。

## 目录速查

| 配置主题 | 核心内容 |
| --- | --- |
| [原生配置与预设](#原生配置与预设) | 原生第三方库（ZenFS、LogTape、Elysia）的直接配置 |
| [选择服务组合](#选择组合) | 官方 `servicesPreset` 与轻量基础服务的选择 |
| [应用入口配置](#应用入口) | `plugins` 清单、`policy.autoStart` 策略与应用生命周期钩子 |
| [Vite 开发模式](#vite-开发) | 开发期间的 HMR 热更新与控制台支持 |
| [动态插件来源](#动态来源) | 监听本地目录动态装载插件 |
| [环境变量与配置绑定](#绑定部署环境与-json-文件) | 将系统环境变量映射到插件的 Valibot 配置 |
| [文件系统后端](#选择文件后端) | 挂载纯内存、本地磁盘或浏览器存储后端 |
| [配置与策略持久化](#保存配置和运行策略) | 配置的 `declared-first`、`saved-first` 模式与热应用机制 |
| [日志系统配置](#host-logging) | 接入 LogTape 控制台与远程传输 Sink |
| [数据库服务装配](#选择-native-postgresql-或-pglite) | 切换本地嵌入式 PGlite 与生产 PostgreSQL 数据库 |
| [独立轻量 Host](#独立-http-host) | 纯脚本或轻量进程中快速创建 Host |
| [浏览器环境 Host](#浏览器-host) | 在 Web Worker 或网页中运行插件图 |
| [生产构建与启动判定](#生产启动判定) | 打包生产静态制品与严格就绪检查 |

---

<span id="原生配置与预设"></span>
## 原生配置与预设

Pluxel 坚持尊重底层优秀生态的原生 API。在宿主配置中，你可以直接传入上游库的标准配置：
- **文件存储**：直接使用 ZenFS 的标准挂载配置（`mounts`）；
- **日志输出**：直接使用 LogTape 原生的 Sinks、Filters 与 Formatter 配置；
- **关系数据库**：直接配置 PostgreSQL 连接参数或 PGlite 原生选项；
- **Web 服务**：基于 Elysia 2 原生实例进行扩展。

预设函数负责填充开箱即用的默认参数，在需要深度定制时，你可以随时覆盖底层原生选项。

---

<span id="选择组合"></span>
## 选择组合

根据项目类型，可在入口中选择预设的服务组合：

- **`servicesPreset()`**：官方服务器推荐组合。开箱包含 HTTP 服务（Elysia）、指令系统（Commands）、Worker 线程池、Node 模块加载器、Vault 凭据存储与 Workbench 可视化管理面板。
- **`standardServices()`**：无前端管理面板的纯后端基础组合。包含 HTTP、Commands 与 Worker 基础设施。
- **按需手工组装**：通过 `@pluxel/host` 从零挑选所需服务，保持最小体积。

---

<span id="应用入口"></span>
## 应用入口

在 `src/app.ts` 中通过 `defineHostApplication()` 声明应用。这是应用的权威入口：

```ts no-twoslash
import { resolve } from 'node:path'
import * as nativeFs from 'node:fs'
import { defineHostApplication } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { servicesPreset } from '@pluxel/services/preset'
import { listenElysia } from '@pluxel/services/elysia/node'
import { Passthrough } from '@pluxel/core/fs'
import { logtape, zenfs } from '@pluxel/core/config'
import { TodoPlugin } from '@app/todo'

export default defineHostApplication(async (startup) => {
	const env = resolveHostEnv(startup.env)
	const storagePrefix = resolve(startup.root, env.dataRoot, 'fs')
	await nativeFs.promises.mkdir(storagePrefix, { recursive: true })

	return {
		name: 'my-app',
		// 1. 声明本应用包含的插件清单
		plugins: [TodoPlugin],

		// 2. 声明冷启动时自动启动的插件节点
		policy: { autoStart: [TodoPlugin] },

		// 3. 初始默认配置
		config: {
			records: [{ owner: TodoPlugin, config: { maxItems: 100 } }],
		},

		// 4. 挂载官方服务预设（含 HTTP、Vault 与 Workbench）
		services: await servicesPreset(startup, {
			workbench: env.workbench ?? true,
		}),

		// 5. 启动 HTTP 物理监听
		async launch({ host }) {
			await listenElysia(host, {
				hostname: env.hostBind,
				port: env.hostPort,
				publicOrigin: env.publicOrigin,
			})
		},

		// 6. 底层运行时基础设施
		runtime: {
			logtape: logtape(),
			zenfs: zenfs({
				mounts: {
					'/': {
						backend: Passthrough,
						fs: nativeFs,
						prefix: storagePrefix,
					},
				},
				durableMounts: ['/'],
			}),
		},
	}
})
```

### 核心属性说明

- **`plugins`**：提供应用可用的插件代码清单。插件列入此清单表示可用，实际启动顺序由依赖图和启动策略统一管理。
- **`policy.autoStart`**：列出应用启动时需要主动拉起的插件；它们的依赖项会被框架自动递归拉起。
- **`prepare`**：在插件启动前执行的应用级准备工作（如准备基础目录、校验底层前置依赖）。
- **`launch`**：在所有插件成功进入运行状态后执行，通常用于绑定并开启 Web 物理监听。

---

<span id="vite-开发"></span>
## Vite 开发

在本地开发时，配合 `@pluxel/services/vite` 提供的 Vite 插件实现实时热更新：

```ts no-twoslash
// vite.config.ts
import { defineConfig } from 'vite'
import { vitePreset } from '@pluxel/services/vite'
import { resolveHostEnv } from '@pluxel/host/environment'

const env = resolveHostEnv(process.env)

export default defineConfig({
	server: {
		host: env.hostBind ?? '127.0.0.1',
		port: env.hostPort ?? 3000,
	},
	plugins: [
		vitePreset({
			entry: './src/app.ts',
			devConsole: true,
		}),
	],
})
```

开发模式下，Vite 会处理插件的装饰器编译与依赖关系提取，并支持通过命令行控制台调试插件状态。

---

<span id="动态来源"></span>
## 动态来源

如果需要在应用运行期间自动扫描并加载指定目录下的插件，可以配置 `sources`：

```ts no-twoslash
import { pluginSource } from '@pluxel/host/sources'

export default defineHostApplication(() => ({
	plugins: [],
	sources: [
		pluginSource({
			kind: 'directory',
			path: './managed-plugins/entries',
			include: ['*.mjs'],
		}),
	],
}))
```

目录中的新插件在被保存或移除时，宿主会自动更新可用插件目录。

---

<span id="vite-生产"></span>
## Vite 生产

在生产环境中，使用 Node 原生生产启动器加载构建产物：

```ts no-twoslash
// start-vite.mjs
import { runViteApplication } from '@pluxel/host-vite/run'

const session = await runViteApplication({
	root: import.meta.dirname,
	configFile: './vite.runtime.config.ts',
})

const shutdown = () => {
	void session.close().catch((err) => {
		console.error('Shutdown error:', err)
		process.exit(1)
	})
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
```

---

<span id="配置环境变量"></span>
## 配置环境变量

`@pluxel/host/environment` 提供了纯解析函数 `resolveHostEnv(input)`，统一管理常用环境变量：

| 环境变量 | 默认值 | 作用说明 |
| --- | --- | --- |
| `PLUXEL_DATA_ROOT` | `.pluxel` | 本地数据持久化存储的相对根目录 |
| `PLUXEL_HOST_BIND` | `127.0.0.1` | HTTP 服务监听的本地地址 |
| `PLUXEL_HOST_PORT` | `3000` | HTTP 服务监听的物理端口 |
| `PLUXEL_WORKBENCH` | `true` | 是否开启 Workbench 管理后台 |
| `PLUXEL_PUBLIC_ORIGIN` | 监听地址 | 对外公开的 HTTP Origin（用于反向代理与同源校验） |

---

<span id="绑定部署环境与-json-文件"></span>
## 绑定部署环境与 JSON 文件

当部署系统需要通过环境变量或外部 JSON 文件覆盖特定插件的配置时，可以使用 `envBinding` 与 `fileBinding`：

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
					http: {
						enabled: 'WORKER_HTTP_ENABLED',
						timeoutMs: 'WORKER_HTTP_TIMEOUT_MS',
					},
				},
			},
		}),
	],
}))
```

宿主在启动时会读取对应的环境变量，校验是否符合 `WorkerConfig` 的格式要求，并注入到插件中。

<span id="可选管理页面与服务配套插件"></span>
<span id="部署凭据"></span>
### 部署凭据与 Vault 绑定

敏感凭证应当通过 Vault 进行绑定，而不是放置在普通明文配置中。详细配置模式请参考 [Vault 凭据指南](../plugin-development/vault.md)。

---

<span id="选择文件后端"></span>
## 选择文件后端

通过 `runtime.zenfs` 挂载文件系统后端：

```ts
import { zenfs } from '@pluxel/core/config'
import { Passthrough, InMemory } from '@pluxel/core/fs'
import * as nativeFs from 'node:fs'

// 生产环境：挂载本地磁盘目录
zenfs({
	mounts: {
		'/': { backend: Passthrough, fs: nativeFs, prefix: './data/fs' },
		'/tmp': InMemory,
	},
	durableMounts: ['/'], // 标记具备持久化保证的挂载点
})
```

- `durableMounts` 用于声明哪些挂载点在重启后依然能够保留数据。依赖持久存储的插件会在启动时核对该声明。

---

<span id="保存配置和运行策略"></span>
## 保存配置和运行策略

每个插件节点的配置来源可以指定优先模式（`mode`）：

- **`declared-first`（默认）**：代码中的显式声明优先生效，其余缺失项继承持久化保存的值；
- **`saved-first`**：管理后台保存的值优先，缺失项采用代码中的声明；
- **`declared-only`**：完全忽略外部持久化修改，严格使用代码中声明的值或 Schema 默认值。

在运行时通过管理 API（或 Workbench）修改配置后，若插件已注册了 `onUpdate` 监听器，新配置会被就地热应用；否则新配置将在插件下次重启后生效。

---

<span id="host-logging"></span>
## 日志配置（Host Logging）

宿主使用 LogTape 管理全局日志输出。通过 `runtime.logtape` 挂载格式化终端 Sink 或远程推送：

```ts
import { logtape } from '@pluxel/core/config'
import { createRuntimePrettyConsoleSink } from '@pluxel/core/logging/pretty'

export const loggingConfig = logtape({
	sinks: {
		console: createRuntimePrettyConsoleSink({
			timezone: 'local',
			pretty: { properties: true },
		}),
	},
	loggers: [
		{ category: ['pluxel'], sinks: ['console'], lowestLevel: 'info' },
	],
})
```

<span id="远程输出原生-logtape-sink"></span>
### 远程输出原生 LogTape Sink

若需将日志输出至 OpenTelemetry 收集器或远程文件，直接组合 LogTape 的官方 Sink 即可。

---

<span id="选择-native-postgresql-或-pglite"></span>
## 数据库服务后端选择

在挂载关系型数据库服务时，宿主可在本地嵌入式轻量引擎与生产外部数据库之间平滑切换：

```ts
import { database } from '@pluxel/services/database'
import { pglite } from '@pluxel/services/database/pglite'
import { postgres } from '@pluxel/services/database/postgres'

// 本地开发或测试：使用嵌入式 PGlite
database({
	backend: pglite({ dataDir: './data/pglite' }),
})

// 生产部署：连接外部 PostgreSQL 数据库
database({
	backend: postgres({
		connectionString: process.env.DATABASE_URL,
	}),
})
```

无论选择哪种后端，插件内部编写的 Drizzle Schema 与查询语句均保持完全一致。

<span id="application-private-database"></span>
### 应用私有数据库（Application-Private Database）

对于整个应用统一共享的数据库连接，可由应用在 `prepare()` 钩子中直接建立，并通过自定义服务提供给内部模块使用。

---

<span id="独立-http-host"></span>
<span id="独立-logging-host"></span>
## 独立轻量 Host

对于简单的脚本工具或批处理任务，可以直接调用 `@pluxel/host` 导出的 `createHost()`：

```ts
import { createHost } from '@pluxel/host'
import { MyWorkerPlugin } from './worker'

await using host = await createHost({
	plugins: [MyWorkerPlugin],
	policy: { autoStart: [MyWorkerPlugin] },
})

await host.start()
```

---

<span id="浏览器-host"></span>
## 浏览器 Host

`@pluxel/host/browser` 导出了适用于浏览器环境与 Web Worker 的轻量宿主实现。在该入口下，底层文件存储默认使用内存（InMemory）或浏览器的 IndexedDB 后端，插件与服务可在纯前端环境中协同运转。

---

<span id="生产启动判定"></span>
<span id="生产构建"></span>
## 生产构建与启动判定

在生产启动阶段，宿主严格按顺序执行以下阶段：
1. 准备宿主服务与执行应用 `prepare()`；
2. 启动插件依赖拓扑图；
3. 校验启动报告，确认每个预期运行的插件均成功达到 `running` 状态；
4. 执行应用 `launch()` 开启物理监听。

如果启动过程中任何必需插件初始化失败，宿主将安全终止并输出完整的异常报告，防止应用在未就绪的状态下接收外部流量。

---

<span id="共享文件与外部修改"></span>
## 共享文件与外部修改

当多个宿主实例共同挂载同一个本地磁盘目录时，底层存储引擎会自动监听外部修改，并在快照合法的前提下热同步给运行中的插件。多实例共享高并发写操作时，建议采用集中式的 PostgreSQL 数据库确保事务安全。
