# Pluxel Host targets

同一组 Provider 和 Consumer 插件分别运行在 Node Host、浏览器 Dedicated Module Worker 和 Cloudflare 请求 Host。Consumer 通过构造器依赖调用 Provider。Provider 读取通过 Valibot 校验的应用配置，用 `ctx.fetch` 读取问候来源，并通过 TinyBase 确认写入访问次数。

## 本地开发

在本项目目录运行 `vp run dev`，打开 Vite 输出的地址。页面显示三个宿主的调用结果。

编辑 [Provider.ts](src/Provider.ts) 中的问候语可观察更新。浏览器会收到 Vite 通知，关闭旧 Host、重建 Module Worker 并刷新结果。点击 `Run plugins` 查看另外两端的更新。Node 通过 Pluxel 的 Vite Host 替换插件 generation，保留当前 Host 的 TinyBase 数据。Cloudflare Vite 插件在本地 workerd 重新加载 Worker 模块，每次请求拥有独立的 Host 和会话状态。

Node 用显式 Fetch 传输提供固定样本数据，浏览器读取同源静态数据，workerd 通过原生 loopback Service Binding 取同一形状的响应。

## 构建与验收

- `vp run build` 构建浏览器和 Cloudflare 制品，另用 Vite SSR 构建 Node 入口。
- `vp run preview` 用本地 workerd 预览 Cloudflare 制品并服务浏览器页面。
- `vp run start:node` 执行已构建的 Node 入口，输出一条调用结果后释放 Host。
- `vp run test:smoke` 在真实 Chromium、本地 workerd 和 Node 中验证构建制品，再用临时源目录验证编辑后的三端更新。测试使用本机 Playwright Chromium，也可用 `PLAYWRIGHT_WS_ENDPOINT` 连接现有实例。
