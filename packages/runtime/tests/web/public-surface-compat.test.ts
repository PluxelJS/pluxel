import { describe, expect, it } from 'vitest'

import * as PublicWeb from '@pluxel/runtime/web'
import * as InternalWeb from '../../src/web'
import { expectPublicSurface } from '../helpers/publicSurface'

describe('runtime/web surface compatibility', () => {
	it('public runtime exports are provided by the runtime web implementation', () => {
		expectPublicSurface(PublicWeb, InternalWeb)
	})
})
