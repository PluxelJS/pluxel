import {
	assertPluginLifecycleIssue,
	BasePlugin,
	Plugin,
	PluginPart,
	createRuntimeHost,
} from '@pluxel/runtime/test'
import { Elysia } from 'elysia'
import { websocket } from 'elysia/websocket'
import { requireRuntimeHttpService, type ElysiaApplicationCarrier } from '@pluxel/runtime/internal'
import { describe, expect, it } from 'vitest'

let ownerApplication: Elysia | undefined
let partApplication: Elysia | undefined

class NativeApplicationPart extends PluginPart<NativeApplicationPlugin> {
	protected override init() {
		partApplication = this.ctx.elysia
		this.ctx.elysia.get('/native/part', () => 'part')
	}
}

@Plugin()
class NativeApplicationPlugin extends BasePlugin {
	readonly part = this.parts.use(NativeApplicationPart)

	protected override init() {
		ownerApplication = this.ctx.elysia
		this.ctx.elysia.get('/native/hello', () => 'hello')
	}
}

@Plugin({ displayName: 'Reserved native Elysia route' })
class ReservedNativeApplicationPlugin extends BasePlugin {
	protected override init() {
		this.ctx.elysia.get('/__pluxel/hijack', () => 'invalid')
	}
}

@Plugin({ displayName: 'Native route conflict A' })
class NativeRouteConflictA extends BasePlugin {
	protected override init() {
		this.ctx.elysia.get('/native/conflict', () => 'a')
	}
}

@Plugin({ displayName: 'Native route conflict B' })
class NativeRouteConflictB extends BasePlugin {
	protected override init() {
		this.ctx.elysia.get('/native/conflict', () => 'b')
	}
}

@Plugin({ displayName: 'Native exact route semantics' })
class NativeExactRouteSemantics extends BasePlugin {
	protected override init() {
		this.ctx.elysia.get('/native/exact', () => 'plain').get('/native/exact/', () => 'trailing')
	}
}

@Plugin({ displayName: 'Native empty route path' })
class NativeEmptyRoutePath extends BasePlugin {
	protected override init() {
		this.ctx.elysia.get('', () => 'empty-root')
	}
}

@Plugin({ displayName: 'Native slash route path' })
class NativeSlashRoutePath extends BasePlugin {
	protected override init() {
		this.ctx.elysia.get('/', () => 'slash-root')
	}
}

@Plugin({ displayName: 'Native wildcard precedence' })
class NativeWildcardRoute extends BasePlugin {
	protected override init() {
		this.ctx.elysia.all('/native/precedence', () => 'wildcard')
	}
}

@Plugin({ displayName: 'Native concrete precedence' })
class NativeConcreteRoute extends BasePlugin {
	protected override init() {
		this.ctx.elysia.get('/native/precedence', () => 'concrete')
	}
}

@Plugin({ displayName: 'Native wildcard reserved probe' })
class NativeReservedWildcard extends BasePlugin {
	protected override init() {
		this.ctx.elysia
			.use(websocket())
			.all('/*', () => 'business-wildcard')
			.ws('/*', { message() {} })
	}
}

let lifecycleApplication: Elysia | undefined

@Plugin({ displayName: 'Native physical lifecycle guard' })
class NativePhysicalLifecycleGuard extends BasePlugin {
	protected override init() {
		lifecycleApplication = this.ctx.elysia
		this.ctx.elysia.get('/native/server-id', ({ server }) => server?.id ?? 'missing')
	}
}

@Plugin({ displayName: 'Native unsupported Elysia lifecycle hook' })
class NativeUnsupportedLifecycleHook extends BasePlugin {
	protected override init() {
		this.ctx.elysia.cleanup(() => undefined)
	}
}

let streamAborted: (() => void) | undefined

@Plugin({ displayName: 'Native streaming route' })
class NativeStreamingApplicationPlugin extends BasePlugin {
	protected override init() {
		this.ctx.elysia.get(
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
			await using host = createRuntimeHost()

			host.add(NativeApplicationPlugin).start(NativeApplicationPlugin)
			await host.commit()

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
				ownerApplication!
					.fetch(new Request('http://local.test/native/hello'), ownerApplication!.server)
					.then((response) => response.text()),
			).resolves.toBe('hello')
			expect(() => ownerApplication?.get('/native/late', () => 'late')).toThrow(
				'called after the app was sealed',
			)

			host.remove(NativeApplicationPlugin)
			await host.commit()
			const removed = await host.fetch(new Request('http://local.test/native/hello'))
			expect(removed.status).toBe(404)
			await expect(
				ownerApplication!.fetch(
					new Request('http://local.test/native/hello'),
					ownerApplication!.server,
				),
			).rejects.toThrow('Plugin owner stopped')
		}
	})

	it('rejects reserved and conflicting routes before atomic publication', async () => {
		{
			await using host = createRuntimeHost()

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
			await using host = createRuntimeHost()

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

	it('hard-excludes the control namespace from HTTP and WebSocket wildcard owners', async () => {
		{
			await using host = createRuntimeHost()

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
			const detach = requireRuntimeHttpService(host.ctx).attachApplicationCarrier(carrier)
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
			await using host = createRuntimeHost()

			host.add(NativePhysicalLifecycleGuard).start(NativePhysicalLifecycleGuard)
			await host.commit()
			const app = lifecycleApplication!
			const server = app.server
			expect(server).toBeTruthy()
			const serverId = server!.id
			expect(() => app.listen(0)).toThrow('shared physical carrier')
			expect(() => app.stop()).toThrow('shared physical carrier')
			expect(() => app.setup(() => undefined)).toThrow(
				'public external application attach/detach epoch',
			)
			expect(() => app.cleanup(() => undefined)).toThrow(
				'public external application attach/detach epoch',
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
			const detach = requireRuntimeHttpService(host.ctx).attachApplicationCarrier(carrier)
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
			await using host = createRuntimeHost()

			host.add(NativeUnsupportedLifecycleHook)
			host.cfg(NativeUnsupportedLifecycleHook).setAutoStart(true)
			host.start(NativeUnsupportedLifecycleHook)
			const result = await host.commitAllowFail()
			assertPluginLifecycleIssue(result, NativeUnsupportedLifecycleHook, {
				kind: 'start-failed',
				message: 'public external application attach/detach epoch',
			})
			expect(host.isRunning(NativeUnsupportedLifecycleHook)).toBe(false)
		}
	})

	it('aborts and drains an entered streaming response with its generation', async () => {
		{
			await using host = createRuntimeHost()

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
