import 'reflect-metadata'
import '@pluxel/core/services'

import { describe, expect, it } from 'bun:test'
import { BasePlugin, Context, Plugin } from '@pluxel/core'
import { LoaderService } from '../../src/services/loader/LoaderService'

function createHmrCtx(core: Context) {
	const enabled = new Set<string>()
	const configService = {
		isEnable(name: string) {
			return enabled.has(name)
		},
		enablePlugin(...names: string[]) {
			for (const n of names) enabled.add(n)
		},
		disablePlugin(...names: string[]) {
			for (const n of names) enabled.delete(n)
		},
		getConfig(_name: string) {
			return { meta: {}, configRecord: {} }
		},
		setConfig() {},
	}

	// Context from @pluxel/core exposes many services as readonly getters.
	// For loader/HMR unit tests we provide a minimal shim context that delegates
	// event wiring to the real core context but keeps stubs writable.
	return {
		registry: core.registry,
		events: (core as any).events,
		on: core.on.bind(core),
		emit: (core as any).emit?.bind(core),
		logger: { info() {}, warn() {}, error() {} },
		configService,
	} as any
}

describe('LoaderService', () => {
	it('getPluginDependenciesInfo tolerates abstract/base tokens', async () => {
		const core = new Context()
		const ctx = createHmrCtx(core)
		const loader = new LoaderService(ctx)

		abstract class Abs extends BasePlugin {}

		@Plugin(Abs, { name: 'Impl' })
		class Impl extends Abs {}

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			constructor(_dep: Abs) {
				super()
			}
		}

		core.registry.pluginRegistry.registerPlugin(Impl)
		core.registry.pluginRegistry.registerPlugin(Consumer)
		const res = await core.registry.commit()
		expect(res.ok).toBe(true)

		const deps = loader.getPluginDependenciesInfo(Consumer)
		expect(deps).toEqual([{ name: 'Abs', isRunning: true }])
	})

	it('batch rollback keeps loader state consistent when core commit fails', async () => {
		const core = new Context()
		const ctx = createHmrCtx(core)
		// Enable both plugins so loader will register them into the core container.
		ctx.configService.enablePlugin('Impl1', 'Impl2')
		const loader = new LoaderService(ctx)

		abstract class Abs extends BasePlugin {}

		@Plugin(Abs, { name: 'Impl1' })
		class Impl1 extends Abs {}

		@Plugin(Abs, { name: 'Impl2' })
		class Impl2 extends Abs {}

		// Baseline: load module A providing Impl1 and commit successfully.
		{
			const batch = loader.beginBatch()
			await batch.replaceModule('A.ts', { Impl1 })
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
			batch.commit()
		}

		expect(core.registry.isRunning(Abs)).toBe(true)
		expect(core.registry.optional(Abs)).toBeInstanceOf(Impl1)

		// Hot update: load module B providing another provider for the same base -> commit should fail.
		{
			const batch = loader.beginBatch()
			await batch.replaceModule('B.ts', { Impl2 })
			const res = await core.registry.commit()
			expect(res.ok).toBe(false)
			batch.rollback()
			core.registry.pluginRegistry.resetDraft()
		}

		// After rollback, loader should not claim Impl2 is loaded.
		expect(loader.registry.getPluginByName('Impl2')).toBeUndefined()
		expect(loader.pathAnchors.has('B.ts')).toBe(false)

		// Core should still be on the previous container: base resolves to Impl1 and remains running.
		expect(core.registry.isRunning(Abs)).toBe(true)
		expect(core.registry.optional(Abs)).toBeInstanceOf(Impl1)
	})
})
