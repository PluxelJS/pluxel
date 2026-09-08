import { describe, expect, it } from 'vitest'
import {
	formatPluginNodeReference,
	pluginDefinitionIndexKey,
	type CommitSummary,
	type PluginNodeAddress,
	type PluginNodeSlot,
} from '@pluxel/core'
import { PluginRecentUpdateTracker } from '../src/internal/recent-update'

const definition = {
	entry: { kind: 'package-root', packageName: '@fixture/update' },
	exportName: 'Service',
} as const
const healthy: PluginNodeAddress = { definition, variant: 'default' }
const failed: PluginNodeAddress = { definition, variant: 'fork', forkId: 'failed' }
const unobserved: PluginNodeAddress = { definition, variant: 'fork', forkId: 'stopped' }
const dependent: PluginNodeAddress = {
	definition: { ...definition, exportName: 'Consumer' },
	variant: 'default',
}
const slots = [healthy, failed, dependent].map(() => ({}) as PluginNodeSlot)
const addressOf = (slot: PluginNodeSlot) => [healthy, failed, dependent][slots.indexOf(slot)]!
const commit: CommitSummary = {
	pluginChanges: {
		added: slots,
		removed: [],
		replaced: [],
		restarted: [],
		availabilityChanged: slots,
	},
	runtimeUpdate: {},
	lifecycleReport: {
		ok: false,
		issues: [
			{ plugin: slots[1]!, phase: 'start', kind: 'start-failed', message: 'could not connect' },
			{
				plugin: slots[2]!,
				phase: 'dependency',
				kind: 'dependency-blocked',
				message: 'provider unavailable',
				blockedBy: slots[1]!,
			},
		],
	},
}
const batch = {
	scope: 'application',
	outcome: 'applied-with-issues',
	phase: 'lifecycle',
	durationMs: 12,
} as const

describe('route update history attribution', () => {
	it('shares batch facts while isolating lifecycle facts by exact node, including forks', () => {
		const history = new PluginRecentUpdateTracker()
		history.record({
			definitionKeys: [pluginDefinitionIndexKey(definition)],
			batch,
			lifecycle: { commit, addressOf },
		})
		expect(history.resolveRecentUpdate(healthy)?.lifecycle).toEqual({ issues: [] })
		expect(history.resolveRecentUpdate(failed)?.lifecycle?.issues).toEqual([
			{ phase: 'start', kind: 'start-failed', message: 'could not connect', blockedBy: null },
		])
		expect(history.resolveRecentUpdate(dependent)?.lifecycle?.issues[0]?.blockedBy).toBe(
			formatPluginNodeReference(failed),
		)
		expect(history.resolveRecentUpdate(unobserved)?.lifecycle).toBeNull()
		expect(history.resolveRecentUpdate(failed)?.batch).toBe(
			history.resolveRecentUpdate(healthy)?.batch,
		)
		expect(
			history.resolveRecentUpdate({
				...healthy,
				definition: { ...definition, exportName: 'Unrelated' },
			}),
		).toBeNull()
	})

	it('replaces historical node facts even when a later diagnostic revises the same batch sequence', () => {
		const history = new PluginRecentUpdateTracker()
		history.record({
			definitionKeys: [],
			batch: { ...batch, sequence: 9 },
			lifecycle: { commit, addressOf },
		})
		history.record({
			definitionKeys: [pluginDefinitionIndexKey(definition)],
			batch: { ...batch, sequence: 9, phase: 'commit' },
		})
		expect(history.resolveRecentUpdate(failed)?.lifecycle).toBeNull()
		const recovered: CommitSummary = { ...commit, lifecycleReport: { ok: true, issues: [] } }
		history.record({
			definitionKeys: [],
			batch: { scope: 'definitions', outcome: 'applied', phase: null, durationMs: 1 },
			lifecycle: { commit: recovered, addressOf },
		})
		expect(history.resolveRecentUpdate(failed)).toMatchObject({
			batch: { sequence: 10 },
			lifecycle: { issues: [] },
		})
	})

	it('keeps cleanup issues after a successful restart local to their owner', () => {
		const history = new PluginRecentUpdateTracker()
		history.record({
			definitionKeys: [],
			batch,
			lifecycle: {
				addressOf,
				commit: {
					...commit,
					lifecycleReport: {
						ok: false,
						issues: [
							{
								plugin: slots[1]!,
								phase: 'drain',
								kind: 'drain-failed',
								message: 'cleanup failed',
							},
						],
					},
				},
			},
		})
		expect(history.resolveRecentUpdate(failed)?.lifecycle?.issues[0]?.phase).toBe('drain')
		expect(history.resolveRecentUpdate(healthy)?.lifecycle).toEqual({ issues: [] })
	})

	it('does not publish partial history when supplied lifecycle facts contradict the batch', () => {
		const history = new PluginRecentUpdateTracker()
		expect(() =>
			history.record({
				definitionKeys: [],
				batch: { scope: 'definitions', outcome: 'applied', phase: null, durationMs: 1 },
				lifecycle: { commit, addressOf },
			}),
		).toThrow(/must report lifecycle issues/)
		expect(history.resolveRecentUpdate(healthy)).toBeNull()
	})
})

