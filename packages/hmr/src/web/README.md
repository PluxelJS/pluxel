# `@pluxel/hmr/web`（Web SDK）

`@pluxel/hmr/web` 是用于 **浏览器/React** 侧连接 Pluxel HMR 后端的 SDK，提供三类能力：
- **RPC**：调用 HMR 内置 API + 插件 UI 扩展 RPC（强类型）
- **SSE**：订阅插件事件（强类型）
- **Plugin UI authoring**：`definePluginUIModule` / `ExtensionPoints` / `useExtensionContext` / `doc` 等

> 仓库里还有一个 `@pluxel/hmr-web`（`private`）用于内部宿主（避免 `@pluxel/components` ↔ `@pluxel/hmr` 双向依赖）。
> 对外（插件/前端集成）请只依赖 `@pluxel/hmr/web`。

## 安装与导入

你只需要安装 `@pluxel/hmr`（对外只发布/建议依赖 `core / hmr / cli` 三个包），并从子路径导入：

```ts
import { createHmrWebClient } from '@pluxel/hmr/web'
```

运行环境要求：
- 浏览器（需要 `fetch` / `EventSource` / `window.location`）
- React（仅当你使用 `HmrWebClientProvider` / `useHmrWebClient` / Plugin UI authoring 相关 React 组件时需要）

## 快速开始（只写一个后端链接就能连）

`createHmrWebClient()` 支持 `origin`：只需要提供后端地址（host）即可：

```ts
import { createHmrWebClient } from '@pluxel/hmr/web'

const hmr = createHmrWebClient({
  origin: 'http://localhost:8787',
  // 跨域 + cookie 鉴权：
  credentials: 'include',
})
```

从 `origin` 推导的默认值：

- `apiBase`: `${origin}/__pluxel/hmr`
- `rpcBase`: `${apiBase}/rpc`
- `sse.url`: `${apiBase}/sse`

同源时可以不传任何配置：

```ts
const hmr = createHmrWebClient() // /__pluxel/hmr, /__pluxel/hmr/rpc, /__pluxel/hmr/sse
```

## RPC

两种常用方式：

```ts
import { rpcErrorMessage } from '@pluxel/hmr/web'

// 1) 内置 API（每次调用一个短生命周期 batch session）：
await hmr.withRpc((rpc) => rpc.ping())

// 2) UI 扩展 RPC（每次方法调用都会创建新 session，避免“Batch RPC request ended.”）：
await hmr.ui.MyPlugin.hello('world')
```

> 如果你的插件 id 不是合法标识符（例如包含 `-`），请用 `hmr.ui['my-plugin'].method()`。

补充：
- `hmr.withRpc(fn)` 更适合“打一组内置接口”的场景。
- `hmr.ui.<namespace>.<method>()` 更适合 UI 层频繁点按的场景（每次方法调用自动创建/释放 session）。

## SSE

```ts
// 命名空间 client（当你扩展了 UI.sse 时会自动带类型）
const off = hmr.sse.MyPlugin.on((msg) => {
	console.log(msg.event, msg.payload)
})

// 可选：只监听某些 event（服务端如果使用了自定义 event 名）
const offChanged = hmr.sse.MyPlugin.on((msg) => {
	console.log('changed', msg.payload)
}, 'changed')

// 关闭共享 SSE 连接
hmr.dispose()
off()
offChanged()
```

可选：只订阅部分 namespace（减少带宽/事件量）：

```ts
const hmr = createHmrWebClient({
  sse: { namespaces: ['extensions', 'MyPlugin'] },
})
```

内置 namespace：
- `hmr.sse.extensions`：用于插件 UI manifest 等宿主事件（例如 `{ type: 'ready' }` 或 manifest 更新事件）。

## 给插件 RPC/SSE 命名空间补类型

在插件（或集成包）里通过 declaration merging 扩展 `@pluxel/hmr/web`：

```ts
// types.d.ts（或任何被 tsconfig 包含的 TS 文件）
declare module '@pluxel/hmr/web' {
  namespace UI {
    interface rpc {
      MyPlugin: {
        hello(name: string): Promise<string>
      }
    }

    interface sse {
      MyPlugin: { type: 'changed'; value: number }
    }
  }
}
```

只要项目里 **导入了 `@pluxel/hmr/web`**，`hmr.ui.MyPlugin.*` / `hmr.sse.MyPlugin.*` 就会自动带上你声明的类型。

建议：
- 业务前端：把上述声明放在 `src/types/hmr.d.ts`，并确保 tsconfig `include` 能覆盖它。
- 插件/集成包：把声明放在包的 `*.d.ts`（或 `types.ts`）并随包一起发布。

## 给插件扩展宿主服务补类型（可选）

`ExtensionServices` 是 UI 插件“向宿主请求能力”的类型口子（例如导航、通知、宿主提供的 client 等）。

```ts
declare module '@pluxel/hmr/web' {
  interface ExtensionServices {
    myService: { hello: () => void }
  }
}
```

## React（可选）

如果你希望在 React 树里通过 context 访问同一个 client 实例：

```tsx
import { HmrWebClientProvider, useHmrWebClient } from '@pluxel/hmr/web'

export function App() {
	return (
		<HmrWebClientProvider options={{ origin: 'http://localhost:8787', credentials: 'include' }}>
			<Page />
		</HmrWebClientProvider>
	)
}

function Page() {
	const hmr = useHmrWebClient()
	// ...
	return null
}
```

## Auth（可选）

默认行为：
- `createHmrWebClient()` 会使用 `credentials`（默认 `same-origin`）包装 fetch（同时用于 RPC / API / SSE 探测）。
- 当鉴权失效（401/403 + redirectPath）时会触发默认的跳转处理（可通过 `auth.onBlocked` 自定义）。

## 相关导出

- `@pluxel/hmr/capnweb`：再导出 `capnweb`（用于让 UI bundle 与宿主使用同版本 capnweb）。
- `@pluxel/hmr/signaldb`：再导出 `@signaldb/core`。
