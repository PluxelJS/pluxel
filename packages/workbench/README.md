# @pluxel/workbench

可组合的 Workbench 发布服务、制品库存与浏览器 SDK。独立 Host 和 Runtime 使用同一 registry、session、renderer scope 和制品提交实现。

- `@pluxel/workbench`：`workbench` 定义 DSL 与 owner-only `Workbench` token。
- `@pluxel/workbench/service`：`workbenchService()`，在 Host 准备阶段装载配置的 production artifact inventory。
- `@pluxel/workbench/server`：受信任宿主的 backend/session 与 `createWorkbenchArtifactHandler()`。
- `@pluxel/workbench/http`：`workbenchHttp({ uiBasePath?, publicDir? })`，将官方 Shell、认证管理连接及制品接入 HTTP。
- `@pluxel/workbench/shell`：已有 HTTP 宿主可复用的 `createWorkbenchShellHandler()`。
- `@pluxel/workbench/client`、`/react`、`/federation`：浏览器 entry，保持各自依赖边界。
- `@pluxel/workbench/dev`：普通 Vite `workbenchArtifacts()` 插件，复用 Host 的 semantic candidate 和已有 Rolldown producer compiler。

```ts
import { createHost } from '@pluxel/host'
import { workbenchService } from '@pluxel/workbench/service'

const host = await createHost({ plugins: [], services: [workbenchService()] })
await host.start()
await host.close()
```

业务 Plugin 使用 `this.ctx.require(Workbench).publish(UI, bindings)`。通用 Context 的 `workbench` 属性仍可选；root 不暴露发布 view，管理端通过 `/server` 获取 backend。

Vite 应用使用 `plugins: [host({ entry: './app.ts' }), workbenchArtifacts()]`。安装运行时服务本身不会启用编译器。制品更新复用当前 Host；来源清单由已有 revision hashing 输出，未关联文件不会触发重建。新发布使旧 session 失效；构建中的 renderer 显示 building，失败显示 failed，已提交不可变 URL 仍可读取。

生产环境不需要安装 `/dev` 的可选 Vite、Host-dev 和 Rolldown peers。HTTP handler 只服务库存中的不可变文件；认证与连接 ownership 由调用它的管理 endpoint 持有。

完整示例见 [独立 Host 的 Workbench](../../docs/workbench/standalone-host.md)。
