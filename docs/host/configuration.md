---
title: Host 配置教程
description: 用一份 HostApplication 组合插件、服务、开发工具和生产部署。
---

Host 拥有插件目录、运行策略和服务生命周期。应用入口默认导出 `defineHostApplication(factory)` 声明的 `HostApplicationFactory`；Vite 和生产构建读取同一个入口。
插件只依赖 Core 和实际使用的服务，不需要全局 Runtime。

本页是应用装配的权威教程，各章可独立读取。只改 Plugin 方法、schema 或日志写法时，直接读[插件开发范式](../plugin-development/index.md)。编写自定义服务安装器再读[服务扩展](./services.md)。

| 本次要配置什么                     | 章节                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| 服务与固定插件、启动策略           | [组合](#选择组合)、[应用入口](#应用入口)                                                  |
| Vite 与动态插件来源                | [Vite](#vite-开发)、[动态来源](#动态来源)                                                 |
| 环境变量、JSON 文件与只读覆盖      | [环境](#配置环境变量)、[插件配置绑定](#绑定部署环境与-json-文件)                          |
| 配置及运行策略跨重启保存           | [持久化](#保存配置和运行策略)                                                             |
| Vault 后端、部署凭据与备份         | [后端](#选择后端)、[绑定](#部署凭据)、[备份](#密钥与备份)                                 |
| 控制台、Workbench store 与远程日志 | [日志 plan](#host-logging-plan)、[OTLP](#远程输出原生-logtape-sink)                       |
| 数据库后端与应用共享数据库         | [Backend](#选择-native-postgresql-或-pglite)、[应用数据库](#application-private-database) |
| 轻量独立 Host                      | [Logging](#独立-logging-host)、[HTTP listener](#独立-http-host)                           |
| 生产制品                           | [构建](#生产构建)                                                                         |

以下 `HostApplication`、`servicesPreset()` 和独立 `createHost()` 示例表示不同装配方式；选择一种适合现有项目的入口，不叠加创建第二个 Host。

## 选择组合

- 自定义或轻量宿主：`@pluxel/host`，只安装显式列出的服务。
- 官方服务器组合：`servicesPreset()`，包括 HTTP、Commands、Node artifacts、Workers、Persistence、Vault、Logging、Management 和默认启用的 Workbench。
- 无管理页面的常用基础组合：`standardServices()`，包括 HTTP、Commands、Node artifacts、Workers 和 Persistence。

Database 单独安装；关闭 Workbench 不会关闭插件业务能力。详细服务列表与资源归属见[组合 Host 服务](./services.md)。

## 应用入口

```ts no-twoslash
import { resolve } from 'node:path'
import { pluginNodeAddressOf } from '@pluxel/core'
import { defineHostApplication } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { servicesPreset } from '@pluxel/services/preset'
import { TodoPlugin } from '@app/todo'

export default defineHostApplication(async (startup) => {
	const environment = resolveHostEnv(startup.env)
	return {
		name: 'my-app',
		plugins: [TodoPlugin],
		services: await servicesPreset(startup, {
			persistence: resolve(startup.root, environment.dataRoot, 'persistence'),
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

`configRecords` 和 `state` 默认存于内存。安装 Persistence 不会隐式持久化 Host 的配置或策略；需要保存时，显式提供借用的 document storage，见[保存配置和运行策略](#保存配置和运行策略)。已有持久文档优先于启动 seed。

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
显式设置 `CHOKIDAR_USEPOLLING` / `CHOKIDAR_INTERVAL` 时需符合固定观察策略；冲突会拒绝并给出所需值，规则见[来源观察与关闭](../../engineering/HMR.md#来源发现与资源所有权)。

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

| 变量                                    | 含义                                                              |
| --------------------------------------- | ----------------------------------------------------------------- |
| `PLUXEL_DATA_ROOT`                      | 数据目录默认值，省略为 `.pluxel`；应用决定子目录                  |
| `PLUXEL_HOST_BIND` / `PLUXEL_HOST_PORT` | 物理 listener 地址与端口                                          |
| `PLUXEL_WORKBENCH`                      | 由应用传给服务组合的页面开关                                      |
| `PORTLESS_URL`                          | 开发外部 origin；存在时可采用 `HOST` / `PORT`，显式 Pluxel 值优先 |

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

Canonical static entry 直接声明部署名称；不要在配置工厂中重复解析类型或拼装 Plugin address：

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

Static production build 从同一声明生成 `.env.example`，只输出说明和注释状态的空 placeholder，不读取构建机环境或复制 schema default。`envBindings` 使用 direct array literal，每项调用从 `@pluxel/host` 导入的 `envBinding`，第一个参数是静态目录中的 Plugin 标识符，第二个参数直接声明 `config`/`vault` 与其 `schema`、`mapping`；mapping 使用对象树和字符串 literal。动态分支不作为构建期来源清单。

直接消费 runtime control-plane `ConfigResult` 时按 discriminant 处理返回值：query 返回 `config` 和 `defaults`，并标记
`saved: false`；成功 mutation 返回已持久化的 `config`、`application` 与 apply report，不再重复返回 defaults。
`validation_failed` 只有在 defaults 可以独立计算时才带可选 `defaults`。持久化失败不会发布 staged revision，也不会把未确认的值注入
Plugin generation。

## Persistence 文件契约

`@pluxel/services/persistence` 的内存与 Node 后端使用相同的相对分层路径：namespace 和 key 保留原字面（包括 `@pluxel/wretch`），不 trim、替换字符或猜测绝对路径。空段、`.`、`..`、反斜杠、冒号和控制字符会抛出 `TypeError`；仅 `list()` / `list('')` 的空前缀表示 namespace 根。namespace 是路径前缀，不是互相隔离的权限域，例如 `a/b` 位于 `a` 之下。

`list(prefix)` 按 key 排序返回目录的直接子项，包含 `file` 与 `directory`；缺失目录返回空集合，文件不能作为列举前缀。`stat(key)` 可识别文件与目录；内存后端在写入嵌套文件时建立目录，删除最后一个文件不会删除目录。`delete()` 只删除文件，缺失文件无操作；`get()` / `getText()` 的缺失结果为 `undefined`，读取目录失败。`size` / `updatedAt` 是后端可提供的 metadata，不保证存在。

Node 后端在创建时固定 root（省略时使用当时的 cwd）。路径检查限制字面路径，不承诺防御宿主在 root 下放置的符号链接；文件树由宿主控制。自定义后端需实现同一目录与完成语义。`readonly` 在实际 `put()` / `delete()` 边界拒绝操作并给出 `PersistenceError.code === 'READONLY'`，不依赖调用方先执行 `preflight()`。

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

Host 应用解析器从本次 `startup.env` 读取显式 `envBindings`，文件输入来自 `fileBindings`。普通配置优先级为基础对象/文件 < 管理保存值 < env，合并后由 schema 校验；env 控制的路径只读且不落盘。Vault env/file 绑定是整记录只读。底层 `createHost()` 不隐式读取进程环境。

## 选择后端

可写记录使用加密后端，并显式安装 Persistence：

```ts
services: [
	persistence('./data/persistence'),
	vault({
		deployIdentity: startup.env.PLUXEL_VAULT_DEPLOY_IDENTITY,
	}),
]
```

只有部署凭据时选择 `vault({ backend: 'bindings' })`。它不依赖 Persistence，不创建密钥或磁盘文件；没有绑定的记录不存在，所有写入拒绝。`servicesPreset(startup, options)` 显式从该 startup 环境读取部署解锁身份，`options.vault` 可以覆盖后端和部署解锁身份。直接 `vault()` 不读取进程环境。

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

备份与回滚应在 Host 停止后整体复制 Persistence 的 `vault` namespace：包括 `security/identity.json`、`global/keys.age`、`global/state.enc` 和 `global/blobs/`。不要分别恢复不匹配的 key envelope 与数据文件；不支持跨进程 writer 或跨 config/Vault 事务。

## 可选管理页面与服务配套插件

Vault 管理页由同一个服务包的 `@pluxel/services/plugins` 入口提供，不需要额外安装 UI 插件包。
`VaultAdminPlugin` 是普通 Plugin：它使用 Vault 能力并发布 Workbench 页面，管理操作仍通过 Management 的已认证会话执行。

```ts no-twoslash
import { pluginNodeAddressOf } from '@pluxel/core'
import { defineHostApplication } from '@pluxel/host'
import { servicesPreset } from '@pluxel/services/preset'
import { VaultAdminPlugin } from '@pluxel/services/plugins'

export default defineHostApplication(async (startup) => ({
	name: 'vault-example',
	services: await servicesPreset(startup, { persistence: '.pluxel/persistence' }),
	plugins: [VaultAdminPlugin],
	state: { initial: { autoStart: [pluginNodeAddressOf(VaultAdminPlugin)] } },
}))
```

在正常 Host 开发或生产入口启动应用后，登录 Workbench 即可访问 Vault 页面。缺少 Vault 服务时插件启动失败；关闭 Workbench 时不发布页面，Vault 服务仍独立运行。页面撤回随 Plugin 停止，后端资源随 Host 服务关闭，不建立第二套生命周期。

第三方服务可以采用同样的结构：服务入口负责业务能力，一个显式 `./plugins` 导出集中提供可选配套 Plugin；应用选择服务、插件与启动策略。基础服务入口不导入 `/plugins`，页面组件不在服务器入口求值。同一个 Plugin 只从一个公开入口具名导出，不能再从根入口重复转发。包内路径、构建和测试示例见 `packages/services/src/plugins.ts` 与 `packages/services/tests/vault-plugin.test.ts`。

## Host logging plan

`servicesPreset()` 安装默认日志方案。自定义时通过它的 `logging` 选项传入完整 plan；自行组合的 Host 使用下文 `logging(plan)` 服务：

```ts no-twoslash
logging: {
	root: {
		profile: 'production',
		debugTopics: ['cache:lookup'],
	},
	sinks: {
		console: {
			kind: 'console',
			format: 'json',
			caller: false,
			timezone: 'utc',
		},
	},
	routes: {
		runtime: [{ sink: 'console', minLevel: 'info' }],
		plugins: [{ sink: 'console', minLevel: 'trace' }],
		debug: [{ sink: 'console', minLevel: 'trace' }],
		meta: [{ sink: 'console', minLevel: 'warning' }],
	},
}
```

`plugins` route 可以保持较低门槛，再由 O(1) Plugin policy 决定实际等级。静默输出使用空 `sinks` 和四个空 routes，仍保留 Context identity 和管理所有权。`logging` 是完整 plan 替换，不合并 preset 默认的 console/store。

部署与 Workbench store 选项见 [配置插件宿主](./configuration.md)，仓库内部的遥测集成见 [OpenTelemetry 预览](../plugins/otel.md)，该包目前不供外部项目安装。

## 远程输出：原生 LogTape sink

Host 的 `kind: 'logtape'` 直接接受原生 `Sink`，保留 `LogRecord`、formatter 和 sink 的释放协议。Pluxel 只管理 Context 身份、路由、插件 policy 与安装寿命；需要自定义格式、脱敏或远程输出时，直接组合上游 sink，不另建 logger 或调用全局 `configure()`。

推荐用 `@logtape/otel` 对接 OTLP 后端。应用按需安装以下依赖；Pluxel 默认不加载网络 exporter：

```sh
pnpm add @logtape/otel@^2.3.10 @opentelemetry/sdk-logs@^0.222.0 @opentelemetry/resources@^2.11.0 @opentelemetry/exporter-logs-otlp-proto@^0.222.0
```

在启动环境中设置完整的 logs endpoint；VictoriaLogs 示例：

```sh
OTEL_SERVICE_NAME=orders
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://victorialogs:9428/insert/opentelemetry/v1/logs
```

下面是独立 Host 的完整装配。使用原生批量 processor；认证和超时沿用 exporter 的标准 `OTEL_EXPORTER_OTLP_LOGS_HEADERS`、`OTEL_EXPORTER_OTLP_LOGS_TIMEOUT` 环境变量。显式选择的 exporter 使用 HTTP/protobuf。

```ts no-twoslash
import { getOpenTelemetrySink } from '@logtape/otel'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import { createHost } from '@pluxel/host'
import { logging } from '@pluxel/services/logging'

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
	services: [
		logging({
			root: { profile: 'production' },
			sinks: {
				remote: { kind: 'logtape', label: 'OTLP', sink, caller: false },
				console: { kind: 'console', format: 'json', caller: false, timezone: 'utc' },
				memory: { kind: 'store', caller: false },
			},
			routes: {
				runtime: [
					{ sink: 'remote', minLevel: 'info' },
					{ sink: 'memory', minLevel: 'info' },
				],
				plugins: [
					{ sink: 'remote', minLevel: 'trace' },
					{ sink: 'memory', minLevel: 'trace' },
				],
				debug: [],
				meta: [{ sink: 'console', minLevel: 'warning' }],
			},
		}),
	],
}).catch(async (error) => {
	// Also cover failures before Logging takes ownership; SDK shutdown is idempotent.
	await provider.shutdown()
	throw error
})
try {
	host.ctx.logger.info('Host ready')
} finally {
	await host.close()
}
```

使用 `servicesPreset()` 时把同一个 plan 传给 `logging` 选项，替换上面的独立 service 装配；不要重复安装 Logging。`memory` 保留 Workbench/开发控制台的有界查询，`diagnostics: true` 将进程级 OTel SDK diagnostics 接入 LogTape，`meta` 输出到本地以便排查 exporter，不回送远程 sink。

- 每个 Host 创建独立 sink/provider。Host 关闭先停止插件，再通过 LogTape async disposal 关闭 sink；此版本的 `getOpenTelemetrySink` **也会 shutdown 传入的 provider**，不要传入其他组件仍在使用的共享 provider。
- 运行中需要立即发送时使用原生 `await provider.forceFlush()`。`host.ctx.logging.flush()` 只刷新 store 与 policy，不是远程送达确认。批量队列、超时、重试及丢弃行为遵循 OTel SDK；没有持久队列或无损交付保证。
- 原生 sink 保留 category（含插件身份）和结构化属性，默认把 Error 投影为 OTel exception 属性；需要保留 cause/自定义字段时使用上游 `exceptionAttributes: 'raw'`。后端 stream 字段选择稳定的 service/deployment 属性，不使用每次启动变化的 rootId 或 request ID。
- 本方案不依赖 `@pluxel/otel` Plugin；该 Plugin 的 telemetry logger 与 `ctx.logger` 是不同入口。

默认示例显式使用 provider：上游自动创建模式使用逐条 processor，且未配置 endpoint 时会成为 no-op。更多参数直接查看 [LogTape OTel sink](https://logtape.org/sinks/otel)、[OTel SDK](https://open-telemetry.github.io/opentelemetry-js/modules/_opentelemetry_sdk-logs.html) 和 [VictoriaLogs OTLP 接入](https://docs.victoriametrics.com/victorialogs/data-ingestion/opentelemetry/)。

若部署已有采集器，直接使用 JSON console 或 JSONL file，由采集器转发即可。Pluxel 不提供供归档抓取的 HTTP 日志端点；Workbench store 的游标查询用于有界诊断，不承担可靠 pull 归档。

## 独立 Logging Host

```ts
import { createHost } from '@pluxel/host'
import { logging } from '@pluxel/services/logging'

const host = await createHost({
	plugins: [],
	services: [
		logging({
			root: { profile: 'application' },
			sinks: { memory: { kind: 'store', caller: false } },
			routes: {
				runtime: [{ sink: 'memory', minLevel: 'info' }],
				plugins: [{ sink: 'memory', minLevel: 'trace' }],
				debug: [],
				meta: [],
			},
		}),
	],
})

host.ctx.logger.info('Host ready')
host.ctx.logging.flushStores()
const recent = host.ctx.logging.stores.getOrCreate('default').tailWindow(100)
await host.close()
```

日志查询和 policy 都属于所选 Host 的 `host.ctx.logging`，不依赖 Management。
需要持久化 policy 时，把 `createPluginLogPolicyStore(namespace)` 作为 `logging(plan, { policyStore })`
的选项传入；namespace 是借用资源，关闭由应用或其存储服务负责。
删除 fork 会在同一 Host 队列内清理日志 policy；写入失败时保留 fork，恢复存储后可重试。
同一进程仍只允许一个活动日志 Host，第二个安装失败不会影响第一个。

### 宿主安装与访问

Host 负责安装、绑定和关闭进程日志 owner。通过 `host.ctx.logging` 或控制台的 `dev.ctx.require(Logging)` 访问这一个 manager；控制台查询不创建第二个日志 owner。

## 在 Workbench 查看与归档

Workbench 使用同一份有界日志存储，通过已认证的 Management 会话查询与 follow，不增加 HTTP/SSE 日志 API。
日志携带 node address、reference 和可读标签；range 按传输预算分页，超大单条记录明确标记 payload 截断。
需要进程外归档时配置 file 或 OpenTelemetry sink；Plugin 的业务 HTTP 不负责暴露宿主日志。

## 独立 HTTP Host

安装 `@pluxel/services` 与 `elysia@2.0.0-beta.19`；Elysia 是 HTTP 服务的可选 peer，不会随其他服务安装。

当前 Elysia 的发布前 schema 编译需要 TypeBox 1.3.23。生成项目已包含该约束；手动组装 pnpm 宿主时，在 `pnpm-workspace.yaml` 中加入：

```yaml
overrides:
  typebox: 1.3.23
```

TypeBox 1.3.24 起删除了 Elysia 编译器仍使用的字段；待 Elysia 适配后再移除此约束。

`elysia()` 安装 generation-scoped Elysia application；生产 Node 接线统一使用 srvx。
`listenElysia()` 使用 Host 的请求分发，并拥有 listener 和 Host 的关闭；不需要重复传 handler。
可选 `publicDir` 在创建 listener 时固定（相对路径以当时 cwd 解析），只在非保留路径的业务 404 后服务编译资源和 SPA fallback。

```ts no-twoslash
import { createHost } from '@pluxel/host'
import { elysia } from '@pluxel/services/elysia'

const host = await createHost({ plugins: [MyRoutes], services: [elysia()] })
await host.startNode(MyRoutesAddress)
const listener = await listenElysia(host, { hostname: '127.0.0.1', port: 3000 })
// 应用结束时关闭 listener 与 Host。
await listener.close()
```

需要直接调用 Fetch 请求边界时，使用 `/elysia` 的 `createElysiaHandler(host)`；调用者负责关闭 Host。
`ElysiaApp` 仅供 Plugin/Part 使用。底层 directory、endpoint/fallback 和 carrier 接线属于框架内部，
不提供第二套公共 server API 或可替换 adapter。Management 与 Workbench 复用同一请求分发。

宿主拥有 listener、port、process shutdown 和物理 server policy，部署 ingress、反向代理或平台拥有 TLS。Plugin 调用 application 的 `listen()` / `stop()` 会立即
失败；`setup()` / `cleanup()` 也会立即失败，因为 Elysia 2 beta.19 尚未公开供外部 carrier 驱动的 attach/detach epoch。Plugin 也不
调用 Server view 的 `stop()`、`reload()`、`ref()` 或 `unref()`，不选择 srvx/runtime adapter。srvx 的接入属于宿主 carrier 工作，
不是 Plugin 的第二套 Web 作者 API。

handler 取得的 `server` 是 generation-scoped、carrier-backed view。`url`、`port`、`hostname` 和 `development` 反映当前宿主 listener；
`id` 是本 generation 内稳定的 virtual-server value，不是物理 listener identity。`server.url` 每次返回独立 `URL`，修改它不会重配
listener。Node carrier 还支持 `server.requestIP(request)` 读取该请求的远端 address、port 和 IP family；把其他来源或已经脱离当前
owner invocation 的 `Request` 传入会明确失败。

## Application-private database

当 fixed catalog、schema 和部署都由同一团队维护时，把 schema、client、repositories、migration 和 connection lifecycle 放进普通 application-private package，例如 `@app/database`。这个 package 自己声明 ORM 和 driver dependency；不要只把依赖安装在 workspace root，再让子包隐式使用。

应用服务列表不安装 `database()`，使误用 `ctx.require(Database)` 的 Plugin 直接启动失败；production freezer 同时设置 `managedDatabaseDrivers: []`，避免把未使用的 PGlite 与 `pg` package 复制进发行物。两处配置分别约束运行时 capability 与构建闭包，必须保持一致。

内置 Plugin 优先消费 repository 或 application service。只有确实需要构造查询时才暴露 ORM client；不要让每个 Plugin 各自读取 DSN、创建 pool 或运行 migration。

### 整个应用依赖数据库

如果没有数据库，整个 static application 就没有可运行的核心功能，数据库是 host-owned root resource：static `prepare()` 必须在 Plugin graph 启动前完成连接、migration 和必要 preflight；失败直接终止本次 host startup。成功实例按 root Context 绑定，关闭登记到 root effects，不能归属任一 consumer Plugin。

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

`appDatabaseFor(ctx)` 的参数既保留 root 隔离和完整返回类型，也在调用点诚实表达 application-private dependency。不要用 declaration merging 增加 `ctx.appDatabase`；static application 的泛型不能反向改变独立编译 Plugin 的 Context shape。

应用入口统一决定部署路径，同时供宿主 Persistence 和 application database 使用：

```ts no-twoslash
import { resolve } from 'node:path'
import { defineHostApplication } from '@pluxel/host'
import { prepareAppDatabase } from '@app/database'
import { standardServices } from '@pluxel/services'

function storagePaths({ env }) {
	// 部署时传入发行目录外的绝对路径。
	const root = resolve(env.APP_DATA_ROOT ?? './data')
	return {
		hostPersistence: resolve(root, 'runtime'),
		applicationDatabase: resolve(root, 'application.sqlite'),
	}
}

export default defineHostApplication((startup) => {
	return {
		name: 'application',
		plugins: [BillingPlugin, AuditPlugin],
		services: standardServices({ persistence: storagePaths(startup).hostPersistence }),
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

SQLite path、DSN、TLS 和 pool options 从 `startup.env`、`bindings` 或部署配置显式解析，不从 Context 猜测。Persistence 是 `namespace/get/put` 抽象，backend 可能是 memory、readonly 或 custom，不保证存在可打开的文件目录。

`prepare()` 不是通用 service lifecycle：这里只表达“数据库是整个应用的硬 readiness 前提”。数据库 package 负责领域初始化，root effects 负责 acquisition rollback、正常 stop 和 shutdown；consumer replacement 不能关闭共享实例。

### 只有部分 Plugin 依赖数据库

如果数据库失败时无关 Plugin 仍应运行，把数据库建模为 application-private provider Plugin，并让 consumer 通过 constructor 声明 required dependency。provider 在 `init()` 打开和迁移数据库，并立即把关闭登记到自己的 effects；provider failure 只阻塞 dependents。不要同时保留 root `prepare()` 和 provider Plugin 两套所有权。

这条路径可以使用 SQLite 或其他数据库，但应用必须自行负责 migration 并发、连接恢复、备份、durability 和 shutdown。不要把 application client 包装成 `ctx.database`，否则会让调用者误以为它具备 managed Plugin database 的 owner isolation 与 replacement 语义。

## 选择 native PostgreSQL 或 PGlite

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

```ts no-twoslash
import { defineConfig } from 'tsdown'
import { buildPreset } from '@pluxel/services/build'

export default defineConfig({
	entry: './src/app.ts',
	plugins: [buildPreset()],
})
```

自定义组合使用 `@pluxel/rolldown` 的 `pluxel()`。生产 bootstrap 通过 `@pluxel/host` 启动同一应用，HTTP handler/listener 属于 `@pluxel/services/elysia/*`。
`delivery` 独立选择交付边界：默认 `standalone` 内联框架和固定插件，`launcher` 可选 `node`、`fetch` 或 `host`，不能声明 sources。`modules` 编译本包模块、保留真实包 imports 与公开 Plugin identity，并导出应用工厂；它不自动启动，也不接受 launcher/residualDependencies。资源 `variant` 与服务安装是独立决定。

modules 同时支持 `package.json#imports`：本包目标进入编译，外部目标保留包依赖；搬移输出后不依赖原来的源码映射。

有 sources 的应用（包括 create 模板）使用：

```ts no-twoslash
export default defineConfig({
	entry: './src/app.ts',
	plugins: [buildPreset({ delivery: 'modules' })],
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

Core/Host 绑定启动器安装；`sharedPackages` 中的其他包相对 startup.root 解析，包括合法 exports，应用须声明所使用的共享包依赖。官方清单来自 `@pluxel/services/sources`，因此官方模板直接声明 Services、Workbench、Commands、Elysia、`@sinclair/typebox`、`typebox` 和 `exact-mirror`；不要依赖工作区 hoist 提供这些安装事实。实际安装版本及 importer 声明必须兼容，错误版本会拒绝；清单不安装服务。自定义服务可以追加包名。Workbench publisher 的 capnweb 由领域检查绑定到所选 Workbench，私有 RPC 保留自身解析。

交付和搬离工作区验证见[发行物](../development/distribution.md)。Node 已有回归覆盖；其他平台需要独立验证网络与原生依赖，不能只凭 Fetch 类型兼容推定支持。

## 测试

插件测试统一使用 `@pluxel/test` 的 `createTestHost()`，按需显式组合服务。它们是隔离宿主，不能代表已经运行的开发应用。具体调用见[测试插件](../plugin-development/testing.md)。
