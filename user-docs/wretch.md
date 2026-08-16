# 出站 HTTP（Wretch）

`@pluxel/wretch` 用 required plugin dependency 提供带宿主级 outbound policy 的原生 Wretch base。

```ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { WretchPlugin, type Wretch } from '@pluxel/wretch'

@Plugin({ displayName: 'Catalog' })
export class CatalogPlugin extends BasePlugin {
	private api!: Wretch

	constructor(private readonly http: WretchPlugin) {
		super()
	}

	override init(): void {
		this.api = this.http.client.url('https://catalog.example/api', true)
	}
}
```

`client` 是 immutable Wretch object。每个 consumer 用原生 `.url()`、`.options()`、`.headers()`、
`.addon()` 和 `.middlewares()` 派生自己的 API client；provider 不维护 caller profile。

provider config 只拥有所有 consumer 共享的 timeout、并发、等待队列和 origin 上限，并由 Pluxel 标准 Config
UI 编辑。retry、dedupe、鉴权和错误解析属于 consumer，直接使用 Wretch 原生 addon/middleware 表达。自定义
fetch 或测试使用 `.fetchPolyfill()`，仍会经过 provider policy。

缓存的 client 只属于创建它的 consumer/provider lifecycle generation。caller 或 provider stop/replacement 后，
旧 client 会拒绝新请求并解除等待队列；已经进入 fetch 的请求会收到 lifecycle abort signal。自定义 fetch 应遵守
标准 `AbortSignal`。

需要统一 HTTP 设置页时，consumer 调用 `await http.enableManagedSettings()`，再用
`workbench.portOutlet()` 把 `@pluxel/wretch/workbench` 的 `WretchWorkbenchPort` 放进自己的 placement。
中心 renderer 统一编辑运行时覆盖 headers、HTTP(S) proxy 和 consumer timeout；保存后会自动应用到已有
client。consumer 只决定 placement 和 caller-owned RPC grant，不实现 Contract resource mapping 或表单。
同一 caller 并发启用设置时只会执行一次 persistence/proxy 初始化；caller/provider stop 或 replacement 会撤销旧
settings RPC，旧 generation 不能继续读写配置，managed proxy 也会随任一 lifecycle cleanup 释放。

敏感 headers 和 proxy credential 不进入这套普通配置；当前设置页不支持 authenticated proxy。领域测试请求
仍由 consumer 自己的 RPC 定义，中心插件不提供任意 URL 请求控制台。

应用自己的 consumer Plugin 直接从 `@pluxel/wretch` 根入口注入 `WretchPlugin`；需要共享设置 UI 时再消费
plugin-free 的 `@pluxel/wretch/workbench` Contract/Port 边界。
