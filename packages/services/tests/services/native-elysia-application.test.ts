import { resolveContextService } from '@pluxel/core/internal'
import { ElysiaApp, ElysiaDirectory } from '@pluxel/services/elysia'
import { ElysiaRuntime, type ElysiaApplicationCarrier } from '@pluxel/services/internal'

import {
	assertPluginLifecycleIssue,
	BasePlugin,
	Plugin,
	PluginPart,
} from '@pluxel/core/internal/test'
import { createServiceInternalTestHarness } from '@pluxel/services/internal/test'
import { Elysia } from 'elysia'
import { WebStandardAdapter } from 'elysia/adapter/web-standard'
import { websocket } from 'elysia/websocket'

import { describe, expect, it } from 'vitest'

let ownerApplication: Elysia | undefined
let partApplication: Elysia | undefined

class NativeApplicationPart extends PluginPart<NativeApplicationPlugin> {
	protected override init() {
		partApplication = this.ctx.service(ElysiaApp)
		this.ctx.service(ElysiaApp).get('/native/part', () => 'part')
	}
}

@Plugin()
class NativeApplicationPlugin extends BasePlugin {
	readonly part = this.parts.use(NativeApplicationPart)

	protected override init() {
		ownerApplication = this.ctx.service(ElysiaApp)
		this.ctx.service(ElysiaApp).get('/native/hello', () => 'hello')
	}
}

@Plugin({ displayName: 'Reserved native Elysia route' })
class ReservedNativeApplicationPlugin extends BasePlugin {
	protected override init() {
		this.ctx.service(ElysiaApp).get('/__pluxel/hijack', () => 'invalid')
	}
}

@Plugin({ displayName: 'Native route conflict A' })
class NativeRouteConflictA extends BasePlugin {
	protected override init() {
		this.ctx.service(ElysiaApp).get('/native/conflict', () => 'a')
	}
}

@Plugin({ displayName: 'Native route conflict B' })
class NativeRouteConflictB extends BasePlugin {
	protected override init() {
		this.ctx.service(ElysiaApp).get('/native/conflict', () => 'b')
	}
}

@Plugin({ displayName: 'Native exact route semantics' })
class NativeExactRouteSemantics extends BasePlugin {
	protected override init() {
		this.ctx
			.service(ElysiaApp)
			.get('/native/exact', () => 'plain')
			.get('/native/exact/', () => 'trailing')
			.patch('/native/patch-only', () => 'patched')
	}
}

@Plugin({ displayName: 'Native empty route path' })
class NativeEmptyRoutePath extends BasePlugin {
	protected override init() {
		this.ctx.service(ElysiaApp).get('', () => 'empty-root')
	}
}

@Plugin({ displayName: 'Native slash route path' })
class NativeSlashRoutePath extends BasePlugin {
	protected override init() {
		this.ctx.service(ElysiaApp).get('/', () => 'slash-root')
	}
}

@Plugin({ displayName: 'Native wildcard precedence' })
class NativeWildcardRoute extends BasePlugin {
	protected override init() {
		addWildcardRoutes(this.ctx.service(ElysiaApp))
	}
}

function addWildcardRoutes(app: Elysia): void {
	app
		.all('/native/precedence', () => 'wildcard')
		.all('/native/catalog/new', async ({ request }) => 'static:' + (await request.text()))
}

@Plugin({ displayName: 'Native concrete precedence' })
class NativeConcreteRoute extends BasePlugin {
	protected override init() {
		addConcreteRoutes(this.ctx.service(ElysiaApp))
	}
}

function addConcreteRoutes(app: Elysia): void {
	app
		.get('/native/precedence', () => 'concrete')
		.get('/native/catalog/:id', ({ params }) => 'parameter:' + params.id)
}

@Plugin({ displayName: 'Native wildcard reserved probe' })
class NativeReservedWildcard extends BasePlugin {
	protected override init() {
		this.ctx
			.service(ElysiaApp)
			.use(websocket())
			.all('/*', () => 'business-wildcard')
			.ws('/*', { message() {} })
	}
}

let lifecycleApplication: Elysia | undefined

@Plugin({ displayName: 'Native physical lifecycle guard' })
class NativePhysicalLifecycleGuard extends BasePlugin {
	protected override init() {
		lifecycleApplication = this.ctx.service(ElysiaApp)
		this.ctx.service(ElysiaApp).get('/native/server-id', ({ server }) => server?.id ?? 'missing')
	}
}

