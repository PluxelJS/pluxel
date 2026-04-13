import { describe, expect, it } from 'vitest'
import type { RuntimeOpCatalogEntry } from '@pluxel/runtime/web'

import {
	buildOpsExplorerCatalogView,
	buildOpsExplorerSidebarData,
	buildOpsToolsetMembershipMap,
	buildOpsToolsetSummaries,
	createInitialRuntimeOpInput,
	getRuntimeOpInputMode,
} from '../../../components/src/app/ops/model'

function makeEntry(
	inputSchema: Record<string, unknown>,
	overrides?: Partial<RuntimeOpCatalogEntry>,
): RuntimeOpCatalogEntry {
	const descriptor = {
		id: overrides?.descriptor?.id ?? overrides?.id ?? 'demo.echo',
		doc: {
			title: 'Echo',
			description: 'Echo input',
			tags: ['demo'],
			...overrides?.descriptor?.doc,
		},
		exposure: { rpc: true, internal: false },
		policy: {},
		schemas: { input: inputSchema },
		transports: {},
		...overrides?.descriptor,
	}
	return {
		id: overrides?.id ?? 'demo.echo',
		owner: overrides?.owner ?? 'plugin:demo',
		ownerKind: overrides?.ownerKind ?? 'plugin',
		pluginId: overrides?.pluginId ?? 'demo',
		...(overrides ? { ...overrides, descriptor } : { descriptor }),
	}
}

describe('op catalog model', () => {
	it('detects input mode and prefills required plugin name', () => {
		const entry = makeEntry({
			type: 'object',
			properties: {
				name: { type: 'string' },
				query: { type: 'string' },
			},
			required: ['name', 'query'],
		})

		expect(getRuntimeOpInputMode(entry)).toBe('json-object')
		expect(createInitialRuntimeOpInput(entry, { pluginName: 'DemoPlugin' })).toBe(
			'{\n  "name": "DemoPlugin"\n}',
		)
	})

	it('builds sidebar counts and supports dedicated owner filtering', () => {
		const entries = [
			makeEntry({ type: 'object', properties: {}, required: [] }, { id: 'demo.echo', owner: 'plugin:Demo', pluginId: 'Demo' }),
			makeEntry(
				{ type: 'object', properties: {}, required: [] },
				{ id: 'plugin.status', owner: 'runtime:ops', ownerKind: 'runtime', pluginId: undefined },
			),
			makeEntry({ type: 'object', properties: {}, required: [] }, { id: 'alpha.run', owner: 'plugin:Alpha', pluginId: 'Alpha' }),
			makeEntry({ type: 'object', properties: {}, required: [] }, { id: 'beta.run', owner: 'plugin:Beta', pluginId: 'Beta' }),
		]

		expect(buildOpsExplorerSidebarData(entries)).toEqual({
			counts: {
				all: 4,
				runtime: 1,
			},
			owners: [
				{ owner: 'plugin:Alpha', label: 'Alpha', count: 1 },
				{ owner: 'plugin:Beta', label: 'Beta', count: 1 },
				{ owner: 'plugin:Demo', label: 'Demo', count: 1 },
			],
		})
	})

	it('builds host-owned ops toolset summaries and preserves missing ids', () => {
		const entries = [
			makeEntry(
				{ type: 'object', properties: {}, required: [] },
				{ id: 'alpha.run', owner: 'plugin:Alpha', pluginId: 'Alpha' },
			),
			makeEntry(
				{ type: 'object', properties: {}, required: [] },
				{ id: 'beta.run', owner: 'plugin:Beta', pluginId: 'Beta' },
			),
		]
		const groups = [
			{
				toolsetId: 'mixed',
				name: 'Mixed',
				description: 'Mixed toolset',
				opIds: ['alpha.run', 'missing.run', 'beta.run'],
			},
		]

		expect(buildOpsToolsetSummaries(groups, entries)).toEqual([
			{
				toolsetId: 'mixed',
				name: 'Mixed',
				description: 'Mixed toolset',
				availableCount: 2,
				missingCount: 1,
			},
		])

		const view = buildOpsExplorerCatalogView(entries, {
			selection: { kind: 'toolset', toolsetId: 'mixed' },
			search: '',
			toolsets: groups,
		})

		expect(view.entries.map((entry) => entry.id)).toEqual(['alpha.run', 'beta.run'])
		expect(view.missingOpIds).toEqual(['missing.run'])
	})

	it('supports ungrouped list building and membership lookup', () => {
		const entries = [
			makeEntry({ type: 'object', properties: {}, required: [] }, { id: 'alpha.run', owner: 'plugin:Alpha', pluginId: 'Alpha' }),
			makeEntry({ type: 'object', properties: {}, required: [] }, { id: 'beta.run', owner: 'plugin:Beta', pluginId: 'Beta' }),
			makeEntry({ type: 'object', properties: {}, required: [] }, { id: 'gamma.run', owner: 'plugin:Gamma', pluginId: 'Gamma' }),
		]
		const groups = [
			{ toolsetId: 'daily', name: 'Daily', opIds: ['alpha.run', 'beta.run'] },
			{ toolsetId: 'notes', name: 'Notes', opIds: ['beta.run'] },
		]

		expect(
			buildOpsExplorerCatalogView(entries, {
				selection: { kind: 'ungrouped' },
				search: '',
				toolsets: groups,
			}).entries.map((entry) => entry.id),
		).toEqual(['gamma.run'])

		expect(buildOpsToolsetMembershipMap(groups).get('beta.run')?.map((group) => group.name)).toEqual([
			'Daily',
			'Notes',
		])
	})
})
