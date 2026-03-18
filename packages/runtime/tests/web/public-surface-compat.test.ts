import { describe, expect, it } from 'vitest'

import * as PublicWeb from '@pluxel/runtime/web'
import * as InternalWeb from '../../src/web'

describe('runtime/web surface compatibility', () => {
	it('public runtime exports are provided by the runtime web implementation', () => {
		const publicKeys = Object.keys(PublicWeb)
		const internalKeys = new Set(Object.keys(InternalWeb))
		const missing = publicKeys.filter((k) => !internalKeys.has(k)).sort()
		expect(missing).toEqual([])
	})
})
