# @pluxel/host-vite

在 Vite 中执行 Pluxel 应用；开发支持控制台，生产持续更新预编译来源。

```ts
import { host } from '@pluxel/host-vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [host({ entry: './app.ts', scripts: true })] })
```

`app.ts` 默认导出 `defineHostApplication(factory)`。官方服务应用可改用 `@pluxel/services/vite` 的 `vitePreset()`；`host()` 本身不安装官方服务附件。

| 入口   | 用途                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------- |
| 根入口 | `host()` 与显式 singleton 选择；[工具链](../../docs/development/tooling.md)                                 |
| `/hmr` | 浏览器与 Worker 模块使用 `closeOnHotReload(import.meta.hot, host)` 在重载时关闭所持有的 Host                |
| `/run` | `runViteApplication({ root, configFile, signal? })`；[生产配置](../../docs/host/configuration.md#vite-生产) |

项目脚本统一使用 `@pluxel/agent-sdk/host` 的 `Script` 和 SDK，通过 `sdk.ctx` 借用 Context；用法见[开发控制台](../../docs/development/dev-console.md)。

应用、来源插件与开发控制台共享专用 `pluxel` environment。默认 SSR 和第三方 `ssrLoadModule` 独立，不能用其中的 Plugin constructor 操作 Host 实例。源码变更由同一有界批次调度器处理，失败候选不覆盖已接受事实；连续编辑使用 [dev console 的 pause/apply/resume](../../docs/development/dev-console.md#hmr-批次控制) 控制接纳时机。

HMR、工厂重建、恢复和关闭约束见 [HMR.md](../../engineering/HMR.md)；开发诊断不自动安装日志 sink，输出配置见[日志](../../docs/plugin-development/logging.md)。

生产需新 NODE_ENV=production 进程；会话启动等待准备、启动报告和 listener，close/abort 排空更新并释放资源。原生一次扫描使用 `@pluxel/host`，见 [Host 配置](../../docs/host/configuration.md#动态来源)。

浏览器 Worker 或 Cloudflare 应用可在 Vite 配置中使用 `@pluxel/host-vite/modules` 的 `pluginModules({ root, environments })`。每个选中的 Vite environment 单独编译插件与配置声明。源插件包通过 `packageJsonPath` 提供公开导出身份。HMR 接受边界由持有 Host 或当前计划的模块定义。 [Market 的 workerd 配置](../../projects/plugin-market/vite.dev.ts) · [三端示例](../../projects/host-targets/vite.dev.ts)
