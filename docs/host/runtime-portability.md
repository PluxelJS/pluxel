---
title: 跨平台宿主契约
description: 接入一个 JavaScript 宿主时，按插件实际使用的能力准备运行环境，并用同一份发布插件验收。
---

Node、浏览器、Cloudflare Workers、LLRT 和 React Native 可以运行同一份已编译的 Pluxel 插件。应用声明选择插件与服务，平台启动文件选择 Host 入口。插件通过 `ctx` 使用宿主提供的能力。

## 五个平台的启动代码

下面五个入口都加载同一个 `application.ts`。这里用部署变量命名 Host，`plugins` 可填入已编译的插件。平台所需的 Fetch、存储和日志实现由工厂通过 `coreConfig` 统一声明。应用需要部署变量时，Node 和嵌入式入口在启动时传入 `{ env }`，Cloudflare 在每次事件中传入选定的绑定值。 [声明插件与绑定](./configuration.md#独立轻量-host)

```ts
// application.ts
import { defineHostApplication } from '@pluxel/host/application'

export default defineHostApplication(({ env }) => ({
	name: env.APP_NAME ?? 'notes',
	plugins: [],
}))
```

**Node / Electron 主进程。** 两者都从包根导入 `startHost`。下面打印一次状态就释放 Host。Electron 窗口需要持续调用插件时，在 `app.whenReady()` 后启动，并让 Host 的作用域覆盖窗口的使用期。 [Node 入口](https://github.com/PluxelJS/pluxel/blob/83f514bf922cd740fc1f4383e749dc447e09f37a/projects/host-targets/src/node-main.ts) · [Electron 主进程](https://github.com/PluxelJS/pluxel/blob/2f1869fc1eaf63de11deeee7d3737498ed701e02/projects/host-electron/index.js)

```ts
import { startHost } from '@pluxel/host'
import application from './application'

await using host = await startHost(application, { env: { APP_NAME: process.env.APP_NAME } })
console.log(await host.status())
```

**浏览器 Dedicated Worker。** 在 Worker 模块里启动，把结果通过消息发回页面。下面的 Worker 只查询一次。长期处理消息的 Worker 可以保留一个 Host，在收到关闭消息时等待 `host.close()`。 [完整消息处理](https://github.com/PluxelJS/pluxel/blob/83f514bf922cd740fc1f4383e749dc447e09f37a/projects/host-targets/src/browser.worker.ts)

```ts
import { startHost } from '@pluxel/host/embedded'
import application from './application'

await using host = await startHost(application)
self.postMessage(host.catalog().entries.map(({ address }) => address.exportName))
```

**Cloudflare Workers。** 模块持有一个驱动。首次请求在有效事件里启动根，后续请求可复用它。每次 `run` 都有自己的 SDK 作用域。 [请求入口](https://github.com/PluxelJS/pluxel/blob/83f514bf922cd740fc1f4383e749dc447e09f37a/projects/host-targets/src/cloudflare/entry.ts)

```ts
import { createWorkerHost } from '@pluxel/host/cloudflare'
import application from './application'

const worker = createWorkerHost(application)
export default {
	fetch(request, env, ctx) {
		return worker.run(
			{ ctx, env: { APP_NAME: env.APP_NAME }, signal: request.signal },
			async (sdk) => Response.json(await sdk.plugins.list()),
		)
	},
} satisfies ExportedHandler<{ APP_NAME?: string }>
```

**Rust / LLRT。** Rust 在 VM 中加载 JS 入口，调用其导出的 `run` 并等待 Promise。这里用字符串把结果交还给 Rust，作用域结束时 Host 已关闭；Rust 此后可以释放 VM。 [JS 入口](https://github.com/PluxelJS/pluxel/blob/2f1869fc1eaf63de11deeee7d3737498ed701e02/projects/host-llrt/src/application.ts) · [Rust 调用方](https://github.com/PluxelJS/pluxel/blob/2f1869fc1eaf63de11deeee7d3737498ed701e02/projects/host-llrt/native/src/main.rs)

```ts
import { startHost } from '@pluxel/host/embedded'
import application from './application'

export async function run(appName: string) {
	await using host = await startHost(application, { env: { APP_NAME: appName } })
	return JSON.stringify(host.catalog().entries.map(({ address }) => address.exportName))
}
```

**React Native / Expo。** Hermes 里的启动代码可以直接返回 JS 值给界面。下面的函数在调用作用域中读取一页插件。组件可在卸载时取消这次操作。常驻应用可以复用一个 Host，每次调用创建独立作用域。示例应用在安装或移除插件后用 Expo 的 `reloadAppAsync()` 重载 JS，下次启动再读取已安装的制品。 [Hermes 入口](https://github.com/PluxelJS/pluxel/blob/2f1869fc1eaf63de11deeee7d3737498ed701e02/projects/host-expo/src/run.ts) · [安装后重载](https://github.com/PluxelJS/pluxel/blob/2f1869fc1eaf63de11deeee7d3737498ed701e02/projects/host-expo/App.tsx)

```ts
import { createScriptScope } from '@pluxel/agent-sdk/host'
import { startHost } from '@pluxel/host/embedded'
import application from './application'

export async function listPlugins(appName: string, signal: AbortSignal) {
	await using host = await startHost(application, { env: { APP_NAME: appName } })
	await using scope = createScriptScope({ ctx: host.ctx, signal })
	return await scope.sdk.plugins.list()
}
```

`startHost` 完成启动验收后才返回 Host，调用方负责关闭。取消信号属于这次 SDK 调用，或 Cloudflare 的当前事件。启动本身没有 `signal` 参数。

## 开发与交付

开发机上的 Node 和包管理器安装 npm 依赖。Vite 解析模块、观察源码更新，Pluxel 编译器提取插件声明。Core 持有插件依赖图和实例生命周期，Host 按应用声明装配服务和插件。把新平台接到这个流程，先在已有 Vite 示例里编辑共享插件，再到目标引擎验收制品。通过包的发布入口使用外部 npm 插件；需要联调该包的源码时，Node Host 用 `sources` 指向源码。Worker 开发入口为目标 Vite environment 配置 `@pluxel/hmr` 解析条件、`pluginModules` 及对应模块的 HMR 接受边界。包及其依赖都必须能在目标执行。 [插件包](../development/plugin-package.md) · [源码工作区](../development/source-workspaces.md)

| 目标                    | 开发时如何看到修改                                                                                     | 发布后插件集如何生效                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Node / Electron 主进程  | Node Vite Host 可以在同一根替换插件 generation。Electron 示例用真实主进程验收桌面服务                  | 固定插件随应用发布。需要独立安装包时，Node modules 加载器可在下次启动扫描来源；需要在线消费来源的 Node 服务可显式采用 Vite 生产配置 |
| 浏览器 Dedicated Worker | Vite 在 Worker 内提交新 catalog，页面保持连接                                                          | 页面随应用版本选择新的 Worker 入口，创建新 Worker 后将请求交给它                                                                    |
| Cloudflare Workers      | Node 上的 Vite 驱动本地 workerd，在有效事件里调用插件                                                  | 部署含插件的新 Worker 版本，平台按部署策略向对应版本的 isolate 派发事件                                                             |
| Rust / LLRT             | 共享插件用 Node + Vite 联调，Rust 服务及模块加载用真实 LLRT 验收                                       | Rust 把独立编译的 JS 安装到应用私有目录，关闭 Host 并释放 VM。新 VM 读取已安装文件，Rust 进程可以继续运行                           |
| React Native / Expo     | 共享插件用 Node + Vite 联调，原生界面用 Metro 和 Fast Refresh 联调；设备上的 Hermes 对独立插件 JS 求值 | 应用把选中的独立 JS 制品保存到私有目录。重载主 JS 运行时后，React 根重新挂载，Host 按已安装文件启动。操作系统进程可继续运行         |

停止一个插件只释放该实例持有的资源。在嵌入式示例中，安装和卸载改变**下次启动要加载的代码**。已运行的 JS 继续使用当前插件集，直至宿主关闭这次执行环境。构建机负责解析依赖并生成制品。两个示例都接收开发者信任的本地文件，摘要校验写入的字节，插件在宿主的 JS 权限下执行。 [Worker 部署语义](https://developers.cloudflare.com/workers/versions-and-deployments/) · [React Native Fast Refresh](https://reactnative.dev/docs/fast-refresh)

## 发布前确定哪些输入

| 数据                             | 随应用发布                                                             | 部署或运行时                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 公开规则、模板、字典             | 直接导入 TS、JSON 或静态资源                                           | 随版本更新，查询无需打开文件或 Store                                                                     |
| 普通部署配置                     | 插件用 `configs.use()` 声明 schema，应用在节点或 fork 上映射环境变量名 | Host 在创建根时解码，再按节点的配置优先级采用                                                            |
| 部署凭据                         | 应用用 `envBindings` 声明 Vault 的记录键、schema 和变量名              | 部署方提供实际值，Host 校验后注入只读记录                                                                |
| 可修改的初值，如默认主题         | 插件创建带初值的 Store，交给 `ctx.tinybase.open(store)`                | 首次无快照时采用初值。已有快照时恢复完整内容，包括用户保存的空 Store                                     |
| 运行中产生的偏好、游标、业务记录 | 确定数据需要保留多久                                                   | 可重建的数据可放在会话存储中。需跨重启恢复时使用持久后端，多个实例协调写入时使用具有相应一致性保证的服务 |

Pluxel 的 standalone 和 modules 应用构建会从源码读取节点、fork 及绑定映射，校验记录键、环境名与 schema 路径，并将部署变量的名称和说明写入发行目录的 `.env.example`。插件清单和映射须能静态解析，无法解析时构建报错。构建机无需持有实际凭据。使用 Vite 构建浏览器或 Cloudflare Worker 时，由应用显式传入部署值。发给浏览器的值对终端用户可见，服务端 token 应留在服务端。 [部署绑定](./configuration.md#绑定部署环境与-json-文件) · [TinyBase 初值与恢复](../plugin-development/tinybase.md#打开并使用原生-store)

## 宿主需要提供什么

先用 `pluxel build` 编译插件，再按目标引擎打包宿主。宿主和插件须使用同一份框架运行时。嵌入引擎应先装好原语和 polyfill，再加载应用模块，例如在引导模块中使用 `await import(...)`。

| 阶段                       | 宿主要准备什么                                                                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 加载框架                   | 制品使用的 ECMAScript 特性，包括 Proxy、Reflect、Promise、AggregateError 和稳定的 `Symbol.dispose`、`Symbol.asyncDispose`。准备 UTF-8 `TextEncoder` 和安全的 `crypto.randomUUID()`。事件库在加载时绑定 `console.info`、`warn`、`error`，缺少 `debug` 或 `trace` 时回退到 `console.log` |
| 直接启动 Node 或嵌入式入口 | ZenFS 在模块加载时使用 `TextDecoder`、`performance.now()` 和支持 `en-US` 的 `Intl.NumberFormat`。默认 Host 创建文件目录时还会用到 `URL` 和 `structuredClone`                                                                                                                           |
| 启动插件、借用和关闭       | 准备定时器、`AbortController` 和 `AbortSignal`。SDK 调用插件方法时用 `AbortSignal.any()` 合并调用者和插件的取消信号。Cloudflare 驱动接纳事件时使用 `Promise.withResolvers()`。嵌入式宿主须驱动 Promise 任务队列，在引擎允许的线程上结算 I/O，并在释放引擎前等待 Host 关闭              |

### 内建能力的运行条件

| 插件使用的能力                        | 宿主需要提供或验证的行为                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.events`、`ctx.effects`、插件配置 | 框架负责根内事件分发、作用域清理和 schema 校验。释放订阅者后再次发事件，应只通知仍订阅的插件                                                                                                                                                                                                                                                |
| `ctx.fetch`、`ctx.wretch`             | 提供 URL、Headers、Request、Response、符合 Fetch 语义的传输、DOMException，以及 `AbortSignal.any()` 和信号实例的 `throwIfAborted()`。当前 Wretch 即使发送 GET 也需要全局 `FormData`。受管请求达到并发上限时使用 `Promise.withResolvers()`，记录耗时使用 `performance.now()`。两种客户端都应能消费响应体，并在插件停止或调用者取消时中止请求 |
| 限制出站 origin                       | 受管终端必须遵守 Request 的 headers、signal 和 `redirect: 'manual'`。测试指向另一 origin 的 302，确认第二个端点没有收到请求。应用可用 `coreConfig.http.fetch` 接入符合要求的传输                                                                                                                                                            |
| `ctx.logger`                          | 由应用选择 LogTape 的输出端和日志级别，发送一条插件日志并在实际输出端核对来源。Node 和嵌入式宿主可用 `coreConfig.logtape` 开启 `root.logging`。同一份 LogTape 运行时同时只允许一个根托管其配置                                                                                                                                              |
| `ctx.tinybase`、`ctx.fs()`            | 快照需要根内文档存储、UTF-8 编码和 `queueMicrotask`。文件操作还需要支持所用方法的 ZenFS 后端。若要求跨重启恢复，须在目标介质上写入，关闭、重开 Host 后读回                                                                                                                                                                                  |
| `ctx.vault`                           | 选 `{ backend: 'bindings' }` 可直接读取宿主注入的只读记录。加密后端还需要可写文件、UTF-8 编解码、`crypto.getRandomValues()`、WebCrypto AES-GCM 的 `importKey`、`encrypt`、`decrypt` 和 age 的运行依赖。即使读取的是只读绑定，加密后端也要先打开加密库。验收时用实际后端测试读取、拒绝覆盖绑定记录及所需的加密写入                           |

桌面窗口、JVM 对象、数据库连接等由应用安装为服务，插件通过 `ctx.service(...)` 借用。用 `installScopeService` 可以给插件提供一个原生函数。由应用持有的共享对象可以用 `installOwnerViewService` 向插件开放所需方法，例如 Electron 示例只开放读取应用名称和版本。插件直接导入 `node:fs` 或访问 DOM 时，也需要相应的平台环境。 [宿主服务](./services.md) · [受管出站 HTTP](../plugin-development/outbound-http.md) · [跨运行时 Web API 标准 ECMA-429](https://ecma-international.org/publications-and-standards/standards/ecma-429/)

## 三个现有入口

| 入口                                 | 根的寿命                                                                       | 文件、TinyBase 和 Vault                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Node `@pluxel/host`                  | `startHost` 创建根，应用等待 `host.close()` 释放。网络可配置 Node 代理         | 直接启动默认使用内存文件系统，应用可挂载本地目录。Vault 默认按需打开加密后端，也可选只读绑定 |
| 嵌入式 `@pluxel/host/embedded`       | 页面、Dedicated Worker 或嵌入引擎的应用持有并关闭根。网络遵循宿主 Fetch 的语义 | 文件和 TinyBase 快照默认使用内存，可配置 ZenFS 挂载。Vault 的后端选择与 Node 相同            |
| Cloudflare `@pluxel/host/cloudflare` | 同一 isolate 内按部署变量复用根，每个事件有自己的 SDK 与取消信号               | `ctx.fs()` 报 `ENOTSUP`。TinyBase 使用根内会话存储。Vault 读取部署绑定，写入报 `READ_ONLY`   |

需要持久性的操作应在首次使用时明确声明。

- **保存文件**时用 `await ctx.fs({ durable: true, writable: true })` 借目录。缺少持久性声明会得到 `ENOTSUP`，只读挂载无法满足可写要求时得到 `EROFS`。 [文件系统](../plugin-development/fs.md)
- **保存插件状态**时用 `await ctx.tinybase.open({ durable: true })`，有初值时传入 `{ durable: true, store }`。会话后端或持久性未知时会得到 `DURABILITY_UNAVAILABLE`。`flush()` 等待当前后端确认保存。 [TinyBase](../plugin-development/tinybase.md)
- **由插件写入并保留加密凭据**时，给 Vault 数据目录挂载持久后端，声明 `zenfs.durableMounts` 并设置 `coreConfig.vault.durable: true`。首次打开时检查声明，缺失会得到 `ENOTSUP`。只读部署绑定随每个新根重新注入。 [Vault](../plugin-development/vault.md#host-后端与部署输入)

Cloudflare 的出站 I/O 应在有效事件内执行。如果返回的响应流还要调用插件，使用 `responseBody: 'scope'` 让借用保持到流结束。平台回收 isolate 时没有可靠的关闭回调。需要跨 isolate 恢复的数据，应在业务操作完成前提交给持久服务，例如通过宿主提供的 D1 或 R2 绑定写入。 [Cloudflare Worker Host](./configuration.md#cloudflare-worker-host) · [Workers Web 标准与差异](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)

## 桌面、移动与嵌入式宿主

满足 Web API 和 ZenFS 依赖的宿主可直接使用 `@pluxel/host/embedded` 的 `startHost(application, inputs)`。该入口也支持没有 DOM 的 Worker。应用所有者保存返回的 Host，停止接收原生调用后等待 `host.close()`，再释放引擎。应用工厂与插件图可直接沿用。 [启动与验收](./configuration.md#嵌入式-host)

- **QuickJS / LLRT** 可从框架仓内的 `projects/host-llrt` 开始。Rust 可执行程序链接 LLRT v0.9.0-beta，在同一进程中驱动本地 HTTP 和 QuickJS 任务队列。每次冷启动都创建新 VM，从应用目录装配插件。共享插件验收会话文件、TinyBase、部署绑定和日志输出，独立安装的 TicketDesk 调用 Rust 并读写加密 Vault。ES2022 ESM 引导模块先安装 FormatJS 的 `getCanonicalLocales`、`Locale`、`PluralRules`、`NumberFormat` 及英文语言数据，再加载宿主。该版 LLRT 从现有 signal 创建 Request 后，取消原 controller 会触发监听器，但 `request.signal.aborted` 仍可能为 `false`。需要控制取消时，可直接传 `ctx.fetch(url, { signal })`。 [Rust 宿主与安装示例](https://github.com/PluxelJS/pluxel/blob/2f1869fc1eaf63de11deeee7d3737498ed701e02/projects/host-llrt/README.md)
- **Electron** 可从 `projects/host-electron` 开始。主进程从 `@pluxel/host` 根入口启动 Node Host，在服务中提供原生 `app` 的名称与版本。插件通过 `ctx.service(...)` 借用，渲染器在启用沙箱的窗口中显示回执。 [Electron 主进程示例](https://github.com/PluxelJS/pluxel/blob/2f1869fc1eaf63de11deeee7d3737498ed701e02/projects/host-electron/README.md)
- **React Native / Expo** 可从 `projects/host-expo` 开始。Android 应用通过系统文件选择器安装独立构建的插件，启动时在 Hermes 中求值并通过 SDK 调用。Expo FileSystem 把插件安装包存入应用私有目录，重载后仍可读取。运行中的插件通过宿主服务读取原生语言设置，通过 `ctx.fs()` 读写自己的文件，通过 `ctx.tinybase.open()` 读写 Store。示例默认将插件文件与 Store 快照保存在内存中。需要跨启动保存时，应用将设备持久存储挂载到相应的 ZenFS 数据目录，并在 `durableMounts` 中声明该挂载。例如，记事本插件保存附件前，用 `await ctx.fs({ durable: true, writable: true })` 取得可持久写入的目录。引导模块补齐安全随机数、UUID 和资源释放 Symbol。示例的 HTTP 回执使用注入的测试传输；设备网络的在途取消、响应流和跨 origin 重定向需另行验收。iOS 也需用实际发行方式验证。 [Android 安装与重载示例](https://github.com/PluxelJS/pluxel/blob/2f1869fc1eaf63de11deeee7d3737498ed701e02/projects/host-expo/README.md) · [Expo 运行时重载](https://docs.expo.dev/versions/latest/sdk/expo/#reloadappasyncreason) · [RN 网络行为](https://reactnative.dev/docs/network)
- **JVM** 待嵌入宿主验收。以 GraalJS 为例，JVM 应用需提供模块来源、定时器、异步 I/O 和 Web API，并安排同一 Context 的进入与关闭顺序。验收应覆盖并发调用、取消，以及关闭后到达的原生回调。 [GraalJS 模块装载](https://github.com/oracle/graaljs/blob/master/docs/user/Modules.md) · [线程模型](https://github.com/oracle/graaljs/blob/master/docs/user/Multithreading.md)

## 如何验收一个宿主

在与应用版本匹配的 Pluxel 框架源码仓库根目录运行以下两项。第一项打包同一份插件，在 Node、Chromium Dedicated Worker 和本地 workerd 中通过正常应用入口调用。第二项在真实 Chromium 中验证 ZenFS 的 IndexedDB 后端能在重开后读回提交的字节。

```sh
vp run @pluxel-example/host-targets#check-smoke
vp run @pluxel/core#check-zenfs-browser
```

移植到新宿主时，可复制与目标引擎最接近的示例。它们都从测试包 `@pluxel-example/host-targets-plugins/probe` 导入 `probePlugins` 和 `inspectHost`，检查相同的构造器注入、配置、网络、存储、事件和清理行为。每个宿主单独注册自己的服务和平台插件。三端示例给出了共享插件的打包命令、公开测试输入和预期回执。 [三端验收与共享探针](https://github.com/PluxelJS/pluxel/blob/2f1869fc1eaf63de11deeee7d3737498ed701e02/projects/host-targets/README.md)

验证可安装插件时，先在缺少插件 B 的情况下构建应用，保留同一可执行文件或 APK。单独构建 B，经应用的正常安装入口写入，重载 JS 后通过 SDK 调用 B 的方法。离线重开必须还能调用；卸载、再次重载后 B 应消失，内建插件仍能工作。记录原生进程、JS 运行时和插件方法的回执，可以分别确认应用是否被重启、是否真的换了引擎，以及新代码是否进入插件图。在框架仓库根目录运行 `vp run @pluxel-example/host-llrt#check-smoke` 可验收 Rust 宿主。移动端先在 `projects/host-expo` 构建 Android release，再从该目录运行 `python3 scripts/check-android.py`，脚本通过设备 UI 选择独立插件。

有持久文件或加密 Vault 的部署，还需在同一介质上重开根并读回先前提交的数据。启用了网络策略时，增加在途取消和跨 origin 重定向用例。
