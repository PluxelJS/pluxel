import '@pluxel/test/setup'

import '../../src/services'

import { createHost, type Host } from '@pluxel/test'
import { afterEach, describe, expect, it } from 'vitest'

describe('HttpService mountBoundary', () => {
	let host: Host | null = null

	afterEach(async () => {
		if (!host) return
		await host.dispose()
		host = null
	})

	it('mounts, replaces, and disposes a fetch boundary without rebuilding the root API', async () => {
		host = createHost()

		const makeApp = (text: string) => {
			const app = host!.ctx.http.hono.app()
			app.get('/', (c) => c.text(text))
			return app
		}

		const handle = host.ctx.http.mountBoundary({
			id: 'test:mounted',
			base: '/mounted',
			boundary: makeApp('v1'),
		})

		let res = await host.ctx.http.fetch(new Request('http://local/mounted'))
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('v1')

		handle.replace(makeApp('v2'))

		res = await host.ctx.http.fetch(new Request('http://local/mounted'))
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('v2')

		handle.dispose()

		res = await host.ctx.http.fetch(new Request('http://local/mounted'))
		expect(res.status).toBe(404)
	})
})
