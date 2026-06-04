import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, setParamToken } from '@pluxel/runtime/test'
import { LoaderService } from '../../../runtime-loader/src/services'
import { createHmrTestContext } from '../support/hmr-context'

describe('monorepo plugin dependencies', () => {
	it('commits successfully when dependent plugin modules are both loaded (separate moduleIds)', async () => {
		const { core, ctx } = createHmrTestContext()
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
		const { core, ctx } = createHmrTestContext()
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
