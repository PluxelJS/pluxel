import {
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { ConcretePluginDefinitionCandidate } from '@pluxel/core/internal'
import { describe, expect, it, vi } from 'vitest'
import { createPluginCatalogSnapshot, type PluginCatalogSnapshot } from '../src/catalog'
import type { PluginRecentUpdateSnapshot } from '../src/execution'
import {
	hostPluginStatusFromView,
	hostPluginStatusOverviewFromView,
	hostPluginControlFromView,
	type HostPluginStatusProjectionView,
} from '../src/status'

const definition: PluginDefinitionAddress = {
	entry: { kind: 'package-root', packageName: '@fixture/status' },
	exportName: 'Provider',
}
const node = (forkId?: string): PluginNodeAddress =>
	forkId === undefined
		? { definition, variant: 'default' }
		: { definition, variant: 'fork', forkId }
const candidate = {
	implementation: class Provider {},
	declaration: {
		address: definition,
		displayName: 'Provider Label',
		requires: [],
		optional: [],
		parts: [],
		forkable: true,
	},
} as unknown as ConcretePluginDefinitionCandidate

function fixture(forkCount = 3): HostPluginStatusProjectionView {
	return {
		catalog: createPluginCatalogSnapshot(1, [{ candidate }]),
		state: {
			autoStart: [node('orphan')],
			forks: Array.from({ length: forkCount }, (_, index) => ({
				definition,
				variant: 'fork',
				forkId: `fork-${index}`,
			})),
			providerDefaults: [],
			dependencyOverrides: [],
		},
		reconciliation: [],
		lifecycleIssues: [],
		sessionIntents: new Map(),
		desiredControl: new Map(),
		coreNodes: [],
		runningNodeKeys: new Set(),
		recentUpdate: undefined,
	}
}

describe('Host exact node status', () => {
	it('projects receipt control from the same native facts without reading presentation inputs', () => {
		const initial = fixture()
		const address = node('fork-1')
		const key = pluginNodeIndexKey(address)
		const view: HostPluginStatusProjectionView = {
			...initial,
			sessionIntents: new Map([[key, { address, intent: 'run' }]]),
			desiredControl: new Map([[key, { address, activationReason: 'session' }]]),
			runningNodeKeys: new Set([key]),
		}
		for (const status of hostPluginStatusOverviewFromView(view).statuses) {
			expect(hostPluginControlFromView(view, status.address)).toEqual({
				autoStart: status.autoStart,
				sessionIntent: status.sessionIntent,
				desiredState: status.desiredState,
				activationReason: status.activationReason,
				lifecycleState: status.lifecycleState,
			})
		}
		const guarded = {
			...view,
			get reconciliation(): never {
				throw new Error('Receipt read reconciliation diagnostics')
			},
			get lifecycleIssues(): never {
				throw new Error('Receipt read lifecycle diagnostics')
			},
			get recentUpdate(): never {
				throw new Error('Receipt read recent updates')
			},
		}
		expect(hostPluginControlFromView(guarded, address)).toMatchObject({
			sessionIntent: 'run',
			lifecycleState: 'running',
		})
		expect(hostPluginControlFromView(guarded, node('unknown'))).toBeNull()
	})

	it('matches overview for stopped, running and unavailable policy-referenced nodes', () => {
		const initial = fixture()
		const address = node('fork-1')
		const key = pluginNodeIndexKey(address)
		const view: HostPluginStatusProjectionView = {
			...initial,
			runningNodeKeys: new Set([key]),
			sessionIntents: new Map([[key, { address, intent: 'run' }]]),
			desiredControl: new Map([[key, { address, activationReason: 'session' }]]),
			lifecycleIssues: [{ plugin: address, kind: 'drain-failed', message: 'cleanup failed' }],
		}
		const statuses = hostPluginStatusOverviewFromView(view).statuses
		for (const status of statuses)
			expect(hostPluginStatusFromView(view, status.address)).toEqual(status)
		expect(hostPluginStatusFromView(view, node())).toMatchObject({
			lifecycleState: 'stopped',
			availability: 'available',
		})
		expect(hostPluginStatusFromView(view, node('orphan'))).toMatchObject({
			availability: 'unavailable',
		})
		expect(hostPluginStatusFromView(view, node('unknown'))).toBeNull()
	})

	it('reads only the selected runtime status even with thousands of stopped forks', () => {
		const initial = fixture(2_000)
		const address = node('fork-1234')
		const key = pluginNodeIndexKey(address)
		const resolveRecentUpdate = vi.fn((selected: PluginNodeAddress) => {
			if (pluginNodeIndexKey(selected) !== key)
				throw new Error('Unrelated runtime status was projected')
			return null
		})
		const catalog = {
			...initial.catalog,
			get entries(): PluginCatalogSnapshot['entries'] {
				throw new Error('Single status enumerated the catalog')
			},
		}
		const status = hostPluginStatusFromView(
			{ ...initial, catalog, recentUpdate: { resolveRecentUpdate } },
			address,
		)
		expect(status).toMatchObject({ address, lifecycleState: 'stopped', availability: 'available' })
		expect(resolveRecentUpdate).toHaveBeenCalledTimes(1)
	})

	it('observes catalog withdrawal, fork deletion and diagnostic changes from each new view', () => {
		const initial = fixture()
		const address = node('fork-1')
		expect(hostPluginStatusFromView(initial, address)).toMatchObject({
			availability: 'available',
			issues: [],
		})
		const removed: HostPluginStatusProjectionView = {
			...initial,
			state: { ...initial.state, forks: [] },
		}
		expect(hostPluginStatusFromView(removed, address)).toBeNull()
		const withdrawn: HostPluginStatusProjectionView = {
			...initial,
			catalog: createPluginCatalogSnapshot(2, []),
		}
		expect(hostPluginStatusFromView(withdrawn, address)).toMatchObject({
			availability: 'unavailable',
			issues: [{ code: 'definition_unavailable' }],
		})
		for (const view of [removed, withdrawn]) {
			for (const status of hostPluginStatusOverviewFromView(view).statuses)
				expect(hostPluginStatusFromView(view, status.address)).toEqual(status)
		}
	})

	it('keeps route execution, control failures and detached recent HMR facts in exact reads', () => {
		const initial = fixture()
		const address = node('fork-1')
		let recent: PluginRecentUpdateSnapshot = {
			batch: {
				scope: 'definitions',
				outcome: 'retained-previous',
				phase: 'artifacts',
				sequence: 3,
				durationMs: 12,
				error: { message: 'control generation failed', file: 'provider.ts', importChain: [] },
			},
			lifecycle: null,
		}
		const view: HostPluginStatusProjectionView = {
			...initial,
			catalog: createPluginCatalogSnapshot(2, [
				{
					candidate,
					provenance: {
						execution: {
							kind: 'vite',
							origin: 'source',
							artifact: { kind: 'source-module' },
							update: { kind: 'definition-hmr' },
						},
						control: {
							state: 'unavailable',
							reason: 'analysis_failed',
							message: 'control generation failed',
						},
					},
				},
			]),
			recentUpdate: { resolveRecentUpdate: () => recent },
		}
		const selected = hostPluginStatusFromView(view, address)!
		expect(selected).toEqual(
			hostPluginStatusOverviewFromView(view).statuses.find(
				(status) => pluginNodeIndexKey(status.address) === pluginNodeIndexKey(address),
			),
		)
		expect(selected).toMatchObject({
			execution: { kind: 'vite', update: { kind: 'definition-hmr' } },
			issues: [{ code: 'control_analysis_failed', message: 'control generation failed' }],
			recentUpdate: recent,
		})
		expect(selected.recentUpdate).not.toBe(recent)
		expect(Object.isFrozen(selected.recentUpdate!.batch.error!.importChain)).toBe(true)
		recent = {
			batch: { scope: 'definitions', outcome: 'applied', phase: null, sequence: 4, durationMs: 5 },
			lifecycle: { issues: [] },
		}
		expect(hostPluginStatusFromView(view, address)!.recentUpdate).toEqual(recent)
		expect(selected.recentUpdate!.batch.sequence).toBe(3)
	})
})
