# Pluxel Host targets

同一个 Consumer 在 Node、浏览器 Dedicated Worker 和 Cloudflare workerd 中调用 Provider。Provider 按节点配置通过 `ctx.fetch` 读取来源，用 TinyBase 保存本次 Host 的访问次数。Node 提供固定响应，浏览器读取同源资源，workerd 访问原生 Service Binding。[共享插件](plugins/src/index.ts) · [应用声明](src/demo-plugins.ts)

## 本地开发

在本目录运行 `vp run dev`，打开 Vite 输出的地址。页面显示三个宿主的问候和计数。点击 **Run plugins**，三端访问次数各增加一次。修改 Provider 的问候语并保存，页面采用新问候，计数继续累加。修改应用工厂触发入口重载，新 Host 从 1 开始计数。[Provider](plugins/src/index.ts)

Node 的 Vite 入口用 `sources` 读取插件源码。浏览器和 workerd 在相应 Vite environment 配置 `pluginModules`、`@pluxel/hmr` 和接受更新的插件入口。Cloudflare 会等待已接纳的事件结束再切换。接入自己的插件包时，发行构建从包的发布入口导入编译后的 ESM。[Node 来源](src/node-app.ts) · [Vite 配置](vite.dev.ts) · [Dedicated Worker](src/browser.worker.ts) · [Cloudflare](src/cloudflare/entry.ts)

## 构建与验收

- `vp run build` 先用 `pluxel build` 构建插件包，三个目标从同一发布入口加载编译后的 ESM。
- `vp run preview` 用本地 workerd 预览 Cloudflare 制品并服务浏览器页面。
- 构建后运行 `GREETING_NAME=Ada vp run start:node`，第一次调用返回 `Hello, Ada!` 和 `visits: 1`。浏览器构建从 `VITE_GREETING_NAME` 读取同一项配置，Cloudflare 从 `wrangler.jsonc` 的 `vars.GREETING_NAME` 读取。
- `vp run test:smoke` 用插件 tarball 构建三个目标，从各端的部署输入传入名字，检查发布应用返回的问候和访问次数。开发模式另行检查热更新时计数是否保留，以及故障后的恢复。测试使用本机 Playwright Chromium，也可用 `PLAYWRIGHT_WS_ENDPOINT` 连接现有实例。[验收脚本](scripts/smoke.mjs)

## 在其他宿主验收内建能力

示例插件是框架仓内的私有包。在 `projects/host-targets/plugins` 运行以下命令，再将生成的 tarball 安装到目标宿主工程。

```sh
vp run build
vp pm pack --out ../host-targets-plugins.tgz
```

Electron、LLRT 和 Expo 的移植示例使用这个包的 `/probe` 入口验证网络、Vault、会话存储、事件与清理，并通过各自的服务访问原生能力。[共享断言](plugins/src/probe.ts) · [宿主项目](../README.md#cross-platform-host-examples)

workerd 默认没有文件后端，TinyBase 只保存会话数据。Host 包直接在 workerd 中检查文件访问和持久 Store 请求的失败结果。[workerd 存储回归](../../packages/host/tests/cloudflare/runtime.test.ts)
