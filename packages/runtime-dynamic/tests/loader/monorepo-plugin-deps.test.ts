import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, setParamToken } from '@pluxel/runtime/test'
import { createHmrTestContext } from '../support/hmr-context'
import { enablePlugins } from '../support/runtime-state'

describe('monorepo plugin dependencies', () => {
	it('commits successfully when dependent plugin modules are both loaded (separate moduleIds)', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader

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

		enablePlugins(ctx, 'Provider', 'Consumer')

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
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader

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
		enablePlugins(ctx, 'Consumer')

		const batch = loader.beginBatch()
		await batch.replaceModule('packages/consumer/src/entry.ts', { Consumer })
		const res = await core.registry.commit()
		expect(res.ok).toBe(false)
		batch.rollback()
		core.registry.resetDraft()
	})
})
