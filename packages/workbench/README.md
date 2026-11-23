# @pluxel/workbench

可组合的 Workbench 发布服务、制品库存与浏览器 SDK。独立 Host 和官方服务组合使用同一 registry、session、renderer scope 和制品提交实现。官方 Shell 源码在本包 `shell/`，构建资源随包交付，不需要另一个应用包。

- `@pluxel/workbench` 提供 `workbench.define(import.meta.url, entries)` 和归属插件的 `Workbench` 服务。每个入口声明 Markdown 文档、React renderer 或其他插件提供的 Attachment。
- `@pluxel/workbench/react` 提供 `createWorkbenchRenderer(Definition.entry)`，由同一个 scope 访问本次打开的 RPC、宿主能力和查询资源。
- `@pluxel/workbench/service`：`workbenchService()`，在 Host 准备阶段装载配置的 production artifact inventory。
- `@pluxel/workbench/server`：受信任宿主的 backend/session 与 `createWorkbenchArtifactHandler()`。
- `@pluxel/workbench/http`：`workbenchHttp({ uiBasePath?, publicDir? })`，将官方 Shell 接入 HTTP；认证管理连接与制品由显式组合的 `managementHttp()` 持有。
- `@pluxel/workbench/shell`：已有 HTTP 宿主可复用的 `createWorkbenchShellHandler()`。
- `@pluxel/workbench/client`、`/react`、`/federation`：浏览器 entry，保持各自依赖边界。
- `@pluxel/workbench/vite`：`workbenchArtifacts()` 复用 Host 的 semantic candidate 与 Rolldown producer compiler。`@pluxel/workbench/dev` 的 `workbenchSourceShell({ entry })` 仅在开发将显式浏览器源码交给现有 Vite server。

```ts
import { createHost } from '@pluxel/host'
import { workbenchService } from '@pluxel/workbench/service'

const host = await createHost({ plugins: [], services: [workbenchService()] })
await host.start()
await host.close()
```

业务 Plugin 在 `init()` 中调用 `this.ctx.service(WorkbenchRef)?.publish(UI, bindings)`，其中 `WorkbenchRef` 由 `defineServiceRef<Workbench>()` 声明。纯静态 Markdown 只传 `UI`。插件 generation 持有发布，宿主管理端通过 `/server` 获取 backend。 [插件作者指南](../../docs/workbench/index.md)

Vite 应用使用 `plugins: [host({ entry: './app.ts' }), workbenchArtifacts()]`。安装运行时服务本身不会启用编译器。制品更新复用当前 Host；来源清单由已有 revision hashing 输出，未关联文件不会触发重建。新发布使旧 session 失效；构建中的 renderer 显示 building，失败显示 failed，已提交不可变 URL 仍可读取。

原生生产通过 loaded owner 读取预编译制品，不加载 Vite/Rolldown；生产 Vite 使用 `/vite` 附件与已构建 Shell，拒绝 `/dev` 源码 Shell。HTTP handler 只服务库存中的不可变文件；认证与连接 ownership 由调用它的管理 endpoint 持有。

完整示例见 [独立 Host 的 Workbench](../../docs/workbench/standalone-host.md)。

维护 Shell 交互先读 [设计决策](../../engineering/WORKBENCH_DESIGN.md)，再按 [Frontend](../../engineering/FRONTEND.md) 定位状态所有者；使用说明见 [工作台操作](../../docs/workbench/operations.md)。
