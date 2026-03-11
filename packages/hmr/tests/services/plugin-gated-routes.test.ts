import '@pluxel/test/setup'

import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

import type { Context } from '@pluxel/core'
import type { AppEnv } from '../../src/services/http/hono-env'
import {
	createPluginGatedRouter,
	type PluginGatedRoute,
} from '../../src/services/http/hono-routing'
import { getPluginRoutingSnapshot } from '../../src/services/routing/pluginGatedRoutes'

function createCtx(enabled: Set<string>): Context {
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
	return {
		logger: logger as any,
		configService: {
			isEnabledInConfig: (name: string) => enabled.has(name),
		},
	} as any
}

const routes: PluginGatedRoute[] = [
	{
		id: 'a.hello',
		plugin: 'PluginA',
		method: 'GET',
		path: '/hello',
		handler: (_ctx) => (c) => c.json({ ok: true, plugin: 'A' }),
	},
	{
		id: 'b.ok',
		plugin: 'PluginB',
		method: 'GET',
		path: '/ok',
		handler: (_ctx) => (c) => c.text('ok'),
	},
]

describe('plugin gated routes', () => {
	it('returns 404 when plugin is disabled', async () => {
		const ctx = createCtx(new Set(['PluginA']))
		const api = createPluginGatedRouter(ctx, routes)
		const app = new Hono<AppEnv>()
		app.route('/api', api)

		const res = await app.fetch(new Request('http://test/api/ok'))
		expect(res.status).toBe(404)
	})

	it('handles request when plugin is enabled', async () => {
		const ctx = createCtx(new Set(['PluginB']))
		const api = createPluginGatedRouter(ctx, routes)
		const app = new Hono<AppEnv>()
		app.route('/api', api)

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
