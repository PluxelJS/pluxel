import { createRuntimeContext } from '@pluxel/runtime/test'
import { requireWorkbench } from '@pluxel/runtime/internal'
import { describe, expect, it, vi } from 'vitest'

import { attachWorkbenchCompiler } from '../src/workbench'

describe('attachWorkbenchCompiler', () => {
	it('attaches one compiler directly to the root Workbench artifacts', async () => {
		const runtime = createRuntimeContext()
		const { ctx } = runtime
		const previousDev = {}
		const previousConfig = { cacheDir: '.pluxel/previous-workbench' }
		ctx.runtimeDev = previousDev
		ctx.config.workbenchCompiler = previousConfig
		const artifacts = requireWorkbench(ctx).artifacts
		const attachSourceBinder = vi.spyOn(artifacts, 'attachSourceBinder')

		const dispose = attachWorkbenchCompiler(ctx, {
			config: { cacheKeep: 2 },
			vite: { define: { __ATTACHMENT_TEST__: 'true' } },
		})

		expect(attachSourceBinder).toHaveBeenCalledOnce()
		expect(ctx.runtimeDev).toBe(previousDev)
		expect(ctx.config.workbenchCompiler).toBe(previousConfig)
		expect(() => attachWorkbenchCompiler(ctx)).toThrow(/already attached/)
		expect(attachSourceBinder).toHaveBeenCalledTimes(2)
		expect(() => attachWorkbenchCompiler(ctx.extend())).toThrow(/root Context/)
		expect(attachSourceBinder).toHaveBeenCalledTimes(2)

		await dispose()
		const disposeAgain = attachWorkbenchCompiler(ctx)
		expect(attachSourceBinder).toHaveBeenCalledTimes(3)
		await disposeAgain()
		await runtime.dispose()
	})
})
