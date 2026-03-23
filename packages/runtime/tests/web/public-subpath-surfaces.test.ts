import { describe, expect, it } from 'vitest'

import * as PublicExtensions from '@pluxel/runtime/web/extensions'
import { extensionFederationSharedPackages } from '@pluxel/runtime/web/federation'
import * as PublicUi from '@pluxel/runtime/web/ui'
import * as InternalExtensions from '../../src/web/extensions'
import * as InternalUi from '../../src/web/ui'

function expectPublicSurface(publicMod: object, internalMod: object) {
	const publicKeys = Object.keys(publicMod)
	const internalKeys = new Set(Object.keys(internalMod))
	const missing = publicKeys.filter((k) => !internalKeys.has(k)).sort()
	expect(missing).toEqual([])
}

describe('runtime web subpath surfaces', () => {
	it('keeps web/ui aligned with the internal ui facade', () => {
		expectPublicSurface(PublicUi, InternalUi)
		expect(PublicUi.createHmrWebClient).toBeTypeOf('function')
		expect(PublicUi.createPluginUiHelpers).toBeTypeOf('function')
		expect(PublicUi.useHmrWebClient).toBeTypeOf('function')
	})

	it('keeps web/extensions aligned with the internal extension contracts', () => {
		expectPublicSurface(PublicExtensions, InternalExtensions)
		expect(PublicExtensions.doc).toBeTypeOf('function')
	})

	it('keeps the federation shared package contract stable', () => {
		expect(extensionFederationSharedPackages).toEqual(
			expect.arrayContaining(['@mantine/core', '@mantine/hooks', '@pluxel/runtime/web/ui']),
		)
	})
})
