import { withRuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'

describe('HttpService host.routes', () => {
	it('mounts, replaces, and disposes an Elysia boundary through the root app', async () => {
		await withRuntimeHost(async (host) => {
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
	})

	it('mounts a plain fetch boundary through the Elysia root', async () => {
		await withRuntimeHost(async (host) => {
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

	it('does not let a stale host route disposer remove a replacement with the same id', async () => {
		await withRuntimeHost(async (host) => {
			const first = host.ctx.http.host.routes((app) => app.get('/', () => 'v1'), {
				id: 'test:replaceable',
				path: '/replaceable',
			})
			const second = host.ctx.http.host.routes((app) => app.get('/', () => 'v2'), {
				id: 'test:replaceable',
				path: '/replaceable',
			})

			first.dispose()
			let res = await host.ctx.http.fetch(new Request('http://local/replaceable'))
			expect(res.status).toBe(200)
			expect(await res.text()).toBe('v2')
			expect(() => first.replaceRoutes((app) => app.get('/', () => 'stale'))).toThrow(
				'HTTP route handle is disposed',
			)

			second.dispose()
			res = await host.ctx.http.fetch(new Request('http://local/replaceable'))
			expect(res.status).toBe(404)
		})
	})

	it('rejects ambiguous ownership of the same mount path', async () => {
		await withRuntimeHost(async (host) => {
			host.ctx.http.host.routes((app) => app.get('/', () => 'first'), {
				id: 'test:first-owner',
				path: '/shared',
			})

			expect(() =>
				host.ctx.http.host.routes((app) => app.get('/', () => 'second'), {
					id: 'test:second-owner',
					path: '/shared',
				}),
			).toThrow('already owned by "test:first-owner"')
		})
	})
})
