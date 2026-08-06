import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'

import { resolveRuntimeStoragePaths } from '../../src/runtime/paths'

describe('runtime host path policy', () => {
	it('uses runtime-owned defaults for managed hosts', () => {
		const root = '/workspace/app'
		const paths = resolveRuntimeStoragePaths(root)

		expect(paths.persistenceDir).toBe(resolve(root, 'data/persistence'))
		expect(paths.logsDir).toBe(resolve(root, 'logs'))
		expect(paths.logFile).toBe(resolve(root, 'logs/runtime.log'))
	})
})
