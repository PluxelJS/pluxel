# @pluxel/host-dev

拥有专用 `pluxel` Vite environment、模块分类与失效、候选提交和恢复队列。它依赖 Core/Host，并按应用的显式服务清单创建宿主。

```ts
import { host } from '@pluxel/host-dev/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [host({ entry: './app.ts', devConsole: true })] })
```

`app.ts` 默认导出 `defineHostApplication(factory)`（来自 `@pluxel/host`）。每次启动向工厂传入 startup，等待其返回完整 plugins、sources、services 与存储配置。
服务准备完成后才启动插件；工厂 identity 变化（包括固定插件 import 失效）会重新求值并重建整个 Host。工厂求值失败保留旧 Host；服务准备或启动失败则从上次成功工厂与 startup 快照创建补偿宿主。动态来源单独更新且工厂不变时仍提交 catalog HMR。
源码更新经过同一串行队列；求值失败保留已接受目录，修复后重新提交。关闭时撤回 watcher 并排空已接纳的工作。

安装来源重新发布入口时会刷新包解析元数据及已加载的 ESM 依赖。原生模块和 CommonJS 由 Node 持有；
升级应使用新的不可变安装路径，原路径覆盖已加载的原生模块或 CommonJS 文件需要重启进程。

官方应用使用 `@pluxel/services/vite` 的 `vitePreset({ entry, devConsole: true })`，在此驱动上组合官方服务附件。`host()` 本身不选择官方服务附件；自定义附件通过 `HostDevelopmentPluginApi` 接入同一生命周期，模块身份通过与 `host()` 配合的 `hostSingletons({ packages })` 显式选择。

`host()` 通过 Vite 的环境工厂创建专用 `pluxel` environment，并使用该环境自带的 runner 和关闭流程。
应用声明、动态插件与控制台共享它的模块身份及 HMR 队列。默认 SSR、第三方 `ssrLoadModule` 及用户自定义 SSR
factory 独立工作，不接受 Host 的 source conditions、singleton 或语义 collector；其 Plugin constructor 也不能
充当 Host 中的同一个类。只有 `pluxel` environment factory 是框架保留配置。
Runner、分类器和失效辅助函数属于内部实现，不是公共 Vite API。

开发控制台由本包完整提供，类型从 `@pluxel/host-dev/console` 导入。它直接操作 Host 的插件和基础配置；脚本通过 `dev.ctx` 及显式导入的服务 API 访问已安装能力，不要求官方服务或 optional peer dependencies。取消信号通过 `dev.signal` 传给服务，脚本负责释放自行取得的资源。详见[开发控制台](../../docs/development/dev-console.md)。

作者用法见 [创建应用](../../docs/getting-started/index.md)，实现边界见 [HMR](../../engineering/HMR.md)。

Host 开发诊断统一使用结构化 `error(message, { error })`：Host 尚未就绪或已开始关闭时由用户配置的 Vite logger 输出原始错误链，
就绪后使用当前 Context logger；Host 替换后随新 Context 切换。此适配不修改 Vite `customLogger`，也不安装日志 sink。
裸 Host 若未配置日志输出，Context logger 的存在本身不保证日志可见；需要日志输出时显式安装相应服务。
