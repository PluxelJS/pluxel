import { BasePlugin, Plugin } from '@pluxel/core'
import { Playwright } from '@pluxel/plugin-playwright'
import { createTestHost } from '@pluxel/test'
import { chromium, type Browser, type ConnectOptions } from 'playwright-core'
import { expect, it } from 'vitest'

const options: ConnectOptions = {
	exposeNetwork: '<loopback>',
	headers: { 'x-pluxel-test': 'native-provider' },
	slowMo: 1,
	timeout: 10_000,
}
let endpoint: string
const connections: Browser[] = []

@Plugin(Playwright)
class NativeProvider extends Playwright {
	protected override async connect(signal: AbortSignal): Promise<Browser> {
		signal.throwIfAborted()
		const browser = await chromium.connect(endpoint, options)
		connections.push(browser)
		return browser
	}
}

@Plugin()
class Consumer extends BasePlugin {
	constructor(private readonly browser: Playwright) {
		super()
	}
	async open() {
		return await this.browser.newContext({ locale: 'zh-CN' })
	}
}

it('connects two owned generations to one native Playwright server with full connection options', async () => {
	const server = await chromium.launchServer({
		headless: true,
		executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
	})
	endpoint = server.wsEndpoint()
	connections.length = 0
	try {
		for (let run = 0; run < 2; run++) {
			await using host = await createTestHost()
			await host.start(NativeProvider)
			const browser = connections[run]!
			const consumer = await host.start(Consumer)
			const context = await consumer.open()
			let closed = false
			context.once('close', () => {
				closed = true
			})
			const page = await context.newPage()
			await page.setContent('<!doctype html><title>Native provider</title><p>owned context</p>')
			expect(await page.title()).toBe('Native provider')
			expect(await page.locator('p').innerText()).toBe('owned context')
			await host.stop(Consumer)
			expect(closed).toBe(true)
			expect(browser.isConnected()).toBe(true)
			await host.stop(NativeProvider)
			expect(browser.isConnected()).toBe(false)
			expect(server.process().exitCode).toBeNull()
		}
	} finally {
		await server.close()
	}
})
