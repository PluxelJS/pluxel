import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { createHost, defineHostApplication, envBinding, resolveHostApplication } from '@pluxel/host'
import { vault } from '@pluxel/services/vault'
import { expect, it } from 'vitest'
import {
	PlaywrightConfig,
	PlaywrightPlugin,
	PlaywrightVaultSchema,
} from '@pluxel/plugin-playwright'

const observations: string[] = []

@Plugin()
export class ExternalBrowserSmoke extends BasePlugin {
	constructor(private readonly browser: PlaywrightPlugin) {
		super()
	}

	protected override async init() {
		const context = await this.browser.newContext()
		try {
			context.setDefaultTimeout(15_000)
			const page = await context.newPage()
			await page.setContent(
				'<!doctype html><title>Pluxel browser smoke</title><p id="result">owned context</p>',
			)
			observations.push(await page.title(), await page.locator('#result').innerText())
		} finally {
			await context.close()
		}
	}
}

it('uses two successive Pluxel generations without stopping the external browser', async () => {
	if (!process.env.PLUXEL_BROWSER_ENDPOINT) {
		throw new Error(
			'Set PLUXEL_BROWSER_ENDPOINT before running test:external; no browser is launched',
		)
	}
	observations.length = 0
	for (let run = 0; run < 2; run++) {
		const application = defineHostApplication(() => ({
			plugins: [PlaywrightPlugin, ExternalBrowserSmoke],
			services: [vault({ backend: 'bindings' })],
			state: { initial: { autoStart: [pluginNodeAddressOf(ExternalBrowserSmoke)] } },
			configRecords: {
				initial: [
					{ owner: pluginNodeAddressOf(PlaywrightPlugin), config: { connectionKey: 'primary' } },
				],
			},
			envBindings: [
				envBinding(PlaywrightPlugin, {
					config: { schema: PlaywrightConfig, mapping: { protocol: 'BROWSER_PROTOCOL' } },
					vault: {
						schema: PlaywrightVaultSchema,
						mapping: { primary: { endpoint: 'BROWSER_ENDPOINT', headers: 'BROWSER_HEADERS' } },
					},
				}),
			],
		}))
		const resolved = await resolveHostApplication(application, {
			root: process.cwd(),
			mode: 'test',
			bindings: {},
			env: {
				BROWSER_PROTOCOL: process.env.PLUXEL_BROWSER_PROTOCOL ?? 'cdp',
				BROWSER_ENDPOINT: process.env.PLUXEL_BROWSER_ENDPOINT,
				BROWSER_HEADERS: process.env.PLUXEL_BROWSER_HEADERS ?? '{}',
			},
		})
		const host = await createHost({
			plugins: resolved.plugins,
			services: resolved.services,
			state: resolved.state,
			config: resolved.config,
			configRecords: resolved.configRecords,
			vaultBindings: resolved.vaultBindings,
		})
		try {
			await host.start()
			const status = await host.status()
			expect(status.summary.running).toBe(2)
		} finally {
			await host.close()
		}
	}
	expect(observations).toEqual([
		'Pluxel browser smoke',
		'owned context',
		'Pluxel browser smoke',
		'owned context',
	])
})
