import { describe, expect, it } from 'vitest'

import * as PublicLogger from '@pluxel/runtime/logger'
import * as InternalLogger from '../../src/logger'
import { expectPublicSurface } from '../helpers/publicSurface'

describe('runtime/logger surface compatibility', () => {
	it('public logger exports are provided by the runtime logger hub', () => {
		expectPublicSurface(PublicLogger, InternalLogger)
	})
})
