import { createRuntimeContext } from '@pluxel/runtime/test'
import { requireWorkbench } from '@pluxel/runtime/internal'
import { createOwnerContext } from '@pluxel/core/internal'
import { describe, expect, it, vi } from 'vitest'

import { attachPluginArtifactCompiler } from '../src/workbench'

describe('attachPluginArtifactCompiler', () => {
	it('attaches one compiler directly to the root Workbench artifacts', async () => {
		const runtime = createRuntimeContext()
		const { ctx } = runtime
		const artifacts = requireWorkbench(ctx).artifacts
		const attachSourceBinder = vi.spyOn(artifacts, 'attachSourceBinder')

		const dispose = attachPluginArtifactCompiler(ctx)

		expect(attachSourceBinder).toHaveBeenCalledOnce()
		expect(() => attachPluginArtifactCompiler(ctx)).toThrow(/already attached/)
		expect(attachSourceBinder).toHaveBeenCalledTimes(1)
		expect(() => attachPluginArtifactCompiler(createOwnerContext(ctx, 'nested'))).toThrow(
			/root Context/,
		)
		expect(attachSourceBinder).toHaveBeenCalledTimes(1)

		await dispose()
		const disposeAgain = attachPluginArtifactCompiler(ctx)
		expect(attachSourceBinder).toHaveBeenCalledTimes(2)
		await disposeAgain()
		await runtime.dispose()
	})
})
