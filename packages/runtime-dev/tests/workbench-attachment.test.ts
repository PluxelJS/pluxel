import { createRuntimeContext } from '@pluxel/runtime/test'
import { createOwnerContext } from '@pluxel/core/internal'
import { describe, expect, it, vi } from 'vitest'

import { attachPluginArtifactCompiler } from '../src/workbench'

describe('attachPluginArtifactCompiler', () => {
	it('attaches one semantic-plan compiler owner to the Runtime root', async () => {
		const runtime = createRuntimeContext()
		const { ctx } = runtime
		const attachSourceBinder = vi.spyOn(ctx.nodeModules, 'attachSourceBinder')

		const attachment = attachPluginArtifactCompiler(ctx)

		expect(attachSourceBinder).toHaveBeenCalledOnce()
		expect(() => attachPluginArtifactCompiler(ctx)).toThrow(/already attached/)
		expect(attachSourceBinder).toHaveBeenCalledTimes(1)
		expect(() => attachPluginArtifactCompiler(createOwnerContext(ctx, 'nested'))).toThrow(
			/root Context/,
		)
		expect(attachSourceBinder).toHaveBeenCalledTimes(1)

		attachment.dispose()
		await expect(attachment.publishWorkbenchProducers([])).rejects.toThrow(/disposed/)
		const attachmentAgain = attachPluginArtifactCompiler(ctx)
		expect(attachSourceBinder).toHaveBeenCalledTimes(2)
		attachmentAgain.dispose()
		await runtime.dispose()
	})
})
