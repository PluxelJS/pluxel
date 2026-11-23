# Pluxel Host targets

Node 构建入口、浏览器 Worker 和 Cloudflare 导入同一个 [应用工厂](src/demo-plugins.ts)，用 `env.GREETING_SOURCE` 选择插件配置。[Node 的 Vite 开发入口](src/node-app.ts) 使用同一声明 API 配置动态插件来源。

同一个 [插件包](plugins/package.json) 在 Node Host、浏览器 Dedicated Module Worker 和 Cloudflare isolate Host 中运行。Consumer 通过构造器依赖调用 Provider。Provider 校验应用配置，用 `ctx.fetch` 读取问候来源，并将访问次数写入 TinyBase。

## 本地开发

在本项目目录运行 `vp run dev`，打开 Vite 输出的地址。页面显示三个宿主的调用结果。

把另一个 npm 插件包加入应用时，先从它的发布入口导入。需要跟随该包的源码编辑时，给 Node 配置源码 `sources`，给浏览器和 workerd 配置该包的 `pluginModules({ root, packageJsonPath, environments })` 和 `@pluxel/hmr` 导出条件，再在宿主入口接收该模块的 HMR。 [Node 源码来源](src/node-app.ts) · [Worker 编译与解析](vite.dev.ts)

编辑 [Provider](plugins/src/index.ts) 中的问候语，三列会自动重新调用插件并显示结果或错误。页面结果包含插件地址、generation 和访问次数。**Run plugins** 可以手动再次调用三端。

| 目标       | 更新方式                                                          | 访问次数 |
| ---------- | ----------------------------------------------------------------- | -------- |
| Node       | 在当前 Host 中替换插件 generation                                 | 继续累加 |
| 浏览器     | Worker 接受插件更新，在原 Host 提交 catalog                       | 继续累加 |
| Cloudflare | 同一 isolate 复用 Host，插件更新等待在途调用结算后替换 generation | 继续累加 |

Node 用显式 Fetch 传输提供固定样本数据，浏览器读取同源静态数据，workerd 的出站传输在每次调用时从 `cloudflare:workers` 的 `exports` 取得原生 loopback Service Binding。

[浏览器 Worker](src/browser.worker.ts) 和 [Cloudflare 入口](src/cloudflare/entry.ts) 将 Vite 的 `accept` 边界设在插件包上。编辑应用工厂时 Vite 重载入口，新 Host 从 1 开始计数。Cloudflare 使用 `closeOnHotReload` 排空旧 Host 再交接。

## 构建与验收

- `vp run build` 先用 `pluxel build` 构建插件包，三个目标从同一发布入口加载编译后的 ESM。
- `vp run preview` 用本地 workerd 预览 Cloudflare 制品并服务浏览器页面。
- `vp run start:node` 执行已构建的 Node 入口，输出一条调用结果后释放 Host。
- `vp run test:smoke` 把插件包打成一个 tarball，在只有发布内容的临时目录构建并运行三个目标。另用临时源码验证自动刷新、generation 切换、状态寿命、请求与编辑交错以及失败后恢复。测试使用本机 Playwright Chromium，也可用 `PLAYWRIGHT_WS_ENDPOINT` 连接现有实例。

## 在其他宿主验收内建能力

示例插件是框架仓内的私有包。在 `projects/host-targets/plugins` 运行以下命令，再将生成的 tarball 安装到目标宿主工程。

```sh
vp run build
vp pm pack --out ../host-targets-plugins.tgz
```

共享包的 `/probe` 入口提供插件清单、公开部署输入和验收函数。下面的浏览器应用要求同源的 `/probe.json` 返回 `{"source":"browser"}`。同一份代码在 LLRT、Electron 和 Expo 中还会运行各自的原生插件。 [宿主示例索引](../README.md#cross-platform-host-examples)

```ts
import {
	inspectHost,
	probeEnvironment,
	probePlugins,
} from '@pluxel-example/host-targets-plugins/probe'
import { createScriptScope } from '@pluxel/agent-sdk/host'
import { defineHostApplication } from '@pluxel/host/application'
import { startHost } from '@pluxel/host/embedded'

const sourceUrl = new URL('/probe.json', location.href).href
const application = defineHostApplication(() => ({
	plugins: probePlugins(sourceUrl),
	coreConfig: {
		http: { allowedOrigins: [location.origin] },
		vault: { backend: 'bindings' },
	},
}))
await using host = await startHost(application, { env: probeEnvironment })
await using scope = createScriptScope({ ctx: host.ctx })
const receipt = await inspectHost(scope.sdk, { sourceUrl, expectedSource: 'browser' })
```

`probeEnvironment` 只含公开测试标记 `HOST_PROBE=fixture-binding`。本项目的发布验收还分别经过 Node 进程环境、浏览器构建变量和 Cloudflare 事件绑定传入该值。发布构建收到该输入时会在启动钩子中执行验收，共享探针先调用两次，应用的首次请求读到第三次访问。 [应用工厂](src/demo-plugins.ts) · [共享验收函数](plugins/src/probe.ts)

`inspectHost` 通过 SDK 连续两次借助 Consumer 调用注入的 Provider，检查读取来源、运行代以及成功写入 TinyBase 后递增的计数，分别返回 `first` 和 `second`。它还会检查下列 `receipt.capabilities` 字段，任何一项不符合预期就抛出错误。

| 回执字段                            | 三端默认配置的预期                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fetchSource`、`wretchSource`       | 两者都等于该宿主的测试标记                                                                                                                                               |
| `vaultBinding`、`vaultWrite`        | 读取到预期的部署记录，返回 `true`；修改该记录得到 `READ_ONLY`                                                                                                            |
| `sessionFiles`                      | Node、浏览器是 `read-write`，表示已写入、读回并删除临时文件；Cloudflare 是 `ENOTSUP`                                                                                     |
| `durableFiles`、`durableState`      | 三端默认存储分别返回 `ENOTSUP` 和 `DURABILITY_UNAVAILABLE`。验收持久后端时单独调用 `HostCapabilities.inspect()`，核对 `read-write` 和 `opened`，再重开宿主读回已保存的值 |
| `owner`                             | 插件 Context 地址 `package:@pluxel-example/host-targets-plugins::HostCapabilities`。探针调用该 Context 的派生 logger；日志交付和归属需要在宿主所选 sink 另行观察         |
| `eventDeliveries`、`effectCleanups` | 都等于 1；释放 effect 后再次发事件，已注销的订阅没有收到通知                                                                                                             |
