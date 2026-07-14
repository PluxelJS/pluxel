import { WorkbenchCompilerService as RuntimeDevWorkbenchCompilerService } from '@pluxel/runtime-dev/workbench'
import { describe, expect, it } from 'vitest'
import { WorkbenchCompilerService } from '../../src/hmr/workbench/WorkbenchCompilerService'

describe('WorkbenchCompilerService re-export', () => {
	it('keeps runtime-dynamic wired to the route-neutral runtime-dev implementation', () => {
		expect(WorkbenchCompilerService).toBe(RuntimeDevWorkbenchCompilerService)
	})
})
