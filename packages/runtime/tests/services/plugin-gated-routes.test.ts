import { describe, expect, it } from 'vitest'

import { withRuntimeContext } from '@pluxel/runtime/test'
import { setPluginEnabled } from '@pluxel/runtime/internal'
import {
	createElysiaApp,
	createPluginGatedRouter,
	getPluginRoutingSnapshot,
	type PluginGatedModuleDef,
} from '@pluxel/runtime'

const routes: PluginGatedModuleDef[] = [
	{
		id: 'a.hello',
		plugin: 'PluginA',
		build: (app) => app.get('/hello', () => ({ ok: true, plugin: 'A' })),
	},
	{
		id: 'b.ok',
		plugin: 'PluginB',
		build: (app) => app.get('/ok', () => 'ok'),
	},
]

describe('plugin gated routes', () => {
	const enable = (ctx: Parameters<typeof createPluginGatedRouter>[0], name: string) => {
		ctx.runtimeState.update((draft) => setPluginEnabled(draft, name, true))
	}

	it('returns 404 when plugin is disabled', async () => {
		await withRuntimeContext(async (ctx) => {
			enable(ctx, 'PluginA')
			const api = createPluginGatedRouter(ctx, routes)
			const app = createElysiaApp(ctx, { aot: true })
			app.mount('/api', api)

			const res = await app.fetch(new Request('http://test/api/ok'))
			expect(res.status).toBe(404)
		})
	})

	it('handles request when plugin is enabled', async () => {
		await withRuntimeContext(async (ctx) => {
			enable(ctx, 'PluginB')
			const api = createPluginGatedRouter(ctx, routes)
			const app = createElysiaApp(ctx, { aot: true })
			app.mount('/api', api)

			const res = await app.fetch(new Request('http://test/api/ok'))
			expect(res.status).toBe(200)
			expect(await res.text()).toBe('ok')
		})
	})

	it('computes a runtime snapshot of enabled plugins/routes', () => {
		return withRuntimeContext((ctx) => {
			enable(ctx, 'PluginA')
			const snap = getPluginRoutingSnapshot(ctx, routes)
			expect(snap).toEqual({
				enabledPlugins: ['PluginA'],
				enabledRouteIds: ['a.hello'],
			})
		})
	})
})
