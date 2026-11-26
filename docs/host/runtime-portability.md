---
title: 跨平台宿主契约
description: 为已有应用选择 Host 入口，接入目标平台的存储、网络和原生能力。
---

同一份已编译的插件可以交给不同宿主运行。插件清单、启停和配置沿用同一套应用声明。给插件加开关和保存配置见[内置插件教程](./fixed-plugins.md)。下文的 `projects/` 路径均相对于与文档版本一致的框架源码仓库。[Pluxel 源码仓库](https://github.com/PluxelJS/pluxel)

## 选择宿主入口

| 应用运行在哪里                                    | 从哪里启动                                            | 谁持有 Host                                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Node、Electron 主进程                             | `startHost`，从 `@pluxel/host` 导入                   | 进程持有 Host。Electron 在 `app.whenReady()` 后创建，窗口使用期间一直保留                                           |
| 浏览器页面或 Dedicated Worker、LLRT、React Native | `startHost`，从 `@pluxel/host/embedded` 导入          | 页面、Worker 或嵌入引擎持有 Host。停止接收调用后等待 `host.close()`，再释放 Worker 或引擎                           |
| Cloudflare Workers                                | `createWorkerHost`，从 `@pluxel/host/cloudflare` 导入 | 模块持有驱动，每个事件通过 `worker.run({ ctx, env, signal }, callback)` 借用。部署变量相同时可在同一 isolate 复用根 |

前两个入口都接受 `startHost(application, { env })`，启动验收通过后返回 Host。Node 可配置代理，嵌入式使用宿主 Fetch。一次业务调用需要取消时，把 signal 传给该调用的 SDK 作用域。Cloudflare 的出站 I/O 须在事件内执行。响应流还要调用插件时传入 `responseBody: 'scope'`，使作用域保留到流结束。[独立轻量 Host](./configuration.md#独立轻量-host) · [Cloudflare 请求与流](./configuration.md#cloudflare-worker-host)

### 重开后还要保留什么

Node 和嵌入式 Host 直接启动时默认使用内存文件系统。要恢复插件的启停选择和配置，可给 `policy.document`、`config.document` 接入平台持久存储，或将 Host 的文档目录挂载到持久介质。Cloudflare 默认只在当前根内保留文档。isolate 回收没有可靠的关闭回调，需跨 isolate 恢复的数据应在业务操作完成前提交到持久服务。[保存配置和运行策略](./configuration.md#保存配置和运行策略)

插件保存自己的文件、状态或凭据时，可在首次使用时声明持久性要求。

- 文件用 `await ctx.fs({ durable: true, writable: true })`。缺少持久挂载时得到 `ENOTSUP`，只读挂载得到 `EROFS`。Cloudflare 的 `ctx.fs()` 也会以 `ENOTSUP` 拒绝。[文件系统](../plugin-development/fs.md)
- 结构化状态用 `await ctx.tinybase.open({ durable: true })`。会话后端得到 `DURABILITY_UNAVAILABLE`。写入后可用 `flush()` 等待后端确认。[TinyBase](../plugin-development/tinybase.md)
- 部署凭据可选择只读 bindings，修改绑定记录得到 `READ_ONLY`。Node 或嵌入式插件需要保留自己写入的加密凭据时，给 Vault 数据目录挂载持久后端，在 `zenfs.durableMounts` 声明该挂载，并设置 `coreConfig.vault.durable: true`。[Vault 后端](../plugin-development/vault.md#host-后端与部署输入)

## 开发与交付

固定插件随应用发布。替换浏览器或扩展中的插件代码时，发布新的应用版本。Cloudflare 部署新的 Worker 版本。开发时可让 Node 的 Vite Host 用 `sources` 联调插件源码，Worker 用对应 Vite environment 的 `@pluxel/hmr` 解析条件、`pluginModules` 和接受更新的入口。发布时通过包的公开入口加载编译后的插件，整个依赖树都须能在目标引擎执行。Worker 和 workerd 的 Vite 配置见 `projects/host-targets/vite.dev.ts`。[插件包开发与交付](../development/plugin-package.md)

应用发布后仍要安装插件时，由宿主决定何时加载新文件。

- Node 的 modules 加载器可在下次启动扫描已安装的模块。托管 Node 服务可显式接入 Vite 在线消费来源。[动态来源](./configuration.md#动态来源)
- Rust/LLRT 示例把可信的本地插件文件装入应用目录，关闭 Host 并排空 VM，再在同一 Rust 进程创建新 VM 读取插件。构建和安装步骤见 `projects/host-llrt/README.md`。
- Expo 的 Android 示例通过系统文件选择器安装可信的独立制品，由 Hermes 在 JS 运行时重载后读取。应用私有目录保存安装包，插件的会话文件和 TinyBase 快照仍使用示例的内存后端。构建和安装步骤见 `projects/host-expo/README.md`。

## 发布前确定哪些输入

| 数据                             | 随应用发布                                                             | 部署或运行时                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 公开规则、模板、字典             | 直接导入 TS、JSON 或静态资源                                           | 随版本更新，查询无需打开文件或 Store                                                                     |
| 普通部署配置                     | 插件用 `configs.use()` 声明 schema，应用在节点或 fork 上映射环境变量名 | Host 在创建根时解码，再按节点的配置优先级采用                                                            |
| 部署凭据                         | 应用用 `envBindings` 声明 Vault 的记录键、schema 和变量名              | 部署方提供实际值，Host 校验后注入只读记录                                                                |
| 可修改的初值，如默认主题         | 插件创建带初值的 Store，交给 `ctx.tinybase.open(store)`                | 首次无快照时采用初值。已有快照时恢复完整内容，包括用户保存的空 Store                                     |
| 运行中产生的偏好、游标、业务记录 | 确定数据需要保留多久                                                   | 可重建的数据可放在会话存储中。需跨重启恢复时使用持久后端，多个实例协调写入时使用具有相应一致性保证的服务 |

Pluxel 的 standalone 和 modules 应用构建会从源码读取节点、fork 及绑定映射，校验记录键、环境名与 schema 路径，并将部署变量的名称和说明写入发行目录的 `.env.example`。插件清单和映射须能静态解析，无法解析时构建报错。构建机无需持有实际凭据。使用 Vite 构建浏览器或 Cloudflare Worker 时，由应用显式传入部署值。发给浏览器的值对终端用户可见，服务端 token 应留在服务端。 [部署绑定](./configuration.md#绑定部署环境与-json-文件) · [TinyBase 初值与恢复](../plugin-development/tinybase.md#打开并使用原生-store)

## 移植到新的 JS 引擎

Host 与插件须使用同一份框架运行时。按目标引擎打包宿主，先加载必要的 polyfill，再导入应用模块。Electron 主进程等宿主可通过服务提供原生能力。桌面示例只向插件开放 `app` 的名称和版本。主进程入口位于 `projects/host-electron/index.js`。[宿主服务](./services.md)

| 用到的功能                  | 引擎或平台要提供什么                                                                                                                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 加载框架                    | 制品使用的 ECMAScript 特性，包括 Proxy、Reflect、Promise、AggregateError、稳定的 `Symbol.dispose` 和 `Symbol.asyncDispose`。还需 UTF-8 编解码、安全的 `crypto.randomUUID()` 和 console 日志方法                                                       |
| 直接启动 Node 或嵌入式 Host | ZenFS 在模块加载时用到 `performance.now()`、`TextDecoder` 和支持 `en-US` 的 `Intl.NumberFormat`。创建默认目录还需要 `URL`、`structuredClone`                                                                                                          |
| 调用与停止插件              | 定时器、`AbortController`、`AbortSignal.any()`。嵌入式宿主须驱动 Promise 任务队列，在释放引擎前等待已接纳的调用和 Host 关闭。Cloudflare 接纳事件需要 `Promise.withResolvers()`                                                                        |
| `ctx.fetch`、`ctx.wretch`   | URL、Headers、Request、Response、DOMException、`signal.throwIfAborted()` 和可取消的 Fetch。Wretch 的 GET 也需要全局 FormData。并发排队用到 `Promise.withResolvers()`，计时用到 `performance.now()`。限制 origin 时，传输必须遵守 `redirect: 'manual'` |
| `ctx.logger`                | 配置 LogTape 的 sink 和级别，在真实输出端检查插件日志。同一份 LogTape 运行时同时只允许一个根托管其配置                                                                                                                                                |
| 文件与 TinyBase 快照        | 提供所需 ZenFS 后端或文档存储。快照使用 UTF-8 和 `queueMicrotask`。验收持久介质时，写入后关闭并重开 Host，读回原值                                                                                                                                    |
| 加密 Vault                  | 可写文件、UTF-8、`crypto.getRandomValues()`、WebCrypto AES-GCM 的 `importKey`、`encrypt`、`decrypt` 及 age 的运行依赖。使用加密后端时，读取只读部署记录也会先打开加密库                                                                               |

LLRT 示例在加载应用前补齐英文 Intl。该示例使用的 LLRT v0.9.0-beta 在取消从现有 signal 创建的 Request 时，监听器可能已触发而 `request.signal.aborted` 仍为 `false`。可直接调用 `ctx.fetch(url, { signal })`。Expo 示例补齐安全随机数、UUID 和资源释放 Symbol，设备上的 HTTP 验收另需覆盖取消、响应流和跨 origin 重定向。移动端示例使用 Android release 和注入的测试传输。分别见 `projects/host-llrt/src/bootstrap.ts` 和 `projects/host-expo/src/run.ts`。

## 如何验收一个宿主

通过目标应用的真实入口运行插件。对固定集合，停用一项功能、修改配置后再启用，观察业务输出，并在重开应用后核对保存结果。接入新的 Fetch 传输时，取消一项在途请求。限制 origin 时发送跨 origin 的 302，确认第二个端点没有收到请求。[出站 HTTP](../plugin-development/outbound-http.md)

框架维护者可从源码仓库根目录运行以下检查。第一项在 Node、Chromium Dedicated Worker 和本地 workerd 加载同一个已发布格式的插件包。第二项在真实 Chromium 重开 IndexedDB 后端并读回已提交的字节。

```sh
vp run @pluxel-example/host-targets#check-smoke
vp run @pluxel/core#check-zenfs-browser
```

如需验收独立插件安装，保留同一份可执行文件或 APK，另外构建插件，经应用正常入口安装，离线重开后调用它，最后卸载并核对内建插件仍可用。Rust 示例可运行 `vp run @pluxel-example/host-llrt#check-smoke`。Android 的构建和设备操作见 `projects/host-expo/README.md` 的「Android 设备验收」。
