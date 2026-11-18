---
title: 浏览器自动化连接（Playwright）
description: 连接外部 Chromium 或 Playwright 服务端，在隔离的浏览器会话中执行自动化任务。
---

`@pluxel/plugin-playwright` 提供了对无头浏览器的控制支持。它基于 `playwright-core`，通过远程连接（CDP 或 Playwright Server）复用外部部署的浏览器实例，便于执行网页截图、自动化爬取或票据查验任务。

## 安装依赖

```sh
vp add @pluxel/plugin-playwright
```

## 连接方式与配置

通过 `PlaywrightConfig` 指定远程浏览器端点：

```ts no-twoslash
import { defineHostApplication, envBinding } from '@pluxel/host'
import { PlaywrightConfig, PlaywrightPlugin } from '@pluxel/plugin-playwright'

export default defineHostApplication(() => ({
	plugins: [
		{
			plugin: PlaywrightPlugin,
			autoStart: true,
			envBindings: [
				envBinding({
					config: {
						schema: PlaywrightConfig,
						mapping: {
							endpoint: 'BROWSER_ENDPOINT',
							protocol: 'BROWSER_PROTOCOL',
						},
					},
				}),
			],
		},
	],
}))
```

<span id="使用原生连接参数"></span>

## 使用原生连接参数

如果需要传递自定义的 Playwright 连接参数（如 `slowMo` 慢速模式、请求拦截代理等），可以直接编写自定义 Provider 插件并调用底层连接器：

```ts no-twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import { chromium } from 'playwright-core'

@Plugin()
export class CustomBrowserPlugin extends BasePlugin {
	async openPage() {
		const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', {
			slowMo: 100,
		})
		const page = await browser.newPage()
		await page.goto('https://example.com')
		return page.title()
	}
}
```

## 在业务插件中执行会话

业务插件注入 `PlaywrightPlugin` 后，可随时开启新的隔离页面上下文并在操作完成后自动释放：

```ts
const context = await this.playwright.newContext()
try {
	const page = await context.newPage()
	await page.goto('https://example.com')
	// 执行业务自动化操作
} finally {
	await context.close()
}
```
