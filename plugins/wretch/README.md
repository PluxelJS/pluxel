# `@pluxel/wretch`

Pluxel 官方出站 HTTP 插件，基于 [Wretch](https://github.com/elbywan/wretch)。插件提供一个带宿主级
outbound policy 的原生、不可变 Wretch base；请求构造、addon、middleware、catcher 和 response chain 仍
完全使用 Wretch API。

## 使用

```sh
pnpm add @pluxel/wretch @pluxel/runtime
```

把 `WretchPlugin` 放进宿主 catalog，需要 HTTP 的插件通过 constructor 声明 required dependency：

```ts
import { BasePlugin, Plugin, v } from '@pluxel/runtime'
import { WretchPlugin, type Wretch } from '@pluxel/wretch'

type Customer = { id: string; name: string }

const CustomerConfig = v.object({
	baseUrl: v.pipe(v.string(), v.url()),
})

@Plugin()
export class CustomerPlugin extends BasePlugin {
	private readonly config = this.configs.use(CustomerConfig)
	private api!: Wretch

	constructor(private readonly http: WretchPlugin) {
		super()
	}

	override init(): void {
		this.api = this.http.client.url(this.config.baseUrl, true)
	}

	find(id: string) {
		return this.api.get(`/customers/${encodeURIComponent(id)}`).json<Customer>()
	}
}
```

`client` 本身就是 Wretch。Wretch 的 immutable 语义保证不同 consumer 从同一个 base 派生 `.url()`、
`.options()`、`.headers()`、`.auth()`、`.addon()` 或 `.middlewares()` 时不会互相污染。

主入口只导出 `WretchPlugin` 和 `Wretch` 类型，不重新导出裸 `wretch()` factory 或 addon/middleware。
创建不受宿主 policy 管理的普通 Wretch 时应直接使用上游 `wretch` 包。

需要 retry、dedupe、query string 或其他扩展时直接使用 Wretch 原生模块：

```ts
import QueryStringAddon from 'wretch/addons/queryString'
import { retry } from 'wretch/middlewares'

this.api = this.http.client
	.url(this.config.baseUrl, true)
	.addon(QueryStringAddon)
	.middlewares([retry({ maxAttempts: 2, retryOnNetworkError: true })])
```

如果 consumer 直接导入 Wretch 的 addon/middleware，请把 `wretch` 声明为自己的 dependency，以明确所用
原生 API 的版本。

## 宿主级 policy

`WretchPlugin` 的 Pluxel config 会自动进入标准 Config UI：

| 字段                    | 默认值 | 含义                                                |
| ----------------------- | ------ | --------------------------------------------------- |
| `timeoutMs`             | 30000  | 每次实际 fetch attempt 的超时；`0` 表示关闭         |
| `maxConcurrentRequests` | 64     | 所有 consumer 共用的实际 fetch attempt 上限         |
| `maxQueuedRequests`     | 256    | 并发满时允许等待的 attempt 数                       |
| `allowedOrigins`        | `[]`   | 空列表不限制；非空时只允许列出的精确 HTTP(S) origin |

policy 使用一个 deferred Wretch middleware 安装：consumer 先完成自己的 immutable chain 组合，请求发送前
provider middleware 才被追加到末尾。因此 consumer 的 retry middleware 位于外层，每次 retry attempt 都会
单独经过 origin、admission 和 timeout，而不是让一个逻辑请求长期占用并发槽。

`.fetchPolyfill()` 仍按 Wretch 原生语义工作，并且不会绕过 provider middleware，适合测试或自定义 fetch
boundary。只有显式清空 deferred callbacks 才会移除 provider policy，不应在受管 client 上这样做。

client 与取得它的 consumer/provider lifecycle generation 绑定。任一方 stop 或 replacement 后，缓存的旧 client
会拒绝新请求，等待并发槽的请求会被解除排队；已经进入 fetch 的请求会收到 lifecycle abort signal。自定义 fetch
需要遵守标准 `AbortSignal`，才能在 teardown 时立即结束。

retry、dedupe、缓存、鉴权刷新和业务错误解析不属于进程级安全不变量，插件不会替 consumer 决定。需要缓存
时显式组合 `@pluxel/cache`。

## 可选 Workbench 配置 UI

中心插件提供 `WretchWorkbenchPort` renderer。consumer 只负责决定标签页 placement，不实现表单 UI：

```ts
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { WretchWorkbenchPort } from '@pluxel/wretch/workbench'

export const CustomerWorkbench = workbench.portOutlet({
	id: 'Http',
	port: WretchWorkbenchPort,
	placement: workbenchContract.tab({
		label: 'HTTP',
		icon: workbenchContract.icons.Settings,
	}),
})
```

`portOutlet()` 从 Port 自动派生一对一 resource contract 和 mapping。consumer 启动时显式启用持久化设置，
并绑定 caller-owned RPC：

```ts
override async init(): Promise<void> {
	await this.http.enableManagedSettings()
	this.api = this.http.client.url(this.config.baseUrl, true)

	this.ctx.workbench?.mount(CustomerWorkbench, {
		settings: workbench.bind.rpc(() => this.http.workbenchSettings()),
	})
}
```

UI 当前统一管理：

- 会覆盖 consumer 同名普通 header 的运行时请求头；
- HTTP(S) proxy；
- 只能收紧宿主上限的 consumer timeout。

设置按 caller 的结构化 Plugin node address 隔离：文件名只使用 canonical address bytes 的完整 SHA-256，文件内容同时保存并
校验完整 owner address。`displayName` 相同的 Plugin/fork 不会冲突；只接受当前 v2 envelope，并存储在
`consumers/v3`。`client` 使用 Wretch `defer()` 在每次请求发送前读取当前设置，因此保存后
已经缓存的 client 也会自动生效，不需要重建。
同一 caller 并发调用 `enableManagedSettings()` 会共享一次初始化；缓存的 settings RPC 在 caller/provider stop 或
replacement 后会撤销，不能继续写入旧 generation。provider cleanup 也会主动释放全部 managed ProxyAgent，不依赖
consumer 必须级联停止。

Authorization、Cookie、Proxy-Authorization、X-API-Key，以及带路径或凭据的 proxy URL 会被拒绝。
当前设置页不支持 authenticated proxy；secret 不进入普通 persistence、日志或 browser contract。
Workbench disabled 时不会创建 UI backend；consumer 已选择启用的持久化设置仍会应用于核心 HTTP client。

实现边界见 [`DESIGN.md`](DESIGN.md)。