it('admits one route attempt before evaluation and preserves a failure outside the old catalog', () => {
	const history = new PluginRecentUpdateTracker()
	const events: unknown[] = []
	const unsubscribe = history.subscribeUpdates((snapshot) => events.push(snapshot))
	expect(history.beginUpdate('new-plugin.ts')).toBe(1)
	expect(history.latestUpdate()).toMatchObject({
		sequence: 1,
		state: 'updating',
		phase: 'evaluate',
	})
	history.record({
		definitionKeys: [],
		batch: {
			scope: 'application',
			outcome: 'retained-previous',
			phase: 'evaluate',
			durationMs: 12,
		},
	})
	expect(events).toHaveLength(1)
	history.finishUpdate({
		message: 'New import failed',
		file: 'new-helper.ts',
		importChain: ['entry.ts', 'new-plugin.ts', 'new-helper.ts'],
	})
	expect(history.latestUpdate()).toMatchObject({
		sequence: 1,
		state: 'settled',
		outcome: 'retained-previous',
		error: { file: 'new-helper.ts' },
	})
	expect(history.resolveRecentUpdate(healthy)).toBeNull()
	unsubscribe()
	expect(history.beginUpdate('new-helper.ts')).toBe(2)
	history.record({
		definitionKeys: [],
		batch: { scope: 'application', outcome: 'applied', phase: null, durationMs: 4 },
	})
	history.finishUpdate()
	expect(events).toHaveLength(2)
	expect(history.latestUpdate()).toMatchObject({ sequence: 2, outcome: 'applied', error: null })
})

it('attaches one diagnostic without discarding node-specific lifecycle attribution', () => {
	const history = new PluginRecentUpdateTracker()
	history.beginUpdate('service.ts')
	history.record({ definitionKeys: [], batch, lifecycle: { commit, addressOf } })
	history.finishUpdate({ message: 'Commit completion failed', file: 'service.ts', importChain: [] })
	expect(history.resolveRecentUpdate(failed)?.lifecycle?.issues[0]?.kind).toBe('start-failed')
	expect(history.resolveRecentUpdate(healthy)?.lifecycle?.issues).toEqual([])
	expect(history.resolveRecentUpdate(dependent)?.lifecycle?.issues[0]?.blockedBy).toBe(
		formatPluginNodeReference(failed),
	)
	expect(history.resolveRecentUpdate(failed)?.batch.error?.message).toBe('Commit completion failed')
})

it('reports a late completion error as applied with issues without claiming the old version was retained', () => {
	const history = new PluginRecentUpdateTracker()
	history.beginUpdate('service.ts')
	history.record({
		definitionKeys: [pluginDefinitionIndexKey(definition)],
		batch: { scope: 'definitions', outcome: 'applied', phase: null, durationMs: 3 },
	})
	history.finishUpdate({
		message: 'Completion failed after acceptance',
		file: null,
		importChain: [],
	})
	expect(history.latestUpdate()).toMatchObject({ outcome: 'applied-with-issues', phase: 'commit' })
	expect(history.resolveRecentUpdate(healthy)?.batch).toMatchObject({
		outcome: 'applied-with-issues',
		phase: 'commit',
		error: { message: 'Completion failed after acceptance' },
	})
})
