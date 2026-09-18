# @pluxel/host-dev

共享的 Vite ModuleRunner、模块分类与失效、候选提交和恢复队列。它依赖 Core/Host，并按应用的显式服务清单创建宿主。

```ts
import { host } from '@pluxel/host-dev/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [host({ entry: './app.ts', devConsole: true })] })
```

`app.ts` 默认导出 `HostApplication`，通过 `plugins` 声明固定目录，通过可选 `sources` 组合动态来源，在每次启动的 `configure(startup)` 中选择服务和存储配置。
服务准备完成后才启动插件；服务声明变化会排空并重建整个 Host，创建失败则从上一份应用声明创建补偿宿主。
源码更新经过同一串行队列；求值失败保留已接受目录，修复后重新提交。关闭时撤回 watcher 并排空已接纳的工作。

安装来源重新发布入口时会刷新包解析元数据及已加载的 ESM 依赖。原生模块和 CommonJS 由 Node 持有；
升级应使用新的不可变安装路径，原路径覆盖已加载的原生模块或 CommonJS 文件需要重启进程。

官方应用使用 `@pluxel/services/vite` 的 `vitePreset({ entry, devConsole: true })`，在此驱动上组合官方服务附件。`host()` 本身不选择官方服务附件；自定义附件通过 `HostDevelopmentPluginApi` 接入同一生命周期，模块身份通过 `hostSingletons({ packages })` 显式选择。

开发控制台由本包完整提供，类型从 `@pluxel/host-dev/console` 导入。它直接操作 Host 的插件和基础配置；脚本通过 `dev.ctx` 及显式导入的服务 API 访问已安装能力，不要求官方服务或 optional peer dependencies。取消信号通过 `run.signal` 传给服务，脚本负责释放自行取得的资源。详见[开发控制台](../../docs/development/dev-console.md)。

作者用法见 [创建应用](../../docs/getting-started/index.md)，实现边界见 [HMR](../../engineering/HMR.md)。
