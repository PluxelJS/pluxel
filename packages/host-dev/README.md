# @pluxel/host-dev

共享的 Vite ModuleRunner、模块分类与失效、候选提交和恢复队列。它依赖 Core/Host，并按应用的显式服务清单创建宿主。

```ts
import { host } from '@pluxel/host-dev/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [host({ entry: './app.ts' })] })
```

`app.ts` 默认导出 `HostApplication`，通过 `plugins` 声明固定目录，通过可选 `sources` 组合动态来源，通过可选 `services` 安装固定服务清单。
服务准备完成后才启动插件；服务声明变化会排空并重建整个 Host，创建失败则从上一份应用声明创建补偿宿主。
源码更新经过同一串行队列；求值失败保留已接受目录，修复后重新提交。关闭时撤回 watcher 并排空已接纳的工作。

安装来源重新发布入口时会刷新包解析元数据及已加载的 ESM 依赖。原生模块和 CommonJS 由 Node 持有；
升级应使用新的不可变安装路径，原路径覆盖已加载的原生模块或 CommonJS 文件需要重启进程。

使用官方 Runtime 服务时，从 `@pluxel/runtime/vite` 导入 `runtime({ entry })`。
该入口在同一驱动上组合 Workbench/Node artifacts、HTTP 和可选开发控制台，不需要再安装 `host()`。

作者用法见 [创建应用](../../docs/getting-started/index.md)，实现边界见 [HMR](../../engineering/HMR.md)。
