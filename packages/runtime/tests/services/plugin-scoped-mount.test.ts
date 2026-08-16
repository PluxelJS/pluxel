import {
	assertPluginLifecycleIssue,
	BasePlugin,
	Plugin,
	withRuntimeHost,
} from '@pluxel/runtime/test'
import { pluginNodeAddressOf } from '@pluxel/core'
import { describe, expect, it } from 'vitest'

import { type ElysiaRouteHandle, PLUGIN_HTTP_BASE } from '@pluxel/runtime'
import { pluginNodePhysicalKey } from '../../src/runtime/plugin-address'

@Plugin()
class ScopedHttpPlugin extends BasePlugin {
	override init() {
		this.ctx.http.plugin.routes((app) =>
			app.get('/', () => 'root').get('/settings', () => 'settings'),
		)
	}
}

@Plugin()
class DynamicScopedHttpPlugin extends BasePlugin {
	private routesHandle: ElysiaRouteHandle | null = null

	override init() {
		this.routesHandle = this.ctx.http.plugin.routes((app) => app.get('/', () => 'v1'))
	}

	replaceRoutes() {
		this.routesHandle?.replaceRoutes((app) => app.get('/', () => 'v2').get('/extra', () => 'extra'))
	}
}

@Plugin()
class PublicHttpPlugin extends BasePlugin {
	override init() {
		this.ctx.http.plugin.routes(
			(app) => app.get('/', () => 'public').get('/health', () => 'healthy'),
			{ publicPath: '/business' },
		)
	}
}

@Plugin()
class ReservedPublicHttpPlugin extends BasePlugin {
	override init() {
		this.ctx.http.plugin.routes((app) => app.get('/', () => 'invalid'), {
			publicPath: '/__pluxel/hijack',
		})
	}
}

describe('HttpService plugin-scoped mount', () => {
	it('mounts plugin routes under the canonical owner key and auto-disposes on unload', async () => {
		await withRuntimeHost(async (host) => {
			host.add(ScopedHttpPlugin)
			host.cfg(ScopedHttpPlugin).enable()
			await host.commit()
			const ownerKey = pluginNodePhysicalKey(pluginNodeAddressOf(ScopedHttpPlugin))

			const rootRes = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerKey}`),
			)
			expect(rootRes.status).toBe(200)
			expect(await rootRes.text()).toBe('root')

			const settingsRes = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerKey}/settings`),
			)
			expect(settingsRes.status).toBe(200)
			expect(await settingsRes.text()).toBe('settings')

			host.remove(ScopedHttpPlugin)
			await host.commit()

			const removedRes = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerKey}`),
			)
			expect(removedRes.status).toBe(404)
		})
	})

	it('supports replacing a mounted plugin route tree to add routes dynamically', async () => {
		await withRuntimeHost(async (host) => {
			host.add(DynamicScopedHttpPlugin)
			host.cfg(DynamicScopedHttpPlugin).enable()
			await host.commit()
			const ownerKey = pluginNodePhysicalKey(pluginNodeAddressOf(DynamicScopedHttpPlugin))

			let rootRes = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerKey}`),
			)
			expect(rootRes.status).toBe(200)
			expect(await rootRes.text()).toBe('v1')

			let extraRes = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerKey}/extra`),
			)
			expect(extraRes.status).toBe(404)

			const instance = host.ctx.registry.getInstance(DynamicScopedHttpPlugin)
			instance?.replaceRoutes()

			rootRes = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerKey}`),
			)
			expect(rootRes.status).toBe(200)
			expect(await rootRes.text()).toBe('v2')

			extraRes = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerKey}/extra`),
			)
			expect(extraRes.status).toBe(200)
			expect(await extraRes.text()).toBe('extra')
		})
	})

	it('mounts a stable public path with plugin lifecycle ownership', async () => {
		await withRuntimeHost(async (host) => {
			host.add(PublicHttpPlugin)
			host.cfg(PublicHttpPlugin).enable()
			await host.commit()
			const ownerKey = pluginNodePhysicalKey(pluginNodeAddressOf(PublicHttpPlugin))

			const publicResponse = await host.ctx.http.fetch(new Request('http://local/business/health'))
			expect(publicResponse.status).toBe(200)
			expect(await publicResponse.text()).toBe('healthy')
			const scopedResponse = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerKey}/health`),
			)
			expect(scopedResponse.status).toBe(404)

			host.remove(PublicHttpPlugin)
			await host.commit()
			const removedResponse = await host.ctx.http.fetch(new Request('http://local/business/health'))
			expect(removedResponse.status).toBe(404)
		})
	})

	it('keeps the Pluxel namespace reserved for the runtime control plane', async () => {
		await withRuntimeHost(async (host) => {
			host.add(ReservedPublicHttpPlugin)
			host.cfg(ReservedPublicHttpPlugin).enable()
			const summary = await host.commitAllowFail()
			assertPluginLifecycleIssue(summary, ReservedPublicHttpPlugin, {
				kind: 'start-failed',
				message: 'reserved /__pluxel namespace',
			})
			expect(host.isRunning(ReservedPublicHttpPlugin)).toBe(false)
		})
	})
})
