import { describe, expect, it } from 'vitest'

import * as PublicVendors from '@pluxel/runtime/web/vendors'
import * as InternalVendors from '../../src/web/plugin-ui/vendors'

describe('runtime/web/vendors surface compatibility', () => {
	it('public vendor exports map directly to the plugin-ui vendor implementation', () => {
		expect(Object.keys(PublicVendors).sort()).toEqual(Object.keys(InternalVendors).sort())
		expect(PublicVendors.extensionVendorPackages).toEqual(InternalVendors.extensionVendorPackages)
	})
})
