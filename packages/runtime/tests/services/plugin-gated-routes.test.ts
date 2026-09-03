import { describe, expect, it } from 'vitest'
import { Elysia } from 'elysia'

import { createRuntimeInternalTestHost } from '@pluxel/runtime/internal/test'
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
	it('returns 404 when plugin is stopped', async () => {
		{
			await using runtimeContext = createRuntimeInternalTestHost({})
			const ctx = runtimeContext.ctx

			const api = createPluginGatedRouter(ctx, routes, { isPluginRunning: () => false })
			const app = new Elysia({ precompile: true })
			app.mount('/api', api.fetch)

			const res = await app.fetch(new Request('http://test/api/ok'))
			expect(res.status).toBe(404)
		}
	})

	it('handles request when plugin is running', async () => {
		{
			await using runtimeContext = createRuntimeInternalTestHost({})
			const ctx = runtimeContext.ctx

			const api = createPluginGatedRouter(ctx, routes, {
				isPluginRunning: (plugin) => plugin === pluginB,
			})
			const app = new Elysia({ precompile: true })
			app.mount('/api', api.fetch)

			const res = await app.fetch(new Request('http://test/api/ok'))
			expect(res.status).toBe(200)
			expect(await res.text()).toBe('ok')
		}
	})

	it('computes a runtime snapshot of running plugins/routes', () => {
		return (async () => {
			await using runtimeContext = createRuntimeInternalTestHost({})
			const ctx = runtimeContext.ctx

			const snap = getPluginRoutingSnapshot(ctx, routes, {
				isPluginRunning: (plugin) => plugin === pluginA,
			})
			expect(snap).toEqual({
				runningPlugins: [pluginA],
				runningRouteIds: ['a.hello'],
			})
		})()
	})
})
