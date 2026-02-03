import '@pluxel/test/setup'

import { describe, expect, it } from 'vitest'
import { BasePlugin, Context, Plugin, setParamToken } from '@pluxel/core'
import { LoaderService } from '../../src/services/runtime/loader/LoaderService'

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

describe('monorepo plugin dependencies', () => {
	it('commits successfully when dependent plugin modules are both loaded (separate moduleIds)', async () => {
		const core = new Context()
		const ctx = createHmrCtx(core)
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Provider' })
		class Provider extends BasePlugin {}

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			constructor(_dep: Provider) {
				super()
			}
		}
		// In tests we explicitly set DI tokens (no reflect-metadata).
		setParamToken(Consumer, 0, Provider)

		ctx.configService.enableInConfig('Provider', 'Consumer')

		const batch = loader.beginBatch()
		await batch.replaceModule('packages/provider/src/entry.ts', { Provider })
		await batch.replaceModule('packages/consumer/src/entry.ts', { Consumer })
		const res = await core.registry.commit()
		expect(res.ok).toBe(true)
		batch.commit()

		expect(core.registry.isRunning(Provider)).toBe(true)
		expect(core.registry.isRunning(Consumer)).toBe(true)
	})

	it('fails commit when a runtime-enabled plugin depends on another plugin that is not loaded via entries', async () => {
		const core = new Context()
		const ctx = createHmrCtx(core)
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Provider' })
		class Provider extends BasePlugin {}

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			constructor(_dep: Provider) {
				super()
			}
		}
		setParamToken(Consumer, 0, Provider)

		// Simulate: profile selected Consumer's package entry, but not Provider's package entry.
		// Runtime config enables Consumer anyway -> DI commit must fail.
		ctx.configService.enableInConfig('Consumer')

		const batch = loader.beginBatch()
		await batch.replaceModule('packages/consumer/src/entry.ts', { Consumer })
		const res = await core.registry.commit()
		expect(res.ok).toBe(false)
		batch.rollback()
		core.registry.resetDraft()
	})
})