@Plugin({ displayName: 'Native unsupported Elysia lifecycle hook' })
class NativeUnsupportedLifecycleHook extends BasePlugin {
	protected override init() {
		this.ctx.service(ElysiaApp).onStop((): undefined => undefined)
	}
}

let streamAborted: (() => void) | undefined

@Plugin({ displayName: 'Native streaming route' })
class NativeStreamingApplicationPlugin extends BasePlugin {
	protected override init() {
		this.ctx.service(ElysiaApp).get(
			'/native/stream',
			({ request }) =>
				new ReadableStream<Uint8Array>({
					start(controller) {
						request.signal.addEventListener(
							'abort',
							() => {
								streamAborted?.()
								controller.error(request.signal.reason)
							},
							{ once: true },
						)
					},
				}),
		)
	}
}

describe('native generation Elysia application', () => {
	it('publishes final Elysia paths and shares one real sealed app with PluginParts', async () => {
		ownerApplication = undefined
		partApplication = undefined

		{
			await using host = await createServiceInternalTestHarness()

			host.add(NativeApplicationPlugin).start(NativeApplicationPlugin)
			await host.commit()

			expect(resolveContextService(host.ctx, ElysiaRuntime).fetch).toBe(
				resolveContextService(host.ctx, ElysiaRuntime).fetch,
			)
			expect(ownerApplication).toBeInstanceOf(Elysia)
			expect(partApplication).toBe(ownerApplication)
			await expect(
				host
					.fetch(new Request('http://local.test/native/hello'))
					.then((response) => response.text()),
			).resolves.toBe('hello')
			await expect(
				host
					.fetch(new Request('http://local.test/native/part'))
					.then((response) => response.text()),
			).resolves.toBe('part')
			await expect(
				Promise.resolve(
					ownerApplication!.fetch(new Request('http://local.test/native/hello')),
				).then((response) => response.text()),
			).resolves.toBe('hello')
			expect(() => ownerApplication?.get('/native/late', () => 'late')).toThrow(
				'called after the app was sealed',
			)

			host.remove(NativeApplicationPlugin)
			await host.commit()
			const removed = await host.fetch(new Request('http://local.test/native/hello'))
			expect(removed.status).toBe(404)
			await expect(
				ownerApplication!.fetch(new Request('http://local.test/native/hello')),
			).rejects.toThrow('Plugin owner stopped')
		}
	})

	it('rejects reserved and conflicting routes before atomic publication', async () => {
		{
			await using host = await createServiceInternalTestHarness()

			host.add(ReservedNativeApplicationPlugin)
			host.cfg(ReservedNativeApplicationPlugin).setAutoStart(true)
			host.start(ReservedNativeApplicationPlugin)
			const reserved = await host.commitAllowFail()
			assertPluginLifecycleIssue(reserved, ReservedNativeApplicationPlugin, {
				kind: 'start-failed',
				message: 'reserved /__pluxel namespace',
			})

			host.add(NativeRouteConflictB).add(NativeRouteConflictA)
			host.cfg(NativeRouteConflictA).setAutoStart(true)
			host.start(NativeRouteConflictA)
			host.cfg(NativeRouteConflictB).setAutoStart(true)
			host.start(NativeRouteConflictB)
			const conflicted = await host.commitAllowFail()
			const running = [NativeRouteConflictA, NativeRouteConflictB].filter((plugin) =>
				host.isRunning(plugin),
			)
			expect(running).toHaveLength(1)
			const rejected =
				running[0] === NativeRouteConflictA ? NativeRouteConflictB : NativeRouteConflictA
			assertPluginLifecycleIssue(conflicted, rejected, {
				kind: 'start-failed',
				message: 'Elysia route conflict for GET /native/conflict',
			})
			const response = await host.fetch(new Request('http://local.test/native/conflict'))
			expect(await response.text()).toBe(running[0] === NativeRouteConflictA ? 'a' : 'b')
		}
	})

	it('preserves exact Elysia method/path semantics in selection and collision checks', async () => {
		{
			await using host = await createServiceInternalTestHarness()

			host
				.add(NativeExactRouteSemantics)
				.add(NativeEmptyRoutePath)
				.add(NativeSlashRoutePath)
				.add(NativeWildcardRoute)
				.add(NativeConcreteRoute)
			host.cfg(NativeExactRouteSemantics).setAutoStart(true)
			host.start(NativeExactRouteSemantics)
			host.cfg(NativeEmptyRoutePath).setAutoStart(true)
			host.start(NativeEmptyRoutePath)
			host.cfg(NativeSlashRoutePath).setAutoStart(true)
			host.start(NativeSlashRoutePath)
			host.cfg(NativeWildcardRoute).setAutoStart(true)
			host.start(NativeWildcardRoute)
			host.cfg(NativeConcreteRoute).setAutoStart(true)
			host.start(NativeConcreteRoute)
			await host.commit()

			await expect(
				host
					.fetch(new Request('http://local.test/native/exact'))
					.then((response) => response.text()),
			).resolves.toBe('plain')
			await expect(
				host
					.fetch(new Request('http://local.test/native/exact/'))
					.then((response) => response.text()),
			).resolves.toBe('trailing')
			expect(host.isRunning(NativeEmptyRoutePath)).toBe(true)
			expect(host.isRunning(NativeSlashRoutePath)).toBe(true)
			expect(['empty-root', 'slash-root']).toContain(
				await host.fetch(new Request('http://local.test/')).then((response) => response.text()),
			)
			const headResponse = await host.fetch(
				new Request('http://local.test/native/exact', { method: 'HEAD' }),
			)
			expect(headResponse.status).toBe(404)
			await expect(
				host
					.fetch(new Request('http://local.test/native/precedence'))
					.then((response) => response.text()),
			).resolves.toBe('concrete')
			await expect(
				host
					.fetch(new Request('http://local.test/native/precedence', { method: 'POST' }))
					.then((response) => response.text()),
			).resolves.toBe('wildcard')
		}
	})

	it('matches native Elysia when a static ALL route and a parameterized GET have different owners', async () => {
		await using host = await createServiceInternalTestHarness()
		host.add(NativeWildcardRoute).start(NativeWildcardRoute)
		host.add(NativeConcreteRoute).start(NativeConcreteRoute)
		await host.commit()
		const runtime = resolveContextService(host.ctx, ElysiaRuntime)
		const native = new Elysia({ adapter: WebStandardAdapter })
		addWildcardRoutes(native)
		addConcreteRoutes(native)
		native.compile()

		for (const [method, path, body] of [
			['GET', '/native/catalog/new'],
			['GET', '/native/catalog/existing'],
			['POST', '/native/catalog/new', 'preserve the request body'],
		] as const) {
			const request = new Request(new URL(path, 'http://local.test'), { method, body })
			const expected = await native.fetch(request.clone())
			expect(runtime.matchesRequest(request)).toBe(true)
			expect(request.bodyUsed).toBe(false)
			const response = await host.fetch(request)
			expect(response.status).toBe(expected.status)
			expect(await response.text()).toBe(await expected.text())
		}
	})

	it('looks up committed paths with or without a method through the root ElysiaDirectory', async () => {
		await using host = await createServiceInternalTestHarness()
		const directory = host.ctx.service(ElysiaDirectory)
		const path = '/native/patch-only'
		expect(directory.matchesHttpRoute(path)).toBe(false)
		host.add(NativeExactRouteSemantics).start(NativeExactRouteSemantics)
		host.add(NativeWildcardRoute).start(NativeWildcardRoute)
		await host.commit()

		expect(directory.matchesHttpRoute(path)).toBe(true)
		expect(directory.matchesHttpRoute(path, 'patch')).toBe(true)
		expect(directory.matchesHttpRoute(path, 'GET')).toBe(false)
		expect(directory.matchesHttpRoute('/native/catalog/new')).toBe(true)
		expect(directory.matchesHttpRoute('/native/catalog/new', 'POST')).toBe(true)
		expect(directory.matchesHttpRoute('/native/missing')).toBe(false)

		host.remove(NativeExactRouteSemantics)
		await host.commit()
		expect(directory.matchesHttpRoute(path)).toBe(false)
	})

	it('hard-excludes the control namespace from HTTP and WebSocket wildcard owners', async () => {
		{
			await using host = await createServiceInternalTestHarness()

			host.add(NativeReservedWildcard).start(NativeReservedWildcard)
			await host.commit()
			await expect(
				host
					.fetch(new Request('http://local.test/native/wildcard'))
					.then((response) => response.text()),
			).resolves.toBe('business-wildcard')

			let upgrades = 0
			const carrier: ElysiaApplicationCarrier = {
				metadata: {
					url: new URL('http://local.test'),
					port: 80,
					hostname: 'local.test',
					development: false,
				},
				upgrade(input) {
					upgrades += 1
					input.release()
					return true
				},
				publish: () => 0,
				pending: () => 0,
				requestIP: () => ({ address: '127.0.0.1', port: 1, family: 'IPv4' }),
			}
			const detach = resolveContextService(host.ctx, ElysiaRuntime).attachApplicationCarrier(
				carrier,
			)
			try {
				const controlHttp = await host.fetch(
					new Request('http://local.test/__pluxel/wildcard-probe'),
				)
				expect(await controlHttp.text()).not.toBe('business-wildcard')
				await host.fetch(
					new Request('http://local.test/__pluxel/socket-probe', {
						headers: { connection: 'upgrade', upgrade: 'websocket' },
					}),
				)
				expect(upgrades).toBe(0)
			} finally {
				detach()
			}
		}
	})

	it('keeps isolated, generation-stable Server metadata when physical lifecycle is rejected', async () => {
		lifecycleApplication = undefined
		{
			await using host = await createServiceInternalTestHarness()

			host.add(NativePhysicalLifecycleGuard).start(NativePhysicalLifecycleGuard)
			await host.commit()
			const app = lifecycleApplication!
			const server = app.server
			expect(server).toBeTruthy()
			const serverId = server!.id
			expect(() => app.listen(0)).toThrow('shared physical carrier')
			expect(() => app.stop()).toThrow('shared physical carrier')
			expect(() => app.onStart((): undefined => undefined)).toThrow(
				'app.onStart() is unavailable on a Plugin-owned Elysia application',
			)
			expect(() => app.onStop((): undefined => undefined)).toThrow(
				'app.onStop() is unavailable on a Plugin-owned Elysia application',
			)
			expect(() => server?.stop()).toThrow('shared physical carrier')
			expect(app.server).toBe(server)

			const carrierUrl = new URL('http://127.0.0.1:4123')
			const carrier: ElysiaApplicationCarrier = {
				metadata: {
					url: carrierUrl,
					port: 4123,
					hostname: '127.0.0.1',
					development: false,
				},
				upgrade: () => false,
				publish: () => 0,
				pending: () => 0,
				requestIP: () => null,
			}
			const detach = resolveContextService(host.ctx, ElysiaRuntime).attachApplicationCarrier(
				carrier,
			)
			const observedUrl = server!.url
			observedUrl.pathname = '/mutated-by-plugin'
			expect(server!.url.href).toBe('http://127.0.0.1:4123/')
			expect(server!.id).toBe(serverId)
			detach()
			expect(server!.id).toBe(serverId)
			await expect(
				host
					.fetch(new Request('http://local.test/native/server-id'))
					.then((response) => response.text()),
			).resolves.toBe(server?.id)
		}
	})

	it('fails generation start when a Plugin directly registers Elysia lifecycle hooks', async () => {
		{
			await using host = await createServiceInternalTestHarness()

			host.add(NativeUnsupportedLifecycleHook)
			host.cfg(NativeUnsupportedLifecycleHook).setAutoStart(true)
			host.start(NativeUnsupportedLifecycleHook)
			const result = await host.commitAllowFail()
			assertPluginLifecycleIssue(result, NativeUnsupportedLifecycleHook, {
				kind: 'start-failed',
				message: 'Use Plugin init() and ctx.effects for setup and cleanup',
			})
			expect(host.isRunning(NativeUnsupportedLifecycleHook)).toBe(false)
		}
	})

	it('aborts and drains an entered streaming response with its generation', async () => {
		{
			await using host = await createServiceInternalTestHarness()

			host.add(NativeStreamingApplicationPlugin).start(NativeStreamingApplicationPlugin)
			await host.commit()
			const aborted = new Promise<void>((resolve) => {
				streamAborted = resolve
			})
			const response = await host.fetch(new Request('http://local.test/native/stream'))
			const reader = response.body!.getReader()
			const reading = reader.read().catch((error: unknown) => error)

			host.remove(NativeStreamingApplicationPlugin)
			const stopping = host.commit()
			await aborted
			await reading
			await stopping
			expect(host.isRunning(NativeStreamingApplicationPlugin)).toBe(false)
		}
		streamAborted = undefined
	})
})
