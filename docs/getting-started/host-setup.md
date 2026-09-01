---
title: 配置插件宿主
description: 为现有项目选择 static 或 dynamic host，并配置 Plugin 清单、运行状态和 Workbench。
---

Pluxel 提供静态和动态两种宿主模式。静态宿主的 Plugin 清单由入口文件确定；动态宿主在固定清单之外，还可以监听运行时增删的文件来源。Plugin 的写法不随模式变化，两者共享同一套依赖图、配置、运行时服务和生命周期。

从零创建完整应用时先使用 [example monorepo](../development/starter-monorepo.md)，它已经包含可运行的 static host、alternative dynamic host、Vite 和构建配置。本页用于把 Pluxel 接入现有项目。

## 选择宿主模式

| 场景                                           | 选择         |
| ---------------------------------------------- | ------------ |
| 产品内置 Plugin、清单固定、需要审计和冻结      | 静态模式     |
| 需要在宿主运行期间增加或删除 Plugin 文件入口   | 动态模式     |
| 需要把包含动态 Plugin 来源的宿主部署到其他环境 | 动态发行模式 |

不要根据是否需要 HMR 选择宿主模式：两种模式在开发期都支持模块热更新，也使用相同的 generation 清理流程。业务 Plugin 不需要为两种模式编写不同实现。

开启 Workbench 的 host 必须能从 application root 解析 `react`、`react-dom`、`@mantine/core` 与 `@mantine/hooks`，并满足当前
`@pluxel/runtime` 的 peer versions。它们是 Shell 提供给 MF2 remote 的固定 singleton winner；缺包或 Mantine 精确版本不一致会在
producer build 前失败。Headless host 不需要安装这组 browser peers。

## Static host

```sh package-install
npx nypm add @pluxel/runtime @pluxel/runtime-static
```

```sh package-install
npx nypm add -D @pluxel/rolldown vite tsdown
```

### Canonical entry

```ts no-twoslash
// src/pluxel.static.ts
import { pluginNodeAddressOf } from '@pluxel/runtime'
import { defineProduct } from '@pluxel/runtime/product'
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { OrdersPlugin } from '@acme/orders'

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
		}
	},
})
```

`plugins` 定义 build-time fixed catalog 和 code closure；运行时依赖图由 auto-start policy、本次进程意图、fork 和 provider override 形成。
`workbench`、persistence、logging、HTTP、Plugin config records 和 auto-start policy 是 `configure()` 返回的 startup data；本次进程意图
不持久化，也不进入 startup config。

Static Vite host 与 `variant: 'workbench'` 产物默认启用 Workbench；`PLUXEL_WORKBENCH=false` 可在启动时完整关闭 Plane。
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

```ts twoslash
// vite.config.ts
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [staticRuntimeVitePlugin({ entry: './src/pluxel.static.ts' })],
})
```

Vite SSR 加载 canonical entry。Plugin module 变化执行 catalog HMR；entry/configure dependency 变化重建 host；Workbench remote 由开发 compiler 增量构建。

React、业务 alias 和普通 Vite plugin 属于 host `vite.config.ts`。不要复制 Pluxel semantic transform、SSR package classifier 或 runtime source alias。

### Production application

```ts twoslash
// tsdown.config.ts
import { staticApplication } from '@pluxel/rolldown/build'

export default staticApplication({
	entry: './src/pluxel.static.ts',
	variant: 'workbench',
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

`env` 是与 `std-env` 相同的原始字符串对象；`hostEnv` 是 Pluxel 官方字段的有效值，不是第二份可变环境。Launcher 测试或 adapter 需要解析显式输入时使用 `resolveHostEnv(input)`。`PluxelEnvironmentVariables` 已声明 `PLUXEL_DATA_ROOT`、`PLUXEL_WORKBENCH`、listener/TLS、config、Vault 与 HMR 变量；应用可以用 module augmentation 添加自己的部署变量。官方变量的行为为：

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
| `PLUXEL_HOST_BIND` / `PLUXEL_HOST_PORT` | Node/Vite physical listener；port 必须为 `0..65535` 整数                                       |
| `PLUXEL_TLS_CERT` / `PLUXEL_TLS_KEY`    | static Node TLS，必须成对配置；可选 `PLUXEL_TLS_PASSPHRASE`                                    |

外部 database、cache 或 sidecar 需要与 Pluxel 放在同一数据树时直接消费 `hostEnv.dataRoot`，并相对同一个 Host root 使用自己拥有的子目录（例如 `database/`）；不要读取 `env.PLUXEL_DATA_ROOT` 并自行补默认值。应用显式选择不同的 persistence path/backend 表示有意偏离共享 root；部署希望统一时设置 `PLUXEL_DATA_ROOT`。

变量优先级为 Pluxel/build 默认值 < application string path/Workbench policy < 显式 `PLUXEL_DATA_ROOT`/`PLUXEL_WORKBENCH`。环境值非法时启动 fail-fast；不会静默回退。

freezer 默认同时携带 managed database 的 PGlite 与 PostgreSQL driver，使 `configure()` 可以在启动时选择任一 backend。部署若只支持部分 driver，使用 `managedDatabaseDrivers` 收窄闭包；完全使用 application-private database 时传空数组，并在 runtime config 中设置 `database: false`：

```ts twoslash
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

