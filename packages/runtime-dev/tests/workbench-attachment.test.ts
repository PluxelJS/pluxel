import { createRuntimeContext } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'

import { attachWorkbenchCompiler } from '../src/workbench'

describe('attachWorkbenchCompiler', () => {
	it('owns one compiler attachment and restores the previous Context state', async () => {
		const runtime = createRuntimeContext()
		const { ctx } = runtime
		const previousDev = {}
		const previousConfig = { cacheDir: '.pluxel/previous-workbench' }
		ctx.runtimeDev = previousDev
		ctx.config.workbenchCompiler = previousConfig

		const dispose = attachWorkbenchCompiler(ctx, {
			config: { cacheKeep: 2 },
			vite: { define: { __ATTACHMENT_TEST__: 'true' } },
		})

		expect(ctx.runtimeDev?.workbenchUiSource?.bind).toBeTypeOf('function')
		expect(ctx.config.workbenchCompiler).toMatchObject({
			cacheKeep: 2,
			vite: { define: { __ATTACHMENT_TEST__: 'true' } },
		})
		expect(() => attachWorkbenchCompiler(ctx)).toThrow(/already attached/)

		await dispose()
		expect(ctx.runtimeDev).toBe(previousDev)
		expect(ctx.config.workbenchCompiler).toBe(previousConfig)
		await runtime.dispose()
	})
})
