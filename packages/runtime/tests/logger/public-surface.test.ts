import { describe, expect, it } from 'vitest'

import * as PublicLogger from '@pluxel/runtime/logger'
import * as InternalLogger from '../../src/logger'

describe('runtime/logger surface compatibility', () => {
	it('public logger exports are provided by the runtime logger hub', () => {
		const publicKeys = Object.keys(PublicLogger)
		const internalKeys = new Set(Object.keys(InternalLogger))
		const missing = publicKeys.filter((key) => !internalKeys.has(key)).sort()
		expect(missing).toEqual([])
	})
})