### Canonical config

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
			config: './src/pluxel.dynamic.ts',
		}),
	],
})
```

Dynamic route 只拥有 file/source lifecycle：watch、OXC resolution、module execution、graph transaction 与 HMR。package download、market、安装管理 RPC 和页面不属于 route core。

Dynamic `root` 是 source、runtime storage 与 module resolution 的显式路径基准，不会改变 Vite 进程的 working directory。Plugin 配置中注明“相对当前工作目录”的路径仍以 launcher cwd 为准；如果 dynamic `root` 与它不同，应在配置模块中生成绝对路径。

运行期安装 package 时显式装配官方 [Package Manager Plugin](../plugins/package-manager.md)；它把受管 package 原子发布成 `.mjs` source entry，dynamic route 只观察这些文件。

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
	config: './src/pluxel.dynamic.ts',
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

Host 的两类状态不要混淆：

- runtime state：哪些 Plugin 自动启动、fork、provider override；
- process session：本次进程中哪些 Plugin 明确启动或停止，由 Runtime coordinator 持有，cold boot 时清空；
- Plugin config record：交给每个 Plugin schema 校验的 raw object。

Static `configure()` 或 dynamic config 提供初始值，file/memory/readonly backend 决定持久化方式；`readonly` 会读取同一 durable file source，但拒绝 mutation，文件缺失时保留 startup snapshot 且不创建文件。Plugin 只看到已经 normalized 的 `this.config`；详细 contract 见 [配置模型](./configuration.md)。

### 业务 Elysia application 与 carrier

Plugin 直接在 generation-scoped `ctx.elysia` 中声明最终业务 path。宿主不为 Plugin 生成 URL，也不把 route options 塞进 static
或 dynamic config；需要 `/orders` namespace 时由 Plugin 使用 Elysia `group('/orders', ...)` 明确表达。`/__pluxel` 始终由宿主
control plane 保留。

launcher 拥有 listener、port、TLS、shutdown、srvx/runtime adapter 和跨业务 API 的外层 policy。Plugin 拥有自己 contribution
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

`workbench: false` 或省略该字段时不创建 Workbench registry、MF compiler/watcher、producer route 或 control session。Plugin business HTTP、database、commands 和 lifecycle 不受影响。启用 Workbench 会同时启用 Management Plane。

不加载 Workbench UI、但需要通过 `@pluxel/runtime/web` 管理宿主时，显式启用 Management：

```ts no-twoslash
workbench: false,
management: true
```

`management: true` 会启用 headless management；省略时，关闭 Workbench 的宿主没有 management route 或 backend。
该字段只接受布尔值，不承载 catalog 分类。Runtime 按固定优先级自动派生 catalog sections：

1. 有 `provides` 的 concrete Plugin 按被提供的 provider role 归类；
2. 其余 package-root definitions 按精确 package name 归类；
3. 其余 source-entry definitions 按直接父目录归类，例如 `src/render/canvas.ts` 与 `src/render/fonts.ts` 同属 `render`。

规则不读取 `requires` / `optional` 依赖边，也不随启动状态或当前 provider selection 改变。用户移动和排序只作为
Management 偏好保存；同一 definition 的 default node 与 forks 不会被拆开。认证策略和 OIDC secret 属于认证 Plugin。
Workbench 启用时总会同时启用 Management，不存在同时“启用 Workbench、禁用 Management”的矛盾状态。

生产 Node launcher 默认监听 `0.0.0.0`。Runtime 从物理 socket peer 和认证 provider 状态决定 Management 访问：真实
loopback socket 取得 Runtime recovery principal；remote/unknown 必须由可信 physical carrier 提供 HTTPS，并由当前
committed、running 且 ready 的 provider 完成认证，否则 fail closed。`Host`、`Forwarded` 和 `X-Forwarded-For` 不参与判断。

自定义认证 Plugin 通过 owner-bound `ctx.managementAccess.provide()` 发布唯一 provider。`open()` 为一条 control socket
创建 disposable authentication session；session 用 `state()` / `submit(input)` 返回封闭 challenge、navigate、authenticated
或 failed step。Provider 收到的 `Request` 只有 URL、headers 与 owner/session signal，不含 Management operation body。
OIDC redirect/callback 与 cookie commit 只能通过 provider 的三个 exact handoff method 实现。Provider registration、session、
回调和 response body 都随 Plugin generation 撤销并参与 drain。

生产 static Node listener 可以直接终止 TLS。`PLUXEL_TLS_CERT` 与 `PLUXEL_TLS_KEY` 必须同时配置，值可以是内联 PEM 内容或 PEM 文件路径；
加密 private key 可另设可选的 `PLUXEL_TLS_PASSPHRASE`。两项都省略时 listener 使用 HTTP。

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
因此不要让同机 reverse proxy 经 loopback 回源 Management，改用非 loopback 私网/容器地址或在 Pluxel carrier 直接终止 TLS。

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
import { createStaticRuntimeTestHost } from '@pluxel/runtime-static/test'
```

普通 runtime Plugin 测试使用 `@pluxel/runtime/test` 的 `withRuntimeHost()` 或 `createRuntimeHost()`。完整选择见 [测试插件](../development/testing.md)。

### 启动前检查

- canonical entry/config 通过 Vite route plugin 加载，不用 raw TS runner。
- static `plugins` 与 dynamic `sources` 没有重复表示同一 definition。
- fixed Plugin 是否自动启动由 runtime state 明确决定；当前进程的启停操作不写回该策略。
- Management provider 与业务 HTTP auth 保持独立；公网前确认 provider ready 且 TLS 可用。
- persistence、logs、dynamic artifact cache 指向可写 state，不写 immutable deployment root。
- production build 与真实 Node/PostgreSQL/native 环境做过 smoke test。
