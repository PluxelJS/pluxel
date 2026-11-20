---
title: Host 宿主配置教程
description: 使用 defineHostApplication 统一组装插件、挂载服务、配置存储与构建生产制品。
---

在 Pluxel 架构中，**宿主（Host）** 是整个应用的装配中心。它负责维护插件声明、启动策略、配置与服务装配，并管理应用从本地开发到生产部署的完整生命周期。

应用入口通常默认导出一个由 `defineHostApplication(factory)` 定义的应用工厂。Vite 本地开发服务器与生产构建流水线直接读取同一个入口，保证开发环境与生产环境行为的一致性。

## 目录速查

| 配置主题                                            | 核心内容                                                |
| --------------------------------------------------- | ------------------------------------------------------- |
| [原生配置与预设](#原生配置与预设)                   | 原生第三方库（ZenFS、LogTape、Elysia）的直接配置        |
| [选择服务组合](#选择组合)                           | 官方 `servicesPreset` 与单项服务的选择                  |
| [应用入口配置](#应用入口)                           | 插件声明、节点配置、启动意图与应用生命周期              |
| [Vite 开发模式](#vite-开发)                         | 开发期间的 HMR 热更新与控制台支持                       |
| [动态插件来源](#动态来源)                           | 监听本地目录动态装载插件                                |
| [环境变量与配置绑定](#绑定部署环境与-json-文件)     | 将系统环境变量映射到插件的 Valibot 配置                 |
| [文件系统后端](#选择文件后端)                       | 挂载纯内存、本地磁盘或浏览器存储后端                    |
| [配置与策略持久化](#保存配置和运行策略)             | 配置的 `declared-first`、`saved-first` 模式与热应用机制 |
| [凭据后端](#部署凭据与-vault-绑定)                  | 配置内建 Vault 的加密后端或只读部署绑定                 |
| [受管出站 HTTP](#受管出站-http)                     | 共享请求预算、代理及按节点收紧的访问范围                |
| [日志系统配置](#host-logging)                       | 接入 LogTape 控制台与远程传输 Sink                      |
| [数据库服务装配](#选择-native-postgresql-或-pglite) | 切换本地嵌入式 PGlite 与生产 PostgreSQL 数据库          |
| [独立轻量 Host](#独立-http-host)                    | 纯脚本或轻量进程中快速创建 Host                         |
| [浏览器环境 Host](#浏览器-host)                     | 在 Web Worker 或网页中运行插件图                        |
| [生产构建与启动判定](#生产启动判定)                 | 打包生产静态制品与严格就绪检查                          |

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

- **普通应用**：使用 `servicesPreset(startup, options)`，包含 HTTP（Elysia）、Commands、Worker、Node 模块、管理能力和默认启用的 Workbench。
- **无界面应用**：使用同一个预设，设置 `workbench: false`，保留管理能力。
- **定制宿主与隔离测试**：直接组合 `elysia()`、`commands()` 等单项安装器，见 [Host 服务组合](./services.md)。

Vault 是 Core 内建能力，通过 `coreConfig.vault` 配置；Database 继续单独选择后端并安装。

---

<span id="应用入口"></span>

## 应用入口

应用入口在 `src/app.ts` 默认导出工厂。每次创建 Host 都用该次的启动环境求值。

```ts no-twoslash
import * as nativeFs from 'node:fs'
import { resolve } from 'node:path'
import { Passthrough } from '@pluxel/core/fs'
import { defineHostApplication } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { listenElysia } from '@pluxel/services/elysia/node'
import { servicesPreset } from '@pluxel/services/preset'
import { TodoPlugin } from '@app/todo'

export default defineHostApplication(async (startup) => {
	const env = resolveHostEnv(startup.env)
	const root = startup.deployment?.root ?? startup.root
	const prefix = resolve(root, env.dataRoot, 'fs')
	await nativeFs.promises.mkdir(prefix, { recursive: true })

	return {
		name: 'my-app',
		plugins: [{ plugin: TodoPlugin, autoStart: true, config: { maxItems: 100 } }],
		coreConfig: {
			logtape: {},
			vault: { deployIdentity: startup.env.PLUXEL_VAULT_DEPLOY_IDENTITY },
			zenfs: {
				mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
				durableMounts: ['/'],
			},
		},
		services: await servicesPreset(startup, {
			workbench: env.workbench === false ? false : undefined,
		}),
		async launch({ host }) {
			await listenElysia(host, {
				hostname: env.hostBind,
				port: env.hostPort,
				publicOrigin: env.publicOrigin,
			})
		},
	}
})
```

### 核心属性说明

| 字段                            | 职责                                                                |
| ------------------------------- | ------------------------------------------------------------------- |
| `plugins`                       | 固定构造器及其默认节点和 fork 声明                                  |
| `sources`                       | 发现并接纳动态实现                                                  |
| `pluginNodes`                   | 通过定义地址预置动态节点的配置与策略                                |
| `coreConfig`                    | Core 的 `logtape`、`zenfs`、`tinybase`、`vault`、`http` 与 `events` |
| `services`                      | 额外服务，由官方预设或单项安装器提供                                |
| `inputMode`、`config`、`policy` | 输入优先级、文档接线与应用级运行策略                                |

`name` 命名应用及根实例。`prepare` 在节点启动前执行，`acceptStartup` 判定启动结果，`launch` 在结果获接受后发布应用。

### 插件装配与地址选择

按定义选择一次实现，默认节点的 `config`、`autoStart`、`configMode`、`policyMode`、`startTimeoutMs`、绑定和 `dependencyOverrides` 均写在同一项。允许 fork 的插件通过 `forks` 表声明额外节点。

```ts no-twoslash
import { defineHostApplication } from '@pluxel/host'
import { QueuePlugin } from './queue'

export default defineHostApplication(() => ({
	plugins: [
		{
			plugin: QueuePlugin,
			autoStart: true,
			config: { queue: 'main' },
			forks: {
				east: { autoStart: true, config: { queue: 'east' } },
				standby: {},
				future: { deploy: false, config: { queue: 'future' } },
			},
		},
	],
}))
```

`standby` 采用默认节点的代码配置。显式 `config: {}` 从空的代码输入开始。各节点自己解析绑定、保存输入、mode、启动期限和依赖选择。管理端创建的 fork 如无对应代码条目，使用其自己的输入。省略 `deploy` 会声明可用的 fork，`deploy: false` 预置输入，保存策略可以按其 mode 部署该节点。代码只预置的 fork 可以写 `autoStart: false`，必须省略 consumer override。

`autoStart: true` 请求宿主启动时主动拉起节点。`false` 只关闭主动启动，依赖仍可拉起它。启动顺序由依赖图决定。

插件类和生成控制引用使用 `address()` 得到定义地址，使用 `nodeAddress()` 或 `nodeAddress('east')` 选择具体节点。应用的 `policy.providerDefaults` 接收 `{ token, provider }`，token 使用抽象插件的定义地址。节点的 consumer override 使用 `{ requirementAddress, providerAddress }`。传入 `null` 恢复正常的 provider 选择。

脚本通过 `sdk.plugins.list({ packageName })` 或 `{ definition }` 定向分页，并把返回的节点地址交给 `sdk.plugin(address)`。详见[插件发现与控制](../development/plugin-control.md#动态安装后的发现与操作)。

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
			scripts: true,
		}),
	],
})
```

开发模式下，Vite 会处理插件的装饰器编译与依赖关系提取，并支持通过命令行控制台调试插件状态。

---

<span id="动态来源"></span>

## 动态来源

用 `sources` 声明入口。精确文件缺失会报错，尚未创建的目录按空匹配处理。目录的 `include` 使用正向 glob。相对路径以应用根目录为起点，工厂可以用启动环境计算绝对路径。

```ts no-twoslash
import { resolve } from 'node:path'
import { Counter } from '@acme/pluxel-plugin-counter/control'
import { defineHostApplication } from '@pluxel/host'

export default defineHostApplication((startup) => {
	const root = startup.deployment?.root ?? startup.root
	const dataRoot = resolve(root, startup.env.PLUXEL_DATA_ROOT ?? '.pluxel')
	return {
		sources: [
			{ file: './entries/local.mjs' },
			{ directory: resolve(dataRoot, 'managed-plugins', 'entries'), include: ['*.mjs'] },
		],
		pluginNodes: [{ definition: Counter.address(), autoStart: true, config: { count: 2 } }],
	}
})
```

同一定义只写一份代码声明。固定类与发现的实现使用同一 catalog。控制引用提供身份，动态入口加载后才提供实现。预置目标在实现缺失时显示为 unavailable。生产默认要求预期运行的节点已运行，应用可用 `acceptStartup` 判定是否接受等待后续发布的状态。

Vite 观察匹配的 TypeScript 和预编译 ESM 入口。Node 原生启动和 modules 交付在启动时发现预编译 `.js` 和 `.mjs`。standalone 构建采用固定清单，`sources` 可以省略或填写 `[]`。

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

| 环境变量               | 默认值      | 作用说明                                         |
| ---------------------- | ----------- | ------------------------------------------------ |
| `PLUXEL_DATA_ROOT`     | `.pluxel`   | 本地数据持久化存储的相对根目录                   |
| `PLUXEL_HOST_BIND`     | `127.0.0.1` | HTTP 服务监听的本地地址                          |
| `PLUXEL_HOST_PORT`     | `3000`      | HTTP 服务监听的物理端口                          |
| `PLUXEL_WORKBENCH`     | `true`      | 是否开启 Workbench 管理后台                      |
| `PLUXEL_PUBLIC_ORIGIN` | 监听地址    | 对外公开的 HTTP Origin（用于反向代理与同源校验） |

---

<span id="绑定部署环境与-json-文件"></span>

## 绑定部署环境与 JSON 文件

把 `envBinding(inputs)` 和 `fileBinding(inputs)` 写在要配置的节点下。配置 binding 引用插件 `configs.use()` 使用的同一个 Valibot schema。

```ts no-twoslash
import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
import { WorkerPlugin, WorkerConfig } from './WorkerPlugin'

export default defineHostApplication(() => ({
	plugins: [
		{
			plugin: WorkerPlugin,
			autoStart: true,
			fileBindings: [fileBinding({ config: { schema: WorkerConfig, path: 'worker.json' } })],
			envBindings: [
				envBinding({
					config: { schema: WorkerConfig, mapping: { endpoint: 'WORKER_ENDPOINT' } },
				}),
			],
		},
	],
}))
```

Host 相对应用根目录读 JSON 文件，从 `startup.env` 取显式映射的变量。节点的代码配置先与文件合并，再合并环境输入，最后按节点的 mode 选择保存输入。数组整项替换。

<span id="可选管理页面与服务配套插件"></span>
<span id="部署凭据"></span>

### 部署凭据与 Vault 绑定

敏感凭证由 Core 内建的 `ctx.vault` 访问，Host 通过 `coreConfig.vault` 选择后端。默认加密后端借用 `coreConfig.zenfs` 的文件系统，首次数据操作按需初始化新库；只使用 `envBindings` / `fileBindings` 提供的只读记录时，可设置 `coreConfig.vault: { backend: 'bindings' }`，不打开加密存储或生成密钥。

应用工厂通过 `deployIdentity: startup.env.PLUXEL_VAULT_DEPLOY_IDENTITY` 显式传入部署私钥。能力存在不表示存储已经解锁或记录存在，具体状态由操作报告。绑定 Schema、命名空间、读写和错误处理见 [Vault 凭据指南](../plugin-development/vault.md)。

---

## 受管出站 HTTP

`coreConfig.http` 配置内建的出站传输，作用于插件通过 `ctx.wretch` 和 `ctx.fetch` 发起的请求。下面的宿主将访问限制到一个 HTTP origin，并调低每次尝试的超时和并发上限。 [插件调用](../plugin-development/outbound-http.md)

```ts twoslash
import { defineHostApplication } from '@pluxel/host'

export default defineHostApplication(() => ({
	coreConfig: {
		http: {
			allowedOrigins: ['https://api.example.com'],
			timeoutMs: 15_000,
			maxConcurrentRequests: 32,
			maxQueuedRequests: 128,
		},
	},
}))
```

默认每个宿主共享 64 个并发尝试和 256 个排队位置，每次已接纳的尝试有 30 秒等待响应头的预算。超时值 `0` 关闭部署层计时。origin 以规范化的 HTTP(S) scheme、host 和 port 匹配。省略 `allowedOrigins` 允许任意 HTTP(S) origin，空列表拒绝全部受管请求。保存的宿主规则和节点规则在部署范围内继续收紧。

宿主在创建时确定是否接管出站请求，以及留存哪些记录。插件统一使用 `ctx.wretch` 或 `ctx.fetch`，在途请求始终关联宿主、插件运行代和调用方的取消信号。

| `coreConfig.http`                | 生效行为                                          |
| -------------------------------- | ------------------------------------------------- |
| 省略或 `{ records: 'requests' }` | 启用受管能力，保留节点摘要和最近 5,000 条请求日志 |
| `{ records: 'summary' }`         | 启用受管能力，每个节点仅保留最近结果及计数        |
| `{ records: 'off' }`             | 仅启用受管能力                                    |
| `{ managed: false }`             | 按平台 Fetch 的语义发送，保留生命周期取消         |

`managed: false` 可以配合部署提供的 `fetch` 使用。遇到 origin、代理、超时、队列或记录等受管选项时，宿主在校验声明时拒绝组合。受管模式下，`fetch` 接收已应用策略的 `Request`。关闭接管时，`fetch` 接收原调用的 URL 或 `Request`，以及附带生命周期取消信号的选项。宿主可以在这处接入运行环境提供的 Fetch 兼容函数。

启用 origin 限制时，字符串或 URL 请求默认使用 `redirect: 'error'`，显式 `follow` 会在发送前被拒绝。调用方可用 `manual` 取得运行时原生响应，并通过同一入口请求获得的下一跳。已有 `Request` 的有效重定向模式由 `init.redirect` 或 `Request.redirect` 决定。

管理设置在已配置的 Host 文档存储中持久化，Workbench 读取同一套设置与活动摘要。活动摘要和请求日志属于当前宿主实例，随宿主结束释放。 [受管出站管理](../workbench/operations.md#查看受管出站-http)

Node Host 可用 `proxyUrl` 设置无凭据的 HTTP(S) 代理 origin，或者用 `null` 清除受管代理并使用 Host 的默认传输。默认允许管理侧调整代理，`allowProxyChanges: false` 将代理选择固定在部署配置。Browser Host 使用平台 Fetch。

通过 `headers` 声明 `User-Agent`、`Accept` 等非敏感默认头。节点默认值优先于宿主保存值及部署值，插件在每个请求中显式提供的头优先。认证和 Cookie 由插件提供，连接、长度等传输头由 Fetch 管理。

### 从 Wretch 插件迁移

将原 Wretch 节点的 `allowedOrigins`、`timeoutMs`、`maxConcurrentRequests` 和 `maxQueuedRequests` 移至 `coreConfig.http`。原有 `allowedOrigins: []` 表示不限地址，迁移时省略该字段。调用方直接使用 `ctx.wretch`，并移除原来的 Wretch 节点和构造参数。迁移时核对与请求同名的已保存默认头。迁移后的请求显式值优先于保存值。

旧 provider Store 的 `consumerSettings` 表有记录时，在停机期间读取各行的 `owner` 和 `settings` JSON 字符串。按完整节点地址核对对应关系和冲突，再把每个值作为 `{ owner, settings }` 放入新文档的 `nodes` 数组，保留 fork 标识。新文档位于 Core FS 的 `services/host/outbound-http/policy.json`，首次创建使用 `version: 1`、`revision: 1` 及 `defaults: {}`。已有文档时合并到现有 `nodes` 并递增 `revision`。保存后通过 Workbench 核对实际采用的设置。 [受管出站设置与活动](../workbench/operations.md#查看受管出站-http)

---

<span id="选择文件后端"></span>

## 选择文件后端

在 `coreConfig.zenfs` 写上游 ZenFS 挂载配置。

```ts
import * as nativeFs from 'node:fs'
import { InMemory, Passthrough, type FsConfig } from '@pluxel/core/fs'

export const zenfs = {
	mounts: {
		'/': { backend: Passthrough, fs: nativeFs, prefix: './data/fs' },
		'/tmp': InMemory,
	},
	durableMounts: ['/'],
} satisfies FsConfig
```

`durableMounts` 声明可跨重启保留数据的挂载点。依赖持久存储的插件在启动时核对该声明。

<span id="保存配置和运行策略"></span>

## 保存配置和运行策略

应用可以用一个 `inputMode` 设置共同优先级。各域采用最先指定的设置。

| 输入         | 从高到低的优先级                                                              |
| ------------ | ----------------------------------------------------------------------------- |
| 节点业务配置 | `configMode → config.mode → inputMode → declared-first`                       |
| 节点策略     | `policyMode → policy.modes[field] → policy.mode → inputMode → declared-first` |
| 应用级策略   | `policy.modes[field] → policy.mode → inputMode → declared-first`              |

`declared-first` 采用代码并从保存值补缺。`saved-first` 采用保存值并从代码补缺。`declared-only` 只采用代码。节点配置按叶路径合并，缺失值由 schema 处理。节点的 `policyMode` 同时作用于自动启动、fork 可用性和其作为 consumer 的覆盖。

`config.document` 和 `policy.document` 分别设置文件接线。默认借用 Core FS，保留期取决于 ZenFS mount。`false` 关闭该域 IO，仍可维护会话输入。`{ readOnly: true }` 允许读取并拒绝本实例的管理写入。嵌入应用可用同步 `{ storage: (root) => HostDocumentStorage }` 借用已有存储。缺失文档保留为缺失，坏文档报错并保留文件。

配置查询返回保存原值、有效输入、来源及校验结果。Workbench 和脚本使用 `patch({ set?, remove? })` 修改保存值，用 `reset` 恢复继承。`expectedManagedRevision` 在写入前检查版本。`persistence` 表示保存阶段，`application` 表示运行采用阶段。保存成功而监听器缺失或失败时返回 `saved-not-applied`。

### 八项运行策略

| 策略                         | 选择单位                                               |
| ---------------------------- | ------------------------------------------------------ |
| `autoStart`                  | 节点。显式 `false` 保留禁用选择                        |
| `forks`                      | fork 节点。保存条目可选择部署或移除                    |
| `dependencyOverrides`        | consumer 节点与 requirement 地址。显式 `null` 清除选择 |
| `providerDefaults`           | 完整列表，显式 `[]` 清空该列表                         |
| `execution.startTimeoutMs`   | Host 默认启动期限                                      |
| `execution.drainTimeoutMs`   | Host 排空期限                                          |
| `execution.startConcurrency` | Host 启动并发预算                                      |
| `execution.stopConcurrency`  | Host 停止并发预算                                      |

代码只给 A 设置自动启动时，B 的保存选择继续按 B 的 mode 生效。原始策略编辑可以保存被遮盖的值，要求实际生效的命令会在副作用前以 `policy_shadowed` 拒绝。`host.policy.reset([{ field: 'autoStart', node }])` 删除一个保存键，恢复继承。fork 的停止与元数据清理由 `host.forks.remove()` 完成。

启动时，每个 generation 依次采用节点的 `startTimeoutMs`、插件 `@Plugin({ startTimeoutMs })`、Host 的 `policy.execution.startTimeoutMs` 和 Core 默认值。显式期限必须是 1 到 2,147,483,647 毫秒的整数。Workbench 保存的 Host 执行参数在重建 Host 时采用，保存结果用 `requires-host-recreation` 标记待采用的参数。

<span id="host-logging"></span>

## 日志配置（Host Logging）

填写 `coreConfig.logtape: {}` 开启默认控制台和有界日志缓存。`{ options }` 可调整管理选项。原生 LogTape Config 或同步 root factory 提供完整输出配置，可和管理选项一起写成 `{ input, options }`。省略该字段时插件仍使用 `ctx.logger`，配置后 `root.logging` 提供日志策略、缓存、状态和 flush。

```ts
import type { CoreFacilitiesConfig } from '@pluxel/core'
import { createRuntimePrettyConsoleSink } from '@pluxel/core/logging/pretty'

export const coreConfig = {
	logtape: {
		sinks: { console: createRuntimePrettyConsoleSink({ timezone: 'local' }) },
		loggers: [{ category: ['pluxel'], sinks: ['console'], lowestLevel: 'info' }],
	},
} satisfies CoreFacilitiesConfig
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
	plugins: [{ plugin: MyWorkerPlugin, autoStart: true }],
})

await host.start()
```

`createHost()` 与应用工厂使用相同的节点声明。具有部署输入绑定或文件发现的应用通过应用工厂取得启动上下文。

---

<span id="浏览器-host"></span>

## 浏览器 Host

`@pluxel/host/browser` 提供浏览器和 Web Worker 中的 `createHost()`。文件存储默认使用 InMemory。需要重开恢复时，通过 `coreConfig.zenfs` 显式挂载 IndexedDB。浏览器入口使用浏览器 Fetch，Node 代理由 Node 入口提供。调用方负责启动和关闭 Host。

## Cloudflare 请求 Host

在 Cloudflare Workers 的原生 `fetch(request, env, ctx)` 内，从 `@pluxel/host/cloudflare` 调用 `createHost()`，传入构建时确定的插件。调用方等待 `host.start()`，确认期望运行的节点已达到 `running`，再调用业务方法。可用 `await using host` 在返回已消费完业务数据的 JSON 等响应前结算 Host。流式响应的调用方须把 Host 保留到响应体结束或取消。

此入口的根文档和 TinyBase 快照保留到当前请求的 Host 关闭。部署通过 `vaultBindings` 传入节点可读的凭据，通过 `coreConfig.http.fetch` 接入 Service Binding 等传输。请求 Host 拒绝托管 LogTape、ZenFS 和 Node 代理配置。插件调用 `ctx.fs()` 会收到 `ENOTSUP`。

插件可以继续使用 `ctx.logger`。由 Worker 应用在 isolate 中配置 LogTape 输出，例如控制台 sink。请求 Host 沿用这份配置，并在日志属性中附加 `hostRequestId`。 [三端完整示例](../../projects/host-targets/README.md)

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
