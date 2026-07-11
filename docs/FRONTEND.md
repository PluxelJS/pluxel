# Frontend and Web Management

插件 HTTP 路由是常驻能力；插件 UI、管理 RPC/SSE 与管理态同步属于可选的 Web Management bundle。

插件只通过一个 gate 注册管理能力：

```ts
import { ui } from '@pluxel/runtime/web-management'

const pluginUi = ui(import.meta.url, './ui/index.tsx')

this.ctx.webManagement.use((web) => {
	web.ui.register(pluginUi)
	web.rpc.expose(() => new PluginRpc(this))
	web.sse.expose(() => this.events())
	web.state.collection({ name: 'status' })
})
```

`ui()` 是纯声明。开发环境的 `web.ui.register()` 交给 Vite UI compiler；生产环境注册插件构建生成的 federation artifact。两种环境使用同一个作者 API，不存在运行期 AST bridge。

宿主关闭 Web Management 时 callback 不执行，UI compiler、watcher、管理路由和状态同步后端均不初始化，插件的 HTTP 与生命周期不受影响。

浏览器侧继续使用 `@pluxel/runtime/web` 提供的插件 UI API。完整边界见 `docs/PLUGIN_AUTHORING_FINAL.md`。
