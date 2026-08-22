import { describe, expect, it } from 'vitest'

import { withRuntimeContext } from '@pluxel/runtime/test'
import { setPluginEnabled } from '@pluxel/runtime/internal'
import {
	createElysiaApp,
	createPluginGatedRouter,
	getPluginRoutingSnapshot,
	type PluginGatedModuleDef,
} from '@pluxel/runtime'

const pluginA = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/a' },
		exportName: 'PluginA',
	},
	variant: 'default',
} as const

const pluginB = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/b' },
		exportName: 'PluginB',
	},
	variant: 'default',
} as const

const routes: PluginGatedModuleDef[] = [
	{
		id: 'a.hello',
		plugin: pluginA,
		build: (app) => app.get('/hello', () => ({ ok: true, plugin: 'A' })),
	},
	{
		id: 'b.ok',
		plugin: pluginB,
		build: (app) => app.get('/ok', () => 'ok'),
	},
]

describe('plugin gated routes', () => {
	const enable = (
		ctx: Parameters<typeof createPluginGatedRouter>[0],
		owner: typeof pluginA | typeof pluginB,
	) => {
		ctx.runtimeState.update((draft) => setPluginEnabled(draft, owner, true))
	}

	it('returns 404 when plugin is disabled', async () => {
		await withRuntimeContext(async (ctx) => {
			enable(ctx, pluginA)
			const api = createPluginGatedRouter(ctx, routes)
			const app = createElysiaApp(ctx, { aot: true })
			app.mount('/api', api)

			const res = await app.fetch(new Request('http://test/api/ok'))
			expect(res.status).toBe(404)
		})
	})

	it('handles request when plugin is enabled', async () => {
		await withRuntimeContext(async (ctx) => {
			enable(ctx, pluginB)
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
			enable(ctx, pluginA)
			const snap = getPluginRoutingSnapshot(ctx, routes)
			expect(snap).toEqual({
				enabledPlugins: [pluginA],
				enabledRouteIds: ['a.hello'],
			})
		})
	})
})
