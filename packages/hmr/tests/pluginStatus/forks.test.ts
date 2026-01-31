import '@pluxel/test/setup'

import { describe, expect, it } from 'bun:test'
import type { Context as PlxContext } from '@pluxel/core'
import { BasePlugin, Context, ForkablePlugin, Plugin } from '@pluxel/core'
import { getStatusOverview } from '../../src/api/features/pluginStatus/service'
import { LoaderService } from '../../src/services/loader/LoaderService'
import { EXTRA_FORKS } from '../../src/services/loader/selection'

function createHmrCtx(core: Context) {
	const enabled = new Set<string>()
	const extra: Record<string, unknown> = Object.create(null)
	const configService = {
		isReady: true,
		ready: Promise.resolve(),
		isEnabledInConfig(name: string) {
			return enabled.has(name)
		},
		setEnabledInConfig(name: string, on: boolean) {
			if (on) enabled.add(name)
			else enabled.delete(name)
		},
		enableInConfig(...names: string[]) {
			for (const n of names) enabled.add(n)
		},
		disableInConfig(...names: string[]) {
			for (const n of names) enabled.delete(n)
		},
		getRawConfig(_name: string) {
			return {}
		},
		getConfigRevision() {
			return 0
		},
		ensureValidated() {
			return Promise.resolve({})
		},
		patchConfig: () => undefined,
		getExtra<T = unknown>(key: string): T | undefined {
			return extra[key] as T | undefined
		},
		setExtra(key: string, value: unknown) {
			extra[key] = value
		},
		batch(run: () => void) {
			run()
		},
	}

	const coreEvents = (core as unknown as { events: unknown }).events
	const coreEmit = (core as unknown as { emit?: (...args: unknown[]) => unknown }).emit

	return {
		registry: core.registry,
		events: coreEvents,
		on: core.on.bind(core),
		emit: typeof coreEmit === 'function' ? coreEmit.bind(core) : undefined,
		logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		configService,
		loader: undefined as LoaderService | undefined,
	} satisfies Partial<PlxContext>
}

describe('pluginStatus forks', () => {
	it('includes fork plugins from runtime and from catalog', async () => {
		const core = new Context()
		const ctx = createHmrCtx(core) as PlxContext
		const loader = new LoaderService(ctx as unknown as Context)
		ctx.loader = loader

		@Plugin({ name: 'DemoWorker' })
		class DemoWorker extends ForkablePlugin {}

		const batch = loader.beginBatch()
		await batch.replaceModule('A.ts', { DemoWorker })
		{
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
			batch.commit()
		}

		// Create + start a runtime fork (not declared in loader registry map).
		const ForkA = core.registry.fork(DemoWorker, 'aaa')
		await loader.api.control.enable('DemoWorker#aaa', ForkA)
		{
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
		}

		// Persist another fork in the catalog, without starting it.
		ctx.configService.setExtra(EXTRA_FORKS, { DemoWorker: ['bbb'] })

		const overview = getStatusOverview(ctx)
		const names = overview.statuses.map((s) => s?.name).filter(Boolean)

		expect(names).toContain('DemoWorker')
		expect(names).toContain('DemoWorker#aaa')
		expect(names).toContain('DemoWorker#bbb')
	})

	it('enabling the same plugin twice is idempotent', async () => {
		const core = new Context()
		const ctx = createHmrCtx(core)
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Alpha' })
		class Alpha extends BasePlugin {}

		// Load module (does not auto-enable without config).
		const batch = loader.beginBatch()
		await batch.replaceModule('A.ts', { Alpha })
		{
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
			batch.commit()
		}

		// Duplicate enable calls should not throw or unregister.
		await loader.api.control.enable('Alpha', Alpha)
		await loader.api.control.enable('Alpha', Alpha)
		{
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
		}

		expect(core.registry.isRunning(Alpha)).toBe(true)
	})
})
