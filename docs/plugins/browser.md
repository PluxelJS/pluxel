---
title: 浏览器连接
description: 连接外部浏览器，在独立会话中执行自动化。
---

`@pluxel/playwright` 提供外部 CDP / Playwright 协议连接和原生 Playwright `BrowserContext`。财政票据、税务发票的图片提取和查验统一由 [`@pluxel/invoice`](./invoice.md) 提供。

浏览器由部署者独立运行。插件依赖 `playwright-core`，不下载、安装或启动 Chromium、Chrome、Lightpanda，也不管理它们的进程。连接地址必须来自可信的部署配置。

## 选择浏览器与连接

通过 `PlaywrightConfig.protocol` 显式选择协议：默认 `cdp` 使用 `chromium.connectOverCDP()`，适用于 Chromium 或 Lightpanda 的 CDP 端点；`playwright` 使用 `chromium.connect()`，适用于 Playwright 原生 WebSocket 服务。原生协议要求服务端与客户端的主、次版本一致；当前客户端为 `playwright-core@1.64.0`。端口号不能判断协议，插件不会自动探测或回退。Lightpanda 的 DOM、Web API、安全验证与 Canvas 兼容性需要按目标网页验证，能够连接不等于能够查验。

无凭据的连接直接使用 `PlaywrightConfig.endpoint`；带 token 的 URL、认证 headers 或其他私密连接信息使用 `connectionKey` 指向 Vault 记录。两者必须且只能配置一个。普通 endpoint 不允许 userinfo、query 或 hash；路径若包含秘密也必须放进 Vault。

```ts no-twoslash
import { pluginNodeAddressOf } from '@pluxel/core'
import { defineHostApplication, envBinding } from '@pluxel/host'
import { PlaywrightConfig, PlaywrightPlugin } from '@pluxel/playwright'

export default defineHostApplication(() => ({
	plugins: [PlaywrightPlugin],
	services: [],
	state: { initial: { autoStart: [pluginNodeAddressOf(PlaywrightPlugin)] } },
	envBindings: [
		envBinding(PlaywrightPlugin, {
			config: {
				schema: PlaywrightConfig,
				mapping: { endpoint: 'BROWSER_ENDPOINT', protocol: 'BROWSER_PROTOCOL' },
			},
		}),
	],
}))
```

`BROWSER_PROTOCOL=playwright` 连接原生服务，省略时采用 CDP。原生服务地址必须是 `ws://` 或 `wss://`。这是生产应用声明；宿主启动与源码装配见 [Host 配置](../host/configuration.md)。无凭据模式不需要 Vault、Workbench、数据库或 Persistence。

有凭据时改用下面的绑定；`BROWSER_CONNECTION_KEY=primary`，`BROWSER_ENDPOINT` 可以包含供应商提供的 token。环境变量由 Host 显式绑定，插件不自行读取进程环境。

```ts no-twoslash
import { pluginNodeAddressOf } from '@pluxel/core'
import { defineHostApplication, envBinding } from '@pluxel/host'
import { vault } from '@pluxel/services/vault'
import { PlaywrightConfig, PlaywrightPlugin, PlaywrightVaultSchema } from '@pluxel/playwright'

export default defineHostApplication(() => ({
	plugins: [PlaywrightPlugin],
	services: [vault({ backend: 'bindings' })],
	state: { initial: { autoStart: [pluginNodeAddressOf(PlaywrightPlugin)] } },
	envBindings: [
		envBinding(PlaywrightPlugin, {
			config: {
				schema: PlaywrightConfig,
				mapping: { connectionKey: 'BROWSER_CONNECTION_KEY', protocol: 'BROWSER_PROTOCOL' },
			},
			vault: {
				schema: PlaywrightVaultSchema,
				mapping: { primary: { endpoint: 'BROWSER_ENDPOINT' } },
			},
		}),
	],
}))
```

Vault 记录形状为 `{ endpoint: string, headers?: Record<string, string> }`。需要 headers 时也可用 `fileBinding` 提供整条记录，见 [Vault 部署凭据](../host/configuration.md#部署凭据)。连接失败的生命周期错误会去掉可能泄露端点和服务器响应的原始错误；其他原生 SDK 调用保留原异常。

连接在插件初始化时建立，默认连接超时为 30 秒。配置或 Vault 凭据修改后显式重启插件；断线后新调用明确失败，不自动重连或重放业务操作。

## 在其他插件中使用原生会话

```ts no-twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import { PlaywrightPlugin } from '@pluxel/playwright'

@Plugin()
export class PageTitlePlugin extends BasePlugin {
	constructor(private readonly browser: PlaywrightPlugin) {
		super()
	}

	async read(url: string, signal?: AbortSignal): Promise<string> {
		const context = await this.browser.newContext({ locale: 'zh-CN' }, { signal })
		try {
			const page = await context.newPage()
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
			return await page.title()
		} finally {
			await context.close()
		}
	}
}
```

`newContext()` 返回原生 SDK 对象，正常使用后由调用者 `close()`。获取时的 `signal` 只控制获取阶段；取得会话后，业务负责取消自己的操作。consumer 或 provider 停止时，连接器会关闭尚未释放的自有会话；不会借用或关闭远端默认 context。原生对象用于受信任的本地插件，不是权限沙盒，不应作为 RPC 数据交给外部客户端。

Playwright 的底层 context 获取不能独立中断。取消时调用可以先拒绝，迟到的 context 会关闭；consumer 清理等待这类获取完成。provider 停止先关闭已创建的 context，再断开自己的浏览器连接。远端不响应获取或关闭请求时，清理也可能等待，需要部署方处理失效的连接；插件不为了一个 caller 强制切断其他 caller 的连接，也不承诺清理有硬超时。外部浏览器进程由部署者继续管理。

## 验证范围

浏览器连接、独立 context 与两代 Host 的连接检查见下方命令。票种、官网交互、安全验证和结果解释见[统一票据查验](./invoice.md)。能够连接不等于目标网站全部 Web API 兼容，Lightpanda 仍需按具体网页验证。

工作区提供显式外部连接检查。通过部署环境设置 `PLUXEL_BROWSER_ENDPOINT`，需要认证 headers 时设置 JSON 格式的 `PLUXEL_BROWSER_HEADERS`，然后运行：

```sh
vp run @pluxel/playwright#test:external
```

该命令通过 Vault 绑定地址，连续创建并关闭两个真实 Host generation，在独立页面中读取合成 HTML，检查第一次停止后仍可重新连接。它不访问财政网站、不提交票据、不启动浏览器，也不会被普通 `test` 命令执行。它能证明两次连接可用，不能证明供应商没有自动重建浏览器进程或全部 Web API 兼容。

2026-10-14 已使用外部 Playwright 1.64 服务与 Chromium 完成上述两代 Host 检查。真实票据测试证据由 [Invoice 插件](./invoice.md) 维护。
