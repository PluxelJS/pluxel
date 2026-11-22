# Pluxel Host targets

Node 构建入口、浏览器 Worker 和 Cloudflare 导入同一个 [应用工厂](src/demo-plugins.ts)，用 `env.GREETING_SOURCE` 选择插件配置。[Node 的 Vite 开发入口](src/node-app.ts) 使用同一声明 API 配置动态插件来源。

同一个 [插件包](plugins/package.json) 在 Node Host、浏览器 Dedicated Module Worker 和 Cloudflare isolate Host 中运行。Consumer 通过构造器依赖调用 Provider。Provider 校验应用配置，用 `ctx.fetch` 读取问候来源，并将访问次数写入 TinyBase。

## 本地开发

在本项目目录运行 `vp run dev`，打开 Vite 输出的地址。页面显示三个宿主的调用结果。

编辑 [Provider](plugins/src/index.ts) 中的问候语，三列会自动重新调用插件并显示结果或错误。页面结果包含插件地址、generation 和访问次数。**Run plugins** 可以手动再次调用三端。

| 目标       | 更新方式                                                          | 访问次数 |
| ---------- | ----------------------------------------------------------------- | -------- |
| Node       | 在当前 Host 中替换插件 generation                                 | 继续累加 |
| 浏览器     | Worker 接受插件更新，在原 Host 提交 catalog                       | 继续累加 |
| Cloudflare | 同一 isolate 复用 Host，插件更新等待在途调用结算后替换 generation | 继续累加 |

Node 用显式 Fetch 传输提供固定样本数据，浏览器读取同源静态数据，workerd 的出站传输在每次调用时从 `cloudflare:workers` 的 `exports` 取得原生 loopback Service Binding。

[浏览器 Worker](src/browser.worker.ts) 和 [Cloudflare 入口](src/cloudflare/entry.ts) 将 Vite 的 `accept` 边界设在插件包上。编辑应用工厂时 Vite 重载入口，新 Host 从 1 开始计数。Cloudflare 使用 `closeOnHotReload` 排空旧 Host 再交接。

## 构建与验收

- `vp run build` 先用 `pluxel build` 构建插件包，三个目标从同一个包的发布入口消费已 lowering 的 ESM。
- `vp run preview` 用本地 workerd 预览 Cloudflare 制品并服务浏览器页面。
- `vp run start:node` 执行已构建的 Node 入口，输出一条调用结果后释放 Host。
- `vp run test:smoke` 把插件包打成一个 tarball，在只有发布内容的临时目录构建并运行三个目标。另用临时源码验证自动刷新、generation 切换、状态寿命、请求与编辑交错以及失败后恢复。测试使用本机 Playwright Chromium，也可用 `PLAYWRIGHT_WS_ENDPOINT` 连接现有实例。
