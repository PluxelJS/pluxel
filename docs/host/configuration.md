---
title: Host 宿主配置
description: 使用 defineHostApplication 统一组装插件、挂载服务、配置存储与构建生产制品。
---

在应用工厂 `defineHostApplication(factory)` 中声明插件、配置和服务。Node 托管项目默认导出工厂，供 Vite 与生产加载器读取。随应用发布的插件如何接入设置页，见[启停和配置内置插件](./fixed-plugins.md)。

## 目录速查

| 配置主题                                          | 核心内容                                                |
| ------------------------------------------------- | ------------------------------------------------------- |
| [原生配置与预设](#原生配置与预设)                 | 原生第三方库（ZenFS、LogTape、Elysia）的直接配置        |
| [选择服务组合](#选择组合)                         | 官方 `servicesPreset` 与单项服务的选择                  |
| [应用入口配置](#应用入口)                         | 插件声明、节点配置、启动意图与应用生命周期              |
| [Vite 开发模式](#vite-开发)                       | 开发期间的 HMR 热更新与控制台支持                       |
| [动态插件来源](#动态来源)                         | 监听本地目录动态装载插件                                |
| [环境变量与配置绑定](#绑定部署环境与-json-文件)   | 将系统环境变量映射到插件的 Valibot 配置                 |
| [文件系统后端](#选择文件后端)                     | 挂载纯内存、本地磁盘或浏览器存储后端                    |
| [配置与策略持久化](#保存配置和运行策略)           | 配置的 `declared-first`、`saved-first` 模式与热应用机制 |
| [凭据后端](#部署凭据与-vault-绑定)                | 配置内建 Vault 的加密后端或只读部署绑定                 |
| [受管出站 HTTP](#受管出站-http)                   | 共享请求预算、代理及按节点收紧的访问范围                |
| [日志系统配置](#host-logging)                     | 接入 LogTape 控制台与远程传输 Sink                      |
| [数据库服务装配](#数据库服务后端选择)             | 为 `Pg` 或 `Sqlite` 选择驱动                            |
| [独立轻量 Host](#独立-http-host)                  | 纯脚本或轻量进程中快速创建 Host                         |
| [嵌入式 Host](#嵌入式-host)                       | 在页面、Worker、LLRT 或 React Native 中运行插件图       |
| [Cloudflare Worker Host](#cloudflare-worker-host) | 在同一 isolate 内跨请求和 Cron 复用插件与服务           |
| [生产构建与启动判定](#生产启动判定)               | 打包生产静态制品与严格就绪检查                          |

---

<span id="原生配置与预设"></span>

## 原生配置与预设

Pluxel 坚持尊重底层优秀生态的原生 API。在宿主配置中，你可以直接传入上游库的标准配置：

- **文件存储**：直接使用 ZenFS 的标准挂载配置（`mounts`）；
- **日志输出**：直接使用 LogTape 原生的 Sinks、Filters 与 Formatter 配置；
- **关系数据库**：按方言安装 PostgreSQL、PGlite、本地 SQLite 或 Cloudflare D1 驱动；
- **Web 服务**：基于 Elysia 2 原生实例进行扩展。

预设函数负责填充开箱即用的默认参数，在需要深度定制时，你可以随时覆盖底层原生选项。

---

<span id="选择组合"></span>

## 选择组合

根据项目类型，可在入口中选择预设的服务组合：

- **普通应用**：使用 `servicesPreset(startup, options)`，包含 HTTP（Elysia）、Commands、Worker、Node 模块、管理能力和默认启用的 Workbench。
- **无界面应用**：使用同一个预设，设置 `workbench: false`，保留管理能力。
- **定制宿主与隔离测试**：直接组合 `elysia()`、`commands()` 等单项安装器，见 [Host 服务组合](./services.md)。

Vault 是 Core 内建能力，通过 `coreConfig.vault` 配置。应用需要托管 PostgreSQL 时单独安装 `Pg`。

---

<span id="应用入口"></span>

## 应用入口

三端共用 `defineHostApplication(factory)`。工厂可以读取 `startup.env`，用普通 TypeScript 选择插件、服务、配置和策略。下例从 `@pluxel/host` 导入 Node 托管入口，默认导出的工厂可直接读取部署路径、模式和启动 bindings。Node 加载器在每次新的应用装配时求值。

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

| 字段               | 职责                                                                |
| ------------------ | ------------------------------------------------------------------- |
| `plugins`          | 固定构造器及其默认节点和 fork 声明                                  |
| `sources`          | 发现并接纳动态实现                                                  |
| `pluginNodes`      | 通过定义地址预置动态节点的配置与策略                                |
| `coreConfig`       | Core 的 `logtape`、`zenfs`、`tinybase`、`vault`、`http` 与 `events` |
| `services`         | 额外服务，由官方预设或单项安装器提供                                |
| `config`、`policy` | 输入优先级、文档接线与应用级运行策略                                |

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

standalone 和 modules 构建从源码静态解析 `plugins` 和 `pluginNodes`。把插件集合写成构建时可确定的声明，`autoStart` 和服务选择可以在启动时求值。[动态来源](#动态来源)

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

开发机上的 Vite 调用 Pluxel 编译器提取插件声明与依赖，Host 把定义交给 Core 构建运行图。可以通过命令行控制台调试 Node Host 中的插件状态。

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

受管来源的发布者可以从 `@pluxel/host/sources` 调用 `readPluginSourceImpact(ctx, [{ name, file }])`。传入包名和即将发布或撤回的入口的绝对物理路径，即可读取当前提供该定义的来源类别、各节点运行状态及直接消费者。审阅后应在提交发布前再次读取；若抛出 `PluginSourceBusyError`，等待 Host 事务结算并重新审阅。需要预检待发布的声明时，每个入口还可携带 `action: 'publish'` 及已核实的根定义，撤回用 `action: 'withdraw'`。返回的 `dependencyReview` 针对整批，包含按当前策略推算的绑定和问题变化，或无法得出该预测的原因。Package Manager 的公开预览用法见[管理插件包](../plugins/package-manager.md#在-workbench-一起安装多个精确版本)。

Node 包来源可从同一入口调用 `await readPackageSourceDefinitions(packageRoot, packageManifest)`，传入实际包目录和其中已解析的 `package.json`，获得清单列出的自有根定义及可核实的依赖。包未声明 `pluxel.control` 时返回 `undefined`，清单没有本包根定义时返回空数组，声明的材料损坏则抛错。

<span id="vite-生产"></span>

## Vite 生产

此入口适用于需要在线消费插件来源的托管 Node 服务。嵌入式应用与 Worker 按目标交付已编译插件。 [跨平台开发与交付](./runtime-portability.md#开发与交付)

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

将绑定写在目标插件或 fork 下。普通配置引用插件 `configs.use()` 使用的同一个 Valibot schema。下面的托管 Node 应用从 JSON 文件取配置，再用部署环境里的 `WORKER_ENDPOINT` 覆盖对应字段。

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

托管 Node 加载器相对应用根目录读取 `fileBindings`。三个平台的直接启动入口都支持 `envBindings`，共享应用从 `@pluxel/host/bindings` 导入 `envBinding`。Node 和嵌入式宿主将部署变量传给 `startHost` 的 `env`，Cloudflare 则在事件中传给 `worker.run`。

普通配置依次合并代码输入、托管 Node 读取的文件输入和显式映射的环境输入。未提供某个环境变量时保留此前的配置，数组整项替换。合并结果再按节点模式与保存值组合。 [配置优先级](#保存配置和运行策略)

<span id="可选管理页面与服务配套插件"></span>
<span id="部署凭据"></span>

### 部署凭据与 Vault 绑定

邮件插件导出 `MailVault`（例如 `v.object({ token: v.string() })`），应用将它的 `token` 记录映射到部署变量 `MAIL_API_TOKEN`。

```ts
import { defineHostApplication } from '@pluxel/host/application'
import { envBinding } from '@pluxel/host/bindings'
import { MailPlugin, MailVault } from './mail'

export default defineHostApplication(() => ({
	coreConfig: { vault: { backend: 'bindings' } },
	plugins: [
		{
			plugin: MailPlugin,
			autoStart: true,
			envBindings: [
				envBinding({ vault: { schema: MailVault, mapping: { token: 'MAIL_API_TOKEN' } } }),
			],
		},
	],
}))
```

交付 modules 应用时，将插件类放在工厂导入的独立模块中。同文件导出插件类和默认工厂可能使 control 声明生成器无法解析推导出的 schema 类型。

服务端部署提供实际的 `MAIL_API_TOKEN`。直接启动 Node Host 时将它放进 `startHost(application, { env })` 的 `env`。Cloudflare 把它配置为 Secret，再在事件处理函数中将 `{ MAIL_API_TOKEN: env.MAIL_API_TOKEN }` 传给 `worker.run` 的 `env`。插件用 `await this.ctx.vault.kv().get('token')` 读取记录。浏览器只能接收可以交付给终端用户的值。 [Worker 事件入口](#cloudflare-worker-host) · [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

每条 Vault 记录映射的所有变量都必须提供。Host 在创建根时检查所有声明，包括尚未启用自动启动的插件和 fork。缺失来源会抛出 `InputBindingError`，错误码为 `MISSING_INPUT`。解码或 schema 校验失败时，错误码为 `INVALID_INPUT`。从 `@pluxel/host/bindings` 导入该错误类型即可区分这两种情况。

只需读取部署记录时，使用示例中的 `bindings` 后端。插件需要自行写入并跨重启保存凭据时，Node 或嵌入式宿主应选择加密后端和持久挂载。 [Vault 后端与部署输入](../plugin-development/vault.md#host-后端与部署输入)

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

Node Host 可用 `proxyUrl` 设置无凭据的 HTTP(S) 代理 origin，或者用 `null` 清除受管代理并使用 Host 的默认传输。默认允许管理侧调整代理，`allowProxyChanges: false` 将代理选择固定在部署配置。嵌入式 Host 默认使用宿主提供的 Fetch。

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

`config.mode` 决定插件业务配置采用代码还是保存值，`policy.mode` 决定运行策略。两者分别默认为 `declared-first`。已有应用若曾统一设置优先级，迁移时把原值分别填入这两个字段。

| 输入         | 从高到低的优先级                                                  |
| ------------ | ----------------------------------------------------------------- |
| 节点业务配置 | `configMode → config.mode → declared-first`                       |
| 节点策略     | `policyMode → policy.modes[field] → policy.mode → declared-first` |
| 应用级策略   | `policy.modes[field] → policy.mode → declared-first`              |

`declared-first` 采用代码并从保存值补缺。`saved-first` 采用保存值并从代码补缺。`declared-only` 只采用代码。节点配置按叶路径合并，缺失值由 schema 处理。节点的 `policyMode` 同时作用于自动启动、fork 可用性和其作为 consumer 的覆盖。

`config.document` 和 `policy.document` 分别选择配置和策略的文档存储。Node 与嵌入式宿主默认通过 Core FS 读写，数据寿命取决于 ZenFS 挂载。Cloudflare 默认使用当前根的内存文档。`false` 关闭该域 IO，仍可维护会话输入。`{ readOnly: true }` 允许读取并拒绝本实例的管理写入。嵌入应用可用同步 `{ storage: (root) => HostDocumentStorage }` 借用已有存储。缺失文档保留为缺失，坏文档报错并保留文件。

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

Node 和嵌入式宿主填写 `coreConfig.logtape: {}` 开启默认控制台和有界日志缓存。Cloudflare 入口由应用直接配置 LogTape 的输出端。`{ options }` 可调整管理选项。原生 LogTape Config 或同步 root factory 提供完整输出配置，可和管理选项一起写成 `{ input, options }`。省略该字段时插件仍使用 `ctx.logger`，配置后 `root.logging` 提供日志策略、缓存、状态和 flush。

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

应用在 `services` 中为每个用到的方言选择一个驱动。PostgreSQL 的 `postgres()` 和 `pglite()` 都提供 `Pg`，SQLite 的 `libsql()` 和 `d1()` 都提供 `Sqlite`。

使用嵌入式 PGlite 时，安装 `@electric-sql/pglite` 并传入原生选项。省略选项会创建内存数据库。

```ts
import { defineHostApplication } from '@pluxel/host'
import { pglite } from '@pluxel/services/pg/pglite'

export default defineHostApplication(() => ({
	services: [pglite({ dataDir: './data/pglite' })],
}))
```

连接 PostgreSQL 时，安装 `pg` 并选择它的入口。`postgres()` 使用 node-postgres 的环境变量和连接池默认值，也可以传入 `PoolConfig`。

```ts
import { defineHostApplication } from '@pluxel/host'
import { postgres } from '@pluxel/services/pg/postgres'

export default defineHostApplication(({ env }) => ({
	services: [postgres({ connectionString: env.DATABASE_URL })],
}))
```

两个入口都在插件首次 `use()` 时打开连接。传入配置时由 Host 在排空操作后关闭资源。传入已有 `PGlite` 或 `pg.Pool` 实例时，由调用方在 Host 关闭后释放它。插件使用同一份 [Drizzle 表定义和查询](../plugin-development/database.md)。

已有数据库使用 v2 迁移清单时，在升级 Host 前按原发布制品转换各实例的迁移记录。转换保留业务行和物理实例，随后由 Drizzle 追加迁移。[已有数据库的一次性切换](https://github.com/PluxelJS/pluxel/blob/main/engineering/DATABASE.md#现有-v2-数据库的一次性切换)

### 本地 SQLite

安装 `@libsql/client`，将 `libsql()` 加入 Node Host 的 `services`。插件首次 `use()` 时，Host 在指定目录打开属于插件或 fork 的文件并应用迁移。插件停止并排空调用后，Host 关闭连接。

```ts
import { defineHostApplication } from '@pluxel/host'
import { libsql } from '@pluxel/services/sqlite/libsql'

export default defineHostApplication(() => ({
	services: [libsql({ directory: './data/sqlite' })],
}))
```

### Cloudflare D1

为每个托管插件或 fork 配置独立的 D1 数据库。用插件完整地址把 Worker 的原生绑定传给安装器。这里的 `NOTES_DB` 是 Wrangler 的 D1 binding 名称。

```ts
import { env } from 'cloudflare:workers'
import { formatPluginNodeReference } from '@pluxel/core'
import { defineHostApplication } from '@pluxel/host/application'
import { d1 } from '@pluxel/services/sqlite/d1'
import { NotesPlugin } from './notes-plugin'

export default defineHostApplication(() => ({
	plugins: [{ plugin: NotesPlugin, autoStart: true }],
	services: [d1({ [formatPluginNodeReference(NotesPlugin.nodeAddress())]: env.NOTES_DB })],
}))
```

部署端安装 `@pluxel/rolldown`。从 Node 传入目标 D1 binding 和已发布插件的 `dist/database/migrations` 目录，给每个物理库安排一个串行迁移任务，再发布依赖新表结构的 Worker。下面使用 Wrangler 的本地绑定。部署到远端时，显式选择对应环境与 remote binding。[Wrangler getPlatformProxy](https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy)

```ts
import type { D1Database } from '@cloudflare/workers-types'
import { formatPluginNodeReference } from '@pluxel/core'
import { migrateD1 } from '@pluxel/services/sqlite/d1/migrate'
import { getPlatformProxy } from 'wrangler'
import { NotesPlugin } from './dist/notes-plugin.mjs'

const proxy = await getPlatformProxy<{ NOTES_DB: D1Database }>({ remoteBindings: false })
try {
	await migrateD1(proxy.env.NOTES_DB, {
		owner: formatPluginNodeReference(NotesPlugin.nodeAddress()),
		migrationsFolder: './dist/database/migrations',
	})
} finally {
	await proxy.dispose()
}
```

默认 `evolution` 为 `migrations`。插件使用 `reset-on-schema-change` 时，把定义的 `evolution` 传给 `migrateD1()`。它只接管空库或已有相同身份的托管数据库。保留 Wrangler 迁移历史的应用自管库继续使用原有执行器。滚动发布期间，旧 Worker 仍可能执行查询，请按运行中的版本安排兼容的 schema 变更。

D1 始终启用外键。生成的迁移若依赖 `PRAGMA foreign_keys=OFF` 重建父表，部署检查会指出对应迁移。请在发布前改成适合 D1 的 SQL，并验证原有子记录仍在。`defer_foreign_keys` 只能推迟约束检查，删除父表仍会执行 `ON DELETE CASCADE`。[D1 外键语义](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)

<span id="application-private-database"></span>

### 应用私有数据库（Application-Private Database）

对于整个应用统一共享的数据库连接，可由应用在 `prepare()` 钩子中直接建立，并通过自定义服务提供给内部模块使用。

---

<span id="独立-http-host"></span>
<span id="独立-logging-host"></span>

## 独立轻量 Host

在现有 Node 程序中，从 `@pluxel/host` 导入 `startHost`。用 `await using host = await startHost(application, { env })` 启动已声明的应用，作用域结束时释放 Host。启动等待 `prepare`、插件启动验收和 `launch` 完成。默认验收要求预期运行的节点都已就绪，失败时关闭 Host 并抛出含 report 和 status 的 `HostApplicationStartupError`。框架仓库中的 `projects/host-targets/src/node-main.ts` 展示了从启动到调用插件的完整入口。

工厂读取冻结的部署变量 `env` 并为这次启动返回完整的 `coreConfig`。第二个参数可传 `env` 和已解析的 `vaultBindings`。节点的 `envBindings` 在创建 Host 时解析，同一 owner、namespace 和 key 有多个来源时启动失败。需要在插件启动前接入诊断时，使用工厂声明的 `prepare({ host })`。底层装配工具也可通过 `createHost(options)` 准备根，再执行 `host.start()`。[部署输入](#绑定部署环境与-json-文件) · [生产启动判定](#生产启动判定)

---

<span id="嵌入式-host"></span>

## 嵌入式 Host

页面、Dedicated Worker、LLRT 和 React Native 从 `@pluxel/host/embedded` 导入 `startHost`，与 Node 使用同一套插件启停和配置接口。嵌入应用拥有 Host 的寿命，负责在关闭页面或释放引擎前调用 `host.close()`。默认文件和 TinyBase 快照保存在内存，需跨启动保留时应接入持久存储。[选择宿主入口](./runtime-portability.md#选择宿主入口)

## Cloudflare Worker Host

在模块顶层调用一次 `createWorkerHost(application)`，在每次 `fetch`、`scheduled` 或其他事件中调用 `worker.run`。首次事件在有效的 workerd I/O 上下文中启动应用。相同部署变量的并发请求共享这次启动，后续请求直接借用已经运行的插件。每个事件都有自己的 SDK、取消信号和 effects。

```ts
// application.ts 用 createWorkerHost(application) 导出 host，热更新时同步发布 market。
import { host, market } from './application'
import { marketEnvironment, type MarketBindings } from './bindings'

export default {
	fetch(request, env, ctx) {
		return host.run({ ctx, signal: request.signal, env: marketEnvironment(env) }, async (sdk) => {
			const { instance } = await sdk.plugin(market.nodeAddress()).instance()
			return instance.fetch(request, env)
		})
	},
} satisfies ExportedHandler<MarketBindings>
```

`run` 的 `env` 只传影响装配的部署变量，包括节点声明映射的 Secret。驱动按键和值比较快照，顺序不影响复用。变量变化时，新事件等待新根通过启动验收，此前接纳的事件继续使用原根，最后一个事件结束后释放原根。新配置启动失败会返回错误，下一次调用可以重试。请求参数和用户身份属于业务调用。D1、R2、请求体等原生资源直接传给本次借用的插件方法。Cloudflare 更新 bindings 时可能继续使用原 isolate。 [Market 的部署投影](https://github.com/PluxelJS/pluxel/blob/5acd5b22dbe62cf96b50421fa37f95f507d5ce02/projects/plugin-market/src/bindings.ts) · [Cloudflare bindings 更新语义](https://developers.cloudflare.com/workers/runtime-apis/bindings/#making-changes-to-bindings)

`ctx` 提供原生 `waitUntil`，维持首次启动和事件收尾的执行时间。当平台触发传入的 `request.signal` 时，驱动取消本次等待并通知 SDK 作用域，业务方法可将同一信号传给出站 I/O。共享启动和其他请求独立结算。并发冷启动依赖 `handle_cross_request_promise_resolution`，在 2024-10-14 起的 compatibility date 默认开启。HTTP 断连后仍受平台的 `waitUntil` 时限约束。 [Promise 上下文](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#handle-cross-request-promise-resolution-correctly) · [执行上下文](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil) · [入站取消信号](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests)

JSON 和可直接转交的原生响应在回调结束时释放作用域。如果响应流在后续 `pull` 中还要调用插件，在事件参数中加 `responseBody: 'scope'` 并传入 `request.signal`。驱动在接纳事件时固定响应体模式和 signal 引用。作用域保持到流读完、出错或取消，原 signal 仍可随时触发取消。 [流与并发回归](https://github.com/PluxelJS/pluxel/blob/5acd5b22dbe62cf96b50421fa37f95f507d5ce02/packages/host/tests/cloudflare/runtime.test.ts)

本地开发时，插件实现的 Vite 接受边界调用 `worker.updateCatalog(({ env }) => selectPlugins(env), { onGraphCommitted })`。选择函数收到当前已验收根的部署变量，在提交回调中同步发布新的插件引用。驱动等待已接纳的事件和依赖插件的响应体结算，将更新应用到同一个 Host，再放行新事件。首次请求之前接到更新时只发布引用，首次启动读取更新后的声明。服务或应用装配变化走入口重载，开发入口用 `await closeOnHotReload(import.meta.hot, worker)` 在模块替换时排空旧根。`updateCatalog` 和 `close` 均由事件回调之外的所有者调用。示例见框架仓库的 `projects/plugin-market/src/application.ts`。

配置、策略和 TinyBase 的默认内存文档在同一个根上跨请求保留。根的生命周期以 isolate 为上限，平台回收 isolate 时没有可靠的关闭回调。需要跨 isolate 保存的业务数据写入持久 binding。Worker 使用平台 Fetch、部署 Vault 和应用配置的 LogTape 输出。常驻服务的传输函数应在调用时取得可用的 binding。Worker 入口拒绝托管 LogTape、ZenFS 和 Node 代理配置。插件调用 `ctx.fs()` 会得到 `ENOTSUP`。 [Worker 入口与存储](./runtime-portability.md#选择宿主入口)

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
