import {
	assertPluginLifecycleIssue,
	BasePlugin,
	Plugin,
	withRuntimeHost,
} from '@pluxel/runtime/test'
import { formatPluginNodeRoute, pluginNodeAddressOf } from '@pluxel/core'
import { describe, expect, it } from 'vitest'

import { type ElysiaRouteHandle, PLUGIN_HTTP_BASE } from '@pluxel/runtime'

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

let staleRouteHandle: ElysiaRouteHandle | undefined

@Plugin()
class StaleRouteHandlePlugin extends BasePlugin {
	override init() {
		staleRouteHandle = this.ctx.http.plugin.routes((app) => app.get('/', () => 'v1'))
	}
}

let inFlightRouteEntered: (() => void) | undefined
let inFlightRouteRelease: Promise<void> | undefined

@Plugin()
class InFlightRoutePlugin extends BasePlugin {
	override init() {
		this.ctx.http.plugin.routes((app) =>
			app.get('/slow', async () => {
				inFlightRouteEntered?.()
				await inFlightRouteRelease
				return 'completed'
			}),
		)
	}
}

describe('HttpService plugin-scoped mount', () => {
	it('mounts plugin routes under the readable owner route and auto-disposes on unload', async () => {
		await withRuntimeHost(async (host) => {
			host.add(ScopedHttpPlugin)
			host.cfg(ScopedHttpPlugin).enable()
			await host.commit()
			const ownerRoute = formatPluginNodeRoute(pluginNodeAddressOf(ScopedHttpPlugin))

			const rootRes = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerRoute}`),
			)
			expect(rootRes.status).toBe(200)
			expect(await rootRes.text()).toBe('root')

			const settingsRes = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerRoute}/settings`),
			)
			expect(settingsRes.status).toBe(200)
			expect(await settingsRes.text()).toBe('settings')

			host.remove(ScopedHttpPlugin)
			await host.commit()

			const removedRes = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerRoute}`),
			)
			expect(removedRes.status).toBe(404)
		})
	})

	it('supports replacing a mounted plugin route tree to add routes dynamically', async () => {
		await withRuntimeHost(async (host) => {
			host.add(DynamicScopedHttpPlugin)
			host.cfg(DynamicScopedHttpPlugin).enable()
			await host.commit()
			const ownerRoute = formatPluginNodeRoute(pluginNodeAddressOf(DynamicScopedHttpPlugin))

			let rootRes = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerRoute}`),
			)
			expect(rootRes.status).toBe(200)
			expect(await rootRes.text()).toBe('v1')

			let extraRes = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerRoute}/extra`),
			)
			expect(extraRes.status).toBe(404)

			const instance = host.ctx.registry.getInstance(DynamicScopedHttpPlugin)
			instance?.replaceRoutes()

			rootRes = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerRoute}`),
			)
			expect(rootRes.status).toBe(200)
			expect(await rootRes.text()).toBe('v2')

			extraRes = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerRoute}/extra`),
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
			const ownerRoute = formatPluginNodeRoute(pluginNodeAddressOf(PublicHttpPlugin))

			const publicResponse = await host.ctx.http.fetch(new Request('http://local/business/health'))
			expect(publicResponse.status).toBe(200)
			expect(await publicResponse.text()).toBe('healthy')
			const scopedResponse = await host.ctx.http.fetch(
				new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerRoute}/health`),
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

	it('does not let a stale plugin route handle republish after owner stop', async () => {
		staleRouteHandle = undefined
		await withRuntimeHost(async (host) => {
			host.add(StaleRouteHandlePlugin)
			host.cfg(StaleRouteHandlePlugin).enable()
			await host.commit()
			const ownerRoute = formatPluginNodeRoute(pluginNodeAddressOf(StaleRouteHandlePlugin))
			const url = `http://local${PLUGIN_HTTP_BASE}/${ownerRoute}`

			const mounted = await host.ctx.http.fetch(new Request(url))
			expect(mounted.status).toBe(200)
			expect(await mounted.text()).toBe('v1')

			host.remove(StaleRouteHandlePlugin)
			await host.commit()
			const removed = await host.ctx.http.fetch(new Request(url))
			expect(removed.status).toBe(404)
			expect(() => staleRouteHandle?.replaceRoutes((app) => app.get('/', () => 'revived'))).toThrow(
				'HTTP route handle is disposed',
			)
			const revived = await host.ctx.http.fetch(new Request(url))
			expect(revived.status).toBe(404)
		})
	})

	it('withdraws future plugin routes without cancelling an entered fetch', async () => {
		let release: (() => void) | undefined
		inFlightRouteRelease = new Promise<void>((resolve) => {
			release = resolve
		})
		const entered = new Promise<void>((resolve) => {
			inFlightRouteEntered = resolve
		})
		try {
			await withRuntimeHost(async (host) => {
				host.add(InFlightRoutePlugin)
				host.cfg(InFlightRoutePlugin).enable()
				await host.commit()
				const ownerRoute = formatPluginNodeRoute(pluginNodeAddressOf(InFlightRoutePlugin))
				const url = `http://local${PLUGIN_HTTP_BASE}/${ownerRoute}/slow`
				const pending = host.ctx.http.fetch(new Request(url))
				await entered

				host.remove(InFlightRoutePlugin)
				await host.commit()
				const removed = await host.ctx.http.fetch(new Request(url))
				expect(removed.status).toBe(404)
				release?.()

				const completed = await pending
				expect(completed.status).toBe(200)
				expect(await completed.text()).toBe('completed')
			})
		} finally {
			release?.()
			inFlightRouteEntered = undefined
			inFlightRouteRelease = undefined
		}
	})
})
