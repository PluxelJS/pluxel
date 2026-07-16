import { createRuntimeContext } from '@pluxel/runtime/test'
import { requireWorkbench } from '@pluxel/runtime/internal'
import { describe, expect, it, vi } from 'vitest'

import { attachPluginArtifactCompiler } from '../src/workbench'

describe('attachPluginArtifactCompiler', () => {
	it('attaches one compiler directly to the root Workbench artifacts', async () => {
		const runtime = createRuntimeContext()
		const { ctx } = runtime
		const previousDev = {}
		const previousConfig = { cacheDir: '.pluxel/previous-workbench' }
		ctx.runtimeDev = previousDev
		ctx.config.pluginArtifactCompiler = previousConfig
		const artifacts = requireWorkbench(ctx).artifacts
		const attachSourceBinder = vi.spyOn(artifacts, 'attachSourceBinder')

		const dispose = attachPluginArtifactCompiler(ctx, {
			config: { cacheKeep: 2 },
			vite: { define: { __ATTACHMENT_TEST__: 'true' } },
		})

		expect(attachSourceBinder).toHaveBeenCalledOnce()
		expect(ctx.runtimeDev).toBe(previousDev)
		expect(ctx.config.pluginArtifactCompiler).toBe(previousConfig)
		expect(() => attachPluginArtifactCompiler(ctx)).toThrow(/already attached/)
		expect(attachSourceBinder).toHaveBeenCalledTimes(1)
		expect(() => attachPluginArtifactCompiler(ctx.extend())).toThrow(/root Context/)
		expect(attachSourceBinder).toHaveBeenCalledTimes(1)

		await dispose()
		const disposeAgain = attachPluginArtifactCompiler(ctx)
		expect(attachSourceBinder).toHaveBeenCalledTimes(2)
		await disposeAgain()
		await runtime.dispose()
	})
})
