import { ExtensionCompilerService as RuntimeDevExtensionCompilerService } from '@pluxel/runtime-dev/extensions'
import { describe, expect, it } from 'vitest'
import { ExtensionCompilerService } from '../../src/hmr/extensions/ExtensionCompilerService'

describe('ExtensionCompilerService re-export', () => {
	it('keeps runtime-dynamic wired to the route-neutral runtime-dev implementation', () => {
		expect(ExtensionCompilerService).toBe(RuntimeDevExtensionCompilerService)
	})
})
