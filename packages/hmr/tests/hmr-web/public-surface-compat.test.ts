import { describe, expect, it } from 'vitest'

import * as PublicWeb from '../../src/web/web'
import * as InternalWeb from '../../../hmr-web/src/index'

describe('hmr/web surface compatibility', () => {
	it('public runtime exports are provided by the internal vendor module', () => {
		const publicKeys = Object.keys(PublicWeb)
		const internalKeys = new Set(Object.keys(InternalWeb))
		const missing = publicKeys.filter((k) => !internalKeys.has(k)).sort()
		expect(missing).toEqual([])
	})
})

