---
title: 把 Pluxel 接入现有项目
description: 为现有项目选择 static 或 dynamic host，并配置 Plugin 清单、运行状态和 Workbench。
---

宿主负责加载插件、持久化配置和提供网络端口。把 Pluxel 加入现有 TypeScript 项目时，先用本页的 static 示例启动一个插件；
只有确实要在运行中增删插件文件，才需要 dynamic。

从零创建应用，先完成[快速开始](./index.md)，模板已经配置好 Vite、工作台和构建命令。
本页假设现有项目使用 ESM（`package.json` 包含 `"type": "module"`），并已安装 Node.js 24 或以上与 pnpm。
源码仓库开发请沿用项目的 `mise.toml`，先运行 `mise install`。

## 选择宿主模式

| 场景                                           | 选择         |
| ---------------------------------------------- | ------------ |
| 产品内置 Plugin、清单固定、需要审计和冻结      | 静态模式     |
| 需要在宿主运行期间增加或删除 Plugin 文件入口   | 动态模式     |
| 需要把包含动态 Plugin 来源的宿主部署到其他环境 | 动态发行模式 |

不要根据是否需要 HMR 选择宿主模式：两种模式在开发期都支持模块热更新，也使用相同的 generation 清理流程。业务 Plugin 不需要为两种模式编写不同实现。

下面的最小 static 示例先关闭 Workbench，确认插件可以启动；需要界面时再按[工作台配置](#workbench-与-management-access)开启。

## Static host

```sh package-install
npx nypm add @pluxel/runtime @pluxel/runtime-static
```

```sh package-install
npx nypm add -D @pluxel/rolldown vite tsdown
```

先创建一个本地插件 `src/OrdersPlugin.ts`：

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ displayName: 'Orders' })
export class OrdersPlugin extends BasePlugin {
	protected override init() {
		this.ctx.logger.info('Orders ready')
	}
}
```

### 定义宿主入口

```ts no-twoslash
// src/pluxel.static.ts
import { pluginNodeAddressOf } from '@pluxel/runtime'
import { defineProduct } from '@pluxel/runtime/product'
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { OrdersPlugin } from './OrdersPlugin.ts'

export const product = defineProduct({
	displayName: 'Rhythm',
	publisher: 'Example Company',
})

export default defineStaticRuntime({
	name: 'rhythm',
	plugins: [OrdersPlugin],
	configure() {
		return {
			runtimeState: {
				snapshot: { autoStart: [pluginNodeAddressOf(OrdersPlugin)] },
			},
			persistence: '.pluxel/persistence',
			workbench: false,
		}
	},
})
```

### 启动并确认结果

```ts twoslash
// vite.config.ts
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [staticRuntimeVitePlugin({ entry: './src/pluxel.static.ts' })],
})
```

运行：

```sh
pnpm exec vite
```

终端应显示 Vite 地址和 `Orders ready`。这个最小插件没有业务 HTTP 页面，也没有开启 Workbench；
看见默认 404 不代表插件启动失败。为插件增加路由见 [HTTP](../runtime/http.md)，启用管理界面见下文。

修改日志文案并保存，应看到插件重新初始化。若没有启动，先检查 `plugins` 是否包含它，以及 `autoStart` 是否包含它的节点地址。
插件出现在清单中并不等于自动启动。

### 入口还可以配置什么

`plugins` 列出此应用包含哪些插件；`runtimeState.snapshot.autoStart` 决定首次启动哪些插件。
`configure()` 每次宿主启动时读取部署环境，并返回持久化、日志、工作台和初始配置等设置。
工作台中的本次进程启停操作不自动改写下次启动策略。

Static Vite host 与 `variant: 'workbench'` 产物默认启用 Workbench；本例通过 `workbench: false` 显式关闭。
`PLUXEL_WORKBENCH=false` 也可在启动时关闭它。
`PLUXEL_DATA_ROOT` 会覆盖 string/omitted persistence root，但不会替换 application 明确注入的 custom backend。

`prepare()` 用于必须在 Plugin graph 启动前成功的 application-owned prerequisite。它在 runtime services ready 后执行；抛错会终止 startup 并清理已经创建的 host resources。没有应用数据库就无法运行的 static application 在这里打开、迁移并把关闭登记到 root effects；只有部分 Plugin 使用的数据库应成为 provider Plugin，由 graph 隔离失败。不要在 `prepare()` 中替 Plugin 调用 `ctx.database.use()`；两种数据所有权的选择见[数据库与数据归属](../runtime/database.md)。

不要把 `root` 或 `workbench` 直接写进 static application 顶层。`configure()` 每次宿主启动都会重新读取 env、bindings 与 deployment。

`product` 是 canonical module 的可选 named export，不放进 `defineStaticRuntime()`。Static 与 dynamic 使用同一个 `defineProduct()` contract。

### 初始化 Plugin config 的部署变量

少量部署变量需要初始化 Plugin config 时，在 canonical entry 使用 `configEnvironmentBootstrap`，并把 Plugin 实际交给 `configs.use()` 的同一个 exported schema 传给 `bindConfigEnvironment()`：

```ts no-twoslash
import { bindConfigEnvironment, defineStaticRuntime } from '@pluxel/runtime-static'
import { OrdersConfig, OrdersPlugin } from '@acme/orders'

