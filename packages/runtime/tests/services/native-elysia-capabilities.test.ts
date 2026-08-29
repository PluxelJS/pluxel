import { BasePlugin, Plugin, withRuntimeHost } from '@pluxel/runtime/test'
import { Elysia, t } from 'elysia'
import { describe, expect, it } from 'vitest'

const reusableApi = (app: Elysia) =>
	app.get('/native-capabilities/function-plugin', () => 'function-plugin')

@Plugin({ displayName: 'Native Elysia capabilities' })
class NativeElysiaCapabilities extends BasePlugin {
	protected override init(): void {
		this.ctx.elysia
			.decorate('nativeOwner', 'capabilities')
			.derive(({ request }) => ({
				requestMarker: request.headers.get('x-marker') ?? 'missing',
			}))
			.error('global', ({ error }) =>
				error instanceof Error && error.message === 'native-capability-error'
					? new Response('mapped-native-error', { status: 418 })
					: undefined,
			)
			.use(reusableApi)
			.use(
				Promise.resolve(
					new Elysia().get('/native-capabilities/lazy/:id', ({ params }) => params.id),
				),
			)
			.group('/native-capabilities', (app) =>
				app
					.get('/context', ({ nativeOwner, requestMarker }) => ({
						nativeOwner,
						requestMarker,
					}))
					.post(
						'/schema',
						{ body: t.Object({ value: t.String({ minLength: 1 }) }) },
						({ body, status }) => status(201, body),
					)
					.get('/error', () => {
						throw new Error('native-capability-error')
					}),
			)
			.mount('/native-capabilities/mounted', (request) =>
				Response.json({ pathname: new URL(request.url).pathname }),
			)
	}
}

@Plugin({ displayName: 'Native Elysia isolation A' })
class NativeElysiaIsolationA extends BasePlugin {
	protected override init(): void {
		this.ctx.elysia
			.decorate('isolatedValue', 'a')
			.get('/native-isolation/a', ({ isolatedValue }) => isolatedValue)
	}
}

@Plugin({ displayName: 'Native Elysia isolation B' })
class NativeElysiaIsolationB extends BasePlugin {
	protected override init(): void {
		this.ctx.elysia
			.decorate('isolatedValue', 'b')
			.get('/native-isolation/b', ({ isolatedValue }) => isolatedValue)
	}
}

describe('native Elysia authoring capability', () => {
	it('preserves function plugins, async modules, context, schemas, errors and mounts', async () => {
		await withRuntimeHost(async (host) => {
			host.add(NativeElysiaCapabilities).start(NativeElysiaCapabilities)
			await host.commit()

			await expect(
				host
					.fetch(new Request('http://local/native-capabilities/function-plugin'))
					.then((response) => response.text()),
			).resolves.toBe('function-plugin')
			await expect(
				host
					.fetch(new Request('http://local/native-capabilities/lazy/42'))
					.then((response) => response.text()),
			).resolves.toBe('42')

			const context = await host.fetch(
				new Request('http://local/native-capabilities/context', {
					headers: { 'x-marker': 'native' },
				}),
			)
			expect(await context.json()).toEqual({
				nativeOwner: 'capabilities',
				requestMarker: 'native',
			})

			const valid = await host.fetch(
				new Request('http://local/native-capabilities/schema', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ value: 'accepted' }),
				}),
			)
			expect(valid.status).toBe(201)
			expect(await valid.json()).toEqual({ value: 'accepted' })

			const invalid = await host.fetch(
				new Request('http://local/native-capabilities/schema', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ value: '' }),
				}),
			)
			expect(invalid.status).toBe(422)

			const mappedError = await host.fetch(new Request('http://local/native-capabilities/error'))
			expect(mappedError.status).toBe(418)
			expect(await mappedError.text()).toBe('mapped-native-error')

			const mounted = await host.fetch(
				new Request('http://local/native-capabilities/mounted/child'),
			)
			expect(await mounted.json()).toEqual({ pathname: '/child' })
		})
	})

	it('keeps decorators and hooks local to each generation application', async () => {
		await withRuntimeHost(async (host) => {
			host.add([NativeElysiaIsolationA, NativeElysiaIsolationB])
			host.cfg(NativeElysiaIsolationA).setAutoStart(true)
			host.start(NativeElysiaIsolationA)
			host.cfg(NativeElysiaIsolationB).setAutoStart(true)
			host.start(NativeElysiaIsolationB)
			await host.commit()

			await expect(
				host
					.fetch(new Request('http://local/native-isolation/a'))
					.then((response) => response.text()),
			).resolves.toBe('a')
			await expect(
				host
					.fetch(new Request('http://local/native-isolation/b'))
					.then((response) => response.text()),
			).resolves.toBe('b')
		})
	})
})
