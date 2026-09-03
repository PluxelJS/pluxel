import { BasePlugin, createCoreTestHost, Plugin, pluginDefinitionAddressOf } from '@pluxel/core/test'
import {
	__setPluginDefinition,
	lowerTestReplacement,
	PLUGIN_LOWERING_ABI_VERSION,
} from '@pluxel/test/unsafe'
import { describe, expect, it } from 'vitest'

// This suite intentionally models lowering facts without the semantic pass.
// oxlint-disable-next-line pluxel/plugin-base-class-requires-plugin-registration
class OriginalPlugin extends BasePlugin {
	readonly revision = 'original'
}

Plugin()(OriginalPlugin)
__setPluginDefinition(OriginalPlugin, {
	abiVersion: PLUGIN_LOWERING_ABI_VERSION,
	kind: 'plugin',
	definition: {
		entry: { kind: 'source-entry', sourceSpace: 'test', path: 'unsafe-replacement.ts' },
		exportName: 'OriginalPlugin',
	},
})

class ReplacementPlugin extends OriginalPlugin {
	override readonly revision = 'replacement'
}

lowerTestReplacement(OriginalPlugin, ReplacementPlugin)

describe('@pluxel/test/unsafe', () => {
	it('lowers an explicit test replacement as a new evaluation of the target definition', async () => {
		expect(pluginDefinitionAddressOf(ReplacementPlugin)).toEqual(
			pluginDefinitionAddressOf(OriginalPlugin),
		)

		await using host = createCoreTestHost()
		await host.add(OriginalPlugin)
		expect(host.require(OriginalPlugin).revision).toBe('original')

		await host.replaceDefinition(OriginalPlugin, ReplacementPlugin)
		expect(host.require(ReplacementPlugin)).toBeInstanceOf(ReplacementPlugin)
		expect(host.require(ReplacementPlugin).revision).toBe('replacement')
	})
})
