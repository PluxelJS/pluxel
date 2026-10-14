---
title: 浏览器与财政票据
description: 连接外部浏览器，在独立会话中执行自动化和实验性财政电子票据查验。
---

`@pluxel/playwright` 提供外部 CDP / Playwright 协议连接和原生 Playwright `BrowserContext`；`@pluxel/fiscal-ticket` 在其上实现全国财政电子票据网站的查验尝试。两个包在 `plugins/browser/` 下独立维护，没有聚合插件。

浏览器由部署者独立运行。插件依赖 `playwright-core`，不下载、安装或启动 Chromium、Chrome、Lightpanda，也不管理它们的进程。连接地址必须来自可信的部署配置。

财政查验为实验性能力：依据当前官网静态页面结构实现，真实票据、安全验证以及外部 Lightpanda 的完整链路仍需联调。它不调用逆向的查验 API，不提供验证码破解，也不把税务发票网站的实现当成财政票据接口。

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

## 财政票据查验

应用清单加入 `FiscalTicketPlugin` 和 `PlaywrightPlugin`，业务 consumer 通过 constructor 注入前者。`FiscalTicketConfig` 是同一份公开配置 schema：`timeoutMs` 默认 120 秒（包括安全验证等待），`maxConcurrent` 默认 1。超过并发预算直接返回执行错误；插件不持久化任务、不排队、不自动重试，调用方根据自己的业务安排后续尝试。

输入五要素：8 位票据代码、10 位票据号码、6 位英数校验码、字符串金额、`YYYY-MM-DD` 日期。保留前导零；金额支持负数、至多 16 位整数和两位小数。票据校验码与提交后的交互安全验证是两回事。

```ts no-twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import {
	FiscalTicketPlugin,
	FiscalTicketError,
	type FiscalTicketInput,
} from '@pluxel/fiscal-ticket'

@Plugin()
export class ReceiptCheckPlugin extends BasePlugin {
	constructor(private readonly fiscal: FiscalTicketPlugin) {
		super()
	}

	async check(input: FiscalTicketInput, signal?: AbortSignal) {
		try {
			const result = await this.fiscal.verify(input, { signal })
			switch (result.status) {
				case 'matched':
					return { state: 'matched', checkedAt: result.checkedAt }
				case 'action_required':
					return { state: 'needs-human' }
				case 'unconfirmed':
					return { state: 'unconfirmed', reason: result.reason }
			}
		} catch (error) {
			if (error instanceof FiscalTicketError && error.code === 'BUSY') {
				return { state: 'busy' }
			}
			throw error
		}
	}
}
```

需要现场处理安全验证时，传入 `onChallenge: async ({ page, signal }) => { ... }`。回调最多调用一次，使用借用的原生 Page 与宿主自己的人工操作通道完成网站正常验证；回调结束后插件继续观察结果。不要保留或关闭借用页面。回调必须把 signal 传给自己的等待与 IO；插件取消会关闭页面，但无法强制停止用户任意回调代码。

未提供回调时返回 `action_required` 并释放会话，不能拿该结果恢复已关闭的挑战；需要人工处理时，应从本次调用开始就提供回调。插件不会在后台维持无人接管的会话。

`matched` 只表达受支持页面的五字段核对结果，不是独立验签、法律真伪鉴定或实时可报销状态。地方 iframe 或已展示但不支持的结果格式返回 `unconfirmed`；站点提示同样保留为未确认，不把“票据不存在”解释为假票。若页面始终没有出现可识别的结果或提示，会等待到超时。执行超时、断线、取消和程序异常通过 rejection 与领域结论区分。取消不撤销已经提交到官网的查验，也不恢复官网查验次数。

结果包含票据数据或网站消息时，由业务决定保存与展示，网站消息作为不可信文本处理；插件不自动记录票据、截图或凭据。

## 验证范围

包内测试使用真实 Pluxel lowering 与 test host，检查依赖、配置、资源释放和业务分支；网页结构使用脱敏 fixture，不能证明官网当前可访问或所有票种可查。

接入外部浏览器后，先验证连接、创建隔离 context、读取页面、关闭 context 与插件后外部浏览器仍可用；再用授权的真实票据验证安全验证流程、结果核对和取消。财政官网中央结果有 Canvas 转图步骤，Lightpanda 是否能完成这一路径需要实际确认。GitHub 税务发票项目仅作为浏览器控制流程参考，没有复用其税务接口或选择器。

工作区提供显式外部连接检查。通过部署环境设置 `PLUXEL_BROWSER_ENDPOINT`，需要认证 headers 时设置 JSON 格式的 `PLUXEL_BROWSER_HEADERS`，然后运行：

```sh
pnpm --filter @pluxel/playwright test:external
```

该命令通过 Vault 绑定地址，连续创建并关闭两个真实 Host generation，在独立页面中读取合成 HTML，检查第一次停止后仍可重新连接。它不访问财政网站、不提交票据、不启动浏览器，也不会被普通 `test` 命令执行。它能证明两次连接可用，不能证明供应商没有自动重建浏览器进程或全部 Web API 兼容。

2026-10-14 已使用外部 Playwright 1.64 服务与 Chromium 完成上述两代 Host 检查，并通过税务总局增值税发票网页的图片验证码交互完成一次实票查验。税务页面试验不属于 `FiscalTicketPlugin` 的实现或验收；财政实票与 Lightpanda 仍未验证，增值税发票不能传给财政票据插件。
