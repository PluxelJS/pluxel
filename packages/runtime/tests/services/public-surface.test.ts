import { describe, expect, it } from 'vitest'

import * as PublicServices from '@pluxel/runtime/services'
import * as InternalServices from '../../src/services'

describe('runtime/services surface compatibility', () => {
	it('public service exports are provided by the runtime services hub', () => {
		const publicKeys = Object.keys(PublicServices)
		const internalKeys = new Set(Object.keys(InternalServices))
		const missing = publicKeys.filter((key) => !internalKeys.has(key)).sort()
		expect(missing).toEqual([])
	})
})
