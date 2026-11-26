import { createCoreContextHost, getContextLoggerRootId, installOwnerViewService } from '../src/host'
import { type Context, type RootContext } from '../src'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { BasePlugin, Plugin } from '@pluxel/core'
import { createCallerContextView, createGenerationContext } from '../src/context/context-factory'
import { createCoreRootContext } from '../src/context/zenfs-plan'
import {
	getInstalledServiceDefinitions,
	consumePluginDefinitionCandidate,
	createCoreContextHostWithFacilities,
	requireFs,
	requireConfigService,
	requireHostDocumentRetention,
	requireHostDocuments,
	requirePluginService,
	snapshotWorkerCoreFacilitiesConfig,
} from '../src/internal'
import { ConfigService } from '../src/services/config/ConfigService'
import { snapshotCoreFacilities } from '../src/context/core-facilities'
import { createMemoryStorage } from '../src/storage/memory'
abstract class ExampleService {}
interface ExampleService {
	readonly owner: Context
}

@Plugin()
class Configless extends BasePlugin {}

describe('Core Context integration', () => {
	it('provides fixed Core facilities outside the extension service registry', () => {
		const root = createCoreRootContext({ name: 'core-integration' })
		const scope = createGenerationContext(root, 'scope')
		expect(root.name).toBe('core-integration')
		expect(scope.logger).toBe(scope.logger)
		expect(scope.effects).toBe(scope.effects)
		expect(scope.logger).not.toBe(root.logger)
		expect(scope.effects).not.toBe(root.effects)
		expect(Object.isExtensible(root)).toBe(false)
		expect('logger' in scope).toBe(true)
		expect(scope.events).toBe(scope.events)
		expect(scope.events.ctx).toBe(scope)
		expect(scope.events).not.toBe(root.events)
		expect(getInstalledServiceDefinitions(root)).toEqual([])
		expect(getInstalledServiceDefinitions(scope)).toEqual([])
		expect('require' in scope).toBe(false)
	})

	it('shares generation facilities while preserving dependency caller ownership', () => {
		const root = createCoreRootContext({ name: 'caller-core' })
		const provider = createGenerationContext(root, 'provider')
		const firstCaller = createGenerationContext(root, 'first-caller')
		const secondCaller = createGenerationContext(root, 'second-caller')
		const firstView = createCallerContextView(provider, firstCaller)
		const secondView = createCallerContextView(provider, secondCaller)
		expect(firstView.caller).toBe(firstCaller)
		expect(secondView.caller).toBe(secondCaller)
		expect(firstView).not.toBe(secondView)
		expect(firstView.effects).toBe(provider.effects)
		expect(secondView.effects).toBe(provider.effects)
		expect(firstView.logger).toBe(provider.logger)
		expect(secondView.logger).toBe(provider.logger)
		expect(firstView.events.ctx).toBe(firstView)
		expect(secondView.events.ctx).toBe(secondView)
		expect(firstView.events).not.toBe(secondView.events)
	})

	it('captures lazy factories before caller mutation and isolates their instances per root', async () => {
		let configCreations = 0
		let lifecycleCreations = 0
		const config = {
			createConfigService(root: RootContext) {
				configCreations++
				return new ConfigService(root)
			},
			createLifecycleHooks() {
				lifecycleCreations++
				return {}
			},
		}
		const storage = vi.fn(createMemoryStorage)
		const facilities = snapshotCoreFacilities({}, () => storage, undefined)
		const host = createCoreContextHostWithFacilities(config, facilities)
		config.createConfigService = () => {
			throw new Error('mutated configuration factory')
		}
		config.createLifecycleHooks = () => {
			throw new Error('mutated lifecycle factory')
		}
		const first = host.createRoot('first')
		const second = host.createRoot('second')
		try {
			expect(configCreations).toBe(0)
			expect(lifecycleCreations).toBe(0)
			const registry = requirePluginService(first)
			const node = Configless.nodeAddress()
			const start = registry.beginUpdate()
			start.materializeNode(node, consumePluginDefinitionCandidate(Configless))
			expect(await start.commit()).toMatchObject({ ok: true })
			expect(registry.getInstance(node)).toBeInstanceOf(Configless)
			const stop = registry.beginUpdate()
			stop.dematerializeNode(node)
			expect(await stop.commit()).toMatchObject({ ok: true })
			expect(storage).not.toHaveBeenCalled()
			expect(configCreations).toBe(0)
			expect(requireConfigService(first)).toBe(requireConfigService(first))
			expect(requirePluginService(first)).toBe(requirePluginService(first))
			expect(configCreations).toBe(1)
			expect(lifecycleCreations).toBe(1)
			expect(requireConfigService(second)).not.toBe(requireConfigService(first))
			expect(requirePluginService(second)).not.toBe(requirePluginService(first))
			expect(configCreations).toBe(2)
			expect(lifecycleCreations).toBe(2)
		} finally {
			await Promise.all([first.effects.dispose(), second.effects.dispose()])
		}
	})

	it('rejects an invalid lifecycle factory result instead of adopting empty hooks', async () => {
		const root = createCoreContextHost({ createLifecycleHooks: () => null as never }).createRoot()
		try {
			expect(() => requirePluginService(root)).toThrow(TypeError)
		} finally {
			await root.effects.dispose()
		}
	})

	it('binds owner views to their Context and rejects duplicate service installations', () => {
		const installation = installOwnerViewService(ExampleService, {
			createRoot: (root) => {
				expectTypeOf(root).toEqualTypeOf<RootContext>()
				return {}
			},
			createView: (_, owner) => ({ owner }),
		})
		const host = createCoreContextHost({ services: [installation] })
		const root = host.createRoot()
		const provider = host.createScope(root, 'provider')
		const part = host.createChild(provider, 'part')
		const caller = host.createScope(root, 'caller')
		const view = createCallerContextView(provider, caller)
		expect(getInstalledServiceDefinitions(root)).toEqual([ExampleService])
		expect(provider.service(ExampleService).owner).toBe(provider)
		expect(part.service(ExampleService).owner).toBe(part)
		expect(view.service(ExampleService).owner).toBe(view)
		expect(provider.service(ExampleService)).not.toBe(view.service(ExampleService))
		expectTypeOf(provider.service(ExampleService)).toEqualTypeOf<ExampleService>()
		expect(() => createCoreContextHost({ services: [installation, installation] })).toThrow(
			/more than once/,
		)
	})

	it('keeps Worker session documents and logger identities local to each root', async () => {
		const plan = createCoreContextHostWithFacilities({}, snapshotWorkerCoreFacilitiesConfig())
		const first = plan.createRoot('first worker')
		const next = plan.createRoot('next worker')
		try {
			const documents = requireHostDocuments(first, 'config')
			await documents.put('records.json', 'first')
			expect(await documents.getText('records.json')).toBe('first')
			expect(await requireHostDocuments(next, 'config').getText('records.json')).toBeUndefined()
			expect(requireHostDocumentRetention(first, 'config')).toBe('session')
			expect(() => requireFs(first)).toThrow(expect.objectContaining({ code: 'ENOTSUP' }))
			expect(getContextLoggerRootId(plan.createScope(first, 'plugin'))).toBe(
				getContextLoggerRootId(first),
			)
			expect(getContextLoggerRootId(first)).not.toBe(getContextLoggerRootId(next))
			await first.effects.dispose()
			await expect(documents.getText('records.json')).rejects.toMatchObject({ code: 'EBADF' })
		} finally {
			await Promise.all([first.effects.dispose(), next.effects.dispose()])
		}
	})

	it.each([
		{ zenfs: {} },
		{ logtape: {} },
		{ vault: { backend: 'encrypted' } },
		{ vault: { durable: true } },
		{ vault: { backend: 'bindings', deployIdentity: '' } },
		{ http: { proxyUrl: null } },
		{ http: { allowProxyChanges: false } },
	] as const)('rejects facilities that the Worker assembly does not own: %j', (config) => {
		expect(() => snapshotWorkerCoreFacilitiesConfig(config)).toThrow(TypeError)
	})
})
