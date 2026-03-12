import '@pluxel/test/setup'

import { BasePlugin, Plugin } from '@pluxel/hmr'
import { createHost, type Host } from '@pluxel/test'
import { afterEach, describe, expect, it } from 'vitest'

import {
	type ElysiaRouteHandle,
	PLUGIN_HTTP_BASE,
} from '@pluxel/hmr/services/http/HttpService'

@Plugin({ name: 'ScopedHttpPlugin', type: 'event' })
class ScopedHttpPlugin extends BasePlugin {
	override init() {
		this.ctx.http.plugin.routes(
			(app) => app.get('/', () => 'root').get('/settings', () => 'settings'),
		)
	}
}

@Plugin({ name: 'DynamicScopedHttpPlugin', type: 'event' })
class DynamicScopedHttpPlugin extends BasePlugin {
	private routesHandle: ElysiaRouteHandle | null = null

	override init() {
		this.routesHandle = this.ctx.http.plugin.routes((app) => app.get('/', () => 'v1'))
	}

	replaceRoutes() {
		this.routesHandle?.replaceRoutes((app) =>
			app.get('/', () => 'v2').get('/extra', () => 'extra'),
		)
	}
}

describe('HttpService plugin-scoped mount', () => {
	let host: Host | null = null

	afterEach(async () => {
		if (!host) return
		await host.dispose()
		host = null
	})

	it('mounts plugin routes under the plugin id prefix and auto-disposes on unload', async () => {
		host = createHost()
		host.add(ScopedHttpPlugin)
		host.cfg('ScopedHttpPlugin').enable()
		await host.commit()

		const rootRes = await host.ctx.http.fetch(
			new Request(`http://local${PLUGIN_HTTP_BASE}/ScopedHttpPlugin`),
		)
		expect(rootRes.status).toBe(200)
		expect(await rootRes.text()).toBe('root')

		const settingsRes = await host.ctx.http.fetch(
			new Request(`http://local${PLUGIN_HTTP_BASE}/ScopedHttpPlugin/settings`),
		)
		expect(settingsRes.status).toBe(200)
		expect(await settingsRes.text()).toBe('settings')

		host.remove(ScopedHttpPlugin)
		await host.commit()

		const removedRes = await host.ctx.http.fetch(
			new Request(`http://local${PLUGIN_HTTP_BASE}/ScopedHttpPlugin`),
		)
		expect(removedRes.status).toBe(404)
	})

	it('supports replacing a mounted plugin route tree to add routes dynamically', async () => {
		host = createHost()
		host.add(DynamicScopedHttpPlugin)
		host.cfg('DynamicScopedHttpPlugin').enable()
		await host.commit()

		let rootRes = await host.ctx.http.fetch(
			new Request(`http://local${PLUGIN_HTTP_BASE}/DynamicScopedHttpPlugin`),
		)
		expect(rootRes.status).toBe(200)
		expect(await rootRes.text()).toBe('v1')

		let extraRes = await host.ctx.http.fetch(
			new Request(`http://local${PLUGIN_HTTP_BASE}/DynamicScopedHttpPlugin/extra`),
		)
		expect(extraRes.status).toBe(404)

		const instance = host.ctx.registry.getInstance(DynamicScopedHttpPlugin)
		instance?.replaceRoutes()

		rootRes = await host.ctx.http.fetch(
			new Request(`http://local${PLUGIN_HTTP_BASE}/DynamicScopedHttpPlugin`),
		)
		expect(rootRes.status).toBe(200)
		expect(await rootRes.text()).toBe('v2')

		extraRes = await host.ctx.http.fetch(
			new Request(`http://local${PLUGIN_HTTP_BASE}/DynamicScopedHttpPlugin/extra`),
		)
		expect(extraRes.status).toBe(200)
		expect(await extraRes.text()).toBe('extra')
	})
})
