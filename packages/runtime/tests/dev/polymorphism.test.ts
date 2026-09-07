import { pluginDefinitionAddressOf, pluginNodeAddressOf } from '@pluxel/core'
import { createRuntimeInternalTestHost } from '@pluxel/runtime/internal/test'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { describe, expect, it } from 'vitest'
import { v } from '../../src/config'
import { setAutoStart } from '../../src/api/usecases/pluginStatus'
import { createDevConsoleScope } from '../../src/internal/dev-console'

abstract class Service extends BasePlugin {
	abstract readonly label: string
}
const Config = v.object({ label: v.optional(v.string(), 'primary') })
@Plugin(Service, { forkable: true })
class Primary extends Service {
	readonly config = this.configs.use(Config)
	get label() {
		return this.config.label
	}
}
@Plugin(Service)
class Alternate extends Service {
	readonly label = 'alternate'
}
@Plugin()
class Consumer extends BasePlugin {
	constructor(readonly service: Service) {
		super()
	}
}
@Plugin()
class Dependent extends BasePlugin {
	constructor(readonly consumer: Consumer) {
		super()
	}
}

describe('development console polymorphism', () => {
	it('selects abstract defaults and forks, restarts dependents, and clears selections', async () => {
		await using host = createRuntimeInternalTestHost()
		await host.commit((change) => change.catalog.add([Primary, Alternate, Consumer, Dependent]))
		const scope = createDevConsoleScope({ ctx: host.ctx })
		const { dev } = scope
		const east = { plugin: Primary, forkId: 'east' }
		const requirement = pluginDefinitionAddressOf(Service)
		try {
			expect(
				await dev.dependencies.setDefault({ requirement: Service, provider: Primary }),
			).toMatchObject({ ok: true, status: 'applied', report: expect.any(Object) })
			expect(await dev.plugins.start(Dependent)).toMatchObject({ ok: true })
			const first = dev.plugins.require(Consumer)
			const firstDependent = dev.plugins.require(Dependent)
			expect(first.service.label).toBe('primary')
			expect(await dev.dependencies.inspect(Consumer)).toMatchObject({
				ok: true,
				items: [
					{ requirement, consumerOverride: null, inheritedProvider: pluginNodeAddressOf(Primary) },
				],
			})
			expect(await dev.forks.ensure(east)).toMatchObject({
				ok: true,
				fork: {
					definition: pluginDefinitionAddressOf(Primary),
					variant: 'fork',
					forkId: 'east',
				},
				report: expect.any(Object),
			})
			expect(dev.plugins.isRunning(east)).toBe(false)
			expect(
				await dev.dependencies.setOverride({
					consumer: Consumer,
					requirement: Service,
					provider: east,
				}),
			).toMatchObject({ ok: true, report: expect.any(Object) })
			expect(dev.plugins.isRunning(east)).toBe(true)
			expect(dev.plugins.require(Consumer) === first).toBe(false)
			expect(dev.plugins.require(Dependent) === firstDependent).toBe(false)
			expect(dev.plugins.require(Consumer).service.ctx.pluginInfo.nodeAddress).toMatchObject({
				variant: 'fork',
				forkId: 'east',
			})
			expect(await dev.forks.remove(east)).toMatchObject({
				ok: false,
				code: 'fork_referenced',
				state: 'unchanged',
				references: [{ consumer: pluginNodeAddressOf(Consumer), requirement }],
			})
			expect(await dev.dependencies.setDefault({ requirement, provider: Alternate })).toMatchObject(
				{ ok: true },
			)
			expect(dev.plugins.require(Consumer).service.ctx.pluginInfo.nodeAddress).toMatchObject({
				variant: 'fork',
			})
			expect(
				await dev.dependencies.clearOverride({ consumer: Consumer, requirement }),
			).toMatchObject({ ok: true })
			expect(dev.plugins.require(Consumer).service.label).toBe('alternate')
			expect(await dev.forks.remove(east)).toMatchObject({
				ok: true,
				status: 'removed',
				report: expect.any(Object),
			})
			expect(await dev.forks.remove(east)).toMatchObject({ ok: true, status: 'already-absent' })
			await dev.plugins.stop(Dependent)
			await dev.plugins.stop(Consumer)
			expect(await dev.dependencies.clearDefault(Service)).toMatchObject({ ok: true })
			expect(await dev.dependencies.inspect(Consumer)).toMatchObject({
				ok: true,
				items: [{ consumerOverride: null, inheritedProvider: pluginNodeAddressOf(Primary) }],
			})
		} finally {
			await scope.dispose()
		}
	})

	it('returns domain failures for unavailable consumers and invalid provider selections', async () => {
		await using host = createRuntimeInternalTestHost()
		await host.commit((change) => change.catalog.add([Primary, Alternate, Consumer]))
		const scope = createDevConsoleScope({ ctx: host.ctx })
		const { dev } = scope
		try {
			expect(await dev.dependencies.inspect(pluginNodeAddressOf(Dependent))).toMatchObject({
				ok: false,
				code: 'consumer_unavailable',
				state: 'unchanged',
			})
			expect(await dev.dependencies.inspect({ plugin: Primary, forkId: 'missing' })).toMatchObject({
				ok: false,
				code: 'consumer_unavailable',
				state: 'unchanged',
			})
			expect(await dev.forks.ensure({ plugin: Alternate, forkId: 'invalid' })).toMatchObject({
				ok: false,
				code: 'not_forkable',
				state: 'unchanged',
			})
			await dev.forks.ensure({ plugin: Primary, forkId: 'existing' })
			expect(
				await dev.dependencies.setDefault({
					requirement: Service,
					provider: {
						definition: pluginDefinitionAddressOf(Primary),
						variant: 'fork',
						forkId: 'existing',
					} as never,
				}),
			).toMatchObject({ ok: false, code: 'fork_default_forbidden', state: 'unchanged' })
			expect(
				await dev.dependencies.setOverride({
					consumer: Consumer,
					requirement: Service,
					provider: Consumer,
				}),
			).toMatchObject({ ok: false, code: 'provider_incompatible', state: 'unchanged' })
		} finally {
			await scope.dispose()
		}
	})

	it('keeps fork configuration isolated and preserves existing automatic-start policy', async () => {
		await using host = createRuntimeInternalTestHost()
		await host.start(Primary)
		const scope = createDevConsoleScope({ ctx: host.ctx })
		const { dev } = scope
		const east = { plugin: Primary, forkId: 'configured-east' }
		const west = { plugin: Primary, forkId: 'configured-west' }
		try {
			await dev.forks.ensure(east)
			await dev.forks.ensure(west)
			expect(await dev.config.patch(east, { label: 'east' })).toMatchObject({ ok: true })
			await dev.plugins.start(east)
			await dev.plugins.start(west)
			expect(dev.plugins.require(east).label).toBe('east')
			expect(dev.plugins.require(west).label).toBe('primary')
			expect(dev.plugins.require(Primary).label).toBe('primary')
			await setAutoStart(host.ctx, [
				{
					address: {
						definition: pluginDefinitionAddressOf(Primary),
						variant: 'fork',
						forkId: east.forkId,
					},
					autoStart: true,
				},
			])
			const instance = dev.plugins.require(east)
			await dev.forks.ensure(east)
			expect(await dev.plugins.status(east)).toMatchObject({ autoStart: true })
			expect(dev.plugins.require(east)).toBe(instance)
		} finally {
			await scope.dispose()
		}
	})

	it('rejects stale concrete constructors throughout polymorphic operations', async () => {
		await using host = createRuntimeInternalTestHost()
		await host.commit((change) => change.catalog.add([Primary, Consumer]))
		const scope = createDevConsoleScope({ ctx: host.ctx })
		const next = lowerTestReplacement(Primary, class extends Primary {}, {
			plugin: { forkable: true },
			provides: Service,
		})
		try {
			await host.replaceDefinition(Primary, next)
			expect(() => scope.dev.plugins.isRunning(Primary)).toThrow(
				expect.objectContaining({ code: 'stale_target' }),
			)
			await expect(
				scope.dev.forks.ensure({ plugin: Primary, forkId: 'stale' }),
			).rejects.toMatchObject({ code: 'stale_target' })
			await expect(
				scope.dev.forks.remove({ plugin: Primary, forkId: 'stale' }),
			).rejects.toMatchObject({ code: 'stale_target' })
			await expect(
				scope.dev.dependencies.setDefault({ requirement: Service, provider: Primary }),
			).rejects.toMatchObject({ code: 'stale_target' })
			await expect(
				scope.dev.dependencies.setOverride({
					consumer: Consumer,
					requirement: Service,
					provider: { plugin: Primary, forkId: 'stale' },
				}),
			).rejects.toMatchObject({ code: 'stale_target' })
		} finally {
			await scope.dispose()
		}
	})

	it('closes borrowed capabilities without stopping or removing managed instances', async () => {
		await using host = createRuntimeInternalTestHost()
		await host.start(Primary)
		const scope = createDevConsoleScope({ ctx: host.ctx })
		const { dev } = scope
		const east = { plugin: Primary, forkId: 'retained' }
		await dev.forks.ensure(east)
		await dev.plugins.start(east)
		await scope.dispose()
		expect(host.isRunning(Primary)).toBe(true)
		expect(() => dev.plugins.isRunning(Primary)).toThrow(
			expect.objectContaining({ code: 'scope_closed' }),
		)
		await expect(dev.dependencies.inspect(Primary)).rejects.toMatchObject({ code: 'scope_closed' })
		await expect(
			dev.dependencies.setDefault({ requirement: Service, provider: Primary }),
		).rejects.toMatchObject({ code: 'scope_closed' })
		await expect(dev.dependencies.clearDefault(Service)).rejects.toMatchObject({
			code: 'scope_closed',
		})
		await expect(
			dev.dependencies.setOverride({ consumer: Consumer, requirement: Service, provider: Primary }),
		).rejects.toMatchObject({ code: 'scope_closed' })
		await expect(
			dev.dependencies.clearOverride({ consumer: Consumer, requirement: Service }),
		).rejects.toMatchObject({ code: 'scope_closed' })
		await expect(dev.forks.ensure(east)).rejects.toMatchObject({ code: 'scope_closed' })
		await expect(dev.forks.remove(east)).rejects.toMatchObject({ code: 'scope_closed' })
		const second = createDevConsoleScope({ ctx: host.ctx })
		try {
			expect(second.dev.plugins.isRunning(east)).toBe(true)
		} finally {
			await second.dispose()
		}
	})
})
