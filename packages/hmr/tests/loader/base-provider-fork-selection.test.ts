import '@pluxel/test/setup'

import { describe, expect, it } from 'bun:test'
import { Context, ForkablePlugin, Plugin } from '@pluxel/core'
import { LoaderService } from '../../src/services/loader/LoaderService'
import { EXTRA_BASE_PROVIDERS, EXTRA_FORKS } from '../../src/services/loader/selection'

function createHmrCtx(core: Context) {
	const enabled = new Set<string>()
	const extra: Record<string, unknown> = Object.create(null)
	const configService = {
		isReady: true,
		ready: Promise.resolve(),
		isEnabledInConfig(name: string) {
			return enabled.has(name)
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
	} as unknown as Context
}

describe('base provider selection', () => {
	it('self-heals when baseProviders points to a fork id', async () => {
		const core = new Context()
		const ctx = createHmrCtx(core)
		const loader = new LoaderService(ctx)

		abstract class Abs extends ForkablePlugin {}

		@Plugin(Abs, { name: 'Impl' })
		class Impl extends Abs {}

		// Persist an invalid selection: base points to a fork id.
		ctx.configService.setExtra(EXTRA_BASE_PROVIDERS, { Abs: 'Impl#f1' })
		ctx.configService.setExtra(EXTRA_FORKS, { Impl: ['f1'] })

		// Enable both the provider and the fork.
		ctx.configService.enableInConfig('Impl', 'Impl#f1')

		const batch = loader.beginBatch()
		await batch.replaceModule('A.ts', { Impl })
		{
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
			batch.commit()
		}

		// Base token must still resolve/runs (selection should not break DI).
		expect(core.registry.isRunning(Abs)).toBe(true)
	})
})
