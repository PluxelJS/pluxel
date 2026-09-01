import { createRuntimeContext } from '@pluxel/runtime/test'
import { createOwnerContext } from '@pluxel/core/internal'
import { describe, expect, it, vi } from 'vitest'

import { attachPluginArtifactCompiler } from '../src/workbench'

describe('attachPluginArtifactCompiler', () => {
	it('attaches one semantic-plan compiler owner to the Runtime root', async () => {
		const runtime = createRuntimeContext()
		const { ctx } = runtime
		const attachSourceBinder = vi.spyOn(ctx.nodeModules, 'attachSourceBinder')

		const options = { packageMode: 'development' } as const
		const attachment = attachPluginArtifactCompiler(ctx, options)

		expect(attachSourceBinder).toHaveBeenCalledOnce()
		expect(() => attachPluginArtifactCompiler(ctx, options)).toThrow(/already attached/)
		expect(attachSourceBinder).toHaveBeenCalledTimes(1)
		expect(() => attachPluginArtifactCompiler(createOwnerContext(ctx, 'nested'), options)).toThrow(
			/root Context/,
		)
		expect(attachSourceBinder).toHaveBeenCalledTimes(1)

		attachment.dispose()
		await expect(
			attachment.publishWorkbenchArtifacts({ producers: [], pages: [] }),
		).rejects.toThrow(/disposed/)
		const attachmentAgain = attachPluginArtifactCompiler(ctx, options)
		expect(attachSourceBinder).toHaveBeenCalledTimes(2)
		attachmentAgain.dispose()
		await runtime.dispose()
	})
})