export default defineStaticRuntime({
	name: 'orders',
	plugins: [OrdersPlugin],
	configEnvironmentBootstrap: [
		bindConfigEnvironment(OrdersPlugin, OrdersConfig, {
			endpoint: 'ORDERS_ENDPOINT',
			concurrency: 'ORDERS_CONCURRENCY',
		}),
	],
	configure: () => ({ persistence: '.pluxel/persistence' }),
})
```

这里的 environment 是 config store 的一次性 bootstrap transport；已有 persisted config 始终优先。Host-only 的 persistence、Workbench、logging 或 platform policy 仍在 `configure()` 读取自己的环境值。完整的 decoder、缺失值、优先级和 secret 边界见[配置模型](./configuration.md#用部署环境初始化-static-config)。

### Vite development

Vite SSR 加载 canonical entry。Plugin module 变化执行 catalog HMR；entry/configure dependency 变化重建 host；Workbench remote 由开发 compiler 增量构建。

源码修改后的保留旧实例、失败恢复和更新状态见 [HMR 失败与自动恢复](../development/tooling.md#hmr-失败与自动恢复)。
工作台中“目录 HMR”、来源和最近更新的读取方法见 [目录诊断](../workbench/operations.md#内置-plugin-目录诊断)。

React、业务 alias 和普通 Vite plugin 属于 host `vite.config.ts`。不要复制 Pluxel semantic transform、SSR package classifier 或 runtime source alias。

包含业务 SPA 的 host 应把 Workbench 安装到非根路径，保持一份 Vite listener、一套 HMR graph 和一个浏览器 origin：

```ts no-twoslash
workbench: {
	enabled: true,
	uiBasePath: '/__pluxel/workbench',
}
```

此时 `/` 是 Application，`/__pluxel/workbench` 是 Workbench。它们是同一 origin 上的两个绝对 URL pathname，不是两个端口；
Workbench 的 cookie、认证、Cap'n Web WebSocket、Module Federation assets 和 Vite HMR 因而不需要跨源代理。Workbench-only host
仍可让 Workbench 拥有 `/`。

`/__pluxel/**` 是唯一由框架强制保留的路径空间。Plugin 精确命中的业务 HTTP/WS route 优先于产品 SPA；未命中的 document
navigation 才进入 Vite SPA fallback。Pluxel 不强制 `/api` 前缀，也不按 Plugin identity 改写产品 URL。完整边界见
[Plugin HTTP 与产品 SPA 共用 origin](../runtime/http.md#与产品-spa-和-workbench-共用-origin)。

开发 workspace 可以用 [Portless](https://github.com/vercel-labs/portless) 为这一个 listener 提供稳定的命名入口。`portless`
在 child process 中注入合法的 `PORTLESS_URL`、`HOST` 和 `PORT` 后，Pluxel 会让 Vite 监听该物理地址，并显示两个可访问入口：

```text
➜  Application: http://rhythm.localhost:1355/
➜  Workbench:   http://rhythm.localhost:1355/__pluxel/workbench
```

Portless 只负责开发期 ingress 和名称，不创建第二个 runtime listener。listener 优先级为 application 默认值 < Portless
`HOST`/`PORT` < 显式 `PLUXEL_HOST_BIND`/`PLUXEL_HOST_PORT`；只有 `PORTLESS_URL` 是不带 path、query、fragment 或凭据的
HTTP(S) origin 时，普通 `HOST`/`PORT` 才会被视为 Portless 注入。需要直接运行 Vite 时使用项目提供的 `dev:direct`，或以
`PORTLESS=0 pnpm dev` 临时绕过 Portless。

Pluxel starter 默认先执行 `portless proxy start --port 1355 --no-tls`，避免占用特权端口、sudo 和本地 CA/OpenSSL 依赖。普通 loopback
开发、Vite HMR、同源 Application/Workbench/Plugin route 与非 `Secure` cookie 不需要 TLS。只有需要验证 `Secure` cookie、
`SameSite=None`、远程 Management carrier 或第三方 OAuth HTTPS callback 时，才应显式启动 HTTPS ingress。

如果产品 SPA 本身部署在 `/xxx/`，必须同时把 Vite asset `base` 和 Router basename/history base 配为该 mount point，并让
服务器对 `/xxx/*` 做 history fallback。浏览器看到的 `/xxx/aaa` 是相对于域名根的绝对 pathname；Router 不会从反向代理自动推断
`/xxx`。这与 Workbench 独立占用 `/__pluxel/workbench` 的路径仲裁是两个不同配置，不应靠相对 URL 偶然工作。

### Production application

```ts twoslash
// tsdown.config.ts
import { staticApplication } from '@pluxel/rolldown/build'

export default staticApplication({
	entry: './src/pluxel.static.ts',
	variant: 'headless',
	target: 'node',
})
```

`variant` 决定 artifact 是否包含 Workbench shell/remotes：

- `headless`：没有 Workbench artifact，startup 不能开启 UI；
- `workbench`：artifact 包含 UI，startup config 仍可关闭它。

生产产物包含 Node server entry、fixed Plugin closure、deployment manifest 和所需 Node dependencies。目标机不再安装 Pluxel packages。

构建总会生成 root `.env.example`，列出官方 host 变量；存在 `configEnvironmentBootstrap` 时还会追加对应 Plugin bootstrap 变量。它是 distribution inventory 中的普通 immutable asset；不会包含构建机 value，也不会生成或加载 `.env`。如果其他 assembly input 已占用该保留路径，构建会失败而不是覆盖。

### 统一 host environment

下游不要直接读取 `process.env`。Pluxel 转导 `std-env` 的 universal `env`，并另外提供已经校验和补全默认值的 `hostEnv`。同一入口可在 Node、Bun、Deno 与 Worker-compatible runtime 中使用：

```ts no-twoslash
import { env, hostEnv } from '@pluxel/runtime/environment'

console.log(env.MY_APPLICATION_VARIABLE)
console.log(hostEnv.dataRoot, hostEnv.workbench)
```

`env` 是与 `std-env` 相同的原始字符串对象；`hostEnv` 是 Pluxel 官方字段的有效值，不是第二份可变环境。Launcher 测试或 adapter 需要解析显式输入时使用 `resolveHostEnv(input)`。`PluxelEnvironmentVariables` 已声明 `PLUXEL_DATA_ROOT`、`PLUXEL_WORKBENCH`、listener、config、Vault 与 HMR 变量；应用可以用 module augmentation 添加自己的部署变量。官方变量的行为为：

```ts no-twoslash
declare module '@pluxel/runtime/environment' {
	interface PluxelEnvironmentVariables {
		readonly DATABASE_URL?: string
	}
}
```

| 变量                                    | 行为                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `PLUXEL_DATA_ROOT`                      | 共享 Host data root；默认 `.pluxel`，Pluxel persistence 位于其 `persistence/` 子目录           |
| `PLUXEL_WORKBENCH`                      | 严格为 `true` 或 `false`；覆盖 Workbench startup policy，但不能开启 headless 产物中不存在的 UI |
| `PLUXEL_HOST_BIND` / `PLUXEL_HOST_PORT` | Node/Vite physical listener；port 必须为 `0..65535` 整数；显式值覆盖 Portless 注入             |
| `PORTLESS_URL` / `HOST` / `PORT`        | Portless development ingress；URL 必须是 HTTP(S) origin，URL 有效时才采用其 listener bind/port |

外部 database、cache 或 sidecar 需要与 Pluxel 放在同一数据树时直接消费 `hostEnv.dataRoot`，并相对同一个 Host root 使用自己拥有的子目录（例如 `database/`）；不要读取 `env.PLUXEL_DATA_ROOT` 并自行补默认值。应用显式选择不同的 persistence path/backend 表示有意偏离共享 root；部署希望统一时设置 `PLUXEL_DATA_ROOT`。

变量优先级为 Pluxel/build 默认值 < application string path/Workbench policy < 显式 `PLUXEL_DATA_ROOT`/`PLUXEL_WORKBENCH`。环境值非法时启动 fail-fast；不会静默回退。

freezer 默认同时携带 managed database 的 PGlite 与 PostgreSQL driver，使本机开发/测试可选择 PGlite、部署可选择 PostgreSQL。部署若只支持部分 driver，使用 `managedDatabaseDrivers` 收窄闭包；完全使用 application-private database 时传空数组，并在 runtime config 中设置 `database: false`：

```ts twoslash
import { staticApplication } from '@pluxel/rolldown/build'

export default staticApplication({
	entry: './src/pluxel.static.ts',
	managedDatabaseDrivers: [],
})
```

这个列表必须覆盖 `configure()` 可能返回的每个 managed database driver。未列出的 driver 不会复制进发行物；Plugin 首次实际取得该 database capability 时会进入明确的 absent module，并报告该 deployment 未包含对应 driver。

需要生产 source map 时可同时设置 `sourcemap: true` 与 `sourcemapExcludeSources: true`。后者保留路径和行列映射，但不在每份 `.map` 中嵌入完整源码；目标环境另有可信源码归档时通常应开启。

最终 inventory、签名和 delivery marker 见 [Static 发行物](../development/distribution.md)。

## Dynamic host

```sh package-install
npx nypm add @pluxel/runtime @pluxel/runtime-dynamic
```

```sh package-install
npx nypm add -D vite
```

### 配置动态插件来源

```ts no-twoslash
// src/pluxel.dynamic.ts
import { pluginNodeAddressOf } from '@pluxel/runtime'
import { defineProduct } from '@pluxel/runtime/product'
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'
import { HostOperationsPlugin } from './HostOperationsPlugin.ts'

export const product = defineProduct({
	displayName: 'Rhythm',
	publisher: 'Example Company',
})

export default defineDynamicRuntimeConfig({
	root: process.cwd(),
	plugins: [HostOperationsPlugin],
	runtimeState: {
		snapshot: { autoStart: [pluginNodeAddressOf(HostOperationsPlugin)] },
	},
	configPath: 'pluxel.loader.hmr.jsonc',
	profile: 'dev',
	sources: [
		{ kind: 'file', path: 'plugins/local.ts' },
		{
			kind: 'directory',
			path: '.pluxel/managed-plugins/entries',
			include: ['*.mjs'],
		},
	],
	logsDir: 'logs',
	workbench: {
		enabled: true,
	},
})
```

`plugins` 是宿主显式 import 的 fixed catalog；`sources` 是 mutable file entries。两者只声明 code availability，不会隐式自动启动 Plugin，
auto-start policy 仍来自 `runtimeState`。

### Vite host

```ts twoslash
// vite.config.ts
import { dynamicRuntimeVitePlugin } from '@pluxel/runtime-dynamic/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		dynamicRuntimeVitePlugin({
			entry: './src/pluxel.dynamic.ts',
		}),
	],
})
```

Dynamic route 只拥有 file/source lifecycle：watch、OXC resolution、module execution、graph transaction 与 HMR。package download、market、安装管理 RPC 和页面不属于 route core。

Dynamic `root` 是 source、runtime storage 与 module resolution 的显式路径基准，不会改变 Vite 进程的 working directory。Plugin 配置中注明“相对当前工作目录”的路径仍以 launcher cwd 为准；如果 dynamic `root` 与它不同，应在配置模块中生成绝对路径。

运行期安装 package 时显式装配官方 [Package Manager Plugin](../plugins/package-manager.md)；它把受管 package 原子发布成 `.mjs` source entry，dynamic route 只观察这些文件。

只监听已安装包的入口文件时，替换入口可以触发更新，但不意味着会监听该包全部源码。
要修改 Git checkout 内的插件并即时更新，使用 [源码工作区](../development/source-workspaces.md)。

### Programmatic dev runtime

脚本或 integration test 需要在进程内拥有真实 Vite server 时，使用同一个 production launcher：

```ts no-twoslash
import { startDynamicDevRuntime } from '@pluxel/runtime-dynamic'

await using runtime = await startDynamicDevRuntime({
	entry: new URL('./src/pluxel.dynamic.ts', import.meta.url),
})

const response = await fetch(new URL('/health', runtime.origin))
```

factory resolve 时 config、initial reconciliation、HMR、carrier 和 listener 已 ready，不需要再调用 `.start()`。返回资源的
`dispose()` 与异步释放协议幂等；可选 `signal` 只取消尚未完成的 startup，resolve 后不会自动关闭已经交付的 runtime。项目需要验证自己的
Vite plugins、assets 或 browser graph 时，直接运行项目的 Vite command；只验证 Plugin behavior 时使用更小的
`createRuntimeTestHost()`。

### Source 约束

- `file` 声明一个精确 entry，暂时不存在时仍 watch parent。
- `directory` 必须给出相对 include glob；不接受 absolute、negation、`.` 或 `..` segment。
- startup 中已存在的 entries 必须完成初始 graph commit，runtime 才 ready。
- add/change/unlink 进入同一 HMR batch，不直接 mutation running instance。
- entry 普通 import graph 不受 include glob 限制，dependency 变化沿 importer graph 返回 entry。

不要把源码仓库或 `node_modules` 整体作为 source directory。producer 只发布普通 ESM entry，不调用 loader internal API。

### Distribution mode

可搬运 source-based host 显式使用：

```ts no-twoslash
dynamicRuntimeVitePlugin({
	entry: './src/pluxel.dynamic.ts',
	mode: 'distribution',
})
```

它使用 built/default package export，不注入 Vite client，并从 runtime artifact 使用 Workbench shell。这个 mode 只定义执行拓扑；目录 closure、inventory、签名和原子发布仍由 distribution tooling 负责。

## 共享宿主策略

宿主配置是封闭契约，不是任意 metadata 容器。TypeScript 会在 `defineStaticRuntime()` 的
`configure()` 返回值和 `defineDynamicRuntimeConfig()` 的直接输入中拒绝未知顶层字段，也会严格检查
`configService`、`runtimeState`、persistence wrapper、`database.pool`、`workers`、`workbench`、`vault` 与完整
logging plan 等所有 Runtime-owned 封闭子配置；Runtime 对 JavaScript、类型断言和外部输入重复执行相同的运行时校验。
Plugin raw config、环境变量映射、custom persistence backend 与 custom log sink 是明确的开放扩展点；其实现私有字段不会被
递归检查。Plugin 业务配置、产品 metadata 与宿主策略应进入各自已有入口，不能借未知字段附加到 host config。

### Plugin config 与 runtime state

宿主分别维护三类状态：

- runtime state：哪些 Plugin 自动启动、fork、provider override；
- process session：本次进程中哪些 Plugin 明确启动或停止，由 Runtime coordinator 持有，cold boot 时清空；
- Plugin config record：交给每个 Plugin schema 校验的 raw object。

Static `configure()` 或 dynamic config 提供初始值，file/memory/readonly backend 决定持久化方式；`readonly` 会读取同一 durable file source，但拒绝 mutation，文件缺失时保留 startup snapshot 且不创建文件。Plugin 只看到已经 normalized 的 `this.config`；详细 contract 见 [配置模型](./configuration.md)。

### 业务 Elysia application 与 carrier

Plugin 直接在 generation-scoped `ctx.elysia` 中声明最终业务 path。宿主不为 Plugin 生成 URL，也不把 route options 塞进 static
或 dynamic config；需要 `/orders` namespace 时由 Plugin 使用 Elysia `group('/orders', ...)` 明确表达。`/__pluxel` 始终由宿主
control plane 保留。

launcher 拥有 listener、port、shutdown、srvx/runtime adapter 和跨业务 API 的外层 policy；部署 ingress、反向代理或平台拥有 TLS。Plugin 拥有自己 contribution
内部的 Elysia hook、schema、error 与业务授权。不要让 Plugin 调用物理 server 的 `listen()` / `stop()`，也不要依赖不同 Plugin
app 的组合顺序取得“全局”CORS 或 auth。

当前锁定的 Elysia 2 beta 已支持 Fetch HTTP contribution、stream、generation publication，以及 Node production、static Vite 与
dynamic Vite 的基础业务 WebSocket。external setup/cleanup attach、第二个非 Node carrier、完整 socket parity 与
canonical-equivalent route collision 仍缺少稳定 seam。需要这些能力时先查看 [Plugin HTTP 的当前边界](../runtime/http.md)，
不要把 Node 已验证范围外的 Elysia server API 当作所有 carrier 都已完成 conformance。

### Workbench 与 management access

Workbench 是可选 host capability：

```ts no-twoslash
workbench: false
```

或：

```ts no-twoslash
workbench: {
	enabled: true
}
```

`workbench: false` 显式关闭管理界面，Plugin 的 HTTP、数据库、命令和生命周期继续可用。
省略字段时是否默认开启取决于宿主入口：Static Vite 和带工作台的静态产物默认开启，不能把省略等同于显式关闭。

开启 Workbench 前，应用需要安装与当前 Runtime 匹配的 `react`、`react-dom`、`@mantine/core` 和 `@mantine/hooks`。
现有模板已经固定这些依赖；接入现有项目时应按所用 `@pluxel/runtime` 的发布包 peerDependencies 配置，
并确保 Mantine 的实际解析版本与宿主一致。它们由工作台统一加载，缺少依赖或版本不匹配会导致页面构建失败。

不加载 Workbench UI、但需要通过 `@pluxel/runtime/web` 管理宿主时，显式启用 Management：

```ts no-twoslash
workbench: false,
management: true
```

`management: true` 会启用 headless management；省略时，关闭 Workbench 的宿主没有 management route 或 backend。
`management` 只接受布尔值。Workbench 开启时也会开启 Management；关闭 Workbench 后，
需要管理 API 就显式保留 `management: true`。
插件目录的[自动依赖分组与人工分组](../workbench/plugin-groups.md)只改变界面组织，不修改启停策略或依赖选择。

生产 Node launcher 默认监听 `0.0.0.0`。Runtime 从物理 socket peer 和认证 provider 状态决定 Management 访问：真实
loopback socket 取得 Runtime recovery principal；remote/unknown 必须由可信 physical carrier 提供 HTTPS，并由当前
committed、running 且 ready 的 provider 完成认证，否则 fail closed。`Host`、`Forwarded` 和 `X-Forwarded-For` 不参与判断。

自定义认证 Plugin 通过 owner-bound `ctx.managementAccess.provide()` 发布唯一 provider。`open()` 为一条 control socket
创建 disposable authentication session；session 用 `state()` / `submit(input)` 返回封闭 challenge、navigate、authenticated
或 failed step。Provider 收到的 `Request` 只有 URL、headers 与 owner/session signal，不含 Management operation body。
OIDC redirect/callback 与 cookie commit 只能通过 provider 的三个 exact handoff method 实现。Provider registration、session、
回调和 response body 都随 Plugin generation 撤销并参与 drain。

内建 production static Node launcher 只监听 HTTP。公网部署在 ingress、反向代理或平台终止 TLS，不把证书和私钥交给应用进程。

官方 `@pluxel/auth` 在一个插件里提供三种互斥模式：`oidc`、`password`、`password-totp`。本地账号的 password verifier、TOTP
secret/counter 和 confidential OIDC client secret 使用 owner Vault，因此这些模式需要 `vault: {}`。需要交互式首次配置时再启用
Workbench：

```ts no-twoslash
vault: {},
workbench: { enabled: true }
```

`clientKind: 'public'` 的 OIDC 没有 client secret，不需要 Vault。

首次配置先建立 tunnel：

```sh
ssh -L 3000:127.0.0.1:3000 user@host
```

再打开 `http://127.0.0.1:3000`，为 Auth Plugin 打开自动启动策略或在当前进程启动它、选择 mode，并进入 Workbench route
`/auth/setup`。Auth-owned Direct View 通过同一 Cap’n Web socket 保存首个账号/TOTP 或 confidential client secret；没有 setup
HTTP endpoint、CLI 或备用 transport。Mutation 只允许真实 loopback recovery principal，且只在 credential 缺失或损坏时执行，
不能覆盖已配置记录。成功后 provider 在同一 generation 立即 ready，并撤销旧 cookie session。

`workbench: false` 或 production `headless` artifact 不包含 setup View/API。此类部署使用 password、password + TOTP 或
confidential OIDC 时，必须预置相同 Vault credential，或先用带 Workbench artifact 且指向同一 persistence 的部署完成配置再切
headless；public OIDC 没有 provisioning，只凭配置即可 ready。

远程 password/OIDC 登录要求物理 carrier 是 HTTPS；不安全的远程请求会在调用 provider 前被拒绝。Runtime 不信任代理头，
因此内建 HTTP-only Node launcher 不通过普通 TLS 反代开放远程 Management，也不要让反代经 loopback 回源取得 recovery principal。
默认用 loopback/SSH tunnel 管理；需要远程 Management 的平台集成必须提供自身能证明 HTTPS 的 application carrier。

最终业务 Elysia path 与 Workbench exposure 是不同边界；声明固定业务 route 不等于开放管理权限，Management provider 也不会自动保护
业务插件 API。

### Logging root

每个进程只有一个 active logging root。Static/dynamic launcher 提供默认 console；dynamic 可以增加轮转 file sink，Workbench enabled 时可加入 store。

Plugin 只使用 `ctx.logger`。完整 host logging plan、debug topics 和 sensitive fields 见 [结构化日志](../runtime/logging.md)。

### 启动结果与进程策略

graph commit 返回结构化 summary：成功节点进入 running，failed 节点回滚，required dependents blocked，无关 Plugin 可以继续。

Static startup/HMR report 中的 `unavailable` 表示 durable policy 或 process session intent 引用的节点当前没有 route catalog availability，例如
source 被移除后仍保留的 fork；它不是 `start-failed`。相同 definition address 再次出现时，runtime 会按保留的 auto-start、fork、dependency
policy 和本次 session intent 恢复有效图。

宿主决定：

- 任一失败是否退出进程；
- 哪些 Plugin 是 deployment readiness 前提；
- 如何暴露 health endpoint；
- 何时告警或自动 restart；
- shutdown signal 和最终 timeout。

Plugin 不调用 `process.exit()`，也不根据 static/dynamic route 自行改变失败语义。

## 测试与检查

### 测试 host entry

Static application 测试使用：

```ts twoslash
import { startStaticApplicationTestHost } from '@pluxel/runtime-static/test'
```

`startStaticApplicationTestHost(application)` resolve 时已经完成 configure、prepare、bindings 与 cold boot；它只提供
`startupReport`、只读 Plugin query 和 Runtime drivers，不提供 Plugin lifecycle mutation、root `ctx` 或 physical listener。

普通 Runtime Plugin 测试使用 `@pluxel/runtime/test` 的 `createRuntimeTestHost()`；Core-only graph 测试使用
`@pluxel/core/test` 的 `createCoreTestHost()`。两者都由 `await using` 或 `finally` 明确拥有生命周期。顶层 lifecycle command 会立即提交，
首次配置使用 `initialConfig`，运行期更新使用 `host.config.patch()`。完整选择见 [测试插件](../development/testing.md)。

### 启动前检查

- canonical entry/config 通过 Vite route plugin 加载，不用 raw TS runner。
- static `plugins` 与 dynamic `sources` 没有重复表示同一 definition。
- fixed Plugin 是否自动启动由 runtime state 明确决定；当前进程的启停操作不写回该策略。
- Management provider 与业务 HTTP auth 保持独立；内建 Node launcher 保持 loopback 管理，需要远程 Management 时确认 provider ready 且 deployment carrier 能证明 HTTPS。
- persistence、logs、dynamic artifact cache 指向可写 state，不写 immutable deployment root。
- production build 与真实 Node/PostgreSQL/native 环境做过 smoke test。
