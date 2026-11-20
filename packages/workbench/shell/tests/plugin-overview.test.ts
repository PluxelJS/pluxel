import { expect, it } from 'vitest'
import { readPluginPolicyTarget } from '../src/app/plugins/pluginOverviewModel'
import { controlCatalog, controlNode } from './pluginControlFixtures'

const address = {
	definition: {
		entry: { kind: 'package-root', packageName: '@pluxel/example' },
		exportName: 'ExamplePlugin',
	},
	variant: 'default',
} as const

it('locks only the addressed policy target and applies node modes to absent choices', () => {
	const other = controlNode('Other')
	const policy = {
		...controlCatalog().statePolicy,
		providerDefaultsSource: 'declared',
		nodeModes: [{ node: other, mode: 'declared-only' }],
		selections: [
			{
				target: {
					field: 'dependencyOverrides',
					consumerAddress: address,
					requirementAddress: other.definition,
				},
				mode: 'declared-first',
				source: 'declared',
				shadowed: true,
			},
		],
	} as const
	expect(readPluginPolicyTarget(policy, 'providerDefaults')?.canWrite).toBe(false)
	expect(readPluginPolicyTarget(policy, { field: 'autoStart', node: address })?.canWrite).toBe(true)
	expect(readPluginPolicyTarget(policy, { field: 'autoStart', node: other })).toEqual({
		mode: 'declared-only',
		source: 'default',
		shadowed: false,
		canWrite: false,
	})
	expect(
		readPluginPolicyTarget(policy, {
			field: 'dependencyOverrides',
			consumerAddress: address,
			requirementAddress: other.definition,
		}),
	).toMatchObject({ source: 'declared', shadowed: true, canWrite: false })
	expect(
		readPluginPolicyTarget(policy, {
			field: 'dependencyOverrides',
			consumerAddress: address,
			requirementAddress: address.definition,
		})?.canWrite,
	).toBe(true)
	expect(
		readPluginPolicyTarget({ ...policy, readonly: true }, { field: 'autoStart', node: address })
			?.canWrite,
	).toBe(false)
	expect(readPluginPolicyTarget(undefined, 'providerDefaults')).toBeUndefined()
})
