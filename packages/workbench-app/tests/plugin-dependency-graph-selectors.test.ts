import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import type { PluginDependencyGraphSnapshot, PluginStatusSnapshot } from '@pluxel/runtime/web'
import { describe, expect, it } from 'vitest'
import { buildPluginDependencyGraphProjection } from '../src/app/plugins/pluginDependencyGraphModel'
import { selectPluginDependencyDetail } from '../src/app/plugins/pluginDependencyGraphSelectors'

const owner = node('OwnerPlugin')
const requiredProvider = node('RequiredProvider')
const stoppedOptional = node('StoppedOptional')
const unavailableOptional = node('UnavailableOptional')
const absentOptional = node('AbsentOptional')
const effectiveConsumer = node('EffectiveConsumer')
const inactiveConsumer = node('InactiveConsumer')
const unresolvedRequirement = definition('AbstractRequirement')

const ownerStatus = status(owner)
const requiredProviderStatus = status(requiredProvider)
const stoppedOptionalStatus = status(stoppedOptional, { lifecycleState: 'stopped' })
const unavailableOptionalStatus = status(unavailableOptional, {
	lifecycleState: 'stopped',
	availability: 'unavailable',
})

const snapshot = Object.freeze({
	nodes: Object.freeze([
		Object.freeze({ status: unavailableOptionalStatus, effective: false }),
		Object.freeze({ status: status(effectiveConsumer), effective: true }),
		Object.freeze({ status: status(inactiveConsumer), effective: false }),
		Object.freeze({ status: ownerStatus, effective: true }),
		Object.freeze({ status: requiredProviderStatus, effective: true }),
		Object.freeze({ status: stoppedOptionalStatus, effective: true }),
	]),
	edges: Object.freeze([
		Object.freeze({
			consumer: effectiveConsumer,
			requirement: owner.definition,
			mode: 'required' as const,
			resolution: Object.freeze({
				state: 'resolved' as const,
				provider: owner,
				via: 'direct' as const,
			}),
			effective: true,
		}),
		Object.freeze({
			consumer: inactiveConsumer,
			requirement: owner.definition,
			mode: 'optional' as const,
			resolution: Object.freeze({
				state: 'resolved' as const,
				provider: owner,
				via: 'direct' as const,
			}),
			effective: false,
		}),
		Object.freeze({
			consumer: owner,
			requirement: unresolvedRequirement,
			mode: 'required' as const,
			resolution: Object.freeze({ state: 'unresolved' as const }),
			effective: false as const,
		}),
		Object.freeze({
			consumer: owner,
			requirement: absentOptional.definition,
			mode: 'optional' as const,
			resolution: Object.freeze({
				state: 'resolved' as const,
				provider: absentOptional,
				via: 'direct' as const,
			}),
			effective: false,
		}),
		Object.freeze({
			consumer: owner,
			requirement: unavailableOptional.definition,
			mode: 'optional' as const,
			resolution: Object.freeze({
				state: 'resolved' as const,
				provider: unavailableOptional,
				via: 'direct' as const,
			}),
			effective: false,
		}),
		Object.freeze({
			consumer: owner,
			requirement: requiredProvider.definition,
			mode: 'required' as const,
			resolution: Object.freeze({
				state: 'resolved' as const,
				provider: requiredProvider,
				via: 'provider-default' as const,
			}),
			effective: true,
		}),
		Object.freeze({
			consumer: owner,
			requirement: stoppedOptional.definition,
			mode: 'optional' as const,
			resolution: Object.freeze({
				state: 'resolved' as const,
				provider: stoppedOptional,
				via: 'direct' as const,
			}),
			effective: true,
		}),
	]),
}) satisfies PluginDependencyGraphSnapshot

describe('plugin dependency graph detail selectors', () => {
	it('classifies required, optional, and placeholder endpoints from one graph snapshot', () => {
		const detail = selectPluginDependencyDetail(
			buildPluginDependencyGraphProjection(snapshot),
			owner,
		)

		expect(detail.node?.status).toBe(ownerStatus)
		expect(detail.required).toHaveLength(2)
		expect(detail.required[0]).toMatchObject({ provider: null })
		expect(detail.required[1]?.provider).toEqual({
			state: 'status',
			node: expect.objectContaining({ status: requiredProviderStatus }),
		})
		expect(detail.optional).toHaveLength(3)
		expect(detail.optional.map((entry) => entry.provider.state)).toEqual([
			'absent',
			'status',
			'status',
		])
		expect(detail.optional[0]?.provider).toEqual({ state: 'absent', address: absentOptional })
		expect(detail.optional[1]?.provider).toMatchObject({
			state: 'status',
			node: { status: { availability: 'unavailable', lifecycleState: 'stopped' } },
		})
		expect(detail.optional[2]?.provider).toMatchObject({
			state: 'status',
			node: { status: { availability: 'available', lifecycleState: 'stopped' } },
		})
	})

	it('separates effective blast radius from declared inactive dependents', () => {
		const detail = selectPluginDependencyDetail(
			buildPluginDependencyGraphProjection(snapshot),
			owner,
		)

		expect(detail.dependents.effective.map((entry) => entry.consumer.status.address)).toEqual([
			effectiveConsumer,
		])
		expect(detail.dependents.inactive.map((entry) => entry.consumer.status.address)).toEqual([
			inactiveConsumer,
		])
		expect(detail.dependents.effective[0]?.edge.effective).toBe(true)
		expect(detail.dependents.inactive[0]?.edge.effective).toBe(false)
		expect(Object.isFrozen(detail)).toBe(true)
		expect(Object.isFrozen(detail.dependents.inactive)).toBe(true)
	})
})

function definition(exportName: string): PluginDefinitionAddress {
	return {
		entry: { kind: 'package-root', packageName: '@fixture/dependency-detail' },
		exportName,
	}
}

function node(exportName: string): PluginNodeAddress {
	return { definition: definition(exportName), variant: 'default' }
}

function status(
	address: PluginNodeAddress,
	override: {
		availability?: 'available' | 'unavailable'
		lifecycleState?: 'running' | 'stopped'
	} = {},
): PluginStatusSnapshot {
	const name = address.definition.exportName
	const lifecycleState = override.lifecycleState ?? 'running'
	const availability = override.availability ?? 'available'
	const desiredState = lifecycleState === 'running' ? 'running' : 'stopped'
	return {
		address,
		reference: `package:@fixture/dependency-detail::${name}`,
		route: `v1/package/${name}/@fixture/dependency-detail`,
		displayName: name,
		label: { title: name, text: name },
		rootExportName: name,
		autoStart: lifecycleState === 'running',
		sessionIntent: 'inherit',
		desiredState,
		activationReason: lifecycleState === 'running' ? 'auto-start' : null,
		lifecycleState,
		availability,
		issues: [],
		execution: {
			kind: 'unreported',
			artifact: { kind: 'unreported' },
			update: { kind: 'unreported' },
		},
		recentUpdate: null,
	}
}
