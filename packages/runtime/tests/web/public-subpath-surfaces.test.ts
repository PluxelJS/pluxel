import { describe, expect, it } from 'vitest'

import * as PublicExtensions from '@pluxel/runtime/web/extensions'
import { extensionFederationSharedPackages } from '@pluxel/runtime/web/federation'
import * as PublicUi from '@pluxel/runtime/web/ui'

describe('runtime web subpath surfaces', () => {
	it('exports the plugin UI authoring entrypoints', () => {
		expect(PublicUi.pluginUi).toBeTypeOf('function')
		expect(PublicUi.definePluginUIModule).toBeTypeOf('function')
		expect(PublicUi.rpcErrorMessage).toBeTypeOf('function')
	})

	it('exports extension document and interaction helpers', () => {
		expect(PublicExtensions.doc).toBeTypeOf('function')
		expect(PublicExtensions.defineInteractionContract).toBeTypeOf('function')
	})

	it('keeps the federation shared package contract stable', () => {
		expect(extensionFederationSharedPackages).toEqual(
			expect.arrayContaining([
				'@tanstack/react-virtual',
				'@mantine/core',
				'@mantine/hooks',
				'@pluxel/runtime/web/ui',
			]),
		)
		expect(extensionFederationSharedPackages).not.toEqual(
			expect.arrayContaining(['@signaldb/react', '@signaldb/maverickjs', '@maverick-js/signals']),
		)
	})
})
