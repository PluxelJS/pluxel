import { expect, it } from 'vitest'
import { parsePluginDefinitionReference } from '@pluxel/core'
import type { PluginSourceImpact } from '@pluxel/host/sources'
import { installHostImpact } from '../src/install-impact.ts'

it('checks other dynamic sources at the declared identity and preserves uncertain shared re-exports', () => {
	const orders = parsePluginDefinitionReference('package:alpha::Orders')
	const other = parsePluginDefinitionReference('package:alpha::Other')
	const sources = [
		{ name: 'alpha', file: '/alpha.mjs', action: 'publish', definitions: [{ address: orders }] },
	] as const
	const external = {
		packageName: 'alpha',
		address: other,
		origin: 'other-source',
		nodes: [],
	} as const
	const view: PluginSourceImpact = {
		catalogRevision: 1,
		policyRevision: 1,
		definitions: [external],
	}
	expect(installHostImpact(sources, view)[0]?.definitions).toEqual([
		{ address: orders, change: 'add', nodes: [] },
	])
	const existing = { ...external, address: orders }
	expect(() => installHostImpact(sources, { ...view, definitions: [existing] })).toThrow(
		'another plugin source',
	)
	const reviewed = { ...existing, packageName: 'beta', origin: 'owned' } as const
	expect(
		installHostImpact(
			[...sources, { name: 'beta', file: '/beta.mjs', action: 'publish', definitions: undefined }],
			{ ...view, definitions: [existing, reviewed] },
		).map(({ definitions }) => definitions[0]?.change),
	).toEqual(['unverified', 'unverified'])
})
