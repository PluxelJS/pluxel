import '@pluxel/test/setup'

import '@pluxel/runtime'

import { createHost, type Host } from '@pluxel/test'
import { afterEach, describe, expect, it } from 'vitest'

describe('HttpService host.routes', () => {
	let host: Host | null = null

	afterEach(async () => {
		if (!host) return
		await host.dispose()
		host = null
	})

	it('mounts, replaces, and disposes an Elysia boundary through the root app', async () => {
		host = createHost()

		const handle = host.ctx.http.host.routes((app) => app.get('/', () => 'v1'), {
			id: 'test:mounted',
			path: '/mounted',
		})

		let res = await host.ctx.http.fetch(new Request('http://local/mounted'))
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('v1')

		handle.replaceRoutes((app) => app.get('/', () => 'v2'))

		res = await host.ctx.http.fetch(new Request('http://local/mounted'))
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('v2')

		handle.dispose()

		res = await host.ctx.http.fetch(new Request('http://local/mounted'))
		expect(res.status).toBe(404)
	})

	it('mounts a plain fetch boundary through the Elysia root', async () => {
		host = createHost()

		host.ctx.http.host.mount({
			id: 'test:fetch-boundary',
			path: '/fetch-boundary',
			boundary: (request) => new Response(new URL(request.url).pathname),
		})

		const res = await host.ctx.http.fetch(new Request('http://local/fetch-boundary/nested'))
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('/nested')
	})
})
