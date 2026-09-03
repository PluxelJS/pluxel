import { pluginNodeAddressOf } from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { defineStaticRuntime, type StaticRuntimeStartupContext } from '@pluxel/runtime-static'
import { startStaticApplicationTestHost } from '@pluxel/runtime-static/test'
import * as runtimeStaticTest from '@pluxel/runtime-static/test'
import { describe, expect, it } from 'vitest'

@Plugin({ displayName: 'Static application probe' })
class StaticApplicationProbe extends BasePlugin {
	readonly ready = true

	override init(): void {
		this.ctx.elysia.get('/static-application-probe', () => 'ready')
	}
}

@Plugin({ displayName: 'Static application failure' })
class StaticApplicationFailure extends BasePlugin {
	override init(): void {
		throw new Error('expected startup failure')
	}
}

@Plugin()
class OutsideCatalog extends BasePlugin {}

describe('startStaticApplicationTestHost', () => {
	it('exports only the application-author test host factory', () => {
		expect(Object.keys(runtimeStaticTest)).toEqual(['startStaticApplicationTestHost'])
	})

	it('returns a ready read-only application view with shared Runtime drivers', async () => {
		const application = defineStaticRuntime({
			name: 'static-application-test-host',
			plugins: [StaticApplicationProbe] as const,
			configure: () => ({
				configService: { mode: 'memory' },
				runtimeState: {
					mode: 'memory',
					snapshot: { autoStart: [pluginNodeAddressOf(StaticApplicationProbe)] },
				},
				workbench: false,
				logging: false,
			}),
		})
		const host = await startStaticApplicationTestHost(application)

		expect(Object.keys(host).sort()).toEqual([
			'commands',
			'config',
			'dispose',
			'http',
			'isRunning',
			'require',
			'startupReport',
			'workbench',
		])
		expect(Object.isFrozen(host)).toBe(true)
		expect(host.startupReport).toEqual({
			runtime: 'static-application-test-host',
			entries: [expect.objectContaining({ status: 'started' })],
		})
		expect('commit' in host.startupReport).toBe(false)
		expect(host.isRunning(StaticApplicationProbe)).toBe(true)
		expect(host.require(StaticApplicationProbe)).toMatchObject({ ready: true })
		expect(host.commands.list()).toEqual(expect.any(Array))

		const response = await host.http.fetch(new URL('/static-application-probe', host.http.origin))
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('ready')
		expect(() => host.require(OutsideCatalog as never)).toThrow(/outside.*fixed catalog/i)

		await Promise.all([host.dispose(), host[Symbol.asyncDispose]()])
		expect(() => host.isRunning(StaticApplicationProbe)).toThrow(/closed|closing/i)
		await expect(
			host.http.fetch(new URL('/static-application-probe', host.http.origin)),
		).rejects.toThrow(/closed|closing/i)
	})

	it('preserves required startup binding inference and values', async () => {
		let observed = ''
		const application = defineStaticRuntime<readonly [], { serviceUrl: string }>({
			name: 'static-application-bindings',
			plugins: [],
			configure({ bindings }: StaticRuntimeStartupContext<{ serviceUrl: string }>) {
				observed = bindings.serviceUrl
				return { logging: false }
			},
		})

		await using host = await startStaticApplicationTestHost(application, {
			bindings: { serviceUrl: 'https://service.test' },
		})
		expect(observed).toBe('https://service.test')
		expect(host.startupReport.entries).toEqual([])
	})

	it('resolves partial Plugin startup failure into the structured application report', async () => {
		await using host = await startStaticApplicationTestHost(
			defineStaticRuntime({
				name: 'static-application-partial-failure',
				plugins: [StaticApplicationFailure] as const,
				configure: () => ({
					runtimeState: {
						mode: 'memory',
						snapshot: { autoStart: [pluginNodeAddressOf(StaticApplicationFailure)] },
					},
					logging: false,
				}),
			}),
		)

		expect(host.isRunning(StaticApplicationFailure)).toBe(false)
		expect(host.startupReport.entries).toEqual([
			expect.objectContaining({
				status: 'start-failed',
				message: expect.stringContaining('expected startup failure'),
			}),
		])
	})

	it('cleans resources acquired before a fatal application prepare failure', async () => {
		let resourceActive = false
		const application = defineStaticRuntime({
			name: 'static-application-fatal-prepare',
			plugins: [] as const,
			configure: () => ({ logging: false }),
			prepare({ host: applicationHost }) {
				resourceActive = true
				applicationHost.ctx.effects.defer(() => {
					resourceActive = false
				})
				throw new Error('fatal prepare failure')
			},
		})

		await expect(startStaticApplicationTestHost(application)).rejects.toThrow(
			'fatal prepare failure',
		)
		expect(resourceActive).toBe(false)
	})

	it('shares concurrent disposal and retains multiple teardown failures', async () => {
		const host = await startStaticApplicationTestHost(
			defineStaticRuntime({
				name: 'static-application-teardown-failures',
				plugins: [] as const,
				configure: () => ({ logging: false }),
				prepare({ host: internalHost }) {
					internalHost.ctx.effects.defer(() => {
						throw new Error('first teardown failure')
					})
					internalHost.ctx.effects.defer(() => {
						throw new Error('second teardown failure')
					})
				},
			}),
		)

		const first = host.dispose()
		const second = host[Symbol.asyncDispose]()
		expect(second).toBe(first)
		const error = await first.catch((cause: unknown) => cause)
		expect(error).toBeInstanceOf(AggregateError)
		expect(collectErrorMessages(error)).toEqual(
			expect.arrayContaining(['first teardown failure', 'second teardown failure']),
		)
	})
})

function collectErrorMessages(error: unknown): string[] {
	if (error instanceof AggregateError) return error.errors.flatMap(collectErrorMessages)
	return error instanceof Error ? [error.message] : [String(error)]
}
