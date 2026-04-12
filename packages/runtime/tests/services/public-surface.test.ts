import { describe, expect, it } from 'vitest'

import * as PublicServices from '@pluxel/runtime/services'
import * as InternalServices from '../../src/services'
import { expectPublicSurface } from '../helpers/publicSurface'

describe('runtime/services surface compatibility', () => {
	it('public service exports are provided by the runtime services hub', () => {
		expectPublicSurface(PublicServices, InternalServices)
	})
})
