# @pluxel/runtime

`@pluxel/runtime` 是 Pluxel 的 runtime kernel：提供稳定的 services、协议和运行时注册能力。

它只负责三件事：

- 创建和持有 `Context`
- 暴露稳定服务，如 `http / config / loader / ext / vault`
- 消费“已经确定好的运行时输入”，例如编译后的插件 UI remote 或宿主渲染 doc

它不负责：

- Vite
- HMR
- workspace source execution
- 任何 authoring/build-time 语义

这些都属于 `@pluxel/hmr`。

## 快速使用

```ts
import { Context } from '@pluxel/runtime'

const ctx = new Context({
	profile: 'prod',
	configService: { mode: 'file', path: './data/runtime/config.json' },
	pluginData: { dir: './data/plugin-data' },
	http: {
		controlPlane: { web: true, rpc: true, sse: true, auth: 'none' },
		uiAssets: 'static-built',
	},
})

export const fetch = (req: Request) => ctx.http.fetch(req)
```

## 前端边界

推荐把两类插件前端严格分开：

- 自定义插件前端：作者侧写 `ui('./ui/index.tsx').bind(ctx)`；这是 authoring/HMR bridge，不是 runtime contract
- 正式运行时注册：build 会把上面的 bridge 重写成 `ctx.ext.ui.packaged()`；runtime 只消费编译后的 MF remote
- 宿主渲染 doc：走 `ctx.ext.ui.doc(...)` + `ctx.ext.ui.helpers(...)` + `ctx.ext.signaldb.*`

`doc` 现在只依赖 SignalDB：

- 展示从 state collection 读取
- 交互把表单/按钮写入 action collection
- 副作用由插件后端 watch collection 后处理

这样 runtime 只理解“编译后 UI”和“受控 doc”，不会混入 authoring/HMR 细节。

## 开发期

runtime 本身不启动 Vite。开发期统一使用 `@pluxel/hmr`：

- `startHmrHostFromConfig(...)`
- `attachHmrRuntime(ctx, { workspaceSnapshot })`

## Subpath

- `@pluxel/runtime/services`：公开 services 类型与导出
- `@pluxel/runtime/logger`：日志与 log store
- `@pluxel/runtime/web`：浏览器侧 SDK / UI 协议
- `@pluxel/runtime/frozen`：冻结宿主生成器
- `@pluxel/runtime/shared`：给 `@pluxel/hmr` 复用的纯工具
- `@pluxel/runtime/internal`：runtime 与 hmr 的内部 glue

应用层自己的启动组合逻辑应放在应用侧，而不是放回 runtime。

## 维护文档

- `docs/ARCHITECTURE.md`
- `docs/PACKAGING.md`
- `docs/AGENT_RULES.md`
- `docs/SERVICES.md`
