import { ManagementCompilerService as RuntimeDevManagementCompilerService } from '@pluxel/runtime-dev/management'
import { describe, expect, it } from 'vitest'
import { ManagementCompilerService } from '../../src/hmr/management/ManagementCompilerService'

describe('ManagementCompilerService re-export', () => {
	it('keeps runtime-dynamic wired to the route-neutral runtime-dev implementation', () => {
		expect(ManagementCompilerService).toBe(RuntimeDevManagementCompilerService)
	})
})
