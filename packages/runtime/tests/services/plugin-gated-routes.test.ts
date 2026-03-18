import '@pluxel/test/setup'

import { describe, expect, it, vi } from 'vitest'

import type { Context } from '@pluxel/core'
import {
	createElysiaApp,
	createPluginGatedRouter,
	getPluginRoutingSnapshot,
	type PluginGatedModuleDef,
} from '@pluxel/runtime/services'

function createCtx(enabled: Set<string>): Context {
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
	return {
		logger: logger as any,
		configService: {
			isEnabledInConfig: (name: string) => enabled.has(name),
		},
	} as any
}

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
	it('returns 404 when plugin is disabled', async () => {
		const ctx = createCtx(new Set(['PluginA']))
		const api = createPluginGatedRouter(ctx, routes)
		const app = createElysiaApp(ctx, { aot: true })
		app.mount('/api', api)

		const res = await app.fetch(new Request('http://test/api/ok'))
		expect(res.status).toBe(404)
	})

	it('handles request when plugin is enabled', async () => {
		const ctx = createCtx(new Set(['PluginB']))
		const api = createPluginGatedRouter(ctx, routes)
		const app = createElysiaApp(ctx, { aot: true })
		app.mount('/api', api)

		const res = await app.fetch(new Request('http://test/api/ok'))
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('ok')
	})

	it('computes a runtime snapshot of enabled plugins/routes', () => {
		const ctx = createCtx(new Set(['PluginA']))
		const snap = getPluginRoutingSnapshot(ctx, routes)
		expect(snap).toEqual({
			enabledPlugins: ['PluginA'],
			enabledRouteIds: ['a.hello'],
		})
	})
})
