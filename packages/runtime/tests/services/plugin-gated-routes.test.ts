import { describe, expect, it } from 'vitest'
import { Elysia } from 'elysia'

import { withRuntimeContext } from '@pluxel/runtime/test'
import {
	createPluginGatedRouter,
	getPluginRoutingSnapshot,
	type PluginGatedModuleDef,
} from '@pluxel/runtime/internal'

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
	it('returns 404 when plugin is disabled', async () => {
		await withRuntimeContext(
			async (ctx) => {
				const api = createPluginGatedRouter(ctx, routes)
				const app = new Elysia({ precompile: true })
				app.mount('/api', api.fetch)

				const res = await app.fetch(new Request('http://test/api/ok'))
				expect(res.status).toBe(404)
			},
			{ runtimeState: { mode: 'memory', snapshot: { enabled: [pluginA] } } },
		)
	})

	it('handles request when plugin is enabled', async () => {
		await withRuntimeContext(
			async (ctx) => {
				const api = createPluginGatedRouter(ctx, routes)
				const app = new Elysia({ precompile: true })
				app.mount('/api', api.fetch)

				const res = await app.fetch(new Request('http://test/api/ok'))
				expect(res.status).toBe(200)
				expect(await res.text()).toBe('ok')
			},
			{ runtimeState: { mode: 'memory', snapshot: { enabled: [pluginB] } } },
		)
	})

	it('computes a runtime snapshot of enabled plugins/routes', () => {
		return withRuntimeContext(
			(ctx) => {
				const snap = getPluginRoutingSnapshot(ctx, routes)
				expect(snap).toEqual({
					enabledPlugins: [pluginA],
					enabledRouteIds: ['a.hello'],
				})
			},
			{ runtimeState: { mode: 'memory', snapshot: { enabled: [pluginA] } } },
		)
	})
})
