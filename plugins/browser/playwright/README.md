# @pluxel/playwright

使用 `playwright-core` 连接部署方提供的外部浏览器；插件不安装、下载、启动或重启浏览器。
`protocol: 'cdp'`（默认）连接 Chromium / Lightpanda 的 CDP endpoint；`protocol: 'playwright'` 连接 Playwright server 的 WebSocket endpoint。
两种协议显式选择，不自动探测或降级重试。Playwright 协议要求客户端与服务端的 major.minor 版本一致，见[上游连接契约](https://playwright.dev/docs/api/class-browsertype#browser-type-connect)。
公共用法与 Host 绑定见[浏览器插件指南](../../../docs/plugins/browser.md)。

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { PlaywrightPlugin } from '@pluxel/playwright'

@Plugin()
export class PageTitlePlugin extends BasePlugin {
	constructor(private readonly browser: PlaywrightPlugin) {
		super()
	}

	async title(url: string, signal?: AbortSignal): Promise<string> {
		const context = await this.browser.newContext(undefined, { signal })
		try {
			const page = await context.newPage()
			await page.goto(url, { timeout: 15_000 })
			return await page.title()
		} finally {
			await context.close()
		}
	}
}
```

`newContext()` 保留 Playwright 的原生 `BrowserContextOptions`、`BrowserContext` 和 SDK 异常。
每次调用创建隔离 context；调用者应在 `finally` 关闭。插件和调用方停止时兜底关闭各自 context。
`signal` 只取消获取阶段；已经交付的 context 的后续操作使用原生 Playwright 超时与调用方的关闭策略。

配置选择 `endpoint` 或 `connectionKey`，二者互斥。无凭据的 endpoint 不需要安装 Vault。
含凭据的 URL（包括路径 token）、所有 query URL 和连接 headers 使用 Vault：
`PlaywrightVaultSchema` 是以 key 为索引的根 schema，单条记录形如 `{ endpoint, headers? }`。
`connectTimeoutMs` 默认为 30 秒；保存配置或更换 Vault 记录后需要显式重启插件。
初始化连接失败会产生不含 endpoint / header / 原始 cause 的生命周期错误。

连接断开后，新调用抛出 `PlaywrightNotRunningError`；插件不会隐式重连。
原生 context 是受信任的同进程 SDK 句柄，并非权限沙箱。不要通过 `context.browser()` 操作其它 context 或关闭共享连接。

Playwright 的 `newContext()` 和 `context.close()` 没有 AbortSignal；取消能立即结束调用方等待，但无法撤销已发送的浏览器请求。
停止会等待在途请求结束并关闭迟到资源。远程浏览器不响应且连接仍存活时，停止也可能等待；部署方应处理失效的远程连接。

包内测试使用真实 Pluxel Host / caller facade 与受控 SDK 替身，验证配置、Vault、归属、取消和释放。
这些测试不证明财政站点或 Lightpanda 的 CDP 兼容性；真实 endpoint 联调需要部署方提供连接。

## 外部端点验证

提供 `PLUXEL_BROWSER_ENDPOINT` 后运行 `pnpm --filter @pluxel/playwright test:external`。
`PLUXEL_BROWSER_PROTOCOL` 选择 `cdp`（默认）或 `playwright`；`PLUXEL_BROWSER_HEADERS` 可提供 JSON 格式的连接 headers。
测试通过 Vault 绑定读取连接，连续建立两个真实 Host generation，在隔离 context 中读取静态页面并清理；第二次连接同时验证前一代未停止外部浏览器。
此命令不启动浏览器，也不访问财政网站。
